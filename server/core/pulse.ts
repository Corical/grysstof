/**
 * Pulse: what the portal shows, computed from captured messages. Pure: thoughts and facts in,
 * plain objects out. No clock of its own (callers pass `now`), no I/O, so every rule here is
 * tested directly and the page only draws what these functions return.
 */
import type { Thought } from "./ports/mod.ts";
import { type Reaction, reactionsIn } from "./reactions.ts";

export type PulseMessage = {
  id: string;
  source: string;
  channel: string;
  author: string | null;
  text: string;
  at: string;
  type: string;
  inReplyTo: string | null;
  reactions: Reaction[];
  topics: string[];
};

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which client a Discord channel belongs to. An override (from a `channel:<name>` ledger fact:
 * "client:<slug>" or "internal") wins. Otherwise the longest client slug whose letters start the
 * channel's letters: #grainfieldchicken is client:grainfield, #relativ-media-pixel is
 * client:relativ-media. Slugs shorter than 3 letters never match; no match is internal (null).
 */
export function clientForChannel(channel: string, clients: string[], overrides: Record<string, string>): { client: string | null; how: "auto" | "set" } {
  const set = overrides[channel];
  if (set !== undefined) return { client: set.startsWith("client:") ? set : null, how: "set" };
  const ch = letters(channel);
  let best: string | null = null, bestLen = 0;
  for (const c of clients) {
    const slug = letters(c.replace(/^client:/, ""));
    if (slug.length >= 3 && ch.startsWith(slug) && slug.length > bestLen) {
      best = c;
      bestLen = slug.length;
    }
  }
  return { client: best, how: "auto" };
}

/** The speaker of a line the Discord writer wrote ("Discord #ch (G), YYYY-MM-DD, Who: …"), or null. */
export function authorOf(content: string): string | null {
  if (!content.startsWith("Discord #")) return null;
  const m = /, \d{4}-\d{2}-\d{2}, ([^:\n]+?): /.exec(content);
  return m ? m[1].trim() : null;
}

/** The message text without the "Discord #ch (G), date, Who:" header. */
function bodyOf(content: string): string {
  const m = /, \d{4}-\d{2}-\d{2}, [^:\n]+?: /.exec(content);
  return m && content.startsWith("Discord #") ? content.slice(m.index + m[0].length) : content;
}

