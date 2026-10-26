/**
 * Open loops (plan 5, contracts C1 and C3 with the v3.1 addendum): the state line, the key
 * grammar, reading a loop from its history, and the /browse/api/loops route. Written to break the
 * parser with hostile text, to hand the reader its input in the wrong order, to prove nothing
 * unreadable is ever silently dropped, and to pin the C1 fixture the job's sanitiser must match.
 * C2 and C5 (generations, closing) belong to the job and are tested there.
 */
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { Hono } from "hono";
import {
  type ClosedLine,
  compose,
  isInstant,
  KEY_RE,
  LIMITS,
  type LoopLine,
  loopQuery,
  type LoopView,
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
import type { CoreOptions, Fact, Ports, Scope } from "../core/ports/mod.ts";
import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { FixedUnderstander } from "../adapters/understanding/llm.ts";
import { OpenGate, SharedKeyGate } from "../adapters/gate.ts";
import { NullLog, RecordingLog } from "../adapters/log.ts";
import { InProcessLedger } from "../adapters/ledger/in-process.ts";

// --- fixtures ---

/** A 19-digit snowflake, as the job writes keys. */
const K = (n: number) => String(1559838169497600000n + BigInt(n));

const openLine = (key: string, over: Partial<OpenLine> = {}): OpenLine => ({
  tag: "OPEN", key, client: "servest", type: "unanswered_question", owner: "Kelli", channel: "servest", channelId: "1300000000000000101",
  opened: "2026-10-20T08:00:00.000Z", reopened: null, title: `Loop ${key}`, summary: "Waiting on an answer", evidence: [key], ...over,
});
const closedLine = (key: string, over: Partial<ClosedLine> = {}): ClosedLine => ({ tag: "CLOSED", key, byMessage: "1563100000000000001", closed: "2026-10-21T08:00:00.000Z", reason: "answered in channel", ...over });
const resolvedLine = (key: string, over: Partial<ResolvedLine> = {}): ResolvedLine => ({ tag: "RESOLVED", key, byUser: "990867950443589672", byName: "kellireynolds", resolved: "2026-10-20T09:30:00.000Z", note: "fine", ...over });
const parkedLine = (key: string, over: Partial<ParkedLine> = {}): ParkedLine => ({ tag: "PARKED", key, byUser: "990867950443589672", byName: "kellireynolds", until: "2026-11-01", note: "after the audit", ...over });

let seq = 0;
const fact = (key: string, claim: string, over: Partial<Fact> = {}): Fact => ({
  id: `fact_${String(++seq).padStart(4, "0")}`, tenant: "alice", subject: `loop:${key}`, claim, source: "test", tags: ["ops"],
  learnedBy: "job", learnedAt: "2026-10-20T09:00:00.000Z", confirmed: false, ...over,
});

/** A chain of lines, each superseding the one before, learned an hour apart from `start`; returned newest first, as history() does. */
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
  "lone \ud83d surrogate \ude00 halves",
  "nbsp and﻿bom",
  "",
  "   ",
  "=",
  "a=b=c",
  ",,, , ,",
  "|||",
  "   leading and trailing   ",
];

// --- C1: the key grammar, dates, sanitise, compose, parse ---

Deno.test("KEY_RE: 17 to 20 digits, then an optional letter, then an optional generation of 1 to 3 digits; nothing else", () => {
  const good = ["1".repeat(17), "9".repeat(20), K(1), `${K(1)}:b`, `${K(1)}:2`, `${K(1)}:b:2`, `${"9".repeat(20)}:z:999`];
  for (const k of good) assert(KEY_RE.test(k), k);
  assertEquals(`${"9".repeat(20)}:z:999`.length, 26, "the longest key there is");
  const bad = ["1".repeat(16), "1".repeat(21), `${K(1)}:1000`, `${K(1)}:B`, `${K(1)}:2:b`, `${K(1)}:bb`, `${K(1)}:`, `${K(1)}:b:`, ` ${K(1)}`, `${K(1)} `, `-${K(1)}`, "not-a-snowflake", "123:b:2:zz", ""];
  for (const k of bad) assertFalse(KEY_RE.test(k), k);
});

Deno.test("isInstant: a calendar date that does not exist is not a date, whatever Date.parse makes of it", () => {
  for (const ok of ["2026-02-28", "2028-02-29", "2026-12-31", "2026-10-20T08:00:00Z", "2026-10-20T08:00:00.123Z", "2026-10-20T10:00:00+02:00"]) assert(isInstant(ok), ok);
  for (const bad of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-02-30T08:00:00Z", "12", "yesterday", "", "26/10/2026"]) assertFalse(isInstant(bad), bad);
});

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
  assertEquals(sanitise("😀".repeat(500), 120), "😀".repeat(120));
  assertEquals([...sanitise("x".repeat(500), LIMITS.title)].length, 120);
  assertEquals([...sanitise("y".repeat(500), LIMITS.summary)].length, 300);
  assertEquals([...sanitise("z".repeat(500), LIMITS.reason)].length, 200);
  assertEquals(sanitise("ab   ", 3), "ab", "a cut that ends on a space is trimmed");
});

