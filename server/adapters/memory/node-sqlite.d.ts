/**
 * The slice of `node:sqlite` the SQLite limb uses. Deno ships the module but
 * not always its types under `deno check`; this keeps the limb type-checked
 * without pulling @types/node.
 */
declare module "node:sqlite" {
  type SqlValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
