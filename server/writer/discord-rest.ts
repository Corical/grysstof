/**
 * The one HTTP path the loops assistant (writer/discord-pa.ts) uses, for Discord and for Grysstof
 * alike: every call is cut after 20 seconds, a 429 is waited out as the server asks, and failures
 * come back as two error types the caller can tell apart (TimeoutError: no answer, so the outcome
 * is unknown; HttpError: an answer with a status). The capture bot's own `rest` is untouched.
 *
 * `fetch` and `sleep` come in as functions so tests run with fakes and no network.
 */

export const DISCORD_API = "https://discord.com/api/v10";

/** No answer within the limit. A write that timed out may or may not have landed. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/** An answer that was not a success. `body` is the start of what the server said. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, what: string) {
    super(`${what} -> ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
  }
}

export type HttpDeps = {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt, headers and body included. Default 20 seconds. */
  timeoutMs?: number;
  /** How many times a 429 is retried before it counts as a failure. Default 3. */
  retries429?: number;
  /** A 429 asking for a longer wait than this fails at once instead. Default 10 seconds. */
  maxWaitMs?: number;
  onRateLimit?: (fields: { what: string; waitMs: number; attempt: number }) => void;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long a 429 asks to wait: the body's `retry_after` (seconds, Discord), else the Retry-After header, else one second. */
function retryAfterMs(text: string, header: string | null): number {
  try {
    const s = (JSON.parse(text) as { retry_after?: unknown }).retry_after;
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  } catch { /* not JSON */ }
  const h = Number(header);
  return header !== null && Number.isFinite(h) && h >= 0 ? Math.ceil(h * 1000) : 1000;
}

/**
 * One request, its body read to the end, within the time limit; 429 retried. Returns the body text.
 * The limit holds even when the fetch ignores the abort signal or the body never finishes.
 */
export async function send(deps: HttpDeps, what: string, url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  const doFetch = deps.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const sleep = deps.sleep ?? realSleep;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const retries = deps.retries429 ?? 3;
  const maxWait = deps.maxWaitMs ?? 10_000;
  for (let attempt = 0;; attempt++) {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new TimeoutError(what, timeoutMs));
      }, timeoutMs);
    });
    let status: number;
    let text: string;
    let retryHeader: string | null;
    try {
      const res = await Promise.race([doFetch(url, { ...init, signal: ctrl.signal }), expired]);
      status = res.status;
      retryHeader = res.headers.get("retry-after");
      text = await Promise.race([res.text(), expired]);
    } catch (e) {
      if (ctrl.signal.aborted) throw new TimeoutError(what, timeoutMs);
      // A network error names the URL, and an interaction URL carries its token: never pass that on.
      throw new Error(`${what} failed: ${scrub(e instanceof Error ? e.message : String(e))}`);
    } finally {
      clearTimeout(timer);
    }
    if (status === 429) {
      const wait = retryAfterMs(text, retryHeader);
      if (attempt >= retries || wait > maxWait) throw new HttpError(429, text, what);
      deps.onRateLimit?.({ what, waitMs: wait, attempt: attempt + 1 });
      await sleep(wait);
      continue;
    }
    if (status < 200 || status >= 300) throw new HttpError(status, text, what);
    return text;
  }
}

/** A path as it may appear in a log or an error: any long segment (an interaction or webhook token) is replaced. */
export function redact(path: string): string {
  return path.split("/").map((seg) => (seg.length > 40 ? "<token>" : seg)).join("/");
}

/** Free text (an error message) with anything token-shaped replaced. */
export function scrub(text: string): string {
  return text.replace(/[A-Za-z0-9_.-]{50,}/g, "<token>");
}

/** Discord REST: JSON in, parsed JSON (or undefined for an empty answer) out. Interaction and webhook calls carry no bot token. */
export function discordClient(token: string, deps: HttpDeps = {}): (method: string, path: string, body?: unknown) => Promise<unknown> {
  return async (method, path, body) => {
    const tokenless = path.startsWith("/interactions/") || path.startsWith("/webhooks/");
    const headers: Record<string, string> = { "content-type": "application/json", ...(tokenless ? {} : { authorization: `Bot ${token}` }) };
    const text = await send(deps, `discord ${method} ${redact(path)}`, `${DISCORD_API}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return text ? JSON.parse(text) : undefined;
  };
}

export type McpAnswer = { text: string; isError: boolean };

/** The JSON-RPC messages in a reply: one JSON body, or the data of each server-sent event. */
function messagesIn(raw: string): string[] {
  const sse = raw.startsWith("event:") || raw.startsWith("data:") || raw.includes("\ndata:");
  if (!sse) return [raw];
  return raw.split(/\r?\n\r?\n/).map((event) =>
    event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
  ).filter(Boolean);
}

/** A tools/call reply as text plus whether it is an error. A tool's own error and a JSON-RPC error both count. Anything unreadable throws. */
export function mcpText(raw: string): McpAnswer {
  for (const body of messagesIn(raw).reverse()) {
    let msg: { result?: { content?: { type?: string; text?: unknown }[]; isError?: unknown }; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== "object") continue;
    if (msg.error) return { text: `${msg.error.code ?? "error"}: ${msg.error.message ?? ""}`, isError: true };
    if (msg.result === undefined) continue;
    const content = Array.isArray(msg.result.content) ? msg.result.content : [];
    const first = content.find((c) => c?.type === "text") ?? content[0];
    return { text: typeof first?.text === "string" ? first.text : "", isError: msg.result.isError === true };
  }
  throw new Error(`unreadable answer from Grysstof: ${raw.slice(0, 120)}`);
}

/** capture_thought through /mcp, as `actor` (the gate records it as who learned the line). */
export function mcpCapture(mcpUrl: string, key: string, deps: HttpDeps = {}): (actor: string, args: Record<string, unknown>) => Promise<McpAnswer> {
  return async (actor, args) => {
    const text = await send(deps, "grysstof /mcp", mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key, "x-brain-actor": actor },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capture_thought", arguments: args } }),
    });
    return mcpText(text);
  };
}

/** GET /browse/api/loops next to /mcp (behind any path prefix GRYSSTOF_URL has), parsed. */
export function browseLoops(mcpUrl: string, key: string, deps: HttpDeps = {}): (query: Record<string, string>) => Promise<unknown> {
  const base = mcpUrl.replace(/\/mcp\/?$/, "");
  return async (query) => {
    const text = await send(deps, "grysstof /browse/api/loops", `${base}/browse/api/loops?${new URLSearchParams(query)}`, {
      method: "GET",
      headers: { accept: "application/json", "x-brain-key": key },
    });
    return JSON.parse(text);
  };
}
