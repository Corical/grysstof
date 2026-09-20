import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { assertExplicitMemory, chunk, clientSlug, MAX_CHARS, MIN_CHARS, seedTree, walk } from "../seed/markdown.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { InProcessLedger } from "../adapters/ledger/in-process.ts";
import { FixedUnderstander } from "../adapters/understanding/llm.ts";
import { RecordingLog } from "../adapters/log.ts";
import { MapSettings } from "../adapters/settings.ts";
import type { Understander, Understanding } from "../core/ports/mod.ts";

const para = (n: number, word = "word") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");
const SCOPE = { tenant: "seedtest", actor: "seed:markdown" };
const understood: Understanding = { type: "reference", topics: ["seed"], people: [], action_items: [], dates_mentioned: [] };

class CountingUnderstander implements Understander {
  calls = 0;
  understand(): Promise<Understanding> {
    this.calls++;
    return Promise.resolve({ ...understood });
  }
}

Deno.test("chunk: splits on # and ## headings, keeps ###, names the first section after the file, drops sections under MIN_CHARS", () => {
  const text = [
    `intro ${para(30)}`,
    "# One",
    `${para(30, "one")}`,
    "### not a split point",
    `${para(30, "sub")}`,
    "## Two",
    "tiny",
    "## Three",
    `${para(30, "three")}`,
  ].join("\n");
  const out = chunk("clients/acme/notes.md", text);
  assertEquals(out.map((c) => c.heading), ["notes", "One", "Three"]);
  assertStringIncludes(out[1].body, "### not a split point");
  assertStringIncludes(out[1].body, "sub0");
  assert(out.every((c) => c.body.length >= MIN_CHARS));
  assert(out.every((c) => c.path === "clients/acme/notes.md"));
  assert(out.every((c) => !c.body.includes("[clients/acme")), "the path is never baked into the content");
});

Deno.test("chunk: a # inside a code fence is not a heading (backticks and tildes, unclosed fence, CRLF)", () => {
  const text = [
    "# Real",
    `${para(30)}`,
    "```bash",
    "# this is a comment, not a heading",
    "echo hi",
    "```",
    `${para(30, "after")}`,
    "~~~",
    "## also not a heading",
    "~~~",
    "## Second",
    `${para(30, "second")}`,
    "```",
    "# unclosed fence swallows the rest",
    "## and this",
    `${para(30, "tail")}`,
  ].join("\r\n");
  const out = chunk("f.md", text);
  assertEquals(out.map((c) => c.heading), ["Real", "Second"]);
  assertStringIncludes(out[0].body, "# this is a comment, not a heading");
  assertStringIncludes(out[0].body, "## also not a heading");
  assertStringIncludes(out[1].body, "## and this");
  assert(out.every((c) => !c.body.includes("\r")), "CRLF is normalised");
});

Deno.test("chunk: an oversize section splits on paragraphs and an oversize paragraph splits on length; nothing exceeds MAX_CHARS", () => {
  const big = "x".repeat(MAX_CHARS * 2 + 100);
  const text = ["# Big", para(200), "", big, "", para(200, "tail")].join("\n");
  const out = chunk("f.md", text);
  assert(out.length >= 3, `expected several parts, got ${out.length}`);
  assert(out.every((c) => c.body.length <= MAX_CHARS), "every chunk fits");
  assertEquals(out.map((c) => c.heading), out.map((_, i) => `Big (${i + 1})`));
  assertEquals(out.map((c) => c.body).join("").replace(/\n/g, "").length, text.split("\n").slice(1).join("").length, "no text is lost");
});

Deno.test("chunk: an empty file, a headings-only file, and a file below MIN_CHARS produce nothing", () => {
  assertEquals(chunk("a.md", ""), []);
  assertEquals(chunk("a.md", "# A\n## B\n# C"), []);
  assertEquals(chunk("a.md", "short"), []);
});

Deno.test("clientSlug: comes from the caller's pattern only; no pattern, no client; the slug is the whole first group, lower-cased", () => {
  const re = /^(?:clients|reports)\/([a-z0-9-]+)(?:[/.]|$)/i;
  assertEquals(clientSlug("clients/cape-town-market.md", re), "cape-town-market");
  assertEquals(clientSlug("clients/Express-Employment-Durban.md", re), "express-employment-durban");
  assertEquals(clientSlug("reports/acme/2026-09.md", re), "acme");
  assertEquals(clientSlug("architecture.md", re), undefined);
  assertEquals(clientSlug("clients/acme.md", undefined), undefined);
  assertEquals(clientSlug("clients/acme.md", /nothing-(captured)?/), undefined);
});

Deno.test("assertExplicitMemory: refuses an unset OB_MEMORY, names it, returns the value otherwise", () => {
  const err = assertThrows(() => assertExplicitMemory(new MapSettings({})), Error);
  assertStringIncludes(err.message, "OB_MEMORY");
  assertThrows(() => assertExplicitMemory(new MapSettings({ OB_MEMORY: "" })), Error);
  assertEquals(assertExplicitMemory(new MapSettings({ OB_MEMORY: "postgres" })), "postgres");
});

