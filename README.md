# Harper Demo Agent

A conversational AI agent with persistent semantic memory, a two-layer semantic cache, cost tracking, and a browser chat UI — all running on [Harper](https://harper.fast). Generation and embedding go through Harper's `models` API, so the app ships no LLM SDK and holds no provider credentials.

Live demo: **[agent-example.stephen-demo-org.harperfabric.com/Chat](https://agent-example.stephen-demo-org.harperfabric.com/Chat)**

## What It Does

- **Chat** via a REST endpoint (`POST /Agent`) or the built-in browser chat UI (`GET /Chat`)
- **Semantic cache** — two-layer cache catches repeated and rephrased questions before they reach the model, returning answers instantly at zero LLM cost
- **Persistent memory** — every message is embedded and stored in Harper; semantic recall surfaces relevant context from past conversations automatically
- **Host-provided models** — `models.generate()` and `models.embed()` resolve to whatever backend the Harper host has configured (the shared inference process on Fabric GPU hosts; Ollama / OpenAI / Anthropic / Bedrock elsewhere). No SDK dependency, no API key in the app
- **Per-response metadata** — every API response includes latency, token estimates, cost breakdown, and vector context stats
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
│  1. Embed user message                                   │
│     ┌─────────────────────┐                              │
│     │   EmbeddingCache    │ ← normalized text → vector   │
│     │   hit: ~1ms lookup  │   miss: models.embed(),      │
│     │   (skip the model)  │   then stores for next time  │
│     └─────────────────────┘                              │
│                                                          │
│  2. Store user message + embedding                       │
│  3. HNSW semantic cache check (cosine distance < 0.15)   │
│       │                          │                       │
│   Cache HIT                  Cache MISS                  │
│       │                          │                       │
│  Return $0.00        models.generate() ───────────────────┼──► host-configured
│  + saved $X                      │                       │    model backend
│                          Embed response (cache/embed)    │◄──────────┘
│                          Store in Harper                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Every request is standalone. Ask once, pay for the generation. Ask again — or rephrase the same question — and Harper serves the cached answer instantly at $0. The embedding cache eliminates the embedding round-trip on repeated text.

## How the Semantic Cache Works

Before calling the model, the agent searches Harper's HNSW vector index for semantically similar past questions:

```javascript
tables.Message.search({
  conditions: {
    attribute: 'embedding',
    comparator: 'lt',
    value: 0.15,           // cosine distance < 0.15 ≡ cosine similarity ≥ 0.85
    target: userEmbedding,
  },
  limit: 20,
})
```

Harper's HNSW index evaluates the distance threshold internally — no full table scan, no vector DB round-trip. The agent then ranks the returned candidates by cosine distance and takes the closest whose *immediately* following message is an assistant reply, and returns that directly. No generation call, no tokens, no cost.

Cache hits return `cost.total: 0` and include a `cost.saved` field showing what the call would have cost. The saved amount is added to the global `Stats` record (`totalSaved`, `cacheHits`).

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Harper](https://www.npmjs.com/package/harper) 5.2+: `npm install -g harper`
- A Harper host with an embedding backend and a generative backend configured (see [Model Configuration](#model-configuration))

No API key lives in this app — credentials, if the chosen backend needs any, belong to the host's model configuration.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/stephengoldberg/agent-example-harper.git
cd agent-example-harper

# Install dependencies
npm install

# Configure environment (deploy credentials only)
cp dot-env.example .env

# Start the dev server
npm run dev
```

## Model Configuration

This app never names a model or holds a credential. `models.generate()` and `models.embed()`
resolve the logical names `models.generative.default` and `models.embedding.default` from the
**host's** configuration — the top-level `models:` block of `harperdb-config.yaml` at the
instance root. Change the backend there and the app is unchanged.

```yaml
models:
  embedding:
    default:
      backend: ollama
      host: http://localhost:11434
      model: nomic-embed-text
  generative:
    default:
      backend: anthropic
      model: claude-sonnet-4-5
      apiKey: ${ANTHROPIC_API_KEY}
```

Built-in backends: `ollama`, `openai`, `anthropic`, `bedrock`. Any other `backend` value is
resolved as a module specifier and imported, so a custom backend needs no core change.

Two things worth knowing:

- **Keep credentials out of the YAML.** String leaves are env-expanded before they reach the
  backend, so write `apiKey: ${ANTHROPIC_API_KEY}` rather than the literal key — Harper warns
  at boot when it sees a literal in a credential field.
- **A misconfigured entry is logged and skipped, not fatal.** Harper still boots; the failure
  surfaces on first use as `ModelBackendNotFoundError: No backend registered for
  'embedding.default'` from `POST /Agent`.

On Fabric GPU hosts the host-manager configures these entries for you against the shared
inference process, and no local setup is needed.

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

Response (`models.generate()` reports no token usage, so `tokens` and `cost` are length-based estimates of what the same call would have cost on Claude Sonnet — the comparator behind the savings tracker, not a bill):

```json
{
  "conversationId": "abc-123",
  "message": { "role": "assistant", "content": "Harper is..." },
  "meta": {
    "latencyMs": 1842,
    "tokens": { "input": 312, "output": 148, "total": 460 },
    "cost": { "input": 0.000936, "output": 0.00222, "total": 0.003156, "saved": 0 },
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
├── config.yaml              # Harper app configuration
├── schemas/
│   └── schema.graphql       # Database schema (Conversation, Message, Stats + HNSW index)
├── resources/
│   ├── Agent.js             # POST /Agent (agent loop + semantic cache)
│   │                        # GET  /PublicStats/:id (public stats endpoint)
│   └── Chat.js              # GET  /Chat (full browser chat UI served as HTML)
├── lib/
│   └── embeddings.js        # Thin wrapper over `models.embed()`
├── dot-env.example          # Environment template (deploy credentials)
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
  embedding: [Float] @indexed(type: "HNSW", distance: "cosine")
  createdAt: String
}

type Stats @table @export {
  id: ID @primaryKey
  totalSaved: Float
  cacheHits: Int
  updatedAt: String
}
```

`@table` creates the database table. `@export` generates the full REST CRUD API. `@indexed(type: "HNSW", distance: "cosine")` adds the HNSW vector index used for both semantic cache lookup and context retrieval.

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
| Model access | Per-provider SDK + key per app | `models.embed()` / `models.generate()`, backend configured on the host |
| Deployment | Docker + K8s + cloud | `harper deploy .` |

**Key insights from building this:**

- **Native HNSW conditions search scales.** Passing `comparator: 'lt'` to Harper's vector search evaluates the distance threshold inside the index. No JS cosine math, no full scans.
- **Everything in one process means no network hops.** Database, vector index, cache, API, and agent code share the same runtime. No Redis round-trip, no vector DB round-trip.
- **The schema is the only config you need.** One `@indexed(type: "HNSW", distance: "cosine")` directive creates the vector index. One `@export` generates the CRUD API. One `@indexed` on `conversationId` creates the secondary index.
- **Resources can return anything.** A `Resource` subclass can return a `Response` with any content type — JSON, HTML, plain text. The chat UI lives in the same project and deploy as the agent logic.
- **The model backend is host configuration, not app code.** `import { models } from 'harper'` gives a resource the process-wide models singleton — the same object as `scope.models`, so no `handleApplication(scope)` shim is needed. Swapping Ollama for Bedrock is a YAML edit on the host; this app does not change.

## License

Apache 2.0 — see [LICENSE](LICENSE)
