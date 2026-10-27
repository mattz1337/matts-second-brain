import { randomUUID, createHash } from 'node:crypto';
import { redactAssistantSources } from './assistant-privacy.js';
import { z } from 'zod';
import {
  captureSchema,
  importSchema,
  reviewSchema,
  editSchema,
  evidenceSchema,
  searchSchema,
  graphSchema,
  sourceBrowseSchema,
} from '../shared/contracts.js';
import type {
  Actor,
  CaptureInput,
  Knowledge,
  Detail,
  Evidence,
  SearchResult,
  Source,
  SourceAttachment,
  SourceBrowseResult,
  ImportJob,
  GraphResult,
  GraphNode,
  GraphEdge,
  Dashboard,
} from '../shared/contracts.js';
import { rows, one, type DB, type QueryDB } from './db.js';
import { AppError, requireCondition } from './errors.js';
import { temporalQuality, intervalsOverlap } from './quality.js';
import {
  chunkText,
  parseFile,
  fetchPublicPage,
  extractCandidates,
  type Candidate,
  type Chunk,
} from './ingestion.js';
import type { Embeddings } from './embeddings.js';
import { config } from './config.js';
import { CategoryService } from './category-service.js';
import { sourceDocument } from './source-document.js';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import {
  NsxArchive,
  NSX_LIMIT,
  storedPath,
  storeAttachment,
  removeStoredFile,
  type NsxNote,
} from './nsx.js';

