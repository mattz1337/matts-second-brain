CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nodes (id uuid PRIMARY KEY, type text NOT NULL, label text NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge (
  id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  title text NOT NULL, statement text NOT NULL, kind text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('candidate','active','rejected','superseded','archived')),
  version integer NOT NULL DEFAULT 1, tags jsonb NOT NULL DEFAULT '[]', project text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '', predicate text NOT NULL DEFAULT '', object text NOT NULL DEFAULT '', context text NOT NULL DEFAULT '',
  review_interval_days integer, grace_days integer NOT NULL DEFAULT 30,
  verified_at timestamptz, valid_from timestamptz, valid_to timestamptz,
  archived_from text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to)
);
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, title text NOT NULL,
  origin text NOT NULL, url text, origin_key text NOT NULL UNIQUE,
  lineage_group text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  tags jsonb NOT NULL DEFAULT '[]', project text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revisions (
  id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash text NOT NULL, text text NOT NULL, original_base64 text,
  observed_at timestamptz NOT NULL DEFAULT now(), parser text NOT NULL, UNIQUE(source_id,content_hash)
);
CREATE TABLE IF NOT EXISTS passages (
  id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  text text NOT NULL, anchor text NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL,
  UNIQUE(revision_id,start_offset)
);
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY, knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  passage_id uuid NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('supports','challenges')), rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(knowledge_id,passage_id,relation)
);
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  canonical text NOT NULL, type text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]', UNIQUE(canonical,type)
);
CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY, source_node uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, type text NOT NULL,
  backing_claim uuid REFERENCES knowledge(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_node,target_node,type), CHECK(source_node <> target_node)
);
CREATE TABLE IF NOT EXISTS versions (
  id uuid PRIMARY KEY, knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  version integer NOT NULL, snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(knowledge_id,version)
);
CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY, knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  version integer NOT NULL, actor text NOT NULL, decision text NOT NULL, rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_documents (
  id uuid PRIMARY KEY, knowledge_id uuid REFERENCES knowledge(id) ON DELETE CASCADE,
  passage_id uuid REFERENCES passages(id) ON DELETE CASCADE,
  title text NOT NULL, text text NOT NULL, labels text NOT NULL DEFAULT '',
  lexical tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', text), 'B') || setweight(to_tsvector('simple', labels),'A')
  ) STORED,
  embedding vector(384), model_id text, input_hash text NOT NULL,
  CHECK ((knowledge_id IS NULL) <> (passage_id IS NULL))
);
CREATE INDEX IF NOT EXISTS search_lexical_idx ON search_documents USING gin(lexical);
CREATE INDEX IF NOT EXISTS search_vector_idx ON search_documents USING hnsw(embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS knowledge_lifecycle_idx ON knowledge(lifecycle);
CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_node);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_node);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY, title text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, error text, warnings jsonb NOT NULL DEFAULT '[]', result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uploads (
  id uuid PRIMARY KEY, name text NOT NULL, mime text NOT NULL, bytes_base64 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency (
  key text PRIMARY KEY, actor text NOT NULL, operation text NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS activity (
  id uuid PRIMARY KEY, knowledge_id uuid REFERENCES knowledge(id) ON DELETE CASCADE,
  action text NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tombstones (id uuid PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS preferences (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS derived_source_id uuid REFERENCES sources(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=2) THEN
    UPDATE knowledge k SET derived_source_id=(SELECT r.source_id FROM evidence e JOIN passages p ON p.id=e.passage_id JOIN revisions r ON r.id=p.revision_id JOIN sources s ON s.id=r.source_id WHERE e.knowledge_id=k.id AND k.context='Source: '||s.title LIMIT 1);
    INSERT INTO schema_migrations(version) VALUES(2);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS entity_merges (
  id uuid PRIMARY KEY, from_id uuid NOT NULL, to_id uuid NOT NULL, snapshot jsonb NOT NULL,
  undone_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS metadata jsonb;
CREATE TABLE IF NOT EXISTS source_attachments (
  id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, content_hash text NOT NULL,
  UNIQUE(revision_id,name,content_hash)
);
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
