/**
 * Keeping a message's reactions in Grysstof current. One routine for the three ways it runs:
 * live (the bot sees a reaction added or removed), catch-up (the bot reconnects after being
 * down) and history (a one-off backfill). Discord and Grysstof come in as functions, so the
 * logic is tested with fakes and every path writes through the same record_reactions tool.
 */
import type { Reaction } from "../core/reactions.ts";
import { type DiscordAuthor, type DiscordReaction, emojiKey, reactionsOf } from "./discord.ts";

export type ReactionIo = {
  /** A Discord REST GET, parsed. Throws on failure. */
  rest: <T>(path: string) => Promise<T>;
  /** record_reactions for one source; returns the tool's text. Throws when the write itself failed. */
  post: (source: string, reactions: Reaction[]) => Promise<string>;
};

type Msg = { id: string; reactions?: DiscordReaction[] };

/** A message's reactions with who, looked up per emoji. A failed lookup keeps the count with no names. */
async function reactionsFor(io: ReactionIo, channel: string, msg: Msg): Promise<Reaction[]> {
  const users = new Map<string, DiscordAuthor[]>();
  for (const r of msg.reactions ?? []) {
    const key = emojiKey(r.emoji);
    try {
      users.set(key, await io.rest<DiscordAuthor[]>(`/channels/${channel}/messages/${msg.id}/reactions/${encodeURIComponent(key)}?limit=100`));
    } catch {
      // who is unknown for this emoji; the count still stands
    }
  }
  return reactionsOf(msg.reactions, (k) => users.get(k));
}

const notCaptured = (answer: string) => answer.startsWith("No thought with source");

/** Bring one message's reactions in Grysstof up to date with Discord (an empty list clears them). */
export async function syncMessageReactions(io: ReactionIo, guild: string, channel: string, messageId: string): Promise<"recorded" | "not-captured"> {
  const msg = (await io.rest<Msg | undefined>(`/channels/${channel}/messages/${messageId}`)) ?? { id: messageId };
  const answer = await io.post(`discord:${guild}/${channel}/${messageId}`, await reactionsFor(io, channel, msg));
  return notCaptured(answer) ? "not-captured" : "recorded";
}

export type ChannelSync = { messages: number; withReactions: number; recorded: number; notCaptured: number; failed: number };

/**
 * Every message in a channel newer than `since` (a snowflake), newest first in pages of 100,
 * records the reactions of those that have any. One message's failure is counted, never fatal.
 */
export async function syncChannelReactions(io: ReactionIo, guild: string, channel: string, since: string): Promise<ChannelSync> {
  const out: ChannelSync = { messages: 0, withReactions: 0, recorded: 0, notCaptured: 0, failed: 0 };
  let before: string | undefined;
  for (;;) {
    const page = await io.rest<Msg[]>(`/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!page?.length) break;
    for (const m of page) {
      if (BigInt(m.id) <= BigInt(since)) return out;
      out.messages++;
      if (!m.reactions?.length) continue;
      out.withReactions++;
      try {
        const answer = await io.post(`discord:${guild}/${channel}/${m.id}`, await reactionsFor(io, channel, m));
        if (notCaptured(answer)) out.notCaptured++;
        else out.recorded++;
      } catch {
        out.failed++;
      }
    }
    before = page[page.length - 1].id;
    if (page.length < 100) break;
  }
  return out;
}
