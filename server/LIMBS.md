# Limbs: plugging anything into Grysstof

The pictures are in [`ARCHITECTURE.md`](ARCHITECTURE.md). Read this if you want Grysstof to run on a store, a model, a login scheme or a log sink it does not ship with. It is written so that a developer, or an agent given this file, can add one without reading anything else first.

## The idea

The **body** is `core/`: the MCP tools, the HTTP layer, the rules about what a thought and a fact are. It never names a vendor, never opens a socket, never reads the environment. [`tests/architecture.test.ts`](tests/architecture.test.ts) fails the build if it ever does.

The body has seven **sockets**. Each socket is a TypeScript interface in `core/ports/` with its promises written in the file as plain sentences. A **limb** is one file in `adapters/` that implements one socket. [`compose.ts`](compose.ts) is the only file that knows which limbs exist; it reads `OB_*` variables and plugs one limb into each socket at boot.

Two limbs that pass the same socket's contract tests are interchangeable. The tools cannot tell them apart; [`tools/matrix.ts`](tools/matrix.ts) proves it by running the same transcript through nine combinations and comparing the output byte for byte.

## The sockets

| Socket | Port (the contract) | What a limb must do | Contract tests | Limbs that ship | Chosen by |
|---|---|---|---|---|---|
| Memory | [`core/ports/memory.ts`](core/ports/memory.ts) | remember a thought (merging repeats), recall by similarity, get by id, list recent with filters, summarise; partition by tenant or declare that it cannot | [`tests/memory.contract.ts`](tests/memory.contract.ts) | [`supabase`](adapters/memory/supabase.ts), [`postgres`](adapters/memory/postgres.ts), [`sqlite`](adapters/memory/sqlite.ts), [`jsonfile`](adapters/memory/jsonfile.ts), [`vector`](adapters/memory/vector-in-process.ts), [`keyword`](adapters/memory/keyword.ts), [`chaos`](adapters/memory/chaos.ts) | `OB_MEMORY` |
| Ledger | [`core/ports/ledger.ts`](core/ports/ledger.ts) | append facts, never edit; latest and history per subject; confirm; supersede with cycle and tenant checks; find by similarity; list subjects | [`tests/ledger.contract.ts`](tests/ledger.contract.ts) | [`postgres`](adapters/ledger/postgres.ts), [`sqlite`](adapters/ledger/sqlite.ts), [`jsonl`, `in-process`](adapters/ledger/in-process.ts) | `OB_LEDGER` |
| Embedder | [`adapters/memory/vectors.ts`](adapters/memory/vectors.ts) (`Embedder`) | turn text into a vector of a declared width, name the model | exercised through every vector memory's contract run | `models` (any OpenAI-shaped `/embeddings`, incl. Ollama), `bag-of-words`, `fake` (all in [`vectors.ts`](adapters/memory/vectors.ts)) | `OB_EMBEDDER` |
| Understanding | [`core/ports/understanding.ts`](core/ports/understanding.ts) | given text, return people, topics, action items, dates and a type; never throw for bad text, return `UNDERSTOOD_NOTHING` | [`tests/limbs-batch2.test.ts`](tests/limbs-batch2.test.ts) | [`models`](adapters/understanding/llm.ts) (any OpenAI-shaped chat API), [`rules`](adapters/understanding/rules.ts), `null` | `OB_UNDERSTANDING` |
| Gate | [`core/ports/gate.ts`](core/ports/gate.ts) | look at a request, say allowed or not, and if allowed name the tenant and the actor; declare whether it admits one tenant or many | [`tests/gates.test.ts`](tests/gates.test.ts) | [`shared-key`](adapters/gate.ts), [`keyring`, `trusted-headers`, `deny-all`](adapters/gate-more.ts) | `OB_GATE` |
| Settings | [`core/ports/settings.ts`](core/ports/settings.ts) | `get(name)` and `require(name)` | [`tests/limbs-batch2.test.ts`](tests/limbs-batch2.test.ts) | [`env`](adapters/settings.ts), [`file`, `layered`](adapters/settings-more.ts) | code, in `entry/` |
| Log | [`core/ports/log.ts`](core/ports/log.ts) | `info`, `warn`, `error(event, fields, err)`; never throw | [`tests/limbs-batch2.test.ts`](tests/limbs-batch2.test.ts) | [`console`](adapters/log.ts), [`jsonl`, `throwing`](adapters/log-more.ts) | code, in `entry/` |

Every knob and its default is listed at the top of [`compose.ts`](compose.ts).

## What has been proven to work together

`deno task matrix` boots each row below as a real HTTP server, runs the same client transcript (capture, recall, facts, supersede, denial) through it, and compares the transcripts. Rows 3, 4, 5, 6 and 8 produce output byte-identical to row 1. Row 2 must refuse to boot and does. Row 7 is expected to differ (it fails on purpose). Row 9 must deny everything and does. Row 10 is upstream's defaults (Supabase + OpenRouter) and runs wherever those keys are present.

