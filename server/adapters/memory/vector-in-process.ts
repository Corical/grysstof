/**
 * VectorMemory: an in-process Memory that recalls by cosine similarity over
 * an Embedder. A second, genuinely different implementation of the same
 * port as KeywordMemory. Single-tenant: ignores scope.
 */
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { boundLimit, bounds, normalise, parseSince, tally } from "./shared.ts";
import { cosine, type Embedder } from "./vectors.ts";

type Row = Thought & { key: string; vector: number[]; seq: number };

export class VectorMemory implements Memory {
  readonly isolation = "none" as const;
  private rows = new Map<string, Row>();
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly embedder: Embedder) {}

  remember(_scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }> {
    const key = normalise(content);
    if (!key) return Promise.reject(new Error("Cannot remember blank content"));
    // Serialised, so two concurrent remembers of one thought cannot both insert while one awaits its embedding.
    const next = this.chain.then(async () => {
      const now = new Date().toISOString();
      for (const row of this.rows.values()) {
        if (row.key === key) {
          row.metadata = { ...row.metadata, ...structuredClone(metadata) };
          row.updatedAt = now;
          return { id: row.id, alreadyKnown: true };
        }
      }
      const vector = await this.embedder.embed(content);
      const id = crypto.randomUUID();
      this.rows.set(id, { id, content, metadata: structuredClone(metadata), createdAt: now, updatedAt: now, key, vector, seq: ++this.seq });
      return { id, alreadyKnown: false };
    });
    this.chain = next.catch(() => {});
    return next;
  }

  known(_scope: Scope, content: string): Promise<string | null> {
    const key = normalise(content);
    if (!key) return Promise.resolve(null);
    for (const row of this.rows.values()) if (row.key === key) return Promise.resolve(row.id);
    return Promise.resolve(null);
  }

  async recall(_scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    if (limit === 0) return [];
    const q = await this.embedder.embed(query);
    const out: Recalled[] = [];
    for (const r of this.rows.values()) {
      const score = Math.max(0, cosine(q, r.vector));
      if (score > minScore) out.push({ ...strip(r), score });
    }
    out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  get(_scope: Scope, id: string): Promise<Thought | null> {
    const r = this.rows.get(id);
    return Promise.resolve(r ? strip(r) : null);
  }

  recent(_scope: Scope, q: RecentQuery): Promise<Thought[]> {
    let since: number | null;
    try {
      since = parseSince(q.since);
    } catch (e) {
      return Promise.reject(e);
    }
    const out = [...this.rows.values()]
      .sort((a, b) => b.seq - a.seq)
      .filter((r) => q.type === undefined || r.metadata.type === q.type)
      .filter((r) => q.topic === undefined || (Array.isArray(r.metadata.topics) && r.metadata.topics.includes(q.topic)))
      .filter((r) => q.person === undefined || (Array.isArray(r.metadata.people) && r.metadata.people.includes(q.person)))
      .filter((r) => since === null || Date.parse(r.createdAt) >= since)
      .slice(0, boundLimit(q.limit))
      .map(strip);
    return Promise.resolve(out);
  }

  summary(_scope: Scope): Promise<Summary> {
    const rows = [...this.rows.values()].sort((a, b) => b.seq - a.seq);
    const s: Summary = { count: rows.length, types: {}, topics: {}, people: {} };
    if (rows.length) {
      s.newest = rows[0].createdAt;
      s.oldest = rows[rows.length - 1].createdAt;
    }
    for (const r of rows) tally(s, r.metadata);
    return Promise.resolve(s);
  }
}

function strip(r: Row): Thought {
  return { id: r.id, content: r.content, metadata: structuredClone(r.metadata), createdAt: r.createdAt, updatedAt: r.updatedAt };
}
