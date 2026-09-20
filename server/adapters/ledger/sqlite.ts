/**
 * SqliteLedger: the in-process ledger engine with every event persisted in
 * an `events` table of a SQLite file (the same file the SQLite memory uses,
 * or its own). Append-only by construction: an event is written, then
 * applied; on start the table is replayed. Single-process, like SQLite.
 */
/// <reference path="../memory/node-sqlite.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { type Event, InProcessLedger } from "./in-process.ts";

export class SqliteLedger extends InProcessLedger {
  private readonly db: DatabaseSync;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string, now?: () => Date) {
    super(now);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS ledger_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL)");
    const rows = this.db.prepare("SELECT event FROM ledger_events ORDER BY seq").all() as { event: string }[];
    this.replay(rows.map((r) => JSON.parse(r.event) as Event));
  }

  protected override record(event: Event): Promise<void> {
    this.chain = this.chain.then(() => {
      this.db.prepare("INSERT INTO ledger_events (at, event) VALUES (?, ?)").run(new Date().toISOString(), JSON.stringify(event));
      this.apply(event);
    });
    return this.chain;
  }

  close(): void {
    this.db.close();
  }
}
