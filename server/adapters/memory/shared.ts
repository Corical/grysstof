/**
 * Helpers every Memory implementation needs and none should reinvent:
 * the input bounds the port promises, the id and timestamp guards, and the
 * summary tally. Adapter-side only; the core never sees this file.
 */
import type { Summary, ThoughtMetadata } from "../../core/ports/mod.ts";

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

/** Port rule: `since` is ISO 8601 or absent; anything else is the caller's error, not a silent empty result. */
export function parseSince(since: string | undefined): number | null {
  if (since === undefined) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(since)) throw new Error(`since must be an ISO 8601 timestamp, got "${since}"`);
  return t;
}

export function tally(s: Summary, m: ThoughtMetadata): void {
  if (typeof m.type === "string") s.types[m.type] = (s.types[m.type] ?? 0) + 1;
  if (Array.isArray(m.topics)) for (const t of m.topics) if (typeof t === "string") s.topics[t] = (s.topics[t] ?? 0) + 1;
  if (Array.isArray(m.people)) for (const p of m.people) if (typeof p === "string") s.people[p] = (s.people[p] ?? 0) + 1;
}
