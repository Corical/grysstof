/**
 * Understanding: what the core needs from "something that reads a thought and
 * tells me what is in it". The core defines the shape because the core is
 * what stores and displays it. How it is produced (which model, which
 * prompt wording, rules, a human) is the implementation's business.
 *
 * Semantics:
 *  - Always returns the full shape; arrays may be empty; `topics` has at
 *    least one entry; `type` is one of the five values.
 *  - If the implementation is unavailable (network, auth, quota) it THROWS,
 *    so a thought capture fails loudly rather than storing a thought it did
 *    not understand. A fact capture (one with a subject) does not fail: the
 *    core writes the fact with empty tags and logs `fact.understand_failed`,
 *    because a ledger line is often a state change a person asked for and
 *    must not be lost to a model outage (core/capture.ts; pinned by
 *    tests/app.e2e.test.ts). If the implementation is available but produced
 *    nonsense, it returns UNDERSTOOD_NOTHING.
 *
 * Key names are snake_case on purpose: they are the metadata keys every
 * other Open Brain integration reads from the stored thought.
 */

export type ThoughtType = "observation" | "task" | "idea" | "reference" | "person_note";

export type Understanding = {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: ThoughtType;
};

export const UNDERSTOOD_NOTHING: Understanding = {
  people: [],
  action_items: [],
  dates_mentioned: [],
  topics: ["uncategorized"],
  type: "observation",
};

export interface Understander {
  understand(text: string): Promise<Understanding>;
}
