/**
 * The Postgres test suite truncates the `thoughts` table. It refuses to do
 * that to any database whose name does not end in `_test`, whatever the
 * environment says.
 */
export function assertTestDatabase(connectionString: string): string {
  let db: string;
  try {
    db = new URL(connectionString).pathname.replace(/^\//, "");
  } catch {
    throw new Error("OB_PG_URL is not a valid URL");
  }
  if (!/_test$/i.test(db)) {
    throw new Error(`Refusing to run destructive tests against database "${db}": the name must end in _test`);
  }
  return db;
}
