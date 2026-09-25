/**
 * The browse API: read-only JSON views over the ledger and the memory for
 * the page in browse-page.ts. Gate already passed; the scope is trusted.
 */
import type { Ports, RecentQuery, Scope } from "./ports/mod.ts";
import { wholeDayUntil } from "./when.ts";
import { clientCards, clientForChannel, type Conversation, conversations, exploreGraph, looseEnds, toMessages } from "./pulse.ts";

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
  "/pulse/overview": async (_q, ports, scope) => {
    const p = await pulseInputs(ports, scope);
    const now = Date.now();
    const clientOf = (ch: string) => clientForChannel(ch, p.clients, p.overrides);
    const channels = [...new Set(p.messages.map((m) => m.channel))].sort();
    const convs = conversations(p.messages, GAP_MINUTES);
    const open = looseEnds(p.messages, { now, days: 30, gapMinutes: GAP_MINUTES });
    return {
      tenant: scope.tenant,
      totals: { messages: p.messages.length, channels: channels.length, clients: p.clients.length, newest: p.messages.at(-1)?.at ?? null },
      cards: clientCards(p.messages, p.clients, p.overrides, p.factCounts, now),
      looseEndsTotal: open.length,
      looseEnds: open.map((m) => ({ ...m, client: clientOf(m.channel).client })).slice(0, 300),
      mapping: channels.map((ch) => ({ channel: ch, ...clientOf(ch), messages: p.messages.filter((m) => m.channel === ch).length })),
      recent: convs.slice(-25).reverse().map((c) => summariseConversation(c, clientOf(c.channel).client)),
    };
  },
  "/pulse/client": async (q, ports, scope) => {
    const client = param(q, "client") ?? "";
    const p = await pulseInputs(ports, scope);
    if (!p.clients.includes(client)) throw new Error(`No client ${client}`);
    const now = Date.now();
    const mine = p.messages.filter((m) => clientForChannel(m.channel, p.clients, p.overrides).client === client);
    const facts = await ports.ledger.history(scope, client);
    return {
      card: clientCards(p.messages, p.clients, p.overrides, p.factCounts, now).find((c) => c.client === client),
      conversations: conversations(mine, GAP_MINUTES).slice(-30).reverse().map((c) => ({ ...summariseConversation(c, client), messages: c.messages })),
      looseEnds: looseEnds(mine, { now, days: 60, gapMinutes: GAP_MINUTES }),
      facts: facts.filter((f) => !f.supersededBy).slice(0, 60), // history() is newest first
    };
  },
  "/pulse/explore": async (q, ports, scope) => {
    const query = param(q, "q") ?? "";
    if (!query.trim()) return { query, nodes: [], links: [] };
    const p = await pulseInputs(ports, scope);
    const known = new Set(p.messages.map((m) => m.id));
    const hits = (await ports.memory.recall(scope, query, { limit: 40, minScore: 0.3 })).filter((h) => known.has(h.id)).slice(0, limitOf(q, 8, 20));
    const graph = exploreGraph(hits.map((h) => h.id), p.messages, (ch) => clientForChannel(ch, p.clients, p.overrides).client, { gapMinutes: GAP_MINUTES, maxMessages: 140 });
    return { query, hits: hits.map((h) => ({ id: h.id, score: h.score })), ...graph };
  },
  "/pulse/thread": async (q, ports, scope) => {
    const source = param(q, "source") ?? "";
    const p = await pulseInputs(ports, scope);
    const all = conversations(p.messages, GAP_MINUTES);
    const conv = all.find((c) => c.messages.some((m) => m.source === source));
    if (!conv) throw new Error(`No conversation holds ${source}`);
    const opened = conv.messages.find((m) => m.source === source)!;
    // The bubbles for this conversation, so whatever opens a thread shows its own graph, never a stale search,
    // with the channel's conversation before and after it for context. Only the opened message is marked.
    const inChannel = all.filter((c) => c.channel === conv.channel);
    const at = inChannel.indexOf(conv);
    const around = [inChannel[at - 1], inChannel[at + 1]].filter((c): c is Conversation => !!c).map((c) => c.opener.id);
    const graph = exploreGraph([opened.id, ...around], p.messages, (ch) => clientForChannel(ch, p.clients, p.overrides).client, { gapMinutes: GAP_MINUTES, maxMessages: 140 });
    for (const n of graph.nodes) if (n.kind === "message") n.hit = n.id === opened.id;
    return { ...summariseConversation(conv, clientForChannel(conv.channel, p.clients, p.overrides).client), messages: conv.messages, graph };
  },
  "/recall": async (q, { memory }, scope) => ({
    thoughts: await memory.recall(scope, q.get("q") ?? "", { limit: limitOf(q, 50, 500), minScore: 0 }),
  }),
  "/thought": async (q, { memory }, scope) => ({ thought: await memory.get(scope, q.get("id") ?? "") }),
} satisfies Record<string, Route>));

/** Talk in one channel that pauses longer than this is two conversations. */
const GAP_MINUTES = 120;

/** Everything Pulse computes from: the captured messages, the known clients, their fact counts, and channel overrides. */
async function pulseInputs(ports: Ports, scope: Scope) {
  const [thoughts, subjects] = await Promise.all([
    ports.memory.recent(scope, { limit: 10_000_000, sourcePrefix: "discord:", order: "oldest" }),
    ports.ledger.subjects(scope),
  ]);
  const clients = subjects.map((s) => s.subject).filter((s) => s.startsWith("client:")).sort();
  const factCounts = Object.fromEntries(subjects.filter((s) => s.subject.startsWith("client:")).map((s) => [s.subject, s.current]));
  const overrides: Record<string, string> = {};
  for (const s of subjects.filter((x) => x.subject.startsWith("channel:"))) {
    const f = await ports.ledger.latest(scope, s.subject);
    if (f) overrides[s.subject.slice("channel:".length).replace(/^#/, "").toLowerCase()] = f.claim.trim();
  }
  return { messages: toMessages(thoughts), clients, factCounts, overrides };
}

function summariseConversation(c: Conversation, client: string | null) {
  return {
    id: c.id, channel: c.channel, client, start: c.start, end: c.end, size: c.messages.length, people: c.people,
    opener: { author: c.opener.author, text: c.opener.text.slice(0, 280), source: c.opener.source },
    last: { author: c.last.author, text: c.last.text.slice(0, 280), source: c.last.source, reactions: c.last.reactions },
  };
}

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
