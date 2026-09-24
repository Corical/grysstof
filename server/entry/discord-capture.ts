/**
 * Discord capture: a bot that listens in every channel it has been invited
 * to and posts each human message into a Grysstof instance as a thought.
 *
 *   deno run --env-file=.env.xactco --env-file=.env.discord \
 *     --allow-net --allow-env --allow-read --allow-write entry/discord-capture.ts
 *
 * Env: DISCORD_BOT_TOKEN (required), MCP_ACCESS_KEY (required),
 * GRYSSTOF_URL (default http://localhost:$PORT/mcp), DISCORD_WATERMARKS
 * (default %LOCALAPPDATA%/grysstof/discord-watermarks.json), DISCORD_BACKFILL_SINCE
 * (an ISO date; every readable text channel with no watermark yet is seeded to it,
 * so the next start imports history from that date; remove it once done).
 *
 * Idempotent across restarts: the last captured message id per channel is
 * written after every successful post; on start, every known channel is
 * backfilled from its watermark, so downtime loses nothing and nothing is
 * posted twice. A channel seen for the first time starts from now.
 */
import { advance, type Capture, type DiscordMessage, distil, type Names, type Reaction, type Watermarks } from "../writer/discord.ts";
import { type ReactionIo, syncChannelReactions, syncMessageReactions } from "../writer/discord-reactions.ts";

const API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15); // GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, MESSAGE_CONTENT
/** After a reconnect, reactions on messages this recent are re-read: a 👍 given while the bot was down still lands. */
const REACTION_CATCHUP_DAYS = 7;
/** A burst of reactions on one message becomes one refresh this long after the last. */
const REACTION_SETTLE_MS = 3000;
const THREAD_TYPES = new Set([10, 11, 12]);
const BACKFILL_PAGE = 100;

const token = Deno.env.get("DISCORD_BOT_TOKEN");
const key = Deno.env.get("MCP_ACCESS_KEY");
if (!token || !key) {
  console.error("DISCORD_BOT_TOKEN and MCP_ACCESS_KEY are required");
  Deno.exit(2);
}
const brainUrl = Deno.env.get("GRYSSTOF_URL") ?? `http://localhost:${Deno.env.get("PORT") ?? "8788"}/mcp`;
const logDir = `${Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("HOME") ?? "."}/grysstof`;
const watermarkPath = Deno.env.get("DISCORD_WATERMARKS") ?? `${logDir}/discord-watermarks.json`;

async function log(fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  console.log(line);
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(`${logDir}/discord.log`, line + "\n", { append: true });
  } catch { /* the log is a courtesy */ }
}

// --- names: guild and channel ids to what a person calls them ---
const guilds = new Map<string, string>();
type Chan = { name: string; type: number; parent?: string; guild?: string };
const channels = new Map<string, Chan>();

/** REST message objects carry no guild_id; the channel cache does, so every proof link can name the guild. */
function remember(c: { id: string; name?: string; type: number; parent_id?: string | null; guild_id?: string }, guild?: string) {
  channels.set(c.id, { name: c.name ?? c.id, type: c.type, parent: c.parent_id ?? undefined, guild: guild ?? c.guild_id ?? channels.get(c.id)?.guild });
}

function withGuild(m: DiscordMessage): DiscordMessage {
  return m.guild_id ? m : { ...m, guild_id: channels.get(m.channel_id)?.guild };
}

async function rest<T>(path: string): Promise<T> {
  for (;;) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bot ${token}` } });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({})) as { retry_after?: number };
      const wait = Math.ceil((body.retry_after ?? 1) * 1000);
      await log({ event: "discord.rate_limited", path, waitMs: wait });
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`discord ${path} -> ${res.status}`);
    return await res.json() as T;
  }
}

/** A Discord snowflake for an instant: everything after it was posted after that instant. */
function snowflakeAt(iso: string): string {
  return ((BigInt(Date.parse(iso)) - 1420070400000n) << 22n).toString();
}

async function namesFor(m: DiscordMessage): Promise<Names> {
  let c = channels.get(m.channel_id);
  if (!c) {
    try {
      remember(await rest<{ id: string; name?: string; type: number; parent_id?: string | null; guild_id?: string }>(`/channels/${m.channel_id}`));
    } catch (e) {
      await log({ event: "channel.lookup_failed", channel: m.channel_id, error: String(e) });
    }
    c = channels.get(m.channel_id) ?? { name: m.channel_id, type: 0 };
  }
  const parent = THREAD_TYPES.has(c.type) && c.parent ? channels.get(c.parent)?.name : undefined;
  return { guild: m.guild_id ? guilds.get(m.guild_id) : undefined, channel: c.name, parent, channelNames: (id) => channels.get(id)?.name };
}

// --- watermarks ---
let marks: Watermarks = {};
try {
  marks = JSON.parse(await Deno.readTextFile(watermarkPath)) as Watermarks;
} catch { /* first run */ }
async function saveMarks() {
  await Deno.mkdir(logDir, { recursive: true });
  await Deno.writeTextFile(watermarkPath, JSON.stringify(marks, null, 2));
}

// --- posting to the brain, one at a time, in arrival order ---
function textOf(raw: string): string {
  const data = raw.includes("\ndata:") || raw.startsWith("event:") ? (raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}") : raw;
  const msg = JSON.parse(data);
  if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`);
  const r = msg.result ?? {};
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "isError");
  return r.content?.[0]?.text ?? "";
}

