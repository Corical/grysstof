/**
 * Backfill for Discord thoughts captured before the writer recorded where they were said.
 * Pure: reads the "Discord #channel > thread (Guild), YYYY-MM-DD, Who: …" header that
 * distil() has always written, and says which metadata keys a thought is missing.
 * entry/discord-backfill.ts does the reading, the Discord lookups and the writing.
 */
import type { ThoughtMetadata } from "../core/ports/mod.ts";

export type Where = { channel: string; thread?: string };

/**
 * The channel (and thread) from a line distil() wrote, or null when the text is not one.
 * The header ends at the first ", YYYY-MM-DD, "; a quoted reply later in the line cannot
 * move it. Channel names cannot contain " > ", so the first one splits channel from thread;
 * thread names may contain anything, brackets and " > " included.
 */
export function whereFrom(content: string): Where | null {
  if (!content.startsWith("Discord #")) return null;
  const date = /, \d{4}-\d{2}-\d{2}, /.exec(content);
  if (!date) return null;
  let header = content.slice("Discord #".length, date.index);
  const guild = / \([^()]*\)$/.exec(header);
  if (guild) header = header.slice(0, guild.index);
  const split = header.indexOf(" > ");
  const channel = (split >= 0 ? header.slice(0, split) : header).trim();
  const thread = split >= 0 ? header.slice(split + 3).trim() : "";
  if (!channel) return null;
  return thread ? { channel, thread } : { channel };
}

export type Patch = { set: { channel?: string; thread?: string }; lookupReply: boolean };

/**
 * What one stored thought still needs, or null when it needs nothing (or is not a Discord line).
 * A reply is recognised by the "[replying to …]" quote distil() writes; its parent's id is not
 * in the text, so it is flagged for a Discord lookup rather than guessed.
 */
export function backfillPatch(t: { content: string; metadata: ThoughtMetadata }): Patch | null {
  const source = t.metadata.source;
  if (typeof source !== "string" || !source.startsWith("discord:")) return null;
  const where = whereFrom(t.content);
  if (!where) return null;
  const set: Patch["set"] = {};
  if (typeof t.metadata.channel !== "string") {
    set.channel = where.channel;
    if (where.thread) set.thread = where.thread;
  }
  const quotesParent = /^Discord #[^\n]*?, \d{4}-\d{2}-\d{2}, [^:\n]+: \[replying to /.test(t.content);
  const lookupReply = quotesParent && typeof t.metadata.in_reply_to !== "string";
  if (!Object.keys(set).length && !lookupReply) return null;
  return { set, lookupReply };
}

/** "discord:<guild>/<channel>/<message>" → its parts, or null. */
export function coordinates(source: string): { guild: string; channel: string; message: string } | null {
  const m = /^discord:([^/]+)\/(\d+)\/(\d+)$/.exec(source);
  return m ? { guild: m[1], channel: m[2], message: m[3] } : null;
}
