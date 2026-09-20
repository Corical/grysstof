export * from "./memory.ts";
export * from "./ledger.ts";
export * from "./understanding.ts";
export * from "./gate.ts";
export * from "./settings.ts";
export * from "./log.ts";

import type { Memory } from "./memory.ts";
import type { Ledger } from "./ledger.ts";
import type { Understander } from "./understanding.ts";
import type { Gate } from "./gate.ts";
import type { Log } from "./log.ts";

/** Everything the core plugs into. Assembled once, outside the core. */
export type Ports = {
  memory: Memory;
  ledger: Ledger;
  understander: Understander;
  gate: Gate;
  log: Log;
};

/** Behaviour knobs of the core itself, not dependencies. */
export type CoreOptions = {
  /** Base for citation links the search/fetch tools return. */
  citationBase: string;
};
