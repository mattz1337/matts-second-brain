import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { createApp } from '../server/app.js';
import { invokeTool } from '../server/mcp.js';
import { chunkText, validatePublicUrl } from '../server/ingestion.js';
import { temporalQuality } from '../server/quality.js';
import type { Actor, Knowledge } from '../shared/contracts.js';

let db: DB;
let service: BrainService;
const assistant: Actor = { id: 'assistant', owner: false, scopes: ['brain:read', 'brain:write'] };
const reader: Actor = { id: 'reader', owner: false, scopes: ['brain:read'] };
const input = (overrides: Record<string, unknown> = {}) => ({
  title: 'An observation',
  statement: 'Evidence makes knowledge inspectable and useful.',
  kind: 'personal_observation',
  tags: ['Learning'],
  project: 'Spike',
  idempotency_key: randomUUID(),
  ...overrides,
});
const sourceText =
  '# First heading\n\nVector search finds semantically related passages in a document. A graph stores explicit relationships between claims and their evidence.\n\n# History\n\nReview intervals schedule a check without deleting knowledge.';
async function imported(text = sourceText, title = 'Sample source') {
  const job = await service.importSource(owner, {
    title,
    text,
    tags: ['Learning'],
    project: 'Spike',
    idempotency_key: randomUUID(),
  });
  await service.processNextJob();
  const done = await service.getJob(owner, job.id);
  expect(done.status, done.error || '').toBe('completed');
  return done;
}
beforeAll(async () => {
  db = await openDatabase();
  service = new BrainService(db);
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE nodes CASCADE; TRUNCATE jobs,uploads,idempotency,activity,tombstones,preferences;',
  );
});
afterAll(async () => {
  await db.close();
});

