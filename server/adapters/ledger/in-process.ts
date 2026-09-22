/**
 * InProcessLedger: a Ledger with no Memory underneath. Lines live in a Map
 * per tenant; search is word overlap over the claim. It exists to prove the
 * Ledger contract does not depend on a Memory being present, and to be the
 * engine that JsonlLedger replays into.
 *
 * Every mutation is an Event. `apply` is the only thing that changes state,
 * so a subclass that persists the events (JsonlLedger) gets replay for free.
 */
import type { Assertion, Fact, FindOptions, Found, Ledger, Scope, SubjectSummary } from "../../core/ports/mod.ts";

import { cosine, type Embedder } from "../memory/vectors.ts";

/** Where a line sits in time: when it became true if the writer said, else when it was learned. */
export const placeInTime = (f: Fact): string => f.occurredAt ?? f.learnedAt;

/** A writer's occurredAt normalised to ISO, undefined when absent, an Error when it is not a date. */
export function occurredAtOf(v: string | undefined): string | undefined {
  if (v === undefined || v === null || v.trim() === "") return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`occurredAt is not a date: ${v}`);
  return new Date(t).toISOString();
}

export type Event =
  | { kind: "assert"; fact: Fact }
  | { kind: "confirm"; tenant: string; id: string; by: string; at: string }
  | { kind: "supersede"; tenant: string; newer: string; older: string };

