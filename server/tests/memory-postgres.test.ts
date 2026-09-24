/**
 * The Memory and Ledger contracts against a real PostgreSQL + pgvector when
 * OB_PG_URL is set, plus what only a real database can prove: migrations,
 * the boot-time schema assertion, statement timeouts, and the iterative HNSW
 * scan that keeps a small tenant's rows findable. Skipped otherwise.
 */
import { Pool } from "postgres";
import { PostgresMemory } from "../adapters/memory/postgres.ts";
import { LATEST_SCHEMA, migrate, schemaVersion, vectorWidth } from "../adapters/memory/postgres-migrate.ts";
import { BagOfWordsEmbedder, FakeEmbedder } from "../adapters/memory/vectors.ts";
import { PostgresLedger } from "../adapters/ledger/postgres.ts";
import { NullLog, RecordingLog } from "../adapters/log.ts";
import { MapSettings } from "../adapters/settings.ts";
import { compose } from "../compose.ts";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { runMemoryContract } from "./memory.contract.ts";
import { runLedgerContract } from "./ledger.contract.ts";
import { assertTestDatabase } from "./pg-guard.ts";

const url = Deno.env.get("OB_PG_URL");
const DIMS = 1536;

async function sql<T>(fn: (c: Awaited<ReturnType<Pool["connect"]>>) => Promise<T>): Promise<T> {
  const pool = new Pool(url!, 1, true);
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
    await pool.end();
  }
}

