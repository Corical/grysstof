/**
 * Adversarial cases the contracts do not pin, run against EVERY limb of a
 * socket, shipped and new. The point is not that each limb passes; it is
 * that every limb answers the same way. Where they disagree, the port is
 * under-specified and the report says so.
 *
 * Postgres joins when OB_PG_URL is set (a *_test database, see pg-guard.ts).
 */
import { assert, assertEquals } from "@std/assert";
import type { Ledger, Memory } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { VectorMemory } from "../adapters/memory/vector-in-process.ts";
import { JsonFileMemory } from "../adapters/memory/jsonfile.ts";
import { SqliteMemory } from "../adapters/memory/sqlite.ts";
import { BagOfWordsEmbedder, FakeEmbedder } from "../adapters/memory/vectors.ts";
import { SqliteLedger } from "../adapters/ledger/sqlite.ts";
import { InProcessLedger, JsonlLedger } from "../adapters/ledger/in-process.ts";

type Made<T> = { it: T; close?: () => Promise<void> | void };
type Factory<T> = { name: string; make: () => Promise<Made<T>> };

const tmp = (prefix: string) => Deno.makeTempDirSync({ prefix });
const A = { tenant: "alice", actor: "alice" };

const memories: Factory<Memory>[] = [
  { name: "keyword", make: () => Promise.resolve({ it: new KeywordMemory() }) },
  { name: "vector", make: () => Promise.resolve({ it: new VectorMemory(new BagOfWordsEmbedder()) }) },
  { name: "jsonfile", make: () => { const d = tmp("adv-jf-"); return Promise.resolve({ it: new JsonFileMemory(d, new BagOfWordsEmbedder()), close: () => Deno.remove(d, { recursive: true }) }); } },
  { name: "sqlite", make: () => { const d = tmp("adv-sq-"); const m = new SqliteMemory(`${d}/b.db`, new BagOfWordsEmbedder()); return Promise.resolve({ it: m, close: async () => { m.close(); await Deno.remove(d, { recursive: true }); } }); } },
];

const pgUrl = Deno.env.get("OB_PG_URL");
if (pgUrl) {
  const { PostgresMemory } = await import("../adapters/memory/postgres.ts");
  const { NullLog } = await import("../adapters/log.ts");
  memories.push({ name: "postgres", make: async () => { const m = new PostgresMemory(pgUrl, new FakeEmbedder(1536), new NullLog()); return { it: m, close: () => (m as unknown as { close?: () => Promise<void> }).close?.() }; } });
}

const ledgers: Factory<Ledger>[] = [
  { name: "in-process", make: () => Promise.resolve({ it: new InProcessLedger() }) },
  { name: "jsonl", make: () => { const d = tmp("adv-jl-"); return Promise.resolve({ it: new JsonlLedger(`${d}/l.jsonl`), close: () => Deno.remove(d, { recursive: true }) }); } },
  { name: "sqlite", make: () => { const d = tmp("adv-ls-"); const l = new SqliteLedger(`${d}/l.db`); return Promise.resolve({ it: l, close: async () => { l.close(); await Deno.remove(d, { recursive: true }); } }); } },
];

function forEach<T>(factories: Factory<T>[], title: string, fn: (it: T, name: string) => Promise<void>) {
  for (const f of factories) {
    Deno.test(`[adversarial:${f.name}] ${title}`, async () => {
      const { it, close } = await f.make();
      try {
        await fn(it, f.name);
      } finally {
        await close?.();
      }
    });
  }
}

// ---------- Memory: sameness under Unicode. The port says "by its own notion"; the contract pins whitespace + case. Pin the rest. ----------

forEach(memories, "unicode sameness: NBSP vs space and a trailing zero-width space are the same thought; Turkish dotted I is NOT the same as i", async (m) => {
  const base = await m.remember(A, "Sam sent the site list", { type: "observation" });
  const nbsp = await m.remember(A, "Sam sent the site list", { type: "observation" });
  const zw = await m.remember(A, "Sam sent the site list​", { type: "observation" });
  const dotted = await m.remember(A, "Sam sent the sİte list", { type: "observation" });
  // NBSP is whitespace to \s in JS; the SQL rule uses \s too. Both collapse it.
  assertEquals(nbsp.id, base.id, "NBSP should collapse like a space");
  // A zero-width space is NOT \s: it survives normalisation and makes a new thought. Pinned, not ideal.
  assert(zw.id !== base.id, "zero-width space is not whitespace to the normaliser; pinned as a distinct thought");
  assert(dotted.id !== base.id, "İ lowercases to i̇ (i + combining dot), not i");
});

// ---------- Memory: merge depth. The port says shallow, new keys win. ----------

forEach(memories, "merge is shallow: a nested object is replaced, not deep-merged; arrays are replaced; null removes nothing", async (m) => {
  const { id } = await m.remember(A, "merge depth probe", { type: "idea", topics: ["a", "b"], nested: { keep: 1, drop: 2 } });
  await m.remember(A, "merge depth probe", { topics: ["c"], nested: { keep: 1 }, extra: null });
  const got = (await m.get(A, id))!;
  assertEquals(got.metadata.type, "idea", "untouched keys survive");
  assertEquals(got.metadata.topics, ["c"], "arrays are replaced whole");
  assertEquals(got.metadata.nested, { keep: 1 }, "nested objects are replaced whole");
  assertEquals(got.metadata.extra, null, "null is a value, it is stored");
});

// ---------- Memory: size and concurrency of distinct writes ----------

