/**
 * The loops assistant ("PA") in the capture bot. `/loops` lists what the open-loops job believes is
 * still owed, six to a page, only to the person who asked; a button on each loop resolves, parks,
 * unparks or reopens it, which writes one line to the ledger (plan 5, contracts C1, C3, C4, C6).
 *
 * Everything here is pure logic over an injected `io` (Discord REST, the /browse/api/loops read,
 * the /mcp write, the log, the clock), so every path is tested with fakes. entry/discord-capture.ts
 * builds the real `io` from writer/discord-rest.ts and hands over each INTERACTION_CREATE.
 *
 * Rules this file keeps:
 *  - Nobody outside PA_USERS causes a read or a write; they get an ephemeral "not permitted".
 *  - Every interaction is acknowledged before anything is read or written (Discord allows 3 s).
 *  - `onInteraction` and `registerCommands` never reject: the capture bot must not die of the PA.
 *  - Every failure is one log line with an event name; nothing pings anyone (`parse: []`).
 */
import { HttpError, type McpAnswer, TimeoutError } from "./discord-rest.ts";

export const PAGE_SIZE = 6;
/** A park records an `until` this far ahead (C1 needs one; the button has no date input). */
export const PARK_DAYS = 7;
/** state:closed shows loops closed or resolved this recently (plan 5, Lane C item 3). */
export const CLOSED_VIEW_DAYS = 14;
/** A press on a closed or resolved loop re-reads this far back, comfortably wider than the view. */
const REREAD_DAYS = 30;
const DAY = 86_400_000;
const MAX_CONTENT = 2000;
/** A list leaves room under Discord's 2,000 for the status line a later press adds. */
const LIST_BUDGET = 1900;

// ---------- configuration (C6) ----------

export type PaConfig = { enabled: boolean; users: ReadonlySet<string> };

/** A comma-separated id list; unset or blank is `undefined` (meaning "no list"), never an empty set. */
export function parseIdList(s: string | undefined): Set<string> | undefined {
  const ids = (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : undefined;
}

/** PA_ENABLED is on only when it says so; PA_USERS unset means nobody is permitted. */
export function paConfig(enabled: string | undefined, users: string | undefined): PaConfig {
  return { enabled: /^(true|1|yes|on)$/i.test((enabled ?? "").trim()), users: parseIdList(users) ?? new Set() };
}

/** DISCORD_CAPTURE_GUILDS: no list means every guild, as before; with a list, only those. */
export function guildAllowed(allow: ReadonlySet<string> | undefined, guild: string | undefined): boolean {
  return !allow || (guild !== undefined && allow.has(guild));
}

/** The allowlist as a check that reports each skipped guild once (a DM or an unresolved channel is "@me" or "unknown"). */
export function makeGuildFilter(allow: ReadonlySet<string> | undefined, onSkip: (guild: string) => void): (guild?: string) => boolean {
  const told = new Set<string>();
  return (guild) => {
    if (guildAllowed(allow, guild)) return true;
    const name = guild ?? "unknown";
    if (!told.has(name)) {
      told.add(name);
      try {
        onSkip(name);
      } catch { /* the log is a courtesy */ }
    }
    return false;
  };
}

// ---------- shapes ----------

export type LoopState = "open" | "parked" | "closed" | "resolved";

/** One loop as /browse/api/loops returns it (C3). Only `key`, `lineId` and `state` are relied on to exist. */
export type Loop = {
  key: string;
  subject?: string;
  lineId: string;
  state: LoopState;
  client?: string | null;
  type?: string | null;
  owner?: string | null;
  channel?: string | null;
  channelId?: string | null;
  opened?: string | null;
  reopened?: string | null;
  title?: string | null;
  summary?: string | null;
  evidence?: string[] | null;
  proof?: string | null;
  closed?: string | null;
  byMessage?: string | null;
  byUser?: string | null;
  byName?: string | null;
  until?: string | null;
  note?: string | null;
  fork?: boolean;
  learnedAt?: string | null;
};

export type DiscordUser = { id: string; username: string; global_name?: string | null };
export type ComponentButton = { type: number; style?: number; label?: string; custom_id?: string; disabled?: boolean; url?: string };
export type ComponentRow = { type: number; components: ComponentButton[] };
export type InteractionData = {
  name?: string;
  options?: { name: string; type?: number; value?: unknown; focused?: boolean }[];
  custom_id?: string;
  component_type?: number;
};
export type Interaction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: InteractionData;
  message?: { content?: string; components?: ComponentRow[] };
};