Deno.test("C1 round trip: parse(compose(x)) equals sanitiseLine(x) for every tag over hostile titles, owners, names and notes", () => {
  for (const h of HOSTILE) {
    const lines: LoopLine[] = [
      openLine(K(111), { title: h, owner: h, summary: h, channel: h, client: h || "internal", evidence: [h, "m1", h] }),
      closedLine(K(111), { reason: h, byMessage: `m${h.length}` }),
      resolvedLine(K(111), { byName: h, note: h }),
      parkedLine(K(111), { byName: h, note: h }),
    ];
    for (const x of lines) {
      const line = compose(x);
      assertFalse(/[\r\n]/.test(line), "a single physical line");
      assertEquals(line.split("|").length, { OPEN: 12, CLOSED: 5, RESOLVED: 6, PARKED: 6 }[x.tag], `hostile text made extra fields: ${line}`);
      const back = parse(line);
      assert(back.ok, `${x.tag} with ${JSON.stringify(h)} did not parse: ${JSON.stringify(back)}`);
      assertEquals(back.line, sanitiseLine(x));
      assertEquals(compose(sanitiseLine(x)), line, "composing the sanitised line gives the same text");
      assertEquals(back.line.key, K(111), "no title can forge the key");
      if (back.line.tag === "OPEN") assertEquals(back.line.type, "unanswered_question", "no title can forge the type");
    }
  }
});