async function post(c: Capture): Promise<string> {
  const res = await fetch(brainUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key!, "x-brain-actor": c.actor },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "capture_thought",
        arguments: {
          content: c.content,
          source: c.source,
          proof: c.proof,
          occurred_at: c.occurredAt,
          channel: c.channel,
          ...(c.thread ? { thread: c.thread } : {}),
          ...(c.inReplyTo ? { in_reply_to: c.inReplyTo } : {}),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`brain answered ${res.status}`);
  return textOf(await res.text());
}

/** record_reactions through the brain. "No thought with source" is an answer (the message was never captured), not a failure. */
async function postReactions(source: string, reactions: Reaction[]): Promise<string> {
  const res = await fetch(brainUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key!, "x-brain-actor": "discord:reactions" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_reactions", arguments: { source, reactions } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`brain answered ${res.status}`);
  try {
    return textOf(await res.text());
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("No thought with source")) return msg;
    throw e;
  }
}

const reactionIo: ReactionIo = { rest, post: postReactions };
const settling = new Map<string, ReturnType<typeof setTimeout>>();

/** Refresh one message's reactions once they settle, in line behind any capture still queued for it. */
function reactionChanged(d: { guild_id?: string; channel_id: string; message_id: string }) {
  const k = `${d.channel_id}/${d.message_id}`;
  clearTimeout(settling.get(k));
  settling.set(k, setTimeout(() => {
    settling.delete(k);
    chain = chain.then(async () => {
      try {
        const outcome = await syncMessageReactions(reactionIo, d.guild_id ?? "@me", d.channel_id, d.message_id);
        await log({ event: "reactions.synced", channel: d.channel_id, message: d.message_id, outcome });
      } catch (e) {
        await log({ event: "reactions.failed", channel: d.channel_id, message: d.message_id, error: String(e) });
      }
    });
  }, REACTION_SETTLE_MS));
}

/** After a reconnect: re-read the last few days' reactions in every tracked channel. */
async function reactionCatchUp() {
  const since = snowflakeAt(new Date(Date.now() - REACTION_CATCHUP_DAYS * 86_400_000).toISOString());
  for (const channelId of Object.keys(marks)) {
    const guild = channels.get(channelId)?.guild ?? "@me";
    try {
      const done = await syncChannelReactions(reactionIo, guild, channelId, since);
      if (done.withReactions) await log({ event: "reactions.caught_up", channel: channelId, ...done });
    } catch (e) {
      await log({ event: "reactions.catchup_failed", channel: channelId, error: String(e) });
    }
  }
}

let chain = Promise.resolve();
function enqueue(raw: DiscordMessage, via: "gateway" | "backfill") {
  chain = chain.then(async () => {
    const names = await namesFor(raw);
    const m = withGuild(raw);
    const d = distil(m, names);
    if ("skip" in d) {
      await log({ event: "message.skipped", via, id: m.id, channel: m.channel_id, reason: d.skip });
      return;
    }
    try {
      const answer = await post(d);
      marks = advance(marks, m.channel_id, m.id);
      await saveMarks();
      await log({ event: "message.captured", via, id: m.id, channel: m.channel_id, actor: d.actor, answer });
    } catch (e) {
      await log({ event: "message.failed", via, id: m.id, channel: m.channel_id, error: String(e) });
    }
  });
  return chain;
}