export type PaIo = {
  /** Discord REST: parsed JSON or undefined. Throws HttpError or TimeoutError. */
  discord: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** GET /browse/api/loops with this query, parsed. */
  loops: (query: Record<string, string>) => Promise<unknown>;
  /** capture_thought as `actor`. */
  capture: (actor: string, args: Record<string, unknown>) => Promise<McpAnswer>;
  log: (fields: Record<string, unknown>) => unknown;
  now: () => Date;
};

// ---------- the ledger line (C1) ----------

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;

/** At most `max` UTF-16 units, never half an emoji. */
function cutSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out;
}

/** C1 `sanitise`: `|` and line breaks become spaces, other control characters go, whitespace collapses; then at most `max`. */
export function sanitise(text: unknown, max = Infinity): string {
  const s = String(text ?? "").replace(/\|/g, " ").replace(LINE_BREAKS, " ").replace(CONTROLS, "").replace(/\s+/g, " ").trim();
  return Number.isFinite(max) ? cutSafe(s, max).trimEnd() : s;
}

const line = (tag: string, fields: [string, string][]) => [tag, ...fields.map(([k, v]) => `${k}=${v}`)].join(" | ");

export function resolvedLine(key: string, byUser: string, byName: string, at: Date, note: string): string {
  return line("RESOLVED/1", [["key", sanitise(key)], ["by_user", sanitise(byUser)], ["by_name", sanitise(byName)], ["resolved", at.toISOString()], ["note", sanitise(note, 300)]]);
}

export function parkedLine(key: string, byUser: string, byName: string, until: string, note: string): string {
  return line("PARKED/1", [["key", sanitise(key)], ["by_user", sanitise(byUser)], ["by_name", sanitise(byName)], ["until", sanitise(until)], ["note", sanitise(note, 300)]]);
}

/** At most eight evidence ids; over eight, the oldest (smallest snowflake) go and the rest keep their order. */
function newestEight(ids: unknown): string[] {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => sanitise(x).replace(/[,\s]/g, "")).filter(Boolean))];
  if (list.length <= 8) return list;
  const big = (s: string) => {
    try {
      return BigInt(s);
    } catch {
      return -1n;
    }
  };
  const keep = new Set([...list].sort((a, b) => (big(a) < big(b) ? -1 : big(a) > big(b) ? 1 : 0)).slice(-8));
  return list.filter((id) => keep.has(id));
}

/** An OPEN line rebuilt from a loop record, with `reopened` as given (null writes "-"). Refuses a record that lacks what OPEN needs. */
export function openLine(l: Loop, reopened: string | null): string {
  const missing = (["title", "type", "opened"] as const).filter((f) => !sanitise(l[f]));
  if (missing.length) throw new Error(`loop ${l.key} lacks ${missing.join(", ")}; an OPEN line cannot be rebuilt from it`);
  return line("OPEN/1", [
    ["key", sanitise(l.key)],
    ["client", sanitise(l.client) || "internal"],
    ["type", sanitise(l.type)],
    ["owner", sanitise(l.owner) || "unclear"],
    ["channel", sanitise(l.channel) || "-"],
    ["channel_id", sanitise(l.channelId) || "-"],
    ["opened", sanitise(l.opened)],
    ["reopened", reopened ? sanitise(reopened) : "-"],
    ["title", sanitise(l.title, 120)],
    ["summary", sanitise(l.summary, 300)],
    ["evidence", newestEight(l.evidence).join(",")],
  ]);
}

const PROOF_RE = /^https:\/\/discord\.com\/channels\/([^/\s]+)\/(\d+)\/(\d+)$/;

/** The opener's own source, from its link: an OPEN line carries the opener's source and proof (C1). */
export function openerSource(proof: unknown): string | undefined {
  const m = PROOF_RE.exec(String(proof ?? ""));
  return m ? `discord:${m[1]}/${m[2]}/${m[3]}` : undefined;
}

// ---------- reading loops (C3) ----------

const STATES = new Set<string>(["open", "parked", "closed", "resolved"]);

type Read = { loops: Loop[]; unreadable: number; total: number };

