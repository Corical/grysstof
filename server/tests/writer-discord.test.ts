import { assert, assertEquals } from "@std/assert";
import { advance, type Capture, describeReactions, type DiscordAuthor, type DiscordMessage, distil, emojiKey, newer, reactionsOf, type Watermarks } from "../writer/discord.ts";
import { backoffMs, type BotIo, createBot, GUILD_WAIT_MS, HOLD_MAX_MS, RETRY_BASE_MS, RETRY_MAX_MS } from "../writer/discord-dispatch.ts";
import { type PaConfig, paConfig, type PaIo, parseIdList } from "../writer/discord-pa.ts";
import { HttpError } from "../writer/discord-rest.ts";

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

Deno.test("distil: carries the author's id, the channel's id and, in a thread, the parent channel's id, so a closing reply can be matched by id rather than by name", () => {
  const plain = distil(base, names);
  assert(!("skip" in plain));
  assertEquals([plain.authorId, plain.channelId, plain.parentId], ["7", "1418000000000000001", undefined]);
  assertEquals("parentId" in plain, false, "a channel that is not a thread sends no parent at all, not an empty one");

  const threadMsg = { ...base, channel_id: "1420000000000000009" };
  const inThread = distil(threadMsg, { guild: "Xactco", channel: "hold decision", parent: "reporting", parentId: "1418000000000000001" });
  assert(!("skip" in inThread));
  assertEquals([inThread.channelId, inThread.parentId, inThread.channel, inThread.thread], ["1420000000000000009", "1418000000000000001", "reporting", "hold decision"]);

  const nameless = distil(threadMsg, { channel: "hold decision", parentId: "1418000000000000001" });
  assert(!("skip" in nameless));
  assertEquals(nameless.parentId, "1418000000000000001", "the parent's name may be unknown; its id still travels");

  const renamed = distil({ ...base, author: { ...base.author, global_name: "Someone Else", username: "corne_new" } }, names);
  assert(!("skip" in renamed));
  assertEquals(renamed.authorId, "7", "a changed display name or username never changes who said it");

  const reply = distil({ ...base, type: 19, author: { id: "8", username: "luke" }, referenced_message: { author: { id: "7", username: "corne" }, content: "can we close this?" } }, names);
  assert(!("skip" in reply));
  assertEquals(reply.authorId, "8", "the replier, never the person replied to");

  const dm = distil({ ...base, guild_id: undefined }, { channel: "dm" });
  assert(!("skip" in dm));
  assertEquals([dm.authorId, dm.channelId], ["7", "1418000000000000001"]);
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

// ---------- the gateway glue (writer/discord-dispatch.ts), driven by a fake gateway ----------

const G1 = "268128051500417024";
const G2 = "777000000000000007";
const C1 = "1418000000000000001";
const C2 = "1418000000000000002";
const C3 = "1418000000000000003";
const M = (n: number) => String(1500000000000000000n + BigInt(n));
const T0 = Date.parse("2026-10-26T20:00:00.000Z");
const APP = "1551511604439285821";
const KELLI = { id: "555000000000000001", username: "kellireynolds" };

/** Let every pending promise and zero-delay task run. */
const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Timers the test moves by hand, so a 30-second wait or an hour's backoff takes no real time. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h: unknown) => void due.delete(h as number),
    pending: () => due.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}

const said = (id: string, channel: string, guild?: string): DiscordMessage => ({
  id,
  channel_id: channel,
  ...(guild ? { guild_id: guild } : {}),
  type: 0,
  content: `message ${id}`,
  author: { id: "7", username: "corne" },
  timestamp: "2026-10-26T08:00:00.000Z",
});

/**
 * A fake Discord per channel. `pageFails`: the first n page fetches fail with 502. `pageStatus(n)`:
 * the status the nth page fetch fails with, or undefined to answer. `lookupFails`/`lookupStatus`: the
 * same for /channels/<id>. `plainErrors`: failures are thrown as the old entry `rest` threw them
 * (an Error whose text ends "-> 403"), not as an HttpError.
 */
type World = Record<string, {
  guild: string;
  messages: DiscordMessage[];
  lookupFails?: number;
  lookupStatus?: number;
  pageFails?: number;
  pageStatus?: (n: number) => number | undefined;
  plainErrors?: boolean;
}>;

const boom = () => {
  throw new Error("boom");
};
const explodingPa: PaIo = { discord: boom, loops: boom, capture: boom, history: boom, supersede: boom, log: boom, now: boom };

function botHarness(opts: { allow?: string; marks?: Watermarks; world: World; pa?: { cfg: PaConfig; io: PaIo }; postFails?: (c: Capture) => boolean; saveFails?: () => boolean }) {
  const timers = fakeTimers();
  const restCalls: string[] = [];
  const posted: Capture[] = [];
  const reactionPosts: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const lookups: Record<string, number> = {};
  const pagesAsked: Record<string, number> = {};
  const fail = (ch: string, status: number, path: string): never => {
    throw opts.world[ch]?.plainErrors ? new Error(`discord ${path} -> ${status}`) : new HttpError(status, "", `discord ${path}`);
  };
  const rest = async <T>(path: string): Promise<T> => {
    restCalls.push(path);
    let m = /^\/channels\/(\d+)\/messages\?after=(\d+)&limit=100$/.exec(path);
    if (m) {
      const n = pagesAsked[m[1]] = (pagesAsked[m[1]] ?? 0) + 1;
      if (n <= (opts.world[m[1]]?.pageFails ?? 0)) fail(m[1], 502, path);
      const status = opts.world[m[1]]?.pageStatus?.(n);
      if (status !== undefined) fail(m[1], status, path);
      return (opts.world[m[1]]?.messages ?? []).filter((x) => BigInt(x.id) > BigInt(m![2])).slice(0, 100).reverse() as T; // newest first, as Discord pages
    }
    if (/^\/channels\/\d+\/messages\?limit=100/.test(path)) return [] as T;
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (m) return { id: m[2], reactions: [{ count: 1, emoji: { id: null, name: "👍" } }] } as T;
    m = /^\/channels\/(\d+)\/messages\/\d+\/reactions\//.exec(path);
    if (m) return [] as T;
    m = /^\/channels\/(\d+)$/.exec(path);
    if (m) {
      const ch = opts.world[m[1]];
      lookups[m[1]] = (lookups[m[1]] ?? 0) + 1;
      if (!ch || lookups[m[1]] <= (ch.lookupFails ?? 0)) fail(m[1], ch?.lookupStatus ?? 503, path);
      return { id: m[1], name: `c${m[1].slice(-1)}`, type: 0, guild_id: ch.guild } as T;
    }
    throw new Error(`unexpected ${path}`);
  };
  const io: BotIo = {
    rest,
    post: async (c) => {
      if (opts.postFails?.(c)) throw new Error("brain answered 500");
      posted.push(c);
      return "Captured as thought";
    },
    postReactions: async (source) => {
      reactionPosts.push(source);
      return "Recorded";
    },
    saveMarks: async () => {
      if (opts.saveFails?.()) throw new Error("disk full");
    },
    log: (f) => void logs.push(f),
    timers,
    now: () => T0,
  };
  const bot = createBot(io, { captureGuilds: parseIdList(opts.allow), pa: opts.pa?.cfg ?? paConfig(undefined, undefined), paIo: opts.pa?.io ?? explodingPa }, { ...(opts.marks ?? {}) });
  return {
    bot,
    timers,
    restCalls,
    posted,
    reactionPosts,
    logs,
    lookups: () => restCalls.filter((p) => /^\/channels\/\d+$/.test(p)),
    pages: () => restCalls.filter((p) => p.includes("messages?after=")),
    pagesAsked: (ch: string) => pagesAsked[ch] ?? 0,
    ids: (ch: string) => posted.filter((p) => p.channelId === ch).map((p) => p.source.split("/").pop()),
    events: (name: string) => logs.filter((l) => l.event === name),
  };
}
const guildCreate = (id: string, channels: string[]) => ({ id, name: `guild ${id.slice(-2)}`, channels: channels.map((c) => ({ id: c, name: `c${c.slice(-1)}`, type: 0 })), threads: [] });

Deno.test("dispatch: with DISCORD_CAPTURE_GUILDS set, backfill waits until every guild READY names has sent GUILD_CREATE, then needs no channel lookups and leaves other guilds alone", async () => {
  const world: World = { [C1]: { guild: G1, messages: [said(M(101), C1), said(M(102), C1)] }, [C2]: { guild: G2, messages: [said(M(101), C2)] } };
  const h = botHarness({ allow: G1, marks: { [C1]: M(100), [C2]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [{ id: G1, unavailable: true }, { id: G2, unavailable: true }], application: { id: APP } });
  await flush();
  assertEquals(h.restCalls, [], "nothing fetched while the guild list is still arriving");
  await h.bot.dispatch("GUILD_CREATE", guildCreate(G1, [C1]));
  await flush();
  assertEquals(h.pages(), [], "one guild of two is not the list");
  await h.bot.dispatch("GUILD_CREATE", guildCreate(G2, [C2]));
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(101), M(102)]);
  assertEquals(h.ids(C2), []);
  assertEquals(h.lookups(), [], "the cache was full: no per-channel lookups");
  assertEquals(h.bot.marks(), { [C1]: M(102), [C2]: M(100) });
  assertEquals(h.events("capture.guild_skipped").map((l) => l.guild), [G2]);
  assertEquals(h.timers.pending(), 0, "the 30-second wait was cancelled, not left to fire");
});

