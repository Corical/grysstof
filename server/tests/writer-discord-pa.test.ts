import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ageText,
  CLOSED_VIEW_DAYS,
  COMMANDS,
  type Interaction,
  KEY_RE,
  type Loop,
  makeGuildFilter,
  onInteraction,
  openLine,
  PAGE_SIZE,
  paConfig,
  type PaIo,
  PARK_DAYS,
  parkedLine,
  parseIdList,
  registerCommands,
  resolvedLine,
} from "../writer/discord-pa.ts";
import { browseHistory, browseLoops, discordClient, HttpError, mcpCapture, mcpText, mcpTool, send, TimeoutError } from "../writer/discord-rest.ts";
import { type LoopLine, loopQuery, type LoopView, type OpenLine, parse, sanitise, selectLoops } from "../core/loops.ts";

// ---------- fixtures ----------

const NOW = new Date("2026-10-26T20:00:00.000Z");
const APP = "1551511604439285821";
const GUILD = "268128051500417024";
const CHANNEL = "1418000000000000001";
const KELLI = { id: "555000000000000001", username: "kellireynolds", global_name: "Kelli" };
const STRANGER = { id: "555000000000000009", username: "lurker" };
const cfg = paConfig("true", `${KELLI.id}, 555000000000000002`);
/** An interaction token is a credential for 15 minutes: it must never reach a log line or an error message. */
const TOKEN = "aW50ZXJhY3Rpb246MTUwMDAwMDAwMDAwMDAwMDAwMTpzZWNyZXQtdG9rZW4tdGhhdC1tdXN0LW5ldmVyLWJlLWxvZ2dlZA";

const keyOf = (i: number) => String(1430000000000000000n + BigInt(i));
function loop(i: number, over: Partial<Loop> = {}): Loop {
  const key = over.key ?? keyOf(i);
  return {
    key,
    subject: `loop:${key}`,
    lineId: `fact_${String(i).padStart(6, "0")}_aaaaaaaa`,
    state: "open",
    client: "servest",
    type: "unanswered_question",
    owner: "Kelli",
    channel: "servest",
    channelId: CHANNEL,
    opened: new Date(Date.parse("2026-10-01T08:00:00.000Z") + i * 3_600_000).toISOString(),
    reopened: null,
    title: `Loop ${i}`,
    summary: `Summary ${i}`,
    evidence: [key.split(":")[0]],
    proof: `https://discord.com/channels/${GUILD}/${CHANNEL}/${key.split(":")[0]}`,
    closed: null,
    byMessage: null,
    byUser: null,
    byName: null,
    until: null,
    note: null,
    fork: false,
    learnedAt: "2026-10-26T05:30:00.000Z",
    ...over,
  };
}

let ixSeq = 0;
/** `guild: null` is a DM (a default parameter would turn an explicit undefined back into GUILD). */
function ix(type: number, data: Interaction["data"], user: { id: string; username: string } | null = KELLI, message?: Interaction["message"], guild: string | null = GUILD): Interaction {
  ixSeq++;
  return {
    id: String(1500000000000000000n + BigInt(ixSeq)),
    application_id: APP,
    type,
    token: TOKEN,
    ...(guild ? { guild_id: guild } : {}),
    channel_id: CHANNEL,
    ...(user ? { member: { user } } : {}),
    data,
    ...(message ? { message } : {}),
  };
}
const command = (name: string, options: { name: string; type: number; value: string }[] = [], user: { id: string; username: string } | null = KELLI, guild: string | null = GUILD) =>
  ix(2, { name, options }, user, undefined, guild);

type Btn = { type: number; style: number; label: string; custom_id: string; disabled?: boolean };
type Msg = { content: string; components: { type: number; components: Btn[] }[]; flags?: number; allowed_mentions?: unknown };
const buttons = (m: Msg) => m.components.flatMap((r) => r.components);
function button(m: Msg, label: string): Btn {
  const b = buttons(m).find((x) => x.label === label);
  assert(b, `no button "${label}" among ${buttons(m).map((x) => x.label).join(", ")}`);
  return b;
}
const actionLabels = (m: Msg) => buttons(m).map((b) => b.label).filter((l) => l !== "Prev" && l !== "Next");
/** The loops a page shows, read from what a person sees: the "n. Loop i" lines. */
const titles = (m: Msg) => [...m.content.matchAll(/^\d+\. Loop (\d+)\b/gm)].map((x) => Number(x[1]));
const pressOn = (m: Msg, label: string, user: { id: string; username: string } = KELLI, guild: string | null = GUILD) =>
  ix(3, { custom_id: button(m, label).custom_id, component_type: 2 }, user, m, guild);

/**
 * A fake /browse/api/loops that selects with core/loops.ts's own query and selection (state, the
 * 30-day window for finished loops, `since`, `client`, the 200 default and 2,000 cap on `limit`),
 * plus the `key` filter of the v3.1 addendum. It answers newest first, so the bot must sort itself.
 */
function route(all: Loop[], q: Record<string, string>) {
  const pool = q.key !== undefined ? all.filter((l) => l.key === q.key) : all;
  const query = loopQuery({ state: q.state, since: q.since, client: q.client, limit: Math.min(2000, q.limit === undefined ? 200 : Number(q.limit)) });
  const { loops, total } = selectLoops(pool as LoopView[], query, NOW);
  return { loops: [...loops].reverse(), unreadable: [], warnings: { understandFailed: 0 }, total };
}

/**
 * A fake ledger behind /mcp: reads every line with core/loops.ts's parser (so a line the route could
 * not read fails the test that wrote it), refuses a `supersedes` that is not the loop's current
 * line as the real one does, and moves the loop the way readLoop would show it.
 */
function ledger(data: Loop[]) {
  let n = 0;
  return (args: Record<string, unknown>) => {
    const read = parse(String(args.content));
    if (!read.ok) return { text: `Failed to capture: test ledger cannot read the line (${read.reason})`, isError: true };
    const key = String(args.subject).slice("loop:".length);
    if (read.line.key !== key) return { text: `Failed to capture: line is for key ${read.line.key}, subject is ${args.subject}`, isError: true };
    const i = data.findIndex((l) => l.key === key);
    if (i < 0) return { text: `Failed to capture: No fact ${args.supersedes}`, isError: true };
    if (data[i].lineId !== args.supersedes) return { text: `Failed to capture: Fact ${args.supersedes} is already superseded by ${data[i].lineId}`, isError: true };
    const line = read.line;
    const id = `fact_9${String(++n).padStart(5, "0")}_cccccccc`;
    const patch: Partial<Loop> = { state: line.tag.toLowerCase() as Loop["state"], lineId: id, learnedAt: NOW.toISOString(), fork: false };
    if (line.tag === "RESOLVED") Object.assign(patch, { closed: line.resolved, byUser: line.byUser, byName: line.byName, note: line.note, until: null });
    if (line.tag === "PARKED") Object.assign(patch, { until: line.until, byUser: line.byUser, byName: line.byName, note: line.note, closed: null });
    if (line.tag === "OPEN") Object.assign(patch, { reopened: line.reopened, title: line.title, evidence: line.evidence, closed: null, byUser: null, byName: null, until: null, note: null });
    data[i] = { ...data[i], ...patch };
    return { text: `Recorded fact ${id} about ${args.subject} (from ${args.source}, by discord:kellireynolds, unconfirmed)`, isError: false };
  };
}

type Answer = { text: string; isError: boolean };
type Call =
  | { kind: "discord"; method: string; path: string; body: unknown }
  | { kind: "loops"; query: Record<string, string> }
  | { kind: "capture"; actor: string; args: Record<string, unknown> }
  | { kind: "history"; subject: string }
  | { kind: "supersede"; actor: string; newer: string; older: string };
type DiscordCall = Extract<Call, { kind: "discord" }>;

