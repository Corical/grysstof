/**
 * Open loops (plan 5): the state line each loop writes to the ledger, and the rules that read it
 * back. One ledger subject per loop (`loop:<key>`), one line per state change; the newest line
 * nobody has superseded is the loop's state. Pure: lines and facts in, plain objects out, no clock
 * of its own (callers pass `now`), no I/O, so every rule is tested directly.
 *
 * C1 (the line), C2 (the key and its generations) and C3 (what /browse/api/loops returns) are
 * written in the plan; this file is their only implementation in the server. A line that cannot
 * be read is reported as unreadable, never dropped.
 */
import type { Fact } from "./ports/mod.ts";

export const LOOP_PREFIX = "loop:";
export const LOOP_TYPES = ["unanswered_question", "unkept_promise", "stale_followup", "unticketed_ask"] as const;
export type LoopType = typeof LOOP_TYPES[number];
export const LOOP_STATES = ["open", "parked", "closed", "resolved"] as const;
export type LoopState = typeof LOOP_STATES[number];

/**
 * Caps on what a line may carry. Title, summary, note, reason and evidence are C1's. Names
 * (owner, channel, by_name) and ids are held to 100 characters, the longest a Discord channel
 * name may be, so no field can grow a line without bound.
 */
export const LIMITS = { title: 120, summary: 300, note: 300, reason: 200, name: 100, id: 100, evidence: 8 } as const;

/** Closed and resolved loops older than this are left out unless the caller gives `since`. */
export const FINISHED_WINDOW_DAYS = 30;

export type OpenLine = {
  tag: "OPEN"; key: string; client: string; type: LoopType; owner: string; channel: string; channelId: string;
  opened: string; reopened: string | null; title: string; summary: string; evidence: string[];
};
export type ClosedLine = { tag: "CLOSED"; key: string; byMessage: string; closed: string; reason: string };
export type ResolvedLine = { tag: "RESOLVED"; key: string; byUser: string; byName: string; resolved: string; note: string };
export type ParkedLine = { tag: "PARKED"; key: string; byUser: string; byName: string; until: string; note: string };
export type LoopLine = OpenLine | ClosedLine | ResolvedLine | ParkedLine;
type Tag = LoopLine["tag"];

/** Field names in the order a line is written. */
const FIELDS: Record<Tag, readonly string[]> = {
  OPEN: ["key", "client", "type", "owner", "channel", "channel_id", "opened", "reopened", "title", "summary", "evidence"],
  CLOSED: ["key", "by_message", "closed", "reason"],
  RESOLVED: ["key", "by_user", "by_name", "resolved", "note"],
  PARKED: ["key", "by_user", "by_name", "until", "note"],
};
const VERSION = "1";

// --- C1: sanitise, compose, parse ---

