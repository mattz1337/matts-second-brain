import { z } from 'zod';

export const kinds = [
  'factual_assertion',
  'personal_observation',
  'preference',
  'hypothesis',
  'derived_inference',
] as const;
export const lifecycles = ['candidate', 'active', 'superseded', 'rejected', 'archived'] as const;
export type Kind = (typeof kinds)[number];
export type Lifecycle = (typeof lifecycles)[number];
export type Freshness =
  | 'unknown'
  | 'current'
  | 'review_due'
  | 'stale'
  | 'expired'
  | 'not_yet_valid';
const tags = z.array(z.string().trim().min(1).max(60)).max(12).default([]);
const date = z.string().datetime({ offset: true }).nullable().optional();
const key = z.string().min(8).max(160);
export const captureSchema = z.object({
  title: z.string().trim().min(1).max(180),
  statement: z.string().trim().min(3).max(12000),
  kind: z.enum(kinds).default('personal_observation'),
  tags,
  project: z.string().trim().max(100).default(''),
  subject: z.string().trim().max(160).default(''),
  predicate: z.string().trim().max(100).default(''),
  object: z.string().trim().max(500).default(''),
  context: z.string().trim().max(1000).default(''),
  review_interval_days: z.number().int().min(1).max(3650).nullable().default(180),
  valid_from: date,
  valid_to: date,
  idempotency_key: key,
});
export type CaptureInput = z.infer<typeof captureSchema>;
export const importSchema = z.object({
  title: z.string().trim().min(1).max(180),
  text: z.string().min(3).max(500000).optional(),
  url: z.string().url().max(2048).optional(),
  upload_id: z.string().uuid().optional(),
  tags,
  project: z.string().trim().max(100).default(''),
  review_interval_days: z.number().int().min(1).max(3650).nullable().default(90),
  lineage_group: z.string().trim().max(200).optional(),
  note_station: z
    .object({
      notebook_ids: z.array(z.string().min(1).max(200)).max(1000).optional(),
      extract_claims: z.boolean().default(false),
    })
    .optional(),
  idempotency_key: key,
});
export type ImportInput = z.infer<typeof importSchema>;
export const reviewSchema = z.object({
  expected_version: z.number().int().positive(),
  decision: z.enum(['accept', 'reject', 'verify']),
  rationale: z.string().trim().min(3).max(2000),
});
export const editSchema = captureSchema
  .omit({ idempotency_key: true })
  .partial()
  .extend({ expected_version: z.number().int().positive() });
export const evidenceSchema = z.object({
  passage_id: z.string().uuid(),
  relation: z.enum(['supports', 'challenges']),
  rationale: z.string().trim().min(3).max(2000),
  expected_version: z.number().int().positive(),
  idempotency_key: key,
});
export const searchSchema = z.object({
  query: z.string().trim().max(1000).default(''),
  topic: z.string().max(60).default(''),
  project: z.string().max(100).default(''),
  kind: z.enum(kinds).optional(),
  lifecycle: z.enum(lifecycles).optional(),
  temporal_mode: z.enum(['current', 'historical', 'all']).default('current'),
  as_of: date,
  recorded_at: date,
  include_stale: z.boolean().default(true),
  include_candidates: z.boolean().default(false),
  include_sources: z.boolean().default(true),
  graph_expansion: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
});
export type SearchInput = z.infer<typeof searchSchema>;
export const sourceBrowseSchema = searchSchema
  .pick({ query: true, topic: true, project: true, limit: true, offset: true })
  .extend({ origin: z.enum(['all', 'note_station']).default('all') });
export interface SourceBrowseResult {
  items: (Source & { excerpt: string })[];
  total: number;
}
export const graphSchema = z.object({
  focus_id: z.string().uuid().optional(),
  topic: z.string().max(60).default(''),
  project: z.string().max(100).default(''),
  include_candidates: z.boolean().default(false),
  include_archived: z.boolean().default(false),
  hops: z.number().int().min(1).max(2).default(1),
  limit: z.number().int().min(1).max(250).default(100),
});
export type GraphInput = z.infer<typeof graphSchema>;

export interface Knowledge {
  id: string;
  title: string;
  statement: string;
  kind: Kind;
  lifecycle: Lifecycle;
  version: number;
  tags: string[];
  project: string;
  subject: string;
  predicate: string;
  object: string;
  context: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  review_interval_days: number | null;
  grace_days: number;
  freshness: Freshness;
  review_due_at: string | null;
  evidence_status: 'unsupported' | 'self_reported' | 'cited' | 'corroborated' | 'challenged';
  evidence_count: number;
  independent_sources: number;
  conflict_count: number;
  source_title?: string;
  score?: number;
  match_type?: string;
  warnings: string[];
}
export interface Evidence {
  id: string;
  relation: 'supports' | 'challenges';
  rationale: string;
  created_at: string;
  passage_id: string;
  text: string;
  anchor: string;
  start_offset: number;
  end_offset: number;
  source_id: string;
  source_title: string;
  source_url: string | null;
  revision_id: string;
  content_hash: string;
  lineage_group: string;
  source_status: string;
}
export interface Detail extends Knowledge {
  evidence: Evidence[];
  reviews: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  conflicts: Knowledge[];
}
export interface Source {
  id: string;
  title: string;
  origin: string;
  url: string | null;
  status: string;
  tags: string[];
  project: string;
  created_at: string;
  revision_count: number;
  claim_count: number;
  metadata?: NoteStationMetadata | null;
}
export interface NoteStationMetadata {
  note_id: string;
  notebook_id: string;
  notebook: string;
  stack: string;
  created_at: string | null;
  modified_at: string | null;
  original_tags: string[];
  warnings: string[];
}
export interface SourceAttachment {
  id: string;
  revision_id: string;
  name: string;
  size: number;
  mime: string;
  content_hash: string;
}
export interface NsxPreview {
  notes: number;
  attachments: number;
  missing_attachments: number;
  unreadable_notes: number;
  notebooks: { id: string; title: string; stack: string; notes: number }[];
  warnings: string[];
}
export interface PassageResult {
  id: string;
  text: string;
  anchor: string;
  source_id: string;
  source_title: string;
  revision_id: string;
  score: number;
  match_type: string;
}
export interface SearchResult {
  items: Knowledge[];
  passages: PassageResult[];
  total: number;
  as_of: string;
  mode: string;
  warnings: string[];
}
export interface ImportJob {
  id: string;
  title: string;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  warnings: string[];
  result: {
    source_id?: string;
    revision_id?: string;
    claims?: number;
    duplicate?: boolean;
    notes?: number;
    imported?: number;
    duplicates?: number;
    skipped?: number;
    attachments?: number;
    total?: number;
  };
  created_at: string;
  updated_at: string;
  attempts: number;
}
export interface GraphNode {
  id: string;
  label: string;
  type: 'claim' | 'note' | 'entity' | 'topic' | 'project' | 'source';
  lifecycle?: string;
  freshness?: Freshness;
  evidence_status?: string;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}
export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  total_nodes: number;
}
export interface Dashboard {
  projects?: { name: string; count: number }[];
  total: number;
  active: number;
  candidates: number;
  due: number;
  sources: number;
  connections: number;
  conflicts: number;
  recent: Knowledge[];
  topics: { name: string; count: number }[];
  activity: { id: string; action: string; title: string; created_at: string }[];
}
export interface ModelStatus {
  mode: string;
  model: string;
  state: string;
  error: string | null;
  indexed: number;
  pending: number;
}
export interface Actor {
  id: string;
  scopes: string[];
  owner: boolean;
}
