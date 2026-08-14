# insurance-mcp-poc

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a life-insurance
back office — policy documents, in-flight applications, and product/underwriting rules — as tools an
LLM agent can call.

The point of the POC: an agent shouldn't need a bespoke integration per assistant. Implement the
domain once as an MCP server, and any MCP-capable client (Claude Code, Microsoft Foundry agents,
an internal chat surface) gets the same sixteen tools with the same contracts.

All data in this repository is **synthetic**. The schema, products, rules, and documents were
invented for this demo and are not derived from any production system.

Built alongside [Microsoft Applied Skills: Integrate model context protocol tools with agents in
Microsoft Foundry](https://learn.microsoft.com/api/credentials/share/en-us/VarunThupakula-1670/8851AA0DDD09A6F2?sharingId=3D36474C20E4579C).
That assessment covers the client side — attaching an MCP tool to a Foundry agent and validating its
calls. This repository is the other half: the server those tools come from.

## Quickstart

Requires Docker and Node 20+.

```bash
npm install
npm run setup     # starts Postgres+pgvector, seeds the corpus, runs the smoke test
```

`npm run setup` is the whole demo: it stands up the database, embeds and inserts 13 documents, then
connects to the MCP server as a real MCP client and exercises all sixteen tools. Expected tail:

```
Connected. Server exposes 16 tools:
  - search_policy_documents: Search policy documents
  - get_application_status: Get application status
  ...
  - update_requirement_status: Update requirement status
  - reassign_application: Reassign application
...
All tool calls completed.
```

Then `npm run demo` walks the chained flow an agent actually performs — see below. Tear down
with `npm run db:down`.

## The tools

Sixteen tools. The design rule: **a tool maps to a decision someone makes, not to a table.** There is no
`get_product` or `list_events` here — an agent that has to assemble answers from CRUD primitives
burns turns and invents joins. Each tool below answers a question a person actually asks.

**Case handling** — one known application

| Tool | Answers |
| --- | --- |
| `get_application_status` | "Where is APP-100242 and what is it waiting on?" Status, blocking step, underwriter, full event timeline. |
| `get_outstanding_requirements` | "Why isn't it moving, and what do I chase today?" Open requirements with age in days, plus the follow-up action the procedure calls for at 14 / 28 / 90 days. |
| `find_applicant` | "What's happening with Priya's application?" Name, whole or partial, to application numbers. Everything else here needs the number — this is how you get it. |
| `add_case_note` | "Record that I called the provider." Appends to the timeline. |
| `update_requirement_status` | "The APS came in." Marks a requirement received or waived and logs it. |

**Pipeline** — across the whole book

| Tool | Answers |
| --- | --- |
| `find_applications` | "What's stuck?" Filter by status, product, underwriter, state, or days untouched. |
| `get_underwriter_workload` | "Who is overloaded?" Open cases, face amount at risk, oldest untouched case per underwriter. |
| `get_pipeline_metrics` | "How are we doing?" Cases and face amount by status, plus outstanding requirements bucketed against the 14 / 28 / 90-day thresholds. |
| `reassign_application` | "Move this off D. Lindqvist." Reassigns and records why. |

**Sales and pricing** — before a case exists

| Tool | Answers |
| --- | --- |
| `find_eligible_products` | "What can I sell a 62-year-old in Texas for $2M?" Every issuable product plus the rules that will fire. The inverse of `lookup_product_rules`. |
| `estimate_premium` | "What will it cost?" Annual and monthly premium from the rate table, by age band and risk class. |
| `get_rate_card` | "How was that derived?" Every risk class and age band for a product. |
| `lookup_product_rules` | "What are the limits on UL-200?" Issue limits and underwriting rules; evaluates hard eligibility when given an applicant. |

**Knowledge**

| Tool | Answers |
| --- | --- |
| `search_policy_documents` | "What does the contract actually say?" Hybrid search over contracts, riders, guidelines and procedures, returning excerpts with `doc_id` so answers can cite a source. |
| `list_documents` | "What guidance exists for this product?" Enumerates the corpus without searching — also the fallback when a search returns nothing. |
| `get_document` | "Quote me the exact clause." One document in full, since search truncates excerpts at 600 characters. Also returns the product's underwriting rules, which is usually what a reader needs next. |

Thirteen of the sixteen are read-only and marked `readOnlyHint: true`. The three writers differ in a
way the annotations capture, because clients use them to decide what needs human confirmation:

| Tool | Semantics | Annotations |
| --- | --- | --- |
| `add_case_note` | Appends. Two calls write two notes. | `idempotentHint: false` |
| `update_requirement_status` | Edits a row, but re-applying the same value changes nothing. | `idempotentHint: true` |
| `reassign_application` | Overwrites the assignment; same target twice is a no-op. | `idempotentHint: true` |

None are marked destructive: nothing here deletes, and every writer checks its target exists first
and returns a plain "nothing was changed" result rather than throwing.

Try, once connected: *"Rowan Kessler's application is stuck — what's it waiting on, and what does the
guideline actually say about that requirement?"* No single tool answers that. The agent chains all
three, and `npm run demo` shows the same chain step by step:

```
[1] get_application_status("APP-100242")
      -> Rowan Kessler, age 61, SecureTerm 20-Year
      -> status=pending_underwriting  blocked on: awaiting_paramedical
      -> rules fired: TRM20-AGE-01, TRM20-FACE-01
[2] lookup_product_rules("TRM-20", age=61, face=1500000)
      -> TRM20-AGE-01 [require_evidence]: Applicants over 60 require a paramedical exam…
      -> TRM20-FACE-01 [refer]: Face amounts above $1,000,000 are referred…
[3] search_policy_documents("when is a paramedical examination required")
      -> GUIDE-UW-01  (rrf 0.03154, vector rank 6, text rank 1)
```

Note step 3: the right document ranked **6th by vector similarity but 1st by full-text**. Fusing the
two rankings is what surfaces it.

## How retrieval works

Hybrid search, fused with **Reciprocal Rank Fusion** (`score = Σ 1/(60 + rank_i)`).

Two things forced this design, both found by testing rather than assumed:

- **Weighted score blending doesn't work here.** Cosine similarity lands around 0.1–0.4 while
  `ts_rank_cd` returns values an order of magnitude smaller, so any fixed weighting lets whichever
  metric happens to be larger dominate. RRF combines *ranks*, which are scale-free.
- **`websearch_to_tsquery` ANDs every term**, so a full-sentence question matches zero documents and
  the hybrid silently degrades to vector-only. The operators are rewritten to `OR`, making the
  lexical side rank by how many query terms a document contains.

Each result reports `vector_rank` and `text_rank` alongside the fused `score`, so it stays visible
which half did the work — and a `text_rank` of `null` means that document matched no query term.

## Connecting it to Claude Code

```bash
claude mcp add insurance --  node /absolute/path/to/insurance-mcp-poc/src/index.js
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "insurance": {
      "command": "node",
      "args": ["/absolute/path/to/insurance-mcp-poc/src/index.js"],
      "env": { "DATABASE_URL": "postgres://insurance:insurance@localhost:55432/insurance" }
    }
  }
}
```

## What happens when a client calls a tool

Worth being precise about, because the common mental picture — "the model calls my API" — is wrong
in two ways. **The model never talks to this server.** The client does. And there is no HTTP
involved: this server speaks JSON-RPC 2.0 over its own stdin and stdout.

**Startup, once per session.** The client (Claude Code, a Foundry agent) *spawns this process* —
`node src/index.js` — and holds its stdin/stdout pipes. It sends `initialize`, the server replies
with protocol version and capabilities, the client sends the `initialized` notification. Then the
client calls `tools/list`, and the SDK answers with all sixteen tools: name, description, annotations,
and a **JSON Schema** for the arguments, which it generated from the zod schemas in `src/index.js`.

**The client puts those tool definitions into the model's context.** This is the step people skip.
The description strings above are not documentation — they are the prompt. A tool the model
misunderstands is a tool it calls wrongly, which is why each description says *when to reach for
this one* rather than just what it returns.

**Per call.** The model emits a tool-use request naming a tool and its arguments. The client — not
the model — sends:

```jsonc
// stdin →
{"jsonrpc":"2.0","id":7,"method":"tools/call",
 "params":{"name":"get_application_status","arguments":{"application_number":"APP-100242"}}}
```

The SDK validates `arguments` against that tool's schema and **rejects the call before the handler
runs** if it doesn't fit — the model gets a schema error back and can retry. On success it invokes
the handler, which runs parameterised SQL against Postgres and returns content blocks:

```jsonc
// ← stdout
{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{ \"application_number\": ... }"}]}}
```

The client feeds that result back into the model's context as the tool result, and the model decides
what to do next — often calling another tool, which is exactly the chain the demo above walks.

**Two distinct failure modes**, worth keeping straight:

- A **protocol error** (unknown tool, malformed arguments) returns a JSON-RPC `error`. The model sees
  it went wrong mechanically.
- A **tool-level failure** — "no application found with number APP-999999" — is a *successful*
  JSON-RPC response whose content says so. That's deliberate: it's information the model should
  reason about, not a crash. `add_case_note` does this rather than throwing, and writes nothing.

**Concurrency and lifetime.** Requests carry an `id`, so the client may have several in flight at
once; responses are matched by id, not by order. The process lives as long as the client session and
holds a `pg` connection pool across calls — so state like the pool is per-session, and anything you
want durable belongs in Postgres.

## How it fits together

```
MCP client (Claude Code / Foundry agent)
        │  stdio, JSON-RPC
        ▼
   src/index.js          tool definitions + zod input schemas
        │
        ├── src/embed.js  query → vector
        └── src/db.js     pg pool
                 │
                 ▼
        Postgres 16 + pgvector      docker-compose, port 55432
```

Layout: `src/index.js` (server and all sixteen tools) · `src/embed.js` (embedding) · `src/db.js`
(pool) · `db/init.sql` (schema + seed) · `scripts/seed.mjs` (documents + embeddings) ·
`scripts/smoke.mjs` (exercises every tool) · `scripts/demo.mjs` (the chained flow) ·
`scripts/benchmark.mjs` (retrieval quality).

## The embedding, and why it was measured

`src/embed.js` runs **all-MiniLM-L6-v2 locally, in-process**, via transformers.js (ONNX). No API
key, no separate service, no Python. Weights (~23MB quantized) download once on first use and cache
under `~/.cache/huggingface`; the model loads lazily on the first search, so spawning the server
stays instant.

It replaced a hashed bag-of-words stand-in, and `npm run benchmark` records what that was worth —
ten questions with a known-correct document, plus paraphrases that share no vocabulary with their
target:

| | hashed bag-of-words | all-MiniLM-L6-v2 |
| --- | --- | --- |
| vector only | 8/10 | **10/10** |
| full-text only | 9/10 | 9/10 |
| hybrid (RRF) | 9/10 | **10/10** |
| paraphrases | 1/3 | **2/3** |

The number that matters is the last row. The old embedding scored **0.0000** cosine between
"dies by suicide" and "takes their own life" — identical to its score against an unrelated sentence
about grace periods, because it matched shared words and those phrases share none. Full-text search
has the same ceiling for the same reason. Only a trained model can close that gap, and it is the
sole reason the vector half exists: on the ten literal questions, plain Postgres full-text was
already beating vector-only 9 to 8.

The one paraphrase still missed lands at **rank 3 of 13**, not wildly off, and adding a few words
of context ("...within two years of the policy date") puts it first. Short queries are ambiguous.

Changing model means changing `EMBEDDING_DIM` here **and** `vector(384)` in `db/init.sql`, then
`npm run db:down && npm run db:up && npm run seed`. Old vectors are meaningless under a new model.

## Notes and limitations

Worth stating plainly, since they're the things a reviewer would ask about:

- **No approximate index, on purpose.** An early version had `ivfflat ... WITH (lists = 10)` over 12
  rows. It silently returned wrong and short result sets — a single probe scans a near-empty
  partition. Approximate indexes only pay off at volume. At this corpus size an exact scan is both
  correct and instant; `db/init.sql` says where to add HNSW once the corpus justifies it.
- **Rules are data, not an engine.** `underwriting_rules.condition` holds plain-language conditions
  for the agent to reason over. Only the hard limits (age band, face band, state availability) are
  actually evaluated in code. A production version would compile these to an executable rule set —
  an LLM interpreting underwriting conditions free-hand is not something to ship.
- **No authentication or tenancy.** The server trusts its caller completely. Real deployment needs
  per-caller authorization, since these tools read customer data.
- **The model has no idea what insurance is.** It learned which phrases keep company with which,
  which is enough for paraphrase but leaves a known blind spot: antonyms and negation sit close
  together, because "the premium increased" and "the premium decreased" appear in near-identical
  contexts. For a policy corpus that is not academic — retrieving the opposite clause and citing it
  confidently is worse than returning nothing. It is the strongest argument for keeping the
  full-text half, which is dumb about meaning but never confuses "not covered" with "covered".
- **RRF ties are common and were non-deterministic.** A document ranked (1,2) scores identically to
  one ranked (2,1), and without a tie-break Postgres returned whichever the plan emitted first —
  the same query gave different answers in different contexts. Now broken by vector rank, then
  `doc_id`. Worth knowing if you fuse rankings anywhere else.
- **`node_modules` is 401MB.** Running the model in-process means shipping ONNX runtime binaries.
  A hosted embedding endpoint would trade that for an API key and a network hop.

## License

MIT
