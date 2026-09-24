import { assert, assertEquals } from "@std/assert";
import { syncMessageReactions, syncChannelReactions } from "../writer/discord-reactions.ts";
import type { DiscordAuthor } from "../writer/discord.ts";

const kelli: DiscordAuthor = { id: "1", username: "kellireynolds", global_name: "Kelli" };
const devon: DiscordAuthor = { id: "2", username: "dman_devon", global_name: "Devon" };
const dyno: DiscordAuthor = { id: "3", username: "Dyno", bot: true };

/** A fake Discord: messages per channel (newest first, as Discord pages them) and who reacted with what. */
function fakeDiscord(opts: { messages: Record<string, { id: string; reactions?: { count: number; emoji: { id: string | null; name: string } }[] }[]>; users: Record<string, DiscordAuthor[]>; failUsersFor?: string }) {
  const calls: string[] = [];
  const rest = async <T>(path: string): Promise<T> => {
    calls.push(path);
    const react = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^?]+)\?limit=100$/.exec(path);
    if (react) {
      const key = decodeURIComponent(react[3]);
      if (key === opts.failUsersFor) throw new Error("discord 504");
      return (opts.users[`${react[2]}|${key}`] ?? []) as T;
    }
    const one = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
    if (one) return (opts.messages[one[1]] ?? []).find((m) => m.id === one[2]) as T;
    const page = /^\/channels\/(\d+)\/messages\?limit=100(?:&before=(\d+))?$/.exec(path);
    if (page) {
      const all = opts.messages[page[1]] ?? [];
      const from = page[2] ? all.findIndex((m) => m.id === page[2]) + 1 : 0;
      return all.slice(from, from + 100) as T;
    }
    throw new Error(`unexpected ${path}`);
  };
  return { rest, calls };
}

function fakeBrain(known: Set<string>) {
  const posted: { source: string; reactions: unknown }[] = [];
  const post = async (source: string, reactions: unknown) => {
    posted.push({ source, reactions });
    return known.has(source) ? "Recorded" : `No thought with source ${source}`;
  };
  return { post, posted };
}

Deno.test("syncMessageReactions: one message's current reactions with who, bots dropped; a message with none clears; unknown to Grysstof is skipped, not an error", async () => {
  const { rest } = fakeDiscord({
    messages: { "100": [{ id: "7", reactions: [{ count: 2, emoji: { id: null, name: "👍" } }, { count: 2, emoji: { id: "55", name: "cool" } }] }, { id: "8" }] },
    users: { "7|👍": [kelli, devon], "7|cool:55": [devon, dyno] },
  });
  const brain = fakeBrain(new Set(["discord:g/100/7", "discord:g/100/8"]));
  assertEquals(await syncMessageReactions({ rest, post: brain.post }, "g", "100", "7"), "recorded");
  assertEquals(brain.posted[0], { source: "discord:g/100/7", reactions: [{ emoji: "👍", count: 2, by: ["Kelli", "Devon"] }, { emoji: ":cool:", count: 2, by: ["Devon"] }] });
  assertEquals(await syncMessageReactions({ rest, post: brain.post }, "g", "100", "8"), "recorded", "all reactions removed: an empty list clears them");
  assertEquals(brain.posted[1], { source: "discord:g/100/8", reactions: [] });
  const stranger = fakeBrain(new Set());
  assertEquals(await syncMessageReactions({ rest, post: stranger.post }, "g", "100", "7"), "not-captured");
});

Deno.test("syncMessageReactions: a failed who-lookup keeps the count and records the rest; the emoji key is URL-encoded", async () => {
  const { rest, calls } = fakeDiscord({
    messages: { "100": [{ id: "7", reactions: [{ count: 3, emoji: { id: null, name: "👍" } }, { count: 1, emoji: { id: null, name: "🙏" } }] }] },
    users: { "7|🙏": [kelli] },
    failUsersFor: "👍",
  });
  const brain = fakeBrain(new Set(["discord:g/100/7"]));
  await syncMessageReactions({ rest, post: brain.post }, "g", "100", "7");
  assertEquals(brain.posted[0].reactions, [{ emoji: "👍", count: 3, by: [] }, { emoji: "🙏", count: 1, by: ["Kelli"] }]);
  assert(calls.some((c) => c.includes(encodeURIComponent("👍"))), "emoji travels URL-encoded");
});

Deno.test("syncChannelReactions: pages back to `since`, touches only messages with reactions, and reports what it did", async () => {
  // Snowflakes: bigger is newer. Discord pages newest first.
  const msgs = Array.from({ length: 250 }, (_, i) => {
    const id = String(1_000_000 + (250 - i)); // 1000250 … 1000001
    return i % 50 === 0 ? { id, reactions: [{ count: 1, emoji: { id: null, name: "👍" } }] } : { id };
  });
  const { rest, calls } = fakeDiscord({ messages: { "100": msgs }, users: {} });
  const known = new Set(msgs.map((m) => `discord:g/100/${m.id}`));
  const brain = fakeBrain(known);
  const all = await syncChannelReactions({ rest, post: brain.post }, "g", "100", "0");
  assertEquals(all, { messages: 250, withReactions: 5, recorded: 5, notCaptured: 0, failed: 0 });
  assertEquals(calls.filter((c) => /messages\?limit=100/.test(c)).length, 3, "250 messages is three pages");

  const recent = fakeBrain(known);
  const since = String(1_000_000 + 150); // only ids above this count
  const part = await syncChannelReactions({ rest, post: recent.post }, "g", "100", since);
  assertEquals(part.messages, 100, "stops at since instead of walking all history");
  assertEquals(part.withReactions, 2);
});

Deno.test("syncChannelReactions: a message Grysstof never captured is counted, a failing write is counted, neither stops the channel", async () => {
  const msgs = [
    { id: "30", reactions: [{ count: 1, emoji: { id: null, name: "👍" } }] },
    { id: "20", reactions: [{ count: 1, emoji: { id: null, name: "👍" } }] },
    { id: "10", reactions: [{ count: 1, emoji: { id: null, name: "👍" } }] },
  ];
  const { rest } = fakeDiscord({ messages: { "100": msgs }, users: {} });
  const post = async (source: string) => {
    if (source.endsWith("/20")) throw new Error("brain answered 500");
    return source.endsWith("/30") ? "Recorded" : `No thought with source ${source}`;
  };
  assertEquals(await syncChannelReactions({ rest, post }, "g", "100", "0"), { messages: 3, withReactions: 3, recorded: 1, notCaptured: 1, failed: 1 });
});
