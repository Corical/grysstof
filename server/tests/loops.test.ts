/**
 * Open loops (plan 5, contracts C1 to C3): the state line, the loop key and its generations,
 * closing acceptance, and the /browse/api/loops route. Written to break the parser with hostile
 * text, to hand the reducers their input in the wrong order, and to prove nothing unreadable
 * is ever silently dropped.
 */
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { Hono } from "hono";
import {
  acceptClose,
  classifySighting,
  type ClosedLine,
  type ClosingMessage,
  compose,
  LIMITS,
  type LoopLine,
  loopQuery,
  type LoopView,
  mergeEvidence,
  type OpenLine,
  type ParkedLine,
  parse,
  readLoop,
  type ResolvedLine,
  sanitise,
  sanitiseLine,
  selectLoops,
} from "../core/loops.ts";
import { buildApp } from "../core/app.ts";
import type { CoreOptions, Fact, Ports } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { FixedUnderstander } from "../adapters/understanding/llm.ts";
import { OpenGate, SharedKeyGate } from "../adapters/gate.ts";
import { NullLog, RecordingLog } from "../adapters/log.ts";
import { InProcessLedger } from "../adapters/ledger/in-process.ts";

// --- fixtures ---

const openLine = (key: string, over: Partial<OpenLine> = {}): OpenLine => ({
  tag: "OPEN", key, client: "servest", type: "unanswered_question", owner: "Kelli", channel: "servest", channelId: "900",
  opened: "2026-10-20T08:00:00.000Z", reopened: null, title: `Loop ${key}`, summary: "Waiting on an answer", evidence: [key], ...over,
});
const closedLine = (key: string, over: Partial<ClosedLine> = {}): ClosedLine => ({ tag: "CLOSED", key, byMessage: "m-close", closed: "2026-10-21T08:00:00.000Z", reason: "answered in channel", ...over });
const resolvedLine = (key: string, over: Partial<ResolvedLine> = {}): ResolvedLine => ({ tag: "RESOLVED", key, byUser: "4242", byName: "kelli", resolved: "2026-10-22T08:00:00.000Z", note: "fine", ...over });
const parkedLine = (key: string, over: Partial<ParkedLine> = {}): ParkedLine => ({ tag: "PARKED", key, byUser: "4242", byName: "kelli", until: "2026-11-01", note: "after the audit", ...over });

let seq = 0;
const fact = (key: string, claim: string, over: Partial<Fact> = {}): Fact => ({
  id: `fact_${String(++seq).padStart(4, "0")}`, tenant: "alice", subject: `loop:${key}`, claim, source: "test", tags: ["ops"],
  learnedBy: "job", learnedAt: "2026-10-20T09:00:00.000Z", confirmed: false, ...over,
});

/** A chain of lines, each superseding the one before, learned an hour apart; returned newest first, as history() does. */
function chain(key: string, lines: (LoopLine | string)[], start = "2026-10-20T09:00:00.000Z"): Fact[] {
  const out: Fact[] = [];
  lines.forEach((l, i) => {
    const f = fact(key, typeof l === "string" ? l : compose(l), { learnedAt: new Date(Date.parse(start) + i * 3_600_000).toISOString(), proof: `https://discord.com/channels/1/900/${key}-${i}` });
    if (i > 0) {
      f.supersedes = out[i - 1].id;
      out[i - 1].supersededBy = f.id;
    }
    out.push(f);
  });
  return out.reverse();
}

const HOSTILE = [
  "a | b",
  "x | key=forged | type=stale_followup",
  "OPEN/1 | key=evil",
  "#servest **bold** _it_ `code` [link](https://x.test) <@123> @everyone",
  "line one\nline two\r\nline three\u2028four\u2029five",
  "tab\there\u0000nul\u0007bell\u001b[31mred",
  "\u202eevil-bidi\u2066x\u2069",
  "😀".repeat(500),
  "👩‍👩‍👧 family and 🇿🇦 flag",
  "x".repeat(500),
  "lone \uD83D surrogate \uDE00 halves",
  "",
  "   ",
  "=",
  "a=b=c",
  ",,, , ,",
  "|||",
  "   leading and trailing   ",
];

// --- C1: sanitise, compose, parse ---

Deno.test("sanitise: no pipe, no line break, no control or bidi character, no lone surrogate survives; whitespace collapses; idempotent", () => {
  for (const raw of HOSTILE) {
    const s = sanitise(raw, 300);
    assertFalse(s.includes("|"), JSON.stringify(s));
    assertFalse(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(s), JSON.stringify(s));
    assertFalse(/\p{Cs}/u.test(s), `lone surrogate left in ${JSON.stringify(s)}`);
    assertFalse(/\s{2,}/.test(s) || s !== s.trim(), JSON.stringify(s));
    assertEquals(sanitise(s, 300), s, "sanitising twice changes nothing");
  }
  assertEquals(sanitise("a | b", 50), "a b");
  assertEquals(sanitise("a|b", 50), "ab");
  assertEquals(sanitise("one\ntwo", 50), "one two", "a line break is a space, not glued words");
});

