/**
 * Seeding a memory from a tree of Markdown files, one thought per section.
 * Pure pieces (walk, chunk, clientSlug) and the seeding loop, with no
 * composition in them, so every rule here has a test. entry/seed-markdown.ts
 * is the command that composes and calls seedTree.
 */
import type { Ports, Scope, Settings } from "../core/ports/mod.ts";
import { capture } from "../core/capture.ts";

export const MAX_CHARS = 6000;
export const MIN_CHARS = 80;

export type Chunk = { path: string; heading: string; body: string };

export function* walk(dir: string, rel = ""): Generator<string> {
  const entries = [...Deno.readDirSync(dir)].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) yield* walk(p, r);
    else if (e.isFile && e.name.toLowerCase().endsWith(".md")) yield r;
  }
}

/**
 * Split on level-1/2 headings that are not inside a code fence; drop
 * sections under MIN_CHARS; split an oversize section on paragraphs, and an
 * oversize paragraph on its own length, so no chunk exceeds MAX_CHARS.
 */
export function chunk(path: string, text: string): Chunk[] {
  const out: Chunk[] = [];
  const lines = text.split(/\r?\n/);
  let heading = path.replace(/\.md$/i, "").split("/").pop() ?? path;
  let buf: string[] = [];
  let fence: string | null = null;

  const push = (h: string, body: string) => out.push({ path, heading: h, body });
  const pieces = (para: string): string[] => {
    if (para.length <= MAX_CHARS) return [para];
    const parts: string[] = [];
    for (let i = 0; i < para.length; i += MAX_CHARS) parts.push(para.slice(i, i + MAX_CHARS));
    return parts;
  };
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (body.length < MIN_CHARS) return;
    if (body.length <= MAX_CHARS) return push(heading, body);
    let part: string[] = [];
    let size = 0;
    let n = 1;
    for (const para of body.split(/\n{2,}/).flatMap(pieces)) {
      if (size + para.length > MAX_CHARS && part.length) {
        push(`${heading} (${n++})`, part.join("\n\n"));
        part = [];
        size = 0;
      }
      part.push(para);
      size += para.length + 2;
    }
    if (part.length) push(n > 1 ? `${heading} (${n})` : heading, part.join("\n\n"));
  };

  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      buf.push(line);
      continue;
    }
    const m = fence === null ? /^(#{1,2})\s+(.*)$/.exec(line) : null;
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * The client a file belongs to, taken from the first capture group of the
 * caller's own pattern applied to the relative path. No pattern, no client.
 */
export function clientSlug(path: string, pattern: RegExp | undefined): string | undefined {
  if (!pattern) return undefined;
  const m = pattern.exec(path);
  const slug = m?.[1]?.trim().toLowerCase();
  return slug || undefined;
}

/** Seeding into whatever the default memory happens to be is how client data ends up in the wrong place. */
export function assertExplicitMemory(settings: Pick<Settings, "get">): string {
  const memory = settings.get("OB_MEMORY");
  if (!memory) throw new Error("Refusing to seed: set OB_MEMORY explicitly (postgres, keyword, vector, supabase) so the seed lands where you meant it to");
  return memory;
}

export type SeedOptions = {
  source?: string;
  clientFrom?: RegExp;
  concurrency?: number;
  /** Receives every failed chunk as it fails; the entry writes them to a file. */
  onFailure?: (failure: { path: string; heading: string; error: string }) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
};

export type SeedResult = { total: number; written: number; known: number; failed: number };

/**
 * Every chunk becomes one thought. A chunk the memory already holds costs
 * no model call: `known` is asked first. Path, heading and client travel as
 * metadata, never inside the content, so a moved file is the same thought.
 */
export async function seedTree(ports: Pick<Ports, "memory" | "ledger" | "understander" | "log">, scope: Scope, chunks: Chunk[], opts: SeedOptions = {}): Promise<SeedResult> {
  const source = opts.source ?? "seed:markdown";
  const seededAt = new Date().toISOString();
  const r: SeedResult = { total: chunks.length, written: 0, known: 0, failed: 0 };
  let next = 0;
  const one = async (c: Chunk) => {
    try {
      if (await ports.memory.known(scope, c.body)) {
        r.known++;
      } else {
        const client = clientSlug(c.path, opts.clientFrom);
        const done = await capture(ports, scope, {
          content: c.body,
          source,
          metadata: { path: c.path, heading: c.heading, ...(client ? { client } : {}), seeded_at: seededAt },
        });
        if (done.kind === "thought" && done.alreadyKnown) r.known++;
        else r.written++;
      }
    } catch (err) {
      r.failed++;
      await opts.onFailure?.({ path: c.path, heading: c.heading, error: (err as Error)?.message ?? String(err) });
    }
    opts.onProgress?.(r.written + r.known + r.failed, r.total);
  };
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, chunks.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < chunks.length) await one(chunks[next++]);
  }));
  return r;
}
