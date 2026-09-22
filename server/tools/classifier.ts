/**
 * The gate's questions and the two things that can answer them.
 *
 * A Classifier answers typed questions about one message: a choice from a closed set, a score on an
 * ordered scale, a yes/no probability. It never writes text. Jev (TypeSafe) is the intended answerer;
 * Haiku with structured output is the stand-in while Jev signups are closed (22 Sep 2026). Same
 * questions, same answer shape, so the gate and everything after it cannot tell which one ran.
 */

export const CLIENTS = ["servest", "qualikleen", "grainfield", "mphe", "swanzo", "xsit", "fairlawns", "retailcreative", "marlin", "jag", "xylem", "evergreen-turf", "express-kempton", "montego", "omnigo", "pandrol", "neledzi", "wov", "enviroloo", "supercare", "empact-venetia", "empact-amandelbult", "ecowize", "zamani", "relativ-media"] as const;
export const KINDS = { decision: "a choice was made or a rule was set", status: "a state changed: done, live, blocked, resolved, postponed", commitment: "someone will do something by some time", problem: "a defect, failure, or complaint", contact: "a person is named with a role or responsibility", question: "asks for information or a decision", chatter: "acknowledgement, thanks, greeting, fyi with no content" } as const;
export const URGENCY = ["routine", "this week", "today", "blocking users now"] as const;

export const QUESTIONS = {
  durable: "Does this message state something that will still be true and worth knowing about the client next month: a decision, a status change, a commitment with an owner, a scope or contract change, a go-live, a root cause, a named contact and role? Chatter, thanks, fyi, questions, and day-to-day task noise are no.",
  subject: "Which client is this message about? Pick none if it is about no specific client or about the File13 team itself.",
  kind: "What kind of message is this?",
  urgency: "How urgent is what this message describes?",
  decision_by_file13: "Does the message record a decision or instruction made by the File13 team (Kelli, Luke, Charne, Saxon, Devon, Corne) rather than by the client?",
};

export type Answers = {
  durable: number; // 0..1
  subject: { choice: (typeof CLIENTS)[number] | "none"; confidence: number };
  kind: { choice: keyof typeof KINDS; confidence: number };
  urgency: { score: number; confidence: number }; // 0..3 along URGENCY
  decision_by_file13: number; // 0..1
};

export type Classified = { answers: Answers; input_tokens: number; output_tokens: number; by: string };

export interface Classifier {
  readonly name: string;
  readonly usdPerMillionInput: number;
  readonly usdPerMillionOutput: number;
  classify(text: string): Promise<Classified>;
}

async function withBackoff(call: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0;; attempt++) {
    const res = await call();
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 8) {
      await new Promise((r) => setTimeout(r, Math.min(30000, 500 * 2 ** attempt)));
      continue;
    }
    return res;
  }
}

/** TypeSafe Jev: POST /v1/systemone, typed questions, calibrated confidence. */
export class JevClassifier implements Classifier {
  readonly name = "jev";
  readonly usdPerMillionInput = 0.042;
  readonly usdPerMillionOutput = 0;
  constructor(private readonly key: string) {}
  async classify(text: string): Promise<Classified> {
    const res = await withBackoff(() =>
      fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "jev-latest",
          state: text,
          questions: {
            durable: { type: "noul", instructions: QUESTIONS.durable },
            subject: { type: "choice", instructions: QUESTIONS.subject, criteria: Object.fromEntries([...CLIENTS, "none"].map((c) => [c, null])) },
            kind: { type: "choice", instructions: QUESTIONS.kind, criteria: KINDS },
            urgency: { type: "score", instructions: QUESTIONS.urgency, criteria: URGENCY },
            decision_by_file13: { type: "noul", instructions: QUESTIONS.decision_by_file13 },
          },
        }),
      })
    );
    if (!res.ok) throw new Error(`jev ${res.status}: ${await res.text()}`);
    const body = await res.json() as { model: string; answers: Record<string, Record<string, unknown>>; usage: { input_tokens: number; output_tokens: number } };
    const a = body.answers;
    return {
      by: body.model,
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
      answers: {
        durable: a.durable.noul as number,
        subject: { choice: a.subject.choice as Answers["subject"]["choice"], confidence: a.subject.confidence as number },
        kind: { choice: a.kind.choice as Answers["kind"]["choice"], confidence: a.kind.confidence as number },
        urgency: { score: a.urgency.score as number, confidence: a.urgency.confidence as number },
        decision_by_file13: a.decision_by_file13.noul as number,
      },
    };
  }
}