Deno.test("dispatch: a guild that never sends GUILD_CREATE starts the backfill at 30 s; a channel whose guild still cannot be found is held, not skipped, and a live message there backfills the gap instead of jumping the watermark", async () => {
  const world: World = { [C1]: { guild: G1, messages: [said(M(101), C1)] }, [C3]: { guild: G1, lookupFails: 99, messages: [said(M(101), C3)] } };
  const h = botHarness({ allow: G1, marks: { [C1]: M(100), [C3]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [{ id: G1 }, { id: G2 }] });
  await h.bot.dispatch("GUILD_CREATE", guildCreate(G1, [C1])); // C3 is an archived thread: not in the guild's list
  await h.timers.advance(GUILD_WAIT_MS - 1);
  assertEquals(h.pages(), []);
  await h.timers.advance(1);
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(101)]);
  assertEquals(h.ids(C3), [], "said while the bot was down, not captured yet");
  assertEquals(h.bot.marks()[C3], M(100), "the watermark has not moved past it");
  assertEquals(h.bot.deferred(), [C3]);
  assertEquals(h.events("backfill.guild_wait_timeout").map((l) => l.missing), [[G2]]);
  assertEquals(h.events("backfill.guild_unknown").map((l) => l.channel), [C3]);
  assertEquals(h.events("capture.guild_skipped"), [], "held, not skipped");

  world[C3].messages.push(said(M(103), C3));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(103), C3, G1));
  await h.bot.settled();
  assertEquals(h.ids(C3), [M(101), M(103)], "the gap first, then the live message, each once");
  assertEquals(h.bot.marks()[C3], M(103));
  assertEquals(h.bot.deferred(), []);
});

