# How Grysstof fits together

Five pictures. Names in the boxes are the names in the code. The written contracts behind each socket, and how to add a limb, are in [`LIMBS.md`](LIMBS.md).

## 1. The body and its sockets

The body never touches the outside world. Everything it needs comes in through seven sockets; a limb fills each one.

```mermaid
flowchart LR
  subgraph body["core/  (the body: no vendor, no network, no env)"]
    direction TB
    tools["10 MCP tools<br/>capture · recall · recent · get · summary · search/fetch<br/>find_facts · fact_history · confirm_fact · supersede_fact"]
    http["HTTP layer<br/>/mcp · /browse · /browse/api"]
    ports["core/ports/<br/>Memory · Ledger · Understanding · Gate · Settings · Log<br/>(+ Embedder, adapter-side)"]
    tools --> ports
    http --> tools
  end

  compose["compose.ts<br/>reads OB_* and plugs one limb into each socket"]

  subgraph limbs["adapters/  (the limbs)"]
    direction TB
    mem["Memory<br/>supabase · postgres · sqlite<br/>jsonfile · vector · keyword · chaos"]
    led["Ledger<br/>postgres · sqlite · jsonl · in-process"]
    emb["Embedder<br/>models (OpenAI-shaped, Ollama) · bag-of-words · fake"]
    und["Understanding<br/>models · rules · null"]
    gate["Gate<br/>shared-key · keyring · trusted-headers · deny-all"]
    misc["Settings: env · file · layered<br/>Log: console · jsonl"]
  end

  compose -. "builds one of each" .-> limbs
  limbs -- "implement" --> ports
```

`tests/architecture.test.ts` fails the build if anything in `core/` imports an adapter, a vendor SDK, `fetch` or `Deno.env`.

## 2. One request, end to end

Where the tenant and the actor come from, and why a tool argument can never override them.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client<br/>(Claude Code, Cursor, ChatGPT, /browse page)
  participant H as HTTP (core/app.ts)
  participant G as Gate limb
  participant T as Tool (core)
  participant U as Understanding limb
  participant E as Embedder limb
  participant M as Memory limb
  participant L as Ledger limb

  C->>H: POST /mcp  x-brain-key, x-brain-actor
  H->>G: authorise(request)
  G-->>H: { allowed, tenant, actor }  or  { denied, challenge }
  Note over H: scope = { tenant, actor } is fixed here.<br/>No tool argument can change it.
  H->>T: capture_thought(content, subject?)  with scope
  alt no subject: a thought
    T->>U: understand(content)
    U-->>T: people, topics, type, dates, actions
    T->>M: remember(scope, content, metadata)
    M->>E: embed(content)  (only if not already known)
    M-->>T: { id, alreadyKnown }
  else subject given: a fact
    T->>L: assert(scope, { subject, claim, source, proof })
    L-->>T: Fact  (learnedBy = scope.actor, learnedAt = now)
  end
  T-->>H: text result  (isError on any limb failure, never a crash)
  H-->>C: response + x-request-id
```

## 3. A fact is not a thought

Two stores, two sets of rules, no leakage between them.

```mermaid
flowchart TB
  subgraph thoughts["Thoughts  (Memory port)"]
    direction LR
    t1["free text + metadata<br/>people · topics · type"]
    t2["same text again → merges<br/>(fingerprint)"]
    t3["found by meaning<br/>recall / search"]
    t1 --> t2 --> t3
  end

  subgraph facts["Facts  (Ledger port)"]
    direction LR
    f1["subject · claim · source · proof<br/>learnedBy · learnedAt"]
    f2["same claim again → a new line<br/>(append only, never edited)"]
    f3["newer line supersedes older<br/>old one stays, marked"]
    f4["a person confirms a line"]
    f1 --> f2 --> f3 --> f4
  end

  cap["capture_thought"]
  cap -- "no subject" --> thoughts
  cap -- "subject given" --> facts

  q1["recall · recent · summary"] --> thoughts
  q2["find_facts · fact_history · latest"] --> facts

  thoughts x--x facts
```

`tests/app.e2e.test.ts` pins that nothing asserted as a fact ever appears in `recall`, `recent` or `summary`.

## 4. Tenants: one checkout, many memories

The gate decides the tenant; the limbs partition by it; the same code serves as many instances as you start.

```mermaid
flowchart LR
  subgraph one["one checkout of the code"]
    direction TB
    p["instance :8787<br/>.env.personal<br/>OB_TENANT=personal"]
    x["instance :8788<br/>.env.work<br/>OB_TENANT=work"]
  end

  pg[("Postgres<br/>grysstof_personal")]
  px[("Postgres<br/>grysstof_work")]
  p --> pg
  x --> px

  k1["key A"] --> p
  k2["key B"] --> x

  subgraph many["or: one instance, keyring gate"]
    direction TB
    i["instance :8787<br/>OB_GATE=keyring<br/>OB_KEYS=a=alice:agent,b=bob:agent"]
    db[("one database<br/>rows carry tenant")]
    i --> db
  end
  ka["key a → tenant alice"] --> i
  kb["key b → tenant bob"] --> i
```

`compose.ts` refuses to pair a memory that cannot partition (`isolation: "none"`) with a gate that admits many tenants.

## 5. Plugging in something new

What changes when you add a store the project has never seen. Everything grey stays exactly as it is.

```mermaid
flowchart LR
  port["core/ports/memory.ts<br/>the contract (unchanged)"]
  new["adapters/memory/mssql.ts<br/>NEW: implements Memory"]
  test["tests/memory-mssql.test.ts<br/>NEW: runMemoryContract('mssql', …)"]
  comp["compose.ts<br/>+ one case: 'mssql'"]
  env["OB_MEMORY=mssql"]
  rest["tools · HTTP · /browse · hooks · matrix<br/>(unchanged, never learn the store exists)"]

  port -. read .-> new
  new --> test
  test -- "green" --> comp
  env --> comp
  comp --> rest

  classDef same fill:#eee,stroke:#999,color:#333
  classDef fresh fill:#dff5e1,stroke:#2e8b57,color:#1a3
  class port,rest same
  class new,test,comp fresh
```

Three files touched, one of them a one-line `case`. The matrix (`deno task matrix`) then proves the new row answers the same transcript byte for byte as the in-memory row.