/** Claude with structured output constrained to the same enums. Confidence is self-reported, not calibrated. */
export class ClaudeClassifier implements Classifier {
  readonly name: string;
  readonly usdPerMillionInput: number;
  readonly usdPerMillionOutput: number;
  constructor(private readonly key: string, private readonly model = "claude-haiku-4-5") {
    this.name = model;
    [this.usdPerMillionInput, this.usdPerMillionOutput] = model.startsWith("claude-haiku") ? [1, 5] : model.startsWith("claude-sonnet") ? [2, 10] : [5, 25];
  }
  async classify(text: string): Promise<Classified> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["durable", "subject", "subject_confidence", "kind", "kind_confidence", "urgency", "urgency_confidence", "decision_by_file13"],
      properties: {
        durable: { type: "number", description: "probability that the answer is yes, 0 to 1" },
        subject: { type: "string", enum: [...CLIENTS, "none"] },
        subject_confidence: { type: "number", description: "0 to 1" },
        kind: { type: "string", enum: Object.keys(KINDS) },
        kind_confidence: { type: "number", description: "0 to 1" },
        urgency: { type: "string", enum: URGENCY.map((_, i) => String(i)), description: URGENCY.map((u, i) => `${i}=${u}`).join(", ") },
        urgency_confidence: { type: "number", description: "0 to 1" },
        decision_by_file13: { type: "number", description: "probability that the answer is yes, 0 to 1" },
      },
    };
    const system = `You answer typed questions about one chat message from a client channel. Answer every question; never explain.
durable: ${QUESTIONS.durable}
subject: ${QUESTIONS.subject}
kind: ${QUESTIONS.kind} Meanings: ${Object.entries(KINDS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
urgency: ${QUESTIONS.urgency}
decision_by_file13: ${QUESTIONS.decision_by_file13}
Confidence fields: how sure you are of that choice, 0 to 1. Be honest; 0.5 means a coin flip.`;
    const res = await withBackoff(() =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 300,
          system,
          messages: [{ role: "user", content: text }],
          output_config: { format: { type: "json_schema", schema } },
        }),
      })
    );
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const body = await res.json() as { model: string; content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
    const reply = body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const j = JSON.parse(reply) as { durable: number; subject: Answers["subject"]["choice"]; subject_confidence: number; kind: Answers["kind"]["choice"]; kind_confidence: number; urgency: string; urgency_confidence: number; decision_by_file13: number };
    const unit = (n: number) => Math.min(1, Math.max(0, Number(n) || 0));
    return {
      by: body.model,
      input_tokens: body.usage.input_tokens,
      output_tokens: body.usage.output_tokens,
      answers: {
        durable: unit(j.durable),
        subject: { choice: j.subject, confidence: unit(j.subject_confidence) },
        kind: { choice: j.kind, confidence: unit(j.kind_confidence) },
        urgency: { score: Math.min(URGENCY.length - 1, Math.max(0, Number(j.urgency) || 0)), confidence: unit(j.urgency_confidence) },
        decision_by_file13: unit(j.decision_by_file13),
      },
    };
  }
}

/** CLASSIFIER=jev needs JEV_API_KEY; anything else uses CHAT_API_KEY with CLASSIFIER_MODEL (default Haiku). */
export function classifierFromEnv(env: { get(k: string): string | undefined }): Classifier {
  const which = env.get("CLASSIFIER") ?? (env.get("JEV_API_KEY") ? "jev" : "claude");
  if (which === "jev") {
    const key = env.get("JEV_API_KEY");
    if (!key) throw new Error("CLASSIFIER=jev needs JEV_API_KEY");
    return new JevClassifier(key);
  }
  const key = env.get("CHAT_API_KEY");
  if (!key) throw new Error("CHAT_API_KEY is required for the Claude classifier");
  return new ClaudeClassifier(key, env.get("CLASSIFIER_MODEL") ?? "claude-haiku-4-5");
}

/** The gate: does this message deserve a sentence from the distiller? One rule, tuned on Servest. */
export function passesGate(a: Answers, durableThreshold = 0.6): boolean {
  if (a.kind.choice === "chatter" && a.durable < 0.8) return false;
  return a.durable >= durableThreshold || ["decision", "status", "commitment", "problem", "contact"].includes(a.kind.choice) && a.kind.confidence >= 0.7;
}
