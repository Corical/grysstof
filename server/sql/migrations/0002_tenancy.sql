-- 0002: tenancy and embedding provenance.
--  * every row belongs to a tenant; identity is (tenant, fingerprint), so two
--    tenants may hold the same sentence as two rows;
--  * match_thoughts takes the tenant and scans the HNSW graph iteratively, so
--    a tenant with 1 % of the rows still finds its own exact match;
--  * upsert_thought says whether it inserted, so "already known" is exact;
--  * rows record which model, at which width, produced their embedding;
--  * created_at is never null.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'default';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_dims integer;

UPDATE thoughts SET created_at = COALESCE(updated_at, now()) WHERE created_at IS NULL;
ALTER TABLE thoughts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE thoughts ALTER COLUMN created_at SET NOT NULL;

DROP INDEX IF EXISTS idx_thoughts_fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_tenant_fingerprint
  ON thoughts (tenant, content_fingerprint) WHERE content_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_tenant_created_at ON thoughts (tenant, created_at DESC);

DROP FUNCTION IF EXISTS match_thoughts(vector, double precision, integer, jsonb);
DROP FUNCTION IF EXISTS upsert_thought(text, jsonb);

CREATE OR REPLACE FUNCTION match_thoughts(
  p_tenant text,
  query_embedding vector,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql AS $$
BEGIN
  -- Keep walking the graph until match_count rows of THIS tenant are found,
  -- instead of taking the ef_search nearest rows of everyone and filtering.
  PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
  RETURN QUERY
  SELECT t.id, t.content, t.metadata, 1 - (t.embedding <=> query_embedding) AS similarity, t.created_at, t.updated_at
  FROM thoughts t
  WHERE t.tenant = p_tenant
    AND t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION upsert_thought(p_tenant text, p_content text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_fingerprint text;
  v_id uuid;
  v_inserted boolean;
BEGIN
  v_fingerprint := encode(sha256(convert_to(lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')), 'hex');
  INSERT INTO thoughts (tenant, content, content_fingerprint, metadata)
  VALUES (p_tenant, p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (tenant, content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(), metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id, (xmax = 0) INTO v_id, v_inserted;
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint, 'inserted', v_inserted);
END;
$$ LANGUAGE plpgsql;
