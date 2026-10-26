// Generates c1-sanitise.json (beside this file) from server/core/loops.ts, the C1 reference.
// Run from server/: deno run --allow-read --allow-write tests/fixtures/c1-sanitise.gen.ts
// Every refused and unreadable case is checked here before anything is written.
import { compose, KEY_RE, LIMITS, type LoopLine, parse, sanitiseLine } from "../../core/loops.ts";

const OUT = new URL("./c1-sanitise.json", import.meta.url);
type Tag = LoopLine["tag"];
type Wire = Record<string, string | string[] | null>;

const WIRE: Record<Tag, [string, string][]> = {
  OPEN: [["key", "key"], ["client", "client"], ["type", "type"], ["owner", "owner"], ["channel", "channel"], ["channel_id", "channelId"], ["opened", "opened"], ["reopened", "reopened"], ["title", "title"], ["summary", "summary"], ["evidence", "evidence"]],
  CLOSED: [["key", "key"], ["by_message", "byMessage"], ["closed", "closed"], ["reason", "reason"]],
  RESOLVED: [["key", "key"], ["by_user", "byUser"], ["by_name", "byName"], ["resolved", "resolved"], ["note", "note"]],
  PARKED: [["key", "key"], ["by_user", "byUser"], ["by_name", "byName"], ["until", "until"], ["note", "note"]],
};
const fromWire = (tag: Tag, w: Wire): LoopLine => Object.fromEntries([["tag", tag], ...WIRE[tag].map(([wire, ts]) => [ts, w[wire]])]) as unknown as LoopLine;
const toWire = (l: LoopLine): Wire => Object.fromEntries(WIRE[l.tag].map(([wire, ts]) => [wire, (l as unknown as Record<string, Wire[string]>)[ts]]));

const K = "1559838169497604096";
const BASE: Record<Tag, Wire> = {
  OPEN: {
    key: K, client: "servest", type: "unanswered_question", owner: "Kelli", channel: "servest", channel_id: "1300000000000000101",
    opened: "2026-10-14T08:00:00.000Z", reopened: null, title: "Site list export for Servest", summary: "The client asked for the site list export twice.",
    evidence: ["1559838169497604096", "1559900000000000001"],
  },
  CLOSED: { key: K, by_message: "1563100000000000007", closed: "2026-10-16T09:12:00.000Z", reason: "answered in channel" },
  RESOLVED: { key: K, by_user: "990867950443589672", by_name: "kellireynolds", resolved: "2026-10-17T10:00:00.000Z", note: "sent by email" },
  PARKED: { key: K, by_user: "990867950443589672", by_name: "kellireynolds", until: "2026-11-02", note: "after the audit" },
};
const KIND: Record<string, "key" | "id" | "date" | "type" | "text" | "list"> = {
  key: "key", client: "id", type: "type", owner: "text", channel: "text", channel_id: "id", opened: "date", reopened: "date", title: "text",
  summary: "text", evidence: "list", by_message: "id", closed: "date", reason: "text", by_user: "id", by_name: "text", resolved: "date", until: "date", note: "text",
};

// One hazard, put into a value so that, once cleaned, it is still valid for its kind.
const HAZARDS: Record<string, { text: string; id: string }> = {
  bidi: { text: "\u202e reversed \u2066isolate\u2069 \u200fmark", id: "\u202e" },
  pipe: { text: " | key=forged | type=stale_followup | ", id: "|" },
  newline: { text: "line one\nline two\r\nline three\u2028four\u2029five", id: "\n" },
  control: { text: "bell\u0007nul\u0000esc\u001b[31mred\u007fdel\ttab", id: "\u0007" },
};
function withHazard(field: string, value: Wire[string], h: { text: string; id: string }): Wire[string] {
  const kind = KIND[field];
  if (value === null) return `${h.id}2026-10-15T07:30:00.000Z`; // reopened
  if (kind === "list") return (value as string[]).map((v) => `${v.slice(0, 9)}${h.id}${v.slice(9)}`);
  if (kind === "text") return `${h.text}${value}${h.text}`;
  const v = value as string;
  return kind === "type" ? `${v}${h.id}` : `${h.id}${v.slice(0, 7)}${h.id}${v.slice(7)}`;
}

const lines: { name: string; tag: Tag; input: Wire; expected?: Wire; line?: string }[] = [];
const refused: { name: string; tag: Tag; input: Wire; because: string }[] = [];
const unreadable: { name: string; claim: string }[] = [];