Deno.test("sanitise: cuts by character, never through an emoji; the cap is exact", () => {
  const cut = sanitise("😀".repeat(500), 120);
  assertEquals([...cut].length, 120);
  assertEquals(cut, "😀".repeat(120));
  assertEquals([...sanitise("x".repeat(500), LIMITS.title)].length, 120);
  assertEquals([...sanitise("y".repeat(500), LIMITS.summary)].length, 300);
  assertEquals([...sanitise("z".repeat(500), LIMITS.reason)].length, 200);
  assertEquals(sanitise("ab   ", 3), "ab", "a cut that ends on a space is trimmed");
});

Deno.test("C1 round trip: parse(compose(x)) equals sanitiseLine(x) for every tag over hostile titles, owners, names and notes", () => {
  for (const h of HOSTILE) {
    const lines: LoopLine[] = [
      openLine("111", { title: h, owner: h, summary: h, channel: h, client: h || "internal", evidence: [h, "m1", h] }),
      closedLine("111", { reason: h, byMessage: `m${h.length}` }),
      resolvedLine("111", { byName: h, note: h }),
      parkedLine("111", { byName: h, note: h }),
    ];
    for (const x of lines) {
      const line = compose(x);
      assertFalse(/[\r\n]/.test(line), "a single physical line");
      const segments = { OPEN: 12, CLOSED: 5, RESOLVED: 6, PARKED: 6 }[x.tag];
      assertEquals(line.split("|").length, segments, `hostile text made extra fields: ${line}`);
      const back = parse(line);
      assert(back.ok, `${x.tag} with ${JSON.stringify(h)} did not parse: ${JSON.stringify(back)}`);
      assertEquals(back.line, sanitiseLine(x));
      assertEquals(compose(sanitiseLine(x)), line, "composing the sanitised line gives the same text");
      assertEquals(back.line.key, "111", "no title can forge the key");
      if (back.line.tag === "OPEN") assertEquals(back.line.type, "unanswered_question", "no title can forge the type");
    }
  }
});

