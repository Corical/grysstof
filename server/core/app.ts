/**
 * The core. Six MCP tools and the HTTP layer, behaviour as upstream.
 * Imports its needs as ports; never a vendor, never the environment, never
 * the network. Guarded by tests/architecture.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { CoreOptions, Fact, Ports, Scope } from "./ports/mod.ts";
import { capture } from "./capture.ts";
import { BROWSE_PAGE } from "./browse-page.ts";
import { browseApi } from "./browse.ts";

/**
 * ISO 8601 date (YYYY-MM-DD): unambiguous in every locale, sorts as text.
 * A memory may hand back a blank or unparsable timestamp (nullable column,
 * hand-migrated row); one bad row must not fail a whole listing.
 */
export const day = (iso: string | null | undefined): string => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? "unknown-date" : new Date(t).toISOString().slice(0, 10);
};

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? day(createdAt) : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(base: string, id: string): string {
  return `${base.replace(/\/$/, "")}/${id}`;
}

/**
 * Stored content and model-derived strings are rendered so they can never be
 * mistaken for the server's own framing: every content line is indented,
 * so a fact containing "--- Result 2 ---" at column 0 shows as text inside
 * result 1; topics, people and actions lose their line breaks.
 */
const INDENT = "  ";
const quote = (content: string) => content.split(/\r?\n/).map((l) => INDENT + l).join("\n");
const oneLine = (s: unknown) => String(s).replace(/\s+/g, " ").trim();
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(oneLine).filter(Boolean) : []);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const message = (err: unknown) => (err as Error)?.message ?? String(err);

/** Every line this log writes carries the given fields (a request id, say). */
export function withFields(log: Ports["log"], fields: Record<string, unknown>): Ports["log"] {
  return {
    info: (e, f) => log.info(e, { ...fields, ...(f ?? {}) }),
    warn: (e, f) => log.warn(e, { ...fields, ...(f ?? {}) }),
    error: (e, f, err) => log.error(e, { ...fields, ...(f ?? {}) }, err),
  };
}