function harness(opts: {
  data?: Loop[];
  loops?: (q: Record<string, string>) => unknown;
  capture?: (args: Record<string, unknown>, n: number) => Answer;
  discord?: (method: string, path: string, body: unknown) => unknown;
  history?: (subject: string) => unknown;
  supersede?: (newer: string, older: string) => Answer;
} = {}) {
  const data = opts.data ?? [];
  const calls: Call[] = [];
  const logs: Record<string, unknown>[] = [];
  const led = ledger(data);
  let writes = 0;
  const io: PaIo = {
    discord: async (method, path, body) => {
      calls.push({ kind: "discord", method, path, body });
      return await opts.discord?.(method, path, body);
    },
    loops: async (query) => {
      calls.push({ kind: "loops", query });
      return opts.loops ? await opts.loops(query) : route(data, query);
    },
    capture: async (actor, args) => {
      calls.push({ kind: "capture", actor, args });
      writes++;
      return opts.capture ? opts.capture(args, writes) : led(args);
    },
    history: async (subject) => {
      calls.push({ kind: "history", subject });
      return opts.history ? opts.history(subject) : { facts: [] };
    },
    supersede: async (actor, newer, older) => {
      calls.push({ kind: "supersede", actor, newer, older });
      return opts.supersede ? opts.supersede(newer, older) : { text: `Fact ${newer} now supersedes ${older}`, isError: false };
    },
    log: (f) => {
      logs.push(f);
    },
    now: () => NOW,
  };
  const discordCalls = () => calls.filter((c): c is DiscordCall => c.kind === "discord");
  return {
    io,
    data,
    calls,
    logs,
    led,
    edits: () => discordCalls().filter((c) => c.method === "PATCH"),
    lastEdit: () => discordCalls().filter((c) => c.method === "PATCH").at(-1)!.body as Msg,
    callbackFor: (i: Interaction) => discordCalls().find((c) => c.path === `/interactions/${i.id}/${TOKEN}/callback`)?.body as { type: number; data?: Record<string, unknown> } | undefined,
    captures: () => calls.filter((c): c is Extract<Call, { kind: "capture" }> => c.kind === "capture"),
    reads: () => calls.filter((c): c is Extract<Call, { kind: "loops" }> => c.kind === "loops"),
    events: () => logs.map((l) => l.event),
  };
}

async function listed(data: Loop[], options: { name: string; type: number; value: string }[] = []) {
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops", options));
  return { h, msg: h.lastEdit() };
}

async function walkToEnd(h: ReturnType<typeof harness>, first: Msg): Promise<{ msg: Msg; seen: number[] }> {
  let msg = first;
  const seen = [...titles(msg)];
  for (let guard = 0; !button(msg, "Next").disabled; guard++) {
    assert(guard < 100, "Next never ran out");
    await onInteraction(cfg, h.io, pressOn(msg, "Next"));
    msg = h.lastEdit();
    seen.push(...titles(msg));
  }
  return { msg, seen };
}

// ---------- configuration and the guild allowlist ----------

Deno.test("config: the PA is off unless PA_ENABLED says so; lists tolerate spaces, blanks and repeats; no users listed means nobody, not everybody", () => {
  for (const v of [undefined, "", " ", "false", "0", "no", "off", "TRUEISH"]) assertEquals(paConfig(v, KELLI.id).enabled, false, `PA_ENABLED=${v}`);
  for (const v of ["true", "TRUE", " 1 ", "yes", "on"]) assertEquals(paConfig(v, KELLI.id).enabled, true, `PA_ENABLED=${v}`);
  assertEquals([...paConfig("true", " 1 , ,2,1,, ").users].sort(), ["1", "2"]);
  assertEquals(paConfig("true", undefined).users.size, 0);
  assertEquals(paConfig("true", " , ").users.size, 0);
  assertEquals(paConfig("true", "1").guilds, undefined, "no guild list: every guild, as the capture does");
  assertEquals([...paConfig("true", "1", parseIdList(GUILD)).guilds!], [GUILD]);
  assertEquals(parseIdList(undefined), undefined);
  assertEquals(parseIdList("   "), undefined, "set but blank is treated as unset (all guilds, as today), never as 'no guild at all'");
  assertEquals(parseIdList(" , ,"), undefined);
  assertEquals([...parseIdList(`${GUILD}, 99 ,${GUILD}`)!], [GUILD, "99"]);
});

Deno.test("guild allowlist: unset lets everything through silently; set skips other guilds, DMs and unknown guilds, one log line per guild", () => {
  const skipped: string[] = [];
  const all = makeGuildFilter(undefined, (g) => skipped.push(g));
  assert(all("1") && all(undefined) && all("@me"));
  assertEquals(skipped, []);
  const only = makeGuildFilter(parseIdList(GUILD), (g) => skipped.push(g));
  assert(only(GUILD));
  assertEquals([only("777"), only("777"), only("888"), only(undefined), only("@me"), only("777")], [false, false, false, false, false, false]);
  assertEquals(skipped, ["777", "888", "unknown", "@me"], "once per guild, not once per message");
  assert(only(GUILD), "the allowed guild still passes after skips");
});

// ---------- authorisation: before any read or write ----------

Deno.test("an unlisted user gets an ephemeral 'not permitted' and causes zero reads and zero writes: a command, a button copied from Kelli's list, an autocomplete, no user at all", async () => {
  const { msg } = await listed([loop(1)]);
  const h = harness({ data: [loop(1)] });
  const tries = [
    command("loops", [], STRANGER),
    pressOn(msg, "Resolve 1", STRANGER),
    ix(4, { name: "loops", options: [{ name: "client", type: 3, value: "se", focused: true }] }, STRANGER),
    command("loops", [], null),
  ];
  for (const t of tries) await onInteraction(cfg, h.io, t);
  assertEquals(h.calls.filter((c) => c.kind !== "discord"), [], "no /loops read and no /mcp write for anyone not listed");
  assertEquals(h.calls.length, 4, "exactly one Discord call each: the refusal itself");
  assertEquals(tries.map((t) => h.callbackFor(t)?.type), [4, 4, 8, 4]);
  for (const t of [tries[0], tries[1], tries[3]]) {
    const data = h.callbackFor(t)!.data!;
    assertEquals(data.flags, 64, "only the presser sees the refusal");
    assertMatch(String(data.content), /not permitted/);
    assertEquals(data.allowed_mentions, { parse: [] });
  }
  assertEquals(h.callbackFor(tries[2])!.data, { choices: [] });
  assertEquals(h.events(), ["pa.refused", "pa.refused", "pa.refused", "pa.refused"]);
});

Deno.test("an interaction from a guild outside DISCORD_CAPTURE_GUILDS, or from a DM, is refused 'not available' with zero reads, even for a listed user; inside the list, or with no list, it is served", async () => {
  const scoped = paConfig("true", KELLI.id, parseIdList(GUILD));
  const { msg } = await listed([loop(1)]);
  const h = harness({ data: [loop(1)] });
  const outside = [
    command("loops", [], KELLI, "777000000000000007"),
    command("loops", [], KELLI, null),
    pressOn(msg, "Resolve 1", KELLI, "777000000000000007"),
    ix(4, { name: "loops", options: [] }, KELLI, undefined, "777000000000000007"),
  ];
  for (const o of outside) await onInteraction(scoped, h.io, o);
  assertEquals(h.calls.filter((c) => c.kind !== "discord"), []);
  assertEquals(outside.map((o) => h.callbackFor(o)?.type), [4, 4, 4, 8]);
  for (const o of outside.slice(0, 3)) {
    assertEquals(h.callbackFor(o)!.data!.flags, 64);
    assertMatch(String(h.callbackFor(o)!.data!.content), /not available/);
  }
  assertEquals(h.logs.map((l) => [l.event, l.reason]), Array(4).fill(["pa.refused", "guild not allowed"]));

  const inside = harness({ data: [loop(1)] });
  await onInteraction(scoped, inside.io, command("loops"));
  assertEquals(titles(inside.lastEdit()), [1]);
  const unscoped = harness({ data: [loop(1)] });
  await onInteraction(cfg, unscoped.io, command("loops", [], KELLI, "777000000000000007"));
  assertEquals(titles(unscoped.lastEdit()), [1], "no list: any guild, as before");
});

Deno.test("PA_ENABLED off: a listed user's command and a stale button cause no reads or writes and get 'not available'", async () => {
  const { msg } = await listed([loop(1)]);
  const off = paConfig(undefined, KELLI.id);
  const h = harness({ data: [loop(1)] });
  const cmd = command("loops");
  const press = pressOn(msg, "Resolve 1");
  await onInteraction(off, h.io, cmd);
  await onInteraction(off, h.io, press);
  assertEquals(h.calls.filter((c) => c.kind !== "discord"), []);
  assertEquals(h.callbackFor(cmd)?.type, 4);
  assertMatch(String(h.callbackFor(cmd)!.data!.content), /not available/);
  assertEquals(h.callbackFor(press)?.type, 6, "a press is acknowledged silently");
  assertEquals(h.edits().length, 0);
});

// ---------- acknowledgement ----------