Deno.test("C1: evidence keeps at most 8 ids, newest kept, no commas or spaces, no duplicates, no blanks", () => {
  const ids = ["m1", "m2", "m2", " m3 ", "m,4", "", "m5", "m6", "m7", "m8", "m9", "m10"];
  const back = parse(compose(openLine("1", { evidence: ids })));
  assert(back.ok);
  assert(back.line.tag === "OPEN");
  assertEquals(back.line.evidence, ["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
  const none = parse(compose(openLine("1", { evidence: [] })));
  assert(none.ok && none.line.tag === "OPEN");
  assertEquals(none.line.evidence, []);
});

Deno.test("C1: compose refuses a line parse could not read back, rather than writing it", () => {
  assertThrows(() => compose(openLine("")), Error, "key");
  assertThrows(() => compose(openLine(" | ")), Error, "key");
  assertThrows(() => compose(openLine("1", { type: "chit_chat" as OpenLine["type"] })), Error, "type");
  assertThrows(() => compose(openLine("1", { opened: "yesterday" })), Error, "opened");
  assertThrows(() => compose(openLine("1", { opened: "12" })), Error, "opened"); // Date.parse("12") is a valid date in V8
  assertThrows(() => compose(openLine("1", { reopened: "soon" })), Error, "reopened");
  assertThrows(() => compose(closedLine("1", { closed: "" })), Error, "closed");
  assertThrows(() => compose(closedLine("1", { byMessage: " " })), Error, "by_message");
  assertThrows(() => compose(resolvedLine("1", { resolved: "now" })), Error, "resolved");
  assertThrows(() => compose(resolvedLine("1", { byUser: "" })), Error, "by_user");
  assertThrows(() => compose(parkedLine("1", { until: "next week" })), Error, "until");
  assertThrows(() => compose({ tag: "DONE", key: "1" } as unknown as LoopLine), Error, "tag");
});

Deno.test("C1 parse: unknown tag, unknown version, wrong case, missing, extra or repeated field, a bare word, two lines, nothing: all unreadable, none throw", () => {
  const good = compose(openLine("7"));
  const bad = [
    "DONE/1 | key=7",
    good.replace("OPEN/1", "OPEN/2"),
    good.replace("OPEN/1", "open/1"),
    good.replace("OPEN/1", "OPEN"),
    good.replace(/ \| evidence=[^|]*$/, ""),
    `${good} | colour=red`,
    `${good} | key=8`,
    good.replace("key=7", "key"),
    good.replace("key=7", "key="),
    good.replace("type=unanswered_question", "type=gossip"),
    good.replace("opened=2026-10-20T08:00:00.000Z", "opened=last Tuesday"),
    good.replace("reopened=-", "reopened=later"),
    `${good}\n${good}`,
    "",
    "   ",
    "Kelli asked about the schedules",
    compose(closedLine("7")).replace(/ \| closed=[^|]*/, ""),
    compose(parkedLine("7")).replace("until=2026-11-01", "until=after the audit"),
  ];
  for (const claim of bad) {
    const r = parse(claim);
    assert(!r.ok, `should be unreadable: ${JSON.stringify(claim)}`);
    assert(typeof r.reason === "string" && r.reason.length > 0);
  }
});

Deno.test("C1 parse: tolerant where the meaning is unambiguous: no spaces around bars, fields in another order, reopened blank or dash", () => {
  const tight = parse("CLOSED/1|key=7|by_message=m9|closed=2026-10-21T08:00:00Z|reason=done");
  assert(tight.ok);
  assertEquals(tight.line, { tag: "CLOSED", key: "7", byMessage: "m9", closed: "2026-10-21T08:00:00Z", reason: "done" });
  const shuffled = parse("RESOLVED/1 | note=ok | resolved=2026-10-22 | by_name=kelli | by_user=4242 | key=7");
  assert(shuffled.ok);
  assertEquals(shuffled.line, { tag: "RESOLVED", key: "7", byUser: "4242", byName: "kelli", resolved: "2026-10-22", note: "ok" });
  for (const blank of ["reopened=-", "reopened="]) {
    const r = parse(compose(openLine("7")).replace("reopened=-", blank));
    assert(r.ok && r.line.tag === "OPEN");
    assertEquals(r.line.reopened, null, blank);
  }
});

// --- readLoop: one subject's history to one loop ---

Deno.test("readLoop: an unreadable head is reported with its line id, never dropped and never thrown", () => {
  for (const claim of ["garbage", "DONE/1 | key=5", compose(openLine("5")).replace("OPEN/1", "OPEN/9")]) {
    const h = chain("5", [openLine("5"), claim]);
    const r = readLoop("loop:5", h);
    assert(!r.ok);
    assertEquals(r.unreadable.subject, "loop:5");
    assertEquals(r.unreadable.lineId, h[0].id, "the line that could not be read, so a person can find it");
  }
});

Deno.test("readLoop: RESOLVED, CLOSED and PARKED heads carry the opener's fields, the head's id and time, and the opener's link", () => {
  const resolved = readLoop("loop:5", chain("5", [openLine("5", { title: "Schedules for Servest" }), resolvedLine("5")]));
  assert(resolved.ok);
  const r = resolved.loop;
  assertEquals([r.state, r.title, r.client, r.owner, r.channelId, r.opened], ["resolved", "Schedules for Servest", "servest", "Kelli", "900", "2026-10-20T08:00:00.000Z"]);
  assertEquals([r.closed, r.byUser, r.byName, r.note, r.byMessage, r.until], ["2026-10-22T08:00:00.000Z", "4242", "kelli", "fine", null, null]);
  assertEquals(r.proof, "https://discord.com/channels/1/900/5-0", "the opener's link, not the resolving press");
  assertEquals(r.fork, false);
  assertEquals(r.learnedAt, "2026-10-20T10:00:00.000Z");

  const closed = readLoop("loop:5", chain("5", [openLine("5"), closedLine("5")]));
  assert(closed.ok);
  assertEquals([closed.loop.state, closed.loop.closed, closed.loop.byMessage, closed.loop.note, closed.loop.byUser], ["closed", "2026-10-21T08:00:00.000Z", "m-close", "answered in channel", null]);

  const parked = readLoop("loop:5", chain("5", [openLine("5"), parkedLine("5")]));
  assert(parked.ok);
  assertEquals([parked.loop.state, parked.loop.until, parked.loop.byName, parked.loop.closed], ["parked", "2026-11-01", "kelli", null]);
});

Deno.test("readLoop: a reopened loop is open again, keeps reopened, and shows nothing of the close it came back from", () => {
  const h = chain("5", [openLine("5"), closedLine("5"), openLine("5", { reopened: "2026-10-23T08:00:00.000Z", evidence: ["5", "m7"] })]);
  const r = readLoop("loop:5", h);
  assert(r.ok);
  assertEquals([r.loop.state, r.loop.reopened, r.loop.closed, r.loop.byMessage, r.loop.note], ["open", "2026-10-23T08:00:00.000Z", null, null, null]);
  assertEquals(r.loop.evidence, ["5", "m7"]);
  assertEquals(r.loop.lineId, h[0].id);
});

Deno.test("readLoop: the newest readable OPEN in the chain wins over a garbled older one; with no readable OPEN at all the loop is unreadable", () => {
  const ok = readLoop("loop:5", chain("5", ["OPEN/1 | garbled", openLine("5", { title: "second try" }), resolvedLine("5")]));
  assert(ok.ok);
  assertEquals(ok.loop.title, "second try");
  const h = chain("5", ["OPEN/1 | garbled", resolvedLine("5")]);
  const none = readLoop("loop:5", h);
  assert(!none.ok);
  assertEquals(none.unreadable.lineId, h[0].id);
  const bare = readLoop("loop:6", chain("6", [closedLine("6")]));
  assert(!bare.ok, "a CLOSED line with no OPEN behind it is not a loop anyone can read");
});

Deno.test("readLoop: a line whose key is not its subject's key is unreadable, not quietly shown under the wrong loop", () => {
  const r = readLoop("loop:5", chain("5", [openLine("6")]));
  assert(!r.ok);
});

Deno.test("C2 rule 4: a fork resolves to the newest learnedAt whatever order history arrives in, and says fork: true", () => {
  const open = fact("5", compose(openLine("5")), { learnedAt: "2026-10-20T09:00:00.000Z" });
  const resolved = fact("5", compose(resolvedLine("5")), { learnedAt: "2026-10-20T10:00:00.000Z", supersedes: open.id });
  open.supersededBy = resolved.id;
  const parked = fact("5", compose(parkedLine("5")), { learnedAt: "2026-10-20T11:00:00.000Z", supersedes: open.id }); // lost the race: a second head
  for (const order of [[resolved, parked, open], [open, resolved, parked], [parked, open, resolved]]) {
    const r = readLoop("loop:5", order);
    assert(r.ok);
    assertEquals([r.loop.state, r.loop.lineId, r.loop.fork], ["parked", parked.id, true]);
    assertEquals(r.loop.title, "Loop 5", "the fork's head still finds the opener");
  }
  const twin = fact("5", compose(resolvedLine("5")), { id: "fact_zzzz", learnedAt: parked.learnedAt });
  const a = readLoop("loop:5", [parked, twin, open, resolved]);
  const b = readLoop("loop:5", [twin, open, resolved, parked]);
  assert(a.ok && b.ok);
  assertEquals(a.loop.lineId, b.loop.lineId, "a same-moment fork is broken the same way every time");
  const single = readLoop("loop:5", chain("5", [openLine("5"), resolvedLine("5")]));
  assert(single.ok);
  assertEquals(single.loop.fork, false);
});

Deno.test("readLoop: history handed over oldest first gives the same loop as newest first", () => {
  const h = chain("5", [openLine("5"), closedLine("5"), openLine("5", { reopened: "2026-10-23T08:00:00.000Z" }), parkedLine("5")]);
  const a = readLoop("loop:5", h);
  const b = readLoop("loop:5", [...h].reverse());
  assert(a.ok && b.ok);
  assertEquals(a.loop, b.loop);
});

// --- C2: generations ---

const view = (key: string, state: LoopView["state"], over: Partial<LoopView> = {}): LoopView => ({
  key, subject: `loop:${key}`, lineId: `fact_${key}`, state, client: "servest", type: "unanswered_question", owner: "Kelli", channel: "servest",
  channelId: "900", opened: "2026-10-20T08:00:00.000Z", reopened: null, title: `Loop ${key}`, summary: "", evidence: [], proof: null,
  closed: state === "closed" || state === "resolved" ? "2026-10-21T08:00:00.000Z" : null, byMessage: null, byUser: null, byName: null,
  until: null, note: null, fork: false, learnedAt: "2026-10-21T09:00:00.000Z", ...over,
});
const at = (id: string, iso: string) => ({ id, at: iso });

Deno.test("C2: an opener nobody has seen is a new loop on its own id", () => {
  assertEquals(classifySighting("123", [at("123", "2026-10-20T08:00:00Z")], []), { kind: "create", key: "123" });
  assertEquals(classifySighting("123", [at("123", "2026-10-20T08:00:00Z")], [view("1234", "open"), view("12", "open"), view("123:b", "open")]), { kind: "create", key: "123" }, "a longer id, a shorter id and a sibling ask are not this loop");
});

Deno.test("C2 rule 1: an OPEN loop gets evidence_add; a PARKED loop gets nothing written", () => {
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], [view("123", "open")]), { kind: "evidence_add", key: "123" });
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], [view("123", "parked")]), { kind: "ignore", key: "123" });
});

