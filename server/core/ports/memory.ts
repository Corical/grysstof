/**
 * Memory: what the core needs from "the thing that remembers".
 *
 * Written from the six tools inward. The core needs to remember a thought,
 * recall thoughts like a piece of text, get one back by id, list recent ones
 * with simple filters, and summarise what it holds. That is the whole socket.
 *
 * What the core does NOT know and a memory may do however it likes: how
 * similarity is computed (vectors, keywords, an LLM), how duplicates are
 * detected, how counts are produced, where anything is stored.
 *
 * Semantics a memory must honour:
 *  - `scope.tenant` says whose memory this call touches. A single-tenant
 *    memory may ignore it; a multi-tenant memory must partition by it and
 *    never return another tenant's thoughts. `scope.actor` is who is asking;
 *    a memory may record it, never partition by it.
 *  - ids are opaque strings; the core only ever hands them back unchanged.
 *  - `remember` with content the memory already holds (by its own notion of
 *    "the same") returns the existing id with `alreadyKnown: true` and merges
 *    the new metadata into the stored one (shallow, new keys win).
 *  - `remember` rejects blank content (nothing but whitespace) with an Error;
 *    the core never sends it, a memory never stores it.
 *  - `recall` scores are in [0, 1], higher is closer; only thoughts with
 *    score strictly greater than `minScore` are returned, best first, at most
 *    `limit`.
 *  - Bounds: `limit` is a whole number ≥ 0 and 0 means "nothing"; a negative,
 *    fractional or non-finite limit is treated as 0 (fractional: rounded
 *    down). `minScore` is clamped into [0, 1] (so +Infinity matches nothing);
 *    a NaN `minScore` is 0.
 *    Every implementation applies these identically (adapters/memory/shared.ts).
 *  - `recent` orders by created-at (when the thought happened, which for
 *    imports is metadata.occurred_at, not when it was stored): newest first
 *    unless `order` is "oldest". Ties are broken by a key that is stable
 *    across calls, so `offset` paging never repeats or skips a thought and
 *    "oldest" is exactly "newest" reversed. Every given filter must match
 *    (`type` equals, `topic` is one of the thought's topics, `person` is one
 *    of its people, `since` is created-at-or-after, `until` is created
 *    strictly before, `channel` equals metadata.channel ignoring case, outer
 *    spaces and one leading #). `since` and `until` must be ISO 8601;
 *    anything else is rejected with an Error, never a silent empty result.
 *    `offset` is bounded exactly like `limit`.
 *  - `summary` never returns the thoughts themselves, only aggregates.
 *  - Errors are thrown as ordinary Errors with a message safe to show a user.
 *
 * Contract tests: server/tests/memory.contract.ts. Run them against any
 * implementation before calling it a memory.
 */

/**
 * Who a call is for. The gate produces it; nothing downstream accepts either
 * value from a caller. `tenant` partitions storage (a client, a person, an
 * organisation); `actor` is the agent or person acting, stamped on what they
 * write.
 */
export type Scope = { tenant: string; actor: string };

/** Stored alongside a thought. Keys are the ones the wider Open Brain ecosystem reads. */
export type ThoughtMetadata = Record<string, unknown>;

export type Thought = {
  id: string;
  content: string;
  metadata: ThoughtMetadata;
  createdAt: string; // ISO 8601
  updatedAt?: string | null;
};

export type Recalled = Thought & { score: number };

export type RecentQuery = {
  limit: number;
  type?: string;
  topic?: string;
  person?: string;
  /** Created at or after this instant (inclusive). ISO 8601. */
  since?: string;
  /** Created strictly before this instant (exclusive), so since/until windows tile without overlap. ISO 8601. */
  until?: string;
  /** Only thoughts whose metadata.source starts with this, e.g. "discord:<guild>/<channel>/" for one channel. */
  sourcePrefix?: string;
  /** Only thoughts whose metadata.channel is this name: any case, a leading # ignored, never a prefix or a wildcard. */
  channel?: string;
  /** "newest" (default) or "oldest" first, by created-at; ties broken by a key stable across calls. */
  order?: "newest" | "oldest";
  /** Skip this many matches first, for paging. Bounded like limit: a whole number ≥ 0. */
  offset?: number;
};

export type Summary = {
  count: number;
  oldest?: string; // ISO 8601 of the earliest thought, absent when empty
  newest?: string;
  types: Record<string, number>;
  topics: Record<string, number>;
  people: Record<string, number>;
};

/**
 * What a memory promises about `scope.tenant`: "tenant" partitions by it and
 * never crosses; "none" ignores it and holds one tenant's thoughts only.
 * Declared so the composition root can refuse to pair a "none" memory with
 * a gate that admits more than one tenant.
 */
export type MemoryIsolation = "tenant" | "none";

export interface Memory {
  readonly isolation: MemoryIsolation;
  remember(scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }>;
  /**
   * The id of the thought this content would merge into, or null. The same
   * notion of "the same" as `remember`, without storing anything and without
   * needing an embedding, so a writer can skip what it already wrote before
   * spending a model call on it.
   */
  known(scope: Scope, content: string): Promise<string | null>;
  recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]>;
  get(scope: Scope, id: string): Promise<Thought | null>;
  recent(scope: Scope, query: RecentQuery): Promise<Thought[]>;
  summary(scope: Scope): Promise<Summary>;
}
