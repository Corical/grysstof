/**
 * The capture bot's behaviour, gateway event by gateway event, as functions over injected I/O: the
 * capture queue, the guild allowlist, backfill after downtime, reactions, the hand-off to the loops
 * assistant, and its command registration. entry/discord-capture.ts keeps the socket, the
 * environment and the real I/O; everything that decides something is here, so tests drive it with
 * a fake gateway and fake timers (plan 5, v3.1 addendum, rows 11, 12 and 23).
 *
 * Rules this file keeps:
 *  - The capture queue is one promise chain that no message can break: every step catches its own
 *    failure and logs one line.
 *  - An interaction never waits behind the queue and the queue never waits on an interaction.
 *  - With DISCORD_CAPTURE_GUILDS set, backfill starts only once every guild READY named has sent
 *    GUILD_CREATE (or after 30 s), and a channel whose guild cannot be found is held and retried,
 *    never skipped: while it is held, its live messages are left to its backfill, so its watermark
 *    cannot move past what was said while the bot was down.
 */
import { advance, type Capture, type DiscordMessage, distil, type Names, type Watermarks } from "./discord.ts";
import { type ReactionIo, syncChannelReactions, syncMessageReactions } from "./discord-reactions.ts";
import { guildAllowed, type Interaction, makeGuildFilter, onInteraction, type PaConfig, type PaIo, registerCommands } from "./discord-pa.ts";

/** How long backfill waits for the guild list when an allowlist is set. */
export const GUILD_WAIT_MS = 30_000;
/** First wait before a held channel or a failed registration is tried again; it doubles each time. */
export const RETRY_BASE_MS = 30_000;
/** The longest wait between tries. */
export const RETRY_MAX_MS = 3_600_000;
const THREAD_TYPES = new Set([10, 11, 12]);
const BACKFILL_PAGE = 100;

/** The wait before try number `attempt + 1`: 30 s, 1 min, 2 min, … never more than an hour. */
export function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 30)));
}

/** A Discord snowflake for an instant: everything after it was posted after that instant. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}

export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

export type BotIo = {
  /** The capture bot's own Discord REST GET, parsed; throws on failure. */
  rest: <T>(path: string) => Promise<T>;
  /** capture_thought for one message; returns the tool's text, throws when the write failed. */
  post: (c: Capture) => Promise<string>;
  postReactions: ReactionIo["post"];
  saveMarks: (marks: Watermarks) => Promise<void>;
  log: (fields: Record<string, unknown>) => unknown;
  timers: Timers;
  /** Epoch milliseconds. */
  now: () => number;
};

export type BotConfig = {
  captureGuilds?: ReadonlySet<string>;
  /** DISCORD_BACKFILL_SINCE: seed every unwatermarked text channel to this date. */
  backfillSince?: string;
  pa: PaConfig;
  paIo: PaIo;
  guildWaitMs?: number;
  reactionSettleMs?: number;
  reactionCatchupDays?: number;
};

export type Bot = {
  /** Handle one gateway dispatch. Never rejects, and never waits on the loops assistant. */
  dispatch(t: string, d: unknown): Promise<void>;
  /** Resolves once backfill, catch-up, held-channel retries in flight and the queue are all done (tests). */
  settled(): Promise<void>;
  marks(): Watermarks;
  /** Channels held because their guild could not be found or their backfill failed. */
  deferred(): string[];
};

type RestChannel = { id: string; name?: string; type: number; parent_id?: string | null; guild_id?: string };
/** `partial`: only the guild is known (from a live message); the name is still to be looked up. */
type Chan = { name: string; type: number; parent?: string; guild?: string; partial?: boolean };

