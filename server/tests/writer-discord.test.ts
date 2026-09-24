import { assert, assertEquals } from "@std/assert";
import { advance, describeReactions, type DiscordAuthor, type DiscordMessage, distil, emojiKey, newer, reactionsOf } from "../writer/discord.ts";

const base: DiscordMessage = {
  id: "1419000000000000002",
  channel_id: "1418000000000000001",
  guild_id: "1417000000000000000",
  type: 0,
  content: "Servest report hold stays until Kelli confirms",
  author: { id: "7", username: "corne", global_name: "Corné" },
  timestamp: "2026-09-21T08:30:00.000Z",
};
const names = { guild: "Xactco", channel: "reporting" };

Deno.test("distil: a plain message becomes a thought with where, when, who, deep link and coordinates", () => {
  const d = distil(base, names);
  assert(!("skip" in d));
  assertEquals(d.content, "Discord #reporting (Xactco), 2026-09-21, Corné: Servest report hold stays until Kelli confirms");
  assertEquals(d.source, "discord:1417000000000000000/1418000000000000001/1419000000000000002");
  assertEquals(d.proof, "https://discord.com/channels/1417000000000000000/1418000000000000001/1419000000000000002");
  assertEquals(d.actor, "discord:corne");
  assertEquals(d.occurredAt, "2026-09-21T08:30:00.000Z");
});

Deno.test("distil: skips bots, system messages, and empty messages; keeps attachment-only ones", () => {
  assertEquals(distil({ ...base, author: { ...base.author, bot: true } }, names), { skip: "bot author" });
  assertEquals(distil({ ...base, type: 7 }, names), { skip: "message type 7" });
  assertEquals(distil({ ...base, content: "   " }, names), { skip: "no text and no attachments" });
  const files = distil({ ...base, content: "", attachments: [{ filename: "q3.xlsx", url: "https://cdn.discordapp.com/x/q3.xlsx?ex=6ab1&is=6ab0&hm=4f4d" }] }, names);
  assert(!("skip" in files));
  assert(files.content.endsWith("Corné: [attachment: q3.xlsx https://cdn.discordapp.com/x/q3.xlsx]"));
});

Deno.test("distil: replies quote the parent, threads name their parent channel, DMs have no guild", () => {
  const reply = distil({ ...base, type: 19, referenced_message: { author: { id: "8", username: "luke" }, content: "should we\n\nhold it?" } }, names);
  assert(!("skip" in reply) && reply.content.includes("Corné: [replying to luke: should we hold it?] Servest"));
  const thread = distil(base, { guild: "Xactco", channel: "hold decision", parent: "reporting" });
  assert(!("skip" in thread) && thread.content.startsWith("Discord #reporting > hold decision (Xactco)"));
  const dm = distil({ ...base, guild_id: undefined }, { channel: "dm" });
  assert(!("skip" in dm));
  assertEquals(dm.proof, "https://discord.com/channels/@me/1418000000000000001/1419000000000000002");
});

Deno.test("distil: carries the channel by name, the thread when in one, and what a reply answers, so a conversation can be read back", () => {
  const plain = distil(base, names);
  assert(!("skip" in plain));
  assertEquals([plain.channel, plain.thread, plain.inReplyTo], ["reporting", undefined, undefined]);

  const inThread = distil(base, { guild: "Xactco", channel: "hold decision", parent: "reporting" });
  assert(!("skip" in inThread));
  assertEquals([inThread.channel, inThread.thread], ["reporting", "hold decision"], "a thread's line belongs to its parent channel");

  const reply = distil({ ...base, type: 19, message_reference: { message_id: "1419000000000000001", channel_id: "1418000000000000001", guild_id: "1417000000000000000" } }, names);
  assert(!("skip" in reply));
  assertEquals(reply.inReplyTo, "discord:1417000000000000000/1418000000000000001/1419000000000000001", "same coordinates as the parent's own source");

  const refNoIds = distil({ ...base, type: 19, message_reference: { message_id: "1419000000000000001" } }, names);
  assert(!("skip" in refNoIds));
  assertEquals(refNoIds.inReplyTo, "discord:1417000000000000000/1418000000000000001/1419000000000000001", "missing channel/guild on the reference fall back to the message's own");

  const crossPost = distil({ ...base, type: 0, message_reference: { message_id: "5", channel_id: "6", guild_id: "7" } }, names);
  assert(!("skip" in crossPost));
  assertEquals(crossPost.inReplyTo, undefined, "only a REPLY (type 19) answers something; a forward or crosspost reference is not an answer");

  const dm = distil({ ...base, guild_id: undefined, type: 19, message_reference: { message_id: "9" } }, { channel: "dm" });
  assert(!("skip" in dm));
  assertEquals(dm.inReplyTo, "discord:@me/1418000000000000001/9");
});

