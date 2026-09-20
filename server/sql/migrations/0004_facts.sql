-- 0004: a fact is not a thought (owner's decision, 20 Sep 2026).
--
-- Facts get their own table. Until now the Postgres instances kept ledger
-- lines inside `thoughts` (LedgerOverMemory), so every fact also appeared in
-- list_thoughts / search_thoughts / thought_stats. From here the ledger is a
-- separate limb over this table; the thought tools never see a fact.
--
-- Lines already stored as thoughts (metadata->>'kind' = 'fact') are moved
-- across with their ids, provenance and embeddings, then removed from
-- thoughts. Supersede links are preserved.

CREATE TABLE IF NOT EXISTS facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL,
  subject text NOT NULL,
  claim text NOT NULL,
  source text NOT NULL,
  proof text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  learned_by text NOT NULL,
  learned_at timestamptz NOT NULL DEFAULT now(),
  confirmed boolean NOT NULL DEFAULT false,
  confirmed_by text,
  confirmed_at timestamptz,
  supersedes uuid REFERENCES facts(id),
  superseded_by uuid REFERENCES facts(id),
  embedding vector({{DIMS}}),
  embedding_model text,
  embedding_dims integer,
  seq bigserial NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_tenant_subject_seq ON facts (tenant, subject, seq DESC);
CREATE INDEX IF NOT EXISTS idx_facts_tenant_seq ON facts (tenant, seq DESC);
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON facts USING hnsw (embedding vector_cosine_ops);

-- Plain-words search over claims, newest-wins by default, tenant-partitioned.
CREATE OR REPLACE FUNCTION match_facts(
  p_tenant text,
  query_embedding vector,
  match_threshold float DEFAULT 0,
  match_count int DEFAULT 10,
  p_subject text DEFAULT NULL,
  p_include_superseded boolean DEFAULT false,
  p_confirmed_only boolean DEFAULT false
)
RETURNS TABLE (id uuid, similarity float)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  RETURN QUERY
  SELECT f.id, 1 - (f.embedding <=> query_embedding) AS similarity
  FROM facts f
  WHERE f.tenant = p_tenant
    AND f.embedding IS NOT NULL
    AND 1 - (f.embedding <=> query_embedding) > match_threshold
    AND (p_subject IS NULL OR f.subject = p_subject)
    AND (p_include_superseded OR f.superseded_by IS NULL)
    AND (NOT p_confirmed_only OR f.confirmed)
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Move facts that were stored as thoughts. Ids are kept so links survive.
INSERT INTO facts (id, tenant, subject, claim, source, proof, tags, learned_by, learned_at, confirmed, confirmed_by, confirmed_at, embedding, embedding_model, embedding_dims)
SELECT
  t.id,
  t.tenant,
  t.metadata->>'subject',
  COALESCE(t.metadata->>'claim', t.content),
  COALESCE(t.metadata->>'source', 'unknown'),
  t.metadata->>'proof',
  COALESCE(t.metadata->'tags', '[]'::jsonb),
  COALESCE(t.metadata->>'learned_by', 'unknown'),
  COALESCE((t.metadata->>'learned_at')::timestamptz, t.created_at),
  COALESCE((t.metadata->>'confirmed')::boolean, false),
  t.metadata->>'confirmed_by',
  (t.metadata->>'confirmed_at')::timestamptz,
  t.embedding,
  t.embedding_model,
  t.embedding_dims
FROM thoughts t
WHERE t.metadata->>'kind' = 'fact' AND t.metadata->>'subject' IS NOT NULL
ORDER BY COALESCE((t.metadata->>'learned_at')::timestamptz, t.created_at)
ON CONFLICT (id) DO NOTHING;

UPDATE facts f SET supersedes = (t.metadata->>'supersedes')::uuid
FROM thoughts t WHERE t.id = f.id AND t.metadata->>'supersedes' IS NOT NULL
  AND EXISTS (SELECT 1 FROM facts o WHERE o.id = (t.metadata->>'supersedes')::uuid);

UPDATE facts f SET superseded_by = (t.metadata->>'superseded_by')::uuid
FROM thoughts t WHERE t.id = f.id AND t.metadata->>'superseded_by' IS NOT NULL
  AND EXISTS (SELECT 1 FROM facts n WHERE n.id = (t.metadata->>'superseded_by')::uuid);

DELETE FROM thoughts WHERE metadata->>'kind' = 'fact';
