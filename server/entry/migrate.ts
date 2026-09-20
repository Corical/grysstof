/**
 * Bring the Postgres memory named by OB_PG_URL up to this build's schema:
 *   deno task migrate
 * Vector width comes from EMBEDDING_DIMENSIONS (default 1536), exactly as
 * serve.ts would embed.
 */
import { migrate } from "../adapters/memory/postgres-migrate.ts";
import { EnvSettings } from "../adapters/settings.ts";
import { ConsoleLog } from "../adapters/log.ts";

const s = new EnvSettings();
const dims = Number(s.get("EMBEDDING_DIMENSIONS") ?? "1536");
const r = await migrate(s.require("OB_PG_URL"), { dims, log: new ConsoleLog() });
console.log(`schema ${r.from} -> ${r.to}${r.applied.length ? ` (applied ${r.applied.join(", ")})` : " (nothing to do)"}`);
