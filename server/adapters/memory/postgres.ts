/**
 * PostgresMemory: any PostgreSQL with pgvector, by connection string, on the
 * schema in server/sql/migrations/. Partitions by tenant: identity is
 * (tenant, fingerprint), every read is filtered by tenant, and match_thoughts
 * scans the HNSW graph iteratively so a small tenant still finds its rows.
 * TLS is enforced unless the URL says sslmode=disable.
 *
 * Nothing here waits forever: acquiring a connection has a deadline in this
 * process, and every statement carries a server-side `statement_timeout`.
 * Either one expiring is logged as `memory.timeout` and thrown as a plain
 * Error, so a hung database is a loud failure, not a silent stall.
 */
import { Pool } from "postgres";
import type { Log, Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { boundLimit, bounds, channelKey, createdAtOf, isUuid, normalise, parseSince, parseUntil, tally, fingerprint } from "./shared.ts";
import { type Embedder, vectorLiteral } from "./vectors.ts";
import { LATEST_SCHEMA, schemaVersion, vectorWidth } from "./postgres-migrate.ts";

type DbRow = { id: string; content: string; metadata: ThoughtMetadata; created_at: Date | string; updated_at?: Date | string | null; similarity?: number | string };

export type PostgresOptions = {
  poolSize?: number;
  /** Deadline for obtaining a connection from the pool, in milliseconds. */
  connectTimeoutMs?: number;
  /** Server-side `statement_timeout`, in milliseconds. */
  statementTimeoutMs?: number;
};

const STATEMENT_TIMEOUT_SQLSTATE = "57014";

const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : d ?? undefined);
const toThought = (r: DbRow): Thought => ({ id: String(r.id), content: r.content, metadata: r.metadata ?? {}, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at) ?? null });

export class PostgresMemory implements Memory {
  readonly isolation = "tenant" as const;
  private readonly pool: Pool;
  private readonly connectTimeoutMs: number;
  private readonly statementTimeoutMs: number;