Deno.test("acknowledgement by kind: commands defer ephemerally (5, flags 64), buttons defer an update (6); unknown component 6, unknown command 4, autocomplete 8 with no choices, modal 4, an unheard-of type no answer; every unknown is logged", async () => {
  const h = harness({ data: [loop(1), loop(2)] });
  const loops = command("loops");
  await onInteraction(cfg, h.io, loops);
  const list = h.lastEdit();
  const help = command("loops-help");
  await onInteraction(cfg, h.io, help);
  assertMatch(h.lastEdit().content, /Resolve/);
  assertMatch(h.lastEdit().content, /Park/);
  const press = pressOn(list, "Resolve 2");
  await onInteraction(cfg, h.io, press);
  const odd = [
    ix(3, { custom_id: "someone-elses-button", component_type: 2 }),
    command("done"),
    ix(4, { name: "loops", options: [{ name: "client", type: 3, value: "x", focused: true }] }),
    ix(5, { custom_id: "a-modal" }),
    ix(99, {}),
  ];
  for (const o of odd) await onInteraction(cfg, h.io, o);
  assertEquals([loops, help, press].map((i) => h.callbackFor(i)), [{ type: 5, data: { flags: 64 } }, { type: 5, data: { flags: 64 } }, { type: 6 }]);
  assertEquals(odd.map((i) => h.callbackFor(i)?.type), [6, 4, 8, 4, undefined]);
  assertEquals(h.callbackFor(odd[1])!.data!.flags, 64);
  assertMatch(String(h.callbackFor(odd[1])!.data!.content), /not available/);
  assertEquals(h.callbackFor(odd[2])!.data, { choices: [] });
  assertEquals(h.callbackFor(odd[3])!.data!.flags, 64);
  assertEquals(h.events().filter((e) => e === "pa.interaction_unknown").length, 5);
  assertEquals(h.captures().length, 1, "only the real press wrote anything");
});

Deno.test("the deferred acknowledgement is the first call of every interaction and comes before every /loops read and /mcp write", async () => {
  const data = Array.from({ length: 8 }, (_, i) => loop(i));
  const h = harness({ data });
  const runs: Call[][] = [];
  const run = async (i: Interaction) => {
    const from = h.calls.length;
    await onInteraction(cfg, h.io, i);
    runs.push(h.calls.slice(from));
  };
  await run(command("loops"));
  await run(pressOn(h.lastEdit(), "Next"));
  await run(pressOn(h.lastEdit(), "Park 7"));
  await run(command("loops", [{ name: "state", type: 3, value: "parked" }]));
  await run(pressOn(h.lastEdit(), "Unpark 1"));
  for (const calls of runs) {
    const first = calls[0];
    assert(first.kind === "discord" && first.method === "POST" && first.path.endsWith("/callback"), `first call was ${JSON.stringify(first)}`);
    assert(calls.some((c) => c.kind !== "discord"), "each step read or wrote something after acknowledging");
    assertEquals(calls.slice(1).filter((c) => c.kind === "discord" && c.path.endsWith("/callback")).length, 0, "one acknowledgement only");
  }
});

Deno.test("if the acknowledgement itself fails (Discord says unknown interaction), nothing is read or written, and pa.failed is logged", async () => {
  const { msg } = await listed([loop(1)]);
  const h = harness({
    data: [loop(1)],
    discord: (_m, p) => {
      if (p.endsWith("/callback")) throw new HttpError(404, '{"message":"Unknown interaction","code":10062}', "discord POST /interactions/…/callback");
    },
  });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(msg, "Resolve 1"));
  assertEquals(h.calls.filter((c) => c.kind !== "discord"), []);
  assertEquals(h.edits().length, 0);
  assertEquals(h.events(), ["pa.failed", "pa.failed"]);
  assert(!JSON.stringify(h.logs).includes(TOKEN), "the interaction token never reaches the log");
});

// ---------- the list and its pages ----------

Deno.test("25 open loops page six at a time, oldest first, numbered across pages; walking Next shows every loop exactly once while the job adds loops between presses", async () => {
  const data = Array.from({ length: 25 }, (_, i) => loop(i));
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  const msg = h.lastEdit();
  assertEquals(PAGE_SIZE, 6);
  assertEquals(titles(msg), [0, 1, 2, 3, 4, 5], "the route answered newest first; the bot sorts oldest first itself");
  assertStringIncludes(msg.content, "1–6 of 25");
  assertMatch(msg.content, /^1\. Loop 0 /m);
  assert(button(msg, "Prev").disabled);
  data.push(loop(99, { opened: "2026-10-26T19:00:00.000Z" })); // the job opens a new loop between presses
  data.push(loop(98, { opened: "2026-09-01T00:00:00.000Z" })); // and one older than anything shown so far
  const { msg: last, seen } = await walkToEnd(h, msg);
  assertEquals(seen, [...Array.from({ length: 25 }, (_, i) => i), 99], "no loop repeated, none skipped; the late older one is not slipped in mid-walk");
  assertMatch(last.content, /^\d+\. Loop 99 /m);
});

Deno.test("past 200 open loops the list asks for up to 2,000 and a press re-reads exactly its own loop by key, so the newest loops are listed and pressable", async () => {
  const data = Array.from({ length: 250 }, (_, i) => loop(i));
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  assertEquals(h.reads()[0].query, { state: "open", limit: "2000" });
  assertStringIncludes(h.lastEdit().content, "1–6 of 250", "a route left at its default of 200 would say 200");
  const { msg, seen } = await walkToEnd(h, h.lastEdit());
  assertEquals(seen.length, 250);
  assertEquals(titles(msg).at(-1), 249);
  const before = h.reads().length;
  await onInteraction(cfg, h.io, pressOn(msg, "Resolve 250"));
  assertEquals(h.reads()[before].query, { state: "all", key: keyOf(249), limit: "2000" });
  assertEquals(h.captures().map((c) => c.args.supersedes), ["fact_000249_aaaaaaaa"]);
  assertEquals(h.data[249].state, "resolved");
});

Deno.test("a loop resolved elsewhere between presses neither shifts the next page nor repeats one, and Prev returns exactly the page before", async () => {
  const data = Array.from({ length: 20 }, (_, i) => loop(i));
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  const page1 = h.lastEdit();
  assertEquals(titles(page1), [0, 1, 2, 3, 4, 5]);
  data.splice(data.findIndex((l) => l.title === "Loop 5"), 1); // the very loop the cursor points at
  data.splice(data.findIndex((l) => l.title === "Loop 8"), 1); // and one not shown yet
  await onInteraction(cfg, h.io, pressOn(page1, "Next"));
  const page2 = h.lastEdit();
  assertEquals(titles(page2), [6, 7, 9, 10, 11, 12]);
  await onInteraction(cfg, h.io, pressOn(page2, "Next"));
  const page3 = h.lastEdit();
  assertEquals(titles(page3), [13, 14, 15, 16, 17, 18]);
  await onInteraction(cfg, h.io, pressOn(page3, "Prev"));
  assertEquals(titles(h.lastEdit()), [6, 7, 9, 10, 11, 12]);
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Prev"));
  assertEquals(titles(h.lastEdit()), [0, 1, 2, 3, 4]);
  assert(button(h.lastEdit(), "Prev").disabled);
});

Deno.test("views: open has Resolve and Park, parked has Resolve and Unpark, closed lists closed and resolved loops of the last 14 days with only Reopen; the client filter reaches the route sanitised", async () => {
  const data = [
    loop(1),
    loop(2, { state: "parked", until: "2026-11-02", byUser: KELLI.id, byName: "kellireynolds" }),
    loop(3, { state: "closed", closed: "2026-10-25T10:00:00.000Z", byMessage: "1431000000000000001" }),
    loop(4, { state: "resolved", closed: "2026-10-24T10:00:00.000Z", byUser: KELLI.id, byName: "kellireynolds" }),
    loop(5, { state: "resolved", closed: "2026-10-05T10:00:00.000Z", byName: "kellireynolds" }), // 21 days ago: outside the view
  ];
  const open = await listed(data);
  assertEquals(actionLabels(open.msg), ["Resolve 1", "Park 1"]);
  assertMatch(open.msg.content, /waiting on Kelli/);

  const parked = await listed(data, [{ name: "state", type: 3, value: "parked" }]);
  assertEquals(titles(parked.msg), [2]);
  assertEquals(actionLabels(parked.msg), ["Resolve 1", "Unpark 1"]);
  assertMatch(parked.msg.content, /parked until 2026-11-02 by kellireynolds/);

  const closed = await listed(data, [{ name: "state", type: 3, value: "closed" }]);
  const since = new Date(NOW.getTime() - CLOSED_VIEW_DAYS * 86_400_000).toISOString();
  assertEquals(closed.h.reads().map((r) => r.query).sort((a, b) => (a.state < b.state ? -1 : 1)), [{ state: "closed", since, limit: "2000" }, { state: "resolved", since, limit: "2000" }]);
  assertEquals(titles(closed.msg), [3, 4]);
  assertEquals(actionLabels(closed.msg), ["Reopen 1", "Reopen 2"]);
  assertMatch(closed.msg.content, /Loop 3 .*closed in channel/);
  assertMatch(closed.msg.content, /Loop 4 .*resolved by kellireynolds/);

  const filtered = await listed(data, [{ name: "client", type: 3, value: "  Servest&state=all " }]);
  assertEquals(filtered.h.reads().map((r) => r.query), [{ state: "open", client: "servest-state-all", limit: "2000" }], "one sanitised value, no smuggled parameter");
  const forged = await listed(data, [{ name: "state", type: 3, value: "all" }]);
  assertEquals(forged.h.reads().map((r) => r.query.state), ["open"], "a state Discord would never send falls back to open");
});

