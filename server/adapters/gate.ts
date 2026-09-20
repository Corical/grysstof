import type { Gate, GateDecision } from "../core/ports/mod.ts";

/** What a caller may claim to be, once the key has let them in. Letters, digits, and . _ : @ / - only. */
const ACTOR = /^[A-Za-z0-9._:@\/-]{1,120}$/;

export type SharedKeyOptions = {
  /** Every caller with the key lands in this tenant. */
  tenant: string;
  /** Upstream behaviour: accept `?key=` as well as the header. Default true. */
  allowQueryKey?: boolean;
  /** Actor when the caller names none. Default "shared-key". */
  defaultActor?: string;
};

/**
 * Upstream behaviour: `x-brain-key` header, or `?key=` query, equal to one
 * shared key. One key means one tenant. The caller may name itself with an
 * `x-brain-actor` header (a session id, an agent name); the key is what
 * authorises it, the header only says who is writing.
 */
export class SharedKeyGate implements Gate {
  readonly tenants = "one" as const;
  private readonly tenant: string;
  private readonly allowQueryKey: boolean;
  private readonly defaultActor: string;

  constructor(private readonly key: string, options: SharedKeyOptions) {
    if (!key) throw new Error("SharedKeyGate needs a non-empty key");
    if (!options.tenant) throw new Error("SharedKeyGate needs a tenant");
    this.tenant = options.tenant;
    this.allowQueryKey = options.allowQueryKey ?? true;
    this.defaultActor = options.defaultActor ?? "shared-key";
  }

  authorise(req: Request): Promise<GateDecision> {
    const provided = req.headers.get("x-brain-key") || (this.allowQueryKey ? new URL(req.url).searchParams.get("key") : null);
    if (!provided || !equal(provided, this.key)) return Promise.resolve({ allowed: false });
    const claimed = req.headers.get("x-brain-actor")?.trim();
    const actor = claimed && ACTOR.test(claimed) ? claimed : this.defaultActor;
    return Promise.resolve({ allowed: true, tenant: this.tenant, actor });
  }
}

/** Lets everyone in as a fixed tenant and actor, or nobody. Tests only. */
export class OpenGate implements Gate {
  readonly tenants = "one" as const;
  constructor(private readonly allow: boolean, private readonly tenant = "test", private readonly actor = "test") {}
  authorise(): Promise<GateDecision> {
    return Promise.resolve(this.allow ? { allowed: true, tenant: this.tenant, actor: this.actor } : { allowed: false });
  }
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
