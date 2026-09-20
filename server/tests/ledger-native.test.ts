import { assert, assertEquals } from "@std/assert";
import { InProcessLedger, JsonlLedger } from "../adapters/ledger/in-process.ts";
import { runLedgerContract } from "./ledger.contract.ts";

runLedgerContract("ledger/in-process", () => Promise.resolve({ ledger: new InProcessLedger() }));

const tempFile = () => `${Deno.makeTempDirSync({ prefix: "ob1-jsonl-" })}/ledger.jsonl`;

runLedgerContract("ledger/jsonl", () => {
  const file = tempFile();
  return Promise.resolve({ ledger: new JsonlLedger(file), close: () => Deno.remove(file.replace(/[\\/]ledger\.jsonl$/, ""), { recursive: true }) });
});

const A = { tenant: "alice", actor: "agent:alice" };

Deno.test("[ledger/jsonl] the file only grows: assert, confirm, supersede are three lines; a restart replays to the same state", async () => {
  const file = tempFile();
  try {
    const l1 = new JsonlLedger(file);
    const v1 = await l1.assert(A, { subject: "client:zenith", claim: "412 sites", source: "reporting-db" });
    const v2 = await l1.assert(A, { subject: "client:zenith", claim: "418 sites", source: "email" });
    await l1.confirm(A, v2.id);
    await l1.supersede(A, v2.id, v1.id);
    const lines = (await Deno.readTextFile(file)).trim().split("\n");
    assertEquals(lines.length, 4, "four events, four lines, nothing rewritten");
    assertEquals(lines.map((l) => JSON.parse(l).kind), ["assert", "assert", "confirm", "supersede"]);

    const l2 = new JsonlLedger(file);
    const latest = await l2.latest(A, "client:zenith");
    assert(latest);
    assertEquals(latest.id, v2.id);
    assertEquals(latest.confirmed, true);
    assertEquals(latest.supersedes, v1.id);
    const history = await l2.history(A, "client:zenith");
    assertEquals(history.map((f) => f.id), [v2.id, v1.id]);
    assertEquals(history[1].supersededBy, v2.id);
  } finally {
    await Deno.remove(file.replace(/[\\/]ledger\.jsonl$/, ""), { recursive: true });
  }
});

Deno.test("[ledger/jsonl] a refused supersede writes nothing", async () => {
  const file = tempFile();
  try {
    const l = new JsonlLedger(file);
    const a = await l.assert(A, { subject: "s1", claim: "one", source: "x" });
    const b = await l.assert(A, { subject: "s2", claim: "two", source: "x" });
    let threw = false;
    try {
      await l.supersede(A, b.id, a.id);
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals((await Deno.readTextFile(file)).trim().split("\n").length, 2);
  } finally {
    await Deno.remove(file.replace(/[\\/]ledger\.jsonl$/, ""), { recursive: true });
  }
});

Deno.test("[ledger/in-process] subjects: a same-moment tie is broken by code-point order, not the locale; a replayed jsonl ledger agrees", async () => {
  const frozen = () => new Date("2026-09-21T10:00:00.000Z");
  const A = { tenant: "alice", actor: "a" };
  const l = new InProcessLedger(frozen);
  for (const subject of ["b", "B", "a", "_z", "a:2", "a:10"]) await l.assert(A, { subject, claim: subject, source: "s" });
  const order = ["B", "_z", "a", "a:10", "a:2", "b"];
  assertEquals((await l.subjects(A)).map((r) => r.subject), order);
  assert((await l.subjects(A)).every((r) => r.latestAt === "2026-09-21T10:00:00.000Z" && r.lines === 1 && r.current === 1));

  const dir = Deno.makeTempDirSync({ prefix: "ob1-lsub-" });
  try {
    const file = `${dir}/ledger.jsonl`;
    const first = new JsonlLedger(file, frozen);
    for (const subject of ["b", "B", "a", "_z", "a:2", "a:10"]) await first.assert(A, { subject, claim: subject, source: "s" });
    const replayed = new JsonlLedger(file, frozen);
    assertEquals((await replayed.subjects(A)).map((r) => r.subject), order);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
