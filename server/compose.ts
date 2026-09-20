/**
 * Composition root: the only file that names an implementation.
 * Defaults reproduce upstream: nothing set means Supabase memory over
 * OpenRouter embeddings, an OpenRouter understander, and the shared key.
 *
 *   OB_MEMORY        = supabase (default) | postgres | keyword | vector | jsonfile | sqlite | chaos
 *   OB_LEDGER        = auto (default: follows OB_MEMORY) | postgres | sqlite | jsonl | in-process
 *   OB_EMBEDDER      = models (default: from OB_MODELS) | bag-of-words | fake
 *   OB_UNDERSTANDING = models (default: from OB_MODELS) | rules | null
 *   OB_GATE          = shared-key (default) | keyring | trusted-headers | deny-all
 *   OB_MODELS        = openrouter (default; any OpenAI-compatible base URL) | azure
 *   OB_TENANT        = the tenant every caller of a shared-key instance lands in (default "default")
 *
 * openrouter knobs: EMBEDDING_API_BASE, EMBEDDING_API_KEY, EMBEDDING_MODEL,
 * EMBEDDING_DIMENSIONS (must match the schema's vector width), CHAT_API_BASE,
 * CHAT_API_KEY, CHAT_MODEL. Chat falls back to the embedding host and key.
 * Limb knobs: OB_MEMORY_DIR (jsonfile), OB_SQLITE_FILE (sqlite),
 * OB_CHAOS_INNER / OB_CHAOS_FAIL_EVERY (chaos), OB_LEDGER_FILE (jsonl),
 * OB_KEYS (keyring: k=tenant:actor,…), OB_TRUST_SECRET (trusted-headers).
 *
 * The model branch is only entered when a socket actually needs a model, so an
 * all-offline composition (keyword + rules, or jsonfile + bag-of-words + null)
 * needs no key of any kind.
 */
import type { CoreOptions, Gate, Ledger, Log, Memory, Ports, Settings, Understander } from "./core/ports/mod.ts";
import { UNDERSTANDING_PROMPT } from "./core/prompts.ts";
import type { Embedder } from "./adapters/memory/vectors.ts";

const KNOWN_MEMORY = ["supabase", "postgres", "keyword", "vector", "jsonfile", "sqlite", "chaos"] as const;
const KNOWN_LEDGER = ["auto", "postgres", "sqlite", "jsonl", "in-process"] as const;
const KNOWN_EMBEDDER = ["models", "bag-of-words", "fake"] as const;
const KNOWN_UNDERSTANDING = ["models", "rules", "null"] as const;
const KNOWN_GATE = ["shared-key", "keyring", "trusted-headers", "deny-all"] as const;
const KNOWN_MODELS = ["openrouter", "azure"] as const;

function pick<T extends readonly string[]>(s: Settings, name: string, known: T, fallback: T[number]): T[number] {
  const v = s.get(name) ?? fallback;
  if (!known.includes(v)) throw new Error(`Unknown ${name} "${v}"; expected one of ${known.join(", ")}`);
  return v;
}

/** A setting that, when present, must be a whole number greater than zero. */
function positiveInteger(s: Settings, name: string): number | undefined {
  const raw = s.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0) throw new Error(`${name} must be a whole number greater than 0, got "${raw}"`);
  return Number(raw);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
}

const sameHost = (a: string, b: string) => hostOf(a) === hostOf(b);

/**
 * A memory that ignores the tenant may only sit behind a gate that admits one
 * tenant; otherwise every caller reads every other caller's thoughts.
 */
export function assertCompatible(memory: Pick<Memory, "isolation">, gate: Pick<Gate, "tenants">): void {
  if (memory.isolation === "none" && gate.tenants === "many") {
    throw new Error("This memory does not partition by tenant (isolation: none) but the gate admits many tenants; choose a tenant-isolating memory (postgres, keyword) or a single-tenant gate");
  }
}