export function createBot(io: BotIo, cfg: BotConfig, initialMarks: Watermarks): Bot {
  const allow = cfg.captureGuilds;
  const guildWait = cfg.guildWaitMs ?? GUILD_WAIT_MS;
  const settleMs = cfg.reactionSettleMs ?? 3000;
  const catchupDays = cfg.reactionCatchupDays ?? 7;
  let marks: Watermarks = { ...initialMarks };
  const guilds = new Map<string, string>();
  const channels = new Map<string, Chan>();
  const work = new Set<Promise<unknown>>();
  let chain: Promise<void> = Promise.resolve();

  const say = async (fields: Record<string, unknown>) => {
    try {
      await io.log(fields);
    } catch { /* the log is a courtesy */ }
  };
  /** Background work that must never reject unseen and that settled() waits for. */
  const track = (p: Promise<unknown>) => {
    const q: Promise<unknown> = p.catch((e) => say({ event: "dispatch.failed", error: String(e) })).finally(() => work.delete(q));
    work.add(q);
    return q;
  };
  const captureGuild = makeGuildFilter(allow, (guild) => void say({ event: "capture.guild_skipped", guild, hint: "not in DISCORD_CAPTURE_GUILDS" }));

  // --- names ---
  function remember(c: RestChannel, guild?: string) {
    channels.set(c.id, { name: c.name ?? c.id, type: c.type, parent: c.parent_id ?? undefined, guild: guild ?? c.guild_id ?? channels.get(c.id)?.guild });
  }
  function noteGuild(channelId: string, guild: string) {
    const c = channels.get(channelId);
    channels.set(channelId, c ? { ...c, guild } : { name: channelId, type: 0, guild, partial: true });
  }
  async function lookup(channelId: string) {
    try {
      remember(await io.rest<RestChannel>(`/channels/${channelId}`));
    } catch (e) {
      await say({ event: "channel.lookup_failed", channel: channelId, error: String(e) });
    }
  }
  async function namesFor(m: DiscordMessage): Promise<Names> {
    let c = channels.get(m.channel_id);
    if (!c || c.partial) {
      await lookup(m.channel_id);
      c = channels.get(m.channel_id) ?? { name: m.channel_id, type: 0 };
    }
    const parent = THREAD_TYPES.has(c.type) && c.parent ? channels.get(c.parent)?.name : undefined;
    const parentId = THREAD_TYPES.has(c.type) ? c.parent : undefined; // a plain channel's parent is its category, not a conversation
    return { guild: m.guild_id ? guilds.get(m.guild_id) : undefined, channel: c.name, parent, parentId, channelNames: (id) => channels.get(id)?.name };
  }
  /** REST message objects carry no guild_id; the channel cache does, so every proof link can name the guild. */
  const withGuild = (m: DiscordMessage): DiscordMessage => (m.guild_id ? m : { ...m, guild_id: channels.get(m.channel_id)?.guild });
  /** The guild a channel belongs to: the cache, else (only when the allowlist needs to know) one REST lookup. */
  async function guildOf(channelId: string): Promise<string | undefined> {
    if (allow && !channels.get(channelId)?.guild) await lookup(channelId);
    return channels.get(channelId)?.guild;
  }

  // --- the capture queue ---
  function enqueue(raw: DiscordMessage, via: "gateway" | "backfill") {
    chain = chain.then(async () => {
      try {
        const known = raw.guild_id ?? channels.get(raw.channel_id)?.guild;
        if (known !== undefined && !captureGuild(known)) return;
        const names = await namesFor(raw);
        const m = withGuild(raw);
        if (!captureGuild(m.guild_id)) return;
        const d = distil(m, names);
        if ("skip" in d) {
          await say({ event: "message.skipped", via, id: m.id, channel: m.channel_id, reason: d.skip });
          return;
        }
        const answer = await io.post(d);
        marks = advance(marks, m.channel_id, m.id);
        await io.saveMarks(marks);
        await say({ event: "message.captured", via, id: m.id, channel: m.channel_id, actor: d.actor, answer });
      } catch (e) {
        await say({ event: "message.failed", via, id: raw?.id, channel: raw?.channel_id, error: String(e) });
      }
    });
  }

  // --- backfill, and channels held until it can run ---
  const held = new Map<string, { attempt: number; timer: unknown }>();

  function hold(channelId: string, why: Record<string, unknown>) {
    const before = held.get(channelId);
    if (before) io.timers.clear(before.timer);
    const attempt = before ? before.attempt + 1 : 0;
    const wait = backoffMs(attempt);
    held.set(channelId, { attempt, timer: io.timers.set(() => void track(release(channelId)), wait) });
    void say({ ...why, channel: channelId, attempt: attempt + 1, retryInMs: wait, hint: "held: its live messages wait for its backfill" });
  }

  async function release(channelId: string) {
    const h = held.get(channelId);
    if (!h) return;
    io.timers.clear(h.timer);
    held.delete(channelId);
    await backfillChannel(channelId);
    if (!held.has(channelId)) await say({ event: "backfill.released", channel: channelId });
    await chain;
  }

  /** Fetch one channel's messages after its watermark into the queue; hold it when that cannot be done safely. */
  async function backfillChannel(channelId: string): Promise<void> {
    if (allow) {
      const guild = await guildOf(channelId);
      if (guild === undefined) return hold(channelId, { event: "backfill.guild_unknown" });
      if (!captureGuild(guild)) return;
    }
    let cursor = marks[channelId];
    if (!cursor) return;
    for (;;) {
      let page: DiscordMessage[];
      try {
        page = await io.rest<DiscordMessage[]>(`/channels/${channelId}/messages?after=${cursor}&limit=${BACKFILL_PAGE}`);
      } catch (e) {
        // What is already queued is captured; the rest is fetched from the new watermark on release.
        return hold(channelId, { event: "backfill.failed", error: String(e) });
      }
      if (!page?.length) return;
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const m of page) enqueue(m, "backfill");
      cursor = page[page.length - 1].id;
      if (page.length < BACKFILL_PAGE) return;
    }
  }

  let generation = 0;
  async function backfill(gen: number) {
    if (cfg.backfillSince) {
      try {
        const seed = snowflakeAt(Date.parse(cfg.backfillSince));
        let seeded = 0;
        for (const g of await io.rest<{ id: string }[]>("/users/@me/guilds")) {
          if (!captureGuild(g.id)) continue;
          for (const c of await io.rest<RestChannel[]>(`/guilds/${g.id}/channels`)) {
            remember(c, g.id);
            if (c.type !== 0 || marks[c.id]) continue;
            marks[c.id] = seed;
            seeded++;
          }
        }
        await io.saveMarks(marks);
        await say({ event: "backfill.seeded", since: cfg.backfillSince, channels: seeded });
      } catch (e) {
        await say({ event: "backfill.seed_failed", error: String(e) });
      }
    }
    for (const channelId of Object.keys(marks)) {
      if (gen !== generation) return; // a newer READY runs its own backfill
      if (held.has(channelId)) continue; // its own timer brings it back
      await backfillChannel(channelId);
    }
    await chain;
  }

  // --- reactions ---
  const reactionIo: ReactionIo = { rest: io.rest, post: io.postReactions };
  const settling = new Map<string, unknown>();
  function reactionChanged(d: { guild_id?: string; channel_id: string; message_id: string }) {
    const k = `${d.channel_id}/${d.message_id}`;
    if (settling.has(k)) io.timers.clear(settling.get(k));
    settling.set(k, io.timers.set(() => {
      settling.delete(k);
      chain = chain.then(async () => {
        try {
          const outcome = await syncMessageReactions(reactionIo, d.guild_id ?? "@me", d.channel_id, d.message_id);
          await say({ event: "reactions.synced", channel: d.channel_id, message: d.message_id, outcome });
        } catch (e) {
          await say({ event: "reactions.failed", channel: d.channel_id, message: d.message_id, error: String(e) });
        }
      });
    }, settleMs));
  }
  async function reactionCatchUp() {
    const since = snowflakeAt(io.now() - catchupDays * 86_400_000);
    for (const channelId of Object.keys(marks)) {
      if (held.has(channelId)) continue;
      const owner = await guildOf(channelId);
      if (!captureGuild(owner)) continue;
      try {
        const done = await syncChannelReactions(reactionIo, owner ?? "@me", channelId, since);
        if (done.withReactions) await say({ event: "reactions.caught_up", channel: channelId, ...done });
      } catch (e) {
        await say({ event: "reactions.catchup_failed", channel: channelId, error: String(e) });
      }
    }
  }

  // --- READY: wait for the guild list (allowlist only), then backfill and catch up ---
  let waiting = new Set<string>();
  let waitTimer: unknown;
  function startBackfill(gen: number) {
    void track(backfill(gen).then(() => (gen === generation ? reactionCatchUp() : undefined)));
  }

  // --- command registration, retried with backoff until it takes ---
  let registration: "idle" | "running" | "waiting" | "done" = "idle";
  let regAttempt = 0;
  let regApp = "";
  let regGuilds: string[] = [];
  function startRegistration() {
    if (!cfg.pa.enabled || registration !== "idle") return;
    registration = "running";
    void track((async () => {
      const ok = await registerCommands(cfg.paIo, regApp, regGuilds);
      if (ok) {
        registration = "done";
        return;
      }
      const wait = backoffMs(regAttempt++);
      registration = "waiting";
      await say({ event: "pa.register_retry", inMs: wait, attempt: regAttempt });
      io.timers.set(() => {
        registration = "idle";
        startRegistration();
      }, wait);
    })());
  }

  async function handle(t: string, d: unknown) {
    switch (t) {
      case "READY": {
        const r = d as { guilds?: { id: string }[]; application?: { id?: string } };
        const ids = (r.guilds ?? []).map((g) => g?.id).filter((id): id is string => typeof id === "string");
        regApp = r.application?.id ?? "";
        regGuilds = ids.filter((id) => guildAllowed(allow, id));
        startRegistration();
        const gen = ++generation;
        if (waitTimer !== undefined) io.timers.clear(waitTimer);
        waitTimer = undefined;
        waiting = new Set(allow ? ids : []);
        if (!waiting.size) return startBackfill(gen);
        await say({ event: "backfill.waiting_for_guilds", guilds: waiting.size, waitMs: guildWait });
        waitTimer = io.timers.set(() => {
          waitTimer = undefined;
          void say({ event: "backfill.guild_wait_timeout", missing: [...waiting], waitedMs: guildWait });
          waiting.clear();
          startBackfill(gen);
        }, guildWait);
        return;
      }
      case "GUILD_CREATE": {
        const g = d as { id: string; name: string; channels?: RestChannel[]; threads?: RestChannel[] };
        guilds.set(g.id, g.name);
        for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) remember(c, g.id);
        await say({ event: "guild.seen", guild: g.name, channels: g.channels?.length ?? 0, threads: g.threads?.length ?? 0 });
        if (waiting.delete(g.id) && !waiting.size && waitTimer !== undefined) {
          io.timers.clear(waitTimer);
          waitTimer = undefined;
          startBackfill(generation);
        }
        return;
      }
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        return remember(d as RestChannel);
      case "MESSAGE_CREATE": {
        const m = d as DiscordMessage;
        if (held.has(m.channel_id)) {
          // Not captured on its own: the channel's backfill, run now, fetches it after the gap.
          if (m.guild_id) noteGuild(m.channel_id, m.guild_id);
          void track(release(m.channel_id));
          return;
        }
        return enqueue(m, "gateway");
      }
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE":
      case "MESSAGE_REACTION_REMOVE_ALL":
      case "MESSAGE_REACTION_REMOVE_EMOJI": {
        const r = d as { guild_id?: string; channel_id: string; message_id: string };
        if (captureGuild(r.guild_id)) reactionChanged(r);
        return;
      }
      case "INTERACTION_CREATE":
        // Not awaited and never rejecting: a command must not wait behind a capture, and nothing the
        // PA does can throw out of here and end the process.
        onInteraction(cfg.pa, cfg.paIo, d as Interaction).catch(() => {});
        return;
    }
  }

  return {
    async dispatch(t, d) {
      try {
        await handle(t, d);
      } catch (e) {
        await say({ event: "dispatch.failed", type: t, error: String(e) });
      }
    },
    async settled() {
      for (let i = 0; i < 1000; i++) {
        await Promise.all([...work]);
        const c = chain;
        await c;
        if (!work.size && c === chain) return;
      }
    },
    marks: () => ({ ...marks }),
    deferred: () => [...held.keys()],
  };
}
