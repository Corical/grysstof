/**
 * Claude Code SessionEnd hook: one fact per finished session, into the
 * instance the env file names. Register in ~/.claude/settings.json:
 *
 *   "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "timeout": 30,
 *     "command": "<deno.exe> run --env-file=<server>/.env.personal --allow-read --allow-net --allow-env --allow-write <server>/entry/session-end-capture.ts" }] }]
 *
 * Claude Code passes {session_id, transcript_path, cwd, reason} on stdin.
 * This never blocks a shutdown: every path exits 0 within HARD_TIMEOUT_MS
 * and writes one line to the writer log saying what happened.
 */
import { captureRequest, distil, resultText } from "../writer/claude-code.ts";

const HARD_TIMEOUT_MS = 20_000;
const logDir = `${Deno.env.get("LOCALAPPDATA") ?? Deno.env.get("HOME") ?? "."}/grysstof`;
const started = Date.now();

async function log(fields: Record<string, unknown>) {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(`${logDir}/writer.log`, JSON.stringify({ ts: new Date().toISOString(), ms: Date.now() - started, ...fields }) + "\n", { append: true });
  } catch {
    // the log is a courtesy; a missing log never fails the hook
  }
}

const deadline = setTimeout(async () => {
  await log({ disposition: "timeout", ms: HARD_TIMEOUT_MS });
  Deno.exit(0);
}, HARD_TIMEOUT_MS);

try {
  const raw = await new Response(Deno.stdin.readable).text();
  const input = JSON.parse(raw || "{}") as { session_id?: string; transcript_path?: string; cwd?: string; reason?: string; hook_event_name?: string };
  const meta = { sessionId: input.session_id ?? "unknown", cwd: input.cwd ?? Deno.cwd(), transcriptPath: input.transcript_path ?? "", reason: input.reason };
  if (!meta.transcriptPath) {
    await log({ session: meta.sessionId, disposition: "skipped:no_transcript_path" });
    Deno.exit(0);
  }
  let text: string;
  try {
    text = await Deno.readTextFile(meta.transcriptPath);
  } catch (e) {
    await log({ session: meta.sessionId, disposition: "skipped:no_transcript", error: (e as Error).message });
    Deno.exit(0);
  }
  const d = distil(text.split("\n"), meta);
  if ("skip" in d) {
    await log({ session: meta.sessionId, disposition: `skipped:${d.skip}` });
    Deno.exit(0);
  }
  const key = Deno.env.get("MCP_ACCESS_KEY");
  const url = Deno.env.get("GRYSSTOF_URL") ?? `http://localhost:${Deno.env.get("PORT") ?? "8787"}/mcp`;
  if (!key) {
    await log({ session: meta.sessionId, disposition: "error:missing_env", missing: "MCP_ACCESS_KEY" });
    Deno.exit(0);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": key, "x-brain-actor": d.actor },
    body: JSON.stringify(captureRequest(d)),
    signal: AbortSignal.timeout(HARD_TIMEOUT_MS - 2_000),
  });
  const r = resultText(await res.text());
  if (!res.ok || !r.ok) {
    await log({ session: meta.sessionId, disposition: "error:capture", status: res.status, text: r.text.slice(0, 300), subject: d.subject });
    try {
      await Deno.writeTextFile(`${logDir}/writer-failures.jsonl`, JSON.stringify({ ts: new Date().toISOString(), meta, request: captureRequest(d), status: res.status, text: r.text }) + "\n", { append: true });
    } catch { /* see log() */ }
    Deno.exit(0);
  }
  const id = /Recorded fact ([0-9a-f-]{36})/.exec(r.text)?.[1];
  await log({ session: meta.sessionId, disposition: "captured", factId: id, subject: d.subject, title: d.title, url });
} catch (e) {
  await log({ disposition: "error:unexpected", error: (e as Error)?.message ?? String(e) });
} finally {
  clearTimeout(deadline);
}
Deno.exit(0);
