/**
 * One-off: record who reacted to every captured Discord message, back to DISCORD_BACKFILL_SINCE
 * (the date Grysstof's Discord history starts). Writes through the running server's
 * record_reactions tool, the same path the live bot uses, so it needs the server up.
 *
 *   deno run -A --env-file=.env.xactco --env-file=.env.discord entry/discord-reactions-backfill.ts [--since 2026-01-01]
 *
 * Idempotent: reactions are the current state, replaced whole. Safe to re-run.
 */
import type { Reaction } from "../core/reactions.ts";
import { type ChannelSync, syncChannelReactions } from "../writer/discord-reactions.ts";

const API = "https://discord.com/api/v10";
const token = Deno.env.get("DISCORD_BOT_TOKEN") ?? Deno.env.get("DISCORD_TOKEN");
const key = Deno.env.get("MCP_ACCESS_KEY");
if (!token || !key) {
  console.error("DISCORD_BOT_TOKEN and MCP_ACCESS_KEY are required");
  Deno.exit(2);
}
const brainUrl = Deno.env.get("GRYSSTOF_URL") ?? `http://localhost:${Deno.env.get("PORT") ?? "8788"}/mcp`;
const i = Deno.args.indexOf("--since");
const sinceDate = i >= 0 ? Deno.args[i + 1] : Deno.env.get("DISCORD_BACKFILL_SINCE") ?? "2026-01-01";
const since = ((BigInt(Date.parse(sinceDate)) - 1420070400000n) << 22n).toString();

async function rest<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({})) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (res.status >= 500 && attempt < 4) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`discord ${path} -> ${res.status}`);
    }
    return await res.json() as T;
  }
}

async function post(source: string, reactions: Reaction[]): Promise<string> {
  const res = await fetch(brainUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key!, "x-brain-actor": "backfill:reactions" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_reactions", arguments: { source, reactions } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`brain answered ${res.status}`);
  const raw = await res.text();
  const data = raw.includes("\ndata:") || raw.startsWith("event:") ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()! : raw;
  const r = JSON.parse(data).result ?? {};
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError && !text.startsWith("No thought with source")) throw new Error(text);
  return text;
}

const total: ChannelSync = { messages: 0, withReactions: 0, recorded: 0, notCaptured: 0, failed: 0 };
console.log(`since ${sinceDate} (snowflake ${since}) brain ${brainUrl}`);
for (const g of await rest<{ id: string; name: string }[]>("/users/@me/guilds")) {
  for (const c of await rest<{ id: string; name: string; type: number }[]>(`/guilds/${g.id}/channels`)) {
    if (c.type !== 0 && c.type !== 5) continue;
    try {
      const done = await syncChannelReactions({ rest, post }, g.id, c.id, since);
      for (const k of Object.keys(total) as (keyof ChannelSync)[]) total[k] += done[k];
      if (done.withReactions) console.log(`#${c.name}: ${JSON.stringify(done)}`);
    } catch (e) {
      console.log(`#${c.name}: skipped (${(e as Error).message})`);
    }
  }
}
console.log(JSON.stringify(total));
Deno.exit(total.failed ? 1 : 0);
