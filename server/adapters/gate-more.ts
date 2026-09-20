/**
 * Three more gates, each attacking one assumption the shared key leaves
 * untested: that one key means one tenant (KeyringGate), that identity is
 * carried in the request itself rather than asserted by a front door
 * (TrustedHeadersGate), and that denial is the odd path (DenyAllGate).
 */
import type { Gate, GateDecision, Scope } from "../core/ports/mod.ts";

const NAME = /^[A-Za-z0-9._:@\/-]{1,120}$/;
/** A tenant can become a file, a table or a partition key: no slashes, no leading dot, 64 chars. */
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * KeyringGate: many keys, each bound to a tenant and a default actor.
 * Spec: `k1=tenant:actor,k2=tenant2:actor2`. A caller may narrow the actor
 * with `x-brain-actor`, never the tenant. Two keys in one tenant give two
 * agents distinct provenance in the same brain.
 */
export class KeyringGate implements Gate {
  readonly tenants = "many" as const;
  private readonly ring: { key: string; scope: Scope }[];

  constructor(spec: string, private readonly allowQueryKey = false) {
    this.ring = KeyringGate.parse(spec);
    if (!this.ring.length) throw new Error("KeyringGate needs at least one key");
  }

  static parse(spec: string): { key: string; scope: Scope }[] {
    const out: { key: string; scope: Scope }[] = [];
    const seen = new Set<string>();
    for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf("=");
      const colon = entry.lastIndexOf(":");
      if (eq <= 0 || colon <= eq + 1 || colon === entry.length - 1) throw new Error(`KeyringGate: "${entry}" is not key=tenant:actor`);
      const key = entry.slice(0, eq);
      const tenant = entry.slice(eq + 1, colon);
      const actor = entry.slice(colon + 1);
      if (!TENANT.test(tenant) || !NAME.test(actor)) throw new Error(`KeyringGate: tenant in "${entry}" must match ${TENANT} and actor ${NAME}`);
      if (seen.has(key)) throw new Error("KeyringGate: the same key appears twice");
      seen.add(key);
      out.push({ key, scope: { tenant, actor } });
    }
    return out;
  }

  authorise(req: Request): Promise<GateDecision> {
    const provided = req.headers.get("x-brain-key") || (this.allowQueryKey ? new URL(req.url).searchParams.get("key") : null);
    if (!provided) return Promise.resolve({ allowed: false });
    // Compare against every key so timing does not reveal which one is close.
    let hit: Scope | undefined;
    for (const e of this.ring) if (equal(provided, e.key)) hit = e.scope;
    if (!hit) return Promise.resolve({ allowed: false });
    const claimed = req.headers.get("x-brain-actor")?.trim();
    const actor = claimed && NAME.test(claimed) ? claimed : hit.actor;
    return Promise.resolve({ allowed: true, tenant: hit.tenant, actor });
  }
}

/**
 * TrustedHeadersGate: a front door (APIM, an Entra-protected proxy, a
 * sidecar) has already authenticated the caller and tells us who they are
 * in `x-tenant` and `x-actor`. We believe it only when it also presents the
 * shared secret in `x-gateway-secret`; a request that reaches us without it
 * is refused with a challenge that names the header, so a misrouted client
 * learns where it went wrong.
 */
export class TrustedHeadersGate implements Gate {
  readonly tenants = "many" as const;

  constructor(private readonly secret: string, private readonly headers = { secret: "x-gateway-secret", tenant: "x-tenant", actor: "x-actor" }) {
    if (!secret) throw new Error("TrustedHeadersGate needs a non-empty secret");
  }

  authorise(req: Request): Promise<GateDecision> {
    const presented = req.headers.get(this.headers.secret);
    if (!presented || !equal(presented, this.secret)) {
      return Promise.resolve({ allowed: false, challenge: { status: 401, headers: { "WWW-Authenticate": `Gateway realm="grysstof", header="${this.headers.secret}"` } } });
    }
    const tenant = req.headers.get(this.headers.tenant)?.trim() ?? "";
    const actor = req.headers.get(this.headers.actor)?.trim() ?? "";
    if (!TENANT.test(tenant) || !NAME.test(actor)) return Promise.resolve({ allowed: false });
    return Promise.resolve({ allowed: true, tenant, actor });
  }
}

/** Nobody gets in. Proves the denial path end to end without a key to guess. */
export class DenyAllGate implements Gate {
  readonly tenants = "one" as const;
  authorise(): Promise<GateDecision> {
    return Promise.resolve({ allowed: false });
  }
}
