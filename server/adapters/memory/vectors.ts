/**
 * Vector helpers for memories that recall by embedding similarity. This is
 * an adapter-side contract: the core never sees it. Any vector-backed Memory
 * (Supabase, Postgres, an in-process one) composes an Embedder from here.
 */

export interface Embedder {
  readonly dimensions: number;
  /** A name for the model that produced the vectors, recorded beside each embedding. */
  readonly model: string;
  embed(text: string): Promise<number[]>;
}

export type OpenAICompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  fetchFn?: typeof fetch;
};

export class OpenAICompatibleEmbedder implements Embedder {
  readonly dimensions: number;
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  constructor(private readonly o: OpenAICompatibleOptions) {
    this.dimensions = o.dimensions ?? 1536;
    this.model = o.model;
    this.fetchFn = o.fetchFn ?? fetch;
  }
  async embed(text: string): Promise<number[]> {
    if (!text.trim()) throw new Error("Embedding input is empty");
    const r = await this.fetchFn(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.o.model, input: text }),
    });
    if (!r.ok) throw new Error(`Embedding API failed: ${r.status} ${await r.text().catch(() => "")}`);
    return checkWidth((await r.json())?.data?.[0]?.embedding, this.dimensions);
  }
}

export type AzureOpenAIOptions = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
  dimensions?: number;
  fetchFn?: typeof fetch;
};

export class AzureOpenAIEmbedder implements Embedder {
  readonly dimensions: number;
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  constructor(private readonly o: AzureOpenAIOptions) {
    this.dimensions = o.dimensions ?? 1536;
    this.model = `azure:${o.deployment}`;
    this.fetchFn = o.fetchFn ?? fetch;
  }
  async embed(text: string): Promise<number[]> {
    if (!text.trim()) throw new Error("Embedding input is empty");
    const u = new URL(`/openai/deployments/${encodeURIComponent(this.o.deployment)}/embeddings`, this.o.endpoint);
    u.searchParams.set("api-version", this.o.apiVersion ?? "2024-10-21");
    const r = await this.fetchFn(u, {
      method: "POST",
      headers: { "api-key": this.o.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });
    if (!r.ok) throw new Error(`Azure OpenAI embeddings failed: ${r.status} ${await r.text().catch(() => "")}`);
    return checkWidth((await r.json())?.data?.[0]?.embedding, this.dimensions);
  }
}

/** Deterministic, offline. Same text, same unit vector. */
export class FakeEmbedder implements Embedder {
  readonly model = "fake";
  constructor(readonly dimensions = 1536) {}
  async embed(text: string): Promise<number[]> {
    if (!text.trim()) throw new Error("Embedding input is empty");
    const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    let x = seed.reduce((acc, b, i) => (acc + b * (i + 1)) >>> 0, 0x9e3779b9) || 1;
    const v = new Array<number>(this.dimensions);
    let n = 0;
    for (let i = 0; i < this.dimensions; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      v[i] = (x / 0xffffffff) * 2 - 1;
      n += v[i] * v[i];
    }
    n = Math.sqrt(n);
    return v.map((c) => c / n);
  }
}

/**
 * Offline, deterministic, and meaningful: each word is hashed into a
 * dimension, so texts that share words are close and texts that do not are
 * far. For tests that need recall to behave like recall.
 */
export class BagOfWordsEmbedder implements Embedder {
  readonly model = "bag-of-words";
  constructor(readonly dimensions = 256) {}
  embed(text: string): Promise<number[]> {
    if (!text.trim()) return Promise.reject(new Error("Embedding input is empty"));
    const v = new Array<number>(this.dimensions).fill(0);
    for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 2) continue;
      let h = 2166136261;
      for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
      v[h % this.dimensions] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return Promise.resolve(v.map((x) => x / n));
  }
}

function checkWidth(vec: unknown, dims: number): number[] {
  if (!Array.isArray(vec) || vec.length !== dims) {
    throw new Error(`Embedding has ${Array.isArray(vec) ? vec.length : "no"} dimensions, expected ${dims}`);
  }
  return vec as number[];
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector width mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
