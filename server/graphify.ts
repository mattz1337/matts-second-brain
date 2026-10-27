import { randomUUID } from 'node:crypto';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import { BrainService, hash, scope } from './service.js';
import { rows, one, type QueryDB } from './db.js';
import { requireCondition } from './errors.js';
import type { Actor } from '../shared/contracts.js';

type Snapshot = {
  id: string;
  kind: 'knowledge' | 'sources';
  title: string;
  text: string;
  revision: string;
  fingerprint: string;
};
const manifestSchema = z.object({
  format: z.literal('orbit-graphify-corpus-v1'),
  sources: z
    .array(
      z.object({
        id: z.string().uuid(),
        file: z.string().max(300),
        revision: z.string().max(100),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(5000),
});
const graphNode = z
  .object({
    id: z.union([z.string().max(1000), z.number()]),
    source_file: z.string().max(1000).optional(),
    orbit_id: z.string().uuid().optional(),
  })
  .passthrough();
const graphEdge = z
  .object({
    source: z.union([z.string().max(1000), z.number()]),
    target: z.union([z.string().max(1000), z.number()]),
    relation: z.string().max(200).default('related'),
    confidence: z.string().max(100).default('UNSPECIFIED'),
    source_file: z.string().max(1000).optional(),
  })
  .passthrough();
export class GraphifyIntegration {
  constructor(private brain: BrainService) {}
  private async snapshots(db: QueryDB = this.brain.db): Promise<Snapshot[]> {
    const records = await rows<Omit<Snapshot, 'fingerprint'>>(
      db,
      `SELECT id,'knowledge' AS kind,title,statement AS text,version::text AS revision FROM knowledge WHERE lifecycle='active'
      UNION ALL SELECT s.id,'sources' AS kind,s.title,r.text,r.id::text AS revision FROM sources s JOIN LATERAL (SELECT id,text FROM revisions WHERE source_id=s.id ORDER BY observed_at DESC,id DESC LIMIT 1) r ON true WHERE s.status='active' LIMIT 5001`,
    );
    requireCondition(
      records.length <= 5000,
      400,
      'graphify_limit',
      'Choose a smaller corpus; this export supports up to 5,000 records.',
    );
    return records.map((r) => ({
      ...r,
      fingerprint: hash(JSON.stringify([r.id, r.revision, r.title, r.text])),
    }));
  }
  async export(actor: Actor) {
    scope(actor, 'brain:admin');
    const corpus = await this.snapshots();
    requireCondition(
      corpus.reduce((n, v) => n + Buffer.byteLength(v.text), 0) <= 100 * 1024 * 1024,
      400,
      'graphify_limit',
      'The corpus exceeds the 100 MB export limit.',
    );
    const zip = new ZipFile();
    const manifest = {
      format: 'orbit-graphify-corpus-v1',
      exported_at: new Date().toISOString(),
      sources: corpus.map((v) => ({
        id: v.id,
        file: `${v.kind}/${v.id}.md`,
        revision: v.revision,
        hash: v.fingerprint,
      })),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'orbit-manifest.json');
    for (const entry of corpus)
      zip.addBuffer(
        Buffer.from(`# ${entry.title}\n\n${entry.text}\n`),
        `${entry.kind}/${entry.id}.md`,
      );
    zip.end();
    return zip.outputStream;
  }
  async list(actor: Actor) {
    scope(actor, 'brain:admin');
    return rows(
      this.brain.db,
      `SELECT p.*,a.label AS source_title,b.label AS target_title FROM graphify_proposals p JOIN nodes a ON a.id=p.source_id JOIN nodes b ON b.id=p.target_id ORDER BY CASE p.status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,p.created_at DESC LIMIT 300`,
    );
  }
  async import(actor: Actor, raw: unknown) {
    scope(actor, 'brain:review');
    requireCondition(
      Buffer.byteLength(JSON.stringify(raw)) <= 8 * 1024 * 1024,
      400,
      'graphify_limit',
      'Graphify input exceeds 8 MB.',
    );
    const input = z
      .object({
        manifest: manifestSchema,
        graph: z
          .object({
            nodes: z.array(graphNode).max(5000),
            links: z.array(graphEdge).max(10000).optional(),
            edges: z.array(graphEdge).max(10000).optional(),
            graph: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      })
      .strict()
      .parse(raw);
    const manifest = new Map(input.manifest.sources.map((s) => [s.id, s]));
    requireCondition(
      manifest.size === input.manifest.sources.length,
      400,
      'invalid_manifest',
      'The corpus manifest contains duplicate IDs.',
    );
    const snapshot = new Map((await this.snapshots()).map((v) => [v.id, v]));
    const fileId = (file?: string) =>
      file?.replaceAll('\\', '/').match(/([a-f0-9-]{36})\.md(?:$|:)/i)?.[1];
    const nodes = new Map(
      input.graph.nodes.map((n) => [
        String(n.id),
        n.orbit_id || fileId(n.source_file) || fileId(String(n.id)),
      ]),
    );
    requireCondition(
      nodes.size === input.graph.nodes.length,
      400,
      'invalid_graph',
      'The graph contains duplicate node IDs.',
    );
    let unmatched = 0,
      stale = 0,
      existing = 0;
    const proposals = new Map<
      string,
      {
        source: string;
        target: string;
        relation: string;
        confidence: string;
        hashA: string;
        hashB: string;
      }
    >();
    for (const edge of input.graph.links || input.graph.edges || []) {
      const anchors = [
        ...new Set(
          [
            nodes.get(String(edge.source)),
            nodes.get(String(edge.target)),
            fileId(edge.source_file),
          ].filter((v): v is string => Boolean(v)),
        ),
      ];
      if (anchors.length < 2) {
        unmatched++;
        continue;
      }
      for (let a = 0; a < anchors.length; a++)
        for (let b = a + 1; b < anchors.length; b++) {
          const [source, target] = [anchors[a], anchors[b]].sort();
          const left = snapshot.get(source),
            right = snapshot.get(target);
          if (!left || !right || !manifest.has(source) || !manifest.has(target)) {
            unmatched++;
            continue;
          }
          if (
            manifest.get(source)!.hash !== left.fingerprint ||
            manifest.get(target)!.hash !== right.fingerprint
          ) {
            stale++;
            continue;
          }
          const fingerprint = hash(JSON.stringify([source, target, edge.relation]));
          proposals.set(fingerprint, {
            source,
            target,
            relation: edge.relation,
            confidence: edge.confidence,
            hashA: left.fingerprint,
            hashB: right.fingerprint,
          });
        }
    }
    requireCondition(
      proposals.size <= 1000,
      400,
      'graphify_limit',
      'The graph proposes too many links. Import a smaller corpus.',
    );
    let created = 0;
    await this.brain.db.transaction(async (q) => {
      for (const [fingerprint, p] of proposals) {
        const prior = await one<{ status: string }>(
          q,
          'SELECT status FROM graphify_proposals WHERE fingerprint=$1',
          [fingerprint],
        );
        if (prior) {
          existing++;
          if (prior.status === 'proposed')
            await q.query(
              'UPDATE graphify_proposals SET source_hash=$2,target_hash=$3,confidence=$4 WHERE fingerprint=$1',
              [fingerprint, p.hashA, p.hashB, p.confidence],
            );
          continue;
        }
        await q.query(
          'INSERT INTO graphify_proposals(id,fingerprint,source_id,target_id,source_hash,target_hash,relation,confidence,rationale,properties) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            randomUUID(),
            fingerprint,
            p.source,
            p.target,
            p.hashA,
            p.hashB,
            p.relation,
            p.confidence,
            'Graphify proposed this connection between retained records. Review the source content; extraction labels are not factual verification.',
            JSON.stringify({
              method: 'graphify',
              graph_metadata: input.graph.graph || {},
              manifest_format: input.manifest.format,
            }),
          ],
        );
        created++;
      }
    });
    return { created, existing, unmatched, stale, automatic_changes: 0 };
  }
  async decide(actor: Actor, id: string, decision: 'accept' | 'dismiss') {
    scope(actor, 'brain:review');
    return this.brain.db.transaction(async (q) => {
      const proposal = await one<{
        source_id: string;
        target_id: string;
        source_hash: string;
        target_hash: string;
        relation: string;
        confidence: string;
        status: string;
      }>(q, 'SELECT * FROM graphify_proposals WHERE id=$1', [id]);
      requireCondition(proposal, 404, 'proposal_missing', 'Graphify proposal not found.');
      if (decision === 'dismiss') {
        await q.query("DELETE FROM relations WHERE properties->>'graphify_proposal_id'=$1", [id]);
        await q.query("UPDATE graphify_proposals SET status='dismissed' WHERE id=$1", [id]);
        return { status: 'dismissed' };
      }
      if (proposal.status === 'accepted') return { status: 'accepted' };
      const current = new Map((await this.snapshots(q)).map((s) => [s.id, s.fingerprint]));
      requireCondition(
        current.get(proposal.source_id) === proposal.source_hash &&
          current.get(proposal.target_id) === proposal.target_hash,
        409,
        'stale_proposal',
        'A source changed since extraction. Export and re-extract the corpus before accepting this connection.',
      );
      await q.query(
        "INSERT INTO relations(id,source_node,target_node,type,properties) VALUES($1,$2,$3,'related_to',$4) ON CONFLICT(source_node,target_node,type) DO NOTHING",
        [
          randomUUID(),
          proposal.source_id,
          proposal.target_id,
          JSON.stringify({
            method: 'graphify',
            graphify_proposal_id: id,
            graphify_relation: proposal.relation,
            graphify_confidence: proposal.confidence,
            status: 'owner_confirmed',
            rationale: 'Source-backed Graphify connection explicitly accepted by the owner.',
          }),
        ],
      );
      await q.query("UPDATE graphify_proposals SET status='accepted' WHERE id=$1", [id]);
      return { status: 'accepted' };
    });
  }
}