export function buildServer(ports: Ports, options: CoreOptions, scope: Scope): McpServer {
  const { memory, ledger, log } = ports;
  const server = new McpServer({ name: "open-brain", version: "1.0.0" });
  // Reads are audited too: who asked which tool, under which request.
  const called = (tool: string) => log.info("tool.called", { tool, tenant: scope.tenant, actor: scope.actor });

  // ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
  // research look for exact read-only `search` and `fetch` tool shapes.
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
      annotations: { readOnlyHint: true },
      inputSchema: { query: z.string().describe("The search query to run against Open Brain thoughts") },
    },
    async ({ query }) => {
      try {
        called("search");
        const found = await memory.recall(scope, query, { limit: 10, minScore: 0.5 });
        const results = found.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.createdAt),
          url: thoughtUrl(options.citationBase, t.id),
        }));
        return text(JSON.stringify({ results }));
      } catch (err) {
        log.error("tool.search.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Search error: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description:
        "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.string().describe("The Open Brain thought ID returned by the search tool") },
    },
    async ({ id }) => {
      try {
        called("fetch");
        const thought = await memory.get(scope, id);
        if (!thought) return failure(`Fetch error: no thought with id ${id}`);
        const document = {
          id: thought.id,
          title: thoughtTitle(thought.content, thought.createdAt),
          text: thought.content,
          url: thoughtUrl(options.citationBase, thought.id),
          metadata: { ...thought.metadata, created_at: thought.createdAt, updated_at: thought.updatedAt },
        };
        return text(JSON.stringify(document));
      } catch (err) {
        log.error("tool.fetch.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Fetch error: ${message(err)}`);
      }
    },
  );

  // Tool 1: Semantic Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().int().min(1).max(100).optional().default(10),
        threshold: z.number().min(0).max(1).optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        called("search_thoughts");
        const found = await memory.recall(scope, query, { limit, minScore: threshold });
        if (found.length === 0) return text(`No thoughts found matching "${query}".`);
        const results = found.map((t, i) => {
          const m = t.metadata || {};
          const topics = list(m.topics), people = list(m.people), actions = list(m.action_items);
          const parts = [
            `--- Result ${i + 1} (${(t.score * 100).toFixed(1)}% match) ---`,
            `Captured: ${day(t.createdAt)}`,
            `Type: ${oneLine(m.type || "unknown")}`,
          ];
          if (topics.length) parts.push(`Topics: ${topics.join(", ")}`);
          if (people.length) parts.push(`People: ${people.join(", ")}`);
          if (actions.length) parts.push(`Actions: ${actions.join("; ")}`);
          parts.push(`\n${quote(t.content)}`);
          return parts.join("\n");
        });
        return text(`Found ${found.length} thought(s):\n\n${results.join("\n\n")}`);
      } catch (err) {
        log.error("tool.search_thoughts.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Search error: ${message(err)}`);
      }
    },
  );

  // Tool 2: List Recent
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description: "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().int().min(1).optional().describe("Only thoughts from the last N days"),
      },
    },
    async ({ limit, type, topic, person, days }) => {
      try {
        called("list_thoughts");
        let since: string | undefined;
        if (days !== undefined) {
          const d = new Date();
          d.setDate(d.getDate() - days);
          since = d.toISOString();
        }
        const found = await memory.recent(scope, { limit, type, topic, person, since });
        if (!found.length) return text("No thoughts found.");
        const results = found.map((t, i) => {
          const m = t.metadata || {};
          const tags = list(m.topics).join(", ");
          return `${i + 1}. [${day(t.createdAt)}] (${oneLine(m.type || "??")}${tags ? " - " + tags : ""})\n${quote(t.content)}`;
        });
        return text(`${found.length} recent thought(s):\n\n${results.join("\n\n")}`);
      } catch (err) {
        log.error("tool.list_thoughts.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Error: ${message(err)}`);
      }
    },
  );

  // Tool 3: Stats
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        called("thought_stats");
        const s = await memory.summary(scope);
        const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const lines: string[] = [
          `Total thoughts: ${s.count}`,
          `Date range: ${
            s.oldest && s.newest
              ? day(s.oldest) + " → " + day(s.newest)
              : "N/A"
          }`,
          "",
          "Types:",
          ...top(s.types).map(([k, v]) => `  ${k}: ${v}`),
        ];
        if (Object.keys(s.topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of top(s.topics)) lines.push(`  ${k}: ${v}`);
        }
        if (Object.keys(s.people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of top(s.people)) lines.push(`  ${k}: ${v}`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        log.error("tool.thought_stats.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Error: ${message(err)}`);
      }
    },
  );

  // Tool 4: Capture Thought
  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        content: z.string().min(1).describe(
          "The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI",
        ),
        source: z.string().max(300).optional().describe(
          "Where this was learned: a session id, a ticket, a file, a URL. Defaults to \"mcp\".",
        ),
        subject: z.string().max(300).optional().describe(
          "What the content is a fact about (e.g. \"client:acme\", \"person:sam\", \"repo:dataservice\"). When given, the content is recorded as a fact in the ledger: a new line every time, never merged, older lines kept.",
        ),
        proof: z.string().max(1000).optional().describe("A link to the evidence for the fact."),
        occurred_at: z.string().max(40).optional().describe(
          "When this actually happened, ISO 8601, for importing history. The thought is dated to it instead of to now.",
        ),
      },
    },
    async ({ content, source, subject, proof, occurred_at }) => {
      try {
        called("capture_thought");
        const done = await capture(ports, scope, { content, source, subject, proof, occurredAt: occurred_at });
        const { understood } = done;
        let confirmation = done.kind === "fact"
          ? `Recorded fact ${done.id} about ${done.fact.subject} (from ${done.fact.source}, by ${done.fact.learnedBy}, unconfirmed)`
          : `Captured as ${understood.type || "thought"}`;
        if (done.kind === "thought" && understood.topics.length) confirmation += ` — ${understood.topics.join(", ")}`;
        if (understood.people.length) confirmation += ` | People: ${understood.people.join(", ")}`;
        if (understood.action_items.length) confirmation += ` | Actions: ${understood.action_items.join("; ")}`;
        return text(confirmation);
      } catch (err) {
        log.error("tool.capture_thought.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Failed to capture: ${message(err)}`);
      }
    },
  );

  // --- The ledger's own verbs. Facts are append-only lines with provenance. ---

  const renderFact = (f: Fact, score?: number) => {
    const head = [
      `--- Fact ${f.id}${score !== undefined ? ` (${(score * 100).toFixed(1)}% match)` : ""} ---`,
      `Subject: ${oneLine(f.subject)}`,
      `Learned: ${f.learnedAt} by ${oneLine(f.learnedBy)}`,
      ...(f.occurredAt ? [`Occurred: ${f.occurredAt}`] : []),
      `Source: ${oneLine(f.source)}`,
    ];
    if (f.proof) head.push(`Proof: ${oneLine(f.proof)}`);
    head.push(`Status: ${f.confirmed ? `confirmed by ${oneLine(f.confirmedBy ?? "")} at ${f.confirmedAt}` : "unconfirmed"}${f.supersededBy ? `, SUPERSEDED by ${f.supersededBy}` : ""}${f.supersedes ? `, supersedes ${f.supersedes}` : ""}`);
    if (f.tags.length) head.push(`Tags: ${f.tags.map(oneLine).join(", ")}`);
    return [...head, "", quote(f.claim)].join("\n");
  };

  server.registerTool(
    "find_facts",
    {
      title: "Find Facts",
      description:
        "Search the fact ledger by meaning. Returns the current facts (newest wins; superseded lines left out unless asked), each with subject, who learned it, when, from where, and whether a person has confirmed it.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().describe("What to look for, in plain words"),
        subject: z.string().optional().describe("Only facts about this subject"),
        limit: z.number().int().min(1).max(100).optional().default(10),
        threshold: z.number().min(0).max(1).optional().default(0.5),
        include_superseded: z.boolean().optional().default(false).describe("Also return lines that a newer fact has replaced"),
        confirmed_only: z.boolean().optional().default(false).describe("Only facts a person has confirmed"),
      },
    },
    async ({ query, subject, limit, threshold, include_superseded, confirmed_only }) => {
      try {
        called("find_facts");
        const found = await ledger.find(scope, query, { limit, minScore: threshold, subject, includeSuperseded: include_superseded, confirmedOnly: confirmed_only });
        if (!found.length) return text(`No facts found matching "${query}".`);
        return text(`Found ${found.length} fact(s):\n\n${found.map((f) => renderFact(f, f.score)).join("\n\n")}`);
      } catch (err) {
        log.error("tool.find_facts.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Find error: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "fact_history",
    {
      title: "Fact History",
      description: "Everything ever recorded about one subject, newest first, superseded lines included and marked. The first line that is not superseded is the current fact.",
      annotations: { readOnlyHint: true },
      inputSchema: { subject: z.string().describe("The subject exactly as it was recorded") },
    },
    async ({ subject }) => {
      try {
        called("fact_history");
        const lines = await ledger.history(scope, subject);
        if (!lines.length) return text(`No facts recorded about "${subject}".`);
        const current = lines.find((f) => !f.supersededBy);
        return text(`${lines.length} line(s) about ${subject}; current: ${current ? current.id : "none (all superseded)"}\n\n${lines.map((f) => renderFact(f)).join("\n\n")}`);
      } catch (err) {
        log.error("tool.fact_history.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`History error: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "confirm_fact",
    {
      title: "Confirm Fact",
      description: "Mark a fact as confirmed by the caller. Agent-written facts are usable but unconfirmed until a person does this.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: { id: z.string().describe("The fact id") },
    },
    async ({ id }) => {
      try {
        called("confirm_fact");
        const f = await ledger.confirm(scope, id);
        return text(`Fact ${f.id} confirmed by ${f.confirmedBy} at ${f.confirmedAt}`);
      } catch (err) {
        log.error("tool.confirm_fact.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Confirm error: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "supersede_fact",
    {
      title: "Supersede Fact",
      description: "Declare that one recorded fact replaces an older one about the same subject. Nothing is deleted: the older line stays in history, marked superseded.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        newer_id: z.string().describe("The fact that is now current"),
        older_id: z.string().describe("The fact it replaces"),
      },
    },
    async ({ newer_id, older_id }) => {
      try {
        called("supersede_fact");
        const f = await ledger.supersede(scope, newer_id, older_id);
        return text(`Fact ${f.id} now supersedes ${older_id}`);
      } catch (err) {
        log.error("tool.supersede_fact.failed", { tenant: scope.tenant, actor: scope.actor }, err);
        return failure(`Supersede error: ${message(err)}`);
      }
    },
  );

  return server;
}

// --- HTTP layer: gate, CORS, MCP transport ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const withCors = (response: Response): Response => {
  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  return response;
};

// -32001 is the conventional MCP "Unauthorized" JSON-RPC code. Returned with
// HTTP 200 because strict MCP hosts treat bare 4xx as transport failures and
// drop the connection instead of surfacing the error.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

async function readBodyText(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return null;
  try {
    return await req.text();
  } catch {
    return null;
  }
}

function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) return id;
    }
  } catch {
    // malformed body
  }
  return null;
}

function unauthorizedResponse(id: string | number | null, challenge?: { status: number; headers: Record<string, string> }): Response {
  const body = { jsonrpc: "2.0", error: { code: JSON_RPC_UNAUTHORIZED_CODE, message: UNAUTHORIZED_MESSAGE }, id };
  return new Response(JSON.stringify(body), {
    status: challenge?.status ?? 200,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...(challenge?.headers ?? {}) },
  });
}

