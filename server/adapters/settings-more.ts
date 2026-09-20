/**
 * Settings from somewhere other than the process environment. FileSettings
 * reads a `.env`-style file (KEY=value, # comments, optional quotes) once.
 * LayeredSettings asks several Settings in order and takes the first answer,
 * so a deployment can put defaults in a file and secrets in the environment.
 * Neither reserialises anything; a settings file is read, never rewritten.
 */
import type { Settings } from "../core/ports/mod.ts";

function requireFrom(get: (n: string) => string | undefined, name: string): string {
  const v = get(name);
  if (v === undefined) throw new Error(`Missing required setting: ${name}`);
  return v;
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export class FileSettings implements Settings {
  private readonly values: Record<string, string>;

  constructor(path: string) {
    this.values = parseDotEnv(Deno.readTextFileSync(path));
  }

  get(name: string) {
    const v = this.values[name];
    return v === undefined || v === "" ? undefined : v;
  }
  require(name: string) {
    return requireFrom((n) => this.get(n), name);
  }
}

export class LayeredSettings implements Settings {
  constructor(private readonly layers: Settings[]) {
    if (!layers.length) throw new Error("LayeredSettings needs at least one layer");
  }
  get(name: string) {
    for (const l of this.layers) {
      const v = l.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  require(name: string) {
    return requireFrom((n) => this.get(n), name);
  }
}