export const owner: Actor = {
  id: 'owner',
  scopes: ['brain:read', 'brain:write', 'brain:review', 'brain:admin'],
  owner: true,
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iso = (value: unknown): string | null =>
  value ? new Date(String(value)).toISOString() : null;
const stringify = (value: unknown) => JSON.stringify(value);
export function scope(actor: Actor, required: string) {
  requireCondition(
    actor.scopes.includes(required),
    403,
    'insufficient_scope',
    `This operation requires ${required}.`,
  );
}
function validDates(input: { valid_from?: string | null; valid_to?: string | null }) {
  requireCondition(
    !input.valid_from ||
      !input.valid_to ||
      Date.parse(input.valid_from) < Date.parse(input.valid_to),
    400,
    'invalid_interval',
    'Valid until must be after valid from.',
  );
}

type Raw = Omit<Knowledge, 'freshness' | 'review_due_at' | 'evidence_status' | 'warnings'>;
const knowledgeSelect = `SELECT k.*,
  count(DISTINCT e.id)::int AS evidence_count,
  count(DISTINCT s.lineage_group) FILTER(WHERE e.relation='supports' AND s.status='active')::int AS independent_sources,
  count(DISTINCT e.id) FILTER(WHERE e.relation='challenges' AND s.status='active')::int AS challenges,
  count(DISTINCT rel.id)::int AS conflict_count
  FROM knowledge k
  LEFT JOIN evidence e ON e.knowledge_id=k.id
  LEFT JOIN passages p ON p.id=e.passage_id LEFT JOIN revisions rev ON rev.id=p.revision_id LEFT JOIN sources s ON s.id=rev.source_id
  LEFT JOIN relations rel ON rel.type='contradicts' AND (rel.source_node=k.id OR rel.target_node=k.id)`;

export class BrainService {
  private workerBusy = false;
  public classification: CategoryService;
  constructor(
    public db: DB,
    public embeddings?: Embeddings,
    public storageRoot = path.join(config.dataDir, 'files'),
  ) {
    this.classification = new CategoryService(
      db,
      embeddings,
      config.categoryMinSimilarity,
      config.categoryAutoSimilarity,
    );
  }

  private decorate(raw: Raw & { challenges?: number }, at = new Date()): Knowledge {
    const item = {
      ...raw,
      created_at: iso(raw.created_at)!,
      updated_at: iso(raw.updated_at)!,
      verified_at: iso(raw.verified_at),
      valid_from: iso(raw.valid_from),
      valid_to: iso(raw.valid_to),
    };
    const evidence_status = raw.challenges
      ? 'challenged'
      : raw.independent_sources >= 2
        ? 'corroborated'
        : raw.independent_sources
          ? 'cited'
          : ['personal_observation', 'preference'].includes(raw.kind)
            ? 'self_reported'
            : 'unsupported';
    const quality = temporalQuality(item, at);
    const warnings: string[] = [];
    if (quality.freshness === 'stale' || quality.freshness === 'review_due')
      warnings.push('Verification is overdue.');
    if (quality.freshness === 'unknown') warnings.push('This knowledge has not been verified.');
    if (raw.conflict_count) warnings.push('Conflicting claims need review.');
    if (evidence_status === 'challenged') warnings.push('Evidence challenges this claim.');
    if (raw.lifecycle === 'candidate') warnings.push('Pending review.');
    return { ...item, ...quality, evidence_status, warnings };
  }
  async allKnowledge(actor: Actor, q: QueryDB = this.db): Promise<Knowledge[]> {
    scope(actor, 'brain:read');
    return (
      await rows<Raw & { challenges: number }>(
        q,
        `${knowledgeSelect} GROUP BY k.id ORDER BY k.updated_at DESC`,
      )
    ).map((x) => this.decorate(x));
  }
  private async requireItem(q: QueryDB, id: string) {
    const item = await one<Raw>(q, 'SELECT * FROM knowledge WHERE id=$1', [id]);
    requireCondition(item, 404, 'not_found', 'Knowledge not found.');
    return item;
  }
  private async enriched(q: QueryDB, id: string): Promise<Knowledge> {
    const raw = await one<Raw & { challenges: number }>(
      q,
      `${knowledgeSelect} WHERE k.id=$1 GROUP BY k.id`,
      [id],
    );
    requireCondition(raw, 404, 'not_found', 'Knowledge not found.');
    return this.decorate(raw);
  }
  async getKnowledge(actor: Actor, id: string): Promise<Detail> {
    scope(actor, 'brain:read');
    const item = await this.enriched(this.db, id);
    const [evidence, reviews, versions, conflictIds] = await Promise.all([
      rows<Evidence>(
        this.db,
        `SELECT e.*,p.text,p.anchor,p.start_offset,p.end_offset, s.id AS source_id,s.title AS source_title,s.url AS source_url,s.lineage_group,s.status AS source_status,r.id AS revision_id,r.content_hash
        FROM evidence e JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id JOIN sources s ON s.id=r.source_id WHERE e.knowledge_id=$1 ORDER BY e.created_at`,
        [id],
      ),
      rows<Record<string, unknown>>(
        this.db,
        'SELECT * FROM reviews WHERE knowledge_id=$1 ORDER BY created_at DESC',
        [id],
      ),
      rows<Record<string, unknown>>(
        this.db,
        'SELECT version,snapshot,recorded_at FROM versions WHERE knowledge_id=$1 ORDER BY version DESC',
        [id],
      ),
      rows<{ id: string }>(
        this.db,
        "SELECT CASE WHEN source_node=$1 THEN target_node ELSE source_node END AS id FROM relations WHERE type='contradicts' AND (source_node=$1 OR target_node=$1)",
        [id],
      ),
    ]);
    const conflicts = await Promise.all(conflictIds.map((x) => this.enriched(this.db, x.id)));
    const origin = await one<{ payload: Detail['assistant_origin'] }>(
      this.db,
      'SELECT payload FROM assistant_origins WHERE knowledge_id=$1',
      [id],
    );
    return {
      ...item,
      evidence,
      reviews,
      versions,
      conflicts,
      ...(origin ? { assistant_origin: origin.payload } : {}),
    };
  }
  private async activity(q: QueryDB, action: string, title: string, id: string | null = null) {
    await q.query('INSERT INTO activity(id,knowledge_id,action,title) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      id,
      action,
      title,
    ]);
  }
  private async snapshot(q: QueryDB, id: string) {
    const item = await this.enriched(q, id);
    await q.query(
      'INSERT INTO versions(id,knowledge_id,version,snapshot) VALUES($1,$2,$3,$4) ON CONFLICT(knowledge_id,version) DO NOTHING',
      [randomUUID(), id, item.version, stringify(item)],
    );
  }
  private async index(
    q: QueryDB,
    id: string,
    title: string,
    text: string,
    labels: string,
    passage = false,
  ) {
    const fingerprint = hash(`${title}\n${text}\n${labels}`);
    await q.query(
      `INSERT INTO search_documents(id,${passage ? 'passage_id' : 'knowledge_id'},title,text,labels,input_hash) VALUES($1,$1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,text=excluded.text,labels=excluded.labels,input_hash=excluded.input_hash,
      embedding=CASE WHEN search_documents.input_hash=excluded.input_hash THEN search_documents.embedding ELSE NULL END`,
      [id, title, text, labels, fingerprint],
    );
  }
  private async edge(
    q: QueryDB,
    source: string,
    target: string,
    type: string,
    backing: string | null = null,
  ) {
    if (source === target) return;
    await q.query(
      'INSERT INTO relations(id,source_node,target_node,type,backing_claim) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_node,target_node,type) DO NOTHING',
      [randomUUID(), source, target, type, backing],
    );
  }
  private async entity(q: QueryDB, name: string, type: string) {
    const canonical = name.trim().toLocaleLowerCase();
    const existing = await one<{ id: string }>(
      q,
      'SELECT id FROM entities WHERE (canonical=$1 OR aliases ? $1) AND type=$2',
      [canonical, type],
    );
    if (existing) return existing.id;
    const id = randomUUID();
    await q.query('INSERT INTO nodes(id,type,label) VALUES($1,$2,$3)', [id, type, name.trim()]);
    await q.query('INSERT INTO entities(id,canonical,type) VALUES($1,$2,$3)', [
      id,
      canonical,
      type,
    ]);
    return id;
  }
  private async connect(
    q: QueryDB,
    id: string,
    input: Pick<CaptureInput, 'tags' | 'project' | 'subject'>,
  ) {
    await q.query("DELETE FROM relations WHERE source_node=$1 AND type IN ('about','in_project')", [
      id,
    ]);
    for (const tag of input.tags)
      await this.edge(q, id, await this.entity(q, tag, 'topic'), 'about');
    if (input.project)
      await this.edge(q, id, await this.entity(q, input.project, 'project'), 'in_project');
    if (input.subject)
      await this.edge(q, id, await this.entity(q, input.subject, 'entity'), 'about', id);
  }
  private async detectConflicts(q: QueryDB, id: string) {
    await q.query(
      "DELETE FROM relations WHERE type='contradicts' AND (source_node=$1 OR target_node=$1)",
      [id],
    );
    const current = await this.requireItem(q, id);
    if (current.lifecycle !== 'active' || !current.subject || !current.predicate || !current.object)
      return;
    const similar = await rows<Raw>(
      q,
      "SELECT * FROM knowledge WHERE id<>$1 AND lifecycle='active' AND lower(subject)=lower($2) AND lower(predicate)=lower($3) AND context=$4 AND project=$5 AND lower(object)<>lower($6)",
      [id, current.subject, current.predicate, current.context, current.project, current.object],
    );
    for (const candidate of similar)
      if (intervalsOverlap(current, candidate)) {
        const [source, target] = [id, candidate.id].sort();
        await this.edge(q, source, target, 'contradicts');
      }
  }
  private async insertKnowledge(
    q: QueryDB,
    input: CaptureInput,
    lifecycle: string,
    derivedSourceId: string | null = null,
  ) {
    validDates(input);
    const id = randomUUID();
    await q.query('INSERT INTO nodes(id,type,label) VALUES($1,$2,$3)', [
      id,
      input.kind === 'factual_assertion' ? 'claim' : 'note',
      input.title,
    ]);
    await q.query(
      `INSERT INTO knowledge(id,title,statement,kind,lifecycle,tags,project,subject,predicate,object,context,review_interval_days,valid_from,valid_to,derived_source_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        input.title,
        input.statement,
        input.kind,
        lifecycle,
        stringify(input.tags),
        input.project,
        input.subject,
        input.predicate,
        input.object,
        input.context,
        input.review_interval_days,
        input.valid_from || null,
        input.valid_to || null,
        derivedSourceId,
      ],
    );
    await this.connect(q, id, input);
    await this.classification.classify(q, id);
    await this.index(
      q,
      id,
      input.title,
      input.statement,
      [...input.tags, input.project, input.subject].join(' '),
    );
    await this.detectConflicts(q, id);
    return id;
  }
  private async idempotent<T>(
    actor: Actor,
    operation: string,
    key: string,
    payload: unknown,
    work: (q: QueryDB) => Promise<T>,
  ): Promise<T> {
    const scopedKey = `${actor.id}:${operation}:${key}`;
    const fingerprint = hash(stringify(payload));
    return this.db.transaction(async (q) => {
      const existing = await one<{ payload_hash: string; response: T }>(
        q,
        'SELECT * FROM idempotency WHERE key=$1',
        [scopedKey],
      );
      if (existing) {
        requireCondition(
          existing.payload_hash === fingerprint,
          409,
          'idempotency_conflict',
          'This key was already used for a different request.',
        );
        return existing.response;
      }
      const response = await work(q);
      await q.query(
        'INSERT INTO idempotency(key,actor,operation,payload_hash,response) VALUES($1,$2,$3,$4,$5)',
        [scopedKey, actor.id, operation, fingerprint, stringify(response)],
      );
      return response;
    });
  }
  async addKnowledge(
    actor: Actor,
    raw: unknown,
    committed?: (q: QueryDB, item: Knowledge) => Promise<void>,
  ) {
    scope(actor, 'brain:write');
    const input = captureSchema.parse(raw);
    return this.idempotent(actor, 'capture', input.idempotency_key, input, async (q) => {
      const id = await this.insertKnowledge(q, input, actor.owner ? 'active' : 'candidate');
      await this.snapshot(q, id);
      await this.activity(q, 'captured', input.title, id);
      const saved = await this.enriched(q, id);
      await committed?.(q, saved);
      return saved;
    });
  }
  async review(actor: Actor, id: string, raw: unknown) {
    scope(actor, 'brain:review');
    const input = reviewSchema.parse(raw);
    return this.db.transaction(async (q) => {
      const item = await this.requireItem(q, id);
      requireCondition(
        item.version === input.expected_version,
        409,
        'version_conflict',
        'Knowledge changed. Refresh before reviewing.',
      );
      requireCondition(
        !['archived', 'superseded'].includes(item.lifecycle),
        400,
        'invalid_lifecycle',
        'Restore archived knowledge before reviewing; superseded claims remain historical.',
      );
      if (input.decision === 'verify') {
        const quality = await this.enriched(q, id);
        requireCondition(
          quality.independent_sources > 0 ||
            ['personal_observation', 'preference'].includes(item.kind),
          400,
          'evidence_required',
          'Attach active supporting evidence before verifying a factual claim.',
        );
        requireCondition(
          quality.freshness !== 'expired' && quality.freshness !== 'not_yet_valid',
          400,
          'invalid_applicability',
          'Update applicability before verifying this claim as current.',
        );
      }
      await q.query(
        `UPDATE knowledge SET lifecycle=$2,verified_at=CASE WHEN $3='verify' THEN now() ELSE verified_at END,version=version+1,updated_at=now() WHERE id=$1`,
        [id, input.decision === 'reject' ? 'rejected' : 'active', input.decision],
      );
      await q.query(
        'INSERT INTO reviews(id,knowledge_id,version,actor,decision,rationale) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, item.version, actor.id, input.decision, input.rationale],
      );
      await this.detectConflicts(q, id);
      await this.snapshot(q, id);
      await this.activity(
        q,
        input.decision === 'verify'
          ? 'verified'
          : input.decision === 'accept'
            ? 'accepted'
            : 'rejected',
        item.title,
        id,
      );
      return this.enriched(q, id);
    });
  }
  async update(
    actor: Actor,
    id: string,
    raw: unknown,
    committed?: (q: QueryDB, item: Knowledge) => Promise<void>,
  ) {
    scope(actor, 'brain:write');
    const input = editSchema.parse(raw);
    return this.db.transaction(async (q) => {
      const old = await this.requireItem(q, id);
      requireCondition(
        old.version === input.expected_version,
        409,
        'version_conflict',
        'Knowledge changed. Refresh before editing.',
      );
      const next = { ...old, ...input };
      validDates(next);
      await q.query(
        `UPDATE knowledge SET title=$2,statement=$3,kind=$4,tags=$5,project=$6,subject=$7,predicate=$8,object=$9,context=$10,review_interval_days=$11,valid_from=$12,valid_to=$13,version=version+1,updated_at=now(),
        verified_at=CASE WHEN statement=$3 AND subject=$7 AND predicate=$8 AND object=$9 AND context=$10 AND valid_from IS NOT DISTINCT FROM $12::timestamptz AND valid_to IS NOT DISTINCT FROM $13::timestamptz THEN verified_at ELSE NULL END WHERE id=$1`,
        [
          id,
          next.title,
          next.statement,
          next.kind,
          stringify(next.tags),
          next.project,
          next.subject,
          next.predicate,
          next.object,
          next.context,
          next.review_interval_days,
          next.valid_from,
          next.valid_to,
        ],
      );
      await q.query('UPDATE nodes SET label=$2,type=$3 WHERE id=$1', [
        id,
        next.title,
        next.kind === 'factual_assertion' ? 'claim' : 'note',
      ]);
      await this.connect(q, id, next);
      await this.classification.classify(q, id);
      await this.index(
        q,
        id,
        next.title,
        next.statement,
        [...next.tags, next.project, next.subject].join(' '),
      );
      await this.detectConflicts(q, id);
      await this.snapshot(q, id);
      await this.activity(q, 'updated', next.title, id);
      const saved = await this.enriched(q, id);
      await committed?.(q, saved);
      return saved;
    });
  }
  async archive(actor: Actor, id: string, expectedVersion: number, restore = false) {
    scope(actor, 'brain:write');
    return this.db.transaction(async (q) => {
      const item = await this.requireItem(q, id);
      requireCondition(
        item.version === expectedVersion,
        409,
        'version_conflict',
        'Knowledge changed. Refresh before archiving.',
      );
      const next = restore
        ? (item as Raw & { archived_from?: string }).archived_from || 'active'
        : 'archived';
      requireCondition(
        restore ? item.lifecycle === 'archived' : item.lifecycle !== 'archived',
        400,
        'invalid_lifecycle',
        restore ? 'Item is not archived.' : 'Item is already archived.',
      );
      await q.query(
        'UPDATE knowledge SET archived_from=lifecycle,lifecycle=$2,version=version+1,updated_at=now() WHERE id=$1',
        [id, next],
      );
      await this.detectConflicts(q, id);
      await this.snapshot(q, id);
      await this.activity(q, restore ? 'restored' : 'archived', item.title, id);
      return this.enriched(q, id);
    });
  }
  async attachEvidence(actor: Actor, id: string, raw: unknown) {
    scope(actor, 'brain:write');
    const input = evidenceSchema.parse(raw);
    return this.idempotent(
      actor,
      'evidence',
      input.idempotency_key,
      { id, ...input },
      async (q) => {
        const item = await this.requireItem(q, id);
        requireCondition(
          item.version === input.expected_version,
          409,
          'version_conflict',
          'Knowledge changed. Refresh before adding evidence.',
        );
        const passage = await one<{ source_id: string }>(
          q,
          "SELECT r.source_id FROM passages p JOIN revisions r ON r.id=p.revision_id JOIN sources s ON s.id=r.source_id WHERE p.id=$1 AND s.status='active'",
          [input.passage_id],
        );
        requireCondition(passage, 404, 'not_found', 'Active source passage not found.');
        await q.query(
          'INSERT INTO evidence(id,knowledge_id,passage_id,relation,rationale) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [randomUUID(), id, input.passage_id, input.relation, input.rationale],
        );
        await this.edge(q, id, passage.source_id, 'cites');
        await q.query(
          'UPDATE knowledge SET version=version+1,updated_at=now(),verified_at=NULL WHERE id=$1',
          [id],
        );
        await this.snapshot(q, id);
        await this.activity(q, 'evidence added', item.title, id);
        return this.enriched(q, id);
      },
    );
  }
  async importSource(
    actor: Actor,
    raw: unknown,
    committed?: (q: QueryDB, item: { id: string; status: string }) => Promise<void>,
  ) {
    scope(actor, 'brain:write');
    const input = importSchema.parse(raw);
    requireCondition(
      [input.text, input.url, input.upload_id].filter(Boolean).length === 1,
      400,
      'invalid_input',
      'Choose exactly one source: text, public URL, or uploaded file.',
    );
    return this.idempotent(actor, 'import', input.idempotency_key, input, async (q) => {
      if (input.upload_id) {
        const upload = await one<{ name: string }>(q, 'SELECT name FROM uploads WHERE id=$1', [
          input.upload_id,
        ]);
        requireCondition(upload, 404, 'not_found', 'Upload not found.');
        requireCondition(
          !input.note_station || /\.nsx$/i.test(upload.name),
          400,
          'invalid_input',
          'Note Station options require an NSX archive.',
        );
      } else
        requireCondition(
          !input.note_station,
          400,
          'invalid_input',
          'Note Station options require an NSX archive.',
        );
      const id = randomUUID();
      await q.query('INSERT INTO jobs(id,title,payload) VALUES($1,$2,$3)', [
        id,
        input.title,
        stringify(input),
      ]);
      await this.activity(q, 'import queued', input.title);
      await committed?.(q, { id, status: 'queued' });
      return { id, status: 'queued' };
    });
  }
  async upload(
    actor: Actor,
    bytes: Buffer,
    name: string,
    mime: string,
  ): Promise<{ id: string; name: string; size: number }> {
    scope(actor, 'brain:write');
    if (/\.nsx$/i.test(name)) {
      requireCondition(bytes.length <= NSX_LIMIT, 400, 'size_limit', 'NSX archive exceeds 512 MB.');
      const key = randomUUID();
      await mkdir(path.join(this.storageRoot, 'incoming'), { recursive: true });
      await writeFile(storedPath(this.storageRoot, key, 'incoming'), bytes);
      return this.uploadDisk(actor, key, name, mime);
    }
    requireCondition(bytes.length <= 25 * 1024 * 1024, 400, 'size_limit', 'File exceeds 25 MB.');
    requireCondition(
      /\.(md|markdown|txt|html?|pdf)$/i.test(name),
      400,
      'unsupported_format',
      'Supported files: Markdown, text, HTML, PDF.',
    );
    const id = randomUUID();
    await this.db.query('INSERT INTO uploads(id,name,mime,bytes_base64) VALUES($1,$2,$3,$4)', [
      id,
      name,
      mime,
      bytes.toString('base64'),
    ]);
    return { id, name, size: bytes.length };
  }
  async uploadDisk(
    actor: Actor,
    storageKey: string,
    name: string,
    mime: string,
  ): Promise<{ id: string; name: string; size: number }> {
    scope(actor, 'brain:write');
    const file = storedPath(this.storageRoot, storageKey, 'incoming');
    let retained = false;
    try {
      const size = (await stat(file)).size;
      if (!/\.nsx$/i.test(name)) {
        requireCondition(size <= 25 * 1024 * 1024, 400, 'size_limit', 'Document exceeds 25 MB.');
        return await this.upload(actor, await readFile(file), name, mime);
      }
      requireCondition(size <= NSX_LIMIT, 400, 'size_limit', 'NSX archive exceeds 512 MB.');
      const archive = await NsxArchive.open(file);
      archive.close();
      const id = randomUUID();
      await this.db.query(
        "INSERT INTO uploads(id,name,mime,bytes_base64,storage_key) VALUES($1,$2,$3,'',$4)",
        [id, name, mime, storageKey],
      );
      retained = true;
      return { id, name, size };
    } finally {
      if (!retained) await removeStoredFile(file);
    }
  }
  async previewNsx(actor: Actor, id: string) {
    scope(actor, 'brain:write');
    const upload = await one<{ storage_key: string | null }>(
      this.db,
      'SELECT storage_key FROM uploads WHERE id=$1',
      [id],
    );
    requireCondition(upload?.storage_key, 400, 'not_nsx', 'Choose an uploaded NSX archive.');
    const archive = await NsxArchive.open(
      storedPath(this.storageRoot, upload.storage_key, 'incoming'),
    );
    try {
      return await archive.preview();
    } finally {
      archive.close();
    }
  }
  async discardUpload(actor: Actor, id: string) {
    scope(actor, 'brain:write');
    const active = await one(
      this.db,
      "SELECT id FROM jobs WHERE payload->>'upload_id'=$1 AND status IN ('queued','running','failed')",
      [id],
    );
    requireCondition(!active, 409, 'upload_in_use', 'This upload is needed by an import job.');
    const upload = await one<{ storage_key: string | null }>(
      this.db,
      'SELECT storage_key FROM uploads WHERE id=$1',
      [id],
    );
    if (upload?.storage_key)
      await removeStoredFile(storedPath(this.storageRoot, upload.storage_key, 'incoming'));
    await this.db.query('DELETE FROM uploads WHERE id=$1', [id]);
    return { deleted: true };
  }
  async attachment(actor: Actor, id: string) {
    scope(actor, 'brain:read');
    const attachment = await one<{
      name: string;
      mime: string;
      content_hash: string;
      size: number;
    }>(this.db, 'SELECT name,mime,content_hash,size FROM source_attachments WHERE id=$1', [id]);
    requireCondition(attachment, 404, 'not_found', 'Attachment not found.');
    return {
      ...attachment,
      file: storedPath(this.storageRoot, attachment.content_hash, 'attachments'),
    };
  }
  async originalNote(actor: Actor, sourceId: string, revisionId: string) {
    scope(actor, 'brain:read');
    const revision = await one<{ original_base64: string | null }>(
      this.db,
      "SELECT original_base64 FROM revisions WHERE id=$1 AND source_id=$2 AND parser='synology-nsx-json-v1'",
      [revisionId, sourceId],
    );
    requireCondition(
      revision?.original_base64,
      404,
      'not_found',
      'Original Note Station record not found.',
    );
    return Buffer.from(revision.original_base64, 'base64');
  }
  async jobs(actor: Actor) {
    scope(actor, 'brain:read');
    return rows<ImportJob>(
      this.db,
      'SELECT id,title,status,stage,progress,error,warnings,result,created_at,updated_at,attempts FROM jobs ORDER BY created_at DESC LIMIT 50',
    );
  }
  async getJob(actor: Actor, id: string) {
    scope(actor, 'brain:read');
    const job = await one<ImportJob>(
      this.db,
      'SELECT id,title,status,stage,progress,error,warnings,result,created_at,updated_at,attempts FROM jobs WHERE id=$1',
      [id],
    );
    requireCondition(job, 404, 'not_found', 'Import job not found.');
    return job;
  }
  async retryJob(actor: Actor, id: string) {
    scope(actor, 'brain:write');
    const job = await this.getJob({ ...actor, scopes: [...actor.scopes, 'brain:read'] }, id);
    requireCondition(
      job.status === 'failed',
      400,
      'invalid_job',
      'Only failed jobs can be retried.',
    );
    await this.db.query(
      "UPDATE jobs SET status='queued',stage='queued',progress=0,error=NULL,updated_at=now() WHERE id=$1",
      [id],
    );
    return { id, status: 'queued' };
  }
  async recoverJobs() {
    await this.db.query(
      "UPDATE jobs SET status='queued',stage='recovered',updated_at=now() WHERE status='running'",
    );
  }
  async processNextJob() {
    if (this.workerBusy) return;
    this.workerBusy = true;
    let job: { id: string; payload: z.infer<typeof importSchema> & { kind?: string } } | undefined;
    try {
      job = await one(
        this.db,
        "UPDATE jobs SET status='running',stage='reading',progress=10,attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING id,payload",
      );
      if (!job) return;
      if (job.payload.kind === 'categorization') {
        await this.classification.run(job.id);
        return;
      }
      const input = job.payload;
      let parsed;
      let origin = 'text';
      let url: string | null = null;
      let originalKey: string;
      if (input.url) {
        const fetched = await fetchPublicPage(input.url);
        url = fetched.url;
        origin = 'url';
        parsed = await parseFile(
          fetched.content,
          fetched.type.includes('pdf')
            ? 'page.pdf'
            : fetched.type.includes('html')
              ? 'page.html'
              : 'page.txt',
          fetched.type,
        );
        originalKey = input.url;
      } else if (input.upload_id) {
        const uploaded = await one<{
          name: string;
          mime: string;
          bytes_base64: string;
          storage_key: string | null;
        }>(this.db, 'SELECT * FROM uploads WHERE id=$1', [input.upload_id]);
        requireCondition(uploaded, 404, 'upload_missing', 'Uploaded file no longer exists.');
        if (/\.nsx$/i.test(uploaded.name)) {
          requireCondition(
            uploaded.storage_key,
            400,
            'upload_missing',
            'NSX archive is unavailable.',
          );
          await this.processNsxJob(job.id, input, uploaded.storage_key);
          return;
        }
        parsed = await parseFile(
          Buffer.from(uploaded.bytes_base64, 'base64'),
          uploaded.name,
          uploaded.mime,
        );
        origin = 'file';
        originalKey = uploaded.name;
      } else {
        parsed = await parseFile(Buffer.from(input.text!), 'pasted.txt');
        originalKey = input.title;
      }
      const sourceHash = hash(parsed.text);
      const originKey = hash(`${origin}:${originalKey}:${input.project}`);
      await this.db.query(
        "UPDATE jobs SET stage='extracting',progress=40,updated_at=now() WHERE id=$1",
        [job.id],
      );
      const chunks = chunkText(parsed.text);
      const { candidates, warnings } = await extractCandidates(chunks);
      const jobId = job.id;
      await this.db.transaction(async (q) => {
        let source = await one<{ id: string }>(q, 'SELECT id FROM sources WHERE origin_key=$1', [
          originKey,
        ]);
        if (!source) {
          source = { id: randomUUID() };
          await q.query("INSERT INTO nodes(id,type,label) VALUES($1,'source',$2)", [
            source.id,
            input.title,
          ]);
          await q.query(
            'INSERT INTO sources(id,title,origin,url,origin_key,lineage_group,tags,project) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              source.id,
              input.title,
              origin,
              url,
              originKey,
              input.lineage_group || originKey,
              stringify(input.tags),
              input.project,
            ],
          );
          await this.connect(q, source.id, {
            tags: input.tags,
            project: input.project,
            subject: '',
          });
        }
        const existing = await one<{ id: string }>(
          q,
          'SELECT id FROM revisions WHERE source_id=$1 AND content_hash=$2',
          [source.id, sourceHash],
        );
        if (existing) {
          await this.classification.classify(q, source.id);
          const count = await one<{ n: number }>(
            q,
            'SELECT count(DISTINCT e.knowledge_id)::int AS n FROM evidence e JOIN passages p ON p.id=e.passage_id WHERE p.revision_id=$1',
            [existing.id],
          );
          await q.query(
            "UPDATE jobs SET status='completed',stage='completed',progress=100,result=$2,warnings=$3,updated_at=now() WHERE id=$1",
            [
              jobId,
              stringify({
                source_id: source.id,
                revision_id: existing.id,
                claims: count?.n || 0,
                duplicate: true,
              }),
              stringify(['Identical source revision already exists. No duplicate claims created.']),
            ],
          );
          return;
        }
        const revisionId = randomUUID();
        // A changed source may invalidate old verification, but it does not silently declare older claims false.
        const affected = await rows<{ id: string }>(
          q,
          'SELECT DISTINCT k.id FROM knowledge k JOIN evidence e ON e.knowledge_id=k.id JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id WHERE r.source_id=$1 AND k.verified_at IS NOT NULL',
          [source.id],
        );
        for (const old of affected) {
          await q.query(
            'UPDATE knowledge SET verified_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
            [old.id],
          );
          await this.snapshot(q, old.id);
        }
        await q.query(
          'INSERT INTO revisions(id,source_id,content_hash,text,original_base64,parser) VALUES($1,$2,$3,$4,$5,$6)',
          [revisionId, source.id, sourceHash, parsed.text, parsed.original || null, parsed.parser],
        );
        await this.classification.classify(q, source.id);
        const passageIds: string[] = [];
        for (const chunk of chunks) {
          const id = randomUUID();
          passageIds.push(id);
          await q.query(
            'INSERT INTO passages(id,revision_id,text,anchor,start_offset,end_offset) VALUES($1,$2,$3,$4,$5,$6)',
            [id, revisionId, chunk.text, chunk.anchor, chunk.start_offset, chunk.end_offset],
          );
          await this.index(
            q,
            id,
            input.title,
            chunk.text,
            [...input.tags, input.project].join(' '),
            true,
          );
        }
        for (const candidate of candidates) {
          const id = await this.insertKnowledge(
            q,
            captureSchema.parse({
              title: candidate.statement.slice(0, 100),
              statement: candidate.statement,
              kind: 'factual_assertion',
              tags: input.tags,
              project: input.project,
              subject: candidate.subject,
              predicate: candidate.predicate,
              object: candidate.object,
              context: `Source: ${input.title}`,
              review_interval_days: input.review_interval_days,
              idempotency_key: jobId,
            }),
            'candidate',
            source.id,
          );
          await q.query(
            "INSERT INTO evidence(id,knowledge_id,passage_id,relation,rationale) VALUES($1,$2,$3,'supports',$4)",
            [
              randomUUID(),
              id,
              passageIds[candidate.passage_index],
              'Candidate extracted from this source. The source assertion needs review.',
            ],
          );
          await this.edge(q, id, source.id, 'cites');
          await this.snapshot(q, id);
        }
        await q.query(
          "UPDATE jobs SET status='completed',stage='completed',progress=100,result=$2,warnings=$3,updated_at=now() WHERE id=$1",
          [
            jobId,
            stringify({
              source_id: source.id,
              revision_id: revisionId,
              claims: candidates.length,
              duplicate: false,
            }),
            stringify([...parsed.warnings, ...warnings]),
          ],
        );
        await this.activity(q, 'import completed', input.title);
      });
    } catch (error) {
      if (job)
        await this.db.query(
          "UPDATE jobs SET status='failed',stage='failed',error=$2,updated_at=now() WHERE id=$1",
          [job.id, error instanceof Error ? error.message : 'Import failed.'],
        );
    } finally {
      this.workerBusy = false;
    }
  }
  private async persistNsxCandidates(
    q: QueryDB,
    sourceId: string,
    title: string,
    jobId: string,
    passageIds: string[],
    candidates: Candidate[],
    tags: string[],
    project: string,
    interval: number | null,
  ) {
    for (const candidate of candidates) {
      const id = await this.insertKnowledge(
        q,
        captureSchema.parse({
          title: candidate.statement.slice(0, 100),
          statement: candidate.statement,
          kind: 'factual_assertion',
          tags,
          project,
          subject: candidate.subject,
          predicate: candidate.predicate,
          object: candidate.object,
          context: `Source: ${title}`.slice(0, 1000),
          review_interval_days: interval,
          idempotency_key: jobId,
        }),
        'candidate',
        sourceId,
      );
      await q.query(
        "INSERT INTO evidence(id,knowledge_id,passage_id,relation,rationale) VALUES($1,$2,$3,'supports','Candidate extracted from a Note Station note; review the source assertion.')",
        [randomUUID(), id, passageIds[candidate.passage_index]],
      );
      await this.edge(q, id, sourceId, 'cites');
      await this.snapshot(q, id);
    }
  }
  private async processNsxJob(
    jobId: string,
    input: CaptureInput | z.infer<typeof importSchema>,
    storageKey: string,
  ) {
    const importInput = importSchema.parse(input);
    const archive = await NsxArchive.open(storedPath(this.storageRoot, storageKey, 'incoming'));
    const result = {
      notes: 0,
      imported: 0,
      duplicates: 0,
      skipped: 0,
      attachments: 0,
      claims: 0,
      total: archive.ids.length,
      source_ids: [] as string[],
    };
    const warnings: string[] = [];
    const warn = (message: string) => {
      if (warnings.length < 50 && !warnings.includes(message)) warnings.push(message);
    };
    try {
      const selected = importInput.note_station?.notebook_ids;
      const availableNotebooks = selected
        ? new Set((await archive.preview()).notebooks.map((notebook) => notebook.id))
        : null;
      if (selected)
        requireCondition(
          selected.length > 0 && selected.every((id) => availableNotebooks!.has(id)),
          400,
          'invalid_notebook',
          'Choose at least one notebook from this archive.',
        );
      for (let i = 0; i < archive.ids.length; i++) {
        let note: NsxNote;
        try {
          note = await archive.note(archive.ids[i]);
        } catch {
          result.skipped++;
          warn(`A note record (${archive.ids[i]}) is missing or malformed.`);
          continue;
        }
        if (selected && !selected.includes(note.metadata.notebook_id)) continue;
        result.notes++;
        note.metadata.warnings.forEach((message) => warn(`${note.title.slice(0, 80)}: ${message}`));
        requireCondition(
          note.text.length <= 500000,
          400,
          'text_limit',
          'A note exceeds the 500,000-character limit. Select a smaller notebook or shorten the note in Note Station.',
        );
        const originKey = hash(`note-station:${note.id}`);
        const revisionHash = hash(note.original);
        const existing = await one<{
          source_id: string;
          id: string;
          tags: string[];
          project: string;
        }>(
          this.db,
          'SELECT r.id,r.source_id,s.tags,s.project FROM revisions r JOIN sources s ON s.id=r.source_id WHERE s.origin_key=$1 AND r.content_hash=$2',
          [originKey, revisionHash],
        );
        if (existing) {
          await this.db.transaction((q) => this.classification.classify(q, existing.source_id));
          if (importInput.note_station?.extract_claims && !note.unreadable) {
            const extracted = await one(
              this.db,
              'SELECT e.id FROM evidence e JOIN passages p ON p.id=e.passage_id JOIN knowledge k ON k.id=e.knowledge_id WHERE p.revision_id=$1 AND k.derived_source_id=$2 LIMIT 1',
              [existing.id, existing.source_id],
            );
            if (!extracted) {
              const retained = await rows<Chunk & { id: string }>(
                this.db,
                'SELECT id,text,anchor,start_offset,end_offset FROM passages WHERE revision_id=$1 ORDER BY start_offset',
                [existing.id],
              );
              const extraction = await extractCandidates(retained);
              await this.db.transaction((q) =>
                this.persistNsxCandidates(
                  q,
                  existing.source_id,
                  note.title,
                  jobId,
                  retained.map((passage) => passage.id),
                  extraction.candidates,
                  existing.tags,
                  existing.project,
                  importInput.review_interval_days,
                ),
              );
              result.claims += extraction.candidates.length;
            }
          }
          result.duplicates++;
          result.source_ids.push(existing.source_id);
          continue;
        }
        const chunks = chunkText(note.text);
        const extraction =
          importInput.note_station?.extract_claims && !note.unreadable
            ? await extractCandidates(chunks)
            : { candidates: [], warnings: [] };
        const attachments: { name: string; mime: string; size: number; content_hash: string }[] =
          [];
        for (const att of note.attachments.filter((att) => !att.missing)) {
          const bytes = await archive.archive.read(att.entry, 64 * 1024 * 1024);
          attachments.push({
            name: att.name,
            mime: att.mime,
            size: bytes.length,
            content_hash: await storeAttachment(this.storageRoot, bytes),
          });
        }
        const tags = [
          ...new Set(
            [...importInput.tags, ...note.metadata.original_tags]
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => tag.slice(0, 60)),
          ),
        ].slice(0, 12);
        const project = (importInput.project || note.metadata.notebook).slice(0, 100);
        await this.db.transaction(async (q) => {
          let source = await one<{ id: string }>(q, 'SELECT id FROM sources WHERE origin_key=$1', [
            originKey,
          ]);
          if (!source) {
            source = { id: randomUUID() };
            await q.query("INSERT INTO nodes(id,type,label) VALUES($1,'source',$2)", [
              source.id,
              note.title,
            ]);
            await q.query(
              "INSERT INTO sources(id,title,origin,origin_key,lineage_group,tags,project,metadata) VALUES($1,$2,'note_station',$3,$3,$4,$5,$6)",
              [
                source.id,
                note.title,
                originKey,
                stringify(tags),
                project,
                stringify(note.metadata),
              ],
            );
          } else {
            const affected = await rows<{ id: string }>(
              q,
              'SELECT DISTINCT k.id FROM knowledge k JOIN evidence e ON e.knowledge_id=k.id JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id WHERE r.source_id=$1 AND k.verified_at IS NOT NULL',
              [source.id],
            );
            for (const old of affected) {
              await q.query(
                'UPDATE knowledge SET verified_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
                [old.id],
              );
              await this.snapshot(q, old.id);
            }
            await q.query(
              'UPDATE sources SET title=$2,tags=$3,project=$4,metadata=$5 WHERE id=$1',
              [source.id, note.title, stringify(tags), project, stringify(note.metadata)],
            );
            await q.query('UPDATE nodes SET label=$2 WHERE id=$1', [source.id, note.title]);
          }
          await this.connect(q, source.id, { tags, project, subject: '' });
          result.source_ids.push(source.id);
          const revisionId = randomUUID();
          await q.query(
            "INSERT INTO revisions(id,source_id,content_hash,text,original_base64,parser) VALUES($1,$2,$3,$4,$5,'synology-nsx-json-v1')",
            [revisionId, source.id, revisionHash, note.text, note.original.toString('base64')],
          );
          await this.classification.classify(q, source.id);
          const passageIds: string[] = [];
          for (const chunk of chunks) {
            const id = randomUUID();
            passageIds.push(id);
            await q.query(
              'INSERT INTO passages(id,revision_id,text,anchor,start_offset,end_offset) VALUES($1,$2,$3,$4,$5,$6)',
              [id, revisionId, chunk.text, chunk.anchor, chunk.start_offset, chunk.end_offset],
            );
            await this.index(
              q,
              id,
              note.title,
              chunk.text,
              [...tags, project, note.metadata.stack].join(' '),
              true,
            );
          }
          for (const att of attachments)
            await q.query(
              'INSERT INTO source_attachments(id,revision_id,name,mime,size,content_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
              [randomUUID(), revisionId, att.name, att.mime, att.size, att.content_hash],
            );
          await this.persistNsxCandidates(
            q,
            source.id,
            note.title,
            jobId,
            passageIds,
            extraction.candidates,
            tags,
            project,
            importInput.review_interval_days,
          );
          result.imported++;
          result.attachments += attachments.length;
          result.claims += extraction.candidates.length;
          await q.query(
            "UPDATE jobs SET stage='Importing notes',progress=$2,result=$3,warnings=$4,updated_at=now() WHERE id=$1",
            [
              jobId,
              Math.min(99, Math.round(((i + 1) / archive.ids.length) * 100)),
              stringify(result),
              stringify(warnings),
            ],
          );
        });
      }
      warn(
        'Note timestamps describe the original notes; importing them does not verify their contents.',
      );
      if (result.skipped)
        warn(
          `${result.skipped} note(s) could not be read. Other notes were imported; inspect the warnings before considering the migration complete.`,
        );
      await this.db.query(
        "UPDATE jobs SET status='completed',stage='completed',progress=100,result=$2,warnings=$3,updated_at=now() WHERE id=$1",
        [jobId, stringify(result), stringify(warnings)],
      );
    } finally {
      archive.close();
    }
    // Each original note JSON and media file are retained separately. Drop the bulk archive
    // after completion so forgetting one note cannot leave its content in an old ZIP copy.
    await removeStoredFile(storedPath(this.storageRoot, storageKey, 'incoming'));
    await this.db.query('DELETE FROM uploads WHERE storage_key=$1', [storageKey]);
  }
  async sources(actor: Actor): Promise<Source[]> {
    scope(actor, 'brain:read');
    return rows<Source>(
      this.db,
      `SELECT s.*,count(DISTINCT r.id)::int AS revision_count,count(DISTINCT e.knowledge_id)::int AS claim_count FROM sources s LEFT JOIN revisions r ON r.source_id=s.id LEFT JOIN passages p ON p.revision_id=r.id LEFT JOIN evidence e ON e.passage_id=p.id GROUP BY s.id ORDER BY s.created_at DESC`,
    );
  }
  async browseSources(actor: Actor, raw: unknown): Promise<SourceBrowseResult> {
    scope(actor, 'brain:read');
    const input = sourceBrowseSchema.parse(raw);
    const params = [
      input.topic,
      stringify([input.topic]),
      input.project,
      input.origin,
      input.query,
    ];
    const where = `s.status='active' AND ($1='' OR s.tags @> $2::jsonb) AND ($3='' OR s.project=$3) AND ($4='all' OR s.origin=$4) ${input.query ? "AND (to_tsvector('simple',concat_ws(' ',s.title,s.project,s.tags::text)) @@ websearch_to_tsquery('simple',$5) OR EXISTS(SELECT 1 FROM revisions r JOIN passages p ON p.revision_id=r.id JOIN search_documents d ON d.passage_id=p.id WHERE r.source_id=s.id AND d.lexical @@ websearch_to_tsquery('simple',$5)))" : "AND $5=''"}`;
    const count = await one<{ n: number }>(
      this.db,
      `SELECT count(*)::int AS n FROM sources s WHERE ${where}`,
      params,
    );
    const items = await rows<Source & { excerpt: string }>(
      this.db,
      `SELECT s.*,(SELECT count(*)::int FROM revisions r WHERE r.source_id=s.id) AS revision_count,(SELECT count(DISTINCT e.knowledge_id)::int FROM revisions r JOIN passages p ON p.revision_id=r.id JOIN evidence e ON e.passage_id=p.id WHERE r.source_id=s.id) AS claim_count,coalesce((SELECT left(r.text,300) FROM revisions r WHERE r.source_id=s.id ORDER BY r.observed_at DESC,r.id LIMIT 1),'') AS excerpt FROM sources s WHERE ${where} ORDER BY s.created_at DESC,s.id LIMIT $6 OFFSET $7`,
      [...params, input.limit, input.offset],
    );
    return { items, total: count?.n || 0 };
  }
  async sourceDetail(actor: Actor, id: string) {
    scope(actor, 'brain:read');
    const source = await one<Source>(this.db, 'SELECT * FROM sources WHERE id=$1', [id]);
    requireCondition(source, 404, 'not_found', 'Source not found.');
    const revisionRows = await rows<{
      id: string;
      content_hash: string;
      text: string;
      observed_at: string;
      parser: string;
      original_base64: string | null;
    }>(
      this.db,
      'SELECT id,content_hash,text,observed_at,parser,original_base64 FROM revisions WHERE source_id=$1 ORDER BY observed_at DESC,id DESC',
      [id],
    );
    const revisions = revisionRows.map(({ original_base64, ...revision }) => ({
      ...revision,
      document: sourceDocument(revision.parser, original_base64),
    }));
    const passages = await rows<Record<string, unknown>>(
      this.db,
      'SELECT p.* FROM passages p JOIN revisions r ON r.id=p.revision_id WHERE r.source_id=$1 ORDER BY r.observed_at DESC,p.start_offset',
      [id],
    );
    const attachments = await rows<SourceAttachment>(
      this.db,
      'SELECT a.id,a.revision_id,a.name,a.mime,a.size::int,a.content_hash FROM source_attachments a JOIN revisions r ON r.id=a.revision_id WHERE r.source_id=$1 ORDER BY a.name',
      [id],
    );
    return { ...source, revisions, passages, attachments };
  }
  async retractSource(actor: Actor, id: string) {
    scope(actor, 'brain:review');
    return this.db.transaction(async (q) => {
      const source = await one<Source>(q, 'SELECT * FROM sources WHERE id=$1', [id]);
      requireCondition(source, 404, 'not_found', 'Source not found.');
      await q.query("UPDATE sources SET status='retracted' WHERE id=$1", [id]);
      await redactAssistantSources(q, [id]);
      const affected = await rows<{ id: string }>(
        q,
        'SELECT DISTINCT e.knowledge_id AS id FROM evidence e JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id WHERE r.source_id=$1',
        [id],
      );
      for (const item of affected) {
        await q.query(
          'UPDATE knowledge SET verified_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
          [item.id],
        );
        await this.snapshot(q, item.id);
      }
      await this.activity(q, 'source retracted', source.title);
      return { id, affected: affected.length };
    });
  }
  async search(actor: Actor, raw: unknown): Promise<SearchResult> {
    scope(actor, 'brain:read');
    const input = searchSchema.parse(raw);
    const at = new Date(input.as_of || new Date().toISOString());
    let all = await this.allKnowledge(actor);
    if (input.recorded_at) {
      const snapshots = await rows<{ snapshot: Knowledge }>(
        this.db,
        'SELECT DISTINCT ON(knowledge_id) snapshot FROM versions WHERE recorded_at<=$1 ORDER BY knowledge_id,version DESC',
        [input.recorded_at],
      );
      all = snapshots.map((x) => ({ ...x.snapshot, ...temporalQuality(x.snapshot, at) }));
    } else all = all.map((x) => ({ ...x, ...temporalQuality(x, at) }));
    const eligible = all.filter((k) => {
      if (
        input.lifecycle
          ? k.lifecycle !== input.lifecycle
          : !(
              k.lifecycle === 'active' ||
              (input.include_candidates && k.lifecycle === 'candidate') ||
              (input.temporal_mode !== 'current' && k.lifecycle === 'superseded')
            )
      )
        return false;
      if (
        (input.topic && !k.tags.includes(input.topic)) ||
        (input.project && k.project !== input.project) ||
        (input.kind && k.kind !== input.kind)
      )
        return false;
      if (input.temporal_mode !== 'all' && ['expired', 'not_yet_valid'].includes(k.freshness))
        return false;
      if (!input.include_stale && ['stale', 'review_due', 'unknown'].includes(k.freshness))
        return false;
      return true;
    });
    const ids = eligible.map((k) => k.id);
    let warnings: string[] = [];
    const model = await this.embeddings?.status();
    if (!model || model.state !== 'ready')
      warnings.push('Semantic search is unavailable; results use full-text search.');
    else if (model.pending)
      warnings.push(`${model.pending} passages or claims are awaiting semantic indexing.`);
    if (input.recorded_at)
      warnings.push(
        'Recorded-time search uses saved claim versions. Source passages are current retained snapshots, not a complete historical source catalog.',
      );
    const qtext = input.query;
    const sourceFilter = `s.status='active' AND ($2='' OR s.tags @> $3::jsonb) AND ($4='' OR s.project=$4)`;
    const eligibleWhere = `(d.knowledge_id=ANY($1::uuid[]) OR ($5::boolean AND d.passage_id IS NOT NULL AND ${sourceFilter}))`;
    const params: unknown[] = [
      ids,
      input.topic,
      stringify([input.topic]),
      input.project,
      input.include_sources,
    ];
    const joins =
      'FROM search_documents d LEFT JOIN passages p ON p.id=d.passage_id LEFT JOIN revisions r ON r.id=p.revision_id LEFT JOIN sources s ON s.id=r.source_id';
    type Hit = {
      id: string;
      knowledge_id: string | null;
      passage_id: string | null;
      score: number;
    };
    let hits: Hit[] = [];
    const ranks = new Map<string, { score: number; types: Set<string>; hit: Hit }>();
    const contribute = (list: Hit[], type: string) =>
      list.forEach((hit, i) => {
        const v = ranks.get(hit.id) || { score: 0, types: new Set<string>(), hit };
        v.score += 1 / (60 + i + 1);
        v.types.add(type);
        ranks.set(hit.id, v);
      });
    if (qtext) {
      const lexical = await rows<Hit>(
        this.db,
        `SELECT d.id,d.knowledge_id,d.passage_id,ts_rank_cd(d.lexical,websearch_to_tsquery('simple',$6)) AS score ${joins} WHERE ${eligibleWhere} AND d.lexical @@ websearch_to_tsquery('simple',$6) ORDER BY score DESC LIMIT 100`,
        [...params, qtext],
      );
      contribute(lexical, 'keyword');
      const vector = input.recorded_at ? null : await this.embeddings?.embed(qtext, true);
      if (vector) {
        const semantic = await rows<Hit>(
          this.db,
          `SELECT d.id,d.knowledge_id,d.passage_id,1-(d.embedding <=> $6::vector) AS score ${joins} WHERE ${eligibleWhere} AND d.embedding IS NOT NULL AND d.model_id=$7 AND 1-(d.embedding <=> $6::vector)>$8 ORDER BY d.embedding <=> $6::vector LIMIT 100`,
          [...params, stringify(vector), this.embeddings!.modelId, config.semanticMinScore],
        );
        contribute(semantic, 'semantic');
      }
      if (input.recorded_at) {
        const terms = qtext
          .toLocaleLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1);
        const historicalHits = eligible
          .filter((k) =>
            terms.every((t) =>
              `${k.title} ${k.statement} ${k.tags.join(' ')}`.toLocaleLowerCase().includes(t),
            ),
          )
          .map((k) => ({ id: k.id, knowledge_id: k.id, passage_id: null, score: 1 }));
        ranks.clear();
        contribute(historicalHits, 'version text');
      }
      hits = [...ranks.values()].sort((a, b) => b.score - a.score).map((x) => x.hit);
    } else
      hits = eligible.map((k) => ({ id: k.id, knowledge_id: k.id, passage_id: null, score: 0 }));
    const byId = new Map(eligible.map((k) => [k.id, k]));
    const selected = new Map<string, Knowledge>();
    for (const hit of hits) {
      if (hit.knowledge_id && byId.has(hit.knowledge_id)) {
        const rank = ranks.get(hit.id);
        selected.set(hit.knowledge_id, {
          ...byId.get(hit.knowledge_id)!,
          score: rank?.score || 0,
          match_type: rank ? [...rank.types].join(' + ') : 'recent',
        });
      }
      if (hit.passage_id) {
        const claims = await rows<{ knowledge_id: string }>(
          this.db,
          'SELECT knowledge_id FROM evidence WHERE passage_id=$1',
          [hit.passage_id],
        );
        for (const claim of claims)
          if (byId.has(claim.knowledge_id) && !selected.has(claim.knowledge_id))
            selected.set(claim.knowledge_id, {
              ...byId.get(claim.knowledge_id)!,
              score: ranks.get(hit.id)?.score || 0,
              match_type: 'source match',
            });
      }
    }
    if (input.graph_expansion && qtext && selected.size && !input.recorded_at) {
      const neighbors = await rows<{ id: string }>(
        this.db,
        `SELECT DISTINCT r2.source_node AS id FROM relations r1 JOIN relations r2 ON r2.target_node=r1.target_node WHERE r1.source_node=ANY($1::uuid[]) AND r1.type IN ('about','in_project') AND r2.type IN ('about','in_project') LIMIT 30`,
        [[...selected.keys()].slice(0, 5)],
      );
      for (const n of neighbors)
        if (byId.has(n.id) && !selected.has(n.id))
          selected.set(n.id, { ...byId.get(n.id)!, score: 0.0001, match_type: 'graph connection' });
    }
    const passageHits = hits.filter((x) => x.passage_id).slice(0, Math.min(input.limit, 20));
    const passages = await Promise.all(
      passageHits.map(async (hit) => {
        const passage = await one<{
          id: string;
          text: string;
          anchor: string;
          source_id: string;
          source_title: string;
          revision_id: string;
        }>(
          this.db,
          'SELECT p.id,p.text,p.anchor,r.source_id,s.title AS source_title,r.id AS revision_id FROM passages p JOIN revisions r ON r.id=p.revision_id JOIN sources s ON s.id=r.source_id WHERE p.id=$1',
          [hit.passage_id],
        );
        return {
          ...passage!,
          score: ranks.get(hit.id)?.score || 0,
          match_type: [...ranks.get(hit.id)!.types].join(' + '),
        };
      }),
    );
    return {
      items: [...selected.values()].slice(input.offset, input.offset + input.limit),
      passages,
      total: selected.size,
      as_of: at.toISOString(),
      mode: model?.state === 'ready' ? 'hybrid' : 'keyword',
      warnings,
    };
  }
  async answer(actor: Actor, raw: unknown) {
    const result = await this.search(actor, raw);
    const grounded = result.items
      .filter((k) => k.lifecycle === 'active' && k.match_type !== 'graph connection')
      .slice(0, 5);
    const citations = await Promise.all(grounded.map((k) => this.getKnowledge(actor, k.id)));
    // The spike returns evidence excerpts rather than generating unsupported prose.
    return {
      query: searchSchema.parse(raw).query,
      mode: 'evidence_digest',
      gap: !grounded.length && !result.passages.length,
      summary: grounded.length
        ? `Found ${grounded.length} relevant accepted ${grounded.length === 1 ? 'item' : 'items'}. Read the evidence and review state below.`
        : result.passages.length
          ? 'Related source passages are available, but no accepted claim answers this question yet.'
          : 'There is not enough relevant knowledge to answer this question. Add a source or record what you know.',
      claims: citations,
      passages: result.passages.slice(0, 5),
      warnings: result.warnings,
      as_of: result.as_of,
    };
  }
  async graph(actor: Actor, raw: unknown): Promise<GraphResult> {
    scope(actor, 'brain:read');
    const input = graphSchema.parse(raw);
    let items = (await this.allKnowledge(actor)).filter(
      (k) =>
        (k.lifecycle === 'active' ||
          (input.include_candidates && k.lifecycle === 'candidate') ||
          (input.include_archived && k.lifecycle === 'archived')) &&
        (!input.topic || k.tags.includes(input.topic)) &&
        (!input.project || k.project === input.project),
    );
    let sources = (await this.sources(actor)).filter(
      (source) =>
        source.status === 'active' &&
        (!input.topic || source.tags.includes(input.topic)) &&
        (!input.project || source.project === input.project),
    );
    const allNodes = await rows<{ id: string; type: GraphNode['type']; label: string }>(
      this.db,
      "SELECT * FROM nodes WHERE type <> 'import_collection'",
    );
    const relations = await rows<GraphEdge>(
      this.db,
      'SELECT id,source_node AS source,target_node AS target,type,properties FROM relations',
    );
    if (input.category_id) {
      requireCondition(
        allNodes.some((node) => node.id === input.category_id && node.type === 'category'),
        404,
        'not_found',
        'Category not found.',
      );
      const descendants = new Set([input.category_id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of relations)
          if (
            edge.type === 'category_parent' &&
            descendants.has(edge.target) &&
            !descendants.has(edge.source)
          ) {
            descendants.add(edge.source);
            changed = true;
          }
      }
      const members = new Set(
        relations
          .filter((edge) => edge.type === 'categorized_as' && descendants.has(edge.target))
          .map((edge) => edge.source),
      );
      items = items.filter((item) => members.has(item.id));
      sources = sources.filter((source) => members.has(source.id));
    }
    const eligibleIds = new Set([
      ...items.map((item) => item.id),
      ...sources.map((source) => source.id),
    ]);
    const permitted = new Set(
      allNodes
        .filter((n) => !['claim', 'note', 'source'].includes(n.type) || eligibleIds.has(n.id))
        .map((n) => n.id),
    );
    const allEdges = relations.filter((e) => permitted.has(e.source) && permitted.has(e.target));
    let keep = new Set<string>(eligibleIds);
    if (input.focus_id) {
      requireCondition(
        permitted.has(input.focus_id),
        404,
        'not_found',
        'Visible graph node not found.',
      );
      keep = new Set([input.focus_id]);
    }
    for (let hop = 0; hop < (input.focus_id ? input.hops : 1); hop++) {
      const next = new Set(keep);
      for (const e of allEdges)
        if (keep.has(e.source) || keep.has(e.target)) {
          next.add(e.source);
          next.add(e.target);
        }
      keep = next;
    }
    // Category ancestors travel with their children even beyond the neighborhood hop bound.
    let addedParent = true;
    while (addedParent) {
      addedParent = false;
      for (const edge of allEdges)
        if (edge.type === 'category_parent' && keep.has(edge.source) && !keep.has(edge.target)) {
          keep.add(edge.target);
          addedParent = true;
        }
    }
    const ordered = allNodes.filter((n) => keep.has(n.id));
    const nodeMap = new Map(ordered.map((node) => [node.id, node]));
    const selectedMap = new Map<string, (typeof ordered)[number]>();
    const categoryTargets = new Map<string, string[]>();
    for (const edge of allEdges)
      if (['categorized_as', 'category_parent'].includes(edge.type) && keep.has(edge.target)) {
        if (!categoryTargets.has(edge.source)) categoryTargets.set(edge.source, []);
        categoryTargets.get(edge.source)!.push(edge.target);
      }
    const addBundle = (node: (typeof ordered)[number]) => {
      if (selectedMap.has(node.id) || selectedMap.size >= input.limit) return;
      const bundle = new Set([node.id]);
      const pending = [node.id];
      while (pending.length) {
        const current = pending.pop()!;
        for (const target of categoryTargets.get(current) || [])
          if (!bundle.has(target)) {
            bundle.add(target);
            pending.push(target);
          }
      }
      const newIds = [...bundle].filter((id) => !selectedMap.has(id));
      if (selectedMap.size + newIds.length > input.limit) return;
      for (const id of newIds) selectedMap.set(id, nodeMap.get(id)!);
    };
    if (input.focus_id) selectedMap.set(input.focus_id, nodeMap.get(input.focus_id)!);
    // Sample across category branches so a large notebook doesn't consume the entire view.
    const groups = new Map<string, typeof ordered>();
    for (const node of ordered
      .filter((node) => eligibleIds.has(node.id))
      .sort((a, b) => a.id.localeCompare(b.id))) {
      const category = categoryTargets.get(node.id)?.[0] || '';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(node);
    }
    const queues = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, nodes]) => nodes);
    for (let i = 0; queues.some((queue) => queue.length > i); i++)
      for (const queue of queues) if (queue[i]) addBundle(queue[i]);
    for (const node of ordered.sort(
      (a, b) =>
        Number(b.type === 'category') - Number(a.type === 'category') || a.id.localeCompare(b.id),
    ))
      addBundle(node);
    const selected = [...selectedMap.values()];
    const selectedIds = new Set(selected.map((n) => n.id));
    const byId = new Map(items.map((k) => [k.id, k]));
    const edges = allEdges
      .filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target))
      .slice(0, 500);
    return {
      nodes: selected.map((n) => ({
        ...n,
        ...(byId.has(n.id)
          ? {
              lifecycle: byId.get(n.id)!.lifecycle,
              freshness: byId.get(n.id)!.freshness,
              evidence_status: byId.get(n.id)!.evidence_status,
            }
          : {}),
      })),
      edges,
      truncated:
        ordered.length > selected.length ||
        allEdges.filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target)).length > 500,
      total_nodes: ordered.length,
    };
  }
  async dashboard(actor: Actor): Promise<Dashboard> {
    const items = await this.allKnowledge(actor);
    const sources = await this.sources(actor);
    const counts = new Map<string, number>();
    const projects = new Map<string, number>();
    for (const source of sources.filter((source) => source.status === 'active')) {
      for (const tag of source.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      if (source.project) projects.set(source.project, (projects.get(source.project) || 0) + 1);
    }
    for (const item of items.filter((item) => item.lifecycle === 'active'))
      if (item.project) projects.set(item.project, (projects.get(item.project) || 0) + 1);
    for (const k of items.filter((k) => k.lifecycle === 'active'))
      for (const tag of k.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    const connections = await one<{ n: number }>(
      this.db,
      'SELECT count(*)::int AS n FROM relations',
    );
    return {
      total: items.filter((k) => !['archived', 'rejected'].includes(k.lifecycle)).length,
      active: items.filter((k) => k.lifecycle === 'active').length,
      candidates: items.filter((k) => k.lifecycle === 'candidate').length,
      due: items.filter(
        (k) => k.lifecycle === 'active' && ['stale', 'review_due'].includes(k.freshness),
      ).length,
      sources: sources.length,
      projects: [...projects]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      connections: connections?.n || 0,
      conflicts: items.filter((k) => k.conflict_count > 0).length,
      recent: items.filter((k) => k.lifecycle === 'active').slice(0, 6),
      topics: [...counts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      activity: await rows(
        this.db,
        'SELECT id,action,title,created_at FROM activity ORDER BY created_at DESC LIMIT 12',
      ),
    };
  }
  async reviewQueue(actor: Actor) {
    const items = await this.allKnowledge(actor);
    return {
      candidates: items.filter((k) => k.lifecycle === 'candidate'),
      due: items.filter(
        (k) => k.lifecycle === 'active' && ['stale', 'review_due', 'unknown'].includes(k.freshness),
      ),
      conflicts: items.filter((k) => k.lifecycle === 'active' && k.conflict_count > 0),
    };
  }
  async forget(actor: Actor, id: string, expectedVersion: number) {
    scope(actor, 'brain:admin');
    return this.db.transaction(async (q) => {
      const item = await this.requireItem(q, id);
      requireCondition(
        item.version === expectedVersion,
        409,
        'version_conflict',
        'Knowledge changed. Refresh before deleting.',
      );
      await q.query('INSERT INTO tombstones(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
      await redactAssistantSources(q, [id]);
      await q.query('DELETE FROM nodes WHERE id=$1', [id]);
      await q.query('DELETE FROM idempotency WHERE response::text LIKE $1', [`%${id}%`]);
      return { id, deleted: true };
    });
  }
  async forgetSource(actor: Actor, id: string) {
    scope(actor, 'brain:admin');
    const activeImport = await one(
      this.db,
      "SELECT id FROM jobs WHERE status='running' AND payload ? 'note_station'",
      [],
    );
    requireCondition(
      !activeImport,
      409,
      'import_in_progress',
      'Wait for the Note Station import to finish before forgetting a source.',
    );
    const attachments = await rows<{ content_hash: string }>(
      this.db,
      'SELECT DISTINCT a.content_hash FROM source_attachments a JOIN revisions r ON r.id=a.revision_id WHERE r.source_id=$1',
      [id],
    );
    const archivedFiles: string[] = [];
    const result = await this.db.transaction(async (q) => {
      const source = await one<Source>(q, 'SELECT * FROM sources WHERE id=$1', [id]);
      requireCondition(source, 404, 'not_found', 'Source not found.');
      const affected = await rows<{ id: string }>(
        q,
        'SELECT DISTINCT e.knowledge_id AS id FROM evidence e JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id WHERE r.source_id=$1',
        [id],
      );
      // Source-extracted claims are derived content: forget them too. User-authored claims lose only that evidence.
      await redactAssistantSources(q, [id, ...affected.map((v) => v.id)]);
      for (const item of affected) {
        const k = await this.requireItem(q, item.id);
        if ((k as Raw & { derived_source_id?: string }).derived_source_id === id) {
          await q.query('INSERT INTO tombstones(id) VALUES($1) ON CONFLICT DO NOTHING', [item.id]);
          await q.query('DELETE FROM nodes WHERE id=$1', [item.id]);
        } else {
          await q.query(
            'UPDATE knowledge SET verified_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
            [item.id],
          );
        }
      }
      await q.query('INSERT INTO tombstones(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
      await q.query('DELETE FROM nodes WHERE id=$1', [id]);
      const relatedJobs = await rows<{ id: string; upload_id: string | null }>(
        q,
        "SELECT id,payload->>'upload_id' AS upload_id FROM jobs WHERE result->>'source_id'=$1 OR (result->'source_ids') ? $1",
        [id],
      );
      const erasedIds = [id, ...affected.map((x) => x.id), ...relatedJobs.map((x) => x.id)];
      const uploads = await rows<{ storage_key: string | null }>(
        q,
        'SELECT storage_key FROM uploads WHERE id=ANY($1::uuid[])',
        [relatedJobs.map((x) => x.upload_id).filter(Boolean)],
      );
      for (const upload of uploads)
        if (upload.storage_key)
          archivedFiles.push(storedPath(this.storageRoot, upload.storage_key, 'incoming'));
      await q.query('DELETE FROM uploads WHERE id=ANY($1::uuid[])', [
        relatedJobs.map((x) => x.upload_id).filter(Boolean),
      ]);
      await q.query('DELETE FROM jobs WHERE id=ANY($1::uuid[])', [relatedJobs.map((x) => x.id)]);
      await q.query('DELETE FROM idempotency WHERE response::text LIKE ANY($1::text[])', [
        erasedIds.map((x) => `%${x}%`),
      ]);
      await q.query('DELETE FROM activity WHERE title=$1', [source.title]);
      for (const item of affected)
        if (await one(q, 'SELECT id FROM knowledge WHERE id=$1', [item.id]))
          await this.snapshot(q, item.id);
      return { id, deleted: true, affected: affected.length };
    });
    for (const file of archivedFiles) await removeStoredFile(file);
    for (const attachment of attachments)
      if (
        !(await one(this.db, 'SELECT id FROM source_attachments WHERE content_hash=$1 LIMIT 1', [
          attachment.content_hash,
        ]))
      )
        await removeStoredFile(
          storedPath(this.storageRoot, attachment.content_hash, 'attachments'),
        );
    return result;
  }
  async exportData(actor: Actor, includeFiles = true) {
    scope(actor, 'brain:admin');
    const tables = [
      'nodes',
      'knowledge',
      'sources',
      'revisions',
      'passages',
      'evidence',
      'entities',
      'relations',
      'versions',
      'reviews',
      'tombstones',
      'entity_merges',
      'source_attachments',
      'categorizations',
      'category_decisions',
      'assistant_conversations',
      'assistant_runs',
      'assistant_messages',
      'assistant_actions',
      'assistant_origins',
      'graphify_proposals',
    ];
    const data = await this.db.transaction(async (q) => {
      const data: Record<string, unknown[]> = {};
      for (const table of tables) data[table] = await rows(q, `SELECT * FROM ${table}`);
      return data;
    });
    const files: Record<string, string> = {};
    if (includeFiles) {
      const attachments = await rows<{ content_hash: string; size: number }>(
        this.db,
        'SELECT content_hash,max(size)::int AS size FROM source_attachments GROUP BY content_hash',
      );
      requireCondition(
        attachments.reduce((sum, att) => sum + att.size, 0) <= 20 * 1024 * 1024,
        400,
        'backup_required',
        'Use Export backup to include large attachments in a portable ZIP.',
      );
      for (const attachment of attachments)
        files[attachment.content_hash] = (
          await readFile(storedPath(this.storageRoot, attachment.content_hash, 'attachments'))
        ).toString('base64');
    }
    return {
      format: 'orbit-export',
      version: 2,
      exported_at: new Date().toISOString(),
      data,
      files,
    };
  }
  async restoreData(actor: Actor, raw: unknown) {
    scope(actor, 'brain:admin');
    const archive = raw as {
      format?: string;
      version?: number;
      data?: Record<string, Record<string, unknown>[]>;
      files?: Record<string, string>;
    };
    requireCondition(
      ['orbit-export', 'commonplace-export'].includes(archive?.format || '') &&
        [1, 2].includes(archive.version || 0) &&
        archive.data,
      400,
      'invalid_export',
      'Use an Orbit v1/v2 export or ZIP backup.',
    );
    const count = await one<{ n: number }>(
      this.db,
      'SELECT ((SELECT count(*) FROM nodes)+(SELECT count(*) FROM assistant_conversations))::int AS n',
    );
    requireCondition(
      count?.n === 0,
      409,
      'restore_not_empty',
      'Restore requires an empty database. Start with a new DATA_DIR and SEED_DEMO=false.',
    );
    const allowed: Record<string, string[]> = {
      nodes: ['id', 'type', 'label'],
      sources: [
        'id',
        'title',
        'origin',
        'url',
        'origin_key',
        'lineage_group',
        'status',
        'tags',
        'project',
        'created_at',
        'metadata',
      ],
      knowledge: [
        'id',
        'title',
        'statement',
        'kind',
        'lifecycle',
        'version',
        'tags',
        'project',
        'subject',
        'predicate',
        'object',
        'context',
        'review_interval_days',
        'grace_days',
        'verified_at',
        'valid_from',
        'valid_to',
        'archived_from',
        'created_at',
        'updated_at',
        'derived_source_id',
      ],
      revisions: [
        'id',
        'source_id',
        'content_hash',
        'text',
        'original_base64',
        'observed_at',
        'parser',
      ],
      passages: ['id', 'revision_id', 'text', 'anchor', 'start_offset', 'end_offset'],
      evidence: ['id', 'knowledge_id', 'passage_id', 'relation', 'rationale', 'created_at'],
      entities: ['id', 'canonical', 'type', 'aliases'],
      relations: [
        'id',
        'source_node',
        'target_node',
        'type',
        'backing_claim',
        'created_at',
        'properties',
      ],
      versions: ['id', 'knowledge_id', 'version', 'snapshot', 'recorded_at'],
      reviews: ['id', 'knowledge_id', 'version', 'actor', 'decision', 'rationale', 'created_at'],
      tombstones: ['id', 'deleted_at'],
      entity_merges: ['id', 'from_id', 'to_id', 'snapshot', 'undone_at', 'created_at'],
      source_attachments: ['id', 'revision_id', 'name', 'mime', 'size', 'content_hash'],
      categorizations: [
        'node_id',
        'engine_version',
        'input_hash',
        'scanned_at',
        'semantic_state',
        'suggestions',
        'decision_version',
        'error',
      ],
      category_decisions: ['node_id', 'category_id', 'decision', 'actor', 'updated_at'],
      assistant_conversations: ['id', 'title', 'created_at', 'updated_at'],
      assistant_runs: [
        'id',
        'conversation_id',
        'request_id',
        'input_hash',
        'budget_day',
        'status',
        'cloud',
        'calls',
        'cost',
        'reserved_cost',
        'reserved_calls',
        'estimated',
        'created_at',
      ],
      assistant_messages: [
        'id',
        'conversation_id',
        'run_id',
        'role',
        'content',
        'payload',
        'created_at',
      ],
      assistant_actions: [
        'id',
        'run_id',
        'kind',
        'title',
        'arguments',
        'status',
        'result',
        'created_at',
      ],
      assistant_origins: ['knowledge_id', 'payload'],
      graphify_proposals: [
        'id',
        'fingerprint',
        'source_id',
        'target_id',
        'source_hash',
        'target_hash',
        'relation',
        'confidence',
        'rationale',
        'status',
        'properties',
        'created_at',
      ],
    };
    for (const [digest, encoded] of Object.entries(archive.files || {})) {
      requireCondition(
        /^[a-f0-9]{64}$/.test(digest) &&
          typeof encoded === 'string' &&
          encoded.length <= 90 * 1024 * 1024,
        400,
        'invalid_export',
        'Invalid attachment data.',
      );
      const bytes = Buffer.from(encoded, 'base64');
      requireCondition(
        hash(bytes) === digest,
        400,
        'invalid_export',
        'Attachment checksum does not match.',
      );
      await storeAttachment(this.storageRoot, bytes);
    }
    for (const att of archive.data!.source_attachments || []) {
      const file = storedPath(this.storageRoot, String(att.content_hash), 'attachments');
      let bytes: Buffer;
      try {
        requireCondition(
          (await stat(file)).size <= 64 * 1024 * 1024,
          400,
          'entry_limit',
          'Attachment exceeds 64 MB.',
        );
        bytes = await readFile(file);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          400,
          'missing_attachment',
          'Backup is missing a retained attachment. Restore the complete ZIP backup.',
        );
      }
      requireCondition(
        hash(bytes) === att.content_hash && bytes.length === Number(att.size),
        400,
        'invalid_export',
        'Attachment size/checksum does not match.',
      );
    }
    return this.db.transaction(async (q) => {
      for (const [table, columns] of Object.entries(allowed)) {
        const entries =
          archive.data![table] ||
          ([
            'entity_merges',
            'source_attachments',
            'categorizations',
            'category_decisions',
            'assistant_conversations',
            'assistant_runs',
            'assistant_messages',
            'assistant_actions',
            'assistant_origins',
            'graphify_proposals',
          ].includes(table)
            ? []
            : undefined);
        requireCondition(
          Array.isArray(entries) && entries.length <= 200000,
          400,
          'invalid_export',
          `Invalid ${table} records.`,
        );
        for (const originalEntry of entries) {
          const entry =
            table === 'assistant_runs' && originalEntry?.status === 'running'
              ? {
                  ...originalEntry,
                  status: 'interrupted',
                  cost: Number(originalEntry.cost || 0) + Number(originalEntry.reserved_cost || 0),
                  calls:
                    Number(originalEntry.calls || 0) + Number(originalEntry.reserved_calls || 0),
                  reserved_cost: 0,
                  reserved_calls: 0,
                  estimated: true,
                }
              : originalEntry;
          requireCondition(
            entry && typeof entry === 'object',
            400,
            'invalid_export',
            'Invalid export record.',
          );
          const values = columns.map((c) =>
            [
              'tags',
              'aliases',
              'snapshot',
              'metadata',
              'properties',
              'suggestions',
              'payload',
              'arguments',
              'result',
            ].includes(c)
              ? entry[c] === undefined
                ? c === 'properties'
                  ? '{}'
                  : c === 'suggestions'
                    ? '[]'
                    : null
                : stringify(entry[c])
              : (entry[c] ??
                (c === 'semantic_state' ? 'pending' : c === 'decision_version' ? 0 : null)),
          );
          await q.query(
            `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})${table === 'tombstones' ? ' ON CONFLICT DO NOTHING' : ''}`,
            values,
          );
        }
      }
      const tombstones = await rows<{ id: string }>(q, 'SELECT id FROM tombstones');
      for (const tombstone of tombstones)
        await q.query('DELETE FROM nodes WHERE id=$1', [tombstone.id]);
      const items = await rows<Raw>(q, 'SELECT * FROM knowledge');
      for (const item of items)
        await this.index(
          q,
          item.id,
          item.title,
          item.statement,
          [...item.tags, item.project, item.subject].join(' '),
        );
      const passages = await rows<{
        id: string;
        text: string;
        title: string;
        tags: string[];
        project: string;
      }>(
        q,
        'SELECT p.id,p.text,s.title,s.tags,s.project FROM passages p JOIN revisions r ON r.id=p.revision_id JOIN sources s ON s.id=r.source_id',
      );
      for (const p of passages)
        await this.index(q, p.id, p.title, p.text, [...p.tags, p.project].join(' '), true);
      await this.classification.retireImportedCollections(q);
      const classified = await rows<{ id: string }>(
        q,
        "SELECT id FROM nodes WHERE type IN ('claim','note','source')",
      );
      for (const node of classified) await this.classification.classify(q, node.id, true);
      return { restored: items.length, sources: archive.data!.sources.length };
    });
  }
  async link(
    actor: Actor,
    from: string,
    to: string,
    type: 'related_to' | 'supersedes',
    expectedVersion?: number,
  ) {
    scope(actor, 'brain:write');
    requireCondition(from !== to, 400, 'invalid_link', 'Choose two different items.');
    return this.db.transaction(async (q) => {
      const a = await this.requireItem(q, from);
      const b = await this.requireItem(q, to);
      requireCondition(
        a.lifecycle === 'active' && b.lifecycle === 'active',
        400,
        'invalid_link',
        'Only accepted items can be linked.',
      );
      if (type === 'supersedes') {
        scope(actor, 'brain:review');
        requireCondition(
          b.version === expectedVersion,
          409,
          'version_conflict',
          'Target knowledge changed.',
        );
        requireCondition(
          !b.valid_from || new Date(b.valid_from).getTime() <= Date.now(),
          400,
          'invalid_applicability',
          'A future claim cannot be superseded at the present time.',
        );
        await q.query(
          "UPDATE knowledge SET lifecycle='superseded',valid_to=LEAST(valid_to,now()),version=version+1,updated_at=now() WHERE id=$1",
          [to],
        );
        if (!a.valid_from) {
          await q.query(
            'UPDATE knowledge SET valid_from=now(),verified_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
            [from],
          );
          await this.snapshot(q, from);
        }
        await this.detectConflicts(q, to);
        await this.snapshot(q, to);
      }
      await this.edge(q, from, to, type);
      await this.activity(q, type, a.title, from);
      return { from, to, type };
    });
  }
  async mergeEntities(actor: Actor, from: string, to: string) {
    scope(actor, 'brain:review');
    requireCondition(from !== to, 400, 'invalid_merge', 'Choose different entities.');
    return this.db.transaction(async (q) => {
      const a = await one<{ canonical: string; type: string; aliases: string[] }>(
        q,
        'SELECT * FROM entities WHERE id=$1',
        [from],
      );
      const b = await one<{ canonical: string; type: string; aliases: string[] }>(
        q,
        'SELECT * FROM entities WHERE id=$1',
        [to],
      );
      requireCondition(
        a && b && a.type === b.type,
        400,
        'invalid_merge',
        'Choose entities of the same type.',
      );
      requireCondition(
        a.type === 'entity',
        400,
        'invalid_merge',
        'Topic/project names are edited on their knowledge items; only named entities can be merged.',
      );
      const edges = await rows<GraphEdge & { backing_claim: string | null }>(
        q,
        'SELECT id,source_node AS source,target_node AS target,type,backing_claim FROM relations WHERE source_node=$1 OR target_node=$1',
        [from],
      );
      const node = await one(q, 'SELECT * FROM nodes WHERE id=$1', [from]);
      const transferred: string[] = [];
      for (const e of edges) {
        const source = e.source === from ? to : e.source,
          target = e.target === from ? to : e.target;
        if (source === target) continue;
        const existing = await one(
          q,
          'SELECT id FROM relations WHERE source_node=$1 AND target_node=$2 AND type=$3',
          [source, target, e.type],
        );
        await this.edge(q, source, target, e.type, e.backing_claim);
        if (!existing) {
          const created = await one<{ id: string }>(
            q,
            'SELECT id FROM relations WHERE source_node=$1 AND target_node=$2 AND type=$3',
            [source, target, e.type],
          );
          if (created) transferred.push(created.id);
        }
      }
      const mergeId = randomUUID();
      await q.query('INSERT INTO entity_merges(id,from_id,to_id,snapshot) VALUES($1,$2,$3,$4)', [
        mergeId,
        from,
        to,
        stringify({ entity: a, node, edges, transferred, target_aliases: b.aliases }),
      ]);
      await q.query('UPDATE entities SET aliases=$2 WHERE id=$1', [
        to,
        stringify([...new Set([...b.aliases, a.canonical, ...a.aliases])]),
      ]);
      await q.query('DELETE FROM nodes WHERE id=$1', [from]);
      await this.activity(q, 'entities merged', `${a.canonical} → ${b.canonical}`);
      return { from, to, merge_id: mergeId };
    });
  }
  async entities(actor: Actor) {
    scope(actor, 'brain:read');
    return rows<{ id: string; canonical: string; label: string; type: string; aliases: string[] }>(
      this.db,
      "SELECT e.*,n.label FROM entities e JOIN nodes n ON n.id=e.id WHERE n.type <> 'import_collection' ORDER BY e.canonical",
    );
  }
  async entityMerges(actor: Actor) {
    scope(actor, 'brain:review');
    return rows<Record<string, unknown>>(
      this.db,
      'SELECT id,from_id,to_id,created_at,undone_at FROM entity_merges ORDER BY created_at DESC',
    );
  }
  async undoEntityMerge(actor: Actor, id: string) {
    scope(actor, 'brain:review');
    return this.db.transaction(async (q) => {
      const merge = await one<{
        from_id: string;
        to_id: string;
        created_at: string;
        undone_at: string | null;
        snapshot: {
          entity: { canonical: string; type: string; aliases: string[] };
          node: { label: string; type: string };
          edges: (GraphEdge & { backing_claim: string | null })[];
          transferred: string[];
          target_aliases: string[];
        };
      }>(q, 'SELECT * FROM entity_merges WHERE id=$1', [id]);
      requireCondition(merge && !merge.undone_at, 404, 'not_found', 'Active merge not found.');
      const later = await one(
        q,
        'SELECT id FROM entity_merges WHERE undone_at IS NULL AND created_at>$1 AND (from_id=ANY($2::uuid[]) OR to_id=ANY($2::uuid[]))',
        [merge.created_at, [merge.from_id, merge.to_id]],
      );
      requireCondition(
        !later,
        409,
        'merge_conflict',
        'Undo subsequent merges of these entities first.',
      );
      requireCondition(
        await one(q, 'SELECT id FROM entities WHERE id=$1', [merge.to_id]),
        409,
        'merge_conflict',
        'The destination entity no longer exists.',
      );
      await q.query('INSERT INTO nodes(id,type,label) VALUES($1,$2,$3)', [
        merge.from_id,
        merge.snapshot.node.type,
        merge.snapshot.node.label,
      ]);
      await q.query('INSERT INTO entities(id,canonical,type,aliases) VALUES($1,$2,$3,$4)', [
        merge.from_id,
        merge.snapshot.entity.canonical,
        merge.snapshot.entity.type,
        stringify(merge.snapshot.entity.aliases),
      ]);
      await q.query('DELETE FROM relations WHERE id=ANY($1::uuid[])', [merge.snapshot.transferred]);
      for (const e of merge.snapshot.edges)
        if (
          await one(q, 'SELECT id FROM nodes WHERE id=$1', [
            e.source === merge.from_id ? e.target : e.source,
          ])
        )
          await this.edge(q, e.source, e.target, e.type, e.backing_claim);
      await q.query('UPDATE entities SET aliases=$2 WHERE id=$1', [
        merge.to_id,
        stringify(merge.snapshot.target_aliases),
      ]);
      await q.query('UPDATE entity_merges SET undone_at=now() WHERE id=$1', [id]);
      await this.activity(q, 'entity merge undone', merge.snapshot.node.label);
      return { id, undone: true };
    });
  }
  async batchReview(actor: Actor, raw: unknown) {
    scope(actor, 'brain:review');
    const input = z
      .object({
        items: z
          .array(z.object({ id: z.string().uuid(), expected_version: z.number().int().positive() }))
          .min(1)
          .max(50),
        decision: z.enum(['accept', 'reject']),
        rationale: z.string().trim().min(3).max(2000),
      })
      .parse(raw);
    const results = [];
    for (const item of input.items) {
      try {
        await this.review(actor, item.id, { ...input, expected_version: item.expected_version });
        results.push({ id: item.id, ok: true });
      } catch (error) {
        results.push({
          id: item.id,
          ok: false,
          error: error instanceof Error ? error.message : 'Review failed.',
        });
      }
    }
    return { results };
  }
}