/** A log that cannot take the core down, whatever was plugged in. */
function guarded(log: Ports["log"]): Ports["log"] {
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // the Log port promises never to throw; if an implementation does, the core does not care
    }
  };
  return {
    info: (e, f) => safe(() => log.info(e, f)),
    warn: (e, f) => safe(() => log.warn(e, f)),
    error: (e, f, err) => safe(() => log.error(e, f, err)),
  };
}

export function buildApp(rawPorts: Ports, options: CoreOptions): Hono {
  const ports: Ports = { ...rawPorts, log: guarded(rawPorts.log) };
  const app = new Hono();

  // CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
  app.options("*", (c) => c.text("ok", 200, corsHeaders));

  app.all("*", async (c) => {
    // One id per request, minted here (never taken from the caller), on every log line and on the response.
    const requestId = crypto.randomUUID();
    const log = withFields(ports.log, { requestId });
    const path = new URL(c.req.url).pathname;
    const stamp = (res: Response) => {
      res.headers.set("x-request-id", requestId);
      return res;
    };
    // The page itself is public; everything it fetches goes through the gate.
    if (c.req.method === "GET" && (path === "/browse" || path === "/browse/")) {
      return stamp(new Response(BROWSE_PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } }));
    }
    try {
      const decision = await ports.gate.authorise(new Request(c.req.raw.url, { method: c.req.raw.method, headers: c.req.raw.headers }));
      if (!decision.allowed) {
        log.warn("gate.denied", { path, source: sourceOf(c.req.raw.headers, c.env) });
        const bodyText = await readBodyText(c.req.raw);
        return stamp(unauthorizedResponse(extractJsonRpcId(bodyText), decision.challenge));
      }
      return stamp(await serve(c, { ...ports, log }, options, { tenant: decision.tenant, actor: decision.actor }));
    } catch (err) {
      log.error("http.failed", { path }, err);
      return stamp(new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }));
    }
  });

  return app;
}

