/** Log: structured events. Implementations must never throw. */
export type LogFields = Record<string, unknown>;

export interface Log {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
}