Deno.test("C2 rule 2: a finished loop seen again with nothing newer than its close is suppressed, the boundary included", () => {
  const closed = view("123", "closed", { closed: "2026-10-21T08:00:00.000Z" });
  assertEquals(classifySighting("123", [at("123", "2026-10-20T08:00:00Z"), at("m5", "2026-10-21T08:00:00.000Z")], [closed]), { kind: "suppressed", key: "123" });
  assertEquals(classifySighting("123", [at("m5", "2026-10-21T10:00:00+02:00")], [closed]), { kind: "suppressed", key: "123" }, "the same instant in another offset is not later");
  const resolved = view("123", "resolved", { closed: "2026-10-22T08:00:00.000Z" });
  assertEquals(classifySighting("123", [at("m5", "2026-10-21T23:59:59Z")], [resolved]).kind, "suppressed");
  assertEquals(classifySighting("123", [at("m5", "not a time")], [closed]).kind, "suppressed", "a time nobody can read never opens a new generation");
  assertEquals(classifySighting("123", [], [closed]).kind, "suppressed");
});

Deno.test("C2 rule 2: any cited message after the close is a new ask on the same opener: the next generation", () => {
  const closed = view("123", "closed", { closed: "2026-10-21T08:00:00.000Z" });
  assertEquals(classifySighting("123", [at("123", "2026-10-20T08:00:00Z"), at("m8", "2026-10-21T08:00:00.001Z")], [closed]), { kind: "new_generation", key: "123:2" });
  const loops = [view("123:3", "resolved", { closed: "2026-10-24T08:00:00.000Z" }), view("123", "closed"), view("123:2", "closed")];
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], loops), { kind: "new_generation", key: "123:4" }, "the newest generation decides, whatever the order");
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], [view("123", "closed"), view("123:2", "open")]), { kind: "evidence_add", key: "123:2" });
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], [view("123:b", "closed"), view("123:b:2", "open")]).kind, "create", "the :b family is a different loop");
  assertEquals(classifySighting("123:b", [at("m9", "2026-10-25T08:00:00Z")], [view("123:b", "closed"), view("123", "open")]), { kind: "new_generation", key: "123:b:2" });
  assertEquals(classifySighting("123", [at("m9", "2026-10-25T08:00:00Z")], [view("123", "closed"), view("123:01", "open"), view("123:1", "open")]).kind, "new_generation", ":01 and :1 are not generations");
});

