/**
 * The browse API: read-only JSON views over the ledger and the memory for
 * the page in browse-page.ts. Gate already passed; the scope is trusted.
 */
import type { Ports, RecentQuery, Scope } from "./ports/mod.ts";
import { wholeDayUntil } from "./when.ts";

const PREFIX = "/browse/api";

type Route = (q: URLSearchParams, ports: Ports, scope: Scope) => Promise<unknown>;

/** Missing or non-numeric is the default; above `max` is `max`; below 0 is 0; parseInt semantics ("2.9" is 2, "5abc" is 5). */
function limitOf(q: URLSearchParams, dflt: number, max: number): number {
  const n = parseInt(q.get("limit") ?? "", 10);
  return Number.isNaN(n) ? dflt : Math.min(max, Math.max(0, n));
}

/** A blank query parameter is the same as an absent one. */
const param = (q: URLSearchParams, name: string): string | undefined => q.get(name) || undefined;

// A Map, not an object: "/browse/apiconstructor" must not find Object.prototype.constructor.
const ROUTES = new Map<string, Route>(Object.entries({
  "/overview": async (_q, { ledger, memory }, scope) => ({
    tenant: scope.tenant,
    subjects: await ledger.subjects(scope),
    summary: await memory.summary(scope),
  }),
  "/history": async (q, { ledger }, scope) => ({ facts: await ledger.history(scope, q.get("subject") ?? "") }),
  "/facts": async (q, { ledger }, scope) => ({
    facts: await ledger.find(scope, q.get("q") ?? "", {
      limit: limitOf(q, 50, 500),
      minScore: 0,
      includeSuperseded: q.get("includeSuperseded") === "true",
    }),
  }),
  "/thoughts": async (q, { memory }, scope) => {
    const query: RecentQuery = { limit: limitOf(q, 200, 2000) };
    for (const key of ["type", "topic", "person", "since", "channel"] as const) {
      const v = param(q, key);
      if (v !== undefined) query[key] = v;
    }
    const until = wholeDayUntil(param(q, "until"));
    if (until !== undefined) query.until = until;
    const source = param(q, "source_prefix");
    if (source !== undefined) query.sourcePrefix = source;
    const order = param(q, "order");
    if (order !== undefined && order !== "newest" && order !== "oldest") throw new Error(`order must be "newest" or "oldest", got "${order}"`);
    if (order !== undefined) query.order = order;
    const offset = param(q, "offset");
    if (offset !== undefined) {
      if (!/^\d+$/.test(offset)) throw new Error(`offset must be a whole number ≥ 0, got "${offset}"`);
      query.offset = Number(offset);
    }
    return { thoughts: await memory.recent(scope, query) };
  },
  "/recall": async (q, { memory }, scope) => ({
    thoughts: await memory.recall(scope, q.get("q") ?? "", { limit: limitOf(q, 50, 500), minScore: 0 }),
  }),
  "/thought": async (q, { memory }, scope) => ({ thought: await memory.get(scope, q.get("id") ?? "") }),
} satisfies Record<string, Route>));

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

export async function browseApi(request: Request, ports: Ports, scope: Scope): Promise<Response> {
  if (request.method !== "GET") return json({ error: `${request.method} is not allowed; the browse API is GET only` }, 405, { Allow: "GET" });
  const url = new URL(request.url);
  const route = url.pathname.slice(PREFIX.length);
  const handler = ROUTES.get(route);
  if (!handler) return json({ error: `No browse route ${route || "/"}` }, 404);
  const who = { route, tenant: scope.tenant, actor: scope.actor };
  ports.log.info("browse.called", who);
  try {
    return json(await handler(url.searchParams, ports, scope));
  } catch (err) {
    ports.log.error("browse.failed", who, err);
    return json({ error: (err as Error)?.message ?? String(err) }, 400);
  }
}
