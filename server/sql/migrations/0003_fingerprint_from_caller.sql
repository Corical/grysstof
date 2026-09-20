-- 0003: the fingerprint is computed by the adapter (adapters/memory/shared.ts,
-- JavaScript \s = Unicode whitespace) and handed in, never derived in SQL.
--
-- Why: PostgreSQL's regexp \s matches ASCII whitespace only; JavaScript's \s
-- also matches NBSP and the other Unicode spaces. Every in-process limb used
-- the JS rule; this one used SQL's. The same sentence with a non-breaking
-- space was one thought in a JSON file and two in Postgres. Moving a brain
-- between limbs duplicated rows. One rule, in one place, passed in.
--
-- Existing rows: for ASCII-whitespace content the two rules hash identically,
-- so nothing changes. Rows whose content contains Unicode whitespace cannot be
-- re-hashed in SQL (that is the whole point); they are re-hashed by the
-- adapter on first touch, and until then may sit beside a JS-rule twin. A
-- one-off `deno task rehash` (not written) would close that for a live brain.

CREATE OR REPLACE FUNCTION upsert_thought(p_tenant text, p_content text, p_fingerprint text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb AS $$
DECLARE
  v_id uuid;
  v_inserted boolean;
BEGIN
  IF p_fingerprint IS NULL OR length(p_fingerprint) <> 64 THEN
    RAISE EXCEPTION 'upsert_thought needs a 64-hex fingerprint from the caller';
  END IF;
  INSERT INTO thoughts (tenant, content, content_fingerprint, metadata)
  VALUES (p_tenant, p_content, p_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (tenant, content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(), metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id, (xmax = 0) INTO v_id, v_inserted;
  RETURN jsonb_build_object('id', v_id, 'fingerprint', p_fingerprint, 'inserted', v_inserted);
END;
$$ LANGUAGE plpgsql;

-- The old three-argument shape is gone so nothing can call the SQL rule by accident.
DROP FUNCTION IF EXISTS upsert_thought(text, text, jsonb);
