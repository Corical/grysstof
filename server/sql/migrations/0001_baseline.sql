-- 0001: the upstream Open Brain schema (the Supabase getting-started guide's,
-- minus the Supabase-only RLS policy and grant). Any PostgreSQL 15+ with
-- pgvector. {{DIMS}} is the vector width the instance embeds at; the
-- migrator substitutes it. Idempotent, so an existing database is left as it is.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  embedding vector({{DIMS}}),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  content_fingerprint text
);

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata ON thoughts USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON thoughts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
