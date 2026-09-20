/**
 * Two more logs. JsonlFileLog writes one JSON line per event to a file,
 * severity kept, so a test can read back exactly what the core said.
 * ThrowingLog throws on every call — the Log port says implementations must
 * never throw, and the core promises to survive one that does anyway;
 * this limb is how that promise gets tested.
 */
import type { Log, LogFields } from "../core/ports/mod.ts";

const describe = (err: unknown) =>
  err instanceof Error ? { error: err.message, stack: err.stack } : err === undefined ? {} : { error: String(err) };

export class JsonlFileLog implements Log {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private emit(level: "info" | "warn" | "error", event: string, fields?: LogFields, err?: unknown) {
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}), ...describe(err) }) + "\n";
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, unserialisable: true }) + "\n";
    }
    // Appends are queued so lines never interleave; a failed write is dropped, never thrown.
    this.chain = this.chain.then(() => Deno.writeTextFile(this.file, line, { append: true })).catch(() => {});
  }

  info(event: string, fields?: LogFields) { this.emit("info", event, fields); }
  warn(event: string, fields?: LogFields) { this.emit("warn", event, fields); }
  error(event: string, fields?: LogFields, err?: unknown) { this.emit("error", event, fields, err); }

  /** Wait for queued lines, then read them back. Tests only. */
  async lines(): Promise<Record<string, unknown>[]> {
    await this.chain;
    try {
      return (await Deno.readTextFile(this.file)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
  }
}

/** Violates the port on purpose. */
export class ThrowingLog implements Log {
  calls = 0;
  info(): void { this.calls++; throw new Error("ThrowingLog.info"); }
  warn(): void { this.calls++; throw new Error("ThrowingLog.warn"); }
  error(): void { this.calls++; throw new Error("ThrowingLog.error"); }
}