Deno.test("an empty view says so with no buttons; unreadable lines, forks and a capped list are all told, never dropped silently", async () => {
  const empty = await listed([]);
  assertMatch(empty.msg.content, /nothing open/i);
  assertEquals(empty.msg.components, []);

  const h = harness({
    loops: () => ({ loops: [loop(1), loop(2, { fork: true })], unreadable: [{ subject: "loop:x", lineId: "fact_1" }, { subject: "loop:y", lineId: "fact_2" }], warnings: { understandFailed: 0 }, total: 2500 }),
  });
  await onInteraction(cfg, h.io, command("loops"));
  const msg = h.lastEdit();
  assertMatch(msg.content, /2 ledger lines could not be read/);
  assertMatch(msg.content, /Loop 2 .*two current lines/);
  assertMatch(msg.content, /showing 2 of 2500/i);
});

Deno.test("hostile titles cannot break the page: six 500-character titles of pipes, newlines, markdown, links and mentions stay one escaped line each, under 2,000 characters, with no pings and embeds suppressed", async () => {
  const evil = ("**bold** _x_ `code` ~~s~~ ||spoiler|| > quote [click](https://evil.example) <@123> @everyone\n# heading\n- list \u2028 ").repeat(6).slice(0, 500);
  const data = Array.from({ length: 6 }, (_, i) => loop(i, { title: evil + i, owner: "@everyone\nKelli", channel: "servest\n# x" }));
  const { msg } = await listed(data);
  assert(msg.content.length <= 2000, `content is ${msg.content.length} characters`);
  assertEquals(msg.allowed_mentions, { parse: [] });
  assertEquals(msg.flags, 4, "SUPPRESS_EMBEDS: six links, no six previews");
  assertEquals("embeds" in msg, false);
  const items = msg.content.split("\n").filter((l) => /^\d+\. /.test(l));
  assertEquals(items.length, 6, "every loop is exactly one line");
  assert(!msg.content.includes("[click](https://evil.example)"), "a masked link in a title is escaped");
  assert(!msg.content.includes("<@123>"), "a mention in a title is escaped");
  assert(!/(^|[^\\])\*\*bold/.test(msg.content), "markdown in a title is escaped");
  assert(!/^#/m.test(msg.content) && !/^- /m.test(msg.content), "no line of the page starts a heading or a list");
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(msg.content), "no emoji cut in half");
});

Deno.test("custom ids: KEY_RE is the addendum's grammar; at its longest key, a 40-character client and the latest time a date can hold, every custom_id is at most 100 characters and unique, at most 5 rows of 5", async () => {
  assertEquals(KEY_RE.source, String.raw`^\d{17,20}(:[a-z])?(:\d{1,3})?$`);
  for (const ok of ["14300000000000000", "99999999999999999999", "99999999999999999999:z", "99999999999999999999:999", "99999999999999999999:z:999"]) assert(KEY_RE.test(ok), ok);
  for (const bad of ["1430000000000000", "999999999999999999999", "1430000000000000001:B", "1430000000000000001:1000", "1430000000000000001:2:b", "not-a-snowflake"]) assert(!KEY_RE.test(bad), bad);
  const longest = (i: number) => `${99999999999999999000n + BigInt(i)}:z:999`;
  for (const [state, view] of [["open", "open"], ["parked", "parked"], ["closed", "closed"], ["resolved", "closed"]] as const) {
    const data = Array.from({ length: 13 }, (_, i) =>
      loop(i, { key: longest(i), state, client: "a".repeat(40), opened: "+275760-09-13T00:00:00.000Z", closed: state === "closed" || state === "resolved" ? "2026-10-25T00:00:00.000Z" : null })
    );
    const h = harness({ data, loops: (q) => ({ ...route(data, q), loops: data.filter((l) => l.state === q.state) }) });
    await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: view }, { name: "client", type: 3, value: "A".repeat(70) }]));
    for (let page = 0; page < 3; page++) {
      const msg = h.lastEdit();
      const ids = buttons(msg).map((b) => b.custom_id);
      assert(ids.length > 2, `${state}: page has action buttons`);
      assert(ids.every((id) => id.length <= 100), `${state}: ${ids.find((id) => id.length > 100)} (${ids.find((id) => id.length > 100)?.length})`);
      assertEquals(new Set(ids).size, ids.length, `${state}: duplicate custom_id`);
      assert(msg.components.length <= 5 && msg.components.every((r) => r.components.length <= 5), `${state}: too many rows or buttons`);
      if (button(msg, "Next").disabled) break;
      await onInteraction(cfg, h.io, pressOn(msg, "Next"));
    }
  }
  const odd = await listed([loop(1, { key: "143000000000000000012" }), loop(2)]);
  assertMatch(odd.msg.content, /1\. Loop 1 .*no buttons: unusual key/);
  assertEquals(actionLabels(odd.msg), ["Resolve 2", "Park 2"], "a key outside the grammar gets no buttons");
});

// ---------- presses ----------

Deno.test("Resolve writes exactly one RESOLVED line superseding the loop's current line, as the presser, opener as proof, then shows the page again as /loops now has it", async () => {
  const data = [loop(1), loop(2)];
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  const list = h.lastEdit();
  const press = pressOn(list, "Resolve 1");
  await onInteraction(cfg, h.io, press);
  const caps = h.captures();
  assertEquals(caps.length, 1);
  assertEquals(caps[0].actor, "discord:kellireynolds");
  const k = keyOf(1);
  assertEquals(caps[0].args, {
    content: `RESOLVED/1 | key=${k} | by_user=${KELLI.id} | by_name=kellireynolds | resolved=2026-10-26T20:00:00.000Z | note=pressed Resolve in /loops`,
    subject: `loop:${k}`,
    source: `discord:interaction/${press.id}`,
    proof: `https://discord.com/channels/${GUILD}/${CHANNEL}/${k}`,
    supersedes: "fact_000001_aaaaaaaa",
  });
  assertEquals(h.data[0].state, "resolved");
  const after = h.lastEdit();
  assertMatch(after.content, /^› Resolved 1: Loop 1/m);
  assertEquals(titles(after), [2], "the resolved loop is gone from the page; the rest is what /loops says now");
  assertEquals(actionLabels(after), ["Resolve 1", "Park 1"]);
  assert(buttons(after).every((b) => !b.custom_id.endsWith(`;${k}`)), "no button left for the resolved loop");
  assert(after.content.length <= 2000);
  assertEquals(h.logs.filter((l) => l.event === "pa.press").map((l) => [l.action, l.outcome]), [["resolve", "recorded"]]);
});

Deno.test("two presses on one stale list: each reply is rendered from /loops, so the second never brings back the first loop or its buttons; a double click says what the loop is now", async () => {
  const data = [loop(1), loop(2), loop(3)];
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  const stale = h.lastEdit();
  await onInteraction(cfg, h.io, pressOn(stale, "Resolve 1"));
  await onInteraction(cfg, h.io, pressOn(stale, "Park 2"));
  const after = h.lastEdit();
  assertMatch(after.content, /^› Parked 2: Loop 2/m);
  assertEquals(titles(after), [3], "loop 1 stays gone after the second press");
  await onInteraction(cfg, h.io, pressOn(stale, "Resolve 1"));
  assertEquals(h.captures().length, 2, "the double click writes nothing");
  assertMatch(h.lastEdit().content, /changed since you listed it; it is now resolved/);
  assertEquals(titles(h.lastEdit()), [3]);
});

Deno.test("Park writes a PARKED line until seven days on; Unpark writes OPEN again with every field kept and `reopened` untouched; the log names each action", async () => {
  const data = [loop(1)];
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Park 1"));
  const k = keyOf(1);
  assertEquals(PARK_DAYS, 7);
  assertEquals(h.captures()[0].args.content, `PARKED/1 | key=${k} | by_user=${KELLI.id} | by_name=kellireynolds | until=2026-11-02 | note=pressed Park in /loops`);
  assertEquals(h.data[0].state, "parked");
  assertMatch(h.lastEdit().content, /^› Parked 1: Loop 1/m);
  assertMatch(h.lastEdit().content, /nothing open/);

  await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: "parked" }]));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Unpark 1"));
  const w = h.captures()[1];
  assertEquals(w.args.content, `OPEN/1 | key=${k} | client=servest | type=unanswered_question | owner=Kelli | channel=servest | channel_id=${CHANNEL} | opened=2026-10-01T09:00:00.000Z | reopened=- | title=Loop 1 | summary=Summary 1 | evidence=${k}`);
  assertEquals(w.args.source, `discord:${GUILD}/${CHANNEL}/${k}`, "an OPEN line carries the opener's own source");
  assertEquals(w.args.supersedes, "fact_900001_cccccccc", "the PARKED line the first press wrote");
  assertEquals(h.data[0].state, "open");
  assertMatch(h.lastEdit().content, /nothing parked/, "the parked view, re-read after the press");

  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: "closed" }]));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Reopen 1"));
  assertEquals(h.logs.filter((l) => l.event === "pa.press" && l.outcome === "recorded").map((l) => l.action), ["park", "unpark", "resolve", "reopen"]);
});

