/**
 * KeywordMemory: an in-process Memory that uses word overlap (Jaccard) for
 * recall. No vectors, no network, no database. It exists to prove the core
 * does not care how similarity works, and to run the core offline. Partitions
 * by tenant, so it is also the reference multi-tenant implementation.
 */
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { bounds, createdAtOf, normalise, recentWindow, spanOf, tally } from "./shared.ts";

type Row = Thought & { key: string; words: Set<string>; seq: number };

function words(content: string): Set<string> {
  return new Set(normalise(content).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export class KeywordMemory implements Memory {
  readonly isolation = "tenant" as const;
  private brains = new Map<string, Map<string, Row>>();
  private seq = 0;

  private brain(scope: Scope): Map<string, Row> {
    let b = this.brains.get(scope.tenant);
    if (!b) {
      b = new Map();
      this.brains.set(scope.tenant, b);
    }
    return b;
  }

  remember(scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }> {
    const key = normalise(content);
    if (!key) return Promise.reject(new Error("Cannot remember blank content"));
    const b = this.brain(scope);
    const now = new Date().toISOString();
    for (const row of b.values()) {
      if (row.key === key) {
        row.metadata = { ...row.metadata, ...structuredClone(metadata) };
        row.updatedAt = now;
        return Promise.resolve({ id: row.id, alreadyKnown: true });
      }
    }
    const id = crypto.randomUUID();
    b.set(id, { id, content, metadata: structuredClone(metadata), createdAt: createdAtOf(metadata, now), updatedAt: now, key, words: words(content), seq: ++this.seq });
    return Promise.resolve({ id, alreadyKnown: false });
  }

  known(scope: Scope, content: string): Promise<string | null> {
    const key = normalise(content);
    if (!key) return Promise.resolve(null);
    for (const row of this.brain(scope).values()) if (row.key === key) return Promise.resolve(row.id);
    return Promise.resolve(null);
  }

  recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    const q = words(query);
    const out: Recalled[] = [];
    for (const row of this.brain(scope).values()) {
      const score = jaccard(q, row.words);
      if (score > minScore) out.push({ ...strip(row), score });
    }
    out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(out.slice(0, limit));
  }

  get(scope: Scope, id: string): Promise<Thought | null> {
    const row = this.brain(scope).get(id);
    return Promise.resolve(row ? strip(row) : null);
  }

  recent(scope: Scope, query: RecentQuery): Promise<Thought[]> {
    try {
      return Promise.resolve(recentWindow(this.brain(scope).values(), query).map(strip));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  summary(scope: Scope): Promise<Summary> {
    const rows = [...this.brain(scope).values()];
    const s: Summary = { count: rows.length, types: {}, topics: {}, people: {}, ...spanOf(rows.map((r) => r.createdAt)) };
    for (const r of rows) tally(s, r.metadata);
    return Promise.resolve(s);
  }
}

function strip(r: Row): Thought {
  return { id: r.id, content: r.content, metadata: structuredClone(r.metadata), createdAt: r.createdAt, updatedAt: r.updatedAt };
}
