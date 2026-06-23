# Harper Demo Agent

A conversational AI agent with persistent semantic memory, a two-layer semantic cache, web search, cost tracking, and a browser chat UI — all running on [Harper](https://harper.fast) with Claude (via the Anthropic API or Google Cloud Vertex AI).

Live demo: **[agent-example.stephen-demo-org.harperfabric.com/Chat](https://agent-example.stephen-demo-org.harperfabric.com/Chat)**

## What It Does

- **Chat with Claude** via a REST endpoint (`POST /Agent`) or the built-in browser chat UI (`GET /Chat`)
- **Semantic cache** — two-layer cache catches repeated and rephrased questions before they reach Claude, returning answers instantly at zero LLM cost
- **Web search** — Anthropic's built-in server-side web search (`web_search_20250305`, up to 5 uses per turn); no external API key required
- **Persistent memory** — every message is embedded and stored in Harper; semantic recall surfaces relevant context from past conversations automatically
- **Schema-level embeddings** — the `@embed` directive embeds each message from its `content` at write time and auto-indexes it with HNSW; `bge-large` runs on a local Ollama server, so no cloud embedding API or billing
- **Per-response metadata** — every API response includes latency, token counts, cost breakdown, web searches used, and vector context stats
- **Global savings tracker** — cache hits accumulate a running total of USD saved and hit count in a `Stats` table, displayed live in the chat sidebar
- **Auto-generated REST APIs** — full CRUD on `Conversation`, `Message`, and `Stats` tables, generated from the GraphQL schema with zero route code

## Architecture

```
User Query
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│                         Harper                           │
│                                                          │
│  1. Embed the query (models.embed "text-embed")          │
│     → local Ollama: bge-large                            │
│                                                          │
│  2. Store user message — @embed auto-embeds `content`    │
│     and updates the HNSW index at write time             │
│  3. HNSW semantic cache check (cosine distance < 0.12)   │
│       │                          │                       │
│   Cache HIT                  Cache MISS                  │
│       │                          │                       │
│  Return $0.00           Call Claude ──────────────────────┼──► Anthropic API
│  + saved $X                      │                       │    + Web Search
│                          Store response — @embed          │◄──────────┘
│                          auto-embeds it too               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Every request is standalone. Ask once, pay for Claude. Ask again — or rephrase the same question — and Harper serves the cached answer instantly at $0. Message embeddings are produced by the `@embed` directive at write time; the query side computes one embedding per request via `models.embed`.

## How the Semantic Cache Works

Before calling Claude, the agent searches Harper's HNSW vector index for semantically similar past questions:

```javascript
tables.Message.search({
  conditions: {
    attribute: 'embedding',
    comparator: 'lt',
    value: 0.12,           // cosine distance < 0.12 ≡ cosine similarity ≥ 0.88
    target: userEmbedding,
  },
  limit: 10,
})
```

Harper's HNSW index evaluates the distance threshold internally — no full table scan, no in-memory cosine math. When a match is found, the agent looks up the assistant reply that followed it and returns that directly. No Claude call, no tokens, no cost.

Cache hits return `cost.total: 0` and include a `cost.saved` field showing what the call would have cost. The saved amount is added to the global `Stats` record (`totalSaved`, `cacheHits`).

## Prerequisites

- [Node.js](https://nodejs.org/) `^22.18.0 || >=24.0.0` (required by Harper 5.1's rocksdb storage engine)
- [Harper CLI](https://www.npmjs.com/package/harper) **5.1+**: `npm install -g harper`
- [Ollama](https://ollama.com/) running locally with the embedding model pulled: `ollama pull bge-large`
- **One of:**
  - [Anthropic API key](https://console.anthropic.com/) (direct API — default)
  - [Google Cloud project](https://console.cloud.google.com/) with Vertex AI enabled (GCP Vertex AI)

No cloud embedding API key needed — embeddings run on your local Ollama server.

### Embedding model

Harper reads the `models:` block **only from the instance (root) config** (`<rootPath>/harper-config.yaml` locally; the instance config on Fabric), not from the app's `config.yaml`. Add:

```yaml
models:
  embedding:
    text-embed:
      backend: ollama
      host: localhost:11434
      model: bge-large
```

The logical name `text-embed` is what `@embed(model: "text-embed")` and `models.embed("text-embed", ...)` resolve against. Harper 5.1 ships `ollama`, `openai`, `anthropic`, and `bedrock` backends — pick another by changing `backend` (and `model`).

## Quick Start

```bash
# Clone the repo
git clone https://github.com/stephengoldberg/agent-example-harper.git
cd agent-example-harper

# Install dependencies
npm install

# Configure environment
cp dot-env.example .env
# Edit .env — see "LLM Provider Setup" below

# Start the dev server
npm run dev
```

## LLM Provider Setup

This agent supports two LLM backends — the direct Anthropic API and Google Cloud Vertex AI. Set `LLM_PROVIDER` in your `.env` to choose which one to use.

### Option A: Anthropic API (default)

The simplest path. You just need an API key from [console.anthropic.com](https://console.anthropic.com/).

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Web search is included automatically via Anthropic's server-side `web_search_20250305` tool — no additional API keys required.

### Option B: Google Cloud Vertex AI

Run Claude through your own GCP project. Useful for enterprise environments, org-level billing, data residency, and keeping everything inside Google Cloud.

**1. Enable the Vertex AI API** in your GCP project:

```
https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=YOUR_PROJECT_ID
```

**2. Enable a Claude model** in the [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden) — search for "Claude" and enable the model you want.

**3. Request quota** — new projects start with 0 tokens/min. Go to [IAM & Admin → Quotas](https://console.cloud.google.com/iam-admin/quotas), filter for your Claude model, and request an increase.

**4. Create a service account** with the **Vertex AI User** role, download the JSON key, and place it in the project root.

**5. Configure `.env`:**

```env
LLM_PROVIDER=vertex
VERTEX_PROJECT_ID=my-gcp-project
VERTEX_REGION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=./your-service-account-key.json
```

> **Note:** Web search is not available on Vertex AI by default (requires an org policy change). The agent automatically disables it when running on Vertex.

### Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROVIDER` | No | `anthropic` | `anthropic` or `vertex` |
| `ANTHROPIC_API_KEY` | When `anthropic` | — | Anthropic API key |
| `VERTEX_PROJECT_ID` | When `vertex` | — | GCP project ID |
| `VERTEX_REGION` | No | `global` | Vertex AI region (e.g. `us-east5`, `global`) |
| `VERTEX_MODEL` | No | `claude-sonnet-4-6` | Vertex model ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | When `vertex` | — | Path to GCP service account JSON key |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-5-20250929` | Anthropic direct API model ID |

> **Before first run:** make sure Ollama is running and the model is pulled (`ollama pull bge-large`), and that the `models.embedding.text-embed` block is in your Harper instance config (see "Embedding model" above). Without it, `/Agent` fails with `No backend registered for 'embedding.text-embed'` or a connection error to `:11434`.

The server starts at `http://localhost:9926`. Open `http://localhost:9926/Chat` in your browser.

## Usage

**Open the chat UI:**

```
http://localhost:9926/Chat
```

**Send a message via API:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Harper?"}'
```

Response:

```json
{
  "conversationId": "abc-123",
  "message": { "role": "assistant", "content": "Harper is..." },
  "meta": {
    "latencyMs": 1842,
    "tokens": { "input": 312, "output": 148, "total": 460 },
    "cost": { "input": 0.000936, "output": 0.00222, "search": 0, "total": 0.003156 },
    "webSearches": 0,
    "vectorContext": { "hit": false, "count": 0, "cached": false }
  }
}
```

**Continue a conversation:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "abc-123",
    "message": "Tell me more about its vector search"
  }'
```

**Ask the same question again (cache hit — free and instant):**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Harper?"}'

# meta.cost.total = 0, meta.cost.saved = 0.003156
```

**Check global savings:**

```bash
curl http://localhost:9926/PublicStats/global
# { "id": "global", "totalSaved": 0.003156, "cacheHits": 1, "updatedAt": "..." }
```

**Auto-generated CRUD** (from schema, no route code written):

```bash
# List all conversations
curl http://localhost:9926/Conversation

# Get messages for a conversation
curl "http://localhost:9926/Message?conversationId=abc-123"
```

## Project Structure

```
├── config.yaml              # Harper app configuration (models: lives in the instance config, not here)
├── schemas/
│   └── schema.graphql       # Database schema (Conversation, Message, Stats + @embed/HNSW index)
├── resources/
│   ├── Agent.js             # POST /Agent (agent loop + semantic cache + web search)
│   │                        # GET  /PublicStats/:id (public stats endpoint)
│   └── Chat.js              # GET  /Chat (full browser chat UI served as HTML)
├── lib/
│   └── config.js            # Environment variable helpers
├── .env.example             # Environment template
└── package.json
```

## Schema

```graphql
type Conversation @table @export {
  id: ID @primaryKey
  title: String
  createdAt: String
  updatedAt: String
}

type Message @table @export {
  id: ID @primaryKey
  conversationId: String @indexed
  role: String
  content: String
  cost: Float
  embedding: [Float] @embed(source: "content", model: "text-embed") @indexed(type: "HNSW", distance: "cosine")
  createdAt: String
}

type Stats @table @export {
  id: ID @primaryKey
  totalSaved: Float
  cacheHits: Int
  updatedAt: String
}
```

`@table` creates the database table. `@export` generates the full REST CRUD API. `@embed(source: "content", model: "text-embed")` tells Harper to compute the embedding from the `content` field at write time (resolving the model from the instance `models:` config), and `@indexed(type: "HNSW", distance: "cosine")` builds the HNSW vector index used for both semantic cache lookup and context retrieval. Because `@embed` populates the field, application code never sets `embedding` on writes — it only computes a query vector via `models.embed` for lookups.

## Deploying to Harper Fabric

```bash
# 1. Create a cluster at https://fabric.harper.fast/
# 2. Add credentials to .env
CLI_TARGET=https://your-instance.your-org.harperfabric.com:9925/
CLI_TARGET_USERNAME=your-username
CLI_TARGET_PASSWORD=your-password

# 3. Deploy
npm run deploy
```

Rolling restarts and replication are handled automatically.

**Public access note:** To make endpoints accessible without authentication, set `target.checkPermission = false` inside the handler method. This is the V2 Resource API pattern (`loadAsInstance = false`). The V1 method `allowRead()` is ignored in V2 Resources and has no effect.

## Why Harper for AI Agents

| Concern | Traditional Stack | Harper |
|---|---|---|
| Database | Postgres / MongoDB | Built in |
| Vector search | Pinecone / Weaviate | Built in (HNSW — one schema directive) |
| Semantic cache | Redis + custom logic | Built in (native HNSW threshold filter) |
| API server | Express / Fastify | Auto-generated from schema |
| Chat UI server | Vite / Next.js | Resource returning `Response(html)` |
| Embeddings | Voyage / OpenAI API + glue code | Schema-level `@embed` directive → local Ollama (`bge-large`) |
| Deployment | Docker + K8s + cloud | `harper deploy .` |

**Key insights from building this:**

- **Native HNSW conditions search scales.** Passing `comparator: 'lt'` to Harper's vector search evaluates the distance threshold inside the index. No JS cosine math, no full scans.
- **Everything in one process means no network hops.** Database, vector index, cache, API, and agent code share the same runtime. No Redis round-trip, no vector DB round-trip.
- **The schema is the only config you need.** One `@embed(source: "content", model: "text-embed") @indexed(type: "HNSW", distance: "cosine")` directive embeds and indexes every message at write time. One `@export` generates the CRUD API. One `@indexed` on `conversationId` creates the secondary index.
- **Resources can return anything.** A `Resource` subclass can return a `Response` with any content type — JSON, HTML, plain text. The chat UI lives in the same project and deploy as the agent logic.
- **`@embed` collapses the RAG write pipeline.** No separate embed call, vector-persist step, or sync drift — Harper embeds from the source field and updates the HNSW index inside the same write. Point it at a local Ollama model (`bge-large`) and there's no per-embedding billing or embedding-service SLA.

## License

Apache 2.0 — see [LICENSE](LICENSE)