| Row | Memory | Ledger | Embedder | Understanding | Gate | Why this row exists |
|---|---|---|---|---|---|---|
| 1 | keyword | in-process | none | rules | shared-key | zero models, zero vendors, no key of any kind |
| 2 | vector | in-process | bag-of-words | rules | keyring | a single-tenant memory behind a many-tenant gate: compose must refuse |
| 3 | jsonfile | jsonl | bag-of-words | null | keyring | file persistence on both stores |
| 4 | sqlite | sqlite | bag-of-words | rules | trusted-headers | second SQL dialect; identity from a proxy |
| 5 | postgres | postgres | Ollama | Anthropic | keyring | the production shape: pgvector, local embeddings, a chat model |
| 6 | postgres | in-process | Ollama | rules | keyring | ledger on a different store than memory |
| 7 | chaos over postgres | postgres | bag-of-words | null | shared-key | every fourth call fails: error paths, never a crash |
| 8 | vector | in-process | bag-of-words | null | shared-key | the core's guards with offline vectors and no tagging |
| 9 | keyword | in-process | none | rules | deny-all | denial end to end |
| 10 | supabase | auto | OpenRouter | OpenRouter | shared-key | upstream's defaults, unchanged |

Results land in `.matrix-out/`. Add a row for your limb and run it.

## Adding a limb, step by step

The example is a memory on Microsoft SQL Server. Every other socket follows the same four steps with a smaller interface.

### 1. Read the port

[`core/ports/memory.ts`](core/ports/memory.ts) is 100 lines and half of it is the promises. Read the promises, not just the signatures. The ones that catch people:

- `remember` with content the memory already holds returns the existing id with `alreadyKnown: true` and merges metadata. "Already holds" is your notion; every shipped limb uses the fingerprint in [`adapters/memory/shared.ts`](adapters/memory/shared.ts) (lower-cased, whitespace-collapsed, Unicode-normalised). Use it.
- `recall` scores are in `[0, 1]`; only strictly greater than `minScore` comes back. `limit` and `minScore` bounds are shared code (`bounds()` in `shared.ts`); call it, do not reimplement it.
- `recent` filters are AND-ed; `since` that is not ISO 8601 is an `Error`, never an empty list.
- `isolation` is `"tenant"` if you partition by `scope.tenant`, `"none"` if you hold one tenant's thoughts and ignore it. Compose refuses a `"none"` memory behind a gate that admits many tenants.
- Blank content is an `Error`. Ids are opaque strings you hand back unchanged.

### 2. Write the limb

One file, `adapters/memory/mssql.ts`. It may import the port, `shared.ts`, `vectors.ts` (for the `Embedder`), and its own driver. It may not import anything from `core/` except `core/ports/`. The shape, from [`jsonfile.ts`](adapters/memory/jsonfile.ts):

```ts
import type { Memory, Recalled, RecentQuery, Scope, Summary, Thought, ThoughtMetadata } from "../../core/ports/mod.ts";
import { boundLimit, bounds, fingerprint, parseSince, tally } from "./shared.ts";
import type { Embedder } from "./vectors.ts";

export class MssqlMemory implements Memory {
  readonly isolation = "tenant" as const;
  constructor(private readonly connectionString: string, private readonly embedder: Embedder) {}

  async remember(scope: Scope, content: string, metadata: ThoughtMetadata) { /* fingerprint → known? merge : embed + insert */ }
  async known(scope: Scope, content: string) { /* fingerprint lookup, no embedding */ }
  async recall(scope: Scope, query: string, opts: { limit: number; minScore: number }) { /* embed query, cosine, bounds() */ }
  async get(scope: Scope, id: string) { /* by id within tenant, else null */ }
  async recent(scope: Scope, q: RecentQuery) { /* newest first, filters AND-ed, parseSince(q.since) */ }
  async summary(scope: Scope) { /* count, oldest, newest, tally() of types/topics/people */ }
}
```

Every method takes `scope` first and must scope by `scope.tenant`. `scope.actor` may be recorded, never used to partition.

### 3. Run the contract against it

Three lines in a new `tests/memory-mssql.test.ts`:

```ts
import { runMemoryContract } from "./memory.contract.ts";
import { MssqlMemory } from "../adapters/memory/mssql.ts";
import { FakeEmbedder } from "../adapters/memory/vectors.ts";

runMemoryContract("mssql", async () => ({ memory: new MssqlMemory(Deno.env.get("OB_MSSQL_URL")!, new FakeEmbedder()), close: async () => {} }));
```