Deno.test("C1: evidence keeps at most 8 ids, newest kept, no commas or spaces, no duplicates, no blanks", () => {
  const ids = ["m1", "m2", "m2", " m3 ", "m,4", "", "m5", "m6", "m7", "m8", "m9", "m10"];
  const back = parse(compose(openLine(K(1), { evidence: ids })));
  assert(back.ok && back.line.tag === "OPEN");
  assertEquals(back.line.evidence, ["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
  const none = parse(compose(openLine(K(1), { evidence: [] })));
  assert(none.ok && none.line.tag === "OPEN");
  assertEquals(none.line.evidence, []);
});

Deno.test("C1: compose refuses a line parse could not read back, rather than writing it: bad keys, types, impossible dates", () => {
  for (const key of ["", " | ", "abc", "1234", `${K(1)}:B`, `${K(1)}:1000`, "1".repeat(21), `${K(1)}:2:b`]) assertThrows(() => compose(openLine(key)), Error, "key", JSON.stringify(key));
  assertThrows(() => compose(openLine(K(1), { type: "chit_chat" as OpenLine["type"] })), Error, "type");
  assertThrows(() => compose(openLine(K(1), { opened: "yesterday" })), Error, "opened");
  assertThrows(() => compose(openLine(K(1), { opened: "12" })), Error, "opened"); // Date.parse("12") is a valid date in V8
  assertThrows(() => compose(openLine(K(1), { opened: "2026-02-30T08:00:00Z" })), Error, "opened");
  assertThrows(() => compose(openLine(K(1), { reopened: "soon" })), Error, "reopened");
  assertThrows(() => compose(closedLine(K(1), { closed: "" })), Error, "closed");
  assertThrows(() => compose(closedLine(K(1), { byMessage: " " })), Error, "by_message");
  assertThrows(() => compose(resolvedLine(K(1), { resolved: "now" })), Error, "resolved");
  assertThrows(() => compose(resolvedLine(K(1), { byUser: "" })), Error, "by_user");
  assertThrows(() => compose(parkedLine(K(1), { until: "next week" })), Error, "until");
  assertThrows(() => compose(parkedLine(K(1), { until: "2026-02-30" })), Error, "until", "V8 would roll it to 2 March; the job would never unpark it");
  assertThrows(() => compose({ tag: "DONE", key: K(1) } as unknown as LoopLine), Error, "tag");
});

Deno.test("C1 parse: unknown tag, version or case; missing, extra or repeated field; bad key, type or date; a bare word; two lines: all unreadable, none throw", () => {
  const good = compose(openLine(K(7)));
  const bad = [
    `DONE/1 | key=${K(7)}`,
    good.replace("OPEN/1", "OPEN/2"),
    good.replace("OPEN/1", "open/1"),
    good.replace("OPEN/1", "OPEN"),
    good.replace(/ \| evidence=[^|]*$/, ""),
    `${good} | colour=red`,
    `${good} | key=${K(8)}`,
    good.replace(`key=${K(7)}`, "key"),
    good.replace(`key=${K(7)}`, "key="),
    good.replace(`key=${K(7)}`, "key=not-a-snowflake"),
    good.replace(`key=${K(7)}`, "key=123:b:2:zz"),
    good.replace("type=unanswered_question", "type=gossip"),
    good.replace("opened=2026-10-20T08:00:00.000Z", "opened=last Tuesday"),
    good.replace("opened=2026-10-20T08:00:00.000Z", "opened=2026-13-01"),
    good.replace("reopened=-", "reopened=later"),
    `${good}\n${good}`,
    "",
    "   ",
    "Kelli asked about the schedules",
    compose(closedLine(K(7))).replace(/ \| closed=[^|]*/, ""),
    compose(parkedLine(K(7))).replace("until=2026-11-01", "until=after the audit"),
    compose(parkedLine(K(7))).replace("until=2026-11-01", "until=2026-02-30"),
  ];
  for (const claim of bad) {
    const r = parse(claim);
    assert(!r.ok, `should be unreadable: ${JSON.stringify(claim)}`);
    assert(r.reason.length > 0);
  }
});

Deno.test("C1 parse: tolerant where the meaning is unambiguous: no spaces around bars, fields in another order, reopened blank or dash", () => {
  const tight = parse(`CLOSED/1|key=${K(7)}|by_message=1563100000000000001|closed=2026-10-21T08:00:00Z|reason=done`);
  assert(tight.ok);
  assertEquals(tight.line, { tag: "CLOSED", key: K(7), byMessage: "1563100000000000001", closed: "2026-10-21T08:00:00Z", reason: "done" });
  const shuffled = parse(`RESOLVED/1 | note=ok | resolved=2026-10-22 | by_name=kelli | by_user=4242 | key=${K(7)}`);
  assert(shuffled.ok);
  assertEquals(shuffled.line, { tag: "RESOLVED", key: K(7), byUser: "4242", byName: "kelli", resolved: "2026-10-22", note: "ok" });
  for (const blank of ["reopened=-", "reopened="]) {
    const r = parse(compose(openLine(K(7))).replace("reopened=-", blank));
    assert(r.ok && r.line.tag === "OPEN");
    assertEquals(r.line.reopened, null, blank);
  }
});

Deno.test("a line the job itself wrote reads back through parse() with every field intact", () => {
  // Produced on 26 October 2026 by the job's own composer from its recorded fixture, verbatim:
  //   cd server/jobs && python3 -c "import json,sys; sys.path.insert(0,'.'); import open_loops as j;
  //     lp=json.load(open('fixtures/loops.json'))['loops'][0]; print(j.open_line(dict(lp, channel_id=lp['channelId'])))"
  const jobLine = "OPEN/1 | key=1559838169497604096 | client=servest | type=unanswered_question | owner=unclear | channel=servest | channel_id=1300000000000000101 | opened=2026-10-14T08:00:00.000Z | reopened=- | title=Site list export for Servest | summary=Site list export for Servest. | evidence=1559838169497604096";
  const r = parse(jobLine);
  assert(r.ok && r.line.tag === "OPEN", JSON.stringify(r));
  assertEquals(r.line, {
    tag: "OPEN", key: "1559838169497604096", client: "servest", type: "unanswered_question", owner: "unclear", channel: "servest",
    channelId: "1300000000000000101", opened: "2026-10-14T08:00:00.000Z", reopened: null, title: "Site list export for Servest",
    summary: "Site list export for Servest.", evidence: ["1559838169497604096"],
  });
  assertEquals(compose(r.line), jobLine, "the server would write the very same line");
  const fixture = JSON.parse(Deno.readTextFileSync(new URL("../jobs/fixtures/loops.json", import.meta.url)));
  const lp = fixture.loops[0];
  assertEquals([r.line.key, r.line.channelId, r.line.opened, r.line.title], [lp.key, lp.channelId, lp.opened, lp.title], "still the loop the job's fixture holds");
});

// --- the C1 fixture shared with the job (tests/fixtures/c1-sanitise.json) ---

type Wire = Record<string, string | string[] | null>;
const WIRE: Record<LoopLine["tag"], [string, string][]> = {
  OPEN: [["key", "key"], ["client", "client"], ["type", "type"], ["owner", "owner"], ["channel", "channel"], ["channel_id", "channelId"], ["opened", "opened"], ["reopened", "reopened"], ["title", "title"], ["summary", "summary"], ["evidence", "evidence"]],
  CLOSED: [["key", "key"], ["by_message", "byMessage"], ["closed", "closed"], ["reason", "reason"]],
  RESOLVED: [["key", "key"], ["by_user", "byUser"], ["by_name", "byName"], ["resolved", "resolved"], ["note", "note"]],
  PARKED: [["key", "key"], ["by_user", "byUser"], ["by_name", "byName"], ["until", "until"], ["note", "note"]],
};
const fromWire = (tag: LoopLine["tag"], w: Wire): LoopLine => Object.fromEntries([["tag", tag], ...WIRE[tag].map(([wire, ts]) => [ts, w[wire]])]) as unknown as LoopLine;
const toWire = (l: LoopLine): Wire => Object.fromEntries(WIRE[l.tag].map(([wire, ts]) => [wire, (l as unknown as Record<string, Wire[string]>)[ts]]));
const CAPS: Record<string, number> = { title: LIMITS.title, summary: LIMITS.summary, note: LIMITS.note, reason: LIMITS.reason, owner: LIMITS.name, channel: LIMITS.name, by_name: LIMITS.name };

type C1Fixture = {
  lines: { name: string; tag: LoopLine["tag"]; input: Wire; expected: Wire; line: string }[];
  refused: { name: string; tag: LoopLine["tag"]; input: Wire; because: string }[];
  unreadable: { name: string; claim: string }[];
};
const C1: C1Fixture = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/c1-sanitise.json", import.meta.url)));

Deno.test("C1 fixture: every case sanitises, composes and parses to exactly what the fixture says", () => {
  assert(C1.lines.length >= 8, "a fixture with a handful of cases is not a contract");
  for (const c of C1.lines) {
    const x = fromWire(c.tag, c.input);
    assertEquals(toWire(sanitiseLine(x)), c.expected, `${c.name}: sanitised`);
    assertEquals(compose(x), c.line, `${c.name}: composed`);
    const back = parse(c.line);
    assert(back.ok, `${c.name}: ${JSON.stringify(back)}`);
    assertEquals(toWire(back.line), c.expected, `${c.name}: parsed`);
    assertEquals(compose(fromWire(c.tag, c.expected)), c.line, `${c.name}: the expected fields compose to the same line`);
    for (const [field, cap] of Object.entries(CAPS)) {
      const v = c.expected[field];
      if (typeof v === "string") assert([...v].length <= cap, `${c.name}: ${field} over its cap of ${cap}`);
    }
    assertFalse(/[\u2028\u2029\u202a-\u202e\u2066-\u2069\u0000-\u001f\u007f]/.test(c.line), `${c.name}: an invisible or control character survived`);
  }
  for (const c of C1.refused) assertThrows(() => compose(fromWire(c.tag, c.input)), Error, c.because, c.name);
  for (const c of C1.unreadable) assert(!parse(c.claim).ok, c.name);
});

Deno.test("C1 fixture: covers every field of every tag with bidi, |, newlines, control characters and over-long values, 12 evidence ids and a client with spaces and commas", () => {
  const has = (tag: string, field: string, test: (v: string) => boolean) =>
    [...C1.lines, ...C1.refused].some((c) => c.tag === tag && [c.input[field]].flat().some((v) => typeof v === "string" && test(v)));
  const OVER = (field: string) => (v: string) => [...v].length > (CAPS[field] ?? LIMITS.id);
  for (const [tag, fields] of Object.entries(WIRE)) {
    for (const [field] of fields) {
      for (const [what, test] of [["bidi U+202E", (v: string) => v.includes("\u202e")], ["|", (v: string) => v.includes("|")], ["a newline", (v: string) => /[\r\n]/.test(v)], ["a control character", (v: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)], ["an over-long value", OVER(field)]] as const) {
        assert(has(tag, field, test), `no ${tag} case puts ${what} in ${field}`);
      }
    }
  }
  assert(C1.lines.some((c) => Array.isArray(c.input.evidence) && c.input.evidence.length === 12), "a case with 12 evidence ids");
  assert(C1.lines.some((c) => typeof c.input.client === "string" && / /.test(c.input.client) && /,/.test(c.input.client)), "a client with spaces and commas");
  const spaced = C1.lines.find((c) => typeof c.input.client === "string" && / /.test(c.input.client) && /,/.test(c.input.client))!;
  assertEquals(/[ ,]/.test(String(spaced.expected.client)), false, "the client comes out with neither");
});

// --- readLoop: one subject's history to one loop ---

Deno.test("readLoop: an unreadable head is reported with its line id, never dropped and never thrown", () => {
  for (const claim of ["garbage", `DONE/1 | key=${K(5)}`, compose(openLine(K(5))).replace("OPEN/1", "OPEN/9")]) {
    const h = chain(K(5), [openLine(K(5)), claim]);
    const r = readLoop(`loop:${K(5)}`, h);
    assert(!r.ok);
    assertEquals([r.unreadable.subject, r.unreadable.lineId], [`loop:${K(5)}`, h[0].id]);
  }
});

Deno.test("readLoop: a subject whose key is outside the key grammar is unreadable, however good its lines look", () => {
  for (const key of ["not-a-snowflake", "123:b:2:zz", `${K(1)}:2:b`, `${K(1)}:1000`, "1".repeat(16), ""]) {
    const claim = compose(openLine(K(1))).replace(`key=${K(1)}`, `key=${key}`);
    const h = [fact(key, claim)];
    const r = readLoop(`loop:${key}`, h);
    assert(!r.ok, key);
    assertEquals(r.unreadable.lineId, h[0].id, key);
    assert(/key/.test(r.unreadable.reason), r.unreadable.reason);
  }
});

Deno.test("readLoop: RESOLVED, CLOSED and PARKED heads carry the opener's fields, the head's id and time, and the opener's link", () => {
  const resolved = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5), { title: "Schedules for Servest" }), resolvedLine(K(5))]));
  assert(resolved.ok);
  const r = resolved.loop;
  assertEquals([r.state, r.title, r.client, r.owner, r.channelId, r.opened], ["resolved", "Schedules for Servest", "servest", "Kelli", "1300000000000000101", "2026-10-20T08:00:00.000Z"]);
  assertEquals([r.closed, r.byUser, r.byName, r.note, r.byMessage, r.until], ["2026-10-20T09:30:00.000Z", "990867950443589672", "kellireynolds", "fine", null, null]);
  assertEquals(r.proof, `https://discord.com/channels/1/900/${K(5)}-0`, "the opener's link, not the resolving press");
  assertEquals([r.fork, r.learnedAt], [false, "2026-10-20T10:00:00.000Z"]);

  const closed = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5)), closedLine(K(5))]));
  assert(closed.ok);
  assertEquals([closed.loop.state, closed.loop.closed, closed.loop.byMessage, closed.loop.note, closed.loop.byUser], ["closed", "2026-10-21T08:00:00.000Z", "1563100000000000001", "answered in channel", null]);

  const parked = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5)), parkedLine(K(5))]));
  assert(parked.ok);
  assertEquals([parked.loop.state, parked.loop.until, parked.loop.byName, parked.loop.closed], ["parked", "2026-11-01", "kellireynolds", null]);
});

