/**
 * Seed the memory the environment names from a tree of Markdown files.
 *
 *   deno run -A entry/seed-markdown.ts <root-dir>
 *       [--dry-run] [--limit n] [--concurrency n]
 *       [--client-from <regex with one capture group, applied to the relative path>]
 *       [--failures <file>]   (default seed-failures.jsonl; one JSON line per failed chunk)
 *
 * Composition comes from the environment exactly as serve.ts does, and the
 * tenant and actor come from the gate, so the seed lands where a request
 * with this key would. OB_MEMORY must be set explicitly. Exits 1 if any
 * chunk failed, 2 on a usage or configuration error.
 */
import { compose } from "../compose.ts";
import { EnvSettings } from "../adapters/settings.ts";
import { ConsoleLog } from "../adapters/log.ts";
import type { Scope } from "../core/ports/mod.ts";
import { assertExplicitMemory, type Chunk, chunk, seedTree, walk } from "../seed/markdown.ts";

function usage(msg: string): never {
  console.error(msg);
  console.error("usage: seed-markdown.ts <root-dir> [--dry-run] [--limit n] [--concurrency n] [--client-from <regex>] [--failures <file>]");
  Deno.exit(2);
}

const args = [...Deno.args];
const root = args.shift();
if (!root || root.startsWith("--")) usage("missing <root-dir>");
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const limit = Number(opt("--limit") ?? Infinity);
const concurrency = Number(opt("--concurrency") ?? 4);
const failuresFile = opt("--failures") ?? "seed-failures.jsonl";
let clientFrom: RegExp | undefined;
if (opt("--client-from")) {
  try {
    clientFrom = new RegExp(opt("--client-from")!, "i");
  } catch (e) {
    usage(`--client-from is not a valid regular expression: ${(e as Error).message}`);
  }
}

const chunks: Chunk[] = [];
for (const rel of walk(root!)) chunks.push(...chunk(rel, await Deno.readTextFile(`${root}/${rel}`)));
console.log(`files=${new Set(chunks.map((c) => c.path)).size} chunks=${chunks.length} chars=${chunks.reduce((n, c) => n + c.body.length, 0)}`);
if (dryRun) {
  for (const c of chunks.slice(0, 20)) console.log(`${c.path} :: ${c.heading} (${c.body.length})`);
  Deno.exit(0);
}

const settings = new EnvSettings();
try {
  assertExplicitMemory(settings);
} catch (e) {
  usage((e as Error).message);
}
const log = new ConsoleLog();
const { ports } = await compose(settings, log);
const decision = await ports.gate.authorise(
  new Request("http://seed.local/mcp", { headers: { "x-brain-key": settings.require("MCP_ACCESS_KEY"), "x-brain-actor": "seed:markdown" } }),
);
if (!decision.allowed) usage("The gate refused the seeder; check MCP_ACCESS_KEY");
const scope: Scope = { tenant: decision.tenant, actor: decision.actor };
console.log(`tenant=${scope.tenant} actor=${scope.actor} memory=${settings.get("OB_MEMORY")}`);

const failures = await Deno.open(failuresFile, { write: true, create: true, truncate: true });
const enc = new TextEncoder();
const result = await seedTree(ports, scope, chunks.slice(0, limit), {
  clientFrom,
  concurrency,
  onFailure: async (f) => {
    console.error(`FAILED ${f.path} :: ${f.heading}: ${f.error}`);
    await failures.write(enc.encode(JSON.stringify({ ...f, at: new Date().toISOString() }) + "\n"));
  },
  onProgress: (done, total) => {
    if (done % 25 === 0 || done === total) console.log(`progress ${done}/${total}`);
  },
});
failures.close();
console.log(`total=${result.total} written=${result.written} alreadyKnown=${result.known} failed=${result.failed}${result.failed ? ` (see ${failuresFile})` : ""}`);
Deno.exit(result.failed ? 1 : 0);