/** The two model-backed limbs, built together because they share a host and a key. */
async function models(s: Settings, log: Log): Promise<{ embedder: Embedder; understander: Understander }> {
  const modelKind = pick(s, "OB_MODELS", KNOWN_MODELS, "openrouter");
  if (modelKind === "azure") {
    const [{ AzureOpenAIEmbedder }, { AzureOpenAIUnderstander }] = await Promise.all([
      import("./adapters/memory/vectors.ts"),
      import("./adapters/understanding/llm.ts"),
    ]);
    const endpoint = s.require("AZURE_OPENAI_ENDPOINT");
    const apiKey = s.require("AZURE_OPENAI_API_KEY");
    const apiVersion = s.get("AZURE_OPENAI_API_VERSION");
    const dimensions = positiveInteger(s, "EMBEDDING_DIMENSIONS");
    return {
      embedder: new AzureOpenAIEmbedder({ endpoint, apiKey, apiVersion, dimensions, deployment: s.require("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") }),
      understander: new AzureOpenAIUnderstander({ endpoint, apiKey, apiVersion, deployment: s.require("AZURE_OPENAI_CHAT_DEPLOYMENT") }, UNDERSTANDING_PROMPT, log),
    };
  }
  const [{ OpenAICompatibleEmbedder }, { OpenAICompatibleUnderstander }] = await Promise.all([
    import("./adapters/memory/vectors.ts"),
    import("./adapters/understanding/llm.ts"),
  ]);
  // Embeddings and chat may live at different OpenAI-compatible hosts
  // (e.g. Ollama for embeddings, Anthropic's compatibility endpoint for chat).
  const baseUrl = s.get("EMBEDDING_API_BASE") ?? "https://openrouter.ai/api/v1";
  const apiKey = s.get("EMBEDDING_API_KEY") ?? s.require("OPENROUTER_API_KEY");
  const dimensions = positiveInteger(s, "EMBEDDING_DIMENSIONS");
  const embedder = new OpenAICompatibleEmbedder({ baseUrl, apiKey, dimensions, model: s.get("EMBEDDING_MODEL") ?? "openai/text-embedding-3-small" });
  const chatBase = s.get("CHAT_API_BASE") ?? baseUrl;
  // A key is only shared between the two hosts when they are the same host;
  // the embedding vendor's key must never be sent to a different chat vendor.
  const chatKey = s.get("CHAT_API_KEY") ?? (sameHost(chatBase, baseUrl) ? apiKey : undefined);
  if (!chatKey) throw new Error(`CHAT_API_KEY is required when CHAT_API_BASE (${hostOf(chatBase)}) is a different host from EMBEDDING_API_BASE (${hostOf(baseUrl)})`);
  const understander = new OpenAICompatibleUnderstander({ baseUrl: chatBase, apiKey: chatKey, model: s.get("CHAT_MODEL") ?? "openai/gpt-4o-mini" }, UNDERSTANDING_PROMPT, log);
  return { embedder, understander };
}

