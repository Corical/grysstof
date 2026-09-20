/**
 * PostgresLedger: the Ledger over its own `facts` table (migration 0004),
 * partitioned by tenant, plain-words search by claim embedding. A fact is
 * never a thought: nothing here touches `thoughts`, and nothing in the
 * PostgresMemory sees a fact. Shares the memory's pool, embedder and
 * timeouts so one composition has one set of connections.
 */
import type { Assertion, Fact, FindOptions, Found, Ledger, Log, Scope, SubjectSummary } from "../../core/ports/mod.ts";
import { type Embedder, vectorLiteral } from "../memory/vectors.ts";
import { isUuid } from "../memory/shared.ts";
import type { PostgresMemory } from "../memory/postgres.ts";

type Row = {
  id: string; tenant: string; subject: string; claim: string; source: string; proof: string | null; tags: unknown;
  learned_by: string; learned_at: Date | string; confirmed: boolean; confirmed_by: string | null; confirmed_at: Date | string | null;
  supersedes: string | null; superseded_by: string | null; similarity?: number | string;
};

const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : d ?? undefined);
const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
const must = (value: string, name: string) => {
  if (!value) throw new Error(`A fact needs a ${name}`);
  return value;
};

function toFact(r: Row): Fact {
  return {
    id: String(r.id),
    tenant: r.tenant,
    subject: r.subject,
    claim: r.claim,
    source: r.source,
    ...(r.proof ? { proof: r.proof } : {}),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((x): x is string => typeof x === "string") : [],
    learnedBy: r.learned_by,
    learnedAt: iso(r.learned_at)!,
    confirmed: r.confirmed === true,
    ...(r.confirmed_by ? { confirmedBy: r.confirmed_by } : {}),
    ...(r.confirmed_at ? { confirmedAt: iso(r.confirmed_at) } : {}),
    ...(r.supersedes ? { supersedes: String(r.supersedes) } : {}),
    ...(r.superseded_by ? { supersededBy: String(r.superseded_by) } : {}),
  };
}

const COLS = "id::text, tenant, subject, claim, source, proof, tags, learned_by, learned_at, confirmed, confirmed_by, confirmed_at, supersedes::text, superseded_by::text";

export class PostgresLedger implements Ledger {
  /** `run` is the memory's guarded connection runner: same pool, same timeouts, same timeout logging. */
  constructor(private readonly memory: PostgresMemory, private readonly embedder: Embedder, private readonly log: Log, private readonly now: () => Date = () => new Date()) {}

  private run<T>(fn: Parameters<PostgresMemory["run"]>[0] extends (c: infer C) => Promise<unknown> ? (c: C) => Promise<T> : never): Promise<T> {
    return this.memory.run(fn);
  }

