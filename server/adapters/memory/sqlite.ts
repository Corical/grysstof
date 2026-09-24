/**
 * SqliteMemory: a Memory in one SQLite file via `node:sqlite`, no vector
 * extension. Vectors are stored as float32 blobs and cosine is computed in
 * JS over a per-tenant scan. A second SQL dialect for the matrix: the
 * fingerprint rule lives in JS (shared.ts), not in the database, and the
 * unique index is (tenant, fingerprint) from the first line — the shape the
 * Postgres schema had to be migrated to.
 */
/// <reference path="./node-sqlite.d.ts" />
import { DatabaseSync } from "node:sqlite";
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { bounds, createdAtOf, fingerprint, normalise, recentWindow, spanOf, tally } from "./shared.ts";
import { cosine, type Embedder } from "./vectors.ts";

type Row = { id: string; tenant: string; content: string; metadata: string; created_at: string; updated_at: string; fingerprint: string; embedding: Uint8Array | null; seq: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  embedding_dims INTEGER,
  seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS thoughts_tenant_fingerprint ON thoughts (tenant, fingerprint);
CREATE INDEX IF NOT EXISTS thoughts_tenant_seq ON thoughts (tenant, seq DESC);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const toBlob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

export class SqliteMemory implements Memory {
  readonly isolation = "tenant" as const;
  private readonly db: DatabaseSync;
  private seq: number;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(path: string, private readonly embedder: Embedder) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // A second process on the same file (a backfill, a seeder) waits for the lock instead of failing at once.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    const model = this.db.prepare("SELECT v FROM meta WHERE k = 'embedding'").get() as { v: string } | undefined;
    const want = `${embedder.model}/${embedder.dimensions}`;
    if (model && model.v !== want) {
      this.db.close(); // never leave a handle open behind a thrown constructor
      throw new Error(`${path} holds ${model.v} vectors; this memory embeds with ${want}. Re-seed or use the same embedder.`);
    }
    if (!model) this.db.prepare("INSERT INTO meta (k, v) VALUES ('embedding', ?)").run(want);
    this.seq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM thoughts").get() as { m: number }).m;
  }

  /** One writer at a time, so concurrent remembers of one text leave one row. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writing.then(fn, fn);
    this.writing = next.catch(() => {});
    return next;
  }

  remember(scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }> {
    if (!normalise(content)) return Promise.reject(new Error("Cannot remember blank content"));
    return this.serial(async () => {
      const fp = await fingerprint(content);
      const now = new Date().toISOString();
      const existing = this.db.prepare("SELECT id, metadata FROM thoughts WHERE tenant = ? AND fingerprint = ?").get(scope.tenant, fp) as { id: string; metadata: string } | undefined;
      if (existing) {
        const merged = { ...JSON.parse(existing.metadata), ...structuredClone(metadata) };
        this.db.prepare("UPDATE thoughts SET metadata = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), now, existing.id);
        return { id: existing.id, alreadyKnown: true };
      }
      const vector = await this.embedder.embed(content);
      const id = crypto.randomUUID();
      this.db.prepare(
        "INSERT INTO thoughts (id, tenant, content, metadata, created_at, updated_at, fingerprint, embedding, embedding_model, embedding_dims, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, scope.tenant, content, JSON.stringify(metadata), createdAtOf(metadata, now), now, fp, toBlob(vector), this.embedder.model, this.embedder.dimensions, ++this.seq);
      return { id, alreadyKnown: false };
    });
  }

  async known(scope: Scope, content: string): Promise<string | null> {
    if (!normalise(content)) return null;
    const fp = await fingerprint(content);
    const row = this.db.prepare("SELECT id FROM thoughts WHERE tenant = ? AND fingerprint = ?").get(scope.tenant, fp) as { id: string } | undefined;
    return row?.id ?? null;
  }

  async recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    if (limit === 0 || !query.trim()) return [];
    const rows = this.db.prepare("SELECT * FROM thoughts WHERE tenant = ? AND embedding IS NOT NULL").all(scope.tenant) as Row[];
    if (!rows.length) return [];
    const q = await this.embedder.embed(query);
    const out: Recalled[] = [];
    for (const r of rows) {
      const score = Math.max(0, Math.min(1, cosine(q, fromBlob(r.embedding!))));
      if (score > minScore) out.push({ ...toThought(r), score });
    }
    out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  get(scope: Scope, id: string): Promise<Thought | null> {
    const r = this.db.prepare("SELECT * FROM thoughts WHERE tenant = ? AND id = ?").get(scope.tenant, id) as Row | undefined;
    return Promise.resolve(r ? toThought(r) : null);
  }

  recent(scope: Scope, query: RecentQuery): Promise<Thought[]> {
    try {
      const rows = this.db.prepare("SELECT * FROM thoughts WHERE tenant = ?").all(scope.tenant) as Row[];
      const held = rows.map((r) => ({ ...toThought(r), seq: r.seq }));
      return Promise.resolve(recentWindow(held, query).map(({ seq: _seq, ...t }) => t));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  summary(scope: Scope): Promise<Summary> {
    const rows = this.db.prepare("SELECT metadata, created_at FROM thoughts WHERE tenant = ?").all(scope.tenant) as { metadata: string; created_at: string }[];
    const s: Summary = { count: rows.length, types: {}, topics: {}, people: {}, ...spanOf(rows.map((r) => r.created_at)) };
    for (const r of rows) tally(s, JSON.parse(r.metadata));
    return Promise.resolve(s);
  }

  close(): void {
    this.db.close();
  }
}

function toThought(r: Row): Thought {
  return { id: r.id, content: r.content, metadata: JSON.parse(r.metadata), createdAt: r.created_at, updatedAt: r.updated_at };
}