for (const tag of Object.keys(BASE) as Tag[]) {
  lines.push({ name: `${tag}: plain`, tag, input: BASE[tag] });
  for (const [hname, h] of Object.entries(HAZARDS)) {
    lines.push({ name: `${tag}: ${hname} in every field`, tag, input: Object.fromEntries(Object.entries(BASE[tag]).map(([f, v]) => [f, withHazard(f, v, h)])) });
  }
  // Over-long values: text and ids are cut and still readable; keys, types and times would no longer be valid, so they are refused.
  const long: Wire = { ...BASE[tag] };
  for (const [f, v] of Object.entries(BASE[tag])) {
    const kind = KIND[f];
    if (kind === "text") long[f] = (f === "title" ? "😀".repeat(130) : f === "summary" ? "y".repeat(299) + "😀😀" : "n".repeat(400)) as string;
    if (kind === "id") long[f] = "7".repeat(150);
    if (kind === "list") long[f] = (v as string[]).map((id) => id + "0".repeat(120));
  }
  lines.push({ name: `${tag}: over-long text and ids are cut by character`, tag, input: long });
  for (const [f] of WIRE[tag]) {
    const kind = KIND[f];
    if (kind === "key") refused.push({ name: `${tag}: over-long key`, tag, input: { ...BASE[tag], key: K + "1".repeat(110) }, because: "key" });
    if (kind === "type") refused.push({ name: `${tag}: over-long type`, tag, input: { ...BASE[tag], type: "unanswered_question".repeat(8) }, because: "type" });
    if (kind === "date") refused.push({ name: `${tag}: over-long ${f}`, tag, input: { ...BASE[tag], [f]: `${f === "until" ? "2026-11-02" : "2026-10-15T07:30:00.000Z"}${"0".repeat(110)}` }, because: f });
  }
  refused.push({ name: `${tag}: key outside the grammar`, tag, input: { ...BASE[tag], key: "not-a-snowflake" }, because: "key" });
  refused.push({ name: `${tag}: key with a fourth part`, tag, input: { ...BASE[tag], key: `${K}:b:2:zz` }, because: "key" });
  refused.push({ name: `${tag}: blank key`, tag, input: { ...BASE[tag], key: " | " }, because: "key" });
}

lines.push({
  name: "OPEN: 12 evidence ids with a repeat, a blank and dirty copies; a client with spaces and commas",
  tag: "OPEN",
  input: {
    ...BASE.OPEN, client: "servest billing, x",
    evidence: ["1559800000000000001", "1559800000000000002", "1559800000000000002", " 1559800000000000003 ", "15598000000,00000004", "", "1559800000000000005", "1559800000000000006", "1559800000000000007", "1559800000000000008", "1559800000000000009", "1559800000000000010"],
  },
});
lines.push({ name: "OPEN: whitespace that is not ASCII (no-break space, byte-order mark, ideographic space) collapses", tag: "OPEN", input: { ...BASE.OPEN, title: "a\u00a0\u00a0b\ufeffc\u3000d", owner: "\ufeffKelli\u00a0", client: "ser\u00a0vest\ufeff" } });
lines.push({ name: "OPEN: lone surrogate halves are dropped; whole emoji, joiner sequences and flags are kept", tag: "OPEN", input: { ...BASE.OPEN, title: "lone \ud83d half \ude00 then 👩‍👩‍👧 and 🇿🇦", owner: "\ud83dKelli" } });
lines.push({ name: "OPEN: markdown, mentions, = and # are text, kept as written", tag: "OPEN", input: { ...BASE.OPEN, title: "**bold** _it_ `code` [l](https://x.test) <@123> @everyone #servest a=b=c", summary: "=" } });
lines.push({ name: "OPEN: reopened written as a dash, and a time with an offset", tag: "OPEN", input: { ...BASE.OPEN, reopened: "-", opened: "2026-10-14T10:00:00+02:00" } });
lines.push({ name: "OPEN: reopened set; a key with a letter and a generation at the grammar's maximum", tag: "OPEN", input: { ...BASE.OPEN, key: `${"9".repeat(20)}:z:999`, reopened: "2026-10-20T09:00:00.000Z" } });
lines.push({ name: "OPEN: blank text fields stay blank", tag: "OPEN", input: { ...BASE.OPEN, owner: "   ", title: "|||", summary: "\n\t" } });
lines.push({ name: "PARKED: until is a date alone", tag: "PARKED", input: { ...BASE.PARKED, until: "2028-02-29" } });

refused.push({ name: "OPEN: an unknown type", tag: "OPEN", input: { ...BASE.OPEN, type: "gossip" }, because: "type" });
refused.push({ name: "OPEN: opened on a day that does not exist", tag: "OPEN", input: { ...BASE.OPEN, opened: "2026-02-30T08:00:00Z" }, because: "opened" });
refused.push({ name: "OPEN: opened is just a number", tag: "OPEN", input: { ...BASE.OPEN, opened: "12" }, because: "opened" });
refused.push({ name: "OPEN: reopened is a word", tag: "OPEN", input: { ...BASE.OPEN, reopened: "later" }, because: "reopened" });
refused.push({ name: "CLOSED: blank by_message", tag: "CLOSED", input: { ...BASE.CLOSED, by_message: " \n " }, because: "by_message" });
refused.push({ name: "RESOLVED: blank by_user", tag: "RESOLVED", input: { ...BASE.RESOLVED, by_user: "|" }, because: "by_user" });
refused.push({ name: "PARKED: until on a day that does not exist", tag: "PARKED", input: { ...BASE.PARKED, until: "2026-02-30" }, because: "until" });
refused.push({ name: "PARKED: until is a phrase", tag: "PARKED", input: { ...BASE.PARKED, until: "after the audit" }, because: "until" });

