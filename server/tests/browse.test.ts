/**
 * The browse page and its JSON API through the real HTTP layer: the page is
 * public, the API is gated, and what it shows is exactly what the MCP tools
 * wrote, partitioned by tenant.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Hono } from "hono";
import { buildApp } from "../core/app.ts";
import type { CoreOptions, Memory, Ports } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { FixedUnderstander } from "../adapters/understanding/llm.ts";
import { OpenGate, SharedKeyGate } from "../adapters/gate.ts";
import { KeyringGate } from "../adapters/gate-more.ts";
import { NullLog, RecordingLog } from "../adapters/log.ts";
import { InProcessLedger } from "../adapters/ledger/in-process.ts";

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const OPTIONS: CoreOptions = { citationBase: "https://brain.test/t" };
const KEY = { "x-brain-key": "s3cret" };

async function rpc(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request("/mcp", { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (text.startsWith("event:") || text.includes("\ndata:")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    return JSON.parse(data!);
  }
  return JSON.parse(text);
}
const call = (app: Hono, name: string, args: Record<string, unknown>, headers?: Record<string, string>) =>
  rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
const factId = (r: { result: { content: { text: string }[] } }) => /Recorded fact (\S+) about/.exec(r.result.content[0].text)![1];

async function get(app: Hono, path: string, headers: Record<string, string> = {}, method = "GET") {
  const res = await app.request(path, { method, headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: JSON.parse(text) };
}

const understood = { type: "task" as const, topics: ["ops"], people: ["Mike"], action_items: ["ship it"], dates_mentioned: [] };
const ports = (memory: Memory, over: Partial<Ports> = {}): Ports => ({
  memory, ledger: new InProcessLedger(), understander: new FixedUnderstander(understood), gate: new OpenGate(true, "alice", "alice"), log: new NullLog(), ...over,
});
const keyed = (over: Partial<Ports> = {}) => buildApp(ports(new KeywordMemory(), { gate: new SharedKeyGate("s3cret", { tenant: "shared" }), ...over }), OPTIONS);

Deno.test("the page is served without a key at /browse and /browse/, and nowhere else", async () => {
  const app = keyed();
  for (const path of ["/browse", "/browse/", "/browse?key=wrong"]) {
    const res = await app.request(path);
    const html = await res.text();
    assertEquals(res.status, 200, path);
    assert(res.headers.get("content-type")?.startsWith("text/html"), path);
    assertStringIncludes(html.toLowerCase(), "<!doctype html>");
    assert(/^[0-9a-f-]{36}$/.test(res.headers.get("x-request-id") ?? ""), `x-request-id on ${path}`);
  }
  for (const path of ["/browsex", "/browse/index.html", "/Browse"]) {
    const res = await app.request(path);
    const body = await res.json();
    assertEquals(body.error?.code, -32001, `${path} is not the public page`);
  }
  const posted = await get(app, "/browse", {}, "POST");
  assertEquals(posted.body.error.code, -32001, "a non-GET to /browse is gated like everything else");
});

Deno.test("overview is gated; with the key it counts facts by subject and thoughts separately", async () => {
  const app = keyed();
  const denied = await get(app, "/browse/api/overview");
  assertEquals(denied.status, 200);
  assertEquals(denied.body.error.code, -32001);
  assertEquals("subjects" in denied.body, false);

  const a = factId(await call(app, "capture_thought", { content: "Acme renews on 1 March 2027", subject: "client:acme", source: "s1" }, KEY));
  const b = factId(await call(app, "capture_thought", { content: "Acme renews on 1 April 2027", subject: "client:acme", source: "s2" }, KEY));
  await call(app, "capture_thought", { content: "Zenith has 418 sites", subject: "client:zenith", source: "s3" }, KEY);
  await call(app, "capture_thought", { content: "a plain thought" }, KEY);
  await call(app, "capture_thought", { content: "another plain thought" }, KEY);

  const before = await get(app, "/browse/api/overview", KEY);
  assertEquals(before.status, 200);
  assertEquals(before.body.tenant, "shared");
  assertEquals(before.body.summary.count, 2, "thoughts, not facts");
  const rows = (body: { subjects: { subject: string; lines: number; current: number }[] }) =>
    Object.fromEntries(body.subjects.map((s) => [s.subject, { lines: s.lines, current: s.current }]));
  assertEquals(rows(before.body), { "client:acme": { lines: 2, current: 2 }, "client:zenith": { lines: 1, current: 1 } });

  await call(app, "supersede_fact", { newer_id: b, older_id: a }, KEY);
  const after = await get(app, "/browse/api/overview", KEY);
  assertEquals(rows(after.body), { "client:acme": { lines: 2, current: 1 }, "client:zenith": { lines: 1, current: 1 } });
  assertEquals(after.body.summary.count, 2, "superseding a fact changes no thought count");
});

Deno.test("history of an unknown or missing subject is an empty list, not an error", async () => {
  const app = keyed();
  await call(app, "capture_thought", { content: "known", subject: "client:known", source: "s" }, KEY);
  assertEquals((await get(app, "/browse/api/history?subject=nope", KEY)).body, { facts: [] });
  assertEquals((await get(app, "/browse/api/history", KEY)).body, { facts: [] });
  assertEquals((await get(app, "/browse/api/history?subject=", KEY)).body, { facts: [] });
  const known = await get(app, "/browse/api/history?subject=client:known", KEY);
  assertEquals(known.body.facts.length, 1);
  assertEquals(known.body.facts[0].claim, "known");
});

Deno.test("facts search hides superseded lines unless includeSuperseded is exactly 'true'", async () => {
  const app = keyed();
  const old = factId(await call(app, "capture_thought", { content: "Sam is the Acme account owner", subject: "client:acme", source: "s1" }, KEY));
  const now = factId(await call(app, "capture_thought", { content: "Lee is the Acme account owner", subject: "client:acme", source: "s2" }, KEY));
  const q = "/browse/api/facts?q=Acme+account+owner";
  assertEquals((await get(app, q, KEY)).body.facts.length, 2);

  await call(app, "supersede_fact", { newer_id: now, older_id: old }, KEY);
  const current = await get(app, q, KEY);
  assertEquals(current.body.facts.map((f: { id: string }) => f.id), [now]);
  assert(typeof current.body.facts[0].score === "number");
  for (const v of ["1", "TRUE", "yes", "True", ""]) {
    assertEquals((await get(app, `${q}&includeSuperseded=${v}`, KEY)).body.facts.length, 1, `includeSuperseded=${v}`);
  }
  const all = await get(app, `${q}&includeSuperseded=true`, KEY);
  assertEquals(all.body.facts.map((f: { id: string }) => f.id).sort(), [old, now].sort());
  assertEquals(all.body.facts.find((f: { id: string }) => f.id === old).supersededBy, now);
  assertEquals((await get(app, "/browse/api/facts", KEY)).body, { facts: [] }, "no q matches nothing");
  assertEquals((await get(app, `${q}&limit=1`, KEY)).body.facts.length, 1);
});

Deno.test("thoughts: an unknown id is null, a bad since is a 400, a bad limit is the default, a huge limit is clamped, a negative one is nothing", async () => {
  const inner = new KeywordMemory();
  const limits: number[] = [];
  const memory: Memory = { ...inner, isolation: inner.isolation, remember: inner.remember.bind(inner), known: inner.known.bind(inner), get: inner.get.bind(inner), summary: inner.summary.bind(inner),
    recall: (s, q, o) => { limits.push(o.limit); return inner.recall(s, q, o); },
    recent: (s, q) => { limits.push(q.limit); return inner.recent(s, q); } };
  const app = buildApp(ports(memory, { gate: new SharedKeyGate("s3cret", { tenant: "shared" }) }), OPTIONS);
  for (const w of ["one", "two", "three"]) await call(app, "capture_thought", { content: `thought ${w}` }, KEY);
  assertEquals((await get(app, "/browse/api/thought?id=nonsense", KEY)).body, { thought: null });
  assertEquals((await get(app, "/browse/api/thought", KEY)).body, { thought: null });

  const bad = await get(app, "/browse/api/thoughts?since=not-a-date", KEY);
  assertEquals(bad.status, 400);
  assertStringIncludes(bad.body.error, "since");
  assertEquals((await get(app, "/browse/api/thoughts?since=", KEY)).body.thoughts.length, 3, "a blank since is no filter");
  assertEquals((await get(app, "/browse/api/thoughts?since=2000-01-01T00:00:00Z", KEY)).body.thoughts.length, 3);
  assertEquals((await get(app, "/browse/api/thoughts?since=2999-01-01T00:00:00Z", KEY)).body.thoughts.length, 0);

  const table: [string, number, number][] = [
    ["abc", 200, 3], ["", 200, 3], ["99999", 2000, 3], ["2", 2, 2], ["2.9", 2, 2], ["0", 0, 0], ["-5", 0, 0],
    ["Infinity", 200, 3], ["-Infinity", 200, 3], ["1e1", 1, 1], ["5abc", 5, 3], ["%207%20", 7, 3], ["0x10", 0, 0],
  ];
  for (const [limit, passed, returned] of table) {
    limits.length = 0;
    const r = await get(app, `/browse/api/thoughts?limit=${limit}`, KEY);
    assertEquals(r.status, 200, `limit=${limit}`);
    assertEquals(limits, [passed], `the port sees limit=${limit} as`);
    assertEquals(r.body.thoughts.length, returned, `limit=${limit}`);
  }
  assertEquals((await get(app, "/browse/api/thoughts?type=task", KEY)).body.thoughts.length, 3);
  assertEquals((await get(app, "/browse/api/thoughts?type=idea", KEY)).body.thoughts.length, 0);
  assertEquals((await get(app, "/browse/api/thoughts?person=Nobody", KEY)).body.thoughts.length, 0);
  assertEquals((await get(app, "/browse/api/thoughts?topic=nothing", KEY)).body.thoughts.length, 0);
  assertEquals((await get(app, "/browse/api/thoughts?type=&person=Mike&topic=", KEY)).body.thoughts.length, 3, "blank filters are dropped, set ones apply");
  assertEquals((await get(app, "/browse/api/thoughts?type=&person=Mike&topic=ops", KEY)).body.thoughts.length, 3);
  const recalled = await get(app, "/browse/api/recall?q=thought+two&limit=1", KEY);
  assertEquals(recalled.body.thoughts.length, 1);
  assertEquals(recalled.body.thoughts[0].content, "thought two");
  limits.length = 0;
  assertEquals((await get(app, "/browse/api/recall?limit=0&q=thought", KEY)).body, { thoughts: [] });
  await get(app, "/browse/api/recall?limit=9999&q=thought", KEY);
  await get(app, "/browse/api/recall?q=thought", KEY);
  assertEquals(limits, [0, 500, 50], "recall has its own default and ceiling");
});

Deno.test("the wrong method is a 405 and an unknown route is a 404, including prototype names", async () => {
  const app = keyed();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await get(app, "/browse/api/overview", KEY, method);
    assertEquals(r.status, 405, method);
    assertEquals(r.headers.get("allow"), "GET", method);
    assert(typeof r.body.error === "string");
  }
  const head = await app.request("/browse/api/overview", { method: "HEAD", headers: KEY });
  await head.text();
  assertEquals(head.status, 405, "GET only means GET only");
  for (const path of ["/browse/api/nope", "/browse/api", "/browse/api/", "/browse/api/overview/", "/browse/api/Overview", "/browse/apiconstructor", "/browse/api/constructor", "/browse/api/__proto__", "/browse/api/toString"]) {
    const r = await get(app, path, KEY);
    assertEquals(r.status, 404, path);
    assert(typeof r.body.error === "string", path);
  }
});

Deno.test("two keys, two tenants: one tenant's facts are invisible to the other", async () => {
  const app = buildApp(ports(new KeywordMemory(), { gate: new KeyringGate("ka=alpha:a,kb=beta:b") }), OPTIONS);
  const ka = { "x-brain-key": "ka" }, kb = { "x-brain-key": "kb" };
  await call(app, "capture_thought", { content: "alpha only", subject: "client:alpha", source: "s" }, ka);
  await call(app, "capture_thought", { content: "alpha thought" }, ka);

  const asAlpha = await get(app, "/browse/api/overview", ka);
  assertEquals(asAlpha.body.tenant, "alpha");
  assertEquals(asAlpha.body.subjects.length, 1);
  assertEquals(asAlpha.body.summary.count, 1);
  const asBeta = await get(app, "/browse/api/overview", kb);
  assertEquals(asBeta.body.tenant, "beta");
  assertEquals(asBeta.body.subjects, []);
  assertEquals(asBeta.body.summary.count, 0);
  assertEquals((await get(app, "/browse/api/history?subject=client:alpha", kb)).body, { facts: [] });
  assertEquals((await get(app, "/browse/api/facts?q=alpha+only", kb)).body, { facts: [] });
  assertEquals((await get(app, "/browse/api/thoughts", kb)).body, { thoughts: [] });
  assertEquals((await get(app, "/browse/api/recall?q=alpha+thought", kb)).body, { thoughts: [] });
  const alphaThought = (await get(app, "/browse/api/thoughts", ka)).body.thoughts[0].id;
  const alphaFact = asAlpha.body.subjects[0].subject;
  assertEquals((await get(app, `/browse/api/thought?id=${alphaThought}`, ka)).body.thought.content, "alpha thought");
  assertEquals((await get(app, `/browse/api/thought?id=${alphaThought}`, kb)).body, { thought: null }, "a real id from another tenant is unknown");
  assertEquals((await get(app, `/browse/api/facts?q=alpha+only&includeSuperseded=true`, kb)).body, { facts: [] });
  assertEquals((await get(app, `/browse/api/history?subject=${alphaFact}`, kb)).body, { facts: [] });
  assertEquals((await get(app, "/browse/api/overview", { "x-brain-key": "kc" })).body.error.code, -32001);
});

Deno.test("browse.called is logged with the route, tenant, actor and the request id; a 404 is not a call", async () => {
  const log = new RecordingLog();
  const app = keyed({ log });
  const res = await app.request("/browse/api/overview", { headers: { ...KEY, "x-brain-actor": "owner" } });
  await res.text();
  const ev = log.events.find((e) => e.event === "browse.called");
  assert(ev, "browse.called was logged");
  assertEquals(ev.fields?.route, "/overview");
  assertEquals(ev.fields?.tenant, "shared");
  assertEquals(ev.fields?.actor, "owner");
  assertEquals(ev.fields?.requestId, res.headers.get("x-request-id"));
  await get(app, "/browse/api/thoughts?since=bad", KEY);
  assertEquals(log.events.filter((e) => e.event === "browse.called").pop()?.fields?.route, "/thoughts", "a failing call is still audited");
  const failed = log.events.find((e) => e.event === "browse.failed");
  assert(failed, "a failing call is logged as failed, like the tools");
  assertEquals(failed.fields?.route, "/thoughts");
  assertEquals(failed.fields?.tenant, "shared");
  assertStringIncludes((failed.err as Error).message, "since");
  await get(app, "/browse/api/nope", KEY);
  await get(app, "/browse/api/overview");
  await get(app, "/browse/api/overview", KEY, "POST");
  assertEquals(log.events.filter((e) => e.event === "browse.called").length, 2, "a 404, a denial and a 405 are not calls");
  assertEquals(log.events.filter((e) => e.event === "browse.failed").length, 1);
});

Deno.test("every API response is JSON with the CORS origin, whatever the outcome", async () => {
  const app = keyed();
  const cases: [string, Record<string, string>, string, number][] = [
    ["/browse/api/overview", KEY, "GET", 200],
    ["/browse/api/overview", {}, "GET", 200],
    ["/browse/api/nope", KEY, "GET", 404],
    ["/browse/api/overview", KEY, "POST", 405],
    ["/browse/api/thoughts?since=bad", KEY, "GET", 400],
  ];
  for (const [path, headers, method, status] of cases) {
    const r = await get(app, path, headers, method);
    assertEquals(r.status, status, `${method} ${path}`);
    assert(r.headers.get("content-type")?.startsWith("application/json"), `${method} ${path}`);
    assertEquals(r.headers.get("access-control-allow-origin"), "*", `${method} ${path}`);
  }
});