Deno.test("dispatch: a held channel is retried on a timer with backoff until its guild is found; one that turns out to be another guild's is dropped, logged once", async () => {
  const world: World = { [C3]: { guild: G1, lookupFails: 2, messages: [said(M(101), C3)] }, [C2]: { guild: G2, lookupFails: 1, messages: [said(M(101), C2)] } };
  const h = botHarness({ allow: G1, marks: { [C2]: M(100), [C3]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  assertEquals(h.bot.deferred().sort(), [C2, C3]);
  assertEquals([backoffMs(0), backoffMs(1), backoffMs(2), backoffMs(30)], [RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS, RETRY_MAX_MS]);
  await h.timers.advance(RETRY_BASE_MS);
  await h.bot.settled();
  assertEquals(h.bot.deferred(), [C3], "C2 resolved to another guild and was let go");
  assertEquals(h.events("capture.guild_skipped").map((l) => l.guild), [G2]);
  assertEquals(h.ids(C3), []);
  await h.timers.advance(2 * RETRY_BASE_MS);
  await h.bot.settled();
  assertEquals(h.ids(C3), [M(101)]);
  assertEquals(h.ids(C2), []);
  assertEquals(h.bot.deferred(), []);
  assertEquals(h.timers.pending(), 0);
});

Deno.test("dispatch: a backfill page that fails holds its channel, list or no list, so the next live message backfills the gap instead of jumping the watermark", async () => {
  const world: World = { [C1]: { guild: G1, pageFails: 1, messages: [said(M(101), C1), said(M(102), C1)] } };
  const h = botHarness({ marks: { [C1]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  assertEquals(h.ids(C1), []);
  assertEquals(h.bot.deferred(), [C1]);
  assertEquals(h.events("backfill.failed").length, 1);
  world[C1].messages.push(said(M(103), C1));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(103), C1, G1));
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(101), M(102), M(103)]);
  assertEquals(h.bot.marks()[C1], M(103));
  assertEquals(h.timers.pending(), 0, "the retry timer was cancelled once the live message released the channel");
});

Deno.test("dispatch: a channel the bot may not read (403) or that is gone (404) is logged once as backfill.forbidden and never retried this run, its watermark untouched", async () => {
  const world: World = {
    [C1]: { guild: G1, pageStatus: () => 403, messages: [said(M(101), C1)] },
    [C2]: { guild: G1, pageStatus: () => 404, plainErrors: true, messages: [said(M(101), C2)] }, // the text form the old entry rest threw
    [C3]: { guild: G1, messages: [said(M(101), C3)] },
  };
  const h = botHarness({ marks: { [C1]: M(100), [C2]: M(100), [C3]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  assertEquals(h.events("backfill.forbidden").map((l) => [l.channel, l.status]), [[C1, 403], [C2, 404]]);
  assertEquals(h.events("backfill.failed"), []);
  assertEquals(h.bot.deferred(), []);
  assertEquals(h.timers.pending(), 0, "no retry scheduled");
  assertEquals(h.ids(C3), [M(101)], "a readable channel is not held up by them");
  await h.timers.advance(24 * 3_600_000);
  await h.bot.dispatch("READY", { guilds: [] }); // a reconnect within the same run
  await h.bot.settled();
  assertEquals([h.pagesAsked(C1), h.pagesAsked(C2)], [1, 1], "asked once, never again this run");
  assertEquals(h.events("backfill.forbidden").length, 2, "logged once each");
  assertEquals(h.bot.marks(), { [C1]: M(100), [C2]: M(100), [C3]: M(101) });
  assert(!h.restCalls.some((p) => p.startsWith(`/channels/${C1}/messages?limit`) || p.startsWith(`/channels/${C2}/messages?limit`)), "reaction catch-up leaves them alone too");
  await h.bot.dispatch("MESSAGE_CREATE", said(M(150), C1, G1));
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(150)], "a live message there is captured as it comes, as before round 2");
  assertEquals(h.pagesAsked(C1), 1);
});

Deno.test("dispatch: a transient failure (503) is retried with delays doubling from 30 s to a cap of 10 minutes, the attempt number rising each time", async () => {
  const world: World = { [C1]: { guild: G1, pageStatus: () => 503, messages: [said(M(101), C1)] } };
  const h = botHarness({ marks: { [C1]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  await h.timers.advance(RETRY_BASE_MS - 1);
  assertEquals(h.pagesAsked(C1), 1, "no retry before its time");
  for (const wait of [1, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    await h.timers.advance(wait);
    await h.bot.settled();
  }
  assertEquals(h.events("backfill.failed").map((l) => [l.attempt, l.retryInMs, l.status]), [
    [1, 30_000, 503],
    [2, 60_000, 503],
    [3, 120_000, 503],
    [4, 240_000, 503],
    [5, 480_000, 503],
    [6, 600_000, 503],
    [7, 600_000, 503],
    [8, 600_000, 503],
  ]);
  assertEquals(HOLD_MAX_MS, 600_000);
  assertEquals(h.pagesAsked(C1), 8);
  assertEquals(h.bot.deferred(), [C1]);
  assertEquals(h.bot.marks()[C1], M(100));
  assertEquals(h.events("backfill.forbidden"), []);
});

Deno.test("dispatch: a channel that fails and then answers is backfilled and let go, and a later failure starts again at attempt 1", async () => {
  const world: World = { [C1]: { guild: G1, pageStatus: (n) => (n <= 2 || n === 4 ? 503 : undefined), messages: [said(M(101), C1), said(M(102), C1)] } };
  const h = botHarness({ marks: { [C1]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  await h.timers.advance(RETRY_BASE_MS);
  await h.bot.settled();
  await h.timers.advance(2 * RETRY_BASE_MS);
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(101), M(102)]);
  assertEquals(h.bot.deferred(), []);
  assertEquals(h.timers.pending(), 0);
  assertEquals(h.events("backfill.released").map((l) => l.channel), [C1]);
  await h.bot.dispatch("READY", { guilds: [] }); // a reconnect; this time the first page fails again
  await h.bot.settled();
  assertEquals(h.events("backfill.failed").map((l) => [l.attempt, l.retryInMs]), [[1, 30_000], [2, 60_000], [1, 30_000]]);
});

Deno.test("dispatch: with the allowlist set, a channel whose guild lookup answers 404 is forbidden for the run, not held", async () => {
  const world: World = { [C3]: { guild: G1, lookupFails: 99, lookupStatus: 404, messages: [said(M(101), C3)] } };
  const h = botHarness({ allow: G1, marks: { [C3]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.settled();
  assertEquals(h.events("backfill.forbidden").map((l) => [l.channel, l.status]), [[C3, 404]]);
  assertEquals(h.events("backfill.guild_unknown"), []);
  assertEquals(h.bot.deferred(), []);
  assertEquals(h.timers.pending(), 0);
  assertEquals(h.bot.marks()[C3], M(100));
});

Deno.test("dispatch: without DISCORD_CAPTURE_GUILDS nothing changes: backfill starts at READY without waiting and every guild is captured", async () => {
  const world: World = { [C1]: { guild: G1, messages: [said(M(101), C1)] }, [C2]: { guild: G2, messages: [said(M(101), C2)] } };
  const h = botHarness({ marks: { [C1]: M(100), [C2]: M(100) }, world });
  await h.bot.dispatch("READY", { guilds: [{ id: G1 }, { id: G2 }] });
  await h.bot.settled();
  assertEquals([h.ids(C1), h.ids(C2)], [[M(101)], [M(101)]]);
  assertEquals(h.timers.pending(), 0, "no guild wait without a list");
  assertEquals(h.events("capture.guild_skipped"), []);
});

Deno.test("dispatch: live messages and reactions from a guild outside the list are skipped, the guild logged once; inside, a reaction is synced once it settles", async () => {
  const world: World = { [C1]: { guild: G1, messages: [] }, [C2]: { guild: G2, messages: [] } };
  const h = botHarness({ allow: G1, world });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.dispatch("MESSAGE_CREATE", said(M(201), C2, G2));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(202), C2, G2));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(203), C1, G1));
  await h.bot.settled();
  assertEquals(h.posted.map((p) => p.source.split("/").pop()), [M(203)]);
  assertEquals(h.events("capture.guild_skipped").map((l) => l.guild), [G2]);
  await h.bot.dispatch("MESSAGE_REACTION_ADD", { guild_id: G2, channel_id: C2, message_id: M(201) });
  await h.bot.dispatch("MESSAGE_REACTION_ADD", { guild_id: G1, channel_id: C1, message_id: M(203) });
  await h.timers.advance(3000);
  await h.bot.settled();
  assertEquals(h.reactionPosts, [`discord:${G1}/${C1}/${M(203)}`]);
  assert(!h.restCalls.some((p) => p.startsWith(`/channels/${C2}/messages/`)), "nothing read for the other guild");
});

Deno.test("dispatch: the capture queue never waits on, and never dies of, the PA: an interaction whose Discord call hangs, and one whose every dependency throws, leave the messages around them captured in order", async () => {
  const cmd = { id: M(900), application_id: APP, type: 2, token: "t".repeat(80), guild_id: G1, member: { user: KELLI }, data: { name: "loops", options: [] } };
  const posts: string[] = [];
  const hanging: PaIo = {
    discord: (_m, p) => {
      posts.push(p);
      return new Promise(() => {}); // Discord never answers the acknowledgement
    },
    loops: boom,
    capture: boom,
    history: boom,
    supersede: boom,
    log: () => {},
    now: () => new Date(T0),
  };
  for (const pa of [hanging, explodingPa]) {
    const world: World = { [C1]: { guild: G1, messages: [] } };
    const h = botHarness({ allow: G1, world, pa: { cfg: paConfig("true", KELLI.id, parseIdList(G1)), io: pa } });
    await h.bot.dispatch("READY", { guilds: [] });
    await h.bot.dispatch("MESSAGE_CREATE", said(M(301), C1, G1));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      h.bot.dispatch("INTERACTION_CREATE", cmd).then(() => "returned"),
      new Promise<string>((r) => timer = setTimeout(() => r("waited on the PA"), 300)),
    ]);
    clearTimeout(timer);
    assertEquals(outcome, "returned");
    await h.bot.dispatch("MESSAGE_CREATE", said(M(302), C1, G1));
    await h.bot.settled();
    assertEquals(h.ids(C1), [M(301), M(302)]);
    assertEquals(h.bot.marks()[C1], M(302));
  }
  assertEquals(posts, [`/interactions/${M(900)}/${"t".repeat(80)}/callback`], "the interaction did reach the PA");
});

Deno.test("dispatch: a malformed message, a failed post and a failed watermark save each cost one log line and never stop the queue", async () => {
  let saves = 0;
  const world: World = { [C1]: { guild: G1, messages: [] } };
  const h = botHarness({ world, postFails: (c) => c.source.endsWith(M(402)), saveFails: () => ++saves === 2 });
  await h.bot.dispatch("READY", { guilds: [] });
  await h.bot.dispatch("MESSAGE_CREATE", { id: M(401), channel_id: C1, guild_id: G1, type: 0 }); // no author, no content
  await h.bot.dispatch("MESSAGE_CREATE", said(M(402), C1, G1));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(403), C1, G1));
  await h.bot.dispatch("MESSAGE_CREATE", said(M(404), C1, G1));
  await h.bot.settled();
  assertEquals(h.ids(C1), [M(403), M(404)]);
  assertEquals(h.events("message.failed").map((l) => l.id), [M(401), M(402), M(404)]);
  assertEquals(h.bot.marks()[C1], M(404));
});

Deno.test("dispatch: command registration is retried on a timer with backoff, capped at an hour, until it succeeds; a reconnect's READY does not start a second attempt; only allowed guilds", async () => {
  let puts = 0;
  const paths: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const pa: PaIo = {
    discord: async (method, path) => {
      if (method !== "PUT") return undefined;
      puts++;
      paths.push(path);
      if (puts <= 2) throw new HttpError(503, "", `discord PUT ${path}`);
      return [{ id: "11", name: "loops" }, { id: "12", name: "loops-help" }];
    },
    loops: boom,
    capture: boom,
    history: boom,
    supersede: boom,
    log: (f) => void logs.push(f),
    now: () => new Date(T0),
  };
  const h = botHarness({ allow: G1, world: {}, pa: { cfg: paConfig("true", KELLI.id, parseIdList(G1)), io: pa } });
  await h.bot.dispatch("READY", { application: { id: APP }, guilds: [{ id: G1 }, { id: G2 }] });
  await flush();
  assertEquals(puts, 1);
  assertEquals(paths, [`/applications/${APP}/guilds/${G1}/commands`], "only the allowed guild");
  assertEquals(h.events("pa.register_retry").map((l) => l.inMs), [RETRY_BASE_MS]);
  await h.bot.dispatch("READY", { application: { id: APP }, guilds: [{ id: G1 }] }); // a reconnect
  await flush();
  assertEquals(puts, 1, "no second attempt beside the scheduled one");
  await h.timers.advance(RETRY_BASE_MS);
  assertEquals(puts, 2);
  assertEquals(h.events("pa.register_retry").map((l) => l.inMs), [RETRY_BASE_MS, 2 * RETRY_BASE_MS]);
  await h.timers.advance(2 * RETRY_BASE_MS);
  assertEquals(puts, 3);
  assertEquals(logs.filter((l) => l.event === "pa.registered").length, 1);
  await h.timers.advance(10 * RETRY_MAX_MS);
  assertEquals(puts, 3, "registered: no more attempts");
  assertEquals(RETRY_MAX_MS, 3_600_000);
});