Deno.test("Reopen on a closed loop writes OPEN with reopened=now; on a resolved one it re-reads that loop by key in any state; a loop reopened before keeps its other fields", async () => {
  const data = [
    loop(3, { state: "closed", closed: "2026-10-25T10:00:00.000Z", reopened: "2026-10-10T00:00:00.000Z", evidence: [keyOf(3), "1431000000000000002"] }),
    loop(4, { state: "resolved", closed: "2026-10-24T10:00:00.000Z", byName: "kellireynolds" }),
  ];
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: "closed" }]));
  const list = h.lastEdit();
  await onInteraction(cfg, h.io, pressOn(list, "Reopen 1"));
  const k = keyOf(3);
  assertEquals(h.captures()[0].args.content, `OPEN/1 | key=${k} | client=servest | type=unanswered_question | owner=Kelli | channel=servest | channel_id=${CHANNEL} | opened=2026-10-01T11:00:00.000Z | reopened=2026-10-26T20:00:00.000Z | title=Loop 3 | summary=Summary 3 | evidence=${k},1431000000000000002`);
  assertEquals(h.captures()[0].args.supersedes, "fact_000003_aaaaaaaa");
  const before = h.reads().length;
  await onInteraction(cfg, h.io, pressOn(list, "Reopen 2"));
  assertEquals(h.reads()[before].query, { state: "all", key: keyOf(4), limit: "2000" }, "one loop by key, whatever state it is in now");
  assertEquals(h.data.map((l) => l.state), ["open", "open"]);
  assertMatch(h.lastEdit().content, /nothing closed or resolved/, "both left the closed view");
});

Deno.test("a stale line: the ledger refuses, the loop is re-read once and, still open, the write is retried on its new line", async () => {
  const data = [loop(1)];
  let h!: ReturnType<typeof harness>;
  h = harness({
    data,
    capture: (args, n) => {
      if (n === 1) data[0] = { ...data[0], lineId: "fact_000777_bbbbbbbb", evidence: [keyOf(1), "1431000000000000003"] }; // the 07:30 job adds evidence between our read and our write
      return h.led(args);
    },
  });
  await onInteraction(cfg, h.io, command("loops"));
  const readsBefore = h.reads().length;
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  assertEquals(h.captures().map((c) => c.args.supersedes), ["fact_000001_aaaaaaaa", "fact_000777_bbbbbbbb"]);
  assertEquals(h.reads().slice(readsBefore).filter((r) => r.query.key).length, 2, "read by key before writing, re-read once after the refusal");
  assertMatch(h.lastEdit().content, /^› Resolved 1/m);
  assertEquals(h.data[0].state, "resolved");
});

Deno.test("a stale line whose loop is no longer in the expected state: no retry, the reply says what it is now, and the page is /loops's", async () => {
  const data = [loop(1), loop(2)];
  let h!: ReturnType<typeof harness>;
  h = harness({
    data,
    capture: (args, n) => {
      if (n === 1) data[0] = { ...data[0], state: "closed", lineId: "fact_000888_bbbbbbbb", closed: "2026-10-26T19:59:00.000Z" }; // closed in channel by the job meanwhile
      return h.led(args);
    },
  });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Park 1"));
  assertEquals(h.captures().length, 1);
  const after = h.lastEdit();
  assertMatch(after.content, /changed since you listed it; it is now closed/);
  assertEquals(titles(after), [2]);
  assertEquals(h.data[0].state, "closed");
  assertEquals(h.logs.filter((l) => l.event === "pa.press").map((l) => [l.action, l.outcome]), [["park", "changed"]]);
});

Deno.test("a stale refusal twice in a row gives up after one retry; a loop gone before the press writes nothing at all", async () => {
  const data = [loop(1)];
  let h!: ReturnType<typeof harness>;
  let line = 0;
  h = harness({
    data,
    capture: (args) => {
      data[0] = { ...data[0], lineId: `fact_00077${++line}_bbbbbbbb` }; // the line moves on before every write
      return h.led(args);
    },
  });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  assertEquals(h.captures().length, 2, "one retry, never a loop of retries");
  assertMatch(h.lastEdit().content, /changed since you listed it/);

  const gone = harness({ data: [loop(5)] });
  await onInteraction(cfg, gone.io, command("loops"));
  const list = gone.lastEdit();
  gone.data.splice(0, 1);
  await onInteraction(cfg, gone.io, pressOn(list, "Resolve 1"));
  assertEquals(gone.captures().length, 0);
  assertMatch(gone.lastEdit().content, /changed since you listed it; it is no longer listed/);
});

Deno.test("a write that times out but lands late is never retried blind: the reply says to check /loops, and the page under it, read afterwards, already shows the loop gone", async () => {
  const data = [loop(1), loop(2)];
  let h!: ReturnType<typeof harness>;
  h = harness({
    data,
    capture: (args) => {
      h.led(args); // the server keeps going after the client gives up, as the real one does
      throw new TimeoutError("grysstof /mcp", 20_000);
    },
  });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  assertEquals(h.captures().length, 1);
  const after = h.lastEdit();
  assertMatch(after.content, /the ledger did not answer; check \/loops before retrying/);
  assertEquals(titles(after), [2], "the line landed; the page read after the timeout says so");
  assertEquals(h.data[0].state, "resolved");
  assertEquals(h.events().filter((e) => e === "pa.timeout" || e === "pa.failed"), ["pa.timeout"]);
});

Deno.test("a read that times out: the command says Grysstof did not answer; a Next that times out keeps the page and says so; a press whose refresh times out shows no stale buttons", async () => {
  let slow = true;
  let slowList = false;
  const data = Array.from({ length: 8 }, (_, i) => loop(i));
  const h = harness({ data, loops: (q) => { if (slow || (slowList && !q.key)) throw new TimeoutError("grysstof /browse/api/loops", 20_000); return route(data, q); } });
  await onInteraction(cfg, h.io, command("loops"));
  assertMatch(h.lastEdit().content, /did not answer/);
  assertEquals(h.lastEdit().components, []);
  slow = false;
  await onInteraction(cfg, h.io, command("loops"));
  const page = h.lastEdit();
  slow = true;
  await onInteraction(cfg, h.io, pressOn(page, "Next"));
  const after = h.lastEdit();
  assertMatch(after.content, /did not answer/);
  assertEquals(titles(after), titles(page), "the page the user was reading stays");
  assertEquals(h.captures().length, 0);
  assertEquals(h.events().filter((e) => e === "pa.timeout").length, 2);

  slow = false;
  slowList = true; // the press's own read and write work; only the page refresh after it times out
  await onInteraction(cfg, h.io, pressOn(page, "Resolve 1"));
  const pressed = h.lastEdit();
  assertMatch(pressed.content, /^› Resolved 1: Loop 0/m);
  assertMatch(pressed.content, /could not refresh the list; run \/loops again/);
  assertEquals(pressed.components, [], "no buttons from a page nobody could re-read");
  assertEquals(h.logs.filter((l) => l.event === "pa.timeout").map((l) => l.what), ["list", "list", "refresh"]);
});

Deno.test("refusals that are not staleness, an unexpected answer and a 500 are failures: no retry, pa.failed, the reply says it was not recorded and the loop is still listed", async () => {
  const cases: [string, (args: Record<string, unknown>) => Answer][] = [
    ["other subject", (a) => ({ text: `Failed to capture: Fact ${a.supersedes} is about "loop:9", not "${a.subject}"; a fact only supersedes one about the same subject`, isError: true })],
    ["a thought, not a fact", () => ({ text: "Captured as observation — servest", isError: false })],
    ["500", () => { throw new HttpError(500, "boom", "grysstof /mcp"); }],
  ];
  for (const [name, capture] of cases) {
    const h = harness({ data: [loop(1)], capture });
    await onInteraction(cfg, h.io, command("loops"));
    await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
    assertEquals(h.captures().length, 1, name);
    assertMatch(h.lastEdit().content, /could not record/i, name);
    assertEquals(h.events().filter((e) => e === "pa.failed" || e === "pa.timeout"), ["pa.failed"], name);
    assertEquals(titles(h.lastEdit()), [1], `${name}: still listed, still pressable`);
  }
});