/** Captured Discord thoughts as messages, oldest first. Thoughts without a channel are left out. */
export function toMessages(thoughts: Thought[]): PulseMessage[] {
  return thoughts
    .filter((t) => typeof t.metadata.channel === "string" && typeof t.metadata.source === "string")
    .map((t) => ({
      id: t.id,
      source: String(t.metadata.source),
      channel: String(t.metadata.channel).toLowerCase(),
      author: authorOf(t.content),
      text: bodyOf(t.content),
      at: t.createdAt,
      type: typeof t.metadata.type === "string" ? t.metadata.type : "observation",
      inReplyTo: typeof t.metadata.in_reply_to === "string" ? t.metadata.in_reply_to : null,
      reactions: reactionsIn(t.metadata.reactions),
      topics: Array.isArray(t.metadata.topics) ? t.metadata.topics.filter((x): x is string => typeof x === "string") : [],
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

export type Conversation = { id: string; channel: string; messages: PulseMessage[]; opener: PulseMessage; last: PulseMessage; people: string[]; start: string; end: string };

/** A channel's messages grouped into conversations: a silence longer than `gapMinutes` starts a new one. */
export function conversations(messages: PulseMessage[], gapMinutes: number): Conversation[] {
  const byChannel = new Map<string, PulseMessage[]>();
  for (const m of messages) byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m]);
  const out: Conversation[] = [];
  for (const [channel, list] of byChannel) {
    let cur: PulseMessage[] = [];
    const flush = () => {
      if (!cur.length) return;
      const people = [...new Set(cur.map((m) => m.author).filter((a): a is string => !!a))];
      out.push({ id: cur[0].source, channel, messages: cur, opener: cur[0], last: cur[cur.length - 1], people, start: cur[0].at, end: cur[cur.length - 1].at });
      cur = [];
    };
    for (const m of list) {
      if (cur.length && Date.parse(m.at) - Date.parse(cur[cur.length - 1].at) > gapMinutes * 60_000) flush();
      cur.push(m);
    }
    flush();
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export type ClientCard = {
  client: string;
  channels: string[];
  lastAt: string | null;
  last7: number;
  last30: number;
  /** Messages per 24 hours for the last 30 days; index 29 is the last 24 hours. */
  daily: number[];
  looseEnds: number;
  facts: number;
  people: { name: string; messages: number }[];
};

/**
 * One card per known client, busiest-need first: open loose ends, then a client gone quiet
 * after being active, then recent activity. Channels map to clients by `clientForChannel`.
 */
export function clientCards(messages: PulseMessage[], clients: string[], overrides: Record<string, string>, facts: Record<string, number>, now: number): ClientCard[] {
  const clientOf = new Map<string, string | null>();
  const mapped = (ch: string) => {
    if (!clientOf.has(ch)) clientOf.set(ch, clientForChannel(ch, clients, overrides).client);
    return clientOf.get(ch)!;
  };
  const open = new Set(looseEnds(messages, { now, days: 30 }).map((m) => m.id));
  const cards = new Map<string, ClientCard>(clients.map((c) => [c, { client: c, channels: [], lastAt: null, last7: 0, last30: 0, daily: Array(30).fill(0), looseEnds: 0, facts: facts[c] ?? 0, people: [] }]));
  const people = new Map<string, Map<string, number>>();
  for (const m of messages) {
    const c = mapped(m.channel);
    const card = c ? cards.get(c) : undefined;
    if (!card) continue;
    if (!card.channels.includes(m.channel)) card.channels.push(m.channel);
    const t = Date.parse(m.at);
    if (t > now) continue;
    if (!card.lastAt || t > Date.parse(card.lastAt)) card.lastAt = m.at;
    const age = now - t;
    if (age < 7 * 86_400_000) card.last7++;
    if (age < 30 * 86_400_000) {
      card.last30++;
      card.daily[29 - Math.floor(age / 86_400_000)]++;
      if (m.author) {
        const p = people.get(card.client) ?? new Map<string, number>();
        p.set(m.author, (p.get(m.author) ?? 0) + 1);
        people.set(card.client, p);
      }
    }
    if (open.has(m.id)) card.looseEnds++;
  }
  for (const card of cards.values()) {
    card.people = [...(people.get(card.client) ?? new Map()).entries()].map(([name, n]) => ({ name, messages: n })).sort((a, b) => b.messages - a.messages).slice(0, 6);
  }
  const quiet = (c: ClientCard) => (c.last30 > 0 && c.last7 === 0 ? 1 : 0);
  return [...cards.values()].sort((a, b) => b.looseEnds - a.looseEnds || quiet(b) - quiet(a) || b.last7 - a.last7 || b.last30 - a.last30 || a.client.localeCompare(b.client));
}

export type GraphNode = { id: string; kind: "message" | "person" | "client"; label: string; source?: string; channel?: string; author?: string | null; at?: string; text?: string; hit?: boolean; reactions?: Reaction[]; weight: number };
export type GraphLink = { source: string; target: string; kind: "next" | "reply" | "said" | "reacted" | "in"; label?: string };

/**
 * The bubbles for Explore. Each hit brings the conversation it sits in (trimmed around the hit
 * so the whole stays under `maxMessages`), everyone who spoke or reacted in it, and its client.
 * Links: next message, reply (only when both ends are in view), who said it, who reacted with
 * what, and the conversation's opener to its client. No link ever points at a missing node.
 */
export function exploreGraph(hitIds: string[], messages: PulseMessage[], clientOf: (channel: string) => string | null, opts: { gapMinutes: number; maxMessages: number }): { nodes: GraphNode[]; links: GraphLink[] } {
  if (!hitIds.length) return { nodes: [], links: [] };
  const convs = conversations(messages, opts.gapMinutes);
  const convOf = new Map<string, number>();
  convs.forEach((c, i) => c.messages.forEach((m) => convOf.set(m.id, i)));
  const hits = hitIds.filter((id) => convOf.has(id));
  const per = Math.max(3, Math.floor(opts.maxMessages / Math.max(1, hits.length)));
  const chosen = new Map<string, PulseMessage>();
  const convShown = new Map<number, PulseMessage[]>();
  for (const id of hits) {
    const ci = convOf.get(id)!;
    const list = convs[ci].messages;
    const at = list.findIndex((m) => m.id === id);
    const half = Math.floor(per / 2);
    const from = Math.max(0, Math.min(at - half, list.length - per));
    for (const m of list.slice(from, from + per)) {
      if (chosen.size >= opts.maxMessages && m.id !== id) continue;
      chosen.set(m.id, m);
      convShown.set(ci, [...(convShown.get(ci) ?? []).filter((x) => x.id !== m.id), m]);
    }
  }
  const hitSet = new Set(hits);
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const bySource = new Map([...chosen.values()].map((m) => [m.source, m.id]));
  const person = (name: string) => {
    const id = `person:${name}`;
    const n = nodes.get(id);
    if (n) n.weight++;
    else nodes.set(id, { id, kind: "person", label: name, weight: 1 });
    return id;
  };
  for (const m of chosen.values()) {
    nodes.set(m.id, { id: m.id, kind: "message", label: m.text.slice(0, 60), source: m.source, channel: m.channel, author: m.author, at: m.at, text: m.text, hit: hitSet.has(m.id), reactions: m.reactions, weight: 1 + m.reactions.reduce((s, r) => s + r.count, 0) });
  }
  for (const m of chosen.values()) {
    if (m.author) links.push({ source: person(m.author), target: m.id, kind: "said" });
    for (const r of m.reactions) for (const who of r.by) links.push({ source: person(who), target: m.id, kind: "reacted", label: r.emoji });
    const parent = m.inReplyTo ? bySource.get(m.inReplyTo) : undefined;
    if (parent) links.push({ source: m.id, target: parent, kind: "reply" });
  }
  for (const [ci, shown] of convShown) {
    const ordered = shown.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 1; i < ordered.length; i++) links.push({ source: ordered[i - 1].id, target: ordered[i].id, kind: "next" });
    const client = clientOf(convs[ci].channel);
    if (client && ordered.length) {
      if (!nodes.has(client)) nodes.set(client, { id: client, kind: "client", label: client.replace(/^client:/, ""), weight: 1 });
      links.push({ source: ordered[0].id, target: client, kind: "in" });
    }
  }
  return { nodes: [...nodes.values()], links };
}

export type LooseEnd = PulseMessage & { ageHours: number };

const REQUEST = /\b(please|pls|plz|kindly|can you|could you|would you|can someone|can we|could we)\b/i;

/** First names @mentioned in a line ("@Luke Simon" → "luke"), lower case. */
function mentioned(text: string): string[] {
  return [...text.matchAll(/@([A-Za-z][\w.'-]*)/g)].map((m) => m[1].toLowerCase());
}

/**
 * A line that asks something: a question or a request phrase. Not the tagger's "task" (most
 * lines), and not a bare @mention ("@Kelli Done", "@Devon thanks"): a mention says who is
 * asked, not that anything is.
 */
export function isAsk(m: PulseMessage): boolean {
  const words = m.text.replace(/https?:\/\/\S+/g, " "); // a link's ?query is not a question
  return !m.inReplyTo && (words.includes("?") || REQUEST.test(words));
}

/**
 * Asks nobody has visibly picked up, within the last `days`. Picked up: a reply linked to it,
 * any reaction, or a later message in the same conversation from a person it @mentioned
 * (from anyone but the asker when it named nobody). An answer in another conversation, or by
 * phone, is not seen, so the portal words this as "no visible response", never "unanswered".
 */
export function looseEnds(messages: PulseMessage[], opts: { now: number; days: number; gapMinutes?: number }): LooseEnd[] {
  const replied = new Set(messages.map((m) => m.inReplyTo).filter((s): s is string => !!s));
  const from = opts.now - opts.days * 86_400_000;
  const open: PulseMessage[] = [];
  for (const conv of conversations(messages, opts.gapMinutes ?? 120)) {
    conv.messages.forEach((m, i) => {
      if (!isAsk(m) || replied.has(m.source) || m.reactions.length) return;
      const t = Date.parse(m.at);
      if (t < from || t > opts.now) return;
      const named = mentioned(m.text);
      const later = conv.messages.slice(i + 1).filter((x) => x.author && x.author !== m.author);
      const pickedUp = named.length
        ? later.some((x) => named.includes(x.author!.toLowerCase().split(/\s+/)[0]))
        : later.length > 0;
      if (!pickedUp) open.push(m);
    });
  }
  return open
    .map((m) => ({ ...m, ageHours: Math.round((opts.now - Date.parse(m.at)) / 3_600_000) }))
    .sort((a, b) => b.ageHours - a.ageHours || a.id.localeCompare(b.id));
}