const good = compose(fromWire("OPEN", BASE.OPEN));
const goodClosed = compose(fromWire("CLOSED", BASE.CLOSED));
const goodParked = compose(fromWire("PARKED", BASE.PARKED));
unreadable.push(
  { name: "an unknown tag", claim: goodClosed.replace("CLOSED/1", "DONE/1") },
  { name: "an unknown version", claim: good.replace("OPEN/1", "OPEN/2") },
  { name: "a tag in lower case", claim: good.replace("OPEN/1", "open/1") },
  { name: "a tag with no version", claim: good.replace("OPEN/1", "OPEN") },
  { name: "a missing field", claim: good.replace(/ \| evidence=[^|]*$/, "") },
  { name: "an extra field", claim: `${good} | colour=red` },
  { name: "a field given twice", claim: `${good} | key=${K}` },
  { name: "a field with no name", claim: `${good} | =x` },
  { name: "a key outside the grammar", claim: good.replace(`key=${K}`, "key=123:b:2:zz") },
  { name: "an unknown type", claim: good.replace("type=unanswered_question", "type=gossip") },
  { name: "opened in month 13", claim: good.replace("opened=2026-10-14T08:00:00.000Z", "opened=2026-13-01") },
  { name: "until on 30 February", claim: goodParked.replace("until=2026-11-02", "until=2026-02-30") },
  { name: "two lines in one claim", claim: `${good}\n${good}` },
  { name: "nothing", claim: "" },
  { name: "a sentence", claim: "Kelli asked about the schedules" },
);

// Check everything before writing.
for (const c of lines) {
  const x = fromWire(c.tag, c.input);
  c.expected = toWire(sanitiseLine(x));
  c.line = compose(x);
  const back = parse(c.line);
  if (!back.ok || JSON.stringify(toWire(back.line)) !== JSON.stringify(c.expected)) throw new Error(`round trip failed: ${c.name}`);
}
for (const c of refused) {
  let threw = "";
  try { compose(fromWire(c.tag, c.input)); } catch (e) { threw = (e as Error).message; }
  if (!threw.includes(c.because)) throw new Error(`${c.name}: expected a refusal mentioning "${c.because}", got "${threw}"`);
}
for (const c of unreadable) if (parse(c.claim).ok) throw new Error(`${c.name} parsed`);

const fixture = {
  about: [
    "C1 sanitising, one truth in two languages (plan 5, v3.1 addendum, row 18). Generated by tests/fixtures/c1-sanitise.gen.ts from server/core/loops.ts, the reference;",
    "server/tests/loops.test.ts and server/jobs/test_open_loops.py both run every case. Field names are the line's own (snake_case).",
    "lines: input fields -> expected fields after sanitising -> the composed line; parsing the line gives the expected fields back.",
    "refused: compose must refuse the input with an error mentioning `because`. unreadable: parse must not read the claim.",
  ],
  rules: {
    text: "sanitise(text, cap): delete every '|'; replace each unsafe character with a space; collapse every run of whitespace to one space; trim; keep the first `cap` code points; trim again.",
    id: "clean_id: delete every unsafe character, every '|', every ',' and all whitespace; keep the first 100 code points. Used for key, client, type, channel_id, opened, reopened, by_message, closed, by_user, resolved, until and each evidence id.",
    unsafe: "general category Cc (control) and Cs (lone surrogate halves), U+2028, U+2029, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069",
    whitespace: "JavaScript's \\s: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF (note U+FEFF, which Python's str.isspace does not count)",
    caps: { title: LIMITS.title, summary: LIMITS.summary, note: LIMITS.note, reason: LIMITS.reason, owner: LIMITS.name, channel: LIMITS.name, by_name: LIMITS.name, ids: LIMITS.id },
    evidence: `clean each id, drop blanks, drop repeats keeping the first sighting, keep the last ${LIMITS.evidence} in the order given; written comma-separated`,
    reopened: "null when blank or '-' after cleaning; written as '-'",
    key: `must match ${KEY_RE.source}`,
    times: "ISO 8601 beginning YYYY-MM-DD, a calendar date that exists (2026-02-30 is refused), and a time JavaScript's Date.parse reads",
    line: "TAG/1 then name=value pairs in the order of `lines` below, joined by ' | '",
  },
  lines,
  refused,
  unreadable,
};

const ascii = JSON.stringify(fixture, null, 2).replace(/[^\x20-\x7e\n]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
JSON.parse(ascii);
Deno.writeTextFileSync(OUT, ascii + "\n");
console.log(`wrote ${OUT}: ${lines.length} lines, ${refused.length} refused, ${unreadable.length} unreadable, ${ascii.length} bytes`);
