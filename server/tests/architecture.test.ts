/**
 * The core knows no vendor. Checked on the real module graph (`deno info`),
 * not on source text, so dynamic imports and re-exports are seen too. Walks
 * every file under core/ recursively.
 */
import { assert, assertEquals } from "@std/assert";

const serverDir = new URL("../", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.name.endsWith(".ts")) yield u;
  }
}

async function graph(entry: URL): Promise<string[]> {
  const cmd = new Deno.Command(Deno.execPath(), { args: ["info", "--json", entry.href], cwd: new URL(".", serverDir).pathname.replace(/^\/([A-Za-z]:)/, "$1"), stdout: "piped", stderr: "piped" });
  const out = await cmd.output();
  const json = JSON.parse(new TextDecoder().decode(out.stdout));
  return (json.modules as { specifier: string }[]).map((m) => m.specifier);
}

const FRAMEWORK = [/^npm:\/?hono@/, /^npm:\/?zod@/, /^npm:\/?@hono\/mcp@/, /^npm:\/?@modelcontextprotocol\/sdk@/];
const isCore = (s: string) => s.startsWith(new URL("core/", serverDir).href);

Deno.test("every module reachable from core/app.ts is core or an allowed framework; no adapter, no vendor", async () => {
  const mods = await graph(new URL("core/app.ts", serverDir));
  const offenders = mods.filter((s) => !isCore(s) && !FRAMEWORK.some((re) => re.test(s)) && !s.startsWith("node:") && !s.includes("/node_modules/"));
  assertEquals(offenders, []);
  assert(mods.some(isCore));
});

Deno.test("no file under core/ mentions the environment, the network, a host, or an adapter path", async () => {
  const forbidden = [/Deno\.env/, /process\.env/, /\bfetch\s*\(/, /globalThis\.fetch/, /Deno\.serve/, /adapters\//, /@supabase/, /["']postgres["']/, /openrouter/i, /azure/i, /edge-runtime/];
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for await (const f of walk(new URL("core/", serverDir))) {
    const src = stripComments(await Deno.readTextFile(f));
    const page = ({ "/core/browse-page.ts": "BROWSE_PAGE", "/core/pulse-page.ts": "PULSE_PAGE" } as Record<string, string>)[f.pathname.slice(f.pathname.lastIndexOf("/core/"))];
    if (page) {
      // A browser page is an asset the core hands out, not code the core runs: it may hold
      // nothing but one string constant. Its fetch() calls execute in the visitor's browser.
      assertEquals(/\bimport\b|\bDeno\b|\bfunction\b|\bawait\b/.test(src.replace(/String\.raw`[\s\S]*`/, "")), false, `${f.pathname} is more than a string`);
      assertEquals(new RegExp(`^export const ${page} = String\\.raw\``, "m").test(src), true, `${f.pathname} must export ${page} as a String.raw literal`);
      continue;
    }
    for (const re of forbidden) assertEquals(re.test(src), false, `${f.pathname} matches ${re}`);
  }
});

Deno.test("port files under core/ports export types and constants only, no classes or network", async () => {
  for await (const f of walk(new URL("core/ports/", serverDir))) {
    const src = (await Deno.readTextFile(f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assertEquals(/\bclass\b/.test(src), false, `${f.pathname} declares a class`);
    assertEquals(/\bfetch\b/.test(src), false, `${f.pathname} touches the network`);
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) assert(m[1].startsWith("./"), `${f.pathname} imports ${m[1]}`);
  }
});

Deno.test("only compose.ts and the entries name an implementation", async () => {
  // Composition roots: compose.ts, the Supabase entry, anything under entry/; tools/ are harnesses like tests/.
  const allowed = new Set(["compose.ts", "index.ts"]);
  const offenders: string[] = [];
  for await (const f of walk(serverDir)) {
    const rel = f.href.slice(serverDir.href.length);
    if (rel.startsWith("adapters/") || rel.startsWith("tests/") || rel.startsWith("tools/") || rel.startsWith("entry/") || rel.includes("node_modules/") || allowed.has(rel)) continue;
    const src = await Deno.readTextFile(f);
    if (/["']\.\.?\/(?:.*\/)?adapters\//.test(src)) offenders.push(rel);
  }
  assertEquals(offenders, []);
});

Deno.test("no memory adapter imports another memory adapter's vendor", async () => {
  const vendors: Record<string, RegExp[]> = {
    "adapters/memory/supabase.ts": [/["']postgres["']/],
    "adapters/memory/postgres.ts": [/@supabase/],
    "adapters/memory/keyword.ts": [/@supabase/, /["']postgres["']/, /\bfetch\b/],
    "adapters/memory/vector-in-process.ts": [/@supabase/, /["']postgres["']/, /\bfetch\b/],
    "adapters/gate.ts": [/@supabase/, /["']postgres["']/, /\bfetch\b/],
    "adapters/settings.ts": [/@supabase/, /["']postgres["']/, /\bfetch\b/],
    "adapters/log.ts": [/@supabase/, /["']postgres["']/, /\bfetch\b/],
  };
  for (const [rel, res] of Object.entries(vendors)) {
    const src = await Deno.readTextFile(new URL(rel, serverDir));
    for (const re of res) assertEquals(re.test(src), false, `${rel} matches ${re}`);
  }
});