if (!url) {
  Deno.test({ name: "[postgres] skipped: OB_PG_URL not set", ignore: true, fn() {} });
} else {
  assertTestDatabase(url);
  // A clean slate proves the migrations from zero on every run.
  await sql((c) => c.queryArray(`DROP TABLE IF EXISTS facts; DROP FUNCTION IF EXISTS match_facts(text, vector, double precision, integer, text, boolean, boolean); DROP TABLE IF EXISTS thoughts; DROP TABLE IF EXISTS schema_version; DROP FUNCTION IF EXISTS match_thoughts(vector, double precision, integer, jsonb); DROP FUNCTION IF EXISTS match_thoughts(text, vector, double precision, integer, jsonb); DROP FUNCTION IF EXISTS upsert_thought(text, jsonb); DROP FUNCTION IF EXISTS upsert_thought(text, text, jsonb); DROP FUNCTION IF EXISTS upsert_thought(text, text, text, jsonb)`));
  const first = await migrate(url, { dims: DIMS });
  const truncate = () => sql((c) => c.queryArray("TRUNCATE thoughts, facts"));

  Deno.test("[postgres] migrations: from zero to latest, then nothing to do; version and width readable", async () => {
    assertEquals(first.from, 0);
    assertEquals(first.to, LATEST_SCHEMA);
    assertEquals(first.applied, ["0001_baseline", "0002_tenancy", "0003_fingerprint_from_caller", "0004_facts", "0005_fact_occurred_at"]);
    const again = await migrate(url, { dims: DIMS });
    assertEquals(again.applied, []);
    assertEquals(again.to, LATEST_SCHEMA);
    await sql(async (c) => {
      assertEquals(await schemaVersion(c), LATEST_SCHEMA);
      assertEquals(await vectorWidth(c), DIMS);
      const cols = await c.queryObject<{ column_name: string; is_nullable: string }>(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'thoughts'`);
      const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.is_nullable]));
      assertEquals(byName.tenant, "NO");
      assertEquals(byName.created_at, "NO");
      assert("embedding_model" in byName && "embedding_dims" in byName);
      const idx = await c.queryObject<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'thoughts' AND indexname = 'idx_thoughts_tenant_fingerprint'`);
      assertStringIncludes(idx.rows[0].indexdef, "UNIQUE INDEX");
      assertStringIncludes(idx.rows[0].indexdef, "(tenant, content_fingerprint)");
      const old = await c.queryObject(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_thoughts_fingerprint'`);
      assertEquals(old.rows.length, 0, "the global fingerprint index is gone");
    });
    await assertRejects(() => migrate(url, { dims: 0 }), Error, "whole number");
  });

  Deno.test("[postgres] compose refuses a database at an older schema, and one whose vectors are a different width, with a plain message", async () => {
    const base = { OB_MEMORY: "postgres", OB_PG_URL: url, MCP_ACCESS_KEY: "k", EMBEDDING_API_KEY: "e", EMBEDDING_API_BASE: "http://localhost:11434/v1" };
    const wrongWidth = await assertRejects(() => compose(new MapSettings({ ...base, EMBEDDING_DIMENSIONS: "768" }), new RecordingLog()), Error);
    assertStringIncludes(wrongWidth.message, "1536-wide vectors");
    assertStringIncludes(wrongWidth.message, "768-wide");
    assertStringIncludes(wrongWidth.message, "EMBEDDING_DIMENSIONS");
    await sql((c) => c.queryArray(`DELETE FROM schema_version WHERE version = $1`, [LATEST_SCHEMA]));
    try {
      const old = await assertRejects(() => compose(new MapSettings({ ...base, EMBEDDING_DIMENSIONS: String(DIMS) }), new RecordingLog()), Error);
      assertStringIncludes(old.message, `schema version ${LATEST_SCHEMA - 1}`);
      assertStringIncludes(old.message, `needs ${LATEST_SCHEMA}`);
      assertStringIncludes(old.message, "deno task migrate");
    } finally {
      await sql((c) => c.queryArray(`INSERT INTO schema_version (version, name) VALUES ($1, 'tenancy')`, [LATEST_SCHEMA]));
    }
    const { ports } = await compose(new MapSettings({ ...base, EMBEDDING_DIMENSIONS: String(DIMS) }), new RecordingLog());
    assertEquals(ports.memory.isolation, "tenant");
    await (ports.memory as PostgresMemory).close();
  });

  Deno.test("[postgres] a statement blocked by a lock dies at statement_timeout with a memory.timeout log, not a hang", async () => {
    const blocker = new Pool(url, 1, true);
    const held = await blocker.connect();
    const log = new RecordingLog();
    const memory = new PostgresMemory(url, new FakeEmbedder(), log, { poolSize: 1, statementTimeoutMs: 300 });
    try {
      await held.queryArray("BEGIN");
      await held.queryArray("LOCK TABLE thoughts IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await assertRejects(() => memory.summary({ tenant: "a", actor: "a" }), Error, "did not answer within 300 ms");
      assert(Date.now() - started < 5_000);
      const ev = log.events.find((e) => e.event === "memory.timeout");
      assert(ev, "memory.timeout must be logged");
      assertEquals(ev.fields?.phase, "statement");
      assertEquals(ev.fields?.ms, 300);
    } finally {
      await held.queryArray("ROLLBACK").catch(() => {});
      held.release();
      await blocker.end();
      await memory.close();
    }
  });

  Deno.test("[postgres] every row records the embedding model and width; alreadyKnown is exact (from the insert, not from a null check)", async () => {
    await truncate();
    const memory = new PostgresMemory(url, new FakeEmbedder(), new NullLog(), { poolSize: 1 });
    try {
      const a = await memory.remember({ tenant: "t", actor: "x" }, "provenance row", {});
      assertEquals(a.alreadyKnown, false);
      const b = await memory.remember({ tenant: "t", actor: "x" }, "provenance  row", {});
      assertEquals(b.alreadyKnown, true);
      assertEquals(b.id, a.id);
      await sql(async (c) => {
        const r = await c.queryObject<{ embedding_model: string; embedding_dims: number; tenant: string }>(`SELECT embedding_model, embedding_dims, tenant FROM thoughts WHERE id = $1::uuid`, [a.id]);
        assertEquals(r.rows[0], { embedding_model: "fake", embedding_dims: 1536, tenant: "t" });
      });
    } finally {
      await memory.close();
    }
  });

  Deno.test("[postgres] a tenant with 1 % of the rows still gets its rows through the HNSW index (iterative scan)", async () => {
    await truncate();
    // A few thousand rows is a sequential scan to the planner, and a 30-row tenant is a btree
    // lookup plus an exact sort: both are correct and neither touches the HNSW graph. The loss
    // this test guards against happens when the planner takes the HNSW index and filters by
    // tenant afterwards (a tenant that is 1 % of a million rows). Force that path here: no
    // sequential scan, no tenant btree, for this test database and this test only.
    const dbName = assertTestDatabase(url);
    await sql((c) => c.queryArray(`ALTER DATABASE "${dbName}" SET enable_seqscan = off; DROP INDEX IF EXISTS idx_thoughts_tenant_created_at; DROP INDEX IF EXISTS idx_thoughts_created_at`));
    const embedder = new BagOfWordsEmbedder(DIMS);
    const memory = new PostgresMemory(url, embedder, new NullLog(), { poolSize: 4 });
    const big = { tenant: "big", actor: "seed" };
    const small = { tenant: "small", actor: "seed" };
    try {
      // Every row shares the base phrase and adds three words of its own, so all rows sit at a
      // similar distance from the query (no row is a near-exact hit) and every vector is distinct.
      const vocab = "amber basalt cedar dune ember fjord granite harbour iris jade kelp lagoon marble nickel ochre pine quartz reed slate tundra umber velvet willow xenon yarrow zinc alder birch cobalt delta elm flint gorse heather ivory juniper lichen mica nettle oak pebble quince rowan sage thistle vale wren yew ash bracken clover dusk fern gale hazel inlet knoll loam moss orchid".split(" ");
      let seed = 12345;
      const word = () => vocab[(seed = (seed * 1103515245 + 12345) >>> 0) % vocab.length];
      const sentence = () => `the quick brown fox jumps over the lazy dog near the ${word()} ${word()} ${word()}`;
      const bigRows = Array.from({ length: 3000 }, sentence);
      const smallRows = Array.from({ length: 30 }, sentence);
      let next = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < bigRows.length) await memory.remember(big, bigRows[next++], {});
      }));
      for (const s of smallRows) await memory.remember(small, s, {});
      await sql((c) => c.queryArray("ANALYZE thoughts"));

      // The test is void unless the planner really goes through the HNSW index for this shape of query.
      const query = "the quick brown fox jumps over the lazy dog near the river";
      const q = await embedder.embed(query);
      const plan = await sql(async (c) => {
        const r = await c.queryObject<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT id FROM thoughts WHERE tenant = 'small' ORDER BY embedding <=> $1::vector LIMIT 10`,
          [`[${q.join(",")}]`],
        );
        return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
      });
      assertStringIncludes(plan, "idx_thoughts_embedding", `the HNSW index must be in the plan for this test to mean anything:\n${plan}`);

      const found = await memory.recall(small, query, { limit: 10, minScore: 0.5 });
      assertEquals(found.length, 10, `iterative scan must surface the small tenant's rows; got ${found.length}`);
      assert(found.every((f) => smallRows.includes(f.content)), "and only the small tenant's");

      // Without the iterative scan the same query loses most of them. Recorded, so a future pgvector change is visible.
      const plain = await sql(async (c) => {
        await c.queryArray("BEGIN");
        await c.queryArray("SET LOCAL hnsw.iterative_scan = off");
        const r = await c.queryObject(`SELECT id FROM thoughts WHERE tenant = 'small' ORDER BY embedding <=> $1::vector LIMIT 10`, [`[${q.join(",")}]`]);
        await c.queryArray("ROLLBACK");
        return r.rows.length;
      });
      console.log(`  [postgres] 1 % tenant: iterative=${found.length} plain=${plain}`);
      assert(plain <= found.length);
    } finally {
      await memory.close();
      await sql((c) =>
        c.queryArray(
          `ALTER DATABASE "${dbName}" RESET enable_seqscan; CREATE INDEX IF NOT EXISTS idx_thoughts_tenant_created_at ON thoughts (tenant, created_at DESC); CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC)`,
        )
      );
    }
  });

  runMemoryContract("postgres", async () => {
    await truncate();
    const memory = new PostgresMemory(url, new FakeEmbedder(), new NullLog(), { poolSize: 2 });
    return { memory, close: () => memory.close() };
  });

  runLedgerContract("ledger/postgres", async () => {
    await truncate();
    const memory = new PostgresMemory(url, new BagOfWordsEmbedder(DIMS), new NullLog(), { poolSize: 2 });
    return { ledger: new PostgresLedger(memory, new BagOfWordsEmbedder(DIMS), new NullLog()), close: () => memory.close() };
  });

  Deno.test("[ledger/postgres] subjects: a same-moment tie is broken by code-point order, whatever the database collation", async () => {
    await truncate();
    const memory = new PostgresMemory(url, new FakeEmbedder(), new NullLog(), { poolSize: 2 });
    const ledger = new PostgresLedger(memory, new FakeEmbedder(), new NullLog(), () => new Date("2026-09-21T10:00:00.000Z"));
    const A = { tenant: "alice", actor: "a" };
    try {
      for (const subject of ["b", "B", "a", "_z", "a:2", "a:10"]) await ledger.assert(A, { subject, claim: subject, source: "s" });
      const rows = await ledger.subjects(A);
      assertEquals(rows.map((r) => r.subject), ["B", "_z", "a", "a:10", "a:2", "b"]);
      assert(rows.every((r) => r.latestAt === "2026-09-21T10:00:00.000Z" && r.lines === 1 && r.current === 1));
    } finally {
      await memory.close();
    }
  });
}
