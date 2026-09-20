/**
 * Mix-and-match matrix runner.
 *
 *   deno task matrix [--server <dir>] [--rows 1,2,5] [--out matrix-results.md]
 *
 * Each row is one `compose` environment. For each row the runner runs
 * server/tests/matrix.test.ts (compose from env, drive C1–C12 over HTTP+MCP,
 * write a normalised transcript) and, when the row has a database, the
 * Postgres contract. Then it diffs every row's transcript against row 1's:
 * same script, same output, different limbs — the swap check.
 *
 * A row is skipped, not failed, when a setting it needs is absent, and the
 * table says which one, so the report can say what was not tested and why.
 */

type Row = { id: number; why: string; env: Record<string, string>; needs?: string[]; expectRefusal?: string; pgDims?: number };
type Cell = { status: "pass" | "fail" | "skip"; seconds: number; note?: string };

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SERVER = arg("--server") ?? `${HERE}..`;
const OUT = `${SERVER}/.matrix-out`;
await Deno.mkdir(OUT, { recursive: true });
const rowFilter = arg("--rows")?.split(",").map(Number);
const outFile = arg("--out") ?? "matrix-results.md";

// Every run gets fresh tenant names so a persistent store (Postgres, files) never carries a
// previous run's rows into this one's transcript.
const RUN = Date.now().toString(36);
const KEYS = `ka=alpha-${RUN}:agent-a,kb=beta-${RUN}:agent-b`;
const TENANT = { OB_TENANT: `t-${RUN}` };
const OLLAMA = { EMBEDDING_API_BASE: "http://localhost:11434/v1", EMBEDDING_API_KEY: "ollama", EMBEDDING_MODEL: "nomic-embed-text", EMBEDDING_DIMENSIONS: "768" };

