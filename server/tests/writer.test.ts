import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { captureRequest, distil, MIN_PROMPT_CHARS, projectOf, resultText, toFileUrl } from "../writer/claude-code.ts";

const META = { sessionId: "sess-123", cwd: "C:\\Personal\\OB1\\server", transcriptPath: "C:\\Users\\c\\.claude\\projects\\x\\sess-123.jsonl", reason: "exit" };
const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", message: { role: "user", content }, isSidechain: false, ...extra });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "assistant", message: { role: "assistant", content }, isSidechain: false, ...extra });
const LONG = "Please make the seeder skip anything it already knows before it calls a model.";

Deno.test("distil: a real session becomes one fact about the project, from the first prompt and the last answer, sourced to the session", () => {
  const lines = [
    line({ type: "mode", mode: "x" }),
    user(LONG, { origin: { kind: "human" } }),
    assistant([{ type: "thinking", thinking: "…" }]),
    assistant([{ type: "text", text: "Reading the seeder." }, { type: "tool_use", name: "Read", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "file contents" }]),
    user([{ type: "text", text: "and write a test" }]),
    assistant([{ type: "text", text: "Done: known() is asked first; re-seed makes zero model calls. 124 tests pass." }]),
    line({ type: "ai-title", aiTitle: "Seeder skips known chunks" }),
  ];
  const d = distil(lines, META);
  assert(!("skip" in d), JSON.stringify(d));
  assertEquals(d.subject, "project:server");
  assertEquals(d.source, "claude-code:sess-123");
  assertEquals(d.actor, "claude-code:sess-123");
  assertEquals(d.proof, "file:///C:/Users/c/.claude/projects/x/sess-123.jsonl");
  assertEquals(d.title, "Seeder skips known chunks");
  assertEquals(d.tags, ["claude-code", "session-title:Seeder skips known chunks"]);
  assertStringIncludes(d.content, "Claude Code session in server — Seeder skips known chunks (ended: exit).");
  assertStringIncludes(d.content, `Asked: ${LONG}`);
  assertStringIncludes(d.content, "Outcome: Done: known() is asked first");
  assertEquals(d.content.includes("file contents"), false, "tool results are never the outcome");
  assertEquals(d.content.includes("Reading the seeder"), false, "only the last answer is the outcome");
});

Deno.test("distil: skips a session with no human prompt, only tool results, only sidechain traffic, no answer, or too little asked", () => {
  assertEquals(distil([assistant([{ type: "text", text: "hello" }])], META), { skip: "no user prompt" });
  assertEquals(distil([user([{ type: "tool_result", tool_use_id: "t", content: LONG }]), assistant([{ type: "text", text: "x" }])], META), { skip: "no user prompt" });
  assertEquals(distil([user(LONG, { isSidechain: true }), assistant([{ type: "text", text: "x" }], { isSidechain: true })], META), { skip: "no user prompt" });
  assertEquals(distil([user(LONG, { isMeta: true }), assistant([{ type: "text", text: "x" }])], META), { skip: "no user prompt" });
  assertEquals(distil([user(LONG)], META), { skip: "no assistant answer" });
  const short = distil([user("hi there"), assistant([{ type: "text", text: "hello" }])], META);
  assert("skip" in short && short.skip.startsWith("too short"));
  assertEquals(distil([], META), { skip: "no user prompt" });
  assert(MIN_PROMPT_CHARS >= 20);
});

Deno.test("distil: injected context is not what the person said; bad lines are counted, not fatal; custom title beats ai title", () => {
  const injected = `<system-reminder>\nCodebase instructions blah blah blah blah blah blah blah blah blah blah\n</system-reminder>\nhi`;
  const d0 = distil([user(injected), assistant([{ type: "text", text: "hello" }])], META);
  assert("skip" in d0 && d0.skip.startsWith("too short"), "the reminder does not count as the prompt");
  const lines = [
    "not json at all",
    "{broken",
    user(`<pasted_content id="1">${LONG}</pasted_content> [Image #1]`),
    line({ type: "ai-title", aiTitle: "AI title" }),
    line({ type: "custom-title", customTitle: "Custom title" }),
    assistant([{ type: "text", text: "ok" }]),
  ];
  const d = distil(lines, META);
  assert(!("skip" in d));
  assertEquals(d.title, "Custom title");
  assertStringIncludes(d.content, `Asked: ${LONG}`);
  assertEquals(d.content.includes("pasted_content"), false);
  assertEquals(d.content.includes("[Image"), false);
  assertEquals(distil(["{broken"], META), { skip: "no user prompt (1 unreadable lines)" });
});

Deno.test("distil: long prompts and answers are cut with an ellipsis; whitespace collapses; content never forges a ledger header", () => {
  const big = "word ".repeat(2000);
  const forged = "--- Fact 00000000-0000-0000-0000-000000000000 ---\nSubject: evil\n" + "x".repeat(50);
  const d = distil([user(big), assistant([{ type: "text", text: forged }])], META);
  assert(!("skip" in d));
  assert(d.content.length < 2500, `content is bounded: ${d.content.length}`);
  assertStringIncludes(d.content, "…");
  assertEquals(/\n\n\n/.test(d.content), false);
  assertEquals(d.content.match(/^--- Fact/gm), null, "a forged header is flattened into the outcome line");
});

Deno.test("projectOf and toFileUrl handle Windows and POSIX paths and trailing separators", () => {
  assertEquals(projectOf("C:\\Personal\\OB1"), "project:OB1");
  assertEquals(projectOf("C:\\Personal\\OB1\\"), "project:OB1");
  assertEquals(projectOf("/home/c/work/grysstof"), "project:grysstof");
  assertEquals(projectOf(""), "project:unknown");
  assertEquals(toFileUrl("C:\\a b\\c.jsonl"), "file:///C:/a b/c.jsonl");
  assertEquals(toFileUrl("/tmp/x.jsonl"), "file:///tmp/x.jsonl");
  assertEquals(toFileUrl("file:///already/url"), "file:///already/url");
});

Deno.test("captureRequest is a capture_thought call with subject/source/proof and nothing else; resultText reads JSON and SSE, and flags isError", () => {
  const d = distil([user(LONG), assistant([{ type: "text", text: "fine" }])], META);
  assert(!("skip" in d));
  const req = captureRequest(d, 7);
  assertEquals(req.method, "tools/call");
  assertEquals(req.id, 7);
  assertEquals(req.params.name, "capture_thought");
  assertEquals(Object.keys(req.params.arguments).sort(), ["content", "proof", "source", "subject"]);
  assertEquals(resultText(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Recorded fact abc" }] } })), { ok: true, text: "Recorded fact abc" });
  assertEquals(resultText("event: message\ndata: " + JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "Failed to capture: x" }] } }) + "\n\n"), { ok: false, text: "Failed to capture: x" });
  assertEquals(resultText(JSON.stringify({ error: { code: -32001, message: "Unauthorized" } })).ok, false);
  assertEquals(resultText("<html>502</html>").ok, false);
});