/** The /loops reply, defensively: an entry without a key, a line id or a known state is counted as unreadable, never shown. */
function readLoops(value: unknown): Read {
  const v = value as { loops?: unknown; unreadable?: unknown; total?: unknown } | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.loops)) throw new Error("unexpected answer from /browse/api/loops");
  const loops = (v.loops as unknown[]).filter((l): l is Loop => {
    const x = l as Loop | null;
    return !!x && typeof x === "object" && typeof x.key === "string" && typeof x.lineId === "string" && STATES.has(x.state);
  });
  const unreadable = (Array.isArray(v.unreadable) ? v.unreadable.length : 0) + (v.loops.length - loops.length);
  return { loops, unreadable, total: typeof v.total === "number" ? v.total : loops.length };
}

type Pos = { at: number; key: string };
const posOf = (l: Loop): Pos => ({ at: Date.parse(l.opened ?? "") || 0, key: l.key });
/** The list's order, (opened, key) ascending, as the route promises; the bot sorts again so paging never depends on it. */
const cmp = (a: Pos, b: Pos) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

type View = "o" | "p" | "c";
const VIEW_OF: Record<string, View> = { open: "o", parked: "p", closed: "c" };
const VIEW_NAME: Record<View, string> = { o: "open", p: "parked", c: "closed" };
const VIEW_TITLE: Record<View, string> = { o: "Open loops", p: "Parked loops", c: "Closed and resolved, last 14 days" };
const EMPTY: Record<View, string> = { o: "nothing open.", p: "nothing parked.", c: "nothing closed or resolved in the last 14 days." };

async function fetchView(io: PaIo, view: View, client: string | null, now: Date): Promise<Read> {
  const states: LoopState[] = view === "o" ? ["open"] : view === "p" ? ["parked"] : ["closed", "resolved"];
  const since = view === "c" ? new Date(now.getTime() - CLOSED_VIEW_DAYS * DAY).toISOString() : undefined;
  const out: Read = { loops: [], unreadable: 0, total: 0 };
  for (const state of states) {
    const r = readLoops(await io.loops({ state, ...(since ? { since } : {}), ...(client ? { client } : {}) }));
    out.loops.push(...r.loops.filter((l) => l.state === state));
    out.unreadable = Math.max(out.unreadable, r.unreadable); // the same unreadable lines come back with every state
    out.total += r.total;
  }
  out.loops.sort((a, b) => cmp(posOf(a), posOf(b)));
  return out;
}

/** The loop as it stands now, if it is still in the state the button expected. */
async function findLoop(io: PaIo, expected: LoopState, key: string, now: Date): Promise<Loop | undefined> {
  const since = expected === "closed" || expected === "resolved" ? new Date(now.getTime() - REREAD_DAYS * DAY).toISOString() : undefined;
  return readLoops(await io.loops({ state: expected, ...(since ? { since } : {}) })).loops.find((l) => l.key === key && l.state === expected);
}

// ---------- custom_id ----------

const KEY_RE = /^\d{1,25}(?::[0-9a-z]{1,8}){0,2}$/;
const CLIENT_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
type Act = "R" | "P" | "U" | "O";
/** Which loop states each action is offered on: Resolve on open and parked, Park on open, Unpark on parked, Reopen on closed and resolved. */
const ACT_ON: Record<Act, string> = { R: "op", P: "o", U: "p", O: "cr" };
const CODE: Record<LoopState, string> = { open: "o", parked: "p", closed: "c", resolved: "r" };
const STATE_OF: Record<string, LoopState> = { o: "open", p: "parked", c: "closed", r: "resolved" };

type Parsed =
  | { kind: "act"; act: Act; state: LoopState; n: number; key: string }
  | { kind: "nav"; dir: "N" | "P"; view: View; client: string | null; cursor: Pos };

const actionId = (act: Act, state: LoopState, n: number, key: string) => `pa1;a;${act};${CODE[state]};${n};${key}`;
const navId = (dir: "N" | "P", view: View, client: string | null, at: Pos | undefined) => `pa1;n;${dir};${view};${client ?? "-"};${at ? at.at.toString(36) : "0"};${at ? at.key : "-"}`;