Deno.test("evidence_add writes only when the stored list changes", () => {
  assertEquals(mergeEvidence(["m1", "m2"], ["m2", "m1"]), { evidence: ["m1", "m2"], changed: false });
  assertEquals(mergeEvidence(["m1", "m2"], []), { evidence: ["m1", "m2"], changed: false });
  assertEquals(mergeEvidence(["m1", "m2"], ["m3"]), { evidence: ["m1", "m2", "m3"], changed: true });
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assertEquals(mergeEvidence(eight, ["a"]), { evidence: eight, changed: false }, "re-citing the oldest keeps the list");
  assertEquals(mergeEvidence(eight, ["i"]), { evidence: [...eight.slice(1), "i"], changed: true }, "the oldest drops off");
  assertEquals(mergeEvidence(["m1"], [" m1 ", "m,1"]).changed, false, "a dirty copy of a stored id is the same id");
});

// --- C5 closing acceptance, as pure rules ---

const loop = { channel: "servest", channelId: "900", opened: "2026-10-20T08:00:00.000Z", reopened: null as string | null };
const MEMBERS = { ids: ["4242", "5151"], names: ["Kelli", "Corné"] };
const msg = (over: Partial<ClosingMessage> = {}): ClosingMessage => ({ id: "m9", at: "2026-10-21T08:00:00.000Z", channelId: "900", parentId: null, channel: "servest", authorId: "4242", authorName: "Kelli", ...over });

Deno.test("closing: a member's later reply in the loop's channel closes it", () => {
  assertEquals(acceptClose(loop, msg(), MEMBERS), { ok: true, weak: [] });
});

Deno.test("closing: a reply with the wrong channel id is refused even when the channel name matches", () => {
  assertEquals(acceptClose(loop, msg({ channelId: "901" }), MEMBERS), { ok: false, reason: "wrong_channel" });
  assertEquals(acceptClose(loop, msg({ channelId: "901", parentId: "902" }), MEMBERS), { ok: false, reason: "wrong_channel" });
});

Deno.test("closing: a thread reply whose parent is the loop's channel closes it", () => {
  assertEquals(acceptClose(loop, msg({ channelId: "777", parentId: "900", channel: "servest" }), MEMBERS), { ok: true, weak: [] });
});