Deno.test("seedTree: a re-seed of an unchanged tree makes zero model calls; a renamed file is the same thought; client and path ride in metadata", async () => {
  const memory = new KeywordMemory();
  const understander = new CountingUnderstander();
  const log = new RecordingLog();
  const ports = { memory, ledger: new InProcessLedger(), understander, log };
  const chunks = [
    { path: "clients/acme.md", heading: "Contract", body: para(30, "acme") },
    { path: "clients/zenith.md", heading: "Yard", body: para(30, "zenith") },
    { path: "architecture.md", heading: "Overview", body: para(30, "arch") },
  ];
  const re = /^clients\/([a-z0-9-]+)\.md$/i;
  const first = await seedTree(ports, SCOPE, chunks, { clientFrom: re, concurrency: 2 });
  assertEquals(first, { total: 3, written: 3, known: 0, failed: 0 });
  assertEquals(understander.calls, 3);

  const second = await seedTree(ports, SCOPE, chunks, { clientFrom: re, concurrency: 2 });
  assertEquals(second, { total: 3, written: 0, known: 3, failed: 0 });
  assertEquals(understander.calls, 3, "no model call for anything already known");

  const moved = chunks.map((c) => ({ ...c, path: c.path.replace("clients/", "customers/") }));
  const third = await seedTree(ports, SCOPE, moved, { clientFrom: re });
  assertEquals(third.written, 0);
  assertEquals(third.known, 3, "a moved file is the same thought");
  assertEquals((await memory.summary(SCOPE)).count, 3);

  const acme = (await memory.recent(SCOPE, { limit: 10, topic: "seed" })).find((t) => t.content.startsWith("acme0"))!;
  assertEquals(acme.metadata.client, "acme");
  assertEquals(acme.metadata.path, "clients/acme.md");
  assertEquals(acme.metadata.heading, "Contract");
  assertEquals(acme.metadata.source, "seed:markdown");
  assert(typeof acme.metadata.seeded_at === "string");
  const arch = (await memory.recent(SCOPE, { limit: 10 })).find((t) => t.content.startsWith("arch0"))!;
  assertEquals(arch.metadata.client, undefined);
  assert(log.events.every((e) => e.fields?.tenant === "seedtest" && e.fields?.actor === "seed:markdown"));
});

Deno.test("seedTree: a failing chunk is counted, reported through onFailure, and never stops the others; a refusing model mid-seed stores nothing for that chunk", async () => {
  const memory = new KeywordMemory();
  let n = 0;
  const flaky: Understander = {
    understand: (text) => {
      n++;
      return text.startsWith("bad") ? Promise.reject(new Error("model refused")) : Promise.resolve({ ...understood });
    },
  };
  const ports = { memory, ledger: new InProcessLedger(), understander: flaky, log: new RecordingLog() };
  const chunks = [
    { path: "a.md", heading: "A", body: para(30, "good") },
    { path: "b.md", heading: "B", body: para(30, "bad") },
    { path: "c.md", heading: "C", body: para(30, "fine") },
  ];
  const failures: { path: string; heading: string; error: string }[] = [];
  const progress: number[] = [];
  const r = await seedTree(ports, SCOPE, chunks, { onFailure: (f) => { failures.push(f); }, onProgress: (d) => progress.push(d), concurrency: 1 });
  assertEquals(r, { total: 3, written: 2, known: 0, failed: 1 });
  assertEquals(failures, [{ path: "b.md", heading: "B", error: "model refused" }]);
  assertEquals(progress, [1, 2, 3]);
  assertEquals((await memory.summary(SCOPE)).count, 2);
  assertEquals(await memory.known(SCOPE, para(30, "bad")), null);
  const again = await seedTree(ports, SCOPE, chunks, { concurrency: 1 });
  assertEquals(again, { total: 3, written: 0, known: 2, failed: 1 }, "the failed chunk is retried on the next run, the others cost nothing");
  assertEquals(n, 4);
});

Deno.test("seedTree: an empty tree is a no-op; concurrency above the chunk count is clamped; ports.understander errors do not leak as unhandled rejections", async () => {
  const memory = new KeywordMemory();
  const ports = { memory, ledger: new InProcessLedger(), understander: new FixedUnderstander(understood), log: new RecordingLog() };
  assertEquals(await seedTree(ports, SCOPE, [], { concurrency: 8 }), { total: 0, written: 0, known: 0, failed: 0 });
  assertEquals((await seedTree(ports, SCOPE, [{ path: "a.md", heading: "A", body: para(30) }], { concurrency: 50 })).written, 1);
});

Deno.test("walk: finds .md files recursively in a stable order, ignores everything else", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/b/inner`, { recursive: true });
    await Deno.writeTextFile(`${dir}/z.md`, "");
    await Deno.writeTextFile(`${dir}/a.MD`, "");
    await Deno.writeTextFile(`${dir}/b/notes.md`, "");
    await Deno.writeTextFile(`${dir}/b/inner/deep.md`, "");
    await Deno.writeTextFile(`${dir}/b/readme.txt`, "");
    await Deno.writeTextFile(`${dir}/image.png`, "");
    assertEquals([...walk(dir)], ["a.MD", "b/inner/deep.md", "b/notes.md", "z.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