`deno task test` now runs the whole memory contract against your limb: tenancy, merging, Unicode sameness, bounds, error cases. Look at [`tests/memory-postgres.test.ts`](tests/memory-postgres.test.ts) for how a limb that needs a live database skips cleanly when its URL is absent and refuses to run against anything not named `*_test`. Also run [`tests/adversarial.test.ts`](tests/adversarial.test.ts) (add your factory to its list); it tries to cross tenants, forge provenance and smuggle bad input.

### 4. Make it selectable

One `case` in [`compose.ts`](compose.ts), next to the others:

```ts
case "mssql": {
  const { MssqlMemory } = await import("./adapters/memory/mssql.ts");
  return new MssqlMemory(s.require("OB_MSSQL_URL"), await embedder());
}
```

and `"mssql"` added to `KNOWN_MEMORY`. Now `OB_MEMORY=mssql OB_MSSQL_URL=... deno task serve` runs the whole server on it: the tools, `/browse`, the hooks, the matrix. Nothing else in the repo learns the limb exists.

Optionally add a matrix row in [`tools/matrix.ts`](tools/matrix.ts) with `needs: ["OB_MSSQL_URL"]` so it is skipped where the database is absent and compared where it is present.

## The other sockets, shorter

**Ledger** ([`core/ports/ledger.ts`](core/ports/ledger.ts)): six verbs plus `subjects`. The hard rules are in the port's comment: append only, provenance from `scope` not from the caller, `supersede` refuses another tenant, another subject, itself, an already-superseded line and any cycle. Start from [`adapters/ledger/in-process.ts`](adapters/ledger/in-process.ts): it is an event engine (`assert`, `confirm`, `supersede` events, one `apply`), so a persisting limb only has to override `record()` to write the event and replay on boot. `sqlite.ts` is 35 lines for exactly that reason. Contract: `runLedgerContract`.

**Embedder** (`Embedder` in [`adapters/memory/vectors.ts`](adapters/memory/vectors.ts)): `dimensions`, `model`, `embed(text)`. Widths must match the store's vector column; Postgres checks this at boot and refuses.

**Understanding** ([`core/ports/understanding.ts`](core/ports/understanding.ts)): `understand(text)` returns `{ people, action_items, dates_mentioned, topics, type }`. Return `UNDERSTOOD_NOTHING` on anything you cannot parse; the body relies on this never throwing. [`rules.ts`](adapters/understanding/rules.ts) is 49 lines and needs no model.

**Gate** ([`core/ports/gate.ts`](core/ports/gate.ts)): `tenants: "one" | "many"` and `authorise(request)` returning `{ allowed: true, tenant, actor }` or `{ allowed: false, challenge? }`. The tenant name must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`. A challenge (status + headers) is relayed to the client untouched, which is how an OAuth gate would ask for a token. Nothing downstream ever takes tenant or actor from the caller; your gate is the only place they come from.

**Settings** and **Log** are two- and three-method interfaces; the shipped limbs are the whole example.

## Rules the body enforces (and tests)

| Rule | Enforced by |
|---|---|
| `core/` imports only `core/` and the framework; never an adapter, never a vendor, never `fetch`, never `Deno.env` | [`tests/architecture.test.ts`](tests/architecture.test.ts) |
| Port files hold types and constants only | same |
| A limb is built only inside `compose.ts` | convention; the architecture test catches a core import of an adapter |
| A `"none"`-isolation memory never sits behind a `"many"`-tenant gate | `assertCompatible` in [`compose.ts`](compose.ts), matrix row 2 |
| The store's vector width matches the embedder's | Postgres limb at boot; `EMBEDDING_DIMENSIONS` |
| A fact is never a thought: nothing asserted through the ledger appears in `recall`, `recent` or `summary` | [`tests/app.e2e.test.ts`](tests/app.e2e.test.ts) |
| Any limb may fail; the tool result is `isError` with the limb's message and one error log line, never a crash | `chaos` limb, [`tests/limbs-batch2.test.ts`](tests/limbs-batch2.test.ts) |

## Checklist for an agent adding a limb

1. Read the port file for the socket in full, including the comment block.
2. Write one file under `adapters/<socket>/`. Import the port, `shared.ts` where it exists, and your driver. Nothing from `core/` beyond `core/ports/`.
3. Wire the contract test with a factory. Make it green. Add the factory to `tests/adversarial.test.ts` if the socket is memory or ledger.
4. Add the `case` to `compose.ts` and the name to the `KNOWN_*` list. Add any knob to the comment block at the top of `compose.ts`.
5. `deno task check`, `deno task test`, and if the limb needs a live service, run its contract with the service up.
6. Add a matrix row and run `deno task matrix`. Your row's transcript should match row 1's.
7. Add the limb to the table in this file and to the socket table in the README.