/** A button's custom_id back to what it means, or null for anything this bot did not make. */
export function parseCustomId(id: unknown): Parsed | null {
  if (typeof id !== "string" || id.length > 100) return null;
  const f = id.split(";");
  if (f[0] !== "pa1") return null;
  if (f[1] === "a" && f.length === 6) {
    const [, , act, st, n, key] = f;
    if (!Object.hasOwn(ACT_ON, act) || st.length !== 1 || !ACT_ON[act as Act].includes(st) || !/^\d{1,3}$/.test(n) || !KEY_RE.test(key)) return null;
    return { kind: "act", act: act as Act, state: STATE_OF[st], n: Number(n), key };
  }
  if (f[1] === "n" && f.length === 7) {
    const [, , dir, view, client, at, key] = f;
    if ((dir !== "N" && dir !== "P") || !(view === "o" || view === "p" || view === "c")) return null;
    if ((client !== "-" && !CLIENT_RE.test(client)) || !/^[0-9a-z]{1,12}$/.test(at) || (key !== "-" && !KEY_RE.test(key))) return null;
    return { kind: "nav", dir, view, client: client === "-" ? null : client, cursor: { at: parseInt(at, 36), key: key === "-" ? "" : key } };
  }
  return null;
}

/** The free-text client option as the slug the route filters on: lower case, [a-z0-9._-], at most 40. */
export function clientSlug(v: unknown): string | null {
  const s = String(v ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-._]+/, "").slice(0, 40).replace(/[-._]+$/, "");
  return s || null;
}

// ---------- rendering ----------

/** Markdown and mention characters in text that came from a channel are shown, never interpreted. */
const esc = (s: string) => s.replace(/[\\*_~`|>#[\]()<@]/g, "\\$&");

export function ageText(from: string | null | undefined, now: Date): string {
  const t = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(t)) return "?";
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

type Widths = { title: number; name: number };
const WIDTHS: Widths[] = [{ title: 120, name: 40 }, { title: 60, name: 24 }, { title: 30, name: 16 }];

function itemLine(n: number, l: Loop, now: Date, w: Widths): string {
  const t = (s: unknown, max: number) => esc(sanitise(s, max));
  const parts = [`${n}. ${t(l.title || "(untitled)", w.title)}`, `#${t(l.channel || "?", w.name)}`];
  if (l.state === "open") parts.push(l.owner && l.owner !== "unclear" ? `waiting on ${t(l.owner, w.name)}` : "owner unclear", ageText(l.reopened || l.opened, now));
  if (l.state === "parked") parts.push(`parked until ${t(l.until || "?", 24)}${l.byName ? ` by ${t(l.byName, w.name)}` : ""}`);
  if (l.state === "closed") parts.push(`closed in channel${l.closed ? ` ${ageText(l.closed, now)} ago` : ""}`);
  if (l.state === "resolved") parts.push(`resolved${l.byName ? ` by ${t(l.byName, w.name)}` : ""}${l.closed ? ` ${ageText(l.closed, now)} ago` : ""}`);
  if (l.fork) parts.push("⚠ two current lines");
  if (!KEY_RE.test(l.key)) parts.push("no buttons: unusual key");
  if (typeof l.proof === "string" && PROOF_RE.test(l.proof)) parts.push(l.proof);
  return parts.join(" · ");
}

/**
 * Next: the six after the last loop shown. Prev: up to six strictly before the first loop shown,
 * so going back never repeats a loop from the page you came from. The cursor is a position
 * (opened, key), not an index, so loops added or resolved between presses shift nothing.
 * Nothing left in that direction: the last (or first) page.
 */
function pageOf(sorted: Loop[], cursor: Pos | null, dir: "N" | "P"): { start: number; items: Loop[] } {
  if (cursor && dir === "N") {
    const i = sorted.findIndex((l) => cmp(posOf(l), cursor) > 0);
    const start = i < 0 ? Math.max(0, sorted.length - PAGE_SIZE) : i;
    return { start, items: sorted.slice(start, start + PAGE_SIZE) };
  }
  if (cursor) {
    const found = sorted.findIndex((l) => cmp(posOf(l), cursor) >= 0);
    const end = found < 0 ? sorted.length : found;
    if (end > 0) {
      const start = Math.max(0, end - PAGE_SIZE);
      return { start, items: sorted.slice(start, end) };
    }
  }
  return { start: 0, items: sorted.slice(0, PAGE_SIZE) };
}

function buttonsFor(view: View, client: string | null, sorted: Loop[], start: number, items: Loop[]): ComponentRow[] {
  const groups = items.map((l, i): ComponentButton[] => {
    const n = start + i + 1;
    if (!KEY_RE.test(l.key)) return [];
    const b = (act: Act, label: string, style: number): ComponentButton => ({ type: 2, style, label: `${label} ${n}`, custom_id: actionId(act, l.state, n, l.key) });
    if (l.state === "open") return [b("R", "Resolve", 3), b("P", "Park", 2)];
    if (l.state === "parked") return [b("R", "Resolve", 3), b("U", "Unpark", 2)];
    return [b("O", "Reopen", 2)];
  });
  const rows: ComponentRow[] = [];
  for (const g of groups.filter((x) => x.length)) {
    const last = rows.at(-1);
    if (last && last.components.length + g.length <= 5) last.components.push(...g);
    else rows.push({ type: 1, components: [...g] });
  }
  if (items.length) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 2, label: "Prev", custom_id: navId("P", view, client, posOf(items[0])), disabled: start === 0 },
        { type: 2, style: 2, label: "Next", custom_id: navId("N", view, client, posOf(items[items.length - 1])), disabled: start + items.length >= sorted.length },
      ],
    });
  }
  return rows;
}

