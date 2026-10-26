/// <reference path="../adapters/memory/node-sqlite.d.ts" />
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { SqliteLedger } from "../adapters/ledger/sqlite.ts";
import { RecordingLog } from "../adapters/log.ts";
import { runLedgerContract } from "./ledger.contract.ts";

runLedgerContract("ledger/sqlite", () => { const d = Deno.makeTempDirSync({ prefix: "ob1-lsq-" }); const l = new SqliteLedger(`${d}/l.db`); return Promise.resolve({ ledger: l, close: async () => { l.close(); await Deno.remove(d, { recursive: true }); } }); });

const A = { tenant: "alice", actor: "agent:alice" };

/** A ledger file with a second connection that can hold the write lock, as the memory or a backup would. */
async function locked(busyTimeoutMs: number, fn: (l: SqliteLedger, other: DatabaseSync, log: RecordingLog, file: string) => Promise<void>) {
  const d = Deno.makeTempDirSync({ prefix: "ob1-lsq-busy-" });
  const log = new RecordingLog();
  const l = new SqliteLedger(`${d}/l.db`, undefined, undefined, { log, busyTimeoutMs });
  const other = new DatabaseSync(`${d}/l.db`);
  try {
    await fn(l, other, log, `${d}/l.db`);
  } finally {
    try { other.close(); } catch { /* already closed */ }
    try { l.close(); } catch { /* already closed */ }
    await Deno.remove(d, { recursive: true });
  }
}

Deno.test("[ledger/sqlite] a write waits busy_timeout for another connection's lock before it fails", async () => {
  await locked(300, async (l, other) => {
    await l.assert(A, { subject: "loop:1", claim: "OPEN", source: "s" });
    other.exec("BEGIN IMMEDIATE");
    const t0 = performance.now();
    await assertRejects(() => l.assert(A, { subject: "loop:2", claim: "OPEN", source: "s" }), Error, "locked");
    const waited = performance.now() - t0;
    other.exec("COMMIT");
    assert(waited >= 250, `busy_timeout not honoured: refused after ${waited.toFixed(0)} ms`);
  });
});

Deno.test("[ledger/sqlite] one failed write does not poison the ledger: once the lock is gone the next writes land, the failure is logged once, a restart replays only what was written", async () => {
  await locked(20, async (l, other, log, file) => {
    const open = await l.assert(A, { subject: "loop:1", claim: "OPEN", source: "s" });
    other.exec("BEGIN IMMEDIATE");
    await assertRejects(() => l.assert(A, { subject: "loop:1", claim: "RESOLVED", source: "press:1", supersedes: open.id }), Error, "locked");
    assertEquals((await l.history(A, "loop:1")).length, 1, "a write that did not persist is not applied either");
    other.exec("COMMIT");

    const resolved = await l.assert(A, { subject: "loop:1", claim: "RESOLVED", source: "press:2", supersedes: open.id });
    assertEquals((await l.latest(A, "loop:1"))?.id, resolved.id, "the next write lands, and the line the failed one aimed at was still free");
    await l.assert(A, { subject: "loop:2", claim: "OPEN", source: "s" });

    const failed = log.events.filter((e) => e.event === "ledger.write_failed");
    assertEquals(failed.length, 1);
    assertEquals([failed[0].level, failed[0].fields?.ledger, failed[0].fields?.kind, failed[0].fields?.tenant, failed[0].fields?.subject], ["error", "sqlite", "assert", "alice", "loop:1"]);
    assert(String((failed[0].err as Error)?.message).includes("locked"));

    l.close();
    const replayed = new SqliteLedger(file);
    try {
      assertEquals((await replayed.history(A, "loop:1")).map((f) => f.claim), ["RESOLVED", "OPEN"], "a restart replays exactly what was written");
      assertEquals((await replayed.history(A, "loop:2")).length, 1);
    } finally {
      replayed.close();
    }
  });
});