  async assert(scope: Scope, a: Assertion): Promise<Fact> {
    const subject = must(clean(a.subject), "subject");
    const claim = must(clean(a.claim), "claim");
    const source = must(clean(a.source), "source");
    const proof = clean(a.proof) || null;
    const tags = [...new Set((a.tags ?? []).map(clean).filter(Boolean))];
    const embedding = await this.embedder.embed(claim);
    const learnedAt = this.now().toISOString();
    return this.run(async (c) => {
      await c.queryArray("BEGIN");
      try {
        const older = a.supersedes ? await this.linkable(c, scope, a.supersedes, subject) : null;
        const r = await c.queryObject<Row>(
          `INSERT INTO facts (tenant, subject, claim, source, proof, tags, learned_by, learned_at, supersedes, embedding, embedding_model, embedding_dims)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::uuid, $10::vector, $11, $12)
           RETURNING ${COLS}`,
          [scope.tenant, subject, claim, source, proof, JSON.stringify(tags), scope.actor, learnedAt, older?.id ?? null, vectorLiteral(embedding), this.embedder.model, this.embedder.dimensions],
        );
        const fact = toFact(r.rows[0]);
        if (older) await c.queryArray(`UPDATE facts SET superseded_by = $1::uuid WHERE id = $2::uuid AND tenant = $3`, [fact.id, older.id, scope.tenant]);
        await c.queryArray("COMMIT");
        this.log.info("ledger.asserted", { ledger: "postgres", id: fact.id, subject, tenant: scope.tenant });
        return fact;
      } catch (e) {
        await c.queryArray("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  }

  latest(scope: Scope, subject: string): Promise<Fact | null> {
    const s = clean(subject);
    if (!s) return Promise.resolve(null);
    return this.run(async (c) => {
      const r = await c.queryObject<Row>(
        `SELECT ${COLS} FROM facts WHERE tenant = $1 AND subject = $2 AND superseded_by IS NULL ORDER BY learned_at DESC, seq DESC LIMIT 1`,
        [scope.tenant, s],
      );
      return r.rows[0] ? toFact(r.rows[0]) : null;
    });
  }

  history(scope: Scope, subject: string): Promise<Fact[]> {
    const s = clean(subject);
    if (!s) return Promise.resolve([]);
    return this.run(async (c) => {
      const r = await c.queryObject<Row>(`SELECT ${COLS} FROM facts WHERE tenant = $1 AND subject = $2 ORDER BY learned_at DESC, seq DESC`, [scope.tenant, s]);
      return r.rows.map(toFact);
    });
  }

  confirm(scope: Scope, id: string): Promise<Fact> {
    return this.run(async (c) => {
      const f = await this.owned(c, scope, id);
      if (f.confirmed) return f;
      const r = await c.queryObject<Row>(
        `UPDATE facts SET confirmed = true, confirmed_by = $1, confirmed_at = $2::timestamptz WHERE id = $3::uuid AND tenant = $4 RETURNING ${COLS}`,
        [scope.actor, this.now().toISOString(), id, scope.tenant],
      );
      return toFact(r.rows[0]);
    });
  }

  supersede(scope: Scope, newerId: string, olderId: string): Promise<Fact> {
    if (newerId === olderId) return Promise.reject(new Error("A fact cannot supersede itself"));
    return this.run(async (c) => {
      await c.queryArray("BEGIN");
      try {
        const newer = await this.owned(c, scope, newerId);
        const older = await this.linkable(c, scope, olderId, newer.subject);
        // Following superseded_by from the newer line must never arrive back at the older one.
        const seen = new Set<string>([newer.id]);
        for (let cur: Fact | null = newer; cur?.supersededBy;) {
          if (cur.supersededBy === older.id) throw new Error(`Superseding ${older.id} with ${newer.id} would form a cycle`);
          if (seen.has(cur.supersededBy)) break;
          seen.add(cur.supersededBy);
          cur = await this.fact(c, scope, cur.supersededBy);
        }
        await c.queryArray(`UPDATE facts SET superseded_by = $1::uuid WHERE id = $2::uuid AND tenant = $3`, [newer.id, older.id, scope.tenant]);
        if (!newer.supersedes) await c.queryArray(`UPDATE facts SET supersedes = $1::uuid WHERE id = $2::uuid AND tenant = $3`, [older.id, newer.id, scope.tenant]);
        await c.queryArray("COMMIT");
        return (await this.fact(c, scope, newer.id))!;
      } catch (e) {
        await c.queryArray("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  }

  async find(scope: Scope, query: string, opts: FindOptions): Promise<Found[]> {
    const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 0;
    if (limit === 0 || !clean(query)) return [];
    const minScore = Number.isNaN(opts.minScore ?? 0) ? 0 : Math.min(1, Math.max(0, opts.minScore ?? 0));
    if (minScore >= 1) return [];
    const subject = clean(opts.subject) || null;
    const q = await this.embedder.embed(query);
    return this.run(async (c) => {
      const hits = await c.queryObject<{ id: string; similarity: number | string }>(
        `SELECT id::text, similarity FROM match_facts($1, $2::vector, $3::float, $4::int, $5, $6, $7)`,
        [scope.tenant, vectorLiteral(q), minScore, limit, subject, opts.includeSuperseded === true, opts.confirmedOnly === true],
      );
      if (!hits.rows.length) return [];
      const rows = await c.queryObject<Row>(`SELECT ${COLS} FROM facts WHERE tenant = $1 AND id = ANY($2::uuid[])`, [scope.tenant, hits.rows.map((h) => h.id)]);
      const byId = new Map(rows.rows.map((r) => [String(r.id), toFact(r)]));
      return hits.rows.map((h) => ({ ...byId.get(h.id)!, score: Math.max(0, Math.min(1, Number(h.similarity))) })).filter((f) => f.id);
    });
  }

  subjects(scope: Scope): Promise<SubjectSummary[]> {
    return this.run(async (c) => {
      const r = await c.queryObject<{ subject: string; lines: number | string | bigint; current: number | string | bigint; latest_at: Date | string }>(
        `SELECT subject, count(*) AS lines, count(*) FILTER (WHERE superseded_by IS NULL) AS current, max(learned_at) AS latest_at
         FROM facts WHERE tenant = $1 GROUP BY subject ORDER BY latest_at DESC, subject COLLATE "C" ASC`,
        [scope.tenant],
      );
      return r.rows.map((row) => ({ subject: row.subject, lines: Number(row.lines), current: Number(row.current), latestAt: iso(row.latest_at)! }));
    });
  }

  private async fact(c: Parameters<Parameters<PostgresMemory["run"]>[0]>[0], scope: Scope, id: string): Promise<Fact | null> {
    if (!isUuid(id)) return null;
    const r = await c.queryObject<Row>(`SELECT ${COLS} FROM facts WHERE tenant = $1 AND id = $2::uuid`, [scope.tenant, id]);
    return r.rows[0] ? toFact(r.rows[0]) : null;
  }

  /** A line of this tenant, or an Error that does not say whether it exists elsewhere. */
  private async owned(c: Parameters<Parameters<PostgresMemory["run"]>[0]>[0], scope: Scope, id: string): Promise<Fact> {
    const f = await this.fact(c, scope, id);
    if (!f) throw new Error(`No fact ${id}`);
    return f;
  }

  private async linkable(c: Parameters<Parameters<PostgresMemory["run"]>[0]>[0], scope: Scope, olderId: string, subject: string): Promise<Fact> {
    const older = await this.owned(c, scope, olderId);
    if (older.subject !== subject) throw new Error(`Fact ${olderId} is about "${older.subject}", not "${subject}"; a fact only supersedes one about the same subject`);
    if (older.supersededBy) throw new Error(`Fact ${olderId} is already superseded by ${older.supersededBy}`);
    return older;
  }
}
