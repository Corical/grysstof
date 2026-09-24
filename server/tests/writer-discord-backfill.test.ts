import { assertEquals } from "@std/assert";
import { backfillPatch, whereFrom } from "../writer/discord-backfill.ts";
import { distil } from "../writer/discord.ts";

const message = {
  id: "1419000000000000002",
  channel_id: "1418000000000000001",
  guild_id: "1417000000000000000",
  type: 0,
  content: "Everything is showing now",
  author: { id: "7", username: "dman_devon", global_name: "Devon" },
  timestamp: "2026-09-23T12:11:08.322Z",
};

Deno.test("whereFrom reads back exactly what distil wrote, for a channel, a thread, a DM and a missing guild name", () => {
  const cases = [
    { names: { guild: "Xactco", channel: "queries" }, want: { channel: "queries" } },
    { names: { guild: "Xactco", channel: "marlin schedules", parent: "queries" }, want: { channel: "queries", thread: "marlin schedules" } },
    { names: { channel: "dm" }, want: { channel: "dm" } },
    { names: { guild: "Xactco", channel: "retail_creative" }, want: { channel: "retail_creative" } },
  ];
  for (const { names, want } of cases) {
    const d = distil(message, names);
    if ("skip" in d) throw new Error("unexpected skip");
    assertEquals(whereFrom(d.content), want, d.content);
    assertEquals({ channel: d.channel, ...(d.thread ? { thread: d.thread } : {}) }, want, "the live writer and the backfill agree");
  }
});

Deno.test("whereFrom survives awkward thread names and refuses anything that is not a Discord line", () => {
  const awkward = distil(message, { guild: "Xactco", channel: "Q3 (draft) > review, v2", parent: "reporting" });
  if ("skip" in awkward) throw new Error("unexpected skip");
  assertEquals(whereFrom(awkward.content), { channel: "reporting", thread: "Q3 (draft) > review, v2" });
  const withReply = distil({ ...message, type: 19, referenced_message: { author: { id: "1", username: "corical" }, content: "Can we find out, 2026-09-23, if Paulos sees it (Sept 2026)?" } }, { guild: "Xactco", channel: "queries" });
  if ("skip" in withReply) throw new Error("unexpected skip");
  assertEquals(whereFrom(withReply.content), { channel: "queries" }, "a quoted date inside the reply does not confuse the parse");
  for (const not of ["Session note: Discord #queries was busy", "discord #queries (Xactco), 2026-09-23, x: y", "Discord #, 2026-09-23, x: y", "Discord #queries (Xactco) 2026-09-23 x: y", ""]) {
    assertEquals(whereFrom(not), null, JSON.stringify(not));
  }
});

Deno.test("backfillPatch: only Discord thoughts, only missing keys, and a reply is flagged for lookup exactly when it quotes a parent and has no link yet", () => {
  const src = "discord:1417000000000000000/1418000000000000001/1419000000000000002";
  const line = "Discord #queries (Xactco), 2026-09-23, Devon: Yes, everything is showing now.";
  const reply = "Discord #queries (Xactco), 2026-09-23, Corical: [replying to Devon: it s showing for him] This is on 20260904.1";
  assertEquals(backfillPatch({ content: line, metadata: { source: src } }), { set: { channel: "queries" }, lookupReply: false });
  assertEquals(backfillPatch({ content: reply, metadata: { source: src } }), { set: { channel: "queries" }, lookupReply: true });
  assertEquals(backfillPatch({ content: line, metadata: { source: src, channel: "queries" } }), null, "already has its channel: nothing to do");
  assertEquals(backfillPatch({ content: reply, metadata: { source: src, channel: "queries" } }), { set: {}, lookupReply: true }, "channel present, link still missing");
  assertEquals(backfillPatch({ content: reply, metadata: { source: src, channel: "queries", in_reply_to: "discord:1/2/3" } }), null);
  assertEquals(backfillPatch({ content: line, metadata: { source: "claude-code:session_1" } }), null, "not from Discord");
  assertEquals(backfillPatch({ content: "Freeform note", metadata: { source: src } }), null, "a Discord source whose text is not a Discord line is left alone");
  assertEquals(backfillPatch({ content: line, metadata: {} }), null, "no source at all");
});
