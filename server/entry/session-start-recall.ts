/**
 * Claude Code SessionStart hook: the other half of the writer. At the start
 * of a session, ask the ledger what earlier sessions in this project learned
 * and hand it to the new session as context. Register in ~/.claude/settings.json:
 *
 *   "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 20,
 *     "command": "<deno.exe> run --env-file=<server>/.env.personal --allow-read --allow-net --allow-env --allow-write <server>/entry/session-start-recall.ts" }] }]
 *
 * Claude Code passes {session_id, cwd, source} on stdin and reads JSON on
 * stdout: hookSpecificOutput.additionalContext is appended to the session's
 * context. This never blocks a start: every path exits 0 within
 * HARD_TIMEOUT_MS, prints nothing when there is nothing (or the ledger is
 * down), and writes one line to the writer log saying what happened.
 */
import { projectOf } from "../writer/claude-code.ts";

const HARD_TIMEOUT_MS = 12_000;
const MAX_LINES = 12;
const logDir = `${Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("HOME") ?? "."}/grysstof`;
const started = Date.now();

async function log(fields: Record<string, unknown>) {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(`${logDir}/writer.log`, JSON.stringify({ ts: new Date().toISOString(), ms: Date.now() - started, hook: "start", ...fields }) + "\n", { append: true });
  } catch {
    // the log is a courtesy
  }
}

const deadline = setTimeout(async () => {
  await log({ disposition: "timeout", ms: HARD_TIMEOUT_MS });
  Deno.exit(0);
}, HARD_TIMEOUT_MS);

function rpc(tool: string, args: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
}

function textOf(raw: string): string {
  const data = raw.includes("\ndata:") || raw.startsWith("event:") ? (raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}") : raw;
  const msg = JSON.parse(data);
  if (msg.error) throw new Error(`${msg.error.code}: ${msg.error.message}`);
  const r = msg.result ?? {};
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "isError");
  return r.content?.[0]?.text ?? "";
}

try {
  const raw = await new Response(Deno.stdin.readable).text();
  const input = JSON.parse(raw || "{}") as { session_id?: string; cwd?: string; source?: string };
  const sessionId = input.session_id ?? "unknown";
  const subject = projectOf(input.cwd ?? Deno.cwd());
  const key = Deno.env.get("MCP_ACCESS_KEY");
  const url = Deno.env.get("GRYSSTOF_URL") ?? `http://localhost:${Deno.env.get("PORT") ?? "8787"}/mcp`;
  if (!key) {
    await log({ session: sessionId, subject, disposition: "error:missing_env", missing: "MCP_ACCESS_KEY" });
    Deno.exit(0);
  }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key, "x-brain-actor": `claude-code:${sessionId}` };
  const res = await fetch(url, { method: "POST", headers, body: rpc("fact_history", { subject }) });
  if (!res.ok) throw new Error(`ledger answered ${res.status}`);
  const history = textOf(await res.text());
  const count = Number(/^(\d+) line\(s\)/.exec(history)?.[1] ?? 0);
  if (!count) {
    await log({ session: sessionId, subject, disposition: "nothing_known" });
    Deno.exit(0);
  }
  // Newest first, current lines only, capped: the session gets a briefing, not the archive.
  const blocks = history.split(/\n(?=--- Fact )/).filter((b) => b.startsWith("--- Fact "));
  const current = blocks.filter((b) => !/^Superseded by:/m.test(b)).slice(0, MAX_LINES);
  const briefing = current.map((b) => {
    const learned = /^Learned: (\S+) by (\S+)/m.exec(b);
    const source = /^Source: (.*)$/m.exec(b)?.[1] ?? "";
    const claim = b.split("\n").filter((l) => l && !/^(--- Fact|Subject:|Status:|Learned:|Source:|Proof:|Tags:|Confirmed|Supersedes)/.test(l)).join(" ").trim();
    return `- ${claim}${learned ? ` (${learned[1].slice(0, 10)}, ${learned[2]}${source ? `, ${source}` : ""})` : ""}`;
  }).join("\n");
  const context = `Grysstof ledger — what earlier sessions in ${subject.slice("project:".length)} recorded (${count} line(s), newest first, ${current.length} shown; call fact_history "${subject}" on grysstof-personal for all):\n${briefing}`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  await log({ session: sessionId, subject, disposition: "briefed", lines: count, shown: current.length });
} catch (e) {
  await log({ disposition: "error:unexpected", error: (e as Error).message });
} finally {
  clearTimeout(deadline);
}
Deno.exit(0);
