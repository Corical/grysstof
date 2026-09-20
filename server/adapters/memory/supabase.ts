/**
 * SupabaseMemory: the upstream behaviour, behind the Memory port.
 * Uses the canonical schema's `upsert_thought` and `match_thoughts` and an
 * Embedder for recall. Single-tenant: ignores scope (the schema has no
 * owner column). Similarity is cosine as the SQL function computes it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Log, Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { boundLimit, bounds, fingerprint, isUuid, normalise, parseSince, tally } from "./shared.ts";
import type { Embedder } from "./vectors.ts";

type DbRow = { id: string; content: string; metadata: ThoughtMetadata; created_at: string; updated_at?: string | null; similarity?: number };

const toThought = (r: DbRow): Thought => ({ id: r.id, content: r.content, metadata: r.metadata ?? {}, createdAt: r.created_at, updatedAt: r.updated_at });

export class SupabaseMemory implements Memory {
  readonly isolation = "none" as const;
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, private readonly embedder: Embedder, private readonly log: Log) {
    this.client = createClient(url, serviceRoleKey);
  }

  async remember(_scope: Scope, content: string, metadata: ThoughtMetadata) {
    if (!normalise(content)) throw new Error("Cannot remember blank content");
    const embedding = await this.embedder.embed(content);
    const { data, error } = await this.client.rpc("upsert_thought", { p_content: content, p_payload: { metadata } });
    if (error) throw new Error(error.message);
    const { id } = data as { id: string };
    const { data: existing } = await this.client.from("thoughts").select("embedding").eq("id", id).maybeSingle();
    const alreadyKnown = !!existing?.embedding;
    const { error: embError } = await this.client.from("thoughts").update({ embedding }).eq("id", id);
    if (embError) throw new Error(embError.message);
    this.log.info("memory.remembered", { memory: "supabase", id, alreadyKnown });
    return { id, alreadyKnown };
  }

  async known(_scope: Scope, content: string): Promise<string | null> {
    if (!normalise(content)) return null;
    const { data, error } = await this.client.from("thoughts").select("id").eq("content_fingerprint", await fingerprint(content)).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { id: string } | null)?.id ?? null;
  }

  async recall(_scope: Scope, query: string, opts: { limit: number; minScore: number }): Promise<Recalled[]> {
    const { limit, minScore } = bounds(opts);
    if (limit === 0) return [];
    const q = await this.embedder.embed(query);
    const { data, error } = await this.client.rpc("match_thoughts", {
      query_embedding: q,
      match_threshold: minScore,
      match_count: limit,
      filter: {},
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as DbRow[]).map((r) => ({ ...toThought(r), score: Math.max(0, Number(r.similarity)) }));
  }

  async get(_scope: Scope, id: string): Promise<Thought | null> {
    if (!isUuid(id)) return null;
    const { data, error } = await this.client
      .from("thoughts").select("id, content, metadata, created_at, updated_at").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toThought(data as DbRow) : null;
  }

  async recent(_scope: Scope, q: RecentQuery): Promise<Thought[]> {
    const since = parseSince(q.since);
    let sel = this.client.from("thoughts").select("id, content, metadata, created_at, updated_at")
      .order("created_at", { ascending: false }).limit(boundLimit(q.limit));
    if (q.type) sel = sel.contains("metadata", { type: q.type });
    if (q.topic) sel = sel.contains("metadata", { topics: [q.topic] });
    if (q.person) sel = sel.contains("metadata", { people: [q.person] });
    if (since !== null) sel = sel.gte("created_at", new Date(since).toISOString());
    const { data, error } = await sel;
    if (error) throw new Error(error.message);
    return ((data ?? []) as DbRow[]).map(toThought);
  }

  async summary(_scope: Scope): Promise<Summary> {
    const { data, error } = await this.client.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { metadata: ThoughtMetadata; created_at: string }[];
    const s: Summary = { count: rows.length, types: {}, topics: {}, people: {} };
    if (rows.length) {
      s.newest = rows[0].created_at;
      s.oldest = rows[rows.length - 1].created_at;
    }
    for (const r of rows) tally(s, r.metadata ?? {});
    return s;
  }
}