Deno.test("closing: the channel name is a fallback only when the message carries no ids, and it says so", () => {
  assertEquals(acceptClose(loop, msg({ channelId: null, parentId: null, channel: "#Servest " }), MEMBERS), { ok: true, weak: ["channel_name"] });
  assertEquals(acceptClose(loop, msg({ channelId: undefined, parentId: undefined, channel: "swanzo" }), MEMBERS), { ok: false, reason: "wrong_channel" });
  assertEquals(acceptClose(loop, msg({ channelId: null, parentId: "900" }), MEMBERS), { ok: true, weak: [] }, "a parent id alone is an id");
});

Deno.test("closing: a reply at or before the opener, or at or before a reopen, is refused", () => {
  assertEquals(acceptClose(loop, msg({ at: "2026-10-19T08:00:00Z" }), MEMBERS), { ok: false, reason: "too_early" });
  assertEquals(acceptClose(loop, msg({ at: "2026-10-20T10:00:00+02:00" }), MEMBERS), { ok: false, reason: "too_early" }, "the opener's own instant is not later");
  const reopened = { ...loop, reopened: "2026-10-23T08:00:00.000Z" };
  assertEquals(acceptClose(reopened, msg({ at: "2026-10-21T08:00:00Z" }), MEMBERS), { ok: false, reason: "before_reopen" }, "the reply that closed it last time cannot close it again");
  assertEquals(acceptClose(reopened, msg({ at: "2026-10-23T08:00:00Z" }), MEMBERS), { ok: false, reason: "before_reopen" });
  assertEquals(acceptClose(reopened, msg({ at: "2026-10-23T08:00:01Z" }), MEMBERS), { ok: true, weak: [] });
  assertEquals(acceptClose(loop, msg({ at: "whenever" }), MEMBERS), { ok: false, reason: "bad_time" });
});

Deno.test("closing: a client's reply never closes a loop; a known id wins over a lookalike name", () => {
  assertEquals(acceptClose(loop, msg({ authorId: "999", authorName: "Kelli" }), MEMBERS), { ok: false, reason: "not_member" }, "a name that looks like a member's is not the member");
  assertEquals(acceptClose(loop, msg({ authorId: null, authorName: " kelli " }), MEMBERS), { ok: true, weak: ["author_name"] });
  assertEquals(acceptClose(loop, msg({ authorId: null, authorName: "Sipho (Servest)" }), MEMBERS), { ok: false, reason: "not_member" });
  assertEquals(acceptClose(loop, msg({ authorId: null, authorName: null }), MEMBERS), { ok: false, reason: "not_member" });
  assertEquals(acceptClose(loop, msg({ channelId: null, parentId: null, authorId: null }), MEMBERS), { ok: true, weak: ["channel_name", "author_name"] });
});

Deno.test("closing: a cited message that is not in the window is refused", () => {
  assertEquals(acceptClose(loop, undefined, MEMBERS), { ok: false, reason: "not_in_window" });
});

// --- the query and its selection ---

Deno.test("loopQuery: state defaults to open; an unknown state or a since that is not ISO 8601 is an error", () => {
  assertEquals(loopQuery({ limit: 200 }).states, ["open"]);
  assertEquals(loopQuery({ state: "all", limit: 5 }).states, ["open", "parked", "closed", "resolved"]);
  for (const state of ["OPEN", "done", "open,closed", " open"]) assertThrows(() => loopQuery({ state, limit: 1 }), Error, "state");
  for (const since of ["yesterday", "12", "26/10/2026"]) assertThrows(() => loopQuery({ since, limit: 1 }), Error, "since");
});

Deno.test("selectLoops: closed and resolved default to the last 30 days; open and parked have no default window", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const old = view("1", "closed", { closed: "2026-09-20T12:00:00Z" });
  const recent = view("2", "resolved", { closed: "2026-10-20T12:00:00Z" });
  const ancientOpen = view("3", "open", { opened: "2025-01-01T00:00:00Z" });
  const all = loopQuery({ state: "all", limit: 50 });
  assertEquals(selectLoops([old, recent, ancientOpen], all, now).loops.map((l) => l.key), ["3", "2"]);
  const since = loopQuery({ state: "all", since: "2026-09-01", limit: 50 });
  assertEquals(selectLoops([old, recent, ancientOpen], since, now).loops.map((l) => l.key), ["1", "2"], "an explicit since replaces the 30-day default and applies to every state");
  const later = loopQuery({ state: "all", since: "2026-10-01T00:00:00+02:00", limit: 50 });
  assertEquals(selectLoops([old, recent, ancientOpen], later, now).loops.map((l) => l.key), ["2"]);
});

// --- the route ---