Deno.test("an edit that fails after a successful write is logged as pa.failed and the write still counts as recorded", async () => {
  let failEdits = false;
  const h = harness({ data: [loop(1)], discord: (m) => { if (failEdits && m === "PATCH") throw new HttpError(500, "", "discord PATCH"); } });
  await onInteraction(cfg, h.io, command("loops"));
  const list = h.lastEdit();
  failEdits = true;
  await onInteraction(cfg, h.io, pressOn(list, "Resolve 1"));
  assertEquals(h.data[0].state, "resolved");
  const press = h.logs.find((l) => l.event === "pa.press");
  assertEquals(press?.outcome, "recorded");
  assert(h.events().includes("pa.failed"));
});

Deno.test("a press on a forked loop writes one line on the shown head, then links every other head to it, leaving one current line, and says so", async () => {
  const k = keyOf(1);
  const data = [loop(1, { fork: true })];
  const fact = (id: string, over: Record<string, unknown> = {}) => ({ id, subject: `loop:${k}`, claim: "x", learnedAt: "2026-10-26T07:30:00.000Z", ...over });
  let h!: ReturnType<typeof harness>;
  h = harness({
    data,
    history: () => ({
      facts: [
        fact("fact_900001_cccccccc", { supersedes: "fact_000001_aaaaaaaa" }),
        fact("fact_000001_aaaaaaaa", { supersededBy: "fact_900001_cccccccc" }),
        fact("fact_000002_dddddddd"), // the other OPEN head, from a timed-out write that landed twice
        fact("fact_000003_eeeeeeee"), // and a third
        fact("fact_000000_ffffffff", { supersededBy: "fact_000002_dddddddd" }),
      ],
    }),
  });
  await onInteraction(cfg, h.io, command("loops"));
  assertMatch(h.lastEdit().content, /two current lines/);
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  const order = h.calls.map((c) => c.kind).filter((x) => x === "capture" || x === "history" || x === "supersede");
  assertEquals(order, ["capture", "history", "supersede", "supersede"], "the heads are read after the write, so a head the job adds meanwhile is caught");
  assertEquals(h.captures()[0].args.supersedes, "fact_000001_aaaaaaaa");
  const links = h.calls.filter((c): c is Extract<Call, { kind: "supersede" }> => c.kind === "supersede");
  assertEquals(links.map((l) => [l.actor, l.newer, l.older]), [["discord:kellireynolds", "fact_900001_cccccccc", "fact_000002_dddddddd"], ["discord:kellireynolds", "fact_900001_cccccccc", "fact_000003_eeeeeeee"]]);
  assertMatch(h.lastEdit().content, /^› Resolved 1: Loop 1\. It had 3 current lines; all now replaced by this one\./m);
  const press = h.logs.find((l) => l.event === "pa.press")!;
  assertEquals(press.fork, { heads: 3, linked: 2, failed: 0 });

  const plain = harness({ data: [loop(2)] });
  await onInteraction(cfg, plain.io, command("loops"));
  await onInteraction(cfg, plain.io, pressOn(plain.lastEdit(), "Resolve 1"));
  assertEquals(plain.calls.filter((c) => c.kind === "history" || c.kind === "supersede"), [], "no fork, no extra reads or links");
});

Deno.test("a fork whose other head was replaced meanwhile counts as done; a link that fails is told and logged once, and the press still counts", async () => {
  const k = keyOf(1);
  const fact = (id: string, over: Record<string, unknown> = {}) => ({ id, subject: `loop:${k}`, claim: "x", learnedAt: "2026-10-26T07:30:00.000Z", ...over });
  const heads = { facts: [fact("fact_900001_cccccccc"), fact("fact_000002_dddddddd"), fact("fact_000003_eeeeeeee")] };
  const h = harness({
    data: [loop(1, { fork: true })],
    history: () => heads,
    supersede: (_n, older) =>
      older === "fact_000002_dddddddd"
        ? { text: "Failed: Fact fact_000002_dddddddd is already superseded by fact_000004_gggggggg", isError: true }
        : { text: "Failed: database is locked", isError: true },
  });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  assertMatch(h.lastEdit().content, /^› Resolved 1: Loop 1\. It had 3 current lines; 1 could not be replaced, see \/loops\./m);
  assertEquals(h.logs.find((l) => l.event === "pa.press")!.fork, { heads: 3, linked: 1, failed: 1 });
  assertEquals(h.logs.filter((l) => l.event === "pa.failed").map((l) => l.what), ["fork_link"]);
});

Deno.test("a fork whose lines cannot be read after the write: the press still counts, nothing is linked blind, and the reply says the fork may remain", async () => {
  const h = harness({ data: [loop(1, { fork: true })], history: () => { throw new TimeoutError("grysstof /browse/api/history", 20_000); } });
  await onInteraction(cfg, h.io, command("loops"));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1"));
  assertMatch(h.lastEdit().content, /^› Resolved 1: Loop 1\. It had more than one current line, and they could not be read; see \/loops\./m);
  assertEquals(h.logs.find((l) => l.event === "pa.press")!.outcome, "recorded");
  assertEquals(h.logs.filter((l) => l.event === "pa.timeout").map((l) => l.what), ["fork_link"]);
  assertEquals(h.calls.filter((c) => c.kind === "supersede"), []);
});

Deno.test("forged or foreign custom_ids are acknowledged and ignored: zero reads, zero writes", async () => {
  const k = keyOf(1);
  const forged = [
    `pa1;a;R;o;1;${k};extra`,
    `pa1;a;X;o;1;${k}`,
    `pa1;a;R;c;1;${k}`, // Resolve offered on a closed loop: no view ever shows that
    `pa1;a;O;o;1;${k}`, // Reopen on an open loop
    `pa1;a;R;o;1;${k} OR 1=1`,
    `pa1;a;R;o;1;../${k}`,
    `pa1;a;R;o;1;${"9".repeat(21)}`,
    `pa1;a;R;o;1;${"9".repeat(120)}`,
    `pa2;a;R;o;1;${k}`,
    "",
  ];
  const h = harness({ data: [loop(1)] });
  for (const custom_id of forged) await onInteraction(cfg, h.io, ix(3, { custom_id, component_type: 2 }));
  assertEquals(h.calls.filter((c) => c.kind !== "discord"), []);
  assertEquals(h.calls.filter((c) => c.kind === "discord").map((c) => (c as DiscordCall).body), forged.map(() => ({ type: 6 })));
  assertEquals(h.events().filter((e) => e === "pa.interaction_unknown").length, forged.length);
});

Deno.test("a listed user in a DM (user, not member) is served the same way when no guild list is set", async () => {
  const h = harness({ data: [loop(1)] });
  const dm: Interaction = { ...command("loops"), member: undefined, guild_id: undefined, user: KELLI };
  await onInteraction(cfg, h.io, dm);
  assertEquals(titles(h.lastEdit()), [1]);
});

Deno.test("a lost race worded differently (a guarded Postgres update) is still treated as stale; a legacy username with a space becomes an actor the gate accepts, while the line keeps the real name", async () => {
  const legacy = { id: KELLI.id, username: "Kelli Reynolds" };
  const data = [loop(1)];
  let h!: ReturnType<typeof harness>;
  h = harness({
    data,
    capture: (args, n) => {
      if (n === 1) {
        data[0] = { ...data[0], lineId: "fact_000555_bbbbbbbb" };
        return { text: `Failed to capture: Fact ${args.supersedes} was superseded concurrently`, isError: true };
      }
      return h.led(args);
    },
  });
  await onInteraction(cfg, h.io, command("loops", [], legacy));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Resolve 1", legacy));
  assertEquals(h.captures().map((c) => c.args.supersedes), ["fact_000001_aaaaaaaa", "fact_000555_bbbbbbbb"]);
  assertEquals(h.captures()[1].actor, "discord:Kelli_Reynolds");
  assertMatch(h.captures()[1].actor, /^[A-Za-z0-9._:@\/-]{1,120}$/, "matches the gate's actor pattern");
  assertStringIncludes(String(h.captures()[1].args.content), "| by_name=Kelli Reynolds |");
});

Deno.test("onInteraction never rejects, whatever its dependencies do: every one of them throwing, a null interaction, an object that is not one", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  const exploding: PaIo = { discord: boom, loops: boom, capture: boom, history: boom, supersede: boom, log: boom, now: boom };
  const { msg } = await listed([loop(1)]);
  await Promise.all([
    onInteraction(cfg, exploding, command("loops")),
    onInteraction(cfg, exploding, pressOn(msg, "Resolve 1")),
    onInteraction(cfg, exploding, pressOn(msg, "Next")),
    onInteraction(cfg, exploding, ix(4, { name: "loops" })),
    onInteraction(cfg, exploding, { nonsense: true } as unknown as Interaction),
    onInteraction(cfg, exploding, null as unknown as Interaction),
  ]);
  assertEquals(await registerCommands(exploding, APP, [GUILD]), false);
});