type Body = { content: string; components: ComponentRow[] };

function renderList(view: View, client: string | null, data: Read, cursor: Pos | null, dir: "N" | "P", now: Date): Body {
  const { start, items } = pageOf(data.loops, cursor, dir);
  const head = `**${VIEW_TITLE[view]}**${client ? ` · ${esc(client)}` : ""}`;
  const top = items.length ? `${head} · ${start + 1}–${start + items.length} of ${data.loops.length}` : `${head} · ${EMPTY[view]}`;
  const foot: string[] = [];
  if (data.unreadable) foot.push(`${data.unreadable} ledger line${data.unreadable === 1 ? "" : "s"} could not be read; see /browse.`);
  if (data.total > data.loops.length) foot.push(`Showing ${data.loops.length} of ${data.total}; narrow it with client:.`);
  let content = "";
  for (const w of WIDTHS) {
    content = [top, ...items.map((l, i) => itemLine(start + i + 1, l, now, w)), ...foot].join("\n");
    if (content.length <= LIST_BUDGET) break;
  }
  return { content: cutSafe(content, LIST_BUDGET), components: buttonsFor(view, client, data.loops, start, items) };
}

const STATUS_RE = /^(›|⚠) /;

/** The message a button sat on, with a status line on top, the item struck through (when the press took), and that loop's buttons dead. */
function markMessage(msg: Interaction["message"], n: number, key: string, status: string, strike: boolean): Body {
  const lines = (msg?.content ?? "").split("\n").filter((l, i) => !(i === 0 && STATUS_RE.test(l)));
  const marked = lines.map((l) => (strike && l.startsWith(`${n}. `) ? `~~${l}~~` : l));
  const components = (msg?.components ?? []).map((row) => ({
    type: row.type,
    components: (row.components ?? []).map((b) => {
      const p = parseCustomId(b.custom_id);
      return p?.kind === "act" && p.key === key ? { ...b, disabled: true } : b;
    }),
  }));
  return { content: cutSafe([status, ...marked].join("\n").trimEnd(), MAX_CONTENT), components };
}

// ---------- talking to Discord ----------

const NOT_PERMITTED = "You are not permitted to use the loops assistant.";
const NOT_AVAILABLE = "That is not available.";
const CHANGED = "⚠ This loop changed since you listed it; run /loops again.";
const WRITE_TIMEOUT = "⚠ Timed out: the ledger did not answer; check /loops before retrying.";
const READ_TIMEOUT = "⚠ Grysstof did not answer in time; try /loops again.";
const NAV_TIMEOUT = "⚠ Grysstof did not answer in time; the page below is unchanged.";
const HELP = [
  "**/loops** lists what the bot believes is still owed in the Xactco channels: questions not answered, promises not kept, follow-ups not done. Oldest first, six to a page. Only you see it.",
  "**Resolve**: it is fine; the loop drops off the list and the morning post.",
  "**Park**: set it aside; it leaves the list and the morning post until you unpark it.",
  "`/loops state:parked`: parked loops, with **Unpark**.",
  "`/loops state:closed`: loops closed in channel or resolved in the last 14 days, with **Reopen**.",
  "`/loops client:servest`: one client only.",
  "Each press writes one line to Grysstof's ledger. Nothing is posted in a channel and nobody is pinged.",
].join("\n");
const DONE: Record<Act, string> = { R: "Resolved", P: "Parked", U: "Unparked", O: "Reopened" };
const NOTE: Record<Act, string> = { R: "pressed Resolve in /loops", P: "pressed Park in /loops", U: "pressed Unpark in /loops", O: "pressed Reopen in /loops" };

