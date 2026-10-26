/**
 * Open loops (plan 5): the state line each loop writes to the ledger, and the rules that read it
 * back. One ledger subject per loop (`loop:<key>`), one line per state change; the newest line
 * nobody has superseded is the loop's state. Pure: lines and facts in, plain objects out, no clock
 * of its own (callers pass `now`), no I/O, so every rule is tested directly.
 *
 * C1 (the line and the key grammar) and C3 (what /browse/api/loops returns) are written in the
 * plan; this file is their reference implementation. The job's sanitiser is held to it by
 * tests/fixtures/c1-sanitise.json. C2 and C5 (generations, what may close a loop) belong to the
 * job (plan v3.1 addendum). A line that cannot be read is reported as unreadable, never dropped.
 */
import type { Fact } from "./ports/mod.ts";

export const LOOP_PREFIX = "loop:";
export const LOOP_TYPES = ["unanswered_question", "unkept_promise", "stale_followup", "unticketed_ask"] as const;
export type LoopType = typeof LOOP_TYPES[number];
export const LOOP_STATES = ["open", "parked", "closed", "resolved"] as const;
export type LoopState = typeof LOOP_STATES[number];

/**
 * The key grammar, one owner (addendum, row 30): the opener's Discord message id (17 to 20 digits),
 * an optional letter for a second ask in one message, an optional generation of 1 to 3 digits.
 * The longest key is 26 characters. A subject or a line with any other key is unreadable.
 */
export const KEY_RE = /^\d{17,20}(:[a-z])?(:\d{1,3})?$/;

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

/**
 * An ISO 8601 date or instant whose calendar date exists. Date.parse rolls 2026-02-30 over to
 * 2 March; a reader in another language refuses it; so it is refused here too (row 15).
 */
export function isInstant(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
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
  if (!KEY_RE.test(f.key)) return `key "${f.key.slice(0, 40)}" does not match the key grammar`;
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
 * A subject whose key is outside KEY_RE is unreadable (row 19): no button and no job could act on it.
 */
export function readLoop(subject: string, history: Fact[]): Read {
  const key = subject.startsWith(LOOP_PREFIX) ? subject.slice(LOOP_PREFIX.length) : "";
  const bad = (lineId: string, reason: string): Read => ({ ok: false, unreadable: { subject, lineId, reason } });
  const heads = history.filter((f) => !f.supersededBy).sort(newestFirst);
  const newest = heads[0] ?? [...history].sort(newestFirst)[0];
  if (!KEY_RE.test(key)) return bad(newest?.id ?? "", `key "${key.slice(0, 40)}" does not match the key grammar`);
  if (!heads.length) return bad(newest?.id ?? "", "every line is superseded; no current line");
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
  // A press's own clock (or a hand-written future time) must not decide when the loop finished (row 17).
  if (line.tag === "RESOLVED") Object.assign(loop, { closed: earlier(line.resolved, head.learnedAt), byUser: line.byUser, byName: line.byName, note: line.note });
  if (line.tag === "PARKED") Object.assign(loop, { until: line.until, byUser: line.byUser, byName: line.byName, note: line.note });
  return { ok: true, loop };
}

/** The earlier of two instants, as written. */
const earlier = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);

// --- the query (C3, with the v3.1 addendum) ---

export type LoopQuery = { states: LoopState[]; since?: string; client?: string; key?: string; offset: number; limit: number };

/**
 * The route's parameters checked. state: open (the default), parked, closed, resolved or all; with
 * `key` the default is all, so a press re-reading its loop finds it in whatever state it is now.
 * since: ISO 8601. key: KEY_RE. offset: a whole number. Anything else is an Error (a 400).
 */
export function loopQuery(p: { state?: string; since?: string; client?: string; key?: string; offset?: string; limit: number }): LoopQuery {
  if (p.key !== undefined && !KEY_RE.test(p.key)) throw new Error(`key must match the key grammar (a Discord message id, then optional :letter and :generation), got "${p.key.slice(0, 40)}"`);
  const state = p.state ?? (p.key !== undefined ? "all" : "open");
  let states: LoopState[];
  if (state === "all") states = [...LOOP_STATES];
  else if ((LOOP_STATES as readonly string[]).includes(state)) states = [state as LoopState];
  else throw new Error(`state must be one of ${LOOP_STATES.join(", ")} or all, got "${state.slice(0, 40)}"`);
  if (p.since !== undefined && !isInstant(p.since)) throw new Error(`since must be an ISO 8601 timestamp, got "${p.since.slice(0, 40)}"`);
  if (p.offset !== undefined && !/^\d+$/.test(p.offset)) throw new Error(`offset must be a whole number ≥ 0, got "${p.offset.slice(0, 40)}"`);
  const client = p.client?.trim() || undefined;
  const limit = Number.isFinite(p.limit) ? Math.max(0, Math.floor(p.limit)) : 0;
  return {
    states, ...(p.since !== undefined ? { since: p.since } : {}), ...(client ? { client } : {}), ...(p.key !== undefined ? { key: p.key } : {}),
    offset: p.offset !== undefined ? Number(p.offset) : 0, limit,
  };
}

const clientKey = (c: string) => c.trim().toLowerCase().replace(/^client:/, "");
const finished = (l: LoopView) => l.state === "closed" || l.state === "resolved";

/**
 * The loops a query asks for, sorted by (opened instant, key in code-point order), the page at
 * `offset` of `limit`; `total` counts every match. `since` narrows closed and resolved loops only,
 * by when they finished; open and parked loops ignore it (row 14). Without `since`, finished loops
 * older than 30 days are left out, unless one loop is asked for by `key`.
 */
export function selectLoops(loops: LoopView[], q: LoopQuery, now: Date): { loops: LoopView[]; total: number } {
  const from = q.since !== undefined ? Date.parse(q.since) : q.key !== undefined ? undefined : now.getTime() - FINISHED_WINDOW_DAYS * 86_400_000;
  const client = q.client !== undefined ? clientKey(q.client) : undefined;
  const kept = loops.filter((l) => {
    if (!q.states.includes(l.state)) return false;
    if (q.key !== undefined && l.key !== q.key) return false;
    if (client !== undefined && clientKey(l.client) !== client) return false;
    if (from !== undefined && finished(l)) return Date.parse(l.closed ?? "") >= from;
    return true;
  });
  kept.sort((a, b) => (Date.parse(a.opened) - Date.parse(b.opened)) || codePoint(a.key, b.key));
  return { loops: kept.slice(q.offset, q.offset + q.limit), total: kept.length };
}

