/**
 * Ledger: what the core needs from "the list of facts that only grows".
 *
 * Written inside-out from the owner's words: each line says what was
 * learned, about whom, by which agent, when, and where the proof is; nothing
 * is edited; a newer line supersedes an older one; the old one stays visible.
 *
 * This is deliberately NOT the Memory port. Memory's rule is "same text is
 * the same thought, a second write merges"; a ledger's rule is "a second
 * observation is a second line". Identity (tenant, subject, claim, source,
 * moment) and supersession belong to the ledger.
 *
 * A fact is never a thought (owner's decision, 20 September 2026). A ledger
 * must not store its lines where the Memory port can see them: nothing
 * asserted here may appear in Memory.recall, Memory.recent or
 * Memory.summary. Readers who want facts use the ledger's own verbs.
 * tests/app.e2e.test.ts pins this through the tools.
 *
 * Semantics an implementation must honour:
 *  - `assert` ALWAYS appends a new line. Same subject, same claim, new source
 *    or new moment: a new line. Nothing is ever overwritten.
 *  - Provenance is stamped from the scope, never taken from the caller:
 *    `learnedBy` is `scope.actor`, `learnedAt` is the moment of the assert.
 *    An assertion carrying such keys has them ignored.
 *  - `tenant` partitions everything. No verb may read or link a line of
 *    another tenant; `supersede` and `confirm` refuse with an Error.
 *  - `latest(subject)` is the newest line for the subject that has not been
 *    superseded; `history(subject)` is every line for the subject, newest
 *    first, superseded ones included and marked.
 *  - `supersede(newer, older)` links two existing lines of the same tenant
 *    and subject. It refuses: a different tenant, a different subject, the
 *    same line twice, an older line already superseded by another, and any
 *    link that would form a cycle. The older line is not changed except for
 *    `supersededBy`.
 *  - `confirm(id)` marks a line as confirmed by `scope.actor` at that moment.
 *    Confirming an already-confirmed line is a no-op that returns the line.
 *  - `find(query)` is plain-words search over claims; by default it returns
 *    only lines that are not superseded ("newest wins"), best match first.
 *    Scores and `minScore` follow the Memory port's rules exactly.
 *  - `subjects()` is one row per subject the tenant has lines for: how many
 *    lines, how many of them are current (no `supersededBy`), and the
 *    `learnedAt` of the newest line. Newest `latestAt` first, then subject
 *    ascending in code-point order (so every limb breaks a tie the same
 *    way). A tenant with no lines gets `[]`. Never crosses tenants.
 *  - Errors are ordinary Errors with a message safe to show a user.
 *
 * Contract tests: server/tests/ledger.contract.ts. Run them against any
 * implementation before calling it a ledger.
 */
import type { Scope } from "./memory.ts";

export type { Scope };

/** What a writer says it learned. No provenance: the core supplies that from the scope. */
export type Assertion = {
  /** What the fact is about. Free text, but stable: "client:acme", "person:sam", "repo:dataservice". */
  subject: string;
  /** The statement itself, one fact, standalone. */
  claim: string;
  /** Where it was learned: a session, a ticket, a file, a URL. */
  source: string;
  /** Link to the evidence, when there is one. */
  proof?: string;
  /** Free labels a reader can browse by. */
  tags?: string[];
  /** Id of the older line this one replaces; validated exactly as `supersede` does. */
  supersedes?: string;
};

export type Fact = {
  id: string;
  tenant: string;
  subject: string;
  claim: string;
  source: string;
  proof?: string;
  tags: string[];
  learnedBy: string;
  learnedAt: string; // ISO 8601
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string; // ISO 8601
  supersedes?: string;
  supersededBy?: string;
};

export type FindOptions = {
  limit: number;
  /** Only lines scoring strictly above this, as for Memory.recall. Default 0. */
  minScore?: number;
  /** Restrict to one subject. */
  subject?: string;
  /** Include lines that have been superseded. Default false: newest wins. */
  includeSuperseded?: boolean;
  /** Only lines a human has confirmed. Default false. */
  confirmedOnly?: boolean;
};

export type Found = Fact & { score: number };

/** One row per subject the tenant has lines for. */
export type SubjectSummary = {
  subject: string;
  /** Every line about the subject, superseded ones included. */
  lines: number;
  /** Lines with no `supersededBy`. */
  current: number;
  /** ISO 8601 `learnedAt` of the newest line. */
  latestAt: string;
};

export interface Ledger {
  assert(scope: Scope, assertion: Assertion): Promise<Fact>;
  latest(scope: Scope, subject: string): Promise<Fact | null>;
  history(scope: Scope, subject: string): Promise<Fact[]>;
  confirm(scope: Scope, id: string): Promise<Fact>;
  supersede(scope: Scope, newerId: string, olderId: string): Promise<Fact>;
  find(scope: Scope, query: string, opts: FindOptions): Promise<Found[]>;
  /** Newest `latestAt` first, then subject ascending; `[]` for a tenant with no lines. */
  subjects(scope: Scope): Promise<SubjectSummary[]>;
}
