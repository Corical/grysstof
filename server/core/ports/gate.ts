/**
 * Gate: what the core needs to know about an incoming request before it
 * serves tools: may this caller in, and who are they. A denial may carry a
 * challenge (status and headers) so schemes like OAuth can ask the client
 * to authenticate; the core relays it as-is.
 *
 * An allowed decision names the tenant (whose memory) and the actor (who is
 * acting). Both come from the gate alone; the core never lets a tool
 * argument override them.
 */
import type { Scope } from "./memory.ts";

export type GateDecision =
  | ({ allowed: true } & Scope)
  | { allowed: false; challenge?: { status: number; headers: Record<string, string> } };

/** How many tenants this gate can admit: a shared key admits one; a per-user scheme admits many. */
export type GateTenants = "one" | "many";

export interface Gate {
  readonly tenants: GateTenants;
  authorise(request: Request): Promise<GateDecision>;
}
