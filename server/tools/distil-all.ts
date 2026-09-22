/**
 * Distil every client channel into ledger facts and import them. One command, resumable.
 *
 *   deno run --env-file=.env.xactco --allow-net --allow-env --allow-read --allow-write --allow-run \
 *     tools/distil-all.ts <dumps-dir> <facts-dir> [--url=http://host:8788/mcp] [--only=chan1,chan2] [--dry-run]
 *
 * For each channel in tools/channels.json with a dump: distil (skipped when <facts-dir>/<channel>.json
 * exists, so a re-run redoes nothing paid), then import (idempotent by claim). A channel over MAX_CHARS of
 * transcript is split at month boundaries, each part seeing the previous part's facts, and the parts are
 * merged with supersedes indexes offset. Per-channel usage and dollars are logged to <facts-dir>/run.log.
 */
const [dumpsDir, factsDir] = Deno.args.filter((a: string) => !a.startsWith("--"));
const flag = (n: string) => Deno.args.find((a: string) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const dryRun = Deno.args.includes("--dry-run");
const only = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const url = flag("url");
if (!dumpsDir || !factsDir) {
  console.error("usage: distil-all.ts <dumps-dir> <facts-dir> [--url=...] [--only=a,b] [--dry-run]");
  Deno.exit(2);
}
const MAX_CHARS = 110_000;
const here = new URL(".", import.meta.url);
const channels = JSON.parse(await Deno.readTextFile(new URL("channels.json", here))) as Record<string, string>;
await Deno.mkdir(factsDir, { recursive: true });
const logPath = `${factsDir}/run.log`;
const log = async (o: Record<string, unknown>) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...o });
  console.error(line);
  await Deno.writeTextFile(logPath, line + "\n", { append: true });
};

type Msg = { at: string; proof: string; text: string };
type Fact = { claim: string; occurred_at: string; sources: number[]; supersedes: number | null; tags: string[]; subject: string; proofs: string[] };

async function run(args: string[], allowRun = false): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", ...(allowRun ? ["--allow-run"] : []), ...args],
    env: Deno.env.toObject(),
    stdout: "inherit",
    stderr: "piped",
  });
  const out = await cmd.output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

/** Split a dump at month boundaries so no part exceeds MAX_CHARS. */
function split(msgs: Msg[]): Msg[][] {
  const total = msgs.reduce((n, m) => n + m.text.length, 0);
  if (total <= MAX_CHARS) return [msgs];
  const parts: Msg[][] = [];
  let cur: Msg[] = [], size = 0, month = "";
  for (const m of msgs) {
    const mo = m.at.slice(0, 7);
    if (cur.length && mo !== month && size + m.text.length > MAX_CHARS) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += m.text.length;
    month = mo;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

for (const [channel, subject] of Object.entries(channels)) {
  if (only && !only.includes(channel)) continue;
  const dumpPath = `${dumpsDir}/${channel}.json`;
  let msgs: Msg[];
  try {
    msgs = JSON.parse(await Deno.readTextFile(dumpPath));
  } catch {
    await log({ channel, subject, skipped: "no dump" });
    continue;
  }
  const factsPath = `${factsDir}/${channel}.json`;
  let haveFacts = false;
  try {
    await Deno.stat(factsPath);
    haveFacts = true;
  } catch { /* distil below */ }

  if (!haveFacts) {
    if (dryRun) {
      await log({ channel, subject, messages: msgs.length, chars: msgs.reduce((n, m) => n + m.text.length, 0), parts: split(msgs).length, wouldDistil: true });
      continue;
    }
    const parts = split(msgs);
    const merged: Fact[] = [];
    let offset = 0;
    for (const [pi, part] of parts.entries()) {
      const partPath = `${factsDir}/${channel}.part${pi}.json`;
      const partDump = `${factsDir}/${channel}.part${pi}.dump.json`;
      await Deno.writeTextFile(partDump, JSON.stringify(part));
      const prior = merged.length ? `${factsDir}/${channel}.prior.json` : undefined;
      if (prior) await Deno.writeTextFile(prior, JSON.stringify({ facts: merged.map((f, i) => ({ index: i, claim: f.claim, occurred_at: f.occurred_at })) }));
      const r = await run(["tools/distil-channel.ts", partDump, subject, partPath, ...(prior ? [`--prior=${prior}`] : [])]);
      const usage = /\{"model".*\}/.exec(r.stderr)?.[0];
      if (r.code !== 0) {
        await log({ channel, subject, part: pi, failed: r.stderr.slice(-400) });
        break;
      }
      const got = JSON.parse(await Deno.readTextFile(partPath)) as { facts: Fact[] };
      // With a prior list, the model numbers its facts from merged.length, so `supersedes` is already global.
      for (const f of got.facts) merged.push({ ...f, sources: f.sources.map((s) => s + offset) });
      offset += part.length;
      await log({ channel, subject, part: pi, messages: part.length, facts: got.facts.length, usage });
    }
    if (merged.length === 0) continue;
    await Deno.writeTextFile(factsPath, JSON.stringify({ subject, model: "claude-opus-5", channel, facts: merged }, null, 2));
  }

  const r = await run(["tools/ledger-import.ts", factsPath, ...(url ? [`--url=${url}`] : []), ...(dryRun ? ["--dry-run"] : [])]);
  const summary = /\{"subject".*\}/.exec(r.stderr)?.[0];
  await log({ channel, subject, imported: summary ?? r.stderr.slice(-300), code: r.code });
}
await log({ done: true });