async function say(io: Pick<PaIo, "log">, fields: Record<string, unknown>): Promise<void> {
  try {
    await io.log(fields);
  } catch { /* the log is a courtesy */ }
}

const short = (e: unknown) => sanitise(e instanceof Error ? e.message : String(e), 160);

/** The interaction callback. False when it failed: then nothing else may happen for this interaction. */
async function callback(io: PaIo, ix: Interaction, body: unknown, user: DiscordUser | undefined): Promise<boolean> {
  try {
    await io.discord("POST", `/interactions/${ix.id}/${ix.token}/callback`, body);
    return true;
  } catch (e) {
    await say(io, { event: "pa.failed", what: "acknowledge", type: ix.type, user: user?.id, error: String(e) });
    return false;
  }
}

const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

/** Finish the deferred reply (or the message a button sat on). */
async function edit(io: PaIo, ix: Interaction, body: Body, user: DiscordUser): Promise<void> {
  try {
    await io.discord("PATCH", `/webhooks/${ix.application_id}/${ix.token}/messages/@original`, { ...body, flags: 4, allowed_mentions: { parse: [] } });
  } catch (e) {
    await say(io, { event: "pa.failed", what: "edit", user: user.id, error: String(e) });
  }
}

/** The answer for an interaction nobody here handles: component 6, command 4, autocomplete 8, modal 4; any other type gets none. */
function defaultAnswer(type: number, text: string): unknown | undefined {
  if (type === 3) return { type: 6 };
  if (type === 4) return { type: 8, data: { choices: [] } };
  if (type === 2 || type === 5) return ephemeral(text);
  return undefined;
}

// ---------- the state machine ----------

/**
 * Handle one INTERACTION_CREATE. Never rejects: every failure is acknowledged where it still can
 * be, logged once, and swallowed, so the capture bot that calls this cannot be taken down by it.
 */
export async function onInteraction(cfg: PaConfig, io: PaIo, ix: Interaction): Promise<void> {
  try {
    await handle(cfg, io, ix);
  } catch (e) {
    await say(io, { event: "pa.failed", what: "interaction", error: String(e) });
  }
}

async function handle(cfg: PaConfig, io: PaIo, ix: Interaction): Promise<void> {
  const user = ix.member?.user ?? ix.user;
  if (!cfg.enabled || !user?.id || !cfg.users.has(user.id)) {
    const reason = cfg.enabled ? "not permitted" : "disabled";
    const answer = cfg.enabled ? (ix.type === 4 ? { type: 8, data: { choices: [] } } : [2, 3, 5].includes(ix.type) ? ephemeral(NOT_PERMITTED) : undefined) : defaultAnswer(ix.type, NOT_AVAILABLE);
    if (answer) await callback(io, ix, answer, user);
    await say(io, { event: "pa.refused", reason, type: ix.type, user: user?.id, name: user?.username });
    return;
  }
  if (ix.type === 2 && (ix.data?.name === "loops" || ix.data?.name === "loops-help")) return await onCommand(io, ix, user);
  if (ix.type === 3) return await onComponent(io, ix, user);
  const answer = defaultAnswer(ix.type, NOT_AVAILABLE);
  if (answer) await callback(io, ix, answer, user);
  await say(io, { event: "pa.interaction_unknown", type: ix.type, name: ix.data?.name, user: user.id });
}

