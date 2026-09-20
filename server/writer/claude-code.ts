/**
 * The Claude Code writer: turns a finished session's transcript into one
 * fact for the ledger, with the session as its provenance. Pure: reads
 * lines, returns what to capture or why not. entry/session-end-capture.ts
 * is the hook that runs it and posts the result.
 *
 * What a session contributes: what was asked (the first real prompt) and
 * what came out (the last thing the assistant said), under the project it
 * happened in. The session's own title, when Claude Code gave it one, rides
 * along as a tag and in the claim. Subject is the project, not the title,
 * so `fact_history("project:<name>")` reads as that project's timeline.
 */

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  reason?: string;
};

export type Distilled =
  | { skip: string }
  | { subject: string; content: string; source: string; proof: string; actor: string; tags: string[]; title?: string };

export const MIN_PROMPT_CHARS = 40;
const ASKED_MAX = 600;
const OUTCOME_MAX = 1500;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");

/** Injected context is not what the person said. */
const stripInjected = (s: string) =>
  s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<pasted_content[^>]*>|<\/pasted_content>/g, " ")
    .replace(/\[Image[^\]]*\]/g, " ");

type Line = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

export function projectOf(cwd: string): string {
  const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name ? `project:${name}` : "project:unknown";
}

export function distil(lines: Iterable<string>, meta: SessionMeta): Distilled {
  const prompts: string[] = [];
  const answers: string[] = [];
  let title: string | undefined;
  let bad = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let o: Line;
    try {
      o = JSON.parse(raw);
    } catch {
      bad++;
      continue;
    }
    if (o.isSidechain === true) continue;
    const t = o.type;
    if (t === "custom-title" && typeof o.customTitle === "string") title = o.customTitle;
    else if (t === "ai-title" && typeof o.aiTitle === "string" && !title) title = o.aiTitle;
    else if (t === "ai-title" && typeof o.title === "string" && !title) title = o.title;
    else if (t === "summary" && typeof o.summary === "string" && !title) title = o.summary;
    const m = o.message as Line | undefined;
    if (!m || typeof m !== "object") continue;
    if (t === "user" && o.isMeta !== true) {
      const text = collapse(stripInjected(textOf(m.content)));
      if (text) prompts.push(text);
    } else if (t === "assistant") {
      const text = collapse(textOf(m.content));
      if (text) answers.push(text);
    }
  }
  if (!prompts.length) return { skip: `no user prompt${bad ? ` (${bad} unreadable lines)` : ""}` };
  if (!answers.length) return { skip: "no assistant answer" };
  if (prompts.join(" ").length < MIN_PROMPT_CHARS) return { skip: `too short (${prompts.join(" ").length} chars of prompt)` };

  const project = projectOf(meta.cwd);
  const head = `Claude Code session in ${project.slice("project:".length)}${title ? ` — ${collapse(title)}` : ""}${meta.reason ? ` (ended: ${meta.reason})` : ""}.`;
  const content = `${head}\n\nAsked: ${cut(prompts[0], ASKED_MAX)}\n\nOutcome: ${cut(answers[answers.length - 1], OUTCOME_MAX)}`;
  const tags = ["claude-code", ...(title ? [`session-title:${collapse(title)}`] : [])];
  return {
    subject: project,
    content,
    source: `claude-code:${meta.sessionId}`,
    proof: toFileUrl(meta.transcriptPath),
    actor: `claude-code:${meta.sessionId}`,
    tags,
    title,
  };
}

export function toFileUrl(p: string): string {
  if (/^[a-z]+:\/\//i.test(p)) return p;
  const norm = p.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

/** The JSON-RPC body that records the distilled session through capture_thought. */
export function captureRequest(d: Exclude<Distilled, { skip: string }>, id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name: "capture_thought", arguments: { content: d.content, subject: d.subject, source: d.source, proof: d.proof } },
  };
}

/** The text of a tools/call result, whether it came back as JSON or as an SSE data line. */
export function resultText(body: string): { ok: boolean; text: string } {
  const payload = body.trimStart().startsWith("{") ? body : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "";
  let j: { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
  try {
    j = JSON.parse(payload);
  } catch {
    return { ok: false, text: `unreadable response: ${cut(body, 200)}` };
  }
  if (j.error) return { ok: false, text: j.error.message ?? "error" };
  const text = j.result?.content?.[0]?.text ?? "";
  return { ok: j.result?.isError !== true, text };
}