Deno.test("reactionsOf: who reacted with what, by display name; custom emoji readable; bots never count as people; none is empty", () => {
  const kelli = { id: "1", username: "kellireynolds", global_name: "Kelli" };
  const devon = { id: "2", username: "dman_devon", global_name: "Devon" };
  const dyno = { id: "3", username: "Dyno", bot: true };
  const users: Record<string, DiscordAuthor[]> = { "👍": [kelli, devon], "niceone:1034055625639997491": [devon, dyno] };
  const got = reactionsOf(
    [{ count: 2, emoji: { id: null, name: "👍" } }, { count: 2, emoji: { id: "1034055625639997491", name: "niceone" } }],
    (key) => users[key],
  );
  assertEquals(got, [
    { emoji: "👍", count: 2, by: ["Kelli", "Devon"] },
    { emoji: ":niceone:", count: 2, by: ["Devon"] },
  ]);
  assertEquals(reactionsOf(undefined, () => undefined), []);
  assertEquals(reactionsOf([], () => undefined), []);
  assertEquals(reactionsOf([{ count: 3, emoji: { id: null, name: "✅" } }], () => undefined), [{ emoji: "✅", count: 3, by: [] }], "who is unknown: the count still stands");
  assertEquals(emojiKey({ id: null, name: "👍" }), "👍");
  assertEquals(emojiKey({ id: "1034055625639997491", name: "niceone" }), "niceone:1034055625639997491", "the form Discord's reactions endpoint takes");
});

Deno.test("describeReactions: one line a person reads as who acknowledged the message", () => {
  assertEquals(describeReactions([{ emoji: "👍", count: 2, by: ["Kelli", "Devon"] }, { emoji: "✅", count: 1, by: [] }]), "👍 by Kelli, Devon; ✅ ×1");
  assertEquals(describeReactions([{ emoji: "👍", count: 3, by: ["Kelli"] }]), "👍 by Kelli and 2 more");
  assertEquals(describeReactions([]), "");
});

Deno.test("distil: a very long message is cut, whitespace collapsed, username used when no display name", () => {
  const long = distil({ ...base, content: "x".repeat(5000), author: { id: "7", username: "corne", global_name: null } }, names);
  assert(!("skip" in long));
  assert(long.content.length <= 4000 && long.content.endsWith("…"));
  assert(long.content.includes(", corne:"));
});

Deno.test("distil: user mentions resolve from the message's own list, channel mentions from the cache, unknown ids stay raw", () => {
  const d = distil({
    ...base,
    content: "<@1551511604439285821> see <#1418000000000000001> and <@!999> and <#777>",
    mentions: [{ id: "1551511604439285821", username: "filex-ingest", global_name: "FileX-Ingest" }],
  }, { ...names, channelNames: (id) => (id === "1418000000000000001" ? "reporting" : undefined) });
  assert(!("skip" in d));
  assert(d.content.endsWith("Corné: @FileX-Ingest see #reporting and <@!999> and <#777>"), d.content);
});

Deno.test("watermarks: snowflake order is numeric, older ids never move it back, unknown channel starts", () => {
  assert(newer("10", undefined));
  assert(newer("1419000000000000010", "1419000000000000009"));
  assert(!newer("999999999999999999", "1419000000000000009"));
  const w = advance({}, "c1", "1419000000000000005");
  assertEquals(advance(w, "c1", "1419000000000000004"), w);
  assertEquals(advance(w, "c1", "1419000000000000006").c1, "1419000000000000006");
  assertEquals(advance(w, "c2", "5").c1, "1419000000000000005");
});