const OPTIONS: CoreOptions = { citationBase: "https://brain.test/t" };
const understood = { type: "task" as const, topics: ["ops"], people: [], action_items: [], dates_mentioned: [] };
const ALICE = { tenant: "alice", actor: "job" };

function rig(over: Partial<Ports> = {}) {
  let clock = Date.parse("2026-10-20T09:00:00Z");
  const ledger = new InProcessLedger(() => new Date(clock));
  const log = new RecordingLog();
  const ports: Ports = { memory: new KeywordMemory(), ledger, understander: new FixedUnderstander(understood), gate: new OpenGate(true, "alice", "alice"), log, ...over };
  const app = buildApp(ports, OPTIONS);
  const write = async (line: LoopLine | string, opts: { subject?: string; supersedes?: string; tags?: string[]; scope?: typeof ALICE } = {}) => {
    clock += 60_000;
    const key = typeof line === "string" ? "x" : line.key;
    return await ledger.assert(opts.scope ?? ALICE, {
      subject: opts.subject ?? `loop:${key}`, claim: typeof line === "string" ? line : compose(line), source: "test",
      proof: `https://discord.com/channels/1/900/${key}`, tags: opts.tags ?? ["ops"], ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    });
  };
  return { app, ledger, log, write };
}

async function getJson(app: Hono, path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers });
  return { status: res.status, body: await res.json() };
}

const VIEW_KEYS = ["byMessage", "byName", "byUser", "channel", "channelId", "client", "closed", "evidence", "fork", "key", "learnedAt", "lineId", "note", "opened", "owner", "proof", "reopened", "state", "subject", "summary", "title", "type", "until"];

Deno.test("/loops: open by default, sorted by opened then key in code-point order whatever order they were written; exactly the C3 shape", async () => {
  const { app, write } = rig();
  await write(openLine("9", { opened: "2026-10-20T08:00:00Z" }));
  await write(openLine("10", { opened: "2026-10-20T08:00:00Z" }));
  await write(openLine("200", { opened: "2026-10-20T09:00:00+02:00" })); // 07:00Z: sorts after "…08:00:00Z" as text, before it as time
  await write(openLine("3", { opened: "2026-10-21T08:00:00Z" }));
  const parked = await write(openLine("p", { opened: "2026-10-01T08:00:00Z" }));
  await write(parkedLine("p"), { supersedes: parked.id });
  await write("Servest renews on 1 March", { subject: "client:servest" });

  const { status, body } = await getJson(app, "/browse/api/loops");
  assertEquals(status, 200);
  assertEquals(Object.keys(body).sort(), ["loops", "total", "unreadable", "warnings"]);
  assertEquals(body.loops.map((l: LoopView) => l.key), ["200", "10", "9", "3"], "07:00Z, then 08:00Z twice (\"10\" before \"9\"), then the 21st");
  assertEquals(body.total, 4);
  assertEquals(body.unreadable, []);
  assertEquals(body.warnings, { understandFailed: 0 });
  for (const l of body.loops) assertEquals(Object.keys(l).sort(), VIEW_KEYS);
  const first = body.loops[0] as LoopView;
  assertEquals([first.subject, first.state, first.proof, first.fork, first.reopened, first.closed], ["loop:200", "open", "https://discord.com/channels/1/900/200", false, null, null]);
});

Deno.test("/loops: state filters, the 30-day default for closed and resolved, an explicit since, client in either spelling, and limit against total", async () => {
  const { app, write } = rig();
  const day = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  const a = await write(openLine("a", { opened: ago(50), client: "servest" }));
  await write(closedLine("a", { closed: ago(40) }), { supersedes: a.id });
  const b = await write(openLine("b", { opened: ago(20), client: "servest" }));
  await write(closedLine("b", { closed: ago(5) }), { supersedes: b.id });
  const c = await write(openLine("c", { opened: ago(10), client: "swanzo" }));
  await write(resolvedLine("c", { resolved: ago(2) }), { supersedes: c.id });
  await write(openLine("d", { opened: ago(3), client: "Servest" }));
  await write(openLine("e", { opened: ago(1), client: "internal" }));

  const keys = async (q: string) => (await getJson(app, `/browse/api/loops${q}`)).body.loops.map((l: LoopView) => l.key);
  assertEquals(await keys("?state=closed"), ["b"], "closed 40 days ago is outside the default window");
  assertEquals(await keys(`?state=closed&since=${ago(60)}`), ["a", "b"]);
  assertEquals(await keys("?state=resolved"), ["c"]);
  assertEquals(await keys("?state=all"), ["b", "c", "d", "e"]);
  assertEquals(await keys(`?state=open&since=${ago(2)}`), ["e"]);
  assertEquals(await keys("?state=all&client=servest"), ["b", "d"]);
  assertEquals(await keys("?state=all&client=client:SERVEST"), ["b", "d"]);
  const limited = (await getJson(app, "/browse/api/loops?state=all&limit=1")).body;
  assertEquals([limited.loops.length, limited.total], [1, 4]);
  assertEquals((await getJson(app, "/browse/api/loops?state=all&limit=0")).body.loops, []);
  assertEquals((await keys("?state=all&limit=abc")).length, 4, "a limit that is not a number is the default");
});

