# Grysstof

A shared memory for your AI tools that does not care where it is stored.

Grysstof is [Open Brain](https://github.com/NateBJones-Projects/OB1) by [Nate B. Jones](https://natesnewsletter.substack.com/), taken apart and put back together so that the storage, the AI models, the login and the logging are each a part you can swap. Same six MCP tools, same behaviour, same Supabase setup if that is what you want. Plus a few things Open Brain does not have: a fact ledger, more than one tenant, and a page to look at what is inside.

Out of the box it *is* Open Brain: run it with no settings and it talks to Supabase exactly as Nate's version does. Set one variable and it talks to Postgres in Docker instead. Set another and it runs from a JSON file on disk with no database at all.

> Open Brain was created by [Nate B. Jones](https://natesnewsletter.substack.com/). Follow his [Substack](https://natesnewsletter.substack.com/) for updates and the companion prompt pack, and join his [Discord](https://discord.gg/Cgh9WJEkeG) for help and community. His original README, setup guide and companion material are kept unchanged in [`docs/open-brain-README.md`](docs/open-brain-README.md) and [`docs/`](docs/). If you want the Open Brain experience as he designed it, start there. Everything in his repo still works here.

## Why this exists

Open Brain is good. It is also welded to Supabase: the vector search, the deduplication, the auth, the dashboard, all of it. If your company cannot use Supabase, or you want your memory on a laptop, or on Azure, or in a plain file, you were stuck.

Grysstof takes the thinking part (the tools, the rules about what a memory is) and puts it in the middle with no vendor in it. Everything that touches the outside world plugs in around it. We call the middle the **body** and the plug-ins **limbs**, because that is how it feels: the body does not change when you swap an arm.

## Start it

You need [Deno](https://deno.com) 2.x. Everything runs from the `server/` folder.

**Option A: Supabase, the Open Brain way.** Follow [Nate's setup guide](docs/01-getting-started.md). No new steps; Grysstof reads the same `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `MCP_ACCESS_KEY`.

**Option B: Postgres on your own machine.** A container with pgvector, a local embedder, and the server:

```sh
docker run -d --name grysstof-pg -p 55432:5432 -e POSTGRES_PASSWORD=choose-one pgvector/pgvector:pg16
docker exec grysstof-pg psql -U postgres -c "create database grysstof"
ollama pull nomic-embed-text            # free, local, 768-wide embeddings

cd server
cp .env.example .env                    # fill in the password, a key for the server, and a chat-model key
deno task migrate:env                   # creates the tables
deno task serve:env                     # http://localhost:8787/mcp
```

**Option C: nothing installed.** A JSON file and word-overlap search (so "runs from a JSON file" finds the thought, "nothing installed" does not; search by meaning needs an embedder, see Option B). Good enough to try the tools in a minute.

```sh
cd server
OB_MEMORY=jsonfile OB_MEMORY_DIR=./data OB_EMBEDDER=bag-of-words OB_UNDERSTANDING=rules MCP_ACCESS_KEY=try-me deno task serve
```

Then point any MCP client at `http://localhost:8000/mcp` (or 8787 for option B) with the header `x-brain-key: <your key>`. Claude Code:

```sh
claude mcp add --transport http grysstof http://localhost:8787/mcp --header "x-brain-key: <your key>"
```

Open `http://localhost:8787/browse` in a browser to see what it holds.

## Plugging things in

Every outside dependency is a socket on the body. Each socket has a written contract (in `server/core/ports/`) and a test suite that any plug-in must pass (in `server/tests/*.contract.ts`). You choose a plug-in per socket with one environment variable:

| Socket | What it does | Variable | Plug-ins that ship |
|---|---|---|---|
| Memory | stores thoughts and finds similar ones | `OB_MEMORY` | `supabase` (default), `postgres`, `sqlite`, `jsonfile`, `vector`, `keyword`, `chaos` |
| Ledger | stores facts, keeps their history | `OB_LEDGER` | `auto` (default: same store as memory), `postgres`, `sqlite`, `jsonl`, `in-process` |
| Embedder | turns text into vectors | `OB_EMBEDDER` | `models` (default: any OpenAI-shaped API, incl. Ollama), `bag-of-words`, `fake` |
| Understanding | pulls topics, people and actions out of a thought | `OB_UNDERSTANDING` | `models` (default: any OpenAI-shaped chat API), `rules`, `null` |
| Gate | decides who may in and whose memory it is | `OB_GATE` | `shared-key` (default), `keyring`, `trusted-headers`, `deny-all` |
| Settings | where the variables come from | code only | environment, `.env` file, layered |
| Log | where log lines go | code only | console, JSONL file |

Mix them however you like. Postgres memory with a JSONL ledger. Supabase memory with local Ollama embeddings. SQLite everything on a Raspberry Pi. `deno task matrix` runs ten such combinations and checks that the tools answer the same on all of them.

### Writing your own

Say you want memory in Microsoft SQL, or Qdrant, or an Obsidian vault. Three steps:

1. **Read the contract.** `server/core/ports/memory.ts` says in plain words what a memory must do: remember, recall by meaning, get by id, list recent, summarise, and the rules (same text is the same thought; scores are 0 to 1; a tenant never sees another tenant's thoughts).
2. **Write the limb.** One file in `server/adapters/memory/`. Look at `jsonfile.ts` (170 lines) for the smallest real one, or `postgres.ts` for the full one. It imports only the port, never the body.
3. **Run the contract against it.** Add three lines to a test file calling `runMemoryContract("mssql", () => ...)`. When those tests are green, it is a memory. Add one `case` to `compose.ts` and it is selectable by `OB_MEMORY=mssql`.

Nothing else changes. The tools, the HTTP layer, the browse page and the hooks never learn the new store exists. A test (`tests/architecture.test.ts`) fails the build if anything in the body ever mentions a vendor, the network or the environment.

## What it adds to Open Brain

**A fact is not a thought.** Thoughts are what Open Brain stores: free text, merged when it repeats, searched by meaning. A *fact* is a line in a ledger: *about* something (`client:acme`, `repo:api`, `person:sam`), a claim, where it was learned, by whom, when, and a link to the proof. Nothing in the ledger is ever edited. A newer line can *supersede* an older one; the old one stays, marked. A person can *confirm* a line. Four tools: `find_facts`, `fact_history`, `confirm_fact`, `supersede_fact`; `capture_thought` with a `subject` writes one. Facts never show up in thought searches and vice versa.

**Tenants.** Every call carries a scope, `{ tenant, actor }`, produced by the gate and never by the caller. A key maps to a tenant; two keys, two memories that cannot see each other. The `keyring` gate takes many keys; `trusted-headers` takes tenant and actor from a proxy you trust.

**A browser.** `GET /browse` on any instance: subjects and their fact history, a graph of facts (with supersede arrows) and of thoughts hung off the people, topics and clients they mention, search by meaning across both. It calls the same tools through the same gate, so it works on every store.

**Claude Code hooks.** `server/entry/session-start-recall.ts` hands a new session what earlier sessions in the same folder recorded; `session-end-capture.ts` writes one fact per finished session. Register both in `~/.claude/settings.json` (the file headers show how).

**Tests.** 270 offline, 290 with a Postgres, including a contract suite per socket, an adversarial suite that tries to cross tenants and forge provenance, and a `chaos` limb that fails on purpose to prove the body copes.

## Layout

```
server/
  core/        the body: tools, HTTP, ports (no vendor, no network, no env)
  adapters/    the limbs, one folder per socket
  compose.ts   the only file that names a limb; reads OB_* and wires the body
  entry/       ways to run it: serve, migrate, seed, the Claude Code hooks
  sql/         Postgres migrations
  tests/       contracts, e2e, adversarial, architecture
  tools/       matrix (every combination) and bench
```

## Credits and licence

Open Brain is Nate B. Jones's work and the reason this exists; the tool behaviour, the schemas, the recipes and the docs under `docs/`, `recipes/`, `extensions/`, `integrations/` and `skills/` are his and his contributors'. Grysstof keeps his [FSL-1.1-MIT licence](LICENSE.md) and his attribution. The word is Afrikaans for grey matter.
