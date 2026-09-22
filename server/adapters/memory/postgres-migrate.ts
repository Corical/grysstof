/**
 * Forward-only, numbered migrations for the Postgres memory. Each file in
 * sql/migrations/ is NNNN_name.sql; the database remembers the highest
 * number applied in schema_version. Nothing is ever rolled back: a change
 * of mind is the next number.
 */
import { Pool } from "postgres";
import type { Log } from "../../core/ports/mod.ts";

export const MIGRATIONS = new URL("../../sql/migrations/", import.meta.url);
/** The version this build of the code expects. Bump when a migration is added. */
export const LATEST_SCHEMA = 5;

type Client = Awaited<ReturnType<Pool["connect"]>>;

export async function schemaVersion(c: Client): Promise<number> {
  const exists = await c.queryObject<{ ok: boolean }>(`SELECT to_regclass('schema_version') IS NOT NULL AS ok`);
  if (!exists.rows[0]?.ok) return 0;
  const r = await c.queryObject<{ v: number | null }>(`SELECT MAX(version)::int AS v FROM schema_version`);
  return r.rows[0]?.v ?? 0;
}

/** The vector width of thoughts.embedding, or null when the table does not exist. */
export async function vectorWidth(c: Client): Promise<number | null> {
  const r = await c.queryObject<{ w: number | null }>(
    `SELECT a.atttypmod::int AS w FROM pg_attribute a WHERE a.attrelid = to_regclass('thoughts') AND a.attname = 'embedding'`,
  );
  const w = r.rows[0]?.w;
  return typeof w === "number" && w > 0 ? w : null;
}

export async function listMigrations(): Promise<{ version: number; name: string; file: URL }[]> {
  const out: { version: number; name: string; file: URL }[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    const m = /^(\d{4})_(.+)\.sql$/.exec(e.name);
    if (e.isFile && m) out.push({ version: Number(m[1]), name: m[2], file: new URL(e.name, MIGRATIONS) });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** Applies every migration above the database's version, each in its own transaction. */
export async function migrate(url: string, opts: { dims: number; log?: Log }): Promise<{ from: number; to: number; applied: string[] }> {
  if (!Number.isInteger(opts.dims) || opts.dims <= 0) throw new Error(`Vector width must be a whole number greater than 0, got ${opts.dims}`);
  const pool = new Pool(url, 1, true);
  const c = await pool.connect();
  try {
    await c.queryArray(`CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const from = await schemaVersion(c);
    const applied: string[] = [];
    for (const m of await listMigrations()) {
      if (m.version <= from) continue;
      const sql = (await Deno.readTextFile(m.file)).replaceAll("{{DIMS}}", String(opts.dims));
      await c.queryArray("BEGIN");
      try {
        await c.queryArray(sql);
        await c.queryArray(`INSERT INTO schema_version (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        await c.queryArray("COMMIT");
      } catch (e) {
        await c.queryArray("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${String(m.version).padStart(4, "0")}_${m.name} failed: ${(e as Error).message}`);
      }
      applied.push(`${String(m.version).padStart(4, "0")}_${m.name}`);
      opts.log?.info("schema.migrated", { version: m.version, name: m.name });
    }
    return { from, to: await schemaVersion(c), applied };
  } finally {
    c.release();
    await pool.end();
  }
}