Deno.test("readLoop: a RESOLVED loop finishes at the earlier of the time it claims and the time the ledger learned it; CLOSED keeps the message time", () => {
  const future = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5)), resolvedLine(K(5), { resolved: "2099-01-01T00:00:00Z" })]));
  assert(future.ok);
  assertEquals(future.loop.closed, "2026-10-20T10:00:00.000Z", "a line claiming 2099 cannot hold off every re-sighting until 2099");
  const offset = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5)), resolvedLine(K(5), { resolved: "2026-10-20T11:30:00+02:00" })]));
  assert(offset.ok);
  assertEquals(offset.loop.closed, "2026-10-20T11:30:00+02:00", "09:30Z is earlier than 10:00Z, offset or not, and is kept as written");
  const lateClose = readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(5)), closedLine(K(5), { closed: "2026-10-23T08:00:00Z" })]));
  assert(lateClose.ok);
  assertEquals(lateClose.loop.closed, "2026-10-23T08:00:00Z", "the closing message's own time, even when learned earlier");
});

Deno.test("readLoop: a reopened loop is open again, keeps reopened, and shows nothing of the close it came back from", () => {
  const h = chain(K(5), [openLine(K(5)), closedLine(K(5)), openLine(K(5), { reopened: "2026-10-23T08:00:00.000Z", evidence: [K(5), "1563100000000000007"] })]);
  const r = readLoop(`loop:${K(5)}`, h);
  assert(r.ok);
  assertEquals([r.loop.state, r.loop.reopened, r.loop.closed, r.loop.byMessage, r.loop.note, r.loop.lineId], ["open", "2026-10-23T08:00:00.000Z", null, null, null, h[0].id]);
  assertEquals(r.loop.evidence, [K(5), "1563100000000000007"]);
});

