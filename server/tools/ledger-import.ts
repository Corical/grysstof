/**
 * Write distilled facts into a Grysstof ledger over /mcp, in list order, then link supersessions.
 *
 *   deno run --env-file=.env.xactco --allow-net --allow-env --allow-read --allow-write \
 *     tools/ledger-import.ts <facts.json> [--url=http://host:8788/mcp] [--dry-run]
 *
 * Input is distil-channel.ts output: {subject, facts:[{claim, occurred_at, sources, supersedes, tags, proofs}]}.
 * Idempotent: the subject's history is read first and a claim that already exists verbatim is skipped, so a
 * re-run writes nothing twice. Writes <facts>.written.json with the id per index. Env: MCP_ACCESS_KEY, PORT.
 */
const [inPath] = Deno.args.filter((a: string) => !a.startsWith("--"));
const dryRun = Deno.args.includes("--dry-run");
const urlFlag = Deno.args.find((a: string) => a.startsWith("--url="))?.slice(6);
const key = Deno.env.get("MCP_ACCESS_KEY");
const url = urlFlag ?? Deno.env.get("GRYSSTOF_URL") ?? `http://localhost:${Deno.env.get("PORT") ?? "8788"}/mcp`;
if (!inPath || !key) {
  console.error("usage: ledger-import.ts <facts.json> [--url=...] [--dry-run]; needs MCP_ACCESS_KEY");
  Deno.exit(2);
}

type DistilledFact = { claim: string; occurred_at: string; sources: number[]; supersedes: number | null; tags: string[]; proofs: string[]; subject?: string };
const input = JSON.parse(await Deno.readTextFile(inPath)) as { subject: string; model?: string; facts: DistilledFact[] };
const subject = input.subject;

function textOf(raw: string): string {
  const data = raw.includes("\ndata:") || raw.startsWith("event:") ? (raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}") : raw;
  const msg = JSON.parse(data);
  if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`);
  const r = msg.result ?? {};
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "isError");
  return r.content?.[0]?.text ?? "";
}

async function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key!, "x-brain-actor": `ledger-import:${input.model ?? "distil"}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${tool}: http ${res.status}`);
  return textOf(await res.text());
}

/** fact_history text -> claim -> id, for the verbatim-skip. Blocks look like "--- Fact <id> ---\nSubject: ...\n\n  <claim>". */
function existingClaims(history: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of history.split(/\n(?=--- Fact )/)) {
    const id = /^--- Fact (\S+) ---/.exec(block)?.[1];
    if (!id) continue;
    const claim = block.split("\n").filter((l) => l && !/^(--- Fact|Subject:|Status:|Learned:|Occurred:|Source:|Proof:|Tags:|Confirmed|Supersedes|Superseded)/.test(l)).join(" ").trim();
    if (claim) out.set(claim, id);
  }
  return out;
}

const known = existingClaims(await call("fact_history", { subject }));
console.error(`${subject}: ${known.size} line(s) already in the ledger`);

const ids: (string | null)[] = [];
const preExisting = new Set<number>();
let written = 0, skipped = 0;
for (const [i, f] of input.facts.entries()) {
  const claim = f.claim.trim();
  const existing = known.get(claim);
  if (existing) {
    ids.push(existing);
    preExisting.add(i);
    skipped++;
    continue;
  }
  if (!f.proofs?.length) {
    console.error(`[${i}] no proof, not written: ${claim.slice(0, 80)}`);
    ids.push(null);
    continue;
  }
  const source = f.proofs[0].replace("https://discord.com/channels/", "discord:");
  if (dryRun) {
    console.error(`[${i}] would write (${f.occurred_at}) ${claim.slice(0, 100)}`);
    ids.push(`dry-${i}`);
    written++;
    continue;
  }
  const answer = await call("capture_thought", { content: claim, subject, source, proof: f.proofs[0], occurred_at: f.occurred_at });
  const id = /Recorded fact (\S+) about/.exec(answer)?.[1];
  if (!id) throw new Error(`[${i}] unexpected answer: ${answer}`);
  ids.push(id);
  written++;
}

let linked = 0, linkFailed = 0;
for (const [i, f] of input.facts.entries()) {
  if (f.supersedes === null || f.supersedes === undefined || f.supersedes === i) continue;
  const newer = ids[i], older = ids[f.supersedes];
  if (!newer || !older) continue;
  if (preExisting.has(i) && preExisting.has(f.supersedes)) continue;
  if (dryRun) {
    console.error(`[${i}] would supersede [${f.supersedes}]`);
    linked++;
    continue;
  }
  try {
    await call("supersede_fact", { newer_id: newer, older_id: older });
    linked++;
  } catch (e) {
    linkFailed++;
    console.error(`[${i}] supersede [${f.supersedes}] failed: ${String(e).slice(0, 160)}`);
  }
}

console.error(JSON.stringify({ subject, url, dryRun, facts: input.facts.length, written, skipped, linked, linkFailed }));
if (!dryRun) await Deno.writeTextFile(`${inPath}.written.json`, JSON.stringify({ subject, ids }, null, 2));
