-- A fact line's place in time. NULL means unknown and readers fall back to learned_at.
-- Old code ignores the column (explicit column lists); new code on the old schema fails loudly at the
-- first assert, so deploy the migration before the code. Forward-only, like every migration here.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS occurred_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS facts_place_in_time ON facts (tenant, subject, COALESCE(occurred_at, learned_at) DESC);