// ---------- registration ----------

Deno.test("registration: PUT to the guild's command list with /loops and /loops-help, no default_member_permissions, client free text, state open/parked/closed; the returned list is logged", async () => {
  const h = harness({ discord: (_m, p) => (p.endsWith("/commands") ? [{ id: "11", name: "loops", version: "1" }, { id: "12", name: "loops-help", version: "1" }] : undefined) });
  assertEquals(await registerCommands(h.io, APP, [GUILD]), true);
  const put = h.calls[0] as DiscordCall;
  assertEquals([put.method, put.path], ["PUT", `/applications/${APP}/guilds/${GUILD}/commands`]);
  assertEquals(put.body, COMMANDS);
  assert(!JSON.stringify(COMMANDS).includes("default_member_permissions"), "no permission default: visibility is decided by PA_USERS, not Discord roles");
  const [loops, help] = COMMANDS;
  assertEquals([loops.name, help.name], ["loops", "loops-help"]);
  const client = loops.options!.find((o) => o.name === "client")!;
  const state = loops.options!.find((o) => o.name === "state")!;
  assertEquals([client.type, "choices" in client, "autocomplete" in client], [3, false, false]);
  assertEquals(state.choices!.map((c) => c.value), ["open", "parked", "closed"]);
  assert(COMMANDS.every((c) => c.description.length <= 100 && (c.options ?? []).every((o) => o.description.length <= 100)));
  assertEquals(h.logs, [{ event: "pa.registered", guild: GUILD, commands: [{ id: "11", name: "loops" }, { id: "12", name: "loops-help" }] }]);
});

Deno.test("every guild member sees the command picker, clients included: no description says what the list holds or names a client", () => {
  const texts = COMMANDS.flatMap((c) => [c.description, ...(c.options ?? []).map((o) => o.description)]);
  for (const t of texts) assert(!/owed|believes|promise|unanswered|servest|swanzo|client|resolve|park/i.test(t), `"${t}" says too much`);
  assertEquals(COMMANDS.map((c) => c.description), ["Team list. Only permitted people can use it.", "How the team list works."]);
});

Deno.test("registration failures: 403 logs the invite-scope hint, 400 and 429 log their status, the next guild is still tried, nothing rejects", async () => {
  const fail: Record<string, number> = { g403: 403, g400: 400, g429: 429 };
  const h = harness({
    discord: (_m, p) => {
      const g = p.split("/")[4];
      if (fail[g]) throw new HttpError(fail[g], `{"message":"x","code":${fail[g]}}`, `discord PUT ${p}`);
      return [];
    },
  });
  assertEquals(await registerCommands(h.io, APP, ["g403", "g400", "g429", "gok"]), false);
  assertEquals(h.calls.length, 4);
  const failed = h.logs.filter((l) => l.event === "pa.register_failed");
  assertEquals(failed.map((l) => [l.guild, l.status]), [["g403", 403], ["g400", 400], ["g429", 429]]);
  assertMatch(String(failed[0].hint), /invite scope applications\.commands missing/);
  assertEquals(failed.slice(1).map((l) => l.hint), [undefined, undefined]);
  assertEquals(h.logs.filter((l) => l.event === "pa.registered").map((l) => l.guild), ["gok"]);

  const none = harness();
  assertEquals(await registerCommands(none.io, "", [GUILD]), false, "READY without an application id");
  assertEquals(await registerCommands(none.io, APP, []), false, "no guild passes the allowlist");
  assertEquals(none.calls, []);
  assertEquals(none.events(), ["pa.register_failed", "pa.register_failed"]);
});

Deno.test("registration through the real REST helper: a 429 is waited out as Discord asks, then registered; a 429 that never ends is logged as 429", async () => {
  let n = 0;
  const seen: { method?: string; url: string; auth: string | null }[] = [];
  const waits: number[] = [];
  const fetch429 = (limit: number) => async (url: string, init: RequestInit) => {
    seen.push({ method: init.method, url, auth: new Headers(init.headers).get("authorization") });
    if (++n <= limit) return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 0.25, global: false }), { status: 429 });
    return new Response(JSON.stringify([{ id: "11", name: "loops" }, { id: "12", name: "loops-help" }]), { status: 200 });
  };
  const logs: Record<string, unknown>[] = [];
  const discord = discordClient("bot-token", { fetch: fetch429(2), sleep: async (ms) => void waits.push(ms) });
  assertEquals(await registerCommands({ discord, log: (f) => void logs.push(f) }, APP, [GUILD]), true);
  assertEquals(waits, [250, 250]);
  assertEquals(seen.map((s) => [s.method, s.url, s.auth]), Array(3).fill(["PUT", `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`, "Bot bot-token"]));
  assertEquals(logs.map((l) => l.event), ["pa.registered"]);

  n = 0;
  const forever = discordClient("bot-token", { fetch: fetch429(99), sleep: async () => {} });
  const logs2: Record<string, unknown>[] = [];
  assertEquals(await registerCommands({ discord: forever, log: (f) => void logs2.push(f) }, APP, [GUILD]), false);
  assertEquals(logs2.map((l) => [l.event, l.status]), [["pa.register_failed", 429]]);
  assertEquals(n, 4, "three retries, then give up");
});

// ---------- the line composer ----------

Deno.test("composer: one physical line, ' | ' only between fields, fields in contract order, hostile text sanitised, title 120 / summary 300 / note 300 at most, evidence 8 newest", () => {
  const hostile = "a | b\nc\r\td\u0000e\u001b[31m \u2028 f||g";
  assertEquals(sanitise(hostile, 300), "a b c d e [31m fg", "core/loops.ts: pipes removed, line breaks and control characters become spaces, whitespace collapses");
  const r = resolvedLine("1430000000000000001", KELLI.id, "kelli|reynolds\n", NOW, hostile + "x".repeat(400));
  assert(!/[\r\n]/.test(r));
  const parts = r.split(" | ");
  assertEquals(parts.map((p) => p.split("=")[0]), ["RESOLVED/1", "key", "by_user", "by_name", "resolved", "note"]);
  assertEquals(parts[3], "by_name=kellireynolds");
  assert([...parts[5]].length - "note=".length <= 300);

  assertEquals(parkedLine("1430000000000000001", KELLI.id, "kellireynolds", "2026-11-02", "n"), `PARKED/1 | key=1430000000000000001 | by_user=${KELLI.id} | by_name=kellireynolds | until=2026-11-02 | note=n`);

  const ev = Array.from({ length: 12 }, (_, i) => String(1431000000000000000n + BigInt((i * 7) % 12)));
  const o = openLine(loop(1, { title: "😀".repeat(100) + "|", summary: "s".repeat(500), owner: "Kel|li", evidence: ev }), null);
  const fields = Object.fromEntries(o.split(" | ").slice(1).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  assertEquals(o.split(" | ").map((p) => p.split("=")[0]), ["OPEN/1", "key", "client", "type", "owner", "channel", "channel_id", "opened", "reopened", "title", "summary", "evidence"]);
  assert([...fields.title].length <= 120 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(fields.title), "title at most 120 characters without splitting an emoji");
  assert([...fields.summary].length <= 300);
  assertEquals(fields.owner, "Kelli");
  assertEquals(fields.reopened, "-");
  assertEquals(fields.evidence.split(","), ev.slice(-8), "the last eight given, in order: core/loops.ts reads list position as age");
  assertEquals(openLine(loop(3, { evidence: ["1431000000000000009", "1431000000000000001"] }), null).split("evidence=")[1], "1431000000000000009,1431000000000000001", "eight or fewer: untouched, so a rewrite never looks like a change");
  const blanks = openLine(loop(2, { client: null, owner: null, reopened: null }), "2026-10-26T20:00:00.000Z");
  assertStringIncludes(blanks, "| client=internal |");
  assertStringIncludes(blanks, "| owner=unclear |");
  assertStringIncludes(blanks, "| reopened=2026-10-26T20:00:00.000Z |");
});

Deno.test("every line the PA writes reads back through core/loops.ts's parser with its state, key, user id and note intact, even from a hostile title", async () => {
  const data = [loop(1), loop(2), loop(3, { state: "closed", closed: "2026-10-25T10:00:00.000Z", title: "Q3 | report\nhold <@1> **now**" })];
  const h = harness({ data });
  await onInteraction(cfg, h.io, command("loops"));
  const open = h.lastEdit();
  await onInteraction(cfg, h.io, pressOn(open, "Resolve 1"));
  await onInteraction(cfg, h.io, pressOn(open, "Park 2"));
  await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: "closed" }]));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Reopen 2")); // item 1 is loop 1, resolved a moment ago
  const caps = h.captures();
  assertEquals(caps.length, 3);
  const read = caps.map((c) => parse(String(c.args.content)));
  assert(read.every((p) => p.ok), JSON.stringify(read));
  const [resolved, parked, reopened] = read.map((p) => (p as { ok: true; line: LoopLine }).line);
  assertEquals(resolved, { tag: "RESOLVED", key: keyOf(1), byUser: KELLI.id, byName: "kellireynolds", resolved: NOW.toISOString(), note: "pressed Resolve in /loops" });
  assertEquals(parked, { tag: "PARKED", key: keyOf(2), byUser: KELLI.id, byName: "kellireynolds", until: "2026-11-02", note: "pressed Park in /loops" });
  const o = reopened as OpenLine;
  assertEquals([o.tag, o.key, o.reopened, o.opened, o.title, o.channelId, o.evidence], ["OPEN", keyOf(3), NOW.toISOString(), "2026-10-01T11:00:00.000Z", "Q3 report hold <@1> **now**", CHANNEL, [keyOf(3)]]);
  assertEquals(caps.map((c) => c.args.subject), [1, 2, 3].map((i) => `loop:${keyOf(i)}`), "each line is written under its own loop's subject");
  assertEquals(h.data.map((l) => l.state), ["resolved", "parked", "open"]);
});

