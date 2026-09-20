/**
 * compose() refuses a bad configuration at start, with a plain message, so
 * nothing is discovered at the first request. Composed offline: keyword
 * memory, no network call is made by construction.
 */
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { assertCompatible, compose } from "../compose.ts";
import { MapSettings } from "../adapters/settings.ts";
import { RecordingLog } from "../adapters/log.ts";

const base = { OB_MEMORY: "keyword", MCP_ACCESS_KEY: "k", EMBEDDING_API_KEY: "emb-key", EMBEDDING_API_BASE: "http://localhost:11434/v1" };
const settings = (over: Record<string, string>) => new MapSettings({ ...base, ...over });
const refused = async (over: Record<string, string>, ...needles: string[]) => {
  const err = await assertRejects(() => compose(settings(over), new RecordingLog()), Error);
  for (const n of needles) assertStringIncludes(err.message, n);
};

Deno.test("compose: EMBEDDING_DIMENSIONS must be a whole number greater than zero", async () => {
  for (const bad of ["abc", "0", "-768", "768.5", "1e3", " ", "768px"]) await refused({ EMBEDDING_DIMENSIONS: bad }, "EMBEDDING_DIMENSIONS", "whole number");
  const { ports } = await compose(settings({ EMBEDDING_DIMENSIONS: "768" }), new RecordingLog());
  assert(ports.memory);
});

Deno.test("compose: a chat host different from the embedding host needs its own key; the embedding key is never reused across hosts", async () => {
  await refused({ CHAT_API_BASE: "https://api.anthropic.com/v1" }, "CHAT_API_KEY", "api.anthropic.com", "localhost:11434");
  await refused({ CHAT_API_BASE: "https://LOCALHOST:11435/v1" }, "CHAT_API_KEY");
  await compose(settings({ CHAT_API_BASE: "https://api.anthropic.com/v1", CHAT_API_KEY: "chat-key" }), new RecordingLog());
  await compose(settings({ CHAT_API_BASE: "http://LOCALHOST:11434/v1/" }), new RecordingLog());
  await compose(settings({}), new RecordingLog());
});

Deno.test("compose: a chat or embedding base that is not a URL is refused by name", async () => {
  await refused({ CHAT_API_BASE: "not a url" }, "not a valid URL");
});

Deno.test("compose: unknown memory or model kinds are refused, never silently defaulted", async () => {
  await refused({ OB_MEMORY: "cosmos" }, "OB_MEMORY", "cosmos");
  await refused({ OB_MODELS: "bedrock" }, "OB_MODELS", "bedrock");
});

Deno.test("compose: a missing access key is refused at start", async () => {
  await refused({ MCP_ACCESS_KEY: "" }, "MCP_ACCESS_KEY");
});

Deno.test("compose: a memory that ignores the tenant is refused behind a gate that admits many tenants, and allowed behind a single-tenant one", async () => {
  let msg = "";
  try {
    assertCompatible({ isolation: "none" }, { tenants: "many" });
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "does not partition by tenant");
  assertCompatible({ isolation: "none" }, { tenants: "one" });
  assertCompatible({ isolation: "tenant" }, { tenants: "many" });
  assertCompatible({ isolation: "tenant" }, { tenants: "one" });
  // The shipped limbs declare what they are; the vector memory says so itself.
  const { ports } = await compose(settings({ OB_MEMORY: "vector" }), new RecordingLog());
  assert(ports.memory.isolation === "none" && ports.gate.tenants === "one");
  const kw = await compose(settings({}), new RecordingLog());
  assert(kw.ports.memory.isolation === "tenant");
});

Deno.test("compose: OB_TENANT names the tenant every caller of this instance lands in", async () => {
  const { ports } = await compose(settings({ OB_TENANT: "personal" }), new RecordingLog());
  const d = await ports.gate.authorise(new Request("https://h/mcp", { headers: { "x-brain-key": "k" } }));
  assert(d.allowed && d.tenant === "personal");
  const dflt = await (await compose(settings({}), new RecordingLog())).ports.gate.authorise(new Request("https://h/mcp", { headers: { "x-brain-key": "k" } }));
  assert(dflt.allowed && dflt.tenant === "default");
});
