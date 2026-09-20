/**
 * The gates, through the real HTTP + MCP stack. Two agents on one server
 * must not see each other; a proxy-asserted identity must not be forgeable
 * from a tool argument; a denial must be a JSON-RPC error, never a bare 4xx
 * that a strict MCP host treats as a dead transport.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { Hono } from "hono";
import { buildApp } from "../core/app.ts";
import type { CoreOptions, Ports } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { InProcessLedger } from "../adapters/ledger/in-process.ts";
import { NullUnderstander } from "../adapters/understanding/llm.ts";
import { RecordingLog } from "../adapters/log.ts";
import { DenyAllGate, KeyringGate, TrustedHeadersGate } from "../adapters/gate-more.ts";

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const OPTIONS: CoreOptions = { citationBase: "https://brain.test/t" };

async function rpc(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request("/mcp", { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.includes("\ndata:") || text.startsWith("event:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()! : text;
  return { status: res.status, headers: res.headers, body: JSON.parse(data) };
}
const call = (app: Hono, id: number, name: string, args: Record<string, unknown>, headers?: Record<string, string>) =>
  rpc(app, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, headers);

const build = (gate: Ports["gate"], log = new RecordingLog()) => {
  const memory = new KeywordMemory();
  return { app: buildApp({ memory, ledger: new InProcessLedger(), understander: new NullUnderstander(), gate, log }, OPTIONS), log };
};

// ---------- KeyringGate ----------

Deno.test("[keyring] spec parsing refuses malformed, duplicate and unsafe entries", () => {
  assertThrows(() => new KeyringGate(""), Error, "at least one key");
  assertThrows(() => new KeyringGate("k1=alpha"), Error, "key=tenant:actor");
  assertThrows(() => new KeyringGate("k1=alpha:"), Error, "key=tenant:actor");
  assertThrows(() => new KeyringGate("=alpha:a"), Error, "key=tenant:actor");
  assertThrows(() => new KeyringGate("k1=alpha:a,k1=beta:b"), Error, "twice");
  assertThrows(() => new KeyringGate("k1=../x:a"), Error, "must match");
  assertEquals(KeyringGate.parse("k1=alpha:agent-a, k2=beta:agent-b").map((e) => e.scope), [{ tenant: "alpha", actor: "agent-a" }, { tenant: "beta", actor: "agent-b" }]);
  assertEquals(KeyringGate.parse("k=t:with:colons").map((e) => e.scope), [{ tenant: "t:with", actor: "colons" }], "the last colon splits tenant from actor");
});

Deno.test("[keyring] C3: two agents, two keys, one server — B sees nothing of A, and fetch by A's id is not-found, not an error", async () => {
  const { app } = build(new KeyringGate("ka=alpha:agent-a,kb=beta:agent-b"));
  const A = { "x-brain-key": "ka" };
  const B = { "x-brain-key": "kb" };
  const captured = await call(app, 1, "capture_thought", { content: "Alpha's secret: the renewal price is R4.2m", subject: "client:alpha", source: "test" }, A);
  assertEquals(captured.status, 200);
  const idA = /fact ([^\s]+) about/.exec(captured.body.result.content[0].text)?.[1];
  assert(idA, captured.body.result.content[0].text);

  const bSearch = await call(app, 2, "find_facts", { query: "renewal price", threshold: 0 }, B);
  assertStringIncludes(bSearch.body.result.content[0].text, "No facts found");
  const bThoughts = await call(app, 3, "search_thoughts", { query: "renewal price", threshold: 0 }, B);
  assertStringIncludes(bThoughts.body.result.content[0].text, "No thoughts found");
  const bFetch = await call(app, 4, "fetch", { id: idA }, B);
  assertEquals(bFetch.body.result.isError, true);
  assertStringIncludes(bFetch.body.result.content[0].text, "no thought with id");
  const bStats = await call(app, 5, "thought_stats", {}, B);
  assertStringIncludes(bStats.body.result.content[0].text, "Total thoughts: 0");

  const aAgain = await call(app, 6, "find_facts", { query: "renewal price", threshold: 0 }, A);
  assertStringIncludes(aAgain.body.result.content[0].text, "Found 1 fact(s)");
});

Deno.test("[keyring] the actor header narrows who is writing but can never move the tenant", async () => {
  const { app, log } = build(new KeyringGate("ka=alpha:agent-a,kb=beta:agent-b"));
  await call(app, 1, "capture_thought", { content: "written by a named session", subject: "s", source: "t" }, { "x-brain-key": "ka", "x-brain-actor": "session:123" });
  await call(app, 2, "capture_thought", { content: "attempt to hop tenants", subject: "s", source: "t" }, { "x-brain-key": "ka", "x-brain-actor": "agent-b", "x-tenant": "beta" });
  const asserted = log.events.filter((e) => e.event === "fact.asserted");
  assertEquals(asserted.map((e) => e.fields?.actor), ["session:123", "agent-b"]);
  assertEquals(asserted.map((e) => e.fields?.tenant), ["alpha", "alpha"]);
  const beta = await call(app, 3, "fact_history", { subject: "s" }, { "x-brain-key": "kb" });
  assertStringIncludes(beta.body.result.content[0].text, "No facts");
});

Deno.test("[keyring] wrong key, missing key, and key in the query string when that is off", async () => {
  const { app, log } = build(new KeyringGate("ka=alpha:agent-a"));
  const attempts: Record<string, string>[] = [{}, { "x-brain-key": "kb" }, { "x-brain-key": "kA" }];
  for (const headers of attempts) {
    const r = await call(app, 1, "thought_stats", {}, headers);
    assertEquals(r.status, 200, "denial rides a 200 so strict MCP hosts keep the transport");
    assertEquals(r.body.error?.code, -32001);
  }
  const viaQuery = await app.request("/mcp?key=ka", { method: "POST", headers: HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "thought_stats", arguments: {} } }) });
  assertEquals((await viaQuery.json()).error?.code, -32001, "query-string keys are off by default for a keyring");
  assert(log.events.filter((e) => e.event === "gate.denied").length >= 4);
});

// ---------- TrustedHeadersGate ----------

Deno.test("[trusted-headers] C4: without the gateway secret the identity headers are ignored and a challenge names the header", async () => {
  const { app } = build(new TrustedHeadersGate("s3cret"));
  const forged = await call(app, 1, "thought_stats", {}, { "x-tenant": "alpha", "x-actor": "me" });
  assertEquals(forged.status, 401);
  assertEquals(forged.body.error?.code, -32001);
  assertStringIncludes(forged.headers.get("WWW-Authenticate") ?? "", "x-gateway-secret");
  const wrong = await call(app, 2, "thought_stats", {}, { "x-gateway-secret": "s3cre", "x-tenant": "alpha", "x-actor": "me" });
  assertEquals(wrong.status, 401);
});

Deno.test("[trusted-headers] C4: with the secret, tenant and actor come from the headers and partition the brain", async () => {
  const { app, log } = build(new TrustedHeadersGate("s3cret"));
  const alpha = { "x-gateway-secret": "s3cret", "x-tenant": "alpha", "x-actor": "sam@example.com" };
  const beta = { "x-gateway-secret": "s3cret", "x-tenant": "beta", "x-actor": "svc:agent-2" };
  await call(app, 1, "capture_thought", { content: "alpha only", subject: "s", source: "t" }, alpha);
  assertStringIncludes((await call(app, 2, "fact_history", { subject: "s" }, beta)).body.result.content[0].text, "No facts");
  assertStringIncludes((await call(app, 3, "fact_history", { subject: "s" }, alpha)).body.result.content[0].text, "by sam@example.com");
  assertEquals(log.events.find((e) => e.event === "fact.asserted")?.fields?.tenant, "alpha");
  const bad = await call(app, 4, "thought_stats", {}, { "x-gateway-secret": "s3cret", "x-tenant": "../alpha", "x-actor": "x" });
  assertEquals(bad.body.error?.code, -32001, "an unsafe tenant name is refused even with the secret");
});

// ---------- DenyAllGate ----------

Deno.test("[deny-all] C9: every tool call is a JSON-RPC -32001 in a 200 body with one gate.denied log line each; tools/list too", async () => {
  const { app, log } = build(new DenyAllGate());
  const names = ["capture_thought", "search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "find_facts", "fact_history", "confirm_fact", "supersede_fact"];
  for (const [i, name] of names.entries()) {
    const r = await call(app, i + 1, name, {}, { "x-brain-key": "anything" });
    assertEquals(r.status, 200, name);
    assertEquals(r.body.error?.code, -32001, name);
    assertEquals(r.body.id, i + 1, "the JSON-RPC id is echoed so the client can match the error");
  }
  const list = await rpc(app, { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
  assertEquals(list.body.error?.code, -32001);
  assertEquals(log.events.filter((e) => e.event === "gate.denied").length, names.length + 1);
});