Deno.test("readLoop: the newest readable OPEN in the chain wins over a garbled older one; with no readable OPEN at all the loop is unreadable", () => {
  const ok = readLoop(`loop:${K(5)}`, chain(K(5), ["OPEN/1 | garbled", openLine(K(5), { title: "second try" }), resolvedLine(K(5))]));
  assert(ok.ok);
  assertEquals(ok.loop.title, "second try");
  const h = chain(K(5), ["OPEN/1 | garbled", resolvedLine(K(5))]);
  const none = readLoop(`loop:${K(5)}`, h);
  assert(!none.ok);
  assertEquals(none.unreadable.lineId, h[0].id);
  assert(!readLoop(`loop:${K(6)}`, chain(K(6), [closedLine(K(6))])).ok, "a CLOSED line with no OPEN behind it is not a loop anyone can read");
});

Deno.test("readLoop: a line whose key is not its subject's key is unreadable, not quietly shown under the wrong loop", () => {
  assert(!readLoop(`loop:${K(5)}`, chain(K(5), [openLine(K(6))])).ok);
});

Deno.test("readLoop: a fork resolves to the newest learnedAt whatever order history arrives in, and says fork: true", () => {
  const open = fact(K(5), compose(openLine(K(5))), { learnedAt: "2026-10-20T09:00:00.000Z" });
  const resolved = fact(K(5), compose(resolvedLine(K(5))), { learnedAt: "2026-10-20T10:00:00.000Z", supersedes: open.id });
  open.supersededBy = resolved.id;
  const parked = fact(K(5), compose(parkedLine(K(5))), { learnedAt: "2026-10-20T11:00:00.000Z", supersedes: open.id });
  for (const order of [[resolved, parked, open], [open, resolved, parked], [parked, open, resolved]]) {
    const r = readLoop(`loop:${K(5)}`, order);
    assert(r.ok);
    assertEquals([r.loop.state, r.loop.lineId, r.loop.fork, r.loop.title], ["parked", parked.id, true, `Loop ${K(5)}`]);
  }
  const twin = fact(K(5), compose(resolvedLine(K(5))), { id: "fact_zzzz", learnedAt: parked.learnedAt });
  const a = readLoop(`loop:${K(5)}`, [parked, twin, open, resolved]);
  const b = readLoop(`loop:${K(5)}`, [twin, open, resolved, parked]);
  assert(a.ok && b.ok);
  assertEquals(a.loop.lineId, b.loop.lineId, "a same-moment fork is broken the same way every time");
});

Deno.test("readLoop: history handed over oldest first gives the same loop as newest first", () => {
  const h = chain(K(5), [openLine(K(5)), closedLine(K(5)), openLine(K(5), { reopened: "2026-10-23T08:00:00.000Z" }), parkedLine(K(5))]);
  const a = readLoop(`loop:${K(5)}`, h);
  const b = readLoop(`loop:${K(5)}`, [...h].reverse());
  assert(a.ok && b.ok);
  assertEquals(a.loop, b.loop);
});

// --- the query and its selection ---

const view = (key: string, state: LoopView["state"], over: Partial<LoopView> = {}): LoopView => ({
  key, subject: `loop:${key}`, lineId: `fact_${key}`, state, client: "servest", type: "unanswered_question", owner: "Kelli", channel: "servest",
  channelId: "1300000000000000101", opened: "2026-10-20T08:00:00.000Z", reopened: null, title: `Loop ${key}`, summary: "", evidence: [], proof: null,
  closed: state === "closed" || state === "resolved" ? "2026-10-21T08:00:00.000Z" : null, byMessage: null, byUser: null, byName: null,
  until: null, note: null, fork: false, learnedAt: "2026-10-21T09:00:00.000Z", ...over,
});

Deno.test("loopQuery: state defaults to open, or to all when a key is asked for; bad state, since, key or offset is an error", () => {
  assertEquals(loopQuery({ limit: 200 }).states, ["open"]);
  assertEquals(loopQuery({ state: "all", limit: 5 }).states, ["open", "parked", "closed", "resolved"]);
  assertEquals(loopQuery({ key: K(1), limit: 5 }).states, ["open", "parked", "closed", "resolved"]);
  assertEquals(loopQuery({ key: K(1), state: "parked", limit: 5 }).states, ["parked"]);
  assertEquals(loopQuery({ limit: 5 }).offset, 0);
  assertEquals(loopQuery({ offset: "40", limit: 5 }).offset, 40);
  for (const state of ["OPEN", "done", "open,closed", " open"]) assertThrows(() => loopQuery({ state, limit: 1 }), Error, "state");
  for (const since of ["yesterday", "12", "26/10/2026", "2026-02-30"]) assertThrows(() => loopQuery({ since, limit: 1 }), Error, "since");
  for (const key of ["not-a-snowflake", "123", `${K(1)}:2:b`, ` ${K(1)}`]) assertThrows(() => loopQuery({ key, limit: 1 }), Error, "key");
  for (const offset of ["-1", "1.5", "abc", " 2", "2e3"]) assertThrows(() => loopQuery({ offset, limit: 1 }), Error, "offset");
});

