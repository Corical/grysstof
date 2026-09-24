/**
 * Helpers every Memory implementation needs and none should reinvent:
 * the input bounds the port promises, the id and timestamp guards, and the
 * summary tally. Adapter-side only; the core never sees this file.
 */
import type { RecentQuery, Summary, ThoughtMetadata } from "../../core/ports/mod.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/** Same text is the same thought: whitespace runs collapse, case folds. */
export const normalise = (content: string): string => content.replace(/\s+/g, " ").trim().toLowerCase();

/** SHA-256 hex of the normalised content, the shape the SQL schema's content_fingerprint takes. */
export async function fingerprint(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalise(content)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Port rule: `limit` is a whole number ≥ 0 (anything else, including ±Infinity, is 0); `minScore` is clamped into [0, 1] (NaN is 0, +Infinity is 1). */
export function bounds(opts: { limit: number; minScore: number }): { limit: number; minScore: number } {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
  const minScore = Number.isNaN(opts.minScore) ? 0 : Math.min(1, Math.max(0, opts.minScore));
  return { limit, minScore };
}

export const boundLimit = (limit: number): number => bounds({ limit, minScore: 0 }).limit;

/** A thought is dated to when it happened (metadata.occurred_at, set by capture for imports) when that is a real date, else to now. */
export function createdAtOf(metadata: ThoughtMetadata, now: string): string {
  const v = metadata.occurred_at;
  if (typeof v !== "string") return now;
  const t = Date.parse(v);
  return Number.isNaN(t) ? now : new Date(t).toISOString();
}

/** Port rule: an instant is ISO 8601 or absent; anything else is the caller's error, not a silent empty result. */
function parseInstant(name: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(value)) throw new Error(`${name} must be an ISO 8601 timestamp, got "${value}"`);
  return t;
}

export const parseSince = (since: string | undefined): number | null => parseInstant("since", since);
export const parseUntil = (until: string | undefined): number | null => parseInstant("until", until);

/** A channel name as the port compares it: trimmed, one leading # dropped, lower case. Anything but a non-blank string has no channel. */
export function channelKey(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.trim().replace(/^#/, "").trim().toLowerCase();
  return k || undefined;
}

/** Every `recent` filter except the time window, on one thought's metadata. */
export function matchesRecent(meta: ThoughtMetadata, q: RecentQuery): boolean {
  if (q.type !== undefined && meta.type !== q.type) return false;
  if (q.topic !== undefined && !(Array.isArray(meta.topics) && meta.topics.includes(q.topic))) return false;
  if (q.person !== undefined && !(Array.isArray(meta.people) && meta.people.includes(q.person))) return false;
  if (q.sourcePrefix !== undefined && !(typeof meta.source === "string" && meta.source.startsWith(q.sourcePrefix))) return false;
  if (q.channel !== undefined) {
    const want = channelKey(q.channel);
    if (want === undefined || channelKey(meta.channel) !== want) return false;
  }
  return true;
}

/**
 * The whole `recent` rule for memories that hold rows in process: filter,
 * window, order by created-at with `seq` (insertion order) breaking ties so
 * paging is stable and "oldest" is exactly "newest" reversed, then offset
 * and limit. Throws on a malformed since or until.
 */
export function recentWindow<R extends { createdAt: string; metadata: ThoughtMetadata; seq: number }>(rows: Iterable<R>, q: RecentQuery): R[] {
  const since = parseSince(q.since);
  const until = parseUntil(q.until);
  const limit = boundLimit(q.limit);
  const offset = boundLimit(q.offset ?? 0);
  const newestFirst = q.order !== "oldest";
  const at = (r: R) => Date.parse(r.createdAt);
  return [...rows]
    .filter((r) => matchesRecent(r.metadata, q))
    .filter((r) => (since === null || at(r) >= since) && (until === null || at(r) < until))
    .sort((a, b) => (at(a) - at(b) || a.seq - b.seq) * (newestFirst ? -1 : 1))
    .slice(offset, offset + limit);
}

/** Oldest and newest by created-at, whatever order the rows are held in. */
export function spanOf(createdAts: Iterable<string>): { oldest?: string; newest?: string } {
  let oldest: string | undefined, newest: string | undefined;
  for (const c of createdAts) {
    if (oldest === undefined || Date.parse(c) < Date.parse(oldest)) oldest = c;
    if (newest === undefined || Date.parse(c) > Date.parse(newest)) newest = c;
  }
  return oldest === undefined ? {} : { oldest, newest };
}

export function tally(s: Summary, m: ThoughtMetadata): void {
  if (typeof m.type === "string") s.types[m.type] = (s.types[m.type] ?? 0) + 1;
  if (Array.isArray(m.topics)) for (const t of m.topics) if (typeof t === "string") s.topics[t] = (s.topics[t] ?? 0) + 1;
  if (Array.isArray(m.people)) for (const p of m.people) if (typeof p === "string") s.people[p] = (s.people[p] ?? 0) + 1;
}
