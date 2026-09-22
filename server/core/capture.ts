/**
 * The one way anything gets written: the capture_thought tool, the seeder
 * and the session writer all come through here, so they agree on what a
 * write is. Without a subject it is a thought (Memory: same text merges);
 * with a subject it is a fact (Ledger: a new line every time).
 */
import type { Fact, Ports, Scope, ThoughtMetadata, Understanding } from "./ports/mod.ts";

export type CaptureInput = {
  content: string;
  /** Where this was learned. Defaults to "mcp", as upstream stamped every capture. */
  source?: string;
  /** Present: the content is a claim about this subject and goes to the ledger. */
  subject?: string;
  proof?: string;
  /** When the thing being captured actually happened (ISO 8601), for imports of history. Defaults to now. */
  occurredAt?: string;
  /** Extra metadata a writer knows (file path, ticket id). Never provenance: those keys are dropped. */
  metadata?: ThoughtMetadata;
};

export type Captured =
  | { kind: "thought"; id: string; alreadyKnown: boolean; understood: Understanding }
  | { kind: "fact"; id: string; fact: Fact; understood: Understanding };

const PROVENANCE_KEYS = new Set(["learnedBy", "learnedAt", "learned_by", "learned_at", "tenant", "actor", "confirmed", "confirmedBy", "confirmedAt", "supersededBy"]);

export async function capture(ports: Pick<Ports, "memory" | "ledger" | "understander" | "log">, scope: Scope, input: CaptureInput): Promise<Captured> {
  const content = input.content;
  if (!content.trim()) throw new Error("content is blank");
  const source = input.source?.trim() || "mcp";
  const extra: ThoughtMetadata = {};
  for (const [k, v] of Object.entries(input.metadata ?? {})) if (!PROVENANCE_KEYS.has(k)) extra[k] = v;
  if (input.occurredAt !== undefined) {
    const t = Date.parse(input.occurredAt);
    if (Number.isNaN(t)) throw new Error(`occurred_at is not a date: ${input.occurredAt}`);
    extra.occurred_at = new Date(t).toISOString();
  }

  const understood = await ports.understander.understand(content);

  if (input.subject?.trim()) {
    const fact = await ports.ledger.assert(scope, {
      subject: input.subject.trim(),
      claim: content,
      source,
      proof: input.proof?.trim() || undefined,
      tags: [...understood.topics, ...understood.people.map((p) => `person:${p}`)],
      ...(typeof extra.occurred_at === "string" ? { occurredAt: extra.occurred_at } : {}),
    });
    ports.log.info("fact.asserted", { id: fact.id, subject: fact.subject, source, tenant: scope.tenant, actor: scope.actor });
    return { kind: "fact", id: fact.id, fact, understood };
  }

  const meta: ThoughtMetadata = { ...extra, ...understood, source };
  if (input.proof?.trim()) meta.proof = input.proof.trim();
  const { id, alreadyKnown } = await ports.memory.remember(scope, content, meta);
  ports.log.info("thought.remembered", { id, alreadyKnown, type: meta.type, source, tenant: scope.tenant, actor: scope.actor });
  return { kind: "thought", id, alreadyKnown, understood };
}