async function onCommand(io: PaIo, ix: Interaction, user: DiscordUser): Promise<void> {
  if (!(await callback(io, ix, { type: 5, data: { flags: 64 } }, user))) return;
  const name = ix.data?.name;
  if (name === "loops-help") {
    await say(io, { event: "pa.command", command: name, user: user.id, name: user.username });
    return await edit(io, ix, { content: HELP, components: [] }, user);
  }
  const opt = (o: string) => ix.data?.options?.find((x) => x.name === o)?.value;
  const view = VIEW_OF[String(opt("state") ?? "open")] ?? "o";
  const client = clientSlug(opt("client"));
  const now = io.now();
  let body: Body;
  try {
    const data = await fetchView(io, view, client, now);
    body = renderList(view, client, data, null, "N", now);
    await say(io, { event: "pa.command", command: name, user: user.id, name: user.username, view: VIEW_NAME[view], client, loops: data.loops.length, unreadable: data.unreadable });
  } catch (e) {
    const timedOut = e instanceof TimeoutError;
    body = { content: timedOut ? READ_TIMEOUT : `⚠ Could not read the loops: ${short(e)}`, components: [] };
    await say(io, { event: timedOut ? "pa.timeout" : "pa.failed", what: "list", user: user.id, view: VIEW_NAME[view], client, error: String(e) });
  }
  await edit(io, ix, body, user);
}

async function onComponent(io: PaIo, ix: Interaction, user: DiscordUser): Promise<void> {
  const p = parseCustomId(ix.data?.custom_id);
  if (!(await callback(io, ix, { type: 6 }, user))) return;
  if (!p) return await say(io, { event: "pa.interaction_unknown", type: 3, custom_id: String(ix.data?.custom_id ?? "").slice(0, 100), user: user.id });
  if (p.kind === "nav") return await onNav(io, ix, user, p);
  return await onPress(io, ix, user, p);
}

async function onNav(io: PaIo, ix: Interaction, user: DiscordUser, p: Extract<Parsed, { kind: "nav" }>): Promise<void> {
  const now = io.now();
  try {
    const data = await fetchView(io, p.view, p.client, now);
    await say(io, { event: "pa.press", action: p.dir === "N" ? "next" : "prev", user: user.id, name: user.username, view: VIEW_NAME[p.view], client: p.client });
    await edit(io, ix, renderList(p.view, p.client, data, p.cursor, p.dir, now), user);
  } catch (e) {
    const timedOut = e instanceof TimeoutError;
    await say(io, { event: timedOut ? "pa.timeout" : "pa.failed", what: "list", user: user.id, view: VIEW_NAME[p.view], error: String(e) });
    const lines = (ix.message?.content ?? "").split("\n").filter((l, i) => !(i === 0 && STATUS_RE.test(l)));
    const status = timedOut ? NAV_TIMEOUT : `⚠ Could not read the loops: ${short(e)}`;
    await edit(io, ix, { content: cutSafe([status, ...lines].join("\n").trimEnd(), MAX_CONTENT), components: ix.message?.components ?? [] }, user);
  }
}

function writeArgs(act: Act, l: Loop, ix: Interaction, user: DiscordUser, now: Date): Record<string, unknown> {
  const interaction = `discord:interaction/${ix.id}`;
  const base = { subject: `loop:${l.key}`, ...(typeof l.proof === "string" && l.proof ? { proof: l.proof } : {}), supersedes: l.lineId };
  if (act === "R") return { content: resolvedLine(l.key, user.id, user.username, now, NOTE.R), source: interaction, ...base };
  if (act === "P") {
    const until = new Date(now.getTime() + PARK_DAYS * DAY).toISOString().slice(0, 10);
    return { content: parkedLine(l.key, user.id, user.username, until, NOTE.P), source: interaction, ...base };
  }
  const reopened = act === "O" ? now.toISOString() : l.reopened ?? null;
  return { content: openLine(l, reopened), source: openerSource(l.proof) ?? interaction, ...base };
}

/**
 * The ledger refused because the line was superseded meanwhile ("Fact … is already superseded by …";
 * a guarded Postgres update may word its lost race differently, hence the bare word). "Supersedes"
 * in the wrong-subject refusal does not match; a false match only costs one re-read.
 */
const isStale = (a: McpAnswer) => a.isError && /\bsuperseded\b/i.test(a.text);

/**
 * A press: read the loop as it stands, write one line superseding its current line, and on a stale
 * refusal re-read once and retry only if the loop is still in the state the button expected.
 */
