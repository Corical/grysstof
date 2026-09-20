/**
 * Put every limb through the same paces and time it.
 *
 *   deno task bench            # in-process limbs
 *   OB_PG_URL=… deno task bench  # plus Postgres (a *_test database)
 *
 * Memory limbs: 200 distinct remembers, 200 re-remembers of the same text
 * (dedupe path), 50 recalls, 50 gets, 20 recent, 5 summaries.
 * Ledger limbs: 1,000 asserts on one subject, latest, history, 50 finds.
 * Numbers are wall-clock milliseconds on this machine; compare limbs to each
 * other, not to anything else. Writes a Markdown table to .matrix-out/bench.md.
 */
import type { Ledger, Memory } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { VectorMemory } from "../adapters/memory/vector-in-process.ts";
import { JsonFileMemory } from "../adapters/memory/jsonfile.ts";
import { SqliteMemory } from "../adapters/memory/sqlite.ts";
import { BagOfWordsEmbedder, FakeEmbedder } from "../adapters/memory/vectors.ts";
import { SqliteLedger } from "../adapters/ledger/sqlite.ts";
import { InProcessLedger, JsonlLedger } from "../adapters/ledger/in-process.ts";
import { NullLog } from "../adapters/log.ts";

const A = { tenant: "bench", actor: "bench" };
const N = 200, Q = 50, L = 1000;
const OUT = new URL("../.matrix-out/", import.meta.url);
await Deno.mkdir(OUT, { recursive: true });
const tmp = (p: string) => Deno.makeTempDirSync({ prefix: p });
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

const sentence = (i: number) => `Bench thought ${i}: ${["Zenith", "Dekro", "Acme", "Ecowize", "Fairlawns"][i % 5]} reported ${100 + i} sites and ${i % 7} open issues in week ${i % 52}`;

type MemRow = { limb: string; write200: number; dedupe200: number; recall50: number; get50: number; recent20: number; summary5: number; note?: string };
type LedRow = { limb: string; assert1000: number; latest: number; history: number; find50: number };

async function benchMemory(name: string, m: Memory, close?: () => Promise<void> | void): Promise<MemRow> {
  const ids: string[] = [];
  let t = performance.now();
  for (let i = 0; i < N; i++) ids.push((await m.remember(A, sentence(i), { type: "observation", topics: ["bench"] })).id);
  const write200 = ms(t);
  t = performance.now();
  for (let i = 0; i < N; i++) await m.remember(A, sentence(i), { seen: i });
  const dedupe200 = ms(t);
  t = performance.now();
  for (let i = 0; i < Q; i++) await m.recall(A, `${["Zenith", "Dekro", "Acme"][i % 3]} sites open issues week ${i}`, { limit: 5, minScore: 0 });
  const recall50 = ms(t);
  t = performance.now();
  for (let i = 0; i < Q; i++) await m.get(A, ids[i]);
  const get50 = ms(t);
  t = performance.now();
  for (let i = 0; i < 20; i++) await m.recent(A, { limit: 10, topic: "bench" });
  const recent20 = ms(t);
  t = performance.now();
  for (let i = 0; i < 5; i++) await m.summary(A);
  const summary5 = ms(t);
  await close?.();
  return { limb: name, write200, dedupe200, recall50, get50, recent20, summary5 };
}

async function benchLedger(name: string, l: Ledger, close?: () => Promise<void> | void): Promise<LedRow> {
  let t = performance.now();
  for (let i = 0; i < L; i++) await l.assert(A, { subject: "client:bench", claim: `site count is ${100 + i}`, source: `run:${i}` });
  const assert1000 = ms(t);
  t = performance.now();
  await l.latest(A, "client:bench");
  const latest = ms(t);
  t = performance.now();
  await l.history(A, "client:bench");
  const history = ms(t);
  t = performance.now();
  for (let i = 0; i < Q; i++) await l.find(A, `site count is ${100 + i}`, { limit: 5, minScore: 0 });
  const find50 = ms(t);
  await close?.();
  return { limb: name, assert1000, latest, history, find50 };
}

const mems: MemRow[] = [];
mems.push(await benchMemory("keyword (in-process)", new KeywordMemory()));
mems.push(await benchMemory("vector (in-process, bag-of-words 256)", new VectorMemory(new BagOfWordsEmbedder())));
{ const d = tmp("bench-jf-"); mems.push(await benchMemory("jsonfile (bag-of-words 256)", new JsonFileMemory(d, new BagOfWordsEmbedder()), () => Deno.remove(d, { recursive: true }))); }
{ const d = tmp("bench-sq-"); const m = new SqliteMemory(`${d}/b.db`, new BagOfWordsEmbedder()); mems.push(await benchMemory("sqlite (bag-of-words 256, cosine in JS)", m, async () => { m.close(); await Deno.remove(d, { recursive: true }); })); }
const pg = Deno.env.get("OB_PG_URL");
if (pg) {
  const { PostgresMemory } = await import("../adapters/memory/postgres.ts");
  const { assertTestDatabase } = await import("../tests/pg-guard.ts");
  assertTestDatabase(pg);
  const m = new PostgresMemory(pg, new FakeEmbedder(1536), new NullLog());
  mems.push(await benchMemory("postgres (pgvector, fake 1536, localhost)", m, () => m.close()));
} else {
  mems.push({ limb: "postgres", write200: 0, dedupe200: 0, recall50: 0, get50: 0, recent20: 0, summary5: 0, note: "OB_PG_URL not set" });
}

const leds: LedRow[] = [];
leds.push(await benchLedger("in-process", new InProcessLedger()));
{ const d = tmp("bench-jl-"); leds.push(await benchLedger("jsonl (append-only file)", new JsonlLedger(`${d}/l.jsonl`), () => Deno.remove(d, { recursive: true }))); }
{ const d = tmp("bench-ls-"); const l = new SqliteLedger(`${d}/l.db`); leds.push(await benchLedger("sqlite (events table)", l, async () => { l.close(); await Deno.remove(d, { recursive: true }); })); }

const f = (n: number) => n.toLocaleString("en-ZA", { maximumFractionDigits: 1 });
let md = `# Bench — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n\nMilliseconds, wall clock, this machine. Compare limbs to each other.\n\n## Memory limbs\n\n| Limb | 200 writes | 200 dedupe re-writes | 50 recalls | 50 gets | 20 recent | 5 summaries |\n|---|---:|---:|---:|---:|---:|---:|\n`;
for (const r of mems) md += r.note ? `| ${r.limb} | ${r.note} | | | | | |\n` : `| ${r.limb} | ${f(r.write200)} | ${f(r.dedupe200)} | ${f(r.recall50)} | ${f(r.get50)} | ${f(r.recent20)} | ${f(r.summary5)} |\n`;
md += `\n## Ledger limbs\n\n| Limb | 1,000 asserts (one subject) | latest | history (1,000 lines) | 50 finds |\n|---|---:|---:|---:|---:|\n`;
for (const r of leds) md += `| ${r.limb} | ${f(r.assert1000)} | ${f(r.latest)} | ${f(r.history)} | ${f(r.find50)} |\n`;
await Deno.writeTextFile(new URL("bench.md", OUT), md);
console.log(md);