Deno.test("selectLoops: since narrows closed and resolved loops only; open and parked ignore it", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const loops = [
    view(K(1), "open", { opened: "2025-01-01T00:00:00Z" }),
    view(K(2), "parked", { learnedAt: "2025-01-01T00:00:00Z" }),
    view(K(3), "closed", { closed: "2026-10-01T00:00:00Z" }),
    view(K(4), "resolved", { closed: "2026-10-25T00:00:00Z" }),
  ];
  const keys = (q: Parameters<typeof loopQuery>[0]) => selectLoops(loops, loopQuery(q), now).loops.map((l) => l.key);
  assertEquals(keys({ state: "all", since: "2026-10-20", limit: 50 }), [K(1), K(2), K(4)]);
  assertEquals(keys({ state: "open", since: "2026-10-25", limit: 50 }), [K(1)], "an open loop opened before since still shows");
  assertEquals(keys({ state: "parked", since: "2026-10-25", limit: 50 }), [K(2)]);
  assertEquals(keys({ state: "all", since: "2026-09-01", limit: 50 }), [K(1), K(2), K(3), K(4)], "an explicit since replaces the 30-day default");
});

Deno.test("selectLoops: closed and resolved default to the last 30 days, unless one loop is asked for by key", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const old = view(K(1), "closed", { closed: "2026-09-20T12:00:00Z" });
  const recent = view(K(2), "resolved", { closed: "2026-10-20T12:00:00Z" });
  const ancientOpen = view(K(3), "open", { opened: "2025-01-01T00:00:00Z" });
  const loops = [old, recent, ancientOpen];
  assertEquals(selectLoops(loops, loopQuery({ state: "all", limit: 50 }), now).loops.map((l) => l.key), [K(3), K(2)]);
  assertEquals(selectLoops(loops, loopQuery({ key: K(1), limit: 50 }), now).loops.map((l) => l.key), [K(1)], "a press re-reading a loop closed 36 days ago still finds it");
  assertEquals(selectLoops(loops, loopQuery({ key: K(1), state: "open", limit: 50 }), now).loops, [], "an explicit state still applies");
  assertEquals(selectLoops(loops, loopQuery({ key: K(9), limit: 50 }), now), { loops: [], total: 0 });
});

Deno.test("selectLoops: offset pages tile the sorted list exactly, total never moves, past the end is empty", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const loops = Array.from({ length: 7 }, (_, i) => view(K(10 - i), "open", { opened: `2026-10-2${i % 3}T08:00:00Z` }));
  const all = selectLoops(loops, loopQuery({ limit: 50 }), now).loops.map((l) => l.key);
  const paged: string[] = [];
  for (const offset of ["0", "3", "6"]) {
    const page = selectLoops(loops, loopQuery({ offset, limit: 3 }), now);
    assertEquals(page.total, 7);
    paged.push(...page.loops.map((l) => l.key));
  }
  assertEquals(paged, all, "no loop repeated or skipped across pages");
  assertEquals(selectLoops(loops, loopQuery({ offset: "7", limit: 3 }), now), { loops: [], total: 7 });
});

// --- the route ---

const OPTIONS: CoreOptions = { citationBase: "https://brain.test/t" };
const understood = { type: "task" as const, topics: ["ops"], people: [], action_items: [], dates_mentioned: [] };
const ALICE = { tenant: "alice", actor: "job" };
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
// Route tests run against the real clock (the route's 30-day window), so every time in them is relative to now.
const rOpen = (key: string, over: Partial<OpenLine> = {}) => openLine(key, { opened: ago(6), ...over });
const rClosed = (key: string, over: Partial<ClosedLine> = {}) => closedLine(key, { closed: ago(1), ...over });
const rResolved = (key: string, over: Partial<ResolvedLine> = {}) => resolvedLine(key, { resolved: ago(1), ...over });
const rParked = (key: string, over: Partial<ParkedLine> = {}) => parkedLine(key, { until: ago(-5).slice(0, 10), ...over });

class SpyLedger extends InProcessLedger {
  histories: string[] = [];
  subjectReads = 0;
  override history(scope: Scope, subject: string) {
    this.histories.push(subject);
    return super.history(scope, subject);
  }
  override subjects(scope: Scope) {
    this.subjectReads++;
    return super.subjects(scope);
  }
}

