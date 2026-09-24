/**
 * The Memory contract, written from the port's promises, runnable against
 * any implementation. Tries to break it: dedup on whitespace and case,
 * merge, unknown ids, malformed ids, the strict threshold, combined filters,
 * empty summary, unicode and size, concurrency, reference leaks, and
 * principal isolation for memories that claim it.
 */
import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import type { Memory } from "../core/ports/mod.ts";

export type MemoryFactory = () => Promise<{ memory: Memory; close?: () => Promise<void> }>;

const A = { tenant: "alice", actor: "alice" };
const B = { tenant: "bob", actor: "bob" };

export function runMemoryContract(name: string, make: MemoryFactory) {
  const t = (title: string, fn: (m: Memory, multiTenant: boolean) => Promise<void>) =>
    Deno.test(`[${name}] ${title}`, async () => {
      const { memory, close } = await make();
      const multiTenant = memory.isolation === "tenant";
      try {
        await fn(memory, multiTenant);
      } finally {
        await close?.();
      }
    });

  t("remember then get round-trips content and metadata", async (m) => {
    const { id, alreadyKnown } = await m.remember(A, "Acme import fix shipped", { type: "task", topics: ["acme"] });
    assertEquals(alreadyKnown, false);
    const got = await m.get(A, id);
    assert(got);
    assertEquals(got.content, "Acme import fix shipped");
    assertEquals(got.metadata.type, "task");
    assertEquals(got.metadata.topics, ["acme"]);
    assert(!Number.isNaN(Date.parse(got.createdAt)));
  });

  t("a thought with metadata.occurred_at is dated to it; a bad or missing one is dated to now; a merge never re-dates", async (m) => {
    const before = Date.now() - 1000;
    const { id } = await m.remember(A, "Rollout postponed, devices not issued", { type: "observation", occurred_at: "2026-08-31T07:15:00Z" });
    assertEquals((await m.get(A, id))!.createdAt, "2026-08-31T07:15:00.000Z");
    const bad = await m.remember(A, "Schedules still outstanding", { occurred_at: "last Tuesday" });
    assert(Date.parse((await m.get(A, bad.id))!.createdAt) >= before);
    const none = await m.remember(A, "NFC pricing shared", {});
    assert(Date.parse((await m.get(A, none.id))!.createdAt) >= before);
    const again = await m.remember(A, "Rollout postponed, devices not issued", { occurred_at: "2020-01-01T00:00:00Z" });
    assertEquals(again.alreadyKnown, true);
    assertEquals((await m.get(A, id))!.createdAt, "2026-08-31T07:15:00.000Z");
    const recent = await m.recent(A, { since: "2026-08-01", limit: 50 });
    assert(recent.some((r) => r.id === id));
  });

  t("remembering the same thought again is alreadyKnown, same id, metadata merged", async (m) => {
    const a = await m.remember(A, "Hello   World", { type: "idea", topics: ["a"] });
    const b = await m.remember(A, "  hello world ", { people: ["Mike"] });
    assertStrictEquals(b.id, a.id);
    assertEquals(b.alreadyKnown, true);
    const got = await m.get(A, a.id);
    assertEquals(got?.metadata.type, "idea");
    assertEquals(got?.metadata.people, ["Mike"]);
    assertEquals((await m.summary(A)).count, 1);
  });

  t("known: null before, the id after, by the same notion of sameness as remember; blank is never known", async (m) => {
    assertStrictEquals(await m.known(A, "Acme renews in March"), null);
    const { id } = await m.remember(A, "Acme renews in March", { type: "task" });
    assertStrictEquals(await m.known(A, "Acme renews in March"), id);
    assertStrictEquals(await m.known(A, "  acme   RENEWS in march \n"), id);
    assertStrictEquals(await m.known(A, "Acme renews in March!"), null);
    assertStrictEquals(await m.known(A, ""), null);
    assertStrictEquals(await m.known(A, "   "), null);
    assertEquals((await m.summary(A)).count, 1, "known stores nothing");
  });

  t("different content is a different thought", async (m) => {
    const a = await m.remember(A, "alpha", {});
    const b = await m.remember(A, "alpha!", {});
    assert(a.id !== b.id);
    assertEquals((await m.summary(A)).count, 2);
  });

  t("five concurrent remembers of one thought leave one thought", async (m) => {
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => m.remember(A, "race candidate", { topics: [`t${i}`] })));
    assertEquals(new Set(rs.map((r) => r.id)).size, 1);
    assertEquals((await m.summary(A)).count, 1);
  });

  t("get of an unknown or malformed id returns null, never throws", async (m) => {
    assertStrictEquals(await m.get(A, "00000000-0000-0000-0000-000000000000"), null);
    assertStrictEquals(await m.get(A, "not-an-id"), null);
    assertStrictEquals(await m.get(A, ""), null);
    assertStrictEquals(await m.get(A, "-".repeat(36)), null);
    assertStrictEquals(await m.get(A, "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"), null);
    assertStrictEquals(await m.get(A, "00000000-0000-0000-0000-00000000000"), null);
    assertStrictEquals(await m.get(A, "00000000-0000-0000-0000-000000000000'; DROP TABLE thoughts; --"), null);
  });

  t("blank content is refused, whatever the whitespace, and nothing is stored", async (m) => {
    for (const blank of ["", " ", "\n\t  \r\n", "  "]) {
      let threw = false;
      try {
        await m.remember(A, blank, { type: "idea" });
      } catch {
        threw = true;
      }
      assert(threw, `remember(${JSON.stringify(blank)}) must throw`);
    }
    assertEquals((await m.summary(A)).count, 0);
    assertEquals((await m.recent(A, { limit: 10 })).length, 0);
  });

  t("recall bounds: negative, NaN, fractional limit; NaN, negative and >1 minScore all behave identically", async (m) => {
    await m.remember(A, "bounded apples", {});
    await m.remember(A, "bounded pears", {});
    await m.remember(A, "bounded plums", {});
    assertEquals((await m.recall(A, "bounded", { limit: -1, minScore: 0 })).length, 0);
    assertEquals((await m.recall(A, "bounded", { limit: NaN, minScore: 0 })).length, 0);
    assertEquals((await m.recall(A, "bounded", { limit: -Infinity, minScore: 0 })).length, 0);
    assertEquals((await m.recall(A, "bounded apples", { limit: 1.9, minScore: 0 })).length, 1, "1.9 rounds down to 1; the exact row always scores");
    assert((await m.recall(A, "bounded apples", { limit: 2.9, minScore: 0 })).length <= 2, "2.9 rounds down to 2");
    const asZero = await m.recall(A, "bounded", { limit: 10, minScore: 0 });
    assertEquals((await m.recall(A, "bounded", { limit: 10, minScore: NaN })).map((r) => r.id), asZero.map((r) => r.id));
    assertEquals((await m.recall(A, "bounded", { limit: 10, minScore: -3 })).map((r) => r.id), asZero.map((r) => r.id));
    assertEquals((await m.recall(A, "bounded apples", { limit: 10, minScore: 5 })).length, 0, "minScore above 1 can match nothing");
    assertEquals((await m.recall(A, "bounded apples", { limit: 10, minScore: Infinity })).length, 0);
  });

  t("recent sourcePrefix: only thoughts whose source starts with it; a prefix that is a LIKE wildcard is literal; combines with since and type", async (m) => {
    const a = await m.remember(A, "Servest report hold stays", { type: "observation", source: "discord:g/111/1", occurred_at: "2026-09-01T08:00:00Z" });
    const b = await m.remember(A, "Servest schedules loaded", { type: "task", source: "discord:g/111/2", occurred_at: "2026-09-10T08:00:00Z" });
    await m.remember(A, "Swanzo ticket blocked", { type: "observation", source: "discord:g/222/3", occurred_at: "2026-09-10T08:00:00Z" });
    await m.remember(A, "Session ended", { type: "observation", source: "claude-code:session_1" });
    const c = await m.remember(A, "Percent sign source", { type: "observation", source: "discord:g/11%/9" });
    const ch = await m.recent(A, { limit: 10, sourcePrefix: "discord:g/111/" });
    assertEquals(ch.map((t) => t.id).sort(), [a.id, b.id].sort(), "one channel, both lines, not 11%/");
    assertEquals((await m.recent(A, { limit: 10, sourcePrefix: "discord:g/111/", since: "2026-09-05" })).map((t) => t.id), [b.id]);
    assertEquals((await m.recent(A, { limit: 10, sourcePrefix: "discord:g/111/", type: "task" })).map((t) => t.id), [b.id]);
    assertEquals((await m.recent(A, { limit: 10, sourcePrefix: "discord:g/11%/" })).map((t) => t.id), [c.id], "% is literal, not a wildcard");
    assertEquals((await m.recent(A, { limit: 10, sourcePrefix: "discord:g/1" })).length, 3, "a prefix is a prefix");
    assertEquals((await m.recent(A, { limit: 10, sourcePrefix: "nothing:" })).length, 0);
    if (m.isolation === "tenant") assertEquals((await m.recent(B, { limit: 10, sourcePrefix: "discord:" })).length, 0, "never another tenant's");
  });

  t("recent bounds: negative, NaN and fractional limit; a non-ISO `since` is an error, not an empty list", async (m) => {
    await m.remember(A, "r1", {});
    await m.remember(A, "r2", {});
    assertEquals((await m.recent(A, { limit: -5 })).length, 0);
    assertEquals((await m.recent(A, { limit: NaN })).length, 0);
    assertEquals((await m.recent(A, { limit: 1.7 })).length, 1);
    for (const bad of ["yesterday", "now", "1 day ago", "garbage", "2026-13-40T00:00:00Z", ""]) {
      let threw = false;
      try {
        await m.recent(A, { limit: 10, since: bad });
      } catch {
        threw = true;
      }
      assert(threw, `since=${JSON.stringify(bad)} must throw`);
    }
    assertEquals((await m.recent(A, { limit: 10, since: "2000-01-01T00:00:00Z" })).length, 2);
    assertEquals((await m.recent(A, { limit: 10, since: "2000-01-01" })).length, 2);
  });

  t("recall: the thought itself scores highest, unrelated text scores below 0.5, threshold is strict", async (m) => {
    await m.remember(A, "The quarterly fuel reconciliation for Jag Petroleum is overdue", {});
    await m.remember(A, "Bothasig weather is mild in September", {});
    const hit = await m.recall(A, "The quarterly fuel reconciliation for Jag Petroleum is overdue", { limit: 10, minScore: 0.5 });
    assert(hit.length >= 1, "exact text recalls itself");
    assert(hit[0].content.includes("Jag Petroleum"));
    assert(hit[0].score > 0.5 && hit[0].score <= 1, `score ${hit[0].score}`);
    const top = hit[0].score;
    const atTop = await m.recall(A, "The quarterly fuel reconciliation for Jag Petroleum is overdue", { limit: 10, minScore: top });
    assertEquals(atTop.filter((r) => r.content.includes("Jag Petroleum")).length, 0, "score equal to minScore is excluded");
    const miss = await m.recall(A, "zebra xylophone quantum", { limit: 10, minScore: 0.5 });
    assertEquals(miss.length, 0);
  });

  t("recall respects limit and orders best first", async (m) => {
    await m.remember(A, "red apples are sweet", {});
    await m.remember(A, "red apples", {});
    await m.remember(A, "green pears are sour", {});
    const r = await m.recall(A, "red apples", { limit: 1, minScore: 0 });
    assertEquals(r.length, 1);
    const all = await m.recall(A, "red apples", { limit: 10, minScore: 0 });
    for (let i = 1; i < all.length; i++) assert(all[i - 1].score >= all[i].score);
  });

  t("recent: newest first, limit, combined type + topic + person + since", async (m) => {
    const since = new Date(Date.now() - 60_000).toISOString();
    await m.remember(A, "one", { type: "task", topics: ["ops"], people: ["Mike"] });
    await m.remember(A, "two", { type: "task", topics: ["ops"], people: ["Owner"] });
    await m.remember(A, "three", { type: "idea", topics: ["ops"], people: ["Mike"] });
    assertEquals((await m.recent(A, { limit: 10 })).map((r) => r.content), ["three", "two", "one"]);
    assertEquals((await m.recent(A, { limit: 2 })).length, 2);
    assertEquals((await m.recent(A, { limit: 10, type: "task", topic: "ops", person: "Mike", since })).map((r) => r.content), ["one"]);
    assertEquals((await m.recent(A, { limit: 10, since: new Date(Date.now() + 3_600_000).toISOString() })).length, 0);
    assertEquals((await m.recent(A, { limit: 0 })).length, 0);
  });

  t("recent orders by when a thought happened, not when it was stored: history imported out of order reads in date order both ways", async (m) => {
    const c = await m.remember(A, "Everything is showing now", { occurred_at: "2026-09-23T12:11:00Z" });
    const a = await m.remember(A, "Schedules deleted and recreated", { occurred_at: "2026-09-22T09:36:00Z" });
    const b = await m.remember(A, "Restored the deleted schedules for Paulos", { occurred_at: "2026-09-22T13:09:00Z" });
    assertEquals((await m.recent(A, { limit: 10 })).map((t) => t.id), [c.id, b.id, a.id], "newest first by date");
    assertEquals((await m.recent(A, { limit: 10, order: "oldest" })).map((t) => t.id), [a.id, b.id, c.id], "oldest first by date");
    assertEquals((await m.recent(A, { limit: 2, order: "oldest" })).map((t) => t.id), [a.id, b.id], "limit keeps the OLDEST two, not the newest two reversed");
    assertEquals((await m.recent(A, { limit: 1 })).map((t) => t.id), [c.id]);
    assertEquals((await m.recent(A, { limit: 10, order: "newest" })).map((t) => t.id), [c.id, b.id, a.id], "explicit newest equals the default");
  });

  t("recent until: exclusive upper bound; since is inclusive; since == until and since > until are empty; a non-ISO until is an error", async (m) => {
    const nine = await m.remember(A, "nine o'clock", { occurred_at: "2026-09-22T09:00:00Z" });
    const ten = await m.remember(A, "ten o'clock", { occurred_at: "2026-09-22T10:00:00Z" });
    await m.remember(A, "eleven o'clock", { occurred_at: "2026-09-22T11:00:00Z" });
    assertEquals((await m.recent(A, { limit: 10, until: "2026-09-22T10:00:00Z" })).map((t) => t.id), [nine.id], "a thought AT until is excluded");
    assertEquals((await m.recent(A, { limit: 10, since: "2026-09-22T10:00:00Z", until: "2026-09-22T11:00:00Z" })).map((t) => t.id), [ten.id], "a thought AT since is included");
    assertEquals((await m.recent(A, { limit: 10, since: "2026-09-22T10:00:00Z", until: "2026-09-22T10:00:00Z" })).length, 0);
    assertEquals((await m.recent(A, { limit: 10, since: "2026-09-22T11:00:00Z", until: "2026-09-22T09:00:00Z" })).length, 0, "an inverted window is empty, not an error");
    assertEquals((await m.recent(A, { limit: 10, until: "2026-09-22T12:00:00+02:00" })).map((t) => t.id), [nine.id], "an offset is honoured: 12:00+02:00 is 10:00Z");
    for (const bad of ["tomorrow", "", "2026-13-01", "22/09/2026"]) {
      let threw = false;
      try {
        await m.recent(A, { limit: 10, until: bad });
      } catch {
        threw = true;
      }
      assert(threw, `until=${JSON.stringify(bad)} must throw`);
    }
  });

  t("recent offset pages without gaps or repeats, even when many thoughts share one timestamp; bad offsets are bounded like limit", async (m) => {
    const same = "2026-09-22T15:13:00Z";
    const ids: string[] = [];
    for (const w of ["alpha", "bravo", "charlie", "delta", "echo"]) ids.push((await m.remember(A, `burst ${w}`, { occurred_at: same })).id);
    ids.push((await m.remember(A, "before the burst", { occurred_at: "2026-09-22T15:00:00Z" })).id);
    ids.push((await m.remember(A, "after the burst", { occurred_at: "2026-09-22T16:00:00Z" })).id);
    for (const order of ["newest", "oldest"] as const) {
      const whole = (await m.recent(A, { limit: 100, order })).map((t) => t.id);
      assertEquals(new Set(whole).size, whole.length, `${order}: no duplicates in one read`);
      const paged: string[] = [];
      for (let offset = 0; offset < 10; offset += 2) paged.push(...(await m.recent(A, { limit: 2, offset, order })).map((t) => t.id));
      assertEquals(paged, whole, `${order}: pages of 2 concatenate to exactly the single read`);
      assertEquals(new Set(paged).size, ids.length, `${order}: every thought appears once`);
    }
    const newest = (await m.recent(A, { limit: 100 })).map((t) => t.id);
    assertEquals((await m.recent(A, { limit: 100, order: "oldest" })).map((t) => t.id), [...newest].reverse(), "oldest is exactly newest reversed, ties included");
    assertEquals((await m.recent(A, { limit: 10, offset: 100 })).length, 0, "an offset past the end is empty");
    assertEquals((await m.recent(A, { limit: 2, offset: -3 })).map((t) => t.id), newest.slice(0, 2), "a negative offset is 0");
    assertEquals((await m.recent(A, { limit: 2, offset: NaN })).map((t) => t.id), newest.slice(0, 2), "NaN offset is 0");
    assertEquals((await m.recent(A, { limit: 2, offset: 1.9 })).map((t) => t.id), newest.slice(1, 3), "a fractional offset rounds down");
  });

  t("recent channel: exact name, any case, optional #, never a prefix or a wildcard; thread messages belong to their channel; odd metadata never crashes", async (m) => {
    const q1 = await m.remember(A, "Can we restore some schedules", { channel: "queries", occurred_at: "2026-09-22T13:09:00Z" });
    const q2 = await m.remember(A, "Everything is showing now", { channel: "Queries", thread: "marlin schedules", occurred_at: "2026-09-23T12:11:00Z" });
    await m.remember(A, "Old queries archive line", { channel: "queries-old" });
    await m.remember(A, "Retail creative update", { channel: "retail_creative" });
    await m.remember(A, "Lookalike channel", { channel: "retailXcreative" });
    await m.remember(A, "Percent channel", { channel: "50%" });
    await m.remember(A, "Numeric channel metadata", { channel: 42 });
    await m.remember(A, "Array channel metadata", { channel: ["queries"] });
    await m.remember(A, "No channel at all", {});
    const ids = async (channel: string, extra: Record<string, unknown> = {}) => (await m.recent(A, { limit: 50, order: "oldest", channel, ...extra })).map((t) => t.id);
    assertEquals(await ids("queries"), [q1.id, q2.id], "both cases, the thread line included, not queries-old, not the array");
    assertEquals(await ids("#queries"), [q1.id, q2.id], "a leading # is ignored");
    assertEquals(await ids("  QUERIES  "), [q1.id, q2.id], "case and outer spaces are ignored");
    assertEquals(await ids("querie"), [], "a channel is not a prefix");
    assertEquals((await ids("retail_creative")).length, 1, "_ is not a wildcard");
    assertEquals((await ids("50%")).length, 1, "% is literal");
    assertEquals(await ids("5%"), [], "% does not match anything else");
    assertEquals(await ids("queries", { since: "2026-09-23T00:00:00Z" }), [q2.id], "combines with since");
    assertEquals(await ids("queries", { until: "2026-09-23T00:00:00Z" }), [q1.id], "combines with until");
    if (m.isolation === "tenant") assertEquals((await m.recent(B, { limit: 10, channel: "queries" })).length, 0, "never another tenant's");
  });

  t("summary oldest and newest are by date, not by storage order", async (m) => {
    await m.remember(A, "stored first, happened last", { occurred_at: "2026-09-23T12:00:00Z" });
    await m.remember(A, "stored second, happened first", { occurred_at: "2026-01-01T00:00:00Z" });
    await m.remember(A, "stored last, happened in between", { occurred_at: "2026-05-01T00:00:00Z" });
    const s = await m.summary(A);
    assertEquals(s.oldest, "2026-01-01T00:00:00.000Z");
    assertEquals(s.newest, "2026-09-23T12:00:00.000Z");
  });

  t("summary of an empty memory", async (m) => {
    assertEquals(await m.summary(A), { count: 0, types: {}, topics: {}, people: {} });
  });

  t("summary counts, oldest and newest", async (m) => {
    await m.remember(A, "s1", { type: "idea", topics: ["x"], people: ["Ann"] });
    await m.remember(A, "s2", { type: "task", topics: ["x", "y"] });
    const s = await m.summary(A);
    assertEquals(s.count, 2);
    assertEquals(s.types, { idea: 1, task: 1 });
    assertEquals(s.topics, { x: 2, y: 1 });
    assertEquals(s.people, { Ann: 1 });
    assert(s.oldest && s.newest && Date.parse(s.oldest) <= Date.parse(s.newest));
  });

  t("unicode and long content round-trip unchanged", async (m) => {
    const content = "Kaapse wyn 🍷 — çava? " + "x".repeat(10_000);
    const { id } = await m.remember(A, content, {});
    assertEquals((await m.get(A, id))?.content, content);
  });

  t("metadata is never held by reference", async (m) => {
    const meta = { topics: ["mutable"] };
    const { id } = await m.remember(A, "ref check", meta);
    meta.topics.push("leak");
    const got = await m.get(A, id);
    assertEquals(got?.metadata.topics, ["mutable"]);
    (got!.metadata.topics as string[]).push("leak2");
    assertEquals((await m.get(A, id))?.metadata.topics, ["mutable"]);
  });

  t("tenant isolation: a tenant-isolating memory never shows bob alice's thoughts", async (m, multiTenant) => {
    const { id } = await m.remember(A, "alice's secret", { type: "idea" });
    if (!multiTenant) return;
    assertStrictEquals(await m.get(B, id), null);
    assertStrictEquals(await m.known(B, "alice's secret"), null, "known never crosses tenants");
    assertEquals((await m.recall(B, "alice's secret", { limit: 10, minScore: 0 })).length, 0);
    assertEquals((await m.recent(B, { limit: 10 })).length, 0);
    assertEquals((await m.summary(B)).count, 0);
  });

  t("tenant isolation: two tenants with the same sentence get two ids, neither is 'already known', neither merges the other's metadata", async (m, multiTenant) => {
    if (!multiTenant) return;
    const a = await m.remember(A, "The invoice run is on the 25th", { type: "task", topics: ["alice-topic"] });
    const b = await m.remember(B, "the invoice run is on the 25th", { type: "idea", topics: ["bob-topic"] });
    assertNotEquals(a.id, b.id);
    assertEquals(a.alreadyKnown, false);
    assertEquals(b.alreadyKnown, false);
    assertEquals((await m.get(A, a.id))?.metadata.topics, ["alice-topic"]);
    assertEquals((await m.get(B, b.id))?.metadata.topics, ["bob-topic"]);
    assertStrictEquals(await m.get(A, b.id), null);
    assertStrictEquals(await m.get(B, a.id), null);
    assertEquals((await m.summary(A)).count, 1);
    assertEquals((await m.summary(B)).count, 1);
    const again = await m.remember(B, "THE INVOICE RUN IS ON THE 25TH", { people: ["Bob"] });
    assertEquals(again.id, b.id);
    assertEquals(again.alreadyKnown, true);
    assertEquals((await m.get(A, a.id))?.metadata.people, undefined, "bob's merge never touches alice's row");
  });

  t("the actor is never a partition: two actors of one tenant share the same thoughts", async (m) => {
    const asAgent = { tenant: "alice", actor: "agent:one" };
    const asHuman = { tenant: "alice", actor: "human:two" };
    const { id } = await m.remember(asAgent, "shared within the tenant", {});
    assert(await m.get(asHuman, id));
    assertEquals((await m.remember(asHuman, "shared within the tenant", {})).alreadyKnown, true);
    assertEquals((await m.summary(asHuman)).count, 1);
  });
}