export async function compose(s: Settings, log: Log): Promise<{ ports: Ports; options: CoreOptions }> {
  const memoryKind = pick(s, "OB_MEMORY", KNOWN_MEMORY, "supabase");
  const ledgerKind = pick(s, "OB_LEDGER", KNOWN_LEDGER, "auto");
  const embedderKind = pick(s, "OB_EMBEDDER", KNOWN_EMBEDDER, "models");
  const understandingKind = pick(s, "OB_UNDERSTANDING", KNOWN_UNDERSTANDING, "models");
  const gateKind = pick(s, "OB_GATE", KNOWN_GATE, "shared-key");

  // The model branch is entered lazily and at most once, and only if a socket asks for it.
  let built: { embedder: Embedder; understander: Understander } | undefined;
  const fromModels = async () => (built ??= await models(s, log));

  // Embedder. Keyword memory never asks; the others do.
  const embedder = async (): Promise<Embedder> => {
    switch (embedderKind) {
      case "bag-of-words": {
        const { BagOfWordsEmbedder } = await import("./adapters/memory/vectors.ts");
        return new BagOfWordsEmbedder(positiveInteger(s, "EMBEDDING_DIMENSIONS") ?? 256);
      }
      case "fake": {
        const { FakeEmbedder } = await import("./adapters/memory/vectors.ts");
        return new FakeEmbedder(positiveInteger(s, "EMBEDDING_DIMENSIONS") ?? 1536);
      }
      default:
        return (await fromModels()).embedder;
    }
  };

  // Memory. Only the chosen implementation is loaded. The Postgres one is kept typed so the ledger can share its pool.
  let pgMemory: import("./adapters/memory/postgres.ts").PostgresMemory | undefined;
  const buildMemory = async (kind: string): Promise<Memory> => {
    switch (kind) {
      case "postgres": {
        const { PostgresMemory } = await import("./adapters/memory/postgres.ts");
        const pg = new PostgresMemory(s.require("OB_PG_URL"), await embedder(), log);
        try {
          await pg.assertSchema();
        } catch (e) {
          await pg.close().catch(() => {});
          throw e;
        }
        pgMemory = pg;
        return pg;
      }
      case "keyword": {
        const { KeywordMemory } = await import("./adapters/memory/keyword.ts");
        log.warn("memory.volatile", { memory: "keyword" });
        return new KeywordMemory();
      }
      case "vector": {
        const { VectorMemory } = await import("./adapters/memory/vector-in-process.ts");
        log.warn("memory.volatile", { memory: "vector" });
        return new VectorMemory(await embedder());
      }
      case "jsonfile": {
        const { JsonFileMemory } = await import("./adapters/memory/jsonfile.ts");
        return new JsonFileMemory(s.require("OB_MEMORY_DIR"), await embedder());
      }
      case "sqlite": {
        const { SqliteMemory } = await import("./adapters/memory/sqlite.ts");
        return new SqliteMemory(s.require("OB_SQLITE_FILE"), await embedder());
      }
      case "chaos": {
        const { ChaosMemory } = await import("./adapters/memory/chaos.ts");
        const innerKind = pick(s, "OB_CHAOS_INNER", KNOWN_MEMORY.filter((k) => k !== "chaos") as unknown as readonly string[], "keyword");
        const inner = await buildMemory(innerKind);
        log.warn("memory.chaos", { inner: innerKind, failEvery: s.get("OB_CHAOS_FAIL_EVERY") ?? "0" });
        return new ChaosMemory(inner, { failEvery: positiveInteger(s, "OB_CHAOS_FAIL_EVERY"), delayMs: positiveInteger(s, "OB_CHAOS_DELAY_MS") });
      }
      default: {
        const { SupabaseMemory } = await import("./adapters/memory/supabase.ts");
        return new SupabaseMemory(s.require("SUPABASE_URL"), s.require("SUPABASE_SERVICE_ROLE_KEY"), await embedder(), log);
      }
    }
  };
  const memory = await buildMemory(memoryKind);

  // Ledger. A fact is never a thought, so the ledger has its own store. "auto"
  // follows the memory: the same Postgres or SQLite file, a JSONL file beside a
  // JSON-file memory, and in-process (volatile, warned) for the in-process memories.
  const resolvedLedger = ledgerKind !== "auto" ? ledgerKind : memoryKind === "postgres" ? "postgres" : memoryKind === "sqlite" ? "sqlite" : memoryKind === "jsonfile" ? "jsonl" : "in-process";
  let ledger: Ledger;
  switch (resolvedLedger) {
    case "postgres": {
      if (!pgMemory) throw new Error("OB_LEDGER=postgres needs OB_MEMORY=postgres (the ledger shares the memory's connection pool)");
      const { PostgresLedger } = await import("./adapters/ledger/postgres.ts");
      ledger = new PostgresLedger(pgMemory, await embedder(), log);
      break;
    }
    case "sqlite": {
      const { SqliteLedger } = await import("./adapters/ledger/sqlite.ts");
      ledger = new SqliteLedger(s.get("OB_LEDGER_FILE") ?? s.require("OB_SQLITE_FILE"));
      break;
    }
    case "jsonl": {
      const { JsonlLedger } = await import("./adapters/ledger/in-process.ts");
      ledger = new JsonlLedger(s.get("OB_LEDGER_FILE") ?? `${s.require("OB_MEMORY_DIR")}/ledger.jsonl`);
      break;
    }
    default: {
      const { InProcessLedger } = await import("./adapters/ledger/in-process.ts");
      log.warn("ledger.volatile", { ledger: "in-process" });
      ledger = new InProcessLedger();
    }
  }

  // Understanding.
  let understander: Understander;
  switch (understandingKind) {
    case "rules": {
      const { RulesUnderstander } = await import("./adapters/understanding/rules.ts");
      understander = new RulesUnderstander();
      break;
    }
    case "null": {
      const { NullUnderstander } = await import("./adapters/understanding/llm.ts");
      log.warn("understanding.null", {});
      understander = new NullUnderstander();
      break;
    }
    default:
      understander = (await fromModels()).understander;
  }

  // Gate.
  let gate: Gate;
  const tenant = s.get("OB_TENANT") ?? "default";
  switch (gateKind) {
    case "keyring": {
      const { KeyringGate } = await import("./adapters/gate-more.ts");
      gate = new KeyringGate(s.require("OB_KEYS"), s.get("OB_ALLOW_QUERY_KEY") === "true");
      break;
    }
    case "trusted-headers": {
      const { TrustedHeadersGate } = await import("./adapters/gate-more.ts");
      gate = new TrustedHeadersGate(s.require("OB_TRUST_SECRET"));
      break;
    }
    case "deny-all": {
      const { DenyAllGate } = await import("./adapters/gate-more.ts");
      log.warn("gate.deny-all", {});
      gate = new DenyAllGate();
      break;
    }
    default: {
      const { SharedKeyGate } = await import("./adapters/gate.ts");
      gate = new SharedKeyGate(s.require("MCP_ACCESS_KEY"), { tenant, allowQueryKey: s.get("OB_ALLOW_QUERY_KEY") !== "false" });
    }
  }
  assertCompatible(memory, gate);
  const options: CoreOptions = { citationBase: s.get("OPEN_BRAIN_CITATION_BASE_URL") ?? "https://openbrain.local/thoughts" };

  log.info("compose.ready", { memory: memoryKind, ledger: resolvedLedger, embedder: embedderKind, understanding: understandingKind, gate: gateKind, tenant });
  return { ports: { memory, ledger, understander, gate, log }, options };
}