Deno.test("/loops: an unreadable loop is listed under unreadable with its line id and logged, never dropped and never shown as a loop", async () => {
  const { app, write, log } = rig();
  await write(openLine("good"));
  const bad = await write("OPEN/2 | key=bad | from the future", { subject: "loop:bad" });
  const gone = await write(openLine("gone"));
  const garbled = await write("RESOLVED/1 | key=gone | by_user=", { subject: "loop:gone", supersedes: gone.id });
  const { body } = await getJson(app, "/browse/api/loops?state=all");
  assertEquals(body.loops.map((l: LoopView) => l.key), ["good"]);
  assertEquals(body.unreadable, [{ subject: "loop:bad", lineId: bad.id }, { subject: "loop:gone", lineId: garbled.id }]);
  const logged = log.events.filter((e) => e.event === "loops.unreadable");
  assertEquals(logged.map((e) => e.fields?.lineId).sort(), [bad.id, garbled.id].sort());
  assert(logged.every((e) => e.level === "warn" && typeof e.fields?.reason === "string" && e.fields?.tenant === "alice"));
});

Deno.test("/loops: a fork shows the newest head with fork: true and is logged", async () => {
  const { app, write, log } = rig();
  const open = await write(openLine("f"));
  await write(resolvedLine("f"), { supersedes: open.id });
  const second = await write(parkedLine("f")); // no supersedes: a second live head
  const { body } = await getJson(app, "/browse/api/loops?state=all");
  assertEquals(body.loops.length, 1);
  assertEquals([body.loops[0].state, body.loops[0].lineId, body.loops[0].fork], ["parked", second.id, true]);
  assert(log.events.some((e) => e.event === "loops.fork" && e.fields?.subject === "loop:f"));
});

Deno.test("/loops: a current line written without understanding is counted under warnings", async () => {
  const { app, write } = rig();
  await write(openLine("t1"), { tags: [] });
  const t2 = await write(openLine("t2"), { tags: [] });
  await write(resolvedLine("t2"), { supersedes: t2.id });
  await write(openLine("t3"));
  assertEquals((await getJson(app, "/browse/api/loops?state=all")).body.warnings, { understandFailed: 1 }, "only t1's current line has no tags");
});

Deno.test("/loops: another tenant's loops are invisible; a bad state or since is a 400 with the reason; the gate still applies", async () => {
  const { app, ledger, write } = rig();
  await write(openLine("mine"));
  await write(openLine("theirs"), { scope: { tenant: "bob", actor: "job" } });
  assertEquals((await getJson(app, "/browse/api/loops?state=all")).body.loops.map((l: LoopView) => l.key), ["mine"]);
  const bad = await getJson(app, "/browse/api/loops?state=done");
  assertEquals(bad.status, 400);
  assert(String(bad.body.error).includes("state"));
  const badSince = await getJson(app, "/browse/api/loops?since=last%20week");
  assertEquals(badSince.status, 400);
  assert(String(badSince.body.error).includes("since"));
  const keyed = buildApp({ memory: new KeywordMemory(), ledger, understander: new FixedUnderstander(understood), gate: new SharedKeyGate("s3cret", { tenant: "alice" }), log: new NullLog() }, OPTIONS);
  assertEquals((await getJson(keyed, "/browse/api/loops")).body.error?.code, -32001);
  assertEquals((await getJson(keyed, "/browse/api/loops", { "x-brain-key": "s3cret" })).body.loops.map((l: LoopView) => l.key), ["mine"]);
});

Deno.test("/loops: a loop's whole life through the ledger: open, resolve, reopen; the route follows the newest line each time", async () => {
  const { app, write } = rig();
  const o = await write(openLine("life"));
  const r = await write(resolvedLine("life"), { supersedes: o.id });
  const now = async () => (await getJson(app, "/browse/api/loops?state=all")).body.loops[0] as LoopView;
  assertEquals([(await now()).state, (await now()).lineId], ["resolved", r.id]);
  const back = await write(openLine("life", { reopened: "2026-10-24T08:00:00Z" }), { supersedes: r.id });
  assertEquals([(await now()).state, (await now()).lineId, (await now()).reopened], ["open", back.id, "2026-10-24T08:00:00Z"]);
});
