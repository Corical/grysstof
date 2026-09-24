/**
 * Give Discord thoughts captured before 25 Sep 2026 the metadata the writer now records:
 * channel and thread (read from the line's own header) and, for replies, in_reply_to
 * (looked up on Discord, because the parent's id is not in the text).
 *
 *   deno run -A --env-file=.env.xactco --env-file=.env.discord entry/discord-backfill.ts [--apply] [--no-replies]
 *
 * Dry run unless --apply. Composition, tenant and actor come from the environment and the
 * gate exactly as serve.ts does. Writes go through Memory.remember with the thought's own
 * content, which merges into the existing row: no model call, no embedding, no new row.
 * Before each write the script checks known(content) is that same id, and it stops if a
 * write ever reports a new row. Idempotent: a second run finds nothing to do.
 * Exits 1 if any write failed, 2 on a usage or configuration error.
 */
import { compose } from "../compose.ts";
import { EnvSettings } from "../adapters/settings.ts";
import { ConsoleLog } from "../adapters/log.ts";
import type { Scope, Thought } from "../core/ports/mod.ts";
import { assertExplicitMemory } from "../seed/markdown.ts";
import { backfillPatch, coordinates } from "../writer/discord-backfill.ts";

const apply = Deno.args.includes("--apply");
const replies = !Deno.args.includes("--no-replies");
const API = "https://discord.com/api/v10";

function fail(msg: string): never {
  console.error(msg);
  Deno.exit(2);
}

const settings = new EnvSettings();
try {
  assertExplicitMemory(settings);
} catch (e) {
  fail((e as Error).message);
}
const { ports } = await compose(settings, new ConsoleLog());
const decision = await ports.gate.authorise(
  new Request("http://backfill.local/mcp", { headers: { "x-brain-key": settings.require("MCP_ACCESS_KEY"), "x-brain-actor": "backfill:discord" } }),
);
if (!decision.allowed) fail("The gate refused the backfill; check MCP_ACCESS_KEY");
const scope: Scope = { tenant: decision.tenant, actor: decision.actor };
const token = Deno.env.get("DISCORD_TOKEN") ?? Deno.env.get("DISCORD_BOT_TOKEN");
if (replies && !token) fail("DISCORD_TOKEN is needed to look up what replies answer; pass --no-replies to skip them");
console.log(`tenant=${scope.tenant} memory=${settings.get("OB_MEMORY")} mode=${apply ? "APPLY" : "dry run"} replies=${replies}`);

/**
 * One Discord REST read, waiting out rate limits. null when the bot cannot see it (403/404).
 * A 5xx or a network timeout is Discord's hiccup, not ours: retried with backoff, then thrown
 * for the caller to count against this one row (it never stops the run).
 */
async function discord<T>(path: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (res.status === 429) {
      const body = await res.json().catch(() => ({})) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (res.status === 403 || res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status >= 500 && attempt < 4) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`discord ${path} -> ${res.status}`);
    return await res.json() as T;
  }
}

const all: Thought[] = await ports.memory.recent(scope, { limit: 10_000_000, sourcePrefix: "discord:", order: "oldest" });
const counts = { discord: all.length, needChannel: 0, needReply: 0, linked: 0, replyUnreadable: 0, notAReply: 0, replyLookupFailed: 0, written: 0, failed: 0, skippedMismatch: 0 };
const samples: string[] = [];

for (const t of all) {
  const patch = backfillPatch(t);
  if (!patch) continue;
  const set: Record<string, string> = { ...patch.set };
  if (set.channel) counts.needChannel++;
  if (patch.lookupReply) {
    counts.needReply++;
    const at = coordinates(String(t.metadata.source));
    if (replies && at) {
      try {
        const msg = await discord<{ type: number; message_reference?: { message_id?: string; channel_id?: string; guild_id?: string } }>(`/channels/${at.channel}/messages/${at.message}`);
        const ref = msg?.message_reference;
        if (!msg) counts.replyUnreadable++;
        else if (msg.type !== 19 || !ref?.message_id) counts.notAReply++;
        else {
          set.in_reply_to = `discord:${ref.guild_id ?? at.guild}/${ref.channel_id ?? at.channel}/${ref.message_id}`;
          counts.linked++;
        }
      } catch (e) {
        // The channel label still lands; this reply stays unlinked and a re-run picks it up.
        counts.replyLookupFailed++;
        console.error(`LOOKUP FAILED ${t.id}: ${(e as Error).message}`);
      }
    }
  }
  if (!Object.keys(set).length) continue;
  if (samples.length < 8) samples.push(`${t.id} ${JSON.stringify(set)} :: ${t.content.slice(0, 90)}`);
  if (!apply) continue;
  try {
    const same = await ports.memory.known(scope, t.content);
    if (same !== t.id) {
      counts.skippedMismatch++;
      console.error(`SKIP ${t.id}: its content resolves to ${same ?? "nothing"}, not to itself`);
      continue;
    }
    const r = await ports.memory.remember(scope, t.content, set);
    if (!r.alreadyKnown || r.id !== t.id) {
      console.error(`STOP: writing ${t.id} created or hit ${r.id} (alreadyKnown=${r.alreadyKnown}); nothing further is written`);
      Deno.exit(1);
    }
    counts.written++;
    if (counts.written % 250 === 0) console.log(`progress written=${counts.written}`);
  } catch (e) {
    counts.failed++;
    console.error(`FAILED ${t.id}: ${(e as Error).message}`);
  }
}

for (const s of samples) console.log(`  e.g. ${s}`);
console.log(JSON.stringify(counts));
Deno.exit(counts.failed ? 1 : 0);