/** Control characters, line and paragraph separators, bidi controls and lone surrogate halves. */
const UNSAFE = /[\p{Cc}\p{Cs}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Free text made safe for one field of one line: every `|` removed, line breaks, control and bidi
 * characters turned to spaces, whitespace collapsed, then cut to `max` characters (code points, so
 * an emoji is never split) and trimmed. Idempotent.
 */
export function sanitise(text: unknown, max: number): string {
  const flat = String(text ?? "").replace(/\|/g, "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  return [...flat].slice(0, Math.max(0, max)).join("").trim();
}

/** An id, a key or a time: nothing unsafe, no `|`, no comma, no whitespace at all. */
function cleanId(v: unknown): string {
  return [...String(v ?? "").replace(UNSAFE, "").replace(/[|,\s]/g, "")].slice(0, LIMITS.id).join("");
}

/** Evidence ids cleaned, blanks and repeats dropped (first sighting keeps its place), the newest 8 kept. */
function cleanEvidence(ids: unknown): string[] {
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const c = cleanId(id);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(-LIMITS.evidence);
}

const reopenedOf = (v: unknown): string | null => {
  const c = v === null || v === undefined ? "" : cleanId(v);
  return c === "" || c === "-" ? null : c;
};

/** What `parse(compose(line))` gives back: every field sanitised and capped. */
export function sanitiseLine(line: LoopLine): LoopLine {
  switch (line.tag) {
    case "OPEN":
      return {
        tag: "OPEN", key: cleanId(line.key), client: cleanId(line.client), type: cleanId(line.type) as LoopType,
        owner: sanitise(line.owner, LIMITS.name), channel: sanitise(line.channel, LIMITS.name), channelId: cleanId(line.channelId),
        opened: cleanId(line.opened), reopened: reopenedOf(line.reopened), title: sanitise(line.title, LIMITS.title),
        summary: sanitise(line.summary, LIMITS.summary), evidence: cleanEvidence(line.evidence),
      };
    case "CLOSED":
      return { tag: "CLOSED", key: cleanId(line.key), byMessage: cleanId(line.byMessage), closed: cleanId(line.closed), reason: sanitise(line.reason, LIMITS.reason) };
    case "RESOLVED":
      return { tag: "RESOLVED", key: cleanId(line.key), byUser: cleanId(line.byUser), byName: sanitise(line.byName, LIMITS.name), resolved: cleanId(line.resolved), note: sanitise(line.note, LIMITS.note) };
    case "PARKED":
      return { tag: "PARKED", key: cleanId(line.key), byUser: cleanId(line.byUser), byName: sanitise(line.byName, LIMITS.name), until: cleanId(line.until), note: sanitise(line.note, LIMITS.note) };
    default:
      throw new Error(`unknown loop line tag ${JSON.stringify((line as { tag?: unknown }).tag)}`);
  }
}

/** An ISO 8601 date or instant: the same rule the Memory port applies to since/until. */
export function isInstant(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

function fieldsOf(line: LoopLine): Record<string, string> {
  switch (line.tag) {
    case "OPEN":
      return {
        key: line.key, client: line.client, type: line.type, owner: line.owner, channel: line.channel, channel_id: line.channelId,
        opened: line.opened, reopened: line.reopened ?? "-", title: line.title, summary: line.summary, evidence: line.evidence.join(","),
      };
    case "CLOSED":
      return { key: line.key, by_message: line.byMessage, closed: line.closed, reason: line.reason };
    case "RESOLVED":
      return { key: line.key, by_user: line.byUser, by_name: line.byName, resolved: line.resolved, note: line.note };
    case "PARKED":
      return { key: line.key, by_user: line.byUser, by_name: line.byName, until: line.until, note: line.note };
  }
}

/** Why these fields do not make a readable line of this tag, or null when they do. */
function invalid(tag: Tag, f: Record<string, string>): string | null {
  if (!f.key) return "key is blank";
  const when = (name: string) => (isInstant(f[name]) ? null : `${name} is not an ISO 8601 time: "${f[name].slice(0, 40)}"`);
  switch (tag) {
    case "OPEN":
      if (!(LOOP_TYPES as readonly string[]).includes(f.type)) return `type "${f.type.slice(0, 40)}" is not one of ${LOOP_TYPES.join(", ")}`;
      if (f.reopened !== "" && f.reopened !== "-" && !isInstant(f.reopened)) return when("reopened");
      return when("opened");
    case "CLOSED":
      return f.by_message ? when("closed") : "by_message is blank";
    case "RESOLVED":
      return f.by_user ? when("resolved") : "by_user is blank";
    case "PARKED":
      return f.by_user ? when("until") : "by_user is blank";
  }
}

function lineOf(tag: Tag, f: Record<string, string>): LoopLine {
  switch (tag) {
    case "OPEN":
      return {
        tag, key: f.key, client: f.client, type: f.type as LoopType, owner: f.owner, channel: f.channel, channelId: f.channel_id,
        opened: f.opened, reopened: reopenedOf(f.reopened), title: f.title, summary: f.summary,
        evidence: f.evidence.split(",").map((s) => s.trim()).filter(Boolean),
      };
    case "CLOSED":
      return { tag, key: f.key, byMessage: f.by_message, closed: f.closed, reason: f.reason };
    case "RESOLVED":
      return { tag, key: f.key, byUser: f.by_user, byName: f.by_name, resolved: f.resolved, note: f.note };
    case "PARKED":
      return { tag, key: f.key, byUser: f.by_user, byName: f.by_name, until: f.until, note: f.note };
  }
}

/**
 * The line a writer stores as the fact's claim. Sanitises every field first; refuses (throws) a
 * line that `parse` could not read back, so nothing unreadable is ever written by this code.
 */
export function compose(line: LoopLine): string {
  const s = sanitiseLine(line);
  const f = fieldsOf(s);
  const problem = invalid(s.tag, f);
  if (problem) throw new Error(`cannot compose a ${s.tag} line: ${problem}`);
  return [`${s.tag}/${VERSION}`, ...FIELDS[s.tag].map((name) => `${name}=${f[name]}`)].join(" | ");
}

export type Parsed = { ok: true; line: LoopLine } | { ok: false; reason: string };

/**
 * A claim read back as a line. Strict about what changes meaning (tag, version, which fields,
 * types, times), tolerant of spacing around `|` and of field order. Never throws.
 */
export function parse(claim: string): Parsed {
  const fail = (reason: string): Parsed => ({ ok: false, reason });
  if (typeof claim !== "string") return fail("not text");
  if (/[\r\n]/.test(claim)) return fail("more than one line");
  const parts = claim.split("|").map((p) => p.trim());
  const m = /^(OPEN|CLOSED|RESOLVED|PARKED)\/(\d+)$/.exec(parts[0]);
  if (!m) return fail(`unknown tag "${parts[0].slice(0, 40)}"`);
  if (m[2] !== VERSION) return fail(`unknown version ${m[1]}/${m[2]}`);
  const tag = m[1] as Tag;
  const f: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq <= 0) return fail(`a field with no name: "${p.slice(0, 40)}"`);
    const name = p.slice(0, eq).trim();
    if (!FIELDS[tag].includes(name)) return fail(`unknown field "${name.slice(0, 40)}" on ${tag}`);
    if (Object.hasOwn(f, name)) return fail(`field ${name} given twice`);
    f[name] = p.slice(eq + 1).trim();
  }
  for (const name of FIELDS[tag]) if (!Object.hasOwn(f, name)) return fail(`${tag} needs ${name}`);
  const problem = invalid(tag, f);
  return problem ? fail(problem) : { ok: true, line: lineOf(tag, f) };
}

// --- one subject's history to one loop (C2 rule 4, C3) ---

/** One loop as /browse/api/loops returns it (C3). */
export type LoopView = {
  key: string; subject: string; lineId: string; state: LoopState;
  client: string; type: LoopType; owner: string; channel: string; channelId: string; opened: string; reopened: string | null;
  title: string; summary: string; evidence: string[]; proof: string | null;
  /** When it stopped being open: the closing message's time for CLOSED, the press for RESOLVED. */
  closed: string | null;
  byMessage: string | null; byUser: string | null; byName: string | null; until: string | null;
  /** CLOSED's reason, or RESOLVED's and PARKED's note. */
  note: string | null;
  fork: boolean; learnedAt: string;
};

export type Unreadable = { subject: string; lineId: string; reason: string };
export type Read = { ok: true; loop: LoopView } | { ok: false; unreadable: Unreadable };

const codePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Newest learnedAt first; a same-moment tie goes to the larger id, so every reader picks the same head. */
const newestFirst = (a: Fact, b: Fact) => (Date.parse(b.learnedAt) - Date.parse(a.learnedAt)) || codePoint(b.id, a.id);

function readable(f: Fact, key: string): Parsed {
  const p = parse(f.claim);
  if (p.ok && p.line.key !== key) return { ok: false, reason: `line is for key "${p.line.key.slice(0, 40)}", not "${key.slice(0, 40)}"` };
  return p;
}

/** The OPEN line a later line belongs to: back along `supersedes` first, else the newest readable OPEN in the history. */
function openerOf(head: Fact, history: Fact[], key: string): { fact: Fact; line: OpenLine } | null {
  const byId = new Map(history.map((f) => [f.id, f]));
  const seen = new Set<string>([head.id]);
  for (let cur = head.supersedes ? byId.get(head.supersedes) : undefined; cur && !seen.has(cur.id); cur = cur.supersedes ? byId.get(cur.supersedes) : undefined) {
    seen.add(cur.id);
    const r = readable(cur, key);
    if (r.ok && r.line.tag === "OPEN") return { fact: cur, line: r.line };
  }
  for (const f of [...history].sort(newestFirst)) {
    const r = readable(f, key);
    if (r.ok && r.line.tag === "OPEN") return { fact: f, line: r.line };
  }
  return null;
}

/**
 * One loop from every line of its subject, in any order. The head is the newest line nobody has
 * superseded; two or more such lines are a fork, read as the newest and reported (C2 rule 4).
 */
export function readLoop(subject: string, history: Fact[]): Read {
  const key = subject.startsWith(LOOP_PREFIX) ? subject.slice(LOOP_PREFIX.length) : "";
  const bad = (lineId: string, reason: string): Read => ({ ok: false, unreadable: { subject, lineId, reason } });
  const heads = history.filter((f) => !f.supersededBy).sort(newestFirst);
  if (!heads.length) return bad([...history].sort(newestFirst)[0]?.id ?? "", "every line is superseded; no current line");
  const head = heads[0];
  const read = readable(head, key);
  if (!read.ok) return bad(head.id, read.reason);
  const line = read.line;
  const opener = line.tag === "OPEN" ? { fact: head, line } : openerOf(head, history, key);
  if (!opener) return bad(head.id, `${line.tag} line with no readable OPEN line for this loop`);
  const o = opener.line;
  const loop: LoopView = {
    key, subject, lineId: head.id, state: line.tag.toLowerCase() as LoopState,
    client: o.client, type: o.type, owner: o.owner, channel: o.channel, channelId: o.channelId, opened: o.opened, reopened: o.reopened,
    title: o.title, summary: o.summary, evidence: [...o.evidence], proof: opener.fact.proof ?? null,
    closed: null, byMessage: null, byUser: null, byName: null, until: null, note: null,
    fork: heads.length > 1, learnedAt: head.learnedAt,
  };
  if (line.tag === "CLOSED") Object.assign(loop, { closed: line.closed, byMessage: line.byMessage, note: line.reason });
  if (line.tag === "RESOLVED") Object.assign(loop, { closed: line.resolved, byUser: line.byUser, byName: line.byName, note: line.note });
  if (line.tag === "PARKED") Object.assign(loop, { until: line.until, byUser: line.byUser, byName: line.byName, note: line.note });
  return { ok: true, loop };
}

// --- the query (C3) ---

export type LoopQuery = { states: LoopState[]; since?: string; client?: string; limit: number };

/** The route's parameters checked: state open (default), parked, closed, resolved or all; since ISO 8601 or absent. */
export function loopQuery(p: { state?: string; since?: string; client?: string; limit: number }): LoopQuery {
  const state = p.state ?? "open";
  let states: LoopState[];
  if (state === "all") states = [...LOOP_STATES];
  else if ((LOOP_STATES as readonly string[]).includes(state)) states = [state as LoopState];
  else throw new Error(`state must be one of ${LOOP_STATES.join(", ")} or all, got "${state.slice(0, 40)}"`);
  if (p.since !== undefined && !isInstant(p.since)) throw new Error(`since must be an ISO 8601 timestamp, got "${p.since.slice(0, 40)}"`);
  const client = p.client?.trim() || undefined;
  const limit = Number.isFinite(p.limit) ? Math.max(0, Math.floor(p.limit)) : 0;
  return { states, ...(p.since !== undefined ? { since: p.since } : {}), ...(client ? { client } : {}), limit };
}

const clientKey = (c: string) => c.trim().toLowerCase().replace(/^client:/, "");

/** When the loop entered its current state: the close for closed and resolved, the (re)opening for open, the write for parked. */
function stateTime(l: LoopView): number {
  const at = l.state === "closed" || l.state === "resolved" ? l.closed : l.state === "parked" ? l.learnedAt : (l.reopened ?? l.opened);
  return Date.parse(at ?? "");
}

/**
 * The loops a query asks for, sorted by (opened, key) ascending, cut to `limit`; `total` is the
 * count before the cut. Without `since`, closed and resolved loops older than 30 days are left out.
 */
export function selectLoops(loops: LoopView[], q: LoopQuery, now: Date): { loops: LoopView[]; total: number } {
  const since = q.since !== undefined ? Date.parse(q.since) : undefined;
  const finishedFrom = now.getTime() - FINISHED_WINDOW_DAYS * 86_400_000;
  const client = q.client !== undefined ? clientKey(q.client) : undefined;
  const kept = loops.filter((l) => {
    if (!q.states.includes(l.state)) return false;
    if (client !== undefined && clientKey(l.client) !== client) return false;
    if (since !== undefined) return stateTime(l) >= since;
    if (l.state === "closed" || l.state === "resolved") return stateTime(l) >= finishedFrom;
    return true;
  });
  kept.sort((a, b) => (Date.parse(a.opened) - Date.parse(b.opened)) || codePoint(a.key, b.key));
  return { loops: kept.slice(0, q.limit), total: kept.length };
}

// --- C2: the key and its generations ---

export type Sighting = { kind: "create" | "evidence_add" | "ignore" | "suppressed" | "new_generation"; key: string };

/** 1 for the base key itself, n for `<base>:<n>` (n ≥ 2, no leading zero), null for anything else. */
export function generationOf(base: string, key: string): number | null {
  if (key === base) return 1;
  if (!key.startsWith(`${base}:`)) return null;
  const rest = key.slice(base.length + 1);
  return /^[1-9]\d*$/.test(rest) && Number(rest) >= 2 ? Number(rest) : null;
}

/**
 * What to do with a loop the model calls new, whose base key (the opener id, or `<opener>:b` for a
 * second ask in one message) may already exist. The newest generation decides: open gets
 * evidence_add; parked gets nothing written; closed or resolved is a suppressed re-sighting unless
 * a cited message is later than the close, which makes generation n+1. A time nobody can read is
 * never later.
 */
export function classifySighting(baseKey: string, cited: { id: string; at: string }[], loops: Pick<LoopView, "key" | "state" | "closed">[]): Sighting {
  let latest: Pick<LoopView, "key" | "state" | "closed"> | null = null;
  let n = 0;
  for (const l of loops) {
    const g = generationOf(baseKey, l.key);
    if (g !== null && g > n) [latest, n] = [l, g];
  }
  if (!latest) return { kind: "create", key: baseKey };
  if (latest.state === "open") return { kind: "evidence_add", key: latest.key };
  if (latest.state === "parked") return { kind: "ignore", key: latest.key };
  const end = Date.parse(latest.closed ?? "");
  const later = !Number.isNaN(end) && cited.some((c) => isInstant(c.at) && Date.parse(c.at) > end);
  return later ? { kind: "new_generation", key: `${baseKey}:${n + 1}` } : { kind: "suppressed", key: latest.key };
}

/** A loop's evidence after a re-sighting, and whether it differs from what is stored (write only when it does). */
export function mergeEvidence(stored: string[], added: string[]): { evidence: string[]; changed: boolean } {
  const before = cleanEvidence(stored);
  const evidence = cleanEvidence([...before, ...added]);
  return { evidence, changed: evidence.length !== before.length || evidence.some((id, i) => id !== before[i]) };
}

// --- C5: may this message close this loop? ---

export type ClosingMessage = {
  id: string; at: string;
  channelId?: string | null; parentId?: string | null; channel?: string | null;
  authorId?: string | null; authorName?: string | null;
};
export type Members = { ids: string[]; names: string[] };
export type Weak = "channel_name" | "author_name";
export type CloseVerdict =
  | { ok: true; weak: Weak[] }
  | { ok: false; reason: "not_in_window" | "wrong_channel" | "bad_time" | "too_early" | "before_reopen" | "not_member" };

const given = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const nameKey = (v: unknown) => String(v ?? "").trim().replace(/^#/, "").trim().toLowerCase();

/**
 * Whether a cited message may close a loop (C5): it is in the window, in the loop's channel (by
 * channel id or, for a thread, parent id; by name only when the message carries no id), strictly
 * later than the opening and than any reopening, and written by a member (by Discord id; by name
 * only when the message carries no author id). Fallbacks are listed in `weak` for the caller to log.
 */
export function acceptClose(loop: Pick<LoopView, "channel" | "channelId" | "opened" | "reopened">, msg: ClosingMessage | undefined, members: Members): CloseVerdict {
  if (!msg) return { ok: false, reason: "not_in_window" };
  const weak: Weak[] = [];
  if (given(loop.channelId) && (given(msg.channelId) || given(msg.parentId))) {
    const want = loop.channelId.trim();
    if (msg.channelId?.trim() !== want && msg.parentId?.trim() !== want) return { ok: false, reason: "wrong_channel" };
  } else {
    if (!given(msg.channel) || nameKey(msg.channel) !== nameKey(loop.channel)) return { ok: false, reason: "wrong_channel" };
    weak.push("channel_name");
  }
  if (!isInstant(msg.at)) return { ok: false, reason: "bad_time" };
  const t = Date.parse(msg.at);
  if (!(t > Date.parse(loop.opened))) return { ok: false, reason: "too_early" };
  if (loop.reopened !== null && !(t > Date.parse(loop.reopened))) return { ok: false, reason: "before_reopen" };
  if (given(msg.authorId)) {
    if (!members.ids.some((id) => id.trim() === msg.authorId!.trim())) return { ok: false, reason: "not_member" };
  } else {
    const names = new Set(members.names.map(nameKey).filter(Boolean));
    if (!names.has(nameKey(msg.authorName))) return { ok: false, reason: "not_member" };
    weak.push("author_name");
  }
  return { ok: true, weak };
}
