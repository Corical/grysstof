import { assert, assertEquals } from "@std/assert";
import { authorOf, clientCards, clientForChannel, conversations, exploreGraph, looseEnds, toMessages } from "../core/pulse.ts";
import type { Thought } from "../core/ports/mod.ts";

const CLIENTS = ["client:relativ-media", "client:retailcreative", "client:grainfield", "client:ecowize", "client:pandrol", "client:evergreen-turf", "client:empact-venetia", "client:empact-amandelbult", "client:express-kempton", "client:marlin", "client:xsit", "client:jag"];

Deno.test("clientForChannel: longest client whose letters start the channel's; internal channels are internal; an override fact wins", () => {
  const cases: [string, string | null][] = [
    ["marlin", "client:marlin"],
    ["relativ-media-pixel", "client:relativ-media"],
    ["retail_creative", "client:retailcreative"],
    ["grainfieldchicken", "client:grainfield"],
    ["ecowize_pest_hygiene", "client:ecowize"],
    ["ecowize_cleaning", "client:ecowize"],
    ["pandrolsa", "client:pandrol"],
    ["evergreen_turf", "client:evergreen-turf"],
    ["empact_venetia", "client:empact-venetia"],
    ["empact_amandelbult", "client:empact-amandelbult"],
    ["express_kempton", "client:express-kempton"],
    ["standup", null],
    ["queries", null],
    ["jm", null],
    ["j", null],
  ];
  for (const [channel, want] of cases) assertEquals(clientForChannel(channel, CLIENTS, {}).client, want, channel);
  assertEquals(clientForChannel("xsit", CLIENTS, {}).how, "auto");
  assertEquals(clientForChannel("jm", CLIENTS, { jm: "client:jag" }), { client: "client:jag", how: "set" }, "an override maps what the name cannot");
  assertEquals(clientForChannel("marlin", CLIENTS, { marlin: "internal" }), { client: null, how: "set" }, "and can mark a lookalike as internal");
  assertEquals(clientForChannel("", CLIENTS, {}).client, null);
});

Deno.test("authorOf reads who said a Discord line; anything else has no author", () => {
  assertEquals(authorOf("Discord #queries (Xactco), 2026-09-23, Devon: Yes, everything is showing now."), "Devon");
  assertEquals(authorOf("Discord #reporting > Q3 (draft) (Xactco), 2026-09-23, Luke Simon: [replying to Kelli: x: y] ok"), "Luke Simon");
  assertEquals(authorOf("Discord #dm, 2026-09-23, Corical: hi"), "Corical");
  assertEquals(authorOf("A note someone captured"), null);
});

const at = (i: number) => new Date(Date.parse("2026-09-22T09:00:00Z") + i * 60_000).toISOString();
function thought(i: number, channel: string, who: string, text: string, extra: Record<string, unknown> = {}, minute = i): Thought {
  return {
    id: `t${i}`,
    content: `Discord #${channel} (Xactco), 2026-09-22, ${who}: ${text}`,
    metadata: { source: `discord:g/${channel}/${i}`, channel, type: "observation", ...extra },
    createdAt: at(minute),
  };
}

Deno.test("conversations: a channel's messages split where the talk goes quiet; channels never mix; each keeps its opener, last word and people", () => {
  const msgs = toMessages([
    thought(1, "marlin", "Devon", "tags not scanning"),
    thought(2, "marlin", "Kelli", "is it working for you", {}, 5),
    thought(3, "queries", "Corical", "restore a subset", {}, 6),
    thought(4, "marlin", "Devon", "from my tests yes", {}, 20),
    thought(5, "marlin", "Charne", "new topic after lunch", {}, 20 + 180),
  ]);
  const convs = conversations(msgs, 120);
  const marlin = convs.filter((c) => c.channel === "marlin");
  assertEquals(marlin.map((c) => c.messages.map((m) => m.id)), [["t1", "t2", "t4"], ["t5"]], "a 3-hour silence starts a new conversation");
  assertEquals(marlin[0].people, ["Devon", "Kelli"]);
  assertEquals(marlin[0].opener.id, "t1");
  assertEquals(marlin[0].last.id, "t4");
  assertEquals(convs.find((c) => c.channel === "queries")!.messages.length, 1, "channels never mix");
  assertEquals(conversations([], 120), []);
});