function rig(over: Partial<Ports> = {}) {
  let clock = Date.now() - 2 * DAY;
  const ledger = new SpyLedger(() => new Date(clock));
  const log = new RecordingLog();
  const ports: Ports = { memory: new KeywordMemory(), ledger, understander: new FixedUnderstander(understood), gate: new OpenGate(true, "alice", "alice"), log, ...over };
  const app = buildApp(ports, OPTIONS);
  const write = async (line: LoopLine | string, opts: { subject?: string; supersedes?: string; tags?: string[]; scope?: Scope } = {}) => {
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
const keysOf = (body: { loops: LoopView[] }) => body.loops.map((l) => l.key);

const VIEW_KEYS = ["byMessage", "byName", "byUser", "channel", "channelId", "client", "closed", "evidence", "fork", "key", "learnedAt", "lineId", "note", "opened", "owner", "proof", "reopened", "state", "subject", "summary", "title", "type", "until"];

Deno.test("/loops: open by default, sorted by opened instant then key in code-point order whatever order they were written; exactly the C3 shape", async () => {
  const { app, write } = rig();
  const short = "99999999999999999", long = "100000000000000000"; // numerically short < long; as text "1…" < "9…"
  await write(rOpen(short, { opened: "2026-10-20T08:00:00Z" }));
  await write(rOpen(long, { opened: "2026-10-20T08:00:00Z" }));
  await write(rOpen(K(200), { opened: "2026-10-20T09:00:00+02:00" })); // 07:00Z: after "…08:00:00Z" as text, before it as time
  await write(rOpen(K(3), { opened: "2026-10-21T08:00:00Z" }));
  const parked = await write(rOpen(K(4), { opened: "2026-10-01T08:00:00Z" }));
  await write(rParked(K(4)), { supersedes: parked.id });
  await write("Servest renews on 1 March", { subject: "client:servest" });

  const { status, body } = await getJson(app, "/browse/api/loops");
  assertEquals(status, 200);
  assertEquals(Object.keys(body).sort(), ["loops", "total", "unreadable", "warnings"]);
  assertEquals(keysOf(body), [K(200), long, short, K(3)]);
  assertEquals([body.total, body.unreadable, body.warnings], [4, [], { understandFailed: 0 }]);
  for (const l of body.loops) assertEquals(Object.keys(l).sort(), VIEW_KEYS);
  const first = body.loops[0] as LoopView;
  assertEquals([first.subject, first.state, first.proof, first.fork, first.reopened, first.closed], [`loop:${K(200)}`, "open", `https://discord.com/channels/1/900/${K(200)}`, false, null, null]);
});

Deno.test("/loops: state filters, the 30-day default for finished loops, since for finished loops only, client in either spelling, limit against total", async () => {
  const { app, write } = rig();
  const a = await write(rOpen(K(1), { opened: ago(50) }));
  await write(rClosed(K(1), { closed: ago(40) }), { supersedes: a.id });
  const b = await write(rOpen(K(2), { opened: ago(20) }));
  await write(rClosed(K(2), { closed: ago(5) }), { supersedes: b.id });
  const c = await write(rOpen(K(3), { opened: ago(10), client: "swanzo" }));
  await write(rResolved(K(3), { resolved: ago(2) }), { supersedes: c.id });
  await write(rOpen(K(4), { opened: ago(9), client: "Servest" }));
  await write(rOpen(K(5), { opened: ago(1), client: "internal" }));

  const keys = async (q: string) => keysOf((await getJson(app, `/browse/api/loops${q}`)).body);
  assertEquals(await keys("?state=closed"), [K(2)], "closed 40 days ago is outside the default window");
  assertEquals(await keys(`?state=closed&since=${ago(60)}`), [K(1), K(2)]);
  assertEquals(await keys(`?state=closed&since=${ago(3)}`), []);
  assertEquals(await keys("?state=resolved"), [K(3)]);
  assertEquals(await keys("?state=all"), [K(2), K(3), K(4), K(5)]);
  assertEquals(await keys(`?state=open&since=${ago(2)}`), [K(4), K(5)], "since never hides an open loop");
  assertEquals(await keys("?state=all&client=servest"), [K(2), K(4)]);
  assertEquals(await keys("?state=all&client=client:SERVEST"), [K(2), K(4)]);
  const limited = (await getJson(app, "/browse/api/loops?state=all&limit=1")).body;
  assertEquals([limited.loops.length, limited.total], [1, 4]);
  assertEquals((await getJson(app, "/browse/api/loops?state=all&limit=0")).body.loops, []);
  assertEquals((await keys("?state=all&limit=abc")).length, 4, "a limit that is not a number is the default");
});

Deno.test("/loops key=: exactly one loop in any state and age, read from its own subject only; a bad key is a 400", async () => {
  const { app, ledger, write } = rig();
  const o = await write(rOpen(K(1), { opened: ago(60) }));
  await write(rResolved(K(1), { resolved: ago(45) }), { supersedes: o.id });
  await write(rOpen(K(2)));
  await write(rOpen(`${K(2)}:b`));
  ledger.histories.length = 0;
  ledger.subjectReads = 0;
  const one = (await getJson(app, `/browse/api/loops?key=${K(1)}`)).body;
  assertEquals([keysOf(one), one.loops[0].state, one.total], [[K(1)], "resolved", 1], "resolved 45 days ago, outside every default window");
  assertEquals([ledger.histories, ledger.subjectReads], [[`loop:${K(1)}`], 0], "one subject read, no scan of every loop");
  assertEquals(keysOf((await getJson(app, `/browse/api/loops?key=${K(2)}`)).body), [K(2)], "never its :b sibling");
  assertEquals(keysOf((await getJson(app, `/browse/api/loops?key=${encodeURIComponent(`${K(2)}:b`)}`)).body), [`${K(2)}:b`]);
  assertEquals((await getJson(app, `/browse/api/loops?key=${K(1)}&state=open`)).body.loops, []);
  assertEquals((await getJson(app, `/browse/api/loops?key=${K(9)}`)).body, { loops: [], unreadable: [], warnings: { understandFailed: 0 }, total: 0 });
  const bad = await getJson(app, "/browse/api/loops?key=not-a-snowflake");
  assertEquals(bad.status, 400);
  assert(String(bad.body.error).includes("key"));
});

Deno.test("/loops offset=: pages tile the list with no loop repeated or skipped; a bad offset is a 400", async () => {
  const { app, write } = rig();
  for (let i = 1; i <= 5; i++) await write(rOpen(K(i), { opened: ago(10 - i) }));
  const pages: string[] = [];
  for (const offset of [0, 2, 4]) {
    const body = (await getJson(app, `/browse/api/loops?limit=2&offset=${offset}`)).body;
    assertEquals(body.total, 5);
    pages.push(...keysOf(body));
  }
  assertEquals(pages, [K(1), K(2), K(3), K(4), K(5)]);
  assertEquals((await getJson(app, "/browse/api/loops?offset=9")).body.loops, []);
  const bad = await getJson(app, "/browse/api/loops?offset=-1");
  assertEquals(bad.status, 400);
  assert(String(bad.body.error).includes("offset"));
});

Deno.test("/loops: a RESOLVED line claiming a future time is placed at when the ledger learned it", async () => {
  const { app, write } = rig();
  const o = await write(rOpen(K(1)));
  const r = await write(rResolved(K(1), { resolved: "2099-01-01T00:00:00Z" }), { supersedes: o.id });
  const loop = (await getJson(app, `/browse/api/loops?key=${K(1)}`)).body.loops[0] as LoopView;
  assertEquals(loop.closed, r.learnedAt);
});

Deno.test("/loops: unreadable and out-of-grammar loops are listed with their line ids, never dropped; each is logged once, the count once per call", async () => {
  const { app, write, log } = rig();
  await write(rOpen(K(1)));
  const bad = await write(`OPEN/2 | key=${K(2)} | from the future`, { subject: `loop:${K(2)}` });
  const gone = await write(rOpen(K(3)));
  const garbled = await write(`RESOLVED/1 | key=${K(3)} | by_user=`, { subject: `loop:${K(3)}`, supersedes: gone.id });
  const odd = await write(compose(rOpen(K(4))).replace(`key=${K(4)}`, "key=not-a-snowflake"), { subject: "loop:not-a-snowflake" });
  const call = async () => (await getJson(app, "/browse/api/loops?state=all")).body;
  const first = await call();
  assertEquals(keysOf(first), [K(1)]);
  assertEquals(first.unreadable, [{ subject: `loop:${K(2)}`, lineId: bad.id }, { subject: `loop:${K(3)}`, lineId: garbled.id }, { subject: "loop:not-a-snowflake", lineId: odd.id }]);
  await call();
  await call();
  const details = log.events.filter((e) => e.event === "loops.unreadable");
  assertEquals(details.map((e) => e.fields?.lineId).sort(), [bad.id, garbled.id, odd.id].sort(), "three calls, each line logged once");
  assert(details.every((e) => e.level === "warn" && typeof e.fields?.reason === "string" && e.fields?.tenant === "alice"));
  const counts = log.events.filter((e) => e.event === "loops.warnings");
  assertEquals(counts.length, 3, "one count line per call");
  assertEquals(counts.map((e) => [e.fields?.unreadable, e.fields?.forks]), [[3, 0], [3, 0], [3, 0]]);
  const later = await write(`CLOSED/9 | key=${K(5)}`, { subject: `loop:${K(5)}` });
  await call();
  assertEquals(log.events.filter((e) => e.event === "loops.unreadable").map((e) => e.fields?.lineId).at(-1), later.id, "a new bad line is logged when it first appears");
  assertEquals(log.events.filter((e) => e.event === "loops.unreadable").length, 4);
});

Deno.test("/loops: a fork shows the newest head with fork: true, is logged once per line, and counted on every call; a clean call logs no warning", async () => {
  const { app, write, log } = rig();
  await write(rOpen(K(1)));
  await getJson(app, "/browse/api/loops?state=all");
  assertEquals(log.events.filter((e) => e.event === "loops.warnings").length, 0, "nothing to warn about, nothing logged");
  const open = await write(rOpen(K(2)));
  await write(rResolved(K(2)), { supersedes: open.id });
  const second = await write(rParked(K(2))); // no supersedes: a second live head
  for (let i = 0; i < 2; i++) {
    const { body } = await getJson(app, `/browse/api/loops?key=${K(2)}`);
    assertEquals([body.loops[0].state, body.loops[0].lineId, body.loops[0].fork], ["parked", second.id, true]);
  }
  assertEquals(log.events.filter((e) => e.event === "loops.fork" && e.fields?.subject === `loop:${K(2)}`).length, 1);
  assertEquals(log.events.filter((e) => e.event === "loops.warnings").map((e) => e.fields?.forks), [1, 1]);
});

Deno.test("/loops: a current line written without understanding is counted under warnings", async () => {
  const { app, write } = rig();
  await write(rOpen(K(1)), { tags: [] });
  const t2 = await write(rOpen(K(2)), { tags: [] });
  await write(rResolved(K(2)), { supersedes: t2.id });
  await write(rOpen(K(3)));
  assertEquals((await getJson(app, "/browse/api/loops?state=all")).body.warnings, { understandFailed: 1 }, "only the first loop's current line has no tags");
});

Deno.test("/loops: another tenant's loops are invisible, by list and by key; a bad state or since is a 400 with the reason; the gate still applies", async () => {
  const { app, ledger, write } = rig();
  await write(rOpen(K(1)));
  await write(rOpen(K(2)), { scope: { tenant: "bob", actor: "job" } });
  assertEquals(keysOf((await getJson(app, "/browse/api/loops?state=all")).body), [K(1)]);
  assertEquals((await getJson(app, `/browse/api/loops?key=${K(2)}`)).body.loops, []);
  for (const [q, word] of [["state=done", "state"], ["since=last%20week", "since"], ["since=2026-02-30", "since"]]) {
    const r = await getJson(app, `/browse/api/loops?${q}`);
    assertEquals(r.status, 400, q);
    assert(String(r.body.error).includes(word), q);
  }
  const keyed = buildApp({ memory: new KeywordMemory(), ledger, understander: new FixedUnderstander(understood), gate: new SharedKeyGate("s3cret", { tenant: "alice" }), log: new NullLog() }, OPTIONS);
  assertEquals((await getJson(keyed, "/browse/api/loops")).body.error?.code, -32001);
  assertEquals(keysOf((await getJson(keyed, "/browse/api/loops", { "x-brain-key": "s3cret" })).body), [K(1)]);
});

Deno.test("/loops: a loop's whole life through the ledger: open, resolve, reopen; the route follows the newest line each time", async () => {
  const { app, write } = rig();
  const o = await write(rOpen(K(1)));
  const r = await write(rResolved(K(1)), { supersedes: o.id });
  const now = async () => (await getJson(app, `/browse/api/loops?key=${K(1)}`)).body.loops[0] as LoopView;
  assertEquals([(await now()).state, (await now()).lineId], ["resolved", r.id]);
  const back = await write(rOpen(K(1), { reopened: ago(0) }), { supersedes: r.id });
  const reopened = await now();
  assertEquals([reopened.state, reopened.lineId, reopened.closed], ["open", back.id, null]);
});
