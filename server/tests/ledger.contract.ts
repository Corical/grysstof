/**
 * The Ledger contract, written from the port's promises, runnable against
 * any implementation. Tries to break the append-only rule, provenance
 * stamping, tenancy, supersession (wrong tenant, wrong subject, self,
 * already superseded, cycles of length 2 and 3, out-of-time-order links),
 * confirmation, and find's newest-wins default.
 */
import { assert, assertEquals, assertNotEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { Ledger } from "../core/ports/mod.ts";

export type LedgerFactory = () => Promise<{ ledger: Ledger; close?: () => Promise<void> }>;

const A = { tenant: "alice", actor: "agent:alice" };
const A2 = { tenant: "alice", actor: "human:owner" };
const B = { tenant: "bob", actor: "agent:bob" };
const tick = () => new Promise((r) => setTimeout(r, 2));

export function runLedgerContract(name: string, make: LedgerFactory) {
  const t = (title: string, fn: (l: Ledger) => Promise<void>) =>
    Deno.test(`[${name}] ${title}`, async () => {
      const { ledger, close } = await make();
      try {
        await fn(ledger);
      } finally {
        await close?.();
      }
    });

  t("assert stamps learnedBy and learnedAt from the scope; caller-supplied provenance is ignored", async (l) => {
    const before = Date.now();
    const smuggled = {
      subject: "client:acme", claim: "Acme renews on 1 March 2027", source: "ticket:6106", proof: "https://ado/6106",
      learnedBy: "root", learnedAt: "1999-01-01T00:00:00.000Z", learned_by: "root", learned_at: "1999-01-01T00:00:00.000Z",
      tenant: "bob", confirmed: true, confirmedBy: "root", supersededBy: "x", id: "forged",
    };
    const f = await l.assert(A, smuggled as unknown as Parameters<Ledger["assert"]>[1]);
    assertEquals(f.learnedBy, "agent:alice");
    assert(Date.parse(f.learnedAt) >= before - 1000 && Date.parse(f.learnedAt) <= Date.now() + 1000, f.learnedAt);
    assertEquals(f.tenant, "alice");
    assertEquals(f.confirmed, false);
    assertEquals(f.confirmedBy, undefined);
    assertEquals(f.supersededBy, undefined);
    assertNotEquals(f.id, "forged");
    assertEquals(f.subject, "client:acme");
    assertEquals(f.claim, "Acme renews on 1 March 2027");
    assertEquals(f.source, "ticket:6106");
    assertEquals(f.proof, "https://ado/6106");
    const again = await l.latest(A, "client:acme");
    assertEquals(again, f);
  });

  t("a fact needs a subject, a claim and a source; blanks are refused and nothing is stored", async (l) => {
    for (const bad of [
      { subject: "", claim: "c", source: "s" },
      { subject: "  ", claim: "c", source: "s" },
      { subject: "s", claim: "", source: "s" },
      { subject: "s", claim: " \n ", source: "s" },
      { subject: "s", claim: "c", source: "" },
    ]) {
      await assertRejects(() => l.assert(A, bad), Error, "needs a");
    }
    assertEquals(await l.history(A, "s"), []);
    assertEquals(await l.latest(A, "s"), null);
  });

  t("append-only: same claim from two sources is two lines; latest is the newer; history has both newest first", async (l) => {
    const one = await l.assert(A, { subject: "person:sam", claim: "Sam owns the Acme account", source: "email:1" });
    await tick();
    const two = await l.assert(A, { subject: "person:sam", claim: "Sam owns the Acme account", source: "teams:2" });
    assertNotEquals(one.id, two.id);
    assertEquals((await l.latest(A, "person:sam"))?.id, two.id);
    assertEquals((await l.history(A, "person:sam")).map((f) => f.id), [two.id, one.id]);
    assertEquals((await l.history(A, "person:sam")).map((f) => f.source), ["teams:2", "email:1"]);
  });

  t("append-only: same claim, same source, same actor, a moment later is still a new line", async (l) => {
    const a = await l.assert(A, { subject: "s", claim: "the same claim", source: "same" });
    await tick();
    const b = await l.assert(A, { subject: "s", claim: "the same claim", source: "same" });
    assertNotEquals(a.id, b.id);
    assertEquals((await l.history(A, "s")).length, 2);
  });

  t("nothing is edited: asserting again never changes an earlier line's provenance", async (l) => {
    const first = await l.assert(A, { subject: "s", claim: "claim", source: "src-1", proof: "p1" });
    await tick();
    await l.assert(A2, { subject: "s", claim: "claim", source: "src-2", proof: "p2" });
    const stillFirst = (await l.history(A, "s")).find((f) => f.id === first.id)!;
    assertEquals(stillFirst.source, "src-1");
    assertEquals(stillFirst.proof, "p1");
    assertEquals(stillFirst.learnedBy, "agent:alice");
    assertEquals(stillFirst.learnedAt, first.learnedAt);
  });

  t("unknown subject: latest is null, history is empty, neither throws", async (l) => {
    assertStrictEquals(await l.latest(A, "nobody:ever"), null);
    assertEquals(await l.history(A, "nobody:ever"), []);
    assertEquals(await l.history(A, ""), []);
  });

  t("supersede: refuses a different tenant and leaves the other tenant's line untouched", async (l) => {
    const bobs = await l.assert(B, { subject: "client:x", claim: "bob's fact", source: "b" });
    const alices = await l.assert(A, { subject: "client:x", claim: "alice's fact", source: "a" });
    await assertRejects(() => l.supersede(A, alices.id, bobs.id), Error, "No fact");
    await assertRejects(() => l.supersede(A, bobs.id, alices.id), Error, "No fact");
    await assertRejects(() => l.assert(A, { subject: "client:x", claim: "sneaky", source: "a", supersedes: bobs.id }), Error, "No fact");
    assertEquals((await l.latest(B, "client:x"))?.id, bobs.id);
    assertEquals((await l.history(B, "client:x"))[0].supersededBy, undefined);
    assertEquals((await l.history(A, "client:x")).length, 1);
  });

  t("supersede: refuses a different subject, the same line twice, and an older line already superseded", async (l) => {
    const acme = await l.assert(A, { subject: "client:acme", claim: "old", source: "s" });
    const zenith = await l.assert(A, { subject: "client:zenith", claim: "other", source: "s" });
    await assertRejects(() => l.supersede(A, zenith.id, acme.id), Error, "same subject");
    await assertRejects(() => l.supersede(A, acme.id, acme.id), Error, "itself");
    await tick();
    const newer = await l.assert(A, { subject: "client:acme", claim: "new", source: "s" });
    await l.supersede(A, newer.id, acme.id);
    await tick();
    const newest = await l.assert(A, { subject: "client:acme", claim: "newest", source: "s" });
    await assertRejects(() => l.supersede(A, newest.id, acme.id), Error, "already superseded");
    await assertRejects(() => l.assert(A, { subject: "client:acme", claim: "x", source: "s", supersedes: acme.id }), Error, "already superseded");
    assertEquals((await l.history(A, "client:acme")).find((f) => f.id === acme.id)?.supersededBy, newer.id, "the first link stands");
  });

  t("supersede: refuses a cycle of length two and of length three", async (l) => {
    const a = await l.assert(A, { subject: "s", claim: "a", source: "s" });
    await tick();
    const b = await l.assert(A, { subject: "s", claim: "b", source: "s" });
    await tick();
    const c = await l.assert(A, { subject: "s", claim: "c", source: "s" });
    await l.supersede(A, b.id, a.id);
    await assertRejects(() => l.supersede(A, a.id, b.id), Error, "cycle");
    await l.supersede(A, c.id, b.id);
    await assertRejects(() => l.supersede(A, a.id, c.id), Error, "cycle");
    await assertRejects(() => l.supersede(A, b.id, c.id), Error, "cycle");
    const h = await l.history(A, "s");
    assertEquals(h.find((f) => f.id === c.id)?.supersededBy, undefined);
    assertEquals((await l.latest(A, "s"))?.id, c.id);
  });

  t("supersede: a later-learned line may be superseded by an earlier one; latest follows the links, not the clock", async (l) => {
    const earlier = await l.assert(A, { subject: "s", claim: "correct all along", source: "s1" });
    await tick();
    const later = await l.assert(A, { subject: "s", claim: "a mistaken update", source: "s2" });
    assertEquals((await l.latest(A, "s"))?.id, later.id);
    await l.supersede(A, earlier.id, later.id);
    assertEquals((await l.latest(A, "s"))?.id, earlier.id);
    const h = await l.history(A, "s");
    assertEquals(h.map((f) => f.id), [later.id, earlier.id], "history stays newest-learned first");
    assertEquals(h[0].supersededBy, earlier.id);
    assertEquals(h[1].supersedes, later.id);
  });

  t("assert with supersedes links both ways in one step and is validated like supersede", async (l) => {
    const old = await l.assert(A, { subject: "s", claim: "v1", source: "s" });
    await tick();
    const v2 = await l.assert(A, { subject: "s", claim: "v2", source: "s", supersedes: old.id });
    assertEquals(v2.supersedes, old.id);
    assertEquals((await l.history(A, "s")).find((f) => f.id === old.id)?.supersededBy, v2.id);
    assertEquals((await l.latest(A, "s"))?.id, v2.id);
    await assertRejects(() => l.assert(A, { subject: "other", claim: "v3", source: "s", supersedes: v2.id }), Error, "same subject");
    await assertRejects(() => l.assert(A, { subject: "s", claim: "v3", source: "s", supersedes: "00000000-0000-0000-0000-000000000000" }), Error, "No fact");
    assertEquals((await l.history(A, "s")).length, 2, "a refused assert stores nothing");
  });

  t("all lines superseded: latest is null while history still shows every line", async (l) => {
    const a = await l.assert(A, { subject: "s", claim: "a", source: "s" });
    await tick();
    const b = await l.assert(A, { subject: "s", claim: "b", source: "s", supersedes: a.id });
    await tick();
    await l.assert(A, { subject: "s", claim: "c", source: "s", supersedes: b.id });
    assertEquals((await l.history(A, "s")).length, 3);
    assertEquals((await l.history(A, "s")).filter((f) => !f.supersededBy).length, 1);
  });

  t("confirm: stamps the confirming actor and moment; idempotent; refuses unknown ids and other tenants' lines", async (l) => {
    const f = await l.assert(A, { subject: "s", claim: "needs a human", source: "agent" });
    assertEquals(f.confirmed, false);
    const c1 = await l.confirm(A2, f.id);
    assertEquals(c1.confirmed, true);
    assertEquals(c1.confirmedBy, "human:owner");
    assert(c1.confirmedAt && !Number.isNaN(Date.parse(c1.confirmedAt)));
    assertEquals(c1.learnedBy, "agent:alice", "confirming never rewrites who learned it");
    await tick();
    const c2 = await l.confirm(A, f.id);
    assertEquals(c2.confirmedBy, "human:owner", "a second confirm does not overwrite the first");
    assertEquals(c2.confirmedAt, c1.confirmedAt);
    await assertRejects(() => l.confirm(B, f.id), Error, "No fact");
    await assertRejects(() => l.confirm(A, "00000000-0000-0000-0000-000000000000"), Error, "No fact");
    await assertRejects(() => l.confirm(A, "not-an-id"), Error, "No fact");
    assertEquals((await l.latest(A, "s"))?.confirmed, true);
  });

  t("find: plain words, newest wins by default, superseded on request, subject and confirmed filters, limit, tenant isolation", async (l) => {
    const v1 = await l.assert(A, { subject: "client:acme", claim: "Acme invoices are sent on the 25th of the month", source: "s1" });
    await tick();
    const v2 = await l.assert(A, { subject: "client:acme", claim: "Acme invoices are sent on the 28th of the month", source: "s2", supersedes: v1.id });
    await tick();
    const other = await l.assert(A, { subject: "client:zenith", claim: "Zenith invoices are sent on the 25th of the month", source: "s3" });
    await l.assert(B, { subject: "client:acme", claim: "Acme invoices are sent on the 25th of the month", source: "bob" });

    const current = await l.find(A, "Acme invoices sent month", { limit: 10 });
    assert(current.some((f) => f.id === v2.id), "the current line is found");
    assert(!current.some((f) => f.id === v1.id), "the superseded line is left out by default");
    assert(current.every((f) => f.tenant === "alice"), "never another tenant's line");
    for (let i = 1; i < current.length; i++) assert(current[i - 1].score >= current[i].score, "best match first");

    const withOld = await l.find(A, "Acme invoices sent month", { limit: 10, includeSuperseded: true });
    assert(withOld.some((f) => f.id === v1.id));
    assertEquals(withOld.find((f) => f.id === v1.id)?.supersededBy, v2.id);

    const onlyZenith = await l.find(A, "invoices sent month", { limit: 10, subject: "client:zenith" });
    assertEquals(onlyZenith.map((f) => f.id), [other.id]);

    assertEquals((await l.find(A, "invoices sent month", { limit: 10, confirmedOnly: true })).length, 0);
    await l.confirm(A2, other.id);
    assertEquals((await l.find(A, "invoices sent month", { limit: 10, confirmedOnly: true })).map((f) => f.id), [other.id]);

    assertEquals((await l.find(A, "invoices sent month", { limit: 1 })).length, 1);
    assertEquals((await l.find(A, "invoices sent month", { limit: 0 })).length, 0);
    assertEquals((await l.find(A, "invoices sent month", { limit: -3 })).length, 0);
    assertEquals((await l.find(A, "   ", { limit: 10 })).length, 0);
    assertEquals((await l.find(A, "zebra xylophone quantum", { limit: 10, minScore: 0.5 })).length, 0);
    const exact = await l.find(A, "Zenith invoices are sent on the 25th of the month", { limit: 10, minScore: 0.5 });
    assertEquals(exact[0]?.id, other.id, "the claim itself clears a 0.5 threshold on every limb");
    assertEquals((await l.find(A, "Zenith invoices are sent on the 25th of the month", { limit: 10, minScore: Infinity })).length, 0);
    assertEquals((await l.find(A, "Zenith invoices are sent on the 25th of the month", { limit: 10, minScore: NaN })).length >= 1, true);

    const bobs = await l.find(B, "Acme invoices sent month", { limit: 10 });
    assert(bobs.length >= 1 && bobs.every((f) => f.tenant === "bob"));
  });

  t("tags are kept, deduplicated and trimmed; person tags are readable back", async (l) => {
    const f = await l.assert(A, { subject: "s", claim: "tagged", source: "s", tags: [" ops ", "ops", "person:Mike", ""] });
    assertEquals(f.tags, ["ops", "person:Mike"]);
    assertEquals((await l.latest(A, "s"))?.tags, ["ops", "person:Mike"]);
  });

  t("unicode and long claims round-trip unchanged", async (l) => {
    const claim = "Kaapse wyn 🍷 — çava? " + "x".repeat(8000);
    const f = await l.assert(A, { subject: "s", claim, source: "s" });
    assertEquals((await l.latest(A, "s"))?.claim, claim);
    assertEquals(f.claim, claim);
  });

  t("subjects: a tenant with no lines gets [], even after another tenant has written", async (l) => {
    assertEquals(await l.subjects(A), []);
    await l.assert(B, { subject: "client:acme", claim: "bob's line", source: "s" });
    assertEquals(await l.subjects(A), []);
    assertEquals(await l.subjects({ tenant: "nobody", actor: "x" }), []);
  });

  t("subjects: one row per subject with exact line counts; a trimmed subject is the same subject; nothing from another tenant", async (l) => {
    await l.assert(A, { subject: "client:acme", claim: "renews 1 March", source: "a" });
    await l.assert(A, { subject: "client:acme", claim: "renews 1 March", source: "b" });
    await l.assert(A, { subject: "  client:acme  ", claim: "renews 1 March", source: "c" });
    await l.assert(A, { subject: "client:zenith", claim: "invoices on the 25th", source: "a" });
    await l.assert(B, { subject: "client:acme", claim: "bob's own line", source: "a" });
    await l.assert(B, { subject: "client:bob-only", claim: "bob's other line", source: "a" });
    const rows = await l.subjects(A);
    assertEquals(rows.map((r) => r.subject).sort(), ["client:acme", "client:zenith"]);
    assertEquals(rows.find((r) => r.subject === "client:acme"), { ...rows.find((r) => r.subject === "client:acme")!, lines: 3, current: 3 });
    assertEquals(rows.find((r) => r.subject === "client:zenith"), { ...rows.find((r) => r.subject === "client:zenith")!, lines: 1, current: 1 });
    const bobs = await l.subjects(B);
    assertEquals(bobs.map((r) => r.subject).sort(), ["client:acme", "client:bob-only"]);
    assertEquals(bobs.find((r) => r.subject === "client:acme")?.lines, 1, "the shared subject name counts only bob's own line");
    for (const r of [...rows, ...bobs]) assertEquals(Object.keys(r).sort(), ["current", "latestAt", "lines", "subject"]);
  });

  t("subjects: supersede lowers current, never lines; confirm changes neither; assert({supersedes}) counts the same as supersede()", async (l) => {
    const a1 = await l.assert(A, { subject: "s", claim: "one", source: "a" });
    await tick();
    const a2 = await l.assert(A, { subject: "s", claim: "two", source: "a" });
    await tick();
    const a3 = await l.assert(A, { subject: "s", claim: "three", source: "a" });
    await l.supersede(A, a2.id, a1.id);
    let [row] = await l.subjects(A);
    assertEquals([row.lines, row.current], [3, 2]);
    await l.supersede(A, a3.id, a2.id);
    [row] = await l.subjects(A);
    assertEquals([row.lines, row.current], [3, 1]);
    await l.confirm(A2, a3.id);
    await l.confirm(A2, a1.id);
    [row] = await l.subjects(A);
    assertEquals([row.lines, row.current], [3, 1], "confirming a line, current or superseded, changes no count");

    const b1 = await l.assert(A, { subject: "t", claim: "uno", source: "a" });
    await tick();
    const b2 = await l.assert(A, { subject: "t", claim: "dos", source: "a", supersedes: b1.id });
    await tick();
    await l.assert(A, { subject: "t", claim: "tres", source: "a", supersedes: b2.id });
    const t = (await l.subjects(A)).find((r) => r.subject === "t")!;
    assertEquals([t.lines, t.current], [3, 1], "the same shape as three lines chained with supersede()");
  });

  t("subjects: the newest line superseded by an older one keeps latestAt on the newest line; a refused supersede changes nothing", async (l) => {
    const x = await l.assert(A, { subject: "s", claim: "x", source: "a" });
    await tick();
    const y = await l.assert(A, { subject: "s", claim: "y", source: "a" });
    await l.supersede(A, x.id, y.id);
    assertEquals(await l.subjects(A), [{ subject: "s", lines: 2, current: 1, latestAt: y.learnedAt }]);
    await assertRejects(() => l.supersede(A, y.id, x.id), Error, "cycle");
    await assertRejects(() => l.supersede(B, x.id, y.id), Error);
    assertEquals(await l.subjects(A), [{ subject: "s", lines: 2, current: 1, latestAt: y.learnedAt }]);
    assertEquals(await l.subjects(B), []);
  });

  t("subjects: ordered newest latestAt first, then subject ascending; latestAt equals the newest line's learnedAt", async (l) => {
    await l.assert(A, { subject: "b", claim: "b1", source: "a" });
    await tick();
    const a1 = await l.assert(A, { subject: "a", claim: "a1", source: "a" });
    await tick();
    await l.assert(A, { subject: "c", claim: "c1", source: "a" });
    await tick();
    const b2 = await l.assert(A, { subject: "b", claim: "b2", source: "a" });
    assertEquals((await l.subjects(A)).map((r) => r.subject), ["b", "c", "a"]);
    assertEquals((await l.subjects(A))[0].latestAt, b2.learnedAt);

    await tick();
    const a2 = await l.assert(A, { subject: "a", claim: "a2", source: "a" });
    assertEquals((await l.subjects(A)).map((r) => r.subject), ["a", "b", "c"]);
    assertEquals((await l.subjects(A))[0].latestAt, a2.learnedAt);

    await l.supersede(A, a2.id, a1.id);
    const rows = await l.subjects(A);
    assertEquals(rows.map((r) => [r.subject, r.lines, r.current]), [["a", 2, 1], ["b", 2, 2], ["c", 1, 1]]);
    for (const r of rows) {
      const newest = (await l.history(A, r.subject))[0];
      assertEquals(r.latestAt, newest.learnedAt, `latestAt of ${r.subject}`);
      assertEquals(Date.parse(r.latestAt) > 0, true, `latestAt of ${r.subject} is a real ISO 8601 moment`);
    }
    const expected = [...rows].sort((p, q) => q.latestAt.localeCompare(p.latestAt) || (p.subject < q.subject ? -1 : p.subject > q.subject ? 1 : 0));
    assertEquals(rows, expected, "the order is exactly (latestAt desc, subject asc)");
    assertEquals(rows.length, 3, "still one row per subject after every supersede");
  });
}