Deno.test("looseEnds: an ask with no reply and no reaction is open; a reply link or any reaction closes it; answers are not asks; old ones fall outside the window", () => {
  const now = Date.parse("2026-09-24T09:00:00Z");
  const msgs = toMessages([
    thought(1, "xsit", "Charne", "can you check the 7 contracts?", { type: "task" }, -300),
    thought(2, "xsit", "Kelli", "please confirm the licence count", { type: "task", reactions: [{ emoji: "👍", count: 1, by: ["Luke"] }] }),
    thought(3, "xsit", "Charne", "who owns the Wilbur device issue?", { type: "observation" }),
    thought(4, "xsit", "Devon", "on it", { type: "task", in_reply_to: "discord:g/xsit/3" }),
    thought(5, "xsit", "Kelli", "Nice weekend all", { type: "observation" }),
    thought(6, "xsit", "Kelli", "please share the minutes", { type: "task" }, -60 * 24 * 40),
    thought(7, "xsit", "Kelli", "please confirm, a reaction with no names still counts", { type: "task", reactions: [{ emoji: "✅", count: 1, by: [] }] }),
  ]);
  const open = looseEnds(msgs, { now, days: 30 });
  assertEquals(open.map((m) => m.id), ["t1"], "t2 reacted, t3 replied to, t4 is itself a reply, t5 is not an ask, t6 too old, t7 reacted");
  assert(open[0].ageHours > 40);
});

Deno.test("looseEnds: an ask is a question, a mention or a request — not whatever the tagger called a task; statuses and answers are never asks", () => {
  const now = Date.parse("2026-09-24T09:00:00Z");
  const msgs = toMessages([
    thought(1, "servest", "Devon", "just sent you the reports", { type: "task" }),
    thought(2, "servest", "Devon", "will do I am also investigating a way to do this faster", { type: "task" }, 200),
    thought(3, "servest", "Kelli", "Hi @Devon just forwarded an email from Nikki can you please assist", { type: "task" }, 400),
    thought(4, "servest", "Saxon", "Tags expected to be delivered this week", { type: "observation" }, 600),
    thought(5, "servest", "Kelli", "Please change the workflow categories to Daily Inspections", { type: "observation" }, 800),
  ]);
  assertEquals(looseEnds(msgs, { now, days: 30 }).map((m) => m.id), ["t3", "t5"], "only the mention/request lines are asks");
  const notAsks = toMessages([
    thought(1, "servest", "Saxon", "@Kelli Done"),
    thought(2, "servest", "Saxon", "@Kelli schedules have been done", {}, 300),
    thought(3, "servest", "Saxon", "@Devon thanks for sorting out the geo fences", {}, 600),
    thought(4, "servest", "Saxon", "@Kelli No its now saying you have 2 weeks from the suggested day", {}, 900),
    thought(5, "zamani", "Charne", "Client Master File - Zamani https://xactco.sharepoint.com/:x:/s/File13/IQB?e=abc&web=1", {}, 1200),
  ]);
  assertEquals(looseEnds(notAsks, { now, days: 30 }).map((m) => m.id), [], "a mention says who, not that something is asked: done, thanks and answers are not asks; a ? inside a link is not a question");
});

Deno.test("looseEnds: picked up when the person asked speaks later in the same conversation; someone else speaking does not count when a person was named; a new conversation does not count", () => {
  const now = Date.parse("2026-09-24T09:00:00Z");
  const run = (lines: Parameters<typeof thought>[]) => looseEnds(toMessages(lines.map((l) => thought(...l))), { now, days: 30 }).map((m) => m.id);
  assertEquals(run([[1, "marlin", "Kelli", "@Devon can you check the tags?"], [2, "marlin", "Devon", "on my side they scan", {}, 5]]), [], "the named person answered in a plain message");
  assertEquals(run([[1, "marlin", "Kelli", "@Devon can you check the tags?"], [2, "marlin", "Charne", "following", {}, 5]]), ["t1"], "a bystander speaking is not Devon picking it up");
  assertEquals(run([[1, "marlin", "Kelli", "@Luke Simon please update the report"], [2, "marlin", "Luke Simon", "done", {}, 5]]), [], "a two-word name matches");
  assertEquals(run([[1, "marlin", "Kelli", "who is the user?"], [2, "marlin", "Devon", "Paulos", {}, 3]]), [], "nobody named: anyone else answering picks it up");
  assertEquals(run([[1, "marlin", "Kelli", "who is the user?"], [2, "marlin", "Kelli", "anyone?", {}, 3]]), ["t1", "t2"], "the asker talking again is not an answer");
  assertEquals(run([[1, "marlin", "Kelli", "@Devon can you check?"], [2, "marlin", "Devon", "next day, other topic", {}, 60 * 20]]), ["t1"], "Devon speaking in a later conversation does not close it");
});

Deno.test("looseEnds: the total is not capped by any list the caller trims", () => {
  const now = Date.parse("2026-09-24T09:00:00Z");
  const many = toMessages(Array.from({ length: 250 }, (_, i) => thought(i, `c${i}`, "Kelli", "can you check this?", {}, i * 3)));
  assertEquals(looseEnds(many, { now, days: 30 }).length, 250);
});