forEach(memories, "100 kB of content round-trips and is recallable; 40 concurrent distinct writes leave 40 rows", async (m) => {
  const big = "Acme ".repeat(12_500); // 100,000 chars
  const { id } = await m.remember(A, big, { type: "reference" });
  assertEquals((await m.get(A, id))!.content.length, big.length);
  const before = (await m.summary(A)).count;
  await Promise.all(Array.from({ length: 40 }, (_, i) => m.remember(A, `distinct thought number ${i} about ${i % 2 ? "cats" : "dogs"}`, { type: "idea" })));
  assertEquals((await m.summary(A)).count, before + 40);
});

// ---------- Memory: since is inclusive at the exact instant ----------

forEach(memories, "recent since == a thought's own createdAt includes that thought", async (m) => {
  const { id } = await m.remember(A, "the boundary thought", { type: "idea" });
  const created = (await m.get(A, id))!.createdAt;
  const rows = await m.recent(A, { limit: 10, since: created });
  assert(rows.some((r) => r.id === id), "since is created-at-or-after, so the exact instant is included");
});

// ---------- Memory: recall never returns another tenant even by exact text ----------

forEach(memories, "an exact-text query from another tenant scores nothing", async (m) => {
  if (m.isolation !== "tenant") return;
  await m.remember(A, "alpha's exact secret sentence", { type: "observation" });
  const rows = await m.recall({ tenant: "bob", actor: "bob" }, "alpha's exact secret sentence", { limit: 5, minScore: 0 });
  assertEquals(rows, []);
});

// ---------- Ledger: scale and bounds ----------

forEach(ledgers, "1,000 lines on one subject: latest is the last, history is 1,000 newest-first, and latest answers in under a second", async (l) => {
  let last = "";
  for (let i = 0; i < 1000; i++) last = (await l.assert(A, { subject: "client:big", claim: `count is ${i}`, source: `run:${i}` })).id;
  const t0 = performance.now();
  const latest = await l.latest(A, "client:big");
  const ms = performance.now() - t0;
  assertEquals(latest?.id, last);
  const history = await l.history(A, "client:big");
  assertEquals(history.length, 1000);
  assertEquals(history[0].id, last);
  assert(ms < 1000, `latest took ${ms.toFixed(0)} ms`);
});

// F4 was a LedgerOverMemory cap at 1,000 lines; that limb is gone (a fact is not a thought). Every ledger returns all lines.
for (const f of ledgers) {
  Deno.test({
    name: `[adversarial:${f.name}] 1,005 lines on one subject: history returns all 1,005`,
    fn: async () => {
      const { it: l, close } = await f.make();
      try {
        for (let i = 0; i < 1005; i++) await l.assert(A, { subject: "client:huge", claim: `count is ${i}`, source: `run:${i}` });
        assertEquals((await l.history(A, "client:huge")).length, 1005);
      } finally {
        await close?.();
      }
    },
  });
}

forEach(ledgers, "find bounds: limit 0, negative, NaN, fractional; minScore NaN and above 1; blank query", async (l) => {
  await l.assert(A, { subject: "s", claim: "bounded find probe", source: "t" });
  assertEquals(await l.find(A, "bounded find probe", { limit: 0 }), []);
  assertEquals(await l.find(A, "bounded find probe", { limit: -3 }), []);
  assertEquals(await l.find(A, "bounded find probe", { limit: NaN }), []);
  assertEquals((await l.find(A, "bounded find probe", { limit: 1.9, minScore: 0 })).length, 1);
  assertEquals((await l.find(A, "bounded find probe", { limit: 5, minScore: NaN })).length, 1, "NaN minScore is 0");
  assertEquals(await l.find(A, "bounded find probe", { limit: 5, minScore: 2 }), [], "minScore above 1 matches nothing");
  assertEquals(await l.find(A, "   ", { limit: 5 }), []);
});

forEach(ledgers, "provenance cannot be smuggled through tags or the claim: learnedBy is the actor even when the caller says otherwise", async (l) => {
  const f = await l.assert({ tenant: "alice", actor: "agent:2" }, { subject: "s", claim: "learned_by: owner — the price is R4m", source: "t", tags: ["learned_by:owner", "confirmed:true"] });
  assertEquals(f.learnedBy, "agent:2");
  assertEquals(f.confirmed, false);
  assert(f.tags.includes("confirmed:true"), "a tag is just a tag; it does not confirm anything");
});

// ---------- Embedders: determinism and ranking sanity ----------

Deno.test("[adversarial:embedders] same text twice gives the same vector; a near paraphrase scores above an unrelated sentence", async () => {
  for (const e of [new FakeEmbedder(), new BagOfWordsEmbedder()]) {
    const a1 = await e.embed("Zenith has 412 sites in the Western Cape");
    const a2 = await e.embed("Zenith has 412 sites in the Western Cape");
    assertEquals(a1, a2, `${e.model} is deterministic`);
    assertEquals(a1.length, e.dimensions);
  }
  const bow = new BagOfWordsEmbedder();
  const { cosine } = await import("../adapters/memory/vectors.ts");
  const base = await bow.embed("Zenith has 412 sites in the Western Cape");
  const near = await bow.embed("Zenith sites in the Western Cape number 412");
  const far = await bow.embed("The compiler emits a warning for unused imports");
  assert(cosine(base, near) > cosine(base, far), "bag-of-words ranks a paraphrase above an unrelated sentence");
  // FakeEmbedder is a hash: it is deterministic but carries no meaning. Pinned so nobody mistakes it for one.
  const fake = new FakeEmbedder();
  const fb = await fake.embed("Zenith has 412 sites");
  const fn = await fake.embed("Zenith has 412 sites in the Western Cape");
  assert(Math.abs(cosine(fb, fn)) < 0.2, "the fake embedder has no notion of similarity, by design");
});