/** Where a request came from: the first forwarded hop, else the socket, else unknown. */
function sourceOf(headers: Headers, env: unknown): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const addr = (env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr?.hostname;
  return addr ? String(addr) : "unknown";
}

async function serve(c: Context, ports: Ports, options: CoreOptions, scope: Scope): Promise<Response> {
    if (new URL(c.req.url).pathname.startsWith("/browse/api")) return withCors(await browseApi(c.req.raw, ports, scope));

    // Claude Desktop connectors don't send the Accept header that
    // StreamableHTTPTransport requires. Build a patched request if missing.
    // See: https://github.com/NateBJones-Projects/OB1/issues/33
    if (!c.req.header("accept")?.includes("text/event-stream")) {
      const headers = new Headers(c.req.raw.headers);
      headers.set("Accept", "application/json, text/event-stream");
      const patched = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers,
        body: c.req.raw.body,
        // @ts-ignore -- duplex required for streaming body in Deno
        duplex: "half",
      });
      Object.defineProperty(c.req, "raw", { value: patched, writable: true });
    }

    const server = buildServer(ports, options, scope);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(c);
    if (!response) {
      ports.log.error("http.no_response", { tenant: scope.tenant, actor: scope.actor });
      return c.json({ error: "No response from MCP transport" }, 500, corsHeaders);
    }
    response.headers.delete("mcp-session-id");
    return withCors(response);
}
