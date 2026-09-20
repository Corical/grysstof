import type { Settings } from "../core/ports/mod.ts";

function requireFrom(get: (n: string) => string | undefined, name: string): string {
  const v = get(name);
  if (v === undefined) throw new Error(`Missing required setting: ${name}`);
  return v;
}

/** Process environment. Key Vault, App Settings and Supabase secrets all arrive here. */
export class EnvSettings implements Settings {
  get(name: string) {
    const v = Deno.env.get(name);
    return v === undefined || v === "" ? undefined : v;
  }
  require(name: string) {
    return requireFrom((n) => this.get(n), name);
  }
}

/** Fixed values. Tests and hosts that inject settings by code. Empty string means unset, as in EnvSettings. */
export class MapSettings implements Settings {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string) {
    const v = this.values[name];
    return v === undefined || v === "" ? undefined : v;
  }
  require(name: string) {
    return requireFrom((n) => this.get(n), name);
  }
}
