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
 * so the next start imports history from that date; remove it once done),
 * DISCORD_CAPTURE_GUILDS (comma-separated guild ids; unset means every guild, as before;
 * when set, messages, backfill and reactions of other guilds are skipped, each guild logged once,
 * backfill waits up to 30 s for the guild list, and the loops assistant answers only there).
 *
 * The loops assistant (writer/discord-pa.ts): PA_ENABLED (unset means off), PA_USERS
 * (comma-separated Discord user ids allowed to use /loops). When on, /loops and /loops-help are
 * registered in each allowed guild at READY, retried with backoff until they take; interactions
 * are handled beside the capture queue, never in it, and can never end the process.
 *
 * Idempotent across restarts: the last captured message id per channel is
 * written after every successful post; on start, every known channel is
 * backfilled from its watermark, so downtime loses nothing and nothing is
 * posted twice. A channel seen for the first time starts from now.
 *
 * This file is the socket, the environment and the real I/O. What the bot does with each gateway
 * event is writer/discord-dispatch.ts, tested with a fake gateway.
 */
import type { Capture, Reaction, Watermarks } from "../writer/discord.ts";
import { createBot } from "../writer/discord-dispatch.ts";
import { type PaIo, paConfig, parseIdList } from "../writer/discord-pa.ts";
import { browseHistory, browseLoops, discordClient, HttpError, type HttpDeps, mcpCapture, mcpTool } from "../writer/discord-rest.ts";

const API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15); // GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, MESSAGE_CONTENT

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
    // Same text as before ("discord <path> -> 403"); the status is now also a field the backfill reads.
    if (!res.ok) throw new HttpError(res.status, "", `discord ${path}`);
    return await res.json() as T;
  }
}

// --- watermarks ---
let initialMarks: Watermarks = {};
try {
  initialMarks = JSON.parse(await Deno.readTextFile(watermarkPath)) as Watermarks;
} catch { /* first run */ }
async function saveMarks(marks: Watermarks) {
  await Deno.mkdir(logDir, { recursive: true });
  await Deno.writeTextFile(watermarkPath, JSON.stringify(marks, null, 2));
}

// --- posting to the brain ---
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
          author_id: c.authorId,
          channel_id: c.channelId,
          ...(c.parentId ? { parent_id: c.parentId } : {}),
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

// --- the bot: the loops assistant's I/O, then everything that decides something ---
const captureGuilds = parseIdList(Deno.env.get("DISCORD_CAPTURE_GUILDS"));
const pa = paConfig(Deno.env.get("PA_ENABLED"), Deno.env.get("PA_USERS"), captureGuilds);
const paRest: HttpDeps = { onRateLimit: (f) => void log({ event: "discord.rate_limited", ...f }) };
const tool = mcpTool(brainUrl, key!, paRest);
const paIo: PaIo = {
  discord: discordClient(token!, paRest),
  loops: browseLoops(brainUrl, key!, paRest),
  capture: mcpCapture(brainUrl, key!, paRest),
  history: browseHistory(brainUrl, key!, paRest),
  supersede: (actor, newerId, olderId) => tool(actor, "supersede_fact", { newer_id: newerId, older_id: olderId }),
  log,
  now: () => new Date(),
};
const bot = createBot(
  { rest, post, postReactions, saveMarks, log, timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) }, now: () => Date.now() },
  { captureGuilds, backfillSince: Deno.env.get("DISCORD_BACKFILL_SINCE"), pa, paIo },
  initialMarks,
);

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
        if (p.t === "READY") {
          const r = p.d as { session_id: string; resume_gateway_url: string; user: { username: string } };
          sessionId = r.session_id;
          resumeUrl = r.resume_gateway_url;
          await log({
            event: "gateway.ready",
            bot: r.user.username,
            brain: brainUrl,
            watermarks: Object.keys(bot.marks()).length,
            captureGuilds: captureGuilds ? [...captureGuilds] : "all",
            pa: pa.enabled ? `on, ${pa.users.size} user(s)` : "off",
          });
        } else if (p.t === "RESUMED") {
          await log({ event: "gateway.resumed" });
        }
        await bot.dispatch(p.t!, p.d);
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

const { url } = await rest<{ url: string }>("/gateway/bot");
await log({ event: "gateway.connecting", url, brain: brainUrl, watermarks: watermarkPath });
connect(url, false);
