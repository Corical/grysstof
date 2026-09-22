/**
 * SqliteLedger: the in-process ledger engine with every event persisted in
 * an `events` table of a SQLite file (the same file the SQLite memory uses,
 * or its own). Append-only by construction: an event is written, then
 * applied; on start the table is replayed. Single-process, like SQLite.
 *
 * With an embedder, claim vectors are kept in `ledger_vectors` so `find`
 * works by meaning after a restart without re-embedding; a line whose vector
 * is missing (written before the embedder existed) is embedded on start.
 */
/// <reference path="../memory/node-sqlite.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { type Event, InProcessLedger } from "./in-process.ts";
import type { Embedder } from "../memory/vectors.ts";

export class SqliteLedger extends InProcessLedger {
  private readonly db: DatabaseSync;
  private chain: Promise<void> = Promise.resolve();
  /** Resolves when lines written before this build have been embedded. `find` waits for it. */
  readonly ready: Promise<void>;

  constructor(path: string, now?: () => Date, embedder?: Embedder) {
    super(now, embedder);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS ledger_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS ledger_vectors (id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL)");
    const rows = this.db.prepare("SELECT event FROM ledger_events ORDER BY seq").all() as { event: string }[];
    const events = rows.map((r) => JSON.parse(r.event) as Event);
    this.replay(events);
    if (embedder) {
      for (const r of this.db.prepare("SELECT id, vector FROM ledger_vectors WHERE model = ? AND dims = ?").all(embedder.model, embedder.dimensions) as { id: string; vector: Uint8Array }[]) {
        this.vectors.set(r.id, Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4)));
      }
      const missing = events.filter((e): e is Extract<Event, { kind: "assert" }> => e.kind === "assert" && !this.vectors.has(e.fact.id));
      this.ready = (async () => {
        for (const e of missing) {
          const v = await embedder.embed(e.fact.claim);
          this.vectors.set(e.fact.id, v);
          await this.storeVector(e.fact.id, v);
        }
      })();
    } else {
      this.ready = Promise.resolve();
    }
  }

  protected override record(event: Event): Promise<void> {
    this.chain = this.chain.then(() => {
      this.db.prepare("INSERT INTO ledger_events (at, event) VALUES (?, ?)").run(new Date().toISOString(), JSON.stringify(event));
      this.apply(event);
    });
    return this.chain;
  }

  protected override storeVector(id: string, vector: number[]): Promise<void> {
    if (!this.embedder) return Promise.resolve();
    const blob = new Uint8Array(new Float32Array(vector).buffer);
    this.db.prepare("INSERT OR REPLACE INTO ledger_vectors (id, model, dims, vector) VALUES (?, ?, ?, ?)").run(id, this.embedder.model, this.embedder.dimensions, blob);
    return Promise.resolve();
  }

  override async find(...args: Parameters<InProcessLedger["find"]>): ReturnType<InProcessLedger["find"]> {
    await this.ready;
    return super.find(...args);
  }

  close(): void {
    this.db.close();
  }
}
