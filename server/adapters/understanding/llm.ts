/**
 * Understanders backed by a chat model. One HTTP flow, two ways of addressing
 * the model (OpenAI-compatible bearer auth, Azure OpenAI deployment + api-key).
 * Transport failures throw (the core fails the capture loudly); model
 * nonsense degrades to UNDERSTOOD_NOTHING.
 */
import { type Understander, type Understanding, UNDERSTOOD_NOTHING } from "../../core/ports/mod.ts";
import type { Log } from "../../core/ports/mod.ts";

type Transport = { url: string | URL; headers: Record<string, string>; model?: string };

/**
 * The Understanding shape as a JSON schema. `json_schema` is the one
 * structured-output form every OpenAI-compatible host accepts (OpenAI,
 * OpenRouter, Azure OpenAI, Anthropic's compatibility endpoint, Ollama);
 * `json_object` is rejected by some of them.
 */
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "understanding",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["people", "action_items", "dates_mentioned", "topics", "type"],
      properties: {
        people: { type: "array", items: { type: "string" } },
        action_items: { type: "array", items: { type: "string" } },
        dates_mentioned: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: ["observation", "task", "idea", "reference", "person_note"] },
      },
    },
  },
} as const;

abstract class ChatUnderstander implements Understander {
  protected readonly fetchFn: typeof fetch;
  constructor(protected readonly prompt: string, protected readonly log: Log, fetchFn?: typeof fetch) {
    this.fetchFn = fetchFn ?? fetch;
  }
  protected abstract transport(): Transport;

  async understand(text: string): Promise<Understanding> {
    const t = this.transport();
    const r = await this.fetchFn(t.url, {
      method: "POST",
      headers: { ...t.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(t.model ? { model: t.model } : {}),
        response_format: RESPONSE_FORMAT,
        messages: [{ role: "system", content: this.prompt }, { role: "user", content: text }],
      }),
    });
    if (!r.ok) throw new Error(`Understanding model failed: ${r.status} ${await r.text().catch(() => "")}`);
    const content = answered(await r.json().catch(() => { throw new Error("Understanding model returned a body that is not JSON"); }));
    try {
      return shape(JSON.parse(content));
    } catch (err) {
      this.log.warn("understanding.nonsense", { reason: (err as Error).message });
      return { ...UNDERSTOOD_NOTHING };
    }
  }
}

/**
 * The model's text, or a thrown Error when the model did not actually answer:
 * an error envelope under HTTP 200, no choices, a refusal, a null or empty
 * message, or an answer cut off by the token limit. None of those may become
 * a stored thought.
 */
export function answered(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.error) {
    const e = b.error as Record<string, unknown>;
    throw new Error(`Understanding model returned an error: ${typeof e === "object" && e && "message" in e ? String(e.message) : JSON.stringify(b.error)}`);
  }
  const choice = Array.isArray(b.choices) ? (b.choices[0] as Record<string, unknown> | undefined) : undefined;
  if (!choice) throw new Error("Understanding model returned no choices");
  if (choice.finish_reason === "length") throw new Error("Understanding model answer was cut off (finish_reason: length)");
  if (choice.finish_reason === "content_filter") throw new Error("Understanding model refused (finish_reason: content_filter)");
  const message = (choice.message ?? {}) as Record<string, unknown>;
  if (typeof message.refusal === "string" && message.refusal) throw new Error(`Understanding model refused: ${message.refusal}`);
  if (typeof message.content !== "string" || !message.content.trim()) throw new Error("Understanding model returned an empty answer");
  return message.content;
}

export class OpenAICompatibleUnderstander extends ChatUnderstander {
  constructor(private readonly o: { baseUrl: string; apiKey: string; model: string }, prompt: string, log: Log, fetchFn?: typeof fetch) {
    super(prompt, log, fetchFn);
  }
  protected transport(): Transport {
    return { url: `${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, headers: { Authorization: `Bearer ${this.o.apiKey}` }, model: this.o.model };
  }
}

export class AzureOpenAIUnderstander extends ChatUnderstander {
  constructor(private readonly o: { endpoint: string; apiKey: string; deployment: string; apiVersion?: string }, prompt: string, log: Log, fetchFn?: typeof fetch) {
    super(prompt, log, fetchFn);
  }
  protected transport(): Transport {
    const u = new URL(`/openai/deployments/${encodeURIComponent(this.o.deployment)}/chat/completions`, this.o.endpoint);
    u.searchParams.set("api-version", this.o.apiVersion ?? "2024-10-21");
    return { url: u, headers: { "api-key": this.o.apiKey } };
  }
}

const TYPES = new Set(["observation", "task", "idea", "reference", "person_note"]);
const MAX_ITEMS = 20;
const MAX_LEN = 200;

/** Whatever the model returned, only the promised shape survives, bounded. */
export function shape(raw: unknown): Understanding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...UNDERSTOOD_NOTHING };
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown, max = MAX_ITEMS) =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.slice(0, MAX_LEN)).slice(0, max);
  const topics = strings(r.topics, 3);
  const dates = strings(r.dates_mentioned).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return {
    people: strings(r.people),
    action_items: strings(r.action_items),
    dates_mentioned: dates,
    topics: topics.length ? topics : ["uncategorized"],
    type: typeof r.type === "string" && TYPES.has(r.type) ? (r.type as Understanding["type"]) : "observation",
  };
}

/** Understands nothing. Offline runs and tests. */
export class NullUnderstander implements Understander {
  understand(): Promise<Understanding> {
    return Promise.resolve({ ...UNDERSTOOD_NOTHING });
  }
}

/** Returns a fixed understanding. Tests control topics and people. */
export class FixedUnderstander implements Understander {
  constructor(private readonly u: Understanding) {}
  understand(): Promise<Understanding> {
    return Promise.resolve({ ...this.u });
  }
}
