/**
 * Prototype: turn one channel's messages into ledger facts about a subject.
 *
 *   deno run --env-file=.env.xactco --allow-net --allow-env --allow-read --allow-write \
 *     tools/distil-channel.ts <messages.json> <subject> [facts.json]
 *
 * Input: [{at, proof, text}] in time order (the dump of one channel's thoughts).
 * Output: facts as JSON on stdout (or to facts.json), nothing written to the ledger.
 * Model: Claude via the Messages API, using CHAT_API_KEY from the env.
 */
const [inPath, subject, outPath] = Deno.args.filter((a: string) => !a.startsWith("--"));
const priorPath = Deno.args.find((a: string) => a.startsWith("--prior="))?.slice(8);
if (!inPath || !subject) {
  console.error("usage: distil-channel.ts <messages.json> <subject> [facts.json] [--prior=facts-so-far.json]");
  Deno.exit(2);
}
const prior = priorPath ? (JSON.parse(await Deno.readTextFile(priorPath)) as { facts: { index: number; claim: string; occurred_at: string }[] }).facts : [];
const key = Deno.env.get("CHAT_API_KEY")!;
const model = Deno.env.get("DISTIL_MODEL") ?? "claude-opus-5";
const messages = JSON.parse(await Deno.readTextFile(inPath)) as { at: string; proof: string; text: string }[];

const transcript = messages.map((m, i) => `[${i}] ${m.at.slice(0, 10)} ${m.text.replace(/^Discord #\S+( \([^)]*\))?, \d{4}-\d{2}-\d{2}, /, "")}`).join("\n");

const system = `You read a client channel's chat history and write the ledger of what became true about the client.
A fact is one durable claim: a decision, a status change, a commitment with an owner and date, a scope or contract change, a recurring problem and its resolution, a named contact and their role, a go-live or milestone. Not chatter, not thanks, not "fyi", not a task's day-to-day noise unless it changed something.
Rules:
- One fact per line, in plain English, standalone: a reader who has never seen the channel must understand it. Name people and dates in the claim.
- When a later message changes an earlier fact (a hold lifted, a date moved, a decision reversed), write the new fact and put the index of the fact it replaces in "supersedes".
- "occurred_at" is the date of the message that made it true. "sources" lists the message indexes [n] that support it; at least one.
- Prefer fewer, denser facts. A 468-message channel usually yields 20 to 60 facts, not 300.
- Output only JSON: {"facts":[{"claim":"...","occurred_at":"YYYY-MM-DD","sources":[n,...],"supersedes":null|index_into_this_list,"tags":["..."]}]}`;

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({
    model,
    max_tokens: 32000,
    system,
    messages: [{
      role: "user",
      content: prior.length
        ? `Subject: ${subject}\n\nFacts already recorded from earlier in this channel (do not restate them; a new fact may supersede one by its index):\n${prior.map((p) => `[${p.index}] ${p.occurred_at} ${p.claim}`).join("\n")}\n\nYour facts continue the numbering from ${prior.length}: the first fact you output is index ${prior.length}. "supersedes" refers to that numbering.\n\nChannel history, continued, oldest first:\n\n${transcript}`
        : `Subject: ${subject}\n\nChannel history, oldest first:\n\n${transcript}`,
    }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["facts"],
          properties: {
            facts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["claim", "occurred_at", "sources", "supersedes", "tags"],
                properties: {
                  claim: { type: "string" },
                  occurred_at: { type: "string" },
                  sources: { type: "array", items: { type: "integer" } },
                  supersedes: { type: ["integer", "null"] },
                  tags: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  }),
});
if (!res.ok) {
  console.error(`anthropic ${res.status}: ${await res.text()}`);
  Deno.exit(1);
}
const body = await res.json() as { content: { type: string; text?: string }[]; usage: unknown; stop_reason: string };
const text = body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
await Deno.writeTextFile(`${inPath}.raw.txt`, text);
if (!text.trim()) {
  await Deno.writeTextFile(`${inPath}.raw.json`, JSON.stringify(body, null, 2));
  console.error(`empty reply: stop_reason=${body.stop_reason} content types=${body.content.map((c) => c.type).join(",")} (full body in ${inPath}.raw.json)`);
  Deno.exit(1);
}
const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
const parsed = JSON.parse(json) as { facts: { claim: string; occurred_at: string; sources: number[]; supersedes: number | null; tags: string[] }[] };
const facts = parsed.facts.map((f) => ({ ...f, subject, proofs: f.sources.map((i) => messages[i]?.proof).filter(Boolean) }));
console.error(JSON.stringify({ model, stop: body.stop_reason, usage: body.usage, messages: messages.length, facts: facts.length }));
const out = JSON.stringify({ subject, model, facts }, null, 2);
if (outPath) await Deno.writeTextFile(outPath, out);
else console.log(out);