Deno.test("clientCards: one card per client with its channels merged, 7/30-day counts at their boundaries, a 30-day trend ending today, loose ends, and the most in need of attention first", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const t = (i: number, channel: string, who: string, text: string, when: string, extra: Record<string, unknown> = {}): Thought => ({
    id: `t${i}`, content: `Discord #${channel} (Xactco), 2026-09-01, ${who}: ${text}`, createdAt: when,
    metadata: { source: `discord:g/${channel}/${i}`, channel, type: "observation", ...extra },
  });
  const msgs = toMessages([
    t(1, "ecowize_pest_hygiene", "Trisha", "still working on it", day(1)),
    t(2, "ecowize_cleaning", "Kelli", "please check consumables?", day(3), { type: "task" }),
    t(3, "ecowize_pest_hygiene", "Charne", "old", day(40)),
    t(4, "marlin", "Devon", "everything is showing now", day(6.9)),
    t(5, "marlin", "Devon", "a week and a bit ago", day(7.1)),
    t(6, "standup", "Saxon", "internal", day(0.1)),
  ]);
  const cards = clientCards(msgs, ["client:ecowize", "client:marlin", "client:swanzo"], {}, { "client:ecowize": 63 }, now);
  const eco = cards.find((c) => c.client === "client:ecowize")!;
  assertEquals(eco.channels.sort(), ["ecowize_cleaning", "ecowize_pest_hygiene"]);
  assertEquals([eco.last7, eco.last30, eco.looseEnds, eco.facts], [2, 2, 1, 63]);
  assertEquals(eco.daily.length, 30);
  assertEquals(eco.daily.reduce((a, b) => a + b, 0), 2, "the trend holds the 30-day messages");
  assertEquals([eco.daily[28], eco.daily[29]], [1, 0], "buckets are half-open like the 7/30-day windows: exactly 24 hours old is the day before, not the last 24 hours");
  const marlin = cards.find((c) => c.client === "client:marlin")!;
  assertEquals([marlin.last7, marlin.last30], [1, 2], "6.9 days is inside the week, 7.1 is not");
  const swanzo = cards.find((c) => c.client === "client:swanzo")!;
  assertEquals([swanzo.last30, swanzo.lastAt], [0, null], "a client with no channel activity still has a card");
  assert(!cards.some((c) => c.channels.includes("standup")), "internal channels are not a client");
  assertEquals(cards[0].client, "client:ecowize", "open loose ends put a client first");
});

Deno.test("exploreGraph: each hit brings its conversation, people and client; replies and reactions are links; nothing links to a node that is not there; it stays readable", () => {
  const msgs = toMessages([
    thought(1, "marlin", "Devon", "tags not scanning"),
    thought(2, "marlin", "Kelli", "is it working for you", { in_reply_to: "discord:g/marlin/1" }, 2),
    thought(3, "marlin", "Devon", "from my tests yes", { in_reply_to: "discord:g/marlin/99", reactions: [{ emoji: "👍", count: 2, by: ["Kelli", "Charne"] }] }, 3),
    thought(4, "queries", "Corical", "unrelated", {}, 4),
  ]);
  const g = exploreGraph(["t2"], msgs, (ch) => (ch === "marlin" ? "client:marlin" : null), { gapMinutes: 120, maxMessages: 150 });
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const want of ["t1", "t2", "t3", "person:Devon", "person:Kelli", "person:Charne", "client:marlin"]) assert(ids.has(want), `missing ${want}`);
  assert(!ids.has("t4"), "another channel's conversation is not pulled in");
  for (const l of g.links) assert(ids.has(l.source) && ids.has(l.target), `dangling link ${l.source} -> ${l.target}`);
  assert(g.links.some((l) => l.kind === "reply" && l.source === "t2" && l.target === "t1"));
  assert(!g.links.some((l) => l.target === "discord:g/marlin/99"), "a reply to a message not in view draws no link");
  assert(g.links.some((l) => l.kind === "reacted" && l.source === "person:Charne" && l.target === "t3" && l.label === "👍"));
  assert(g.nodes.find((n) => n.id === "t2")!.hit, "the searched message is marked");
  assertEquals(g.nodes.find((n) => n.id === "t2")!.source, "discord:g/marlin/2", "a message bubble carries its source, so its thread can be opened");
  const many = toMessages(Array.from({ length: 400 }, (_, i) => thought(i, "marlin", `P${i % 7}`, `line ${i}`, {}, i)));
  const big = exploreGraph(["t200"], many, () => "client:marlin", { gapMinutes: 120, maxMessages: 60 });
  assert(big.nodes.filter((n) => n.kind === "message").length <= 60, "capped");
  assert(big.nodes.some((n) => n.id === "t200"), "the hit survives the cap");
  assertEquals(exploreGraph([], many, () => null, { gapMinutes: 120, maxMessages: 60 }), { nodes: [], links: [] });
});
