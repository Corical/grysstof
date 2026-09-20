/**
 * ChaosMemory: wraps any Memory and makes it unreliable on a schedule —
 * every Nth call throws, and any call may be delayed. It exists so the
 * error paths above it (the core's tool handlers, the seeder's retry and
 * failure file, the ledger's "nothing half-written") are exercised by a
 * limb that is guaranteed to fail, not by hoping Postgres has a bad day.
 *
 * Failures are ordinary Errors with a user-safe message, as the port asks.
 * The schedule counts calls across all verbs so a test can predict which
 * call fails: with `failEvery: 3`, calls 3, 6, 9 … throw.
 */
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";

export type ChaosOptions = {
  /** Throw on every Nth call (1-based). 0 or absent: never. */
  failEvery?: number;
  /** Delay every call by this many milliseconds. */
  delayMs?: number;
  /** Which verbs may fail. Default: all. */
  verbs?: ("remember" | "known" | "recall" | "get" | "recent" | "summary")[];
};

export class ChaosMemory implements Memory {
  readonly isolation: Memory["isolation"];
  calls = 0;
  failures = 0;

  constructor(private readonly inner: Memory, private readonly o: ChaosOptions = {}) {
    this.isolation = inner.isolation;
  }

  private async gate<T>(verb: NonNullable<ChaosOptions["verbs"]>[number], fn: () => Promise<T>): Promise<T> {
    this.calls++;
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    const eligible = !this.o.verbs || this.o.verbs.includes(verb);
    if (eligible && this.o.failEvery && this.calls % this.o.failEvery === 0) {
      this.failures++;
      throw new Error(`The memory is unavailable right now (chaos: call ${this.calls})`);
    }
    return fn();
  }

  remember(scope: Scope, content: string, metadata: ThoughtMetadata) {
    return this.gate("remember", () => this.inner.remember(scope, content, metadata));
  }
  known(scope: Scope, content: string) {
    return this.gate("known", () => this.inner.known(scope, content));
  }
  recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    return this.gate("recall", () => this.inner.recall(scope, query, opts));
  }
  get(scope: Scope, id: string): Promise<Thought | null> {
    return this.gate("get", () => this.inner.get(scope, id));
  }
  recent(scope: Scope, query: RecentQuery): Promise<Thought[]> {
    return this.gate("recent", () => this.inner.recent(scope, query));
  }
  summary(scope: Scope): Promise<Summary> {
    return this.gate("summary", () => this.inner.summary(scope));
  }
}