describe('knowledge lifecycle and evidence', () => {
  it('keeps owner notes self-reported, persists versions, and does not mark them verified', async () => {
    const item = await service.addKnowledge(owner, input());
    expect(item.lifecycle).toBe('active');
    expect(item.evidence_status).toBe('self_reported');
    expect(item.freshness).toBe('unknown');
    expect(item.verified_at).toBeNull();
    expect((await service.getKnowledge(owner, item.id)).versions).toHaveLength(1);
  });
  it('makes assistant additions candidates and enforces write/review/admin scopes', async () => {
    const item = await service.addKnowledge(assistant, input());
    expect(item.lifecycle).toBe('candidate');
    await expect(service.addKnowledge(reader, input())).rejects.toMatchObject({ status: 403 });
    await expect(
      service.review(assistant, item.id, {
        expected_version: 1,
        decision: 'verify',
        rationale: 'I believe it.',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.forget(assistant, item.id, 1)).rejects.toMatchObject({ status: 403 });
  });
  it('enforces idempotency including mismatched payloads', async () => {
    const payload = input();
    const a = await service.addKnowledge(owner, payload);
    const b = await service.addKnowledge(owner, payload);
    expect(a.id).toBe(b.id);
    expect(await service.allKnowledge(owner)).toHaveLength(1);
    await expect(
      service.addKnowledge(owner, { ...payload, statement: 'A completely different statement.' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('imports exact anchored evidence and preserves original bytes', async () => {
    const job = await imported();
    const candidates = (await service.reviewQueue(owner)).candidates;
    expect(candidates.length).toBeGreaterThan(1);
    for (const candidate of candidates) {
      const detail = await service.getKnowledge(owner, candidate.id);
      expect(detail.lifecycle).toBe('candidate');
      expect(detail.evidence_status).toBe('cited');
      expect(detail.verified_at).toBeNull();
      expect(detail.evidence[0].text).toContain(candidate.statement);
      const source = await service.sourceDetail(owner, detail.evidence[0].source_id);
      const revision = source.revisions[0];
      expect(
        String(revision.text).slice(detail.evidence[0].start_offset, detail.evidence[0].end_offset),
      ).toBe(detail.evidence[0].text);
    }
    const originals = await db.query<{ original_base64: string }>(
      'SELECT original_base64 FROM revisions WHERE id=$1',
      [job.result.revision_id],
    );
    expect(Buffer.from(originals.rows[0].original_base64, 'base64').toString()).toBe(sourceText);
  });
  it('reuses identical revisions without duplicate claims and versions changed sources', async () => {
    const a = await imported();
    const n = (await service.allKnowledge(owner)).length;
    const b = await imported();
    expect(b.result.duplicate).toBe(true);
    expect(b.result.revision_id).toBe(a.result.revision_id);
    expect(await service.allKnowledge(owner)).toHaveLength(n);
    const c = await imported(sourceText + '\n\nNew evidence requires another source revision.');
    expect(c.result.source_id).toBe(a.result.source_id);
    expect(c.result.revision_id).not.toBe(a.result.revision_id);
    expect((await service.sources(owner))[0].revision_count).toBe(2);
  });
  it('accepts without verifying and checks optimistic versions', async () => {
    await imported();
    const item = (await service.reviewQueue(owner)).candidates[0];
    const accepted = await service.review(owner, item.id, {
      expected_version: item.version,
      decision: 'accept',
      rationale: 'Useful to keep.',
    });
    expect(accepted.lifecycle).toBe('active');
    expect(accepted.verified_at).toBeNull();
    await expect(
      service.review(owner, item.id, {
        expected_version: item.version,
        decision: 'accept',
        rationale: 'Old version.',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const verified = await service.review(owner, item.id, {
      expected_version: accepted.version,
      decision: 'verify',
      rationale: 'Read and checked the retained passage and its scope.',
    });
    expect(verified.freshness).toBe('current');
    expect(verified.verified_at).not.toBeNull();
    expect(verified.review_due_at).not.toBeNull();
    const unchanged = await service.getKnowledge(owner, item.id);
    expect(unchanged.verified_at).toBe(verified.verified_at);
  });
  it('requires evidence before verifying factual claims and resets verification on substantive edits', async () => {
    const factual = await service.addKnowledge(owner, input({ kind: 'factual_assertion' }));
    await expect(
      service.review(owner, factual.id, {
        expected_version: 1,
        decision: 'verify',
        rationale: 'A check without evidence.',
      }),
    ).rejects.toMatchObject({ code: 'evidence_required' });
    const personal = await service.addKnowledge(owner, input());
    const checked = await service.review(owner, personal.id, {
      expected_version: 1,
      decision: 'verify',
      rationale: 'Checked my own experiment notes.',
    });
    const renamed = await service.update(owner, personal.id, {
      expected_version: checked.version,
      title: 'A clearer title',
    });
    expect(renamed.verified_at).toBe(checked.verified_at);
    const changed = await service.update(owner, personal.id, {
      expected_version: renamed.version,
      statement: 'A substantively changed observation requires another check.',
    });
    expect(changed.verified_at).toBeNull();
  });
  it('counts independent lineages rather than copies and exposes challenges', async () => {
    const item = await service.addKnowledge(owner, input({ kind: 'factual_assertion' }));
    let version = item.version;
    for (const [title, lineage] of [
      ['Original', 'paper-one'],
      ['Copy', 'paper-one'],
      ['Independent', 'paper-two'],
    ]) {
      const j = await service.importSource(owner, {
        title,
        text: sourceText,
        lineage_group: lineage,
        idempotency_key: randomUUID(),
      });
      await service.processNextJob();
      const job = await service.getJob(owner, j.id);
      const source = await service.sourceDetail(owner, job.result.source_id!);
      const attached = await service.attachEvidence(owner, item.id, {
        passage_id: source.passages[0].id,
        relation: 'supports',
        rationale: 'This source addresses the assertion.',
        expected_version: version,
        idempotency_key: randomUUID(),
      });
      version = attached.version;
      if (title === 'Copy') expect(attached.independent_sources).toBe(1);
      if (title === 'Independent') expect(attached.evidence_status).toBe('corroborated');
    }
    const source = await service.sourceDetail(owner, (await service.sources(owner))[0].id);
    const challenged = await service.attachEvidence(owner, item.id, {
      passage_id: source.passages[1].id,
      relation: 'challenges',
      rationale: 'The observation challenges the scope.',
      expected_version: version,
      idempotency_key: randomUUID(),
    });
    expect(challenged.evidence_status).toBe('challenged');
  });
  it('invalidates verification when a source changes or is retracted', async () => {
    const j = await imported();
    let item = (await service.reviewQueue(owner)).candidates[0];
    item = await service.review(owner, item.id, {
      expected_version: 1,
      decision: 'verify',
      rationale: 'Checked the retained source.',
    });
    expect(item.verified_at).not.toBeNull();
    await imported(sourceText + '\n\nThe source now contains a revised observation.');
    expect((await service.getKnowledge(owner, item.id)).verified_at).toBeNull();
    await service.retractSource(owner, j.result.source_id!);
    const detail = await service.getKnowledge(owner, item.id);
    expect(detail.independent_sources).toBe(0);
    expect(detail.evidence[0].source_status).toBe('retracted');
    expect(
      (await service.search(owner, { query: 'Vector', include_candidates: true })).passages,
    ).toHaveLength(0);
  });
  it('detects structured conflicts only within overlapping scope and dates', async () => {
    const base = {
      kind: 'factual_assertion',
      subject: 'Printer',
      predicate: 'nozzle size',
      context: 'machine A',
      object: '0.4mm',
    };
    const first = await service.addKnowledge(owner, input(base));
    const second = await service.addKnowledge(owner, input({ ...base, object: '0.6mm' }));
    expect((await service.getKnowledge(owner, first.id)).conflict_count).toBe(1);
    expect((await service.getKnowledge(owner, second.id)).conflicts[0].id).toBe(first.id);
    const separate = await service.addKnowledge(
      owner,
      input({ ...base, object: '0.8mm', context: 'machine B' }),
    );
    expect(separate.conflict_count).toBe(0);
    const dated = await service.addKnowledge(
      owner,
      input({ ...base, subject: 'Historical printer', valid_to: '2020-01-01T00:00:00.000Z' }),
    );
    const modern = await service.addKnowledge(
      owner,
      input({
        ...base,
        subject: 'Historical printer',
        object: '0.8mm',
        valid_from: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect((await service.getKnowledge(owner, dated.id)).conflict_count).toBe(0);
    expect(modern.conflict_count).toBe(0);
  });
  it('archives reversibly, suppresses search/graph results, and purges item derivatives', async () => {
    let item = await service.addKnowledge(
      owner,
      input({
        title: 'Private observation',
        statement: 'SecretStarlight is the observation to forget.',
      }),
    );
    item = await service.archive(owner, item.id, item.version);
    expect((await service.search(owner, { query: 'SecretStarlight' })).items).toHaveLength(0);
    expect((await service.graph(owner, {})).nodes.some((n) => n.id === item.id)).toBe(false);
    item = await service.archive(owner, item.id, item.version, true);
    expect((await service.search(owner, { query: 'SecretStarlight' })).items).toHaveLength(1);
    await service.forget(owner, item.id, item.version);
    await expect(service.getKnowledge(owner, item.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await db.query('SELECT * FROM search_documents WHERE knowledge_id=$1', [item.id])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query('SELECT * FROM versions WHERE knowledge_id=$1', [item.id])).rows,
    ).toHaveLength(0);
    expect((await service.exportData(owner)).data.tombstones).toHaveLength(1);
  });
  it('forgets retained sources and their extracted claims', async () => {
    const j = await imported();
    await service.forgetSource(owner, j.result.source_id!);
    expect(await service.sources(owner)).toHaveLength(0);
    expect(await service.allKnowledge(owner)).toHaveLength(0);
    expect((await db.query('SELECT * FROM search_documents')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(0);
  });
  it('forgets derived claims after edits while preserving unrelated uploads and retry records', async () => {
    const unrelatedUpload = await service.upload(
      owner,
      Buffer.from('An unrelated note with useful retained content.'),
      'other.md',
      'text/markdown',
    );
    const payload = input({ title: 'Unrelated persistent note' });
    const note = await service.addKnowledge(owner, payload);
    const j = await imported();
    const derived = (await service.reviewQueue(owner)).candidates[0];
    await service.update(owner, derived.id, {
      expected_version: 1,
      context: 'Edited context',
      statement: 'A rewritten derivative of the imported source.',
    });
    await service.forgetSource(owner, j.result.source_id!);
    await expect(service.getKnowledge(owner, derived.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await db.query('SELECT id FROM uploads WHERE id=$1', [unrelatedUpload.id])).rows,
    ).toHaveLength(1);
    expect((await service.addKnowledge(owner, payload)).id).toBe(note.id);
  });
  it('supersedes at the present time while retaining historical applicability', async () => {
    const previous = await service.addKnowledge(
      owner,
      input({ statement: 'Older protocol notes use VersionAlpha.' }),
    );
    const next = await service.addKnowledge(
      owner,
      input({ statement: 'Current protocol notes use VersionBeta.' }),
    );
    await service.link(owner, next.id, previous.id, 'supersedes', previous.version);
    const old = await service.getKnowledge(owner, previous.id);
    const fresh = await service.getKnowledge(owner, next.id);
    expect(old.lifecycle).toBe('superseded');
    expect(old.valid_to).not.toBeNull();
    expect(fresh.valid_from).not.toBeNull();
    const historical = await service.search(owner, {
      query: 'VersionAlpha',
      temporal_mode: 'historical',
      as_of: '2020-01-01T00:00:00.000Z',
    });
    expect(historical.items[0].id).toBe(previous.id);
    expect((await service.search(owner, { query: 'VersionAlpha' })).items).toHaveLength(0);
  });
  it('batch reviews preserve acceptance semantics and report concurrent changes per item', async () => {
    await imported();
    const candidates = (await service.reviewQueue(owner)).candidates.slice(0, 2);
    await service.update(owner, candidates[1].id, {
      expected_version: 1,
      title: 'Changed candidate title',
    });
    const result = await service.batchReview(owner, {
      items: candidates.map((k) => ({ id: k.id, expected_version: k.version })),
      decision: 'accept',
      rationale: 'Reviewed these exact source assertions for usefulness.',
    });
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
    expect((await service.getKnowledge(owner, candidates[0].id)).verified_at).toBeNull();
    await expect(
      service.batchReview(assistant, { items: [], decision: 'accept', rationale: 'Attempt' }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('merges named entities with preserved aliases, redirects connections, and undoes the merge', async () => {
    const a = await service.addKnowledge(
      owner,
      input({ subject: 'Postgres', kind: 'factual_assertion' }),
    );
    const b = await service.addKnowledge(
      owner,
      input({ subject: 'PostgreSQL', kind: 'factual_assertion' }),
    );
    const entities = await service.entities(owner);
    const from = entities.find((e) => e.canonical === 'postgres')!;
    const to = entities.find((e) => e.canonical === 'postgresql')!;
    const merge = await service.mergeEntities(owner, from.id, to.id);
    expect((await service.entities(owner)).find((e) => e.id === to.id)?.aliases).toContain(
      'postgres',
    );
    expect(
      (await service.graph(owner, { focus_id: a.id })).edges.some((e) => e.target === to.id),
    ).toBe(true);
    await service.undoEntityMerge(owner, merge.merge_id);
    expect((await service.entities(owner)).some((e) => e.id === from.id)).toBe(true);
    expect(
      (await service.graph(owner, { focus_id: a.id })).edges.some((e) => e.target === from.id),
    ).toBe(true);
    expect(
      (await service.graph(owner, { focus_id: b.id })).edges.some((e) => e.target === to.id),
    ).toBe(true);
  });
});
describe('retrieval, graph, and recovery', () => {
  it('persists records and pending jobs across a real filesystem database restart', async () => {
    const dataDir = path.resolve(`.data/persistence-tests/${randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    let persistent = await openDatabase(dataDir);
    const first = new BrainService(persistent);
    const item = await first.addKnowledge(
      owner,
      input({ statement: 'DiskContinuity survives a database close and reopen.' }),
    );
    const queued = await first.importSource(owner, {
      title: 'Persisted import',
      text: sourceText,
      idempotency_key: randomUUID(),
    });
    await persistent.close();
    persistent = await openDatabase(dataDir);
    try {
      const restarted = new BrainService(persistent);
      expect((await restarted.getKnowledge(owner, item.id)).statement).toContain('DiskContinuity');
      expect((await restarted.getJob(owner, queued.id)).status).toBe('queued');
      await restarted.processNextJob();
      expect((await restarted.getJob(owner, queued.id)).status).toBe('completed');
    } finally {
      await persistent.close();
    }
  });
  it('retrieves exact evidence, excludes candidates by default, and exposes source text', async () => {
    await imported();
    const result = await service.search(owner, { query: 'Vector search' });
    expect(result.items).toHaveLength(0);
    expect(result.passages.length).toBeGreaterThan(0);
    const candidates = await service.search(owner, {
      query: 'Vector search',
      include_candidates: true,
    });
    expect(candidates.items.length).toBeGreaterThan(0);
    const selected = candidates.items[0];
    await service.review(owner, selected.id, {
      expected_version: 1,
      decision: 'accept',
      rationale: 'Keep the relevant passage.',
    });
    const answer = await service.answer(owner, { query: 'Vector search' });
    expect(answer.gap).toBe(false);
    expect(answer.claims[0].evidence.length).toBeGreaterThan(0);
    const missing = await service.answer(owner, { query: 'nonexistent-quasar-123' });
    expect(missing.gap).toBe(true);
    expect(missing.claims).toHaveLength(0);
  });
  it('filters applicability, retrieves historical knowledge, and searches recorded versions', async () => {
    let item = await service.addKnowledge(
      owner,
      input({
        title: 'Historic design',
        statement: 'VintageEngine used a special material in 2010.',
        valid_from: '2000-01-01T00:00:00.000Z',
        valid_to: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect((await service.search(owner, { query: 'VintageEngine' })).items).toHaveLength(0);
    expect(
      (
        await service.search(owner, {
          query: 'VintageEngine',
          temporal_mode: 'historical',
          as_of: '2010-01-01T00:00:00.000Z',
        })
      ).items,
    ).toHaveLength(1);
    const past = await service.addKnowledge(
      owner,
      input({ statement: 'OldWording was present in the first recorded observation.' }),
    );
    await db.query("UPDATE versions SET recorded_at='2020-01-01' WHERE knowledge_id=$1", [past.id]);
    await service.update(owner, past.id, {
      expected_version: 1,
      statement: 'NewWording replaced the initial observation.',
    });
    const historical = await service.search(owner, {
      query: 'OldWording',
      recorded_at: '2021-01-01T00:00:00.000Z',
    });
    expect(historical.items[0].statement).toContain('OldWording');
    expect((await service.search(owner, { query: 'OldWording' })).items).toHaveLength(0);
  });
  it('bounds graph neighborhoods and provides explainable evidence edges', async () => {
    await imported();
    const item = (await service.reviewQueue(owner)).candidates[0];
    await service.review(owner, item.id, {
      expected_version: 1,
      decision: 'accept',
      rationale: 'Keep this claim.',
    });
    const graph = await service.graph(owner, { focus_id: item.id, hops: 2, limit: 2 });
    expect(graph.nodes.length).toBeLessThanOrEqual(2);
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.some((n) => n.id === item.id)).toBe(true);
    const full = await service.graph(owner, { focus_id: item.id, hops: 1 });
    expect(full.edges.some((e) => e.type === 'cites')).toBe(true);
    expect(full.nodes.some((n) => n.type === 'source')).toBe(true);
  });
  it('recovers a running job and reports failed unsafe imports', async () => {
    const j = await service.importSource(owner, {
      title: 'Recovered source',
      text: sourceText,
      idempotency_key: randomUUID(),
    });
    await db.query("UPDATE jobs SET status='running' WHERE id=$1", [j.id]);
    await service.recoverJobs();
    expect((await service.getJob(owner, j.id)).status).toBe('queued');
    await service.processNextJob();
    expect((await service.getJob(owner, j.id)).status).toBe('completed');
    const unsafe = await service.importSource(owner, {
      title: 'Unsafe URL',
      url: 'http://127.0.0.1',
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    expect((await service.getJob(owner, unsafe.id)).status).toBe('failed');
    expect((await service.getJob(owner, unsafe.id)).error).toMatch(/Private/);
  });
  it.each(['orbit-export', 'commonplace-export'])(
    'restores %s IDs, original sources, versions, and search behavior',
    async (format) => {
      const j = await imported();
      const item = (await service.reviewQueue(owner)).candidates[0];
      await service.review(owner, item.id, {
        expected_version: 1,
        decision: 'accept',
        rationale: 'Keep it before export.',
      });
      const archive = await service.exportData(owner);
      expect(archive.format).toBe('orbit-export');
      archive.format = format;
      const fresh = await openDatabase();
      try {
        const restored = new BrainService(fresh);
        const result = await restored.restoreData(owner, archive);
        expect(result.restored).toBeGreaterThan(0);
        expect((await restored.getKnowledge(owner, item.id)).versions).toHaveLength(2);
        expect(
          (await restored.search(owner, { query: item.statement.split(' ')[0] })).items.some(
            (k) => k.id === item.id,
          ),
        ).toBe(true);
        expect((await restored.sourceDetail(owner, j.result.source_id!)).revisions).toHaveLength(1);
      } finally {
        await fresh.close();
      }
    },
  );
  it('uses actual vector similarity in PostgreSQL', async () => {
    const a = await service.addKnowledge(owner, input({ title: 'First vector' }));
    const b = await service.addKnowledge(owner, input({ title: 'Second vector' }));
    const axis = [1, ...Array(383).fill(0)];
    const orthogonal = [0, 1, ...Array(382).fill(0)];
    await db.query('UPDATE search_documents SET embedding=$2::vector WHERE id=$1', [
      a.id,
      JSON.stringify(axis),
    ]);
    await db.query('UPDATE search_documents SET embedding=$2::vector WHERE id=$1', [
      b.id,
      JSON.stringify(orthogonal),
    ]);
    const result = await db.query<{ id: string; distance: number }>(
      'SELECT id,embedding <=> $1::vector AS distance FROM search_documents ORDER BY embedding <=> $1::vector',
      [JSON.stringify(axis)],
    );
    expect(result.rows[0].id).toBe(a.id);
    expect(result.rows[0].distance).toBe(0);
    expect(result.rows[1].distance).toBe(1);
  });
});
describe('HTTP and MCP authorization', () => {
  const keys = {
    session: 'owner-session-secret',
    assistant: 'assistant-secret',
    reader: 'reader-secret',
  };
  it('denies unauthenticated calls, hostile hosts/origins, and cookie writes without origin', async () => {
    const app = createApp(service, keys);
    expect((await request(app).get('/api/dashboard').set('Host', '127.0.0.1:4310')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .post('/api/session')
          .set('Host', 'attacker.example')
          .set('Origin', 'http://127.0.0.1:4310')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/session')
          .set('Host', '127.0.0.1:4310')
          .set('Origin', 'https://attacker.example')
      ).status,
    ).toBe(403);
    expect((await request(app).post('/api/session').set('Host', '127.0.0.1:4310')).status).toBe(
      403,
    );
    const session = await request(app)
      .post('/api/session')
      .set('Host', '127.0.0.1:4310')
      .set('Origin', 'http://127.0.0.1:4310');
    expect(session.status).toBe(200);
    const cookies = session.headers['set-cookie'];
    expect(
      (
        await request(app)
          .post('/api/knowledge')
          .set('Host', '127.0.0.1:4310')
          .set('Cookie', cookies)
          .send(input())
      ).status,
    ).toBe(403);
  });
  it('gives REST and MCP tools equivalent candidate/permission behavior', async () => {
    const app = createApp(service, keys);
    const response = await request(app)
      .post('/api/knowledge')
      .set('Host', '127.0.0.1:4310')
      .set('Authorization', `Bearer ${keys.assistant}`)
      .send(input());
    expect(response.status).toBe(201);
    expect(response.body.lifecycle).toBe('candidate');
    const result = await invokeTool(service, assistant, 'add_knowledge', input());
    expect((result as Knowledge).lifecycle).toBe('candidate');
    await expect(invokeTool(service, reader, 'add_knowledge', input())).rejects.toMatchObject({
      status: 403,
    });
    const denied = await request(app)
      .post('/api/tools/review_knowledge')
      .set('Host', '127.0.0.1:4310')
      .set('Authorization', `Bearer ${keys.assistant}`)
      .send({
        id: response.body.id,
        expected_version: 1,
        decision: 'verify',
        rationale: 'Not authorized.',
      });
    expect(denied.status).toBe(403);
  });
  it('rejects malformed tool payloads and unsupported upload types', async () => {
    await expect(invokeTool(service, assistant, 'query_graph', { hops: 99 })).rejects.toThrow();
    await expect(
      service.upload(owner, Buffer.from('binary'), 'model.exe', 'application/octet-stream'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
describe('freshness and source boundaries', () => {
  it('imports HTML without scripts and PDF with page anchors', async () => {
    const html = await service.upload(
      owner,
      Buffer.from(
        '<html><body><script>SECRET_SCRIPT_CONTENT</script><main><h1>Study</h1><p>HTMLObservation preserves the evidence within readable source text.</p></main></body></html>',
      ),
      'article.html',
      'text/html',
    );
    const h = await service.importSource(owner, {
      title: 'HTML source',
      upload_id: html.id,
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    const htmlJob = await service.getJob(owner, h.id);
    expect(htmlJob.status).toBe('completed');
    const retained = await service.sourceDetail(owner, htmlJob.result.source_id!);
    expect(String(retained.revisions[0].text)).toContain('HTMLObservation');
    expect(String(retained.revisions[0].text)).not.toContain('SECRET_SCRIPT_CONTENT');
    const content =
      'BT /F1 12 Tf 50 700 Td (PDFObservation retains a readable source passage and its evidence.) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const start = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => String(o).padStart(10, '0') + ' 00000 n ')
      .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const upload = await service.upload(
      owner,
      Buffer.from(pdf),
      'observation.pdf',
      'application/pdf',
    );
    const j = await service.importSource(owner, {
      title: 'PDF source',
      upload_id: upload.id,
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    const job = await service.getJob(owner, j.id);
    expect(job.status, job.error || '').toBe('completed');
    const source = await service.sourceDetail(owner, job.result.source_id!);
    expect(source.passages[0].text).toContain('PDFObservation');
    expect(source.passages[0].anchor).toContain('Page 1');
  });
  it('distinguishes unknown, current, due, stale, expired, and future validity', () => {
    const base = {
      verified_at: null,
      valid_from: null,
      valid_to: null,
      review_interval_days: 90,
      grace_days: 30,
    };
    const at = new Date('2026-10-08T12:00:00Z');
    expect(temporalQuality(base, at).freshness).toBe('unknown');
    expect(temporalQuality({ ...base, verified_at: '2026-10-01T12:00:00Z' }, at).freshness).toBe(
      'current',
    );
    expect(temporalQuality({ ...base, verified_at: '2026-07-01T12:00:00Z' }, at).freshness).toBe(
      'review_due',
    );
    expect(temporalQuality({ ...base, verified_at: '2026-01-01T12:00:00Z' }, at).freshness).toBe(
      'stale',
    );
    expect(temporalQuality({ ...base, valid_to: '2026-01-01T12:00:00Z' }, at).freshness).toBe(
      'expired',
    );
    expect(temporalQuality({ ...base, valid_from: '2027-01-01T12:00:00Z' }, at).freshness).toBe(
      'not_yet_valid',
    );
  });
  it('retains exact offsets even when long passages are split', () => {
    const text = '# Heading\n\n' + 'Words with some meaning and unicode äöü. '.repeat(120);
    for (const p of chunkText(text)) {
      expect(text.slice(p.start_offset, p.end_offset)).toBe(p.text);
      expect(p.text.length).toBeLessThanOrEqual(900);
      expect(p.anchor).toContain('Heading');
    }
  });
  it('blocks private IPv4, IPv6, metadata, credentials, protocols, and ports', async () => {
    for (const url of [
      'http://127.0.0.1',
      'http://[::1]',
      'http://169.254.169.254',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://user:pass@example.com',
      'file:///C:/secret',
      'http://example.com:9000',
    ])
      await expect(validatePublicUrl(url)).rejects.toThrow();
  });
});
