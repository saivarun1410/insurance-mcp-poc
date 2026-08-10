# insurance-mcp-poc

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a life-insurance
back office — policy documents, in-flight applications, and product/underwriting rules — as tools an
LLM agent can call.

The point of the POC: an agent shouldn't need a bespoke integration per assistant. Implement the
domain once as an MCP server, and any MCP-capable client (Claude Code, Microsoft Foundry agents,
an internal chat surface) gets the same three tools with the same contracts.

All data in this repository is **synthetic**. The schema, products, rules, and documents were
invented for this demo and are not derived from any production system.

## Quickstart

Requires Docker and Node 20+.

```bash
npm install
npm run setup     # starts Postgres+pgvector, seeds the corpus, runs the smoke test
```

`npm run setup` is the whole demo: it stands up the database, embeds and inserts 12 documents, then
connects to the MCP server as a real MCP client and exercises every tool. Expected tail:

```
Connected. Server exposes 3 tools:
  - search_policy_documents: Search policy documents
  - get_application_status: Get application status
  - lookup_product_rules: Look up product rules
...
All tool calls completed.
```

Then `npm run demo` walks the chained flow an agent actually performs — see below. Tear down
with `npm run db:down`.

## The tools

| Tool | What it does |
| --- | --- |
| `search_policy_documents` | Vector search over contracts, riders, underwriting guidelines, and procedures. Optional `product_code` filter. Returns ranked excerpts with `doc_id` so answers can cite a source. |
| `get_application_status` | Looks up an application by number; returns status, the step it is blocked on, assigned underwriter, and the full event timeline. |
| `lookup_product_rules` | Returns issue limits and underwriting rules for a product. Given `applicant_age` / `face_amount` / `state`, also evaluates hard eligibility and reports which dimensions failed. |

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

Layout: `src/index.js` (server and tools) · `src/embed.js` (embedding) · `src/db.js` (pool) ·
`db/init.sql` (schema + seed) · `scripts/seed.mjs` (documents + embeddings) ·
`scripts/smoke.mjs` (MCP client test).

## Swapping in a real embedding model

`src/embed.js` ships a deterministic hashed bag-of-words projection so the repo runs offline with no
API key. It matches on vocabulary overlap, not meaning — good enough to demonstrate the retrieval
path, not good enough for production.

Replacing it is a one-function change. Keep `EMBEDDING_DIM` in sync with the `vector(n)` column in
`db/init.sql`, then re-run `npm run seed`:

```js
export async function embed(text) {
  const response = await fetch(`${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.EMBEDDING_DEPLOYMENT}/embeddings?api-version=2024-02-01`, {
    method: 'POST',
    headers: { 'api-key': process.env.AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text }),
  });
  const { data } = await response.json();
  return data[0].embedding;
}
```

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
- **The embedding is lexical, and hybrid search is a mitigation, not a cure.** Fusing full-text
  ranking with the vector side fixed most of the misranking, but neither half understands meaning:
  a query that shares no vocabulary with the target document will still miss it. A real embedding
  model is the actual fix; the fusion then makes it better still.

## License

MIT
