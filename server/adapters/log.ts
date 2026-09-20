import type { Log, LogFields } from "../core/ports/mod.ts";

const describe = (err: unknown) =>
  err instanceof Error ? { error: err.message, stack: err.stack } : err === undefined ? {} : { error: String(err) };

/** One JSON object per line. Uses console.warn/error for those levels so host log viewers keep severity. */
export class ConsoleLog implements Log {
  private emit(level: "info" | "warn" | "error", event: string, fields?: LogFields, err?: unknown) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}), ...describe(err) });
      (level === "info" ? console.log : level === "warn" ? console.warn : console.error)(line);
    } catch {
      // a logger never throws
    }
  }
  info(event: string, fields?: LogFields) { this.emit("info", event, fields); }
  warn(event: string, fields?: LogFields) { this.emit("warn", event, fields); }
  error(event: string, fields?: LogFields, err?: unknown) { this.emit("error", event, fields, err); }
}

export class NullLog implements Log {
  info() {}
  warn() {}
  error() {}
}

export class RecordingLog implements Log {
  readonly events: { level: string; event: string; fields?: LogFields; err?: unknown }[] = [];
  info(event: string, fields?: LogFields) { this.events.push({ level: "info", event, fields }); }
  warn(event: string, fields?: LogFields) { this.events.push({ level: "warn", event, fields }); }
  error(event: string, fields?: LogFields, err?: unknown) { this.events.push({ level: "error", event, fields, err }); }
}