// --- backfill: what was said while the bot was down ---
async function backfill() {
  const since = Deno.env.get("DISCORD_BACKFILL_SINCE");
  if (since) {
    const seed = snowflakeAt(since);
    let seeded = 0;
    for (const g of await rest<{ id: string }[]>("/users/@me/guilds")) {
      const chans = await rest<{ id: string; name?: string; type: number; parent_id?: string | null }[]>(`/guilds/${g.id}/channels`);
      for (const c of chans) {
        remember(c, g.id);
        if (c.type !== 0 || marks[c.id]) continue;
        marks[c.id] = seed;
        seeded++;
      }
    }
    await saveMarks();
    await log({ event: "backfill.seeded", since, channels: seeded });
  }
  for (const [channelId, after] of Object.entries(marks)) {
    let cursor = after;
    for (;;) {
      let page: DiscordMessage[];
      try {
        page = await rest<DiscordMessage[]>(`/channels/${channelId}/messages?after=${cursor}&limit=${BACKFILL_PAGE}`);
      } catch (e) {
        await log({ event: "backfill.failed", channel: channelId, error: String(e) });
        break;
      }
      if (page.length === 0) break;
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const m of page) enqueue(m, "backfill");
      cursor = page[page.length - 1].id;
      if (page.length < BACKFILL_PAGE) break;
    }
  }
  await chain;
}

// --- gateway ---
type Payload = { op: number; d?: unknown; s?: number | null; t?: string | null };
let seq: number | null = null;
let sessionId: string | undefined;
let resumeUrl: string | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let acked = true;

function connect(url: string, resume: boolean) {
  const ws = new WebSocket(`${url}?v=10&encoding=json`);
  const send = (p: Payload) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(p));

  ws.onmessage = async (ev) => {
    const p = JSON.parse(String(ev.data)) as Payload;
    if (p.s != null) seq = p.s;
    switch (p.op) {
      case 10: {
        const { heartbeat_interval } = p.d as { heartbeat_interval: number };
        clearInterval(heartbeat);
        acked = true;
        heartbeat = setInterval(() => {
          if (!acked) {
            ws.close(4000, "heartbeat not acked");
            return;
          }
          acked = false;
          send({ op: 1, d: seq });
        }, heartbeat_interval);
        if (resume && sessionId) send({ op: 6, d: { token, session_id: sessionId, seq } });
        else send({ op: 2, d: { token, intents: INTENTS, properties: { os: Deno.build.os, browser: "grysstof", device: "grysstof" } } });
        break;
      }
      case 11:
        acked = true;
        break;
      case 7:
        ws.close(4001, "reconnect requested");
        break;
      case 9: {
        const resumable = p.d as boolean;
        if (!resumable) sessionId = undefined;
        ws.close(4002, "invalid session");
        break;
      }
      case 0:
        await dispatch(p.t!, p.d);
        break;
    }
  };

  ws.onclose = async (ev) => {
    clearInterval(heartbeat);
    await log({ event: "gateway.closed", code: ev.code, reason: ev.reason });
    if (ev.code === 4004 || ev.code === 4014) {
      await log({ event: "gateway.fatal", hint: ev.code === 4004 ? "bad token" : "Message Content Intent not enabled in the Developer Portal" });
      Deno.exit(1);
    }
    setTimeout(() => connect(sessionId && resumeUrl ? resumeUrl : url, Boolean(sessionId)), 2000 + Math.random() * 3000);
  };
  ws.onerror = (e) => log({ event: "gateway.error", error: String((e as ErrorEvent).message ?? e) });
}

async function dispatch(t: string, d: unknown) {
  switch (t) {
    case "READY": {
      const r = d as { session_id: string; resume_gateway_url: string; user: { username: string } };
      sessionId = r.session_id;
      resumeUrl = r.resume_gateway_url;
      await log({ event: "gateway.ready", bot: r.user.username, brain: brainUrl, watermarks: Object.keys(marks).length });
      backfill().then(reactionCatchUp);
      break;
    }
    case "RESUMED":
      await log({ event: "gateway.resumed" });
      break;
    case "GUILD_CREATE": {
      const g = d as { id: string; name: string; channels: { id: string; name?: string; type: number; parent_id?: string | null }[]; threads?: { id: string; name?: string; type: number; parent_id?: string | null }[] };
      guilds.set(g.id, g.name);
      for (const c of [...g.channels, ...(g.threads ?? [])]) remember(c, g.id);
      await log({ event: "guild.seen", guild: g.name, channels: g.channels.length, threads: g.threads?.length ?? 0 });
      break;
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
      remember(d as { id: string; name?: string; type: number; parent_id?: string | null; guild_id?: string });
      break;
    case "MESSAGE_CREATE":
      enqueue(d as DiscordMessage, "gateway");
      break;
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE":
    case "MESSAGE_REACTION_REMOVE_ALL":
    case "MESSAGE_REACTION_REMOVE_EMOJI":
      reactionChanged(d as { guild_id?: string; channel_id: string; message_id: string });
      break;
  }
}

const { url } = await rest<{ url: string }>("/gateway/bot");
await log({ event: "gateway.connecting", url, brain: brainUrl, watermarks: watermarkPath });
connect(url, false);
