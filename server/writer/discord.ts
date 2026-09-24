/**
 * The Discord writer: turns one gateway message into one thought for the
 * memory, or says why not. Pure: no network, no clock. entry/discord-capture.ts
 * listens to the gateway, keeps channel names, and posts what this returns.
 *
 * A message is a thought (not a fact): the same text from the same person
 * merges, and search_thoughts finds it by meaning. Source is the message's
 * coordinates, proof is the deep link Discord itself resolves.
 */

export type DiscordAuthor = { id: string; username: string; global_name?: string | null; bot?: boolean };
export type DiscordAttachment = { filename: string; url: string };
export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  type: number;
  content: string;
  author: DiscordAuthor;
  attachments?: DiscordAttachment[];
  mentions?: DiscordAuthor[];
  timestamp: string;
  referenced_message?: { author?: DiscordAuthor; content?: string } | null;
  /** Set on replies (and on forwards/crossposts, which are not answers); its ids may be absent when they equal the message's own. */
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string } | null;
};

export type Names = { guild?: string; channel: string; parent?: string; channelNames?: (id: string) => string | undefined };

/** `<@id>` and `<@!id>` become @Name from the message's own mentions list; `<#id>` becomes #channel when known. */
export function resolveMentions(text: string, mentions: DiscordAuthor[] | undefined, channelNames?: (id: string) => string | undefined): string {
  const byId = new Map((mentions ?? []).map((u) => [u.id, displayName(u)]));
  return text
    .replace(/<@!?(\d+)>/g, (whole, id) => (byId.has(id) ? `@${byId.get(id)}` : whole))
    .replace(/<#(\d+)>/g, (whole, id) => (channelNames?.(id) ? `#${channelNames(id)}` : whole));
}

export type Capture = {
  content: string;
  source: string;
  proof: string;
  actor: string;
  occurredAt: string;
  /** The channel by name; for a thread, its parent channel, so the whole conversation reads back under one name. */
  channel: string;
  /** The thread's name, when the message was said in one. */
  thread?: string;
  /** For a reply: the source of the message it answers, in the same shape as `source`. */
  inReplyTo?: string;
};
export type Distilled = { skip: string } | Capture;

export type Watermarks = Record<string, string>;

/** Discord message types the bot treats as a person talking: DEFAULT and REPLY. */
const HUMAN_TYPES = new Set([0, 19]);
const MAX_CONTENT = 4000;
const MAX_QUOTE = 200;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");

export function displayName(a: DiscordAuthor): string {
  return collapse(a.global_name ?? "") || a.username;
}

export function distil(m: DiscordMessage, names: Names): Distilled {
  if (m.author.bot) return { skip: "bot author" };
  if (!HUMAN_TYPES.has(m.type)) return { skip: `message type ${m.type}` };
  const text = collapse(resolveMentions(m.content ?? "", m.mentions, names.channelNames));
  const files = (m.attachments ?? []).map((a) => `[attachment: ${a.filename} ${a.url.split("?")[0]}]`);
  if (!text && files.length === 0) return { skip: "no text and no attachments" };

  const where = names.parent ? `#${names.parent} > ${names.channel}` : `#${names.channel}`;
  const server = names.guild ? ` (${names.guild})` : "";
  const day = m.timestamp.slice(0, 10);
  const who = displayName(m.author);
  const quoted = m.referenced_message?.author && m.referenced_message.content
    ? ` [replying to ${displayName(m.referenced_message.author)}: ${cut(collapse(m.referenced_message.content), MAX_QUOTE)}]`
    : "";
  const body = [text, ...files].filter(Boolean).join(" ");
  const content = cut(`Discord ${where}${server}, ${day}, ${who}:${quoted} ${body}`, MAX_CONTENT);

  const guild = m.guild_id ?? "@me";
  const ref = m.message_reference;
  const inReplyTo = m.type === 19 && ref?.message_id
    ? `discord:${ref.guild_id ?? guild}/${ref.channel_id ?? m.channel_id}/${ref.message_id}`
    : undefined;
  return {
    content,
    source: `discord:${guild}/${m.channel_id}/${m.id}`,
    proof: `https://discord.com/channels/${guild}/${m.channel_id}/${m.id}`,
    actor: `discord:${m.author.username}`,
    occurredAt: m.timestamp,
    channel: names.parent ?? names.channel,
    ...(names.parent ? { thread: names.channel } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
  };
}

/** Snowflakes are 64-bit and ordered; compare as BigInt, never as strings of unequal length. */
export function newer(a: string, b: string | undefined): boolean {
  return b === undefined || BigInt(a) > BigInt(b);
}

export function advance(w: Watermarks, channelId: string, messageId: string): Watermarks {
  return newer(messageId, w[channelId]) ? { ...w, [channelId]: messageId } : w;
}