const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
const must = (value: string, name: string) => {
  if (!value) throw new Error(`A fact needs a ${name}`);
  return value;
};

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export class InProcessLedger implements Ledger {
  private readonly tenants = new Map<string, Map<string, Fact>>();
  private seq = 0;
  /** Claim vectors by fact id, when an embedder is present. A line without one falls back to word overlap. */
  protected readonly vectors = new Map<string, number[]>();

  constructor(protected readonly now: () => Date = () => new Date(), protected readonly embedder?: Embedder) {}

  /** Subclasses that persist vectors override this; the default keeps them in memory only. */
  protected storeVector(_id: string, _vector: number[]): Promise<void> {
    return Promise.resolve();
  }

  private async embedFact(fact: Fact): Promise<void> {
    if (!this.embedder || this.vectors.has(fact.id)) return;
    const v = await this.embedder.embed(fact.claim);
    this.vectors.set(fact.id, v);
    await this.storeVector(fact.id, v);
  }

  private lines(tenant: string): Map<string, Fact> {
    let m = this.tenants.get(tenant);
    if (!m) {
      m = new Map();
      this.tenants.set(tenant, m);
    }
    return m;
  }

  /** Persisting subclasses override this to write the event before it takes effect. */
  protected record(event: Event): Promise<void> {
    this.apply(event);
    return Promise.resolve();
  }

  /** The only state change. Idempotent for replay. */
  protected apply(event: Event): void {
    const lines = this.lines(event.kind === "assert" ? event.fact.tenant : event.tenant);
    switch (event.kind) {
      case "assert":
        lines.set(event.fact.id, structuredClone(event.fact));
        if (event.fact.supersedes) {
          const older = lines.get(event.fact.supersedes);
          if (older) older.supersededBy = event.fact.id;
        }
        break;
      case "confirm": {
        const f = lines.get(event.id);
        if (f) Object.assign(f, { confirmed: true, confirmedBy: event.by, confirmedAt: event.at });
        break;
      }
      case "supersede": {
        const older = lines.get(event.older);
        const newer = lines.get(event.newer);
        if (older) older.supersededBy = event.newer;
        if (newer && !newer.supersedes) newer.supersedes = event.older;
        break;
      }
    }
  }

  async assert(scope: Scope, a: Assertion): Promise<Fact> {
    const subject = must(clean(a.subject), "subject");
    const claim = must(clean(a.claim), "claim");
    const source = must(clean(a.source), "source");
    const proof = clean(a.proof) || undefined;
    const tags = [...new Set((a.tags ?? []).map(clean).filter(Boolean))];
    const older = a.supersedes ? this.linkable(scope, a.supersedes, subject) : null;
    const occurredAt = occurredAtOf(a.occurredAt);
    const fact: Fact = {
      id: `fact_${(++this.seq).toString(36).padStart(6, "0")}_${crypto.randomUUID().slice(0, 8)}`,
      tenant: scope.tenant,
      subject,
      claim,
      source,
      ...(proof ? { proof } : {}),
      tags,
      learnedBy: scope.actor,
      learnedAt: this.now().toISOString(),
      ...(occurredAt ? { occurredAt } : {}),
      confirmed: false,
      ...(older ? { supersedes: older.id } : {}),
    };
    await this.record({ kind: "assert", fact });
    await this.embedFact(fact);
    return this.copy(scope, fact.id)!;
  }

  latest(scope: Scope, subject: string): Promise<Fact | null> {
    return this.history(scope, subject).then((h) => h.find((f) => !f.supersededBy) ?? null);
  }

  history(scope: Scope, subject: string): Promise<Fact[]> {
    const s = clean(subject);
    if (!s) return Promise.resolve([]);
    return Promise.resolve(
      [...this.lines(scope.tenant).values()].filter((f) => f.subject === s).sort((a, b) => placeInTime(b).localeCompare(placeInTime(a)) || b.learnedAt.localeCompare(a.learnedAt) || b.id.localeCompare(a.id)).map((f) => structuredClone(f)),
    );
  }

  async confirm(scope: Scope, id: string): Promise<Fact> {
    const f = this.owned(scope, id);
    if (f.confirmed) return structuredClone(f);
    await this.record({ kind: "confirm", tenant: scope.tenant, id, by: scope.actor, at: this.now().toISOString() });
    return this.copy(scope, id)!;
  }

  async supersede(scope: Scope, newerId: string, olderId: string): Promise<Fact> {
    if (newerId === olderId) throw new Error("A fact cannot supersede itself");
    const newer = this.owned(scope, newerId);
    const older = this.linkable(scope, olderId, newer.subject);
    const seen = new Set<string>([newer.id]);
    for (let cur: Fact | undefined = newer; cur?.supersededBy;) {
      if (cur.supersededBy === older.id) throw new Error(`Superseding ${older.id} with ${newer.id} would form a cycle`);
      if (seen.has(cur.supersededBy)) break;
      seen.add(cur.supersededBy);
      cur = this.lines(scope.tenant).get(cur.supersededBy);
    }
    await this.record({ kind: "supersede", tenant: scope.tenant, newer: newer.id, older: older.id });
    return this.copy(scope, newer.id)!;
  }

  async find(scope: Scope, query: string, opts: FindOptions): Promise<Found[]> {
    const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
    if (limit === 0 || !clean(query)) return [];
    const minScore = Number.isNaN(opts.minScore ?? 0) ? 0 : Math.min(1, Math.max(0, opts.minScore ?? 0));
    const subject = clean(opts.subject) || undefined;
    const q = words(query);
    const qv = this.embedder ? await this.embedder.embed(query) : undefined;
    const out: Found[] = [];
    for (const f of this.lines(scope.tenant).values()) {
      if (subject && f.subject !== subject) continue;
      if (!opts.includeSuperseded && f.supersededBy) continue;
      if (opts.confirmedOnly && !f.confirmed) continue;
      const fv = qv ? this.vectors.get(f.id) : undefined;
      const score = fv && qv ? Math.max(0, Math.min(1, cosine(qv, fv))) : jaccard(q, words(f.claim));
      if (score > minScore) out.push({ ...structuredClone(f), score });
    }
    out.sort((a, b) => b.score - a.score || b.learnedAt.localeCompare(a.learnedAt));
    return out.slice(0, limit);
  }

  subjects(scope: Scope): Promise<SubjectSummary[]> {
    const bySubject = new Map<string, SubjectSummary>();
    for (const f of this.lines(scope.tenant).values()) {
      const row = bySubject.get(f.subject) ?? { subject: f.subject, lines: 0, current: 0, latestAt: f.learnedAt };
      row.lines++;
      if (!f.supersededBy) row.current++;
      if (f.learnedAt > row.latestAt) row.latestAt = f.learnedAt;
      bySubject.set(f.subject, row);
    }
    // Code-point order on the subject, the same tie-break every limb uses (Postgres: COLLATE "C").
    return Promise.resolve([...bySubject.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt) || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)));
  }

  private owned(scope: Scope, id: string): Fact {
    const f = this.lines(scope.tenant).get(id);
    if (!f) throw new Error(`No fact ${id}`);
    return f;
  }

  private linkable(scope: Scope, olderId: string, subject: string): Fact {
    const older = this.owned(scope, olderId);
    if (older.subject !== subject) throw new Error(`Fact ${olderId} is about "${older.subject}", not "${subject}"; a fact only supersedes one about the same subject`);
    if (older.supersededBy) throw new Error(`Fact ${olderId} is already superseded by ${older.supersededBy}`);
    return older;
  }

  private copy(scope: Scope, id: string): Fact | null {
    const f = this.lines(scope.tenant).get(id);
    return f ? structuredClone(f) : null;
  }

  /** Replay support for persisting subclasses. */
  protected replay(events: Iterable<Event>): void {
    let n = 0;
    for (const e of events) {
      this.apply(e);
      n++;
    }
    this.seq = n;
  }
}

/**
 * JsonlLedger: InProcessLedger whose every event is first appended as one
 * line to a file. Nothing is ever rewritten. On start the file is replayed.
 * A crash between "append" and "apply" loses nothing: the line is on disk
 * and applies on the next start.
 */
export class JsonlLedger extends InProcessLedger {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, now?: () => Date) {
    super(now);
    try {
      const text = Deno.readTextFileSync(file);
      this.replay(text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Event));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  protected override record(event: Event): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    this.chain = this.chain.then(async () => {
      await Deno.writeTextFile(this.file, line, { append: true });
      this.apply(event);
    });
    return this.chain;
  }
}