  constructor(connectionString: string, private readonly embedder: Embedder, private readonly log: Log, options: PostgresOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new Error("The PostgreSQL connection string is not a valid URL");
    }
    const enforceTls = url.searchParams.get("sslmode") !== "disable";
    this.pool = new Pool({
      hostname: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      tls: { enabled: enforceTls, enforce: enforceTls },
      options: { statement_timeout: String(this.statementTimeoutMs) },
    }, options.poolSize ?? 4, true);
  }

  /**
   * The database must be at this build's schema and embed at this embedder's
   * width. Called by the composition root at start, so a missing migration or
   * a model swap is refused before the first request, with a plain message.
   */
  assertSchema(): Promise<void> {
    return this.run(async (c) => {
      const v = await schemaVersion(c);
      if (v !== LATEST_SCHEMA) {
        throw new Error(`The database is at schema version ${v}; this build needs ${LATEST_SCHEMA}. Run \`deno task migrate\` against it.`);
      }
      const w = await vectorWidth(c);
      if (w !== this.embedder.dimensions) {
        throw new Error(`The database stores ${w}-wide vectors but the embedder (${this.embedder.model}) produces ${this.embedder.dimensions}-wide ones. Set EMBEDDING_DIMENSIONS to match, or use a database created for this model.`);
      }
    });
  }

  private async acquire() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.log.error("memory.timeout", { memory: "postgres", phase: "connect", ms: this.connectTimeoutMs });
        reject(new Error(`Memory did not accept a connection within ${this.connectTimeoutMs} ms`));
      }, this.connectTimeoutMs);
    });
    try {
      return await Promise.race([this.pool.connect(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A guarded connection from the shared pool. Public so sibling adapters (the Postgres ledger) share pool, deadlines and timeout logging. */
  async run<T>(fn: (c: Awaited<ReturnType<Pool["connect"]>>) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      return await fn(c);
    } catch (e) {
      if ((e as { fields?: { code?: string } })?.fields?.code === STATEMENT_TIMEOUT_SQLSTATE) {
        this.log.error("memory.timeout", { memory: "postgres", phase: "statement", ms: this.statementTimeoutMs });
        throw new Error(`Memory did not answer within ${this.statementTimeoutMs} ms`);
      }
      throw e;
    } finally {
      c.release();
    }
  }

  async remember(scope: Scope, content: string, metadata: ThoughtMetadata): Promise<{ id: string; alreadyKnown: boolean }> {
    if (!normalise(content)) throw new Error("Cannot remember blank content");
    // One sameness rule for every limb: the fingerprint is computed here (JS \s, Unicode
    // whitespace) and handed to SQL, never derived there (PostgreSQL \s is ASCII-only).
    const fp = await fingerprint(content);
    // A row already known needs no embedding call and no vector write: merge its metadata and stop.
    const known: string | null = await this.run((c) =>
      c.queryObject<{ id: string }>(`SELECT id::text FROM thoughts WHERE tenant = $1 AND content_fingerprint = $2`, [scope.tenant, fp]).then((r) => r.rows[0]?.id ?? null)
    );
    if (known) {
      await this.run((c) => c.queryArray(`UPDATE thoughts SET metadata = metadata || $1::jsonb, updated_at = now() WHERE id = $2::uuid AND tenant = $3`, [JSON.stringify(metadata), known, scope.tenant]));
      this.log.info("memory.remembered", { memory: "postgres", id: known, alreadyKnown: true, tenant: scope.tenant });
      return { id: known, alreadyKnown: true };
    }
    const embedding = await this.embedder.embed(content);
    return this.run(async (c) => {
      await c.queryArray("BEGIN");
      try {
        // upsert_thought still handles the race where two writers embed the same new text at once.
        const r = await c.queryObject<{ result: { id: string; inserted: boolean } }>(
          `SELECT upsert_thought($1, $2, $3, $4::jsonb) AS result`,
          [scope.tenant, content, fp, JSON.stringify({ metadata })],
        );
        const { id, inserted } = r.rows[0].result;
        if (inserted) {
          const at = createdAtOf(metadata, "");
          await c.queryArray(
            `UPDATE thoughts SET embedding = $1::vector, embedding_model = $2, embedding_dims = $3, created_at = COALESCE($6::timestamptz, created_at) WHERE id = $4::uuid AND tenant = $5`,
            [vectorLiteral(embedding), this.embedder.model, this.embedder.dimensions, id, scope.tenant, at || null],
          );
        }
        await c.queryArray("COMMIT");
        const alreadyKnown = inserted !== true;
        this.log.info("memory.remembered", { memory: "postgres", id, alreadyKnown, tenant: scope.tenant });
        return { id: String(id), alreadyKnown };
      } catch (e) {
        await c.queryArray("ROLLBACK").catch(() => {});
        throw e;
      }
    });
  }

  known(scope: Scope, content: string): Promise<string | null> {
    if (!normalise(content)) return Promise.resolve(null);
    // The same JS fingerprint remember() hands to SQL, so "known" and "already known" never disagree.
    return fingerprint(content).then((fp) =>
      this.run(async (c) => {
        const r = await c.queryObject<{ id: string }>(`SELECT id::text FROM thoughts WHERE tenant = $1 AND content_fingerprint = $2`, [scope.tenant, fp]);
        return r.rows[0]?.id ?? null;
      })
    );
  }

  async recall(scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    if (limit === 0) return [];
    const q = await this.embedder.embed(query);
    return this.run(async (c) => {
      const r = await c.queryObject<DbRow>(
        `SELECT id::text, content, metadata, similarity, created_at, updated_at FROM match_thoughts($1, $2::vector, $3::float, $4::int, '{}'::jsonb)`,
        [scope.tenant, vectorLiteral(q), minScore, limit],
      );
      return r.rows.map((row) => ({ ...toThought(row), score: Math.max(0, Number(row.similarity)) }));
    });
  }

  get(scope: Scope, id: string): Promise<Thought | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.run(async (c) => {
      const r = await c.queryObject<DbRow>(
        `SELECT id::text, content, metadata, created_at, updated_at FROM thoughts WHERE id = $1::uuid AND tenant = $2`,
        [id, scope.tenant],
      );
      return r.rows[0] ? toThought(r.rows[0]) : null;
    });
  }

  recent(scope: Scope, q: RecentQuery): Promise<Thought[]> {
    let since: number | null, until: number | null;
    try {
      since = parseSince(q.since);
      until = parseUntil(q.until);
    } catch (e) {
      return Promise.reject(e);
    }
    const where: string[] = [`tenant = $1`];
    const params: unknown[] = [scope.tenant];
    const contains = (o: ThoughtMetadata) => { params.push(JSON.stringify(o)); where.push(`metadata @> $${params.length}::jsonb`); };
    if (q.type) contains({ type: q.type });
    if (q.topic) contains({ topics: [q.topic] });
    if (q.person) contains({ people: [q.person] });
    if (q.sourcePrefix !== undefined) {
      params.push(q.sourcePrefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%");
      where.push(`metadata->>'source' LIKE $${params.length} ESCAPE '\\'`);
    }
    if (q.channel !== undefined) {
      // Same rule as channelKey(): a string, trimmed, one leading # dropped, any case. Equality, so no wildcard escaping is needed.
      const want = channelKey(q.channel);
      if (want === undefined) where.push("FALSE"); // a blank channel names nothing
      else {
        params.push(want);
        where.push(`jsonb_typeof(metadata->'channel') = 'string'
          AND lower(btrim(regexp_replace(btrim(metadata->>'channel'), '^#', ''))) = $${params.length}`);
      }
    }
    if (since !== null) { params.push(new Date(since).toISOString()); where.push(`created_at >= $${params.length}::timestamptz`); }
    if (until !== null) { params.push(new Date(until).toISOString()); where.push(`created_at < $${params.length}::timestamptz`); }
    const dir = q.order === "oldest" ? "ASC" : "DESC";
    params.push(boundLimit(q.limit));
    const limitAt = params.length;
    params.push(boundLimit(q.offset ?? 0));
    const sql = `SELECT id::text, content, metadata, created_at, updated_at FROM thoughts
      WHERE ${where.join(" AND ")} ORDER BY created_at ${dir}, id ${dir} LIMIT $${limitAt} OFFSET $${params.length}`;
    return this.run(async (c) => (await c.queryObject<DbRow>(sql, params)).rows.map(toThought));
  }

  summary(scope: Scope): Promise<Summary> {
    return this.run(async (c) => {
      const agg = await c.queryObject<{ count: number; oldest: Date | null; newest: Date | null }>(
        `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM thoughts WHERE tenant = $1`,
        [scope.tenant],
      );
      const rows = await c.queryObject<{ metadata: ThoughtMetadata }>(`SELECT metadata FROM thoughts WHERE tenant = $1`, [scope.tenant]);
      const a = agg.rows[0];
      const s: Summary = { count: a?.count ?? 0, types: {}, topics: {}, people: {} };
      if (a?.oldest) s.oldest = iso(a.oldest);
      if (a?.newest) s.newest = iso(a.newest);
      for (const r of rows.rows) tally(s, r.metadata ?? {});
      return s;
    });
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