async function onPress(io: PaIo, ix: Interaction, user: DiscordUser, p: Extract<Parsed, { kind: "act" }>): Promise<void> {
  const now = io.now();
  // The gate only accepts [A-Za-z0-9._:@/-] as an actor and silently substitutes its default otherwise.
  const actor = `discord:${user.username.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}`;
  const logged = { action: DONE[p.act].toLowerCase().replace(/ed$/, ""), key: p.key, user: user.id, name: user.username };
  const finish = (status: string, strike: boolean) => edit(io, ix, markMessage(ix.message, p.n, p.key, status, strike), user);
  let stage = "read";
  try {
    let current = await findLoop(io, p.state, p.key, now);
    for (let attempt = 0; current; attempt++) {
      stage = "write";
      const answer = await io.capture(actor, writeArgs(p.act, current, ix, user, now));
      if (!answer.isError && /^Recorded fact /.test(answer.text)) {
        await say(io, { event: "pa.press", ...logged, outcome: "recorded", retried: attempt > 0, line: /^Recorded fact (\S+)/.exec(answer.text)?.[1], superseded: current.lineId });
        return await finish(`› ${DONE[p.act]} ${p.n}: ${esc(sanitise(current.title || p.key, 80))}`, true);
      }
      if (!isStale(answer)) throw new Error(answer.isError ? answer.text : `unexpected answer: ${answer.text}`);
      if (attempt > 0) break;
      stage = "read";
      const again = await findLoop(io, p.state, p.key, now);
      current = again && again.lineId !== current.lineId ? again : undefined;
    }
    await say(io, { event: "pa.press", ...logged, outcome: "changed", expected: p.state });
    await finish(CHANGED, false);
  } catch (e) {
    const timedOut = e instanceof TimeoutError;
    await say(io, { event: timedOut ? "pa.timeout" : "pa.failed", what: stage, ...logged, error: String(e), ...(e instanceof HttpError ? { status: e.status } : {}) });
    await finish(timedOut ? WRITE_TIMEOUT : `⚠ Could not record that: ${esc(short(e))}. Check /loops before retrying.`, false);
  }
}

// ---------- registration ----------

type CommandOption = { type: number; name: string; description: string; required?: boolean; max_length?: number; choices?: { name: string; value: string }[] };
type CommandDef = { name: string; type: number; description: string; options?: CommandOption[] };

/** The guild commands. No `default_member_permissions`: who may use them is PA_USERS, checked on every interaction. */
export const COMMANDS: CommandDef[] = [
  {
    name: "loops",
    type: 1,
    description: "What the bot believes is still owed, with buttons to resolve or park it. Only you see it.",
    options: [
      { type: 3, name: "client", description: "Only this client, by short name (for example servest)", required: false, max_length: 40 },
      {
        type: 3,
        name: "state",
        description: "Which loops: open (default), parked, or closed in the last 14 days",
        required: false,
        choices: [{ name: "open", value: "open" }, { name: "parked", value: "parked" }, { name: "closed", value: "closed" }],
      },
    ],
  },
  { name: "loops-help", type: 1, description: "What /loops shows and what its buttons do" },
];

/**
 * PUT the commands to each guild (an overwrite, so running it on every READY is harmless). Logs
 * the list Discord returns, or the failure with its status. True only when every guild took them.
 * Never rejects.
 */
export async function registerCommands(io: Pick<PaIo, "discord" | "log">, appId: string, guildIds: string[]): Promise<boolean> {
  try {
    if (!appId) {
      await say(io, { event: "pa.register_failed", hint: "READY carried no application id" });
      return false;
    }
    if (!guildIds.length) {
      await say(io, { event: "pa.register_failed", hint: "no guild to register in: none at READY, or none in DISCORD_CAPTURE_GUILDS" });
      return false;
    }
    let ok = true;
    for (const guild of guildIds) {
      try {
        const got = await io.discord("PUT", `/applications/${appId}/guilds/${guild}/commands`, COMMANDS);
        const commands = Array.isArray(got) ? (got as { id?: unknown; name?: unknown }[]).map((c) => ({ id: c?.id, name: c?.name })) : [];
        await say(io, { event: "pa.registered", guild, commands });
      } catch (e) {
        ok = false;
        const status = e instanceof HttpError ? e.status : undefined;
        await say(io, { event: "pa.register_failed", guild, status, error: String(e), ...(status === 403 ? { hint: "invite scope applications.commands missing" } : {}) });
      }
    }
    return ok;
  } catch {
    return false;
  }
}