Deno.test("a loop record missing what an OPEN line needs is not reopened half-written", async () => {
  const h = harness({ data: [loop(3, { state: "closed", closed: "2026-10-25T10:00:00.000Z", title: null, type: null })] });
  await onInteraction(cfg, h.io, command("loops", [{ name: "state", type: 3, value: "closed" }]));
  await onInteraction(cfg, h.io, pressOn(h.lastEdit(), "Reopen 1"));
  assertEquals(h.captures().length, 0);
  assertMatch(h.lastEdit().content, /could not record/i);
  assert(h.events().includes("pa.failed"));
});

Deno.test("age reads as a person says it: minutes, hours and minutes, days and hours; nonsense and the future do not crash", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  assertEquals(ageText(ago(((3 * 24 + 18) * 60 + 5) * 60_000), NOW), "3d 18h");
  assertEquals(ageText(ago((5 * 60 + 2) * 60_000), NOW), "5h 2m");
  assertEquals(ageText(ago(7 * 60_000 + 59_000), NOW), "7m");
  assertEquals(ageText(ago(-3_600_000), NOW), "0m");
  assertEquals(ageText("not a date", NOW), "?");
  assertEquals(ageText(null, NOW), "?");
});

// ---------- the REST helper ----------

Deno.test("REST: a call that never answers is cut at the timeout even if fetch ignores the abort, and so is a body that never finishes", async () => {
  const t0 = Date.now();
  await assertRejects(() => send({ fetch: () => new Promise<Response>(() => {}), timeoutMs: 30 }, "grysstof /mcp", "http://pi/mcp", { method: "POST" }), TimeoutError);
  const stalled = { status: 200, headers: new Headers(), text: () => new Promise<string>(() => {}) } as unknown as Response;
  await assertRejects(() => send({ fetch: async () => stalled, timeoutMs: 30 }, "grysstof /mcp", "http://pi/mcp", { method: "POST" }), TimeoutError);
  assert(Date.now() - t0 < 2000);
});

Deno.test("REST: 429 waits retry_after (body or header) and retries; a wait longer than the cap or past the retries fails as 429; other statuses fail at once with the status", async () => {
  const waits: number[] = [];
  let n = 0;
  const flaky = async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response("ok", { status: 200 }));
  assertEquals(await send({ fetch: flaky, sleep: async (ms) => void waits.push(ms) }, "x", "http://x", { method: "GET" }), "ok");
  assertEquals(waits, [2000]);
  const long = async () => new Response(JSON.stringify({ retry_after: 600 }), { status: 429 });
  const err = await assertRejects(() => send({ fetch: long, sleep: async () => {} }, "x", "http://x", { method: "GET" }), HttpError);
  assertEquals(err.status, 429);
  let m = 0;
  const once500 = async () => (++m, new Response("nope", { status: 503 }));
  assertEquals((await assertRejects(() => send({ fetch: once500, sleep: async () => {} }, "x", "http://x", { method: "GET" }), HttpError)).status, 503);
  assertEquals(m, 1, "a 5xx is not retried here: the caller decides");
});

Deno.test("REST: the interaction token in a webhook path never appears in an error; interaction and webhook calls carry no bot token, application calls do", async () => {
  const heads: [string, string | null][] = [];
  const fake = async (url: string, init: RequestInit) => {
    heads.push([url, new Headers(init.headers).get("authorization")]);
    return new Response('{"message":"Unknown Webhook"}', { status: 404 });
  };
  const discord = discordClient("bot-token", { fetch: fake });
  const err = await assertRejects(() => discord("PATCH", `/webhooks/${APP}/${TOKEN}/messages/@original`, { content: "x" }), HttpError);
  assert(!err.message.includes(TOKEN), err.message);
  assertStringIncludes(err.message, "404");
  await assertRejects(() => discord("POST", `/interactions/1/${TOKEN}/callback`, { type: 6 }), HttpError);
  await assertRejects(() => discord("PUT", `/applications/${APP}/guilds/${GUILD}/commands`, []), HttpError);
  assertEquals(heads.map((h) => h[1]), [null, null, "Bot bot-token"]);

  const offline = discordClient("bot-token", { fetch: (url) => Promise.reject(new TypeError(`error sending request for url (${url}): connection refused`)) });
  const net = await assertRejects(() => offline("POST", `/interactions/1/${TOKEN}/callback`, { type: 6 }));
  assert(!(net as Error).message.includes(TOKEN), "a network error that names the URL is scrubbed of the token");
  assertStringIncludes((net as Error).message, "connection refused");
});

Deno.test("mcpText: plain JSON, SSE with a notification first, a tool error, a JSON-RPC error; anything else throws", () => {
  const res = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
  assertEquals(mcpText(res({ content: [{ type: "text", text: "Recorded fact f1 about loop:1" }] })), { text: "Recorded fact f1 about loop:1", isError: false });
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${res({ content: [{ type: "text", text: "Recorded fact f2 about loop:2" }] })}\n\n`;
  assertEquals(mcpText(sse), { text: "Recorded fact f2 about loop:2", isError: false });
  assertEquals(mcpText(res({ content: [{ type: "text", text: "Failed to capture: Fact f1 is already superseded by f2" }], isError: true })), { text: "Failed to capture: Fact f1 is already superseded by f2", isError: true });
  const rpc = mcpText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }));
  assertEquals(rpc.isError, true);
  assertStringIncludes(rpc.text, "Invalid params");
  let threw = false;
  try {
    mcpText("<html>502 Bad Gateway</html>");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("clients: /mcp gets the key, the actor and both accept types for capture_thought and supersede_fact; /browse/api/loops and /history are found next to /mcp, behind a path prefix too", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(url.includes("/mcp") ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Recorded fact f1 about loop:1" }] } }) : '{"loops":[],"unreadable":[],"total":0}', { status: 200 });
  };
  const capture = mcpCapture("http://localhost:8788/mcp", "k3y", { fetch: fake });
  assertEquals(await capture("discord:kellireynolds", { content: "x", subject: "loop:1" }), { text: "Recorded fact f1 about loop:1", isError: false });
  const h = new Headers(seen[0].init.headers);
  assertEquals([seen[0].init.method, h.get("x-brain-key"), h.get("x-brain-actor")], ["POST", "k3y", "discord:kellireynolds"]);
  assertStringIncludes(String(h.get("accept")), "text/event-stream");
  assertEquals(JSON.parse(String(seen[0].init.body)).params, { name: "capture_thought", arguments: { content: "x", subject: "loop:1" } });
  await mcpTool("http://localhost:8788/mcp", "k3y", { fetch: fake })("discord:kellireynolds", "supersede_fact", { newer_id: "f2", older_id: "f1" });
  assertEquals(JSON.parse(String(seen[1].init.body)).params, { name: "supersede_fact", arguments: { newer_id: "f2", older_id: "f1" } });

  await browseLoops("http://localhost:8788/mcp", "k3y", { fetch: fake })({ state: "open", client: "servest" });
  await browseLoops("https://pi.example/grysstof/mcp/", "k3y", { fetch: fake })({ state: "closed", since: "2026-10-12T20:00:00.000Z" });
  await browseHistory("https://pi.example/grysstof/mcp", "k3y", { fetch: fake })("loop:1430000000000000001:b");
  assertEquals(seen.slice(2).map((s) => s.url), [
    "http://localhost:8788/browse/api/loops?state=open&client=servest",
    "https://pi.example/grysstof/browse/api/loops?state=closed&since=2026-10-12T20%3A00%3A00.000Z",
    "https://pi.example/grysstof/browse/api/history?subject=loop%3A1430000000000000001%3Ab",
  ]);
  assertEquals(new Headers(seen[2].init.headers).get("x-brain-key"), "k3y");
});