const ROWS: Row[] = [
  { id: 1, why: "zero models, zero vendors", env: { OB_MEMORY: "keyword", OB_UNDERSTANDING: "rules", OB_GATE: "shared-key", MCP_ACCESS_KEY: "m" } },
  { id: 2, why: "in-process vector (single-tenant) behind a many-tenant gate: compose must refuse", expectRefusal: "does not partition by tenant", env: { OB_MEMORY: "vector", OB_EMBEDDER: "bag-of-words", OB_UNDERSTANDING: "rules", OB_GATE: "keyring", OB_KEYS: KEYS, OB_LOG: "jsonl" } },
  { id: 3, why: "file persistence on both sockets", env: { OB_MEMORY: "jsonfile", OB_MEMORY_DIR: `${OUT}/row3-mem`, OB_LEDGER: "jsonl", OB_LEDGER_FILE: `${OUT}/row3-ledger.jsonl`, OB_EMBEDDER: "bag-of-words", OB_UNDERSTANDING: "null", OB_GATE: "keyring", OB_KEYS: KEYS, OB_LOG: "jsonl" } },
  { id: 4, why: "second SQL dialect, proxy identity", env: { OB_MEMORY: "sqlite", OB_SQLITE_FILE: `${OUT}/row4.db`, OB_EMBEDDER: "bag-of-words", OB_UNDERSTANDING: "rules", OB_GATE: "trusted-headers", OB_TRUST_SECRET: "s3cret", OB_LOG: "jsonl" } },
  { id: 5, why: "Friday's real run, tenanted (Postgres + Ollama + Anthropic)", env: { OB_MEMORY: "postgres", ...OLLAMA, CHAT_API_BASE: "https://api.anthropic.com/v1", CHAT_MODEL: "claude-haiku-4-5-20251001", OB_GATE: "keyring", OB_KEYS: KEYS, OB_LOG: "jsonl" }, needs: ["OB_PG_URL", "CHAT_API_KEY"], pgDims: 768 },
  { id: 6, why: "ledger independent of memory", env: { OB_MEMORY: "postgres", OB_LEDGER: "in-process", ...OLLAMA, OB_UNDERSTANDING: "rules", OB_GATE: "keyring", OB_KEYS: KEYS }, needs: ["OB_PG_URL"], pgDims: 768 },
  { id: 7, why: "error paths under a failing store", env: { OB_MEMORY: "chaos", OB_CHAOS_INNER: "postgres", OB_CHAOS_FAIL_EVERY: "4", OB_EMBEDDER: "bag-of-words", EMBEDDING_DIMENSIONS: "1536", OB_UNDERSTANDING: "null", OB_GATE: "shared-key", MCP_ACCESS_KEY: "m", ...TENANT, OB_LOG: "jsonl" }, needs: ["OB_PG_URL"] },
  { id: 8, why: "the core's guards (offline vectors, null tagging)", env: { OB_MEMORY: "vector", OB_EMBEDDER: "bag-of-words", OB_UNDERSTANDING: "null", OB_GATE: "shared-key", MCP_ACCESS_KEY: "m" } },
  { id: 9, why: "denial end to end", env: { OB_MEMORY: "keyword", OB_LEDGER: "in-process", OB_UNDERSTANDING: "rules", OB_GATE: "deny-all" } },
  { id: 10, why: "upstream defaults, unchanged", env: {}, needs: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"] },
];

const DENO = Deno.execPath();

async function run(files: string[], env: Record<string, string>): Promise<{ ok: boolean; seconds: number; summary: string; text: string }> {
  const started = performance.now();
  const cmd = new Deno.Command(DENO, {
    args: ["test", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "--allow-ffi", "--no-check", ...files],
    cwd: SERVER,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const r = await cmd.output();
  const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  const m = /(\d+) passed(?: \| (\d+) failed)?/.exec(text);
  const summary = m ? `${m[1]} passed${m[2] ? `, ${m[2]} failed` : ""}` : text.trim().split("\n").slice(-2).join(" / ").slice(0, 140);
  return { ok: r.success, seconds: Math.round((performance.now() - started) / 100) / 10, summary, text };
}

const results: Record<number, Record<string, Cell>> = {};
const SUITES = ["scenarios", "pg-contract", "swap"] as const;

for (const row of ROWS) {
  if (rowFilter && !rowFilter.includes(row.id)) continue;
  results[row.id] = {};
  const missing = (row.needs ?? []).filter((n) => !Deno.env.get(n));
  if (missing.length) {
    for (const s of SUITES) results[row.id][s] = { status: "skip", seconds: 0, note: `needs ${missing.join(", ")}` };
    console.log(`row ${row.id}: skip (needs ${missing.join(", ")})`);
    continue;
  }
  // Rows with their own files start clean each run.
  for (const k of ["OB_MEMORY_DIR", "OB_SQLITE_FILE", "OB_LEDGER_FILE"]) {
    if (row.env[k]) await Deno.remove(row.env[k], { recursive: true }).catch(() => {});
  }
  const env: Record<string, string> = { ...row.env, OB_MATRIX_ROW: String(row.id), OB_MATRIX_OUT: OUT };
  const usesPg = row.env.OB_MEMORY === "postgres" || row.env.OB_CHAOS_INNER === "postgres";
  if (usesPg) {
    // A *_test database of the right width, brought to this build's schema before anything composes against it.
    const base = Deno.env.get("OB_PG_URL")!;
    env.OB_PG_URL = row.pgDims === 768 ? base.replace("/openbrain_test?", "/openbrain_test768?") : base;
    env.EMBEDDING_DIMENSIONS = String(row.pgDims ?? 1536);
    const mig = new Deno.Command(DENO, { args: ["task", "migrate"], cwd: SERVER, env: { OB_PG_URL: env.OB_PG_URL, EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS }, stdout: "piped", stderr: "piped" });
    const m = await mig.output();
    const migOut = new TextDecoder().decode(m.stdout).trim().split("\n").pop() ?? new TextDecoder().decode(m.stderr).trim().split("\n").pop();
    console.log(`row ${row.id} migrate: ${migOut}`);
  }
  if (Deno.env.get("CHAT_API_KEY")) env.CHAT_API_KEY = Deno.env.get("CHAT_API_KEY")!;

  const sc = await run(["tests/matrix.test.ts"], env);
  if (row.expectRefusal) {
    const refused = !sc.ok && sc.text.includes(row.expectRefusal);
    await Deno.writeTextFile(`${OUT}/row${row.id}-scenarios.log`, sc.text);
    results[row.id].scenarios = { status: refused ? "pass" : "fail", seconds: sc.seconds, note: refused ? "refused as expected" : "was NOT refused" };
    results[row.id]["pg-contract"] = { status: "skip", seconds: 0, note: "refusal row" };
    console.log(`row ${row.id} scenarios: ${refused ? "pass" : "FAIL"} (${results[row.id].scenarios.note})`);
    continue;
  }
  await Deno.writeTextFile(`${OUT}/row${row.id}-scenarios.log`, sc.text);
  results[row.id].scenarios = { status: sc.ok ? "pass" : "fail", seconds: sc.seconds, note: sc.summary };
  console.log(`row ${row.id} scenarios: ${sc.ok ? "pass" : "FAIL"} (${sc.seconds}s) ${sc.summary}`);

  if (usesPg && (row.pgDims ?? 1536) === 1536) {
    const pg = await run(["tests/memory-postgres.test.ts"], env);
    await Deno.writeTextFile(`${OUT}/row${row.id}-pg.log`, pg.text);
    results[row.id]["pg-contract"] = { status: pg.ok ? "pass" : "fail", seconds: pg.seconds, note: pg.summary };
    console.log(`row ${row.id} pg-contract: ${pg.ok ? "pass" : "FAIL"} (${pg.seconds}s) ${pg.summary}`);
  } else {
    results[row.id]["pg-contract"] = { status: "skip", seconds: 0, note: usesPg ? "contract suite is 1536-wide; this row is 768" : "no database in this row" };
  }
}

// Swap check: every row's transcript against row 1's.
const readT = async (id: number) => await Deno.readTextFile(`${OUT}/transcript-row${id}.txt`).catch(() => null);
const base = await readT(1);
for (const row of ROWS) {
  if (!results[row.id] || results[row.id].scenarios?.status === "skip") continue;
  if (row.env.OB_MEMORY === "chaos") { results[row.id].swap = { status: "skip", seconds: 0, note: "chaos rows are not comparable by design" }; continue; }
  const t = await readT(row.id);
  if (!t) {
    results[row.id].swap = { status: "skip", seconds: 0, note: row.env.OB_GATE === "deny-all" ? "denied rows have no transcript" : "no transcript" };
    continue;
  }
  if (!base || row.id === 1) {
    results[row.id].swap = { status: "pass", seconds: 0, note: "baseline" };
    continue;
  }
  if (t === base) {
    results[row.id].swap = { status: "pass", seconds: 0, note: "identical to row 1" };
  } else {
    const a = base.split("\n"), b = t.split("\n");
    const firstDiff = a.findIndex((l, i) => l !== b[i]);
    await Deno.writeTextFile(`${OUT}/swap-diff-row${row.id}.txt`, `--- row1\n+++ row${row.id}\n@@ line ${firstDiff + 1}\n- ${a[firstDiff]}\n+ ${b[firstDiff] ?? "<missing>"}\n`);
    results[row.id].swap = { status: "fail", seconds: 0, note: `differs at line ${firstDiff + 1}` };
  }
  console.log(`row ${row.id} swap: ${results[row.id].swap.status} ${results[row.id].swap.note}`);
}

const mark = (c?: Cell) => !c ? "—" : c.status === "pass" ? `✅ ${c.note ?? ""} ${c.seconds ? c.seconds + "s" : ""}`.trim() : c.status === "fail" ? `❌ ${c.note ?? ""}`.trim() : `⏭ ${c.note}`;
const combo = (r: Row) => ["OB_MEMORY", "OB_LEDGER", "OB_EMBEDDER", "OB_UNDERSTANDING", "OB_GATE", "OB_LOG"].map((k) => r.env[k] ?? "default").join(" / ");
const lines = ROWS.filter((r) => results[r.id]).map((r) => `| ${r.id} | ${combo(r)} | ${SUITES.map((s) => mark(results[r.id][s])).join(" | ")} | ${r.why} |`);
const md = `# Matrix results — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n\nColumns: memory / ledger / embedder / understanding / gate / log.\n\n| # | Combination | ${SUITES.join(" | ")} | Why |\n|---|---|${SUITES.map(() => "---").join("|")}|---|\n${lines.join("\n")}\n\nLogs and transcripts: \`.local/limbs-prep/out/\`\n`;
await Deno.writeTextFile(`${OUT}/${outFile}`, md);
console.log(`\nwrote ${outFile}`);
