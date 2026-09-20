/**
 * JsonFileMemory: a Memory that is a directory of JSON files, one per
 * tenant. Recall is brute-force cosine over stored vectors. It exists to
 * prove three things the port promises but no shipped limb had tested:
 * persistence without a database, ids that are not UUIDs, and a memory that
 * survives a restart. Fine for thousands of thoughts, not for millions.
 */
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { boundLimit, bounds, normalise, parseSince, tally } from "./shared.ts";
import { cosine, type Embedder } from "./vectors.ts";

type Row = Thought & { key: string; vector: number[]; seq: number };
type File = { model: string; dimensions: number; seq: number; rows: Row[] };

const TENANT_FILE = /^[A-Za-z0-9._-]{1,64}$/;

/** Time-ordered, non-UUID, opaque to the core. */
function newId(seq: number): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.getRandomValues(new Uint8Array(4));
  return `jf_${t}_${seq.toString(36)}_${[...r].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function matches(meta: ThoughtMetadata, q: RecentQuery): boolean {
  if (q.type !== undefined && meta.type !== q.type) return false;
  if (q.topic !== undefined && !(Array.isArray(meta.topics) && meta.topics.includes(q.topic))) return false;
  if (q.person !== undefined && !(Array.isArray(meta.people) && meta.people.includes(q.person))) return false;
  return true;
}

export class JsonFileMemory implements Memory {
  readonly isolation = "tenant" as const;
  private readonly cache = new Map<string, File>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dir: string, private readonly embedder: Embedder) {
    Deno.mkdirSync(dir, { recursive: true });
  }

  private path(scope: Scope): string {
    if (!TENANT_FILE.test(scope.tenant)) throw new Error(`tenant name "${scope.tenant}" cannot be a file name`);
    return `${this.dir}/${scope.tenant}.json`;
  }

  private async load(scope: Scope): Promise<File> {
    const p = this.path(scope);
    const cached = this.cache.get(p);
    if (cached) return cached;
    let f: File;
    try {
      f = JSON.parse(await Deno.readTextFile(p)) as File;
      if (f.model !== this.embedder.model || f.dimensions !== this.embedder.dimensions) {
        throw new Error(`${p} holds ${f.model}/${f.dimensions} vectors; this memory embeds with ${this.embedder.model}/${this.embedder.dimensions}. Re-seed or use the same embedder.`);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      f = { model: this.embedder.model, dimensions: this.embedder.dimensions, seq: 0, rows: [] };
    }
    this.cache.set(p, f);
    return f;
  }

  /** Writes are serialised per tenant and land atomically (write temp, rename). */
  private async save(scope: Scope, f: File): Promise<void> {
    const p = this.path(scope);
    const prev = this.locks.get(p) ?? Promise.resolve();
    const next = prev.then(async () => {
      const tmp = `${p}.${crypto.randomUUID()}.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(f));
      await Deno.rename(tmp, p);
    });
    this.locks.set(p, next.catch(() => {}));
    await next;
  }

  /** One writer per tenant at a time, so concurrent remembers of one text leave one row. */
  private async exclusive<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
    const key = `w:${this.path(scope)}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(key, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  remember(scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }> {
    const key = normalise(content);
    if (!key) return Promise.reject(new Error("Cannot remember blank content"));
    return this.exclusive(scope, async () => {
      const f = await this.load(scope);
      const now = new Date().toISOString();
      const existing = f.rows.find((r) => r.key === key);
      if (existing) {
        existing.metadata = { ...existing.metadata, ...structuredClone(metadata) };
        existing.updatedAt = now;
        await this.save(scope, f);
        return { id: existing.id, alreadyKnown: true };
      }
      const vector = await this.embedder.embed(content);
      const seq = ++f.seq;
      const row: Row = { id: newId(seq), content, metadata: structuredClone(metadata), createdAt: now, updatedAt: now, key, vector, seq };
      f.rows.push(row);
      await this.save(scope, f);
      return { id: row.id, alreadyKnown: false };
    });
  }

  async known(scope: Scope, content: string): Promise<string | null> {
    const key = normalise(content);
    if (!key) return null;
    const f = await this.load(scope);
    return f.rows.find((r) => r.key === key)?.id ?? null;
  }

  async recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    if (limit === 0) return [];
    const f = await this.load(scope);
    if (!query.trim() || f.rows.length === 0) return [];
    const q = await this.embedder.embed(query);
    const out: Recalled[] = [];
    for (const r of f.rows) {
      const score = Math.max(0, Math.min(1, cosine(q, r.vector)));
      if (score > minScore) out.push({ ...strip(r), score });
    }
    out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  async get(scope: Scope, id: string): Promise<Thought | null> {
    const f = await this.load(scope);
    const r = f.rows.find((x) => x.id === id);
    return r ? strip(r) : null;
  }

  async recent(scope: Scope, query: RecentQuery): Promise<Thought[]> {
    const since = parseSince(query.since);
    const f = await this.load(scope);
    return [...f.rows]
      .sort((a, b) => b.seq - a.seq)
      .filter((r) => matches(r.metadata, query))
      .filter((r) => since === null || Date.parse(r.createdAt) >= since)
      .slice(0, boundLimit(query.limit))
      .map(strip);
  }

  async summary(scope: Scope): Promise<Summary> {
    const f = await this.load(scope);
    const rows = [...f.rows].sort((a, b) => b.seq - a.seq);
    const s: Summary = { count: rows.length, types: {}, topics: {}, people: {} };
    if (rows.length) {
      s.newest = rows[0].createdAt;
      s.oldest = rows[rows.length - 1].createdAt;
    }
    for (const r of rows) tally(s, r.metadata);
    return s;
  }

  /** Forget the in-memory copy; the next call re-reads the file. Tests use it to prove persistence. */
  dropCache(): void {
    this.cache.clear();
  }
}

function strip(r: Row): Thought {
  return { id: r.id, content: r.content, metadata: structuredClone(r.metadata), createdAt: r.createdAt, updatedAt: r.updatedAt };
}
