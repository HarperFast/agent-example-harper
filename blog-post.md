---
title: Build and Deploy a Conversational AI Agent on Harper
published: false
description: Build a chat agent with persistent semantic memory, a semantic cache, and web search using Harper, Claude, and about 200 lines of JavaScript. No glue code required.
tags: ai, agents, harperdb, javascript
---

If you've built an AI agent before, you know the drill: spin up a database for conversation history, bolt on a vector store for semantic search, wire up an API server, add a caching layer so it doesn't crawl, and then figure out how to deploy the whole thing. Five services, five sets of credentials, and a weekend gone.

What if your entire agent backend — database, vector search, caching, API, and deployment — was one thing?

That's [Harper](https://harper.fast). In this tutorial, we'll build a full-featured conversational AI agent with persistent semantic memory, a two-layer semantic cache, web search, cost tracking, and a chat UI, then deploy it globally with a single command.

## What We're Building

A conversational assistant powered by Claude that:

- **Persists every conversation** in Harper's database
- **Embeds every message** locally with no API cost, using `bge-small-en-v1.5` via llama.cpp
- **Searches past conversations** automatically to give Claude relevant context
- **Caches semantically similar questions** so repeated questions are answered for free
- **Searches the web** via Anthropic's built-in server-side web search tool — no external API key
- **Tracks cost and savings** on every response, accumulating global stats in Harper
- **Serves a chat UI** directly from a Harper Resource — no separate frontend server
- **Exposes a single REST endpoint** — `POST /Agent` — that handles the entire agent loop

When you ask it a question it discussed three conversations ago, it remembers. When you ask the same question again (or a semantically equivalent one), it answers instantly from cache at zero cost. All backed by Harper's built-in HNSW vector index — no Pinecone, no Weaviate, no Redis, no extra service.

Live demo: [agent-example.stephen-demo-org.harperfabric.com/Chat](https://agent-example.stephen-demo-org.harperfabric.com/Chat)

## Prerequisites

- Node.js 22+
- An [Anthropic API key](https://console.anthropic.com/) (for Claude)

That's it. Embeddings run locally — no second API key required.

Install the Harper CLI:

```bash
npm install -g harperdb
```

## Step 1: Scaffold the Project

```bash
mkdir agent-example-harper && cd agent-example-harper
npm init -y
npm install @anthropic-ai/sdk harper-fabric-embeddings graphql
```

Set `"type": "module"` in your `package.json` and add these scripts:

```json
{
  "type": "module",
  "engines": { "harperdb": "^4.4" },
  "scripts": {
    "dev": "harperdb dev .",
    "start": "harperdb run .",
    "deploy": "npx -y dotenv-cli -- harperdb deploy . restart=rolling replicated=true"
  }
}
```

Create a `config.yaml` — this is how Harper knows what your app does:

```yaml
loadEnv:
  files:
    - '.env'

rest: true

graphqlSchema:
  files: 'schemas/*.graphql'

jsResource:
  files: 'resources/*.js'
```

Four lines of config. `rest: true` turns on the auto-generated REST API. `graphqlSchema` points to your schema. `jsResource` points to your custom endpoints. That's the entire backend configuration.

Create a `.env` file with your Anthropic key:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## Step 2: Define the Schema

This is where Harper shines. Create `schemas/schema.graphql`:

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

That's it. Those 24 lines give you:

- **Three database tables** (`Conversation`, `Message`, `Stats`) with automatic persistence
- **Full REST CRUD APIs** for all three tables (thanks to `@export`) — no controllers, no routes, no ORM
- **A vector index** on `Message.embedding` using HNSW with cosine similarity — no separate vector database
- **A secondary index** on `conversationId` for fast lookups
- **A `cost` field** on every message for tracking per-response spend
- **A `Stats` table** for accumulating global cache savings and hit counts

You can immediately `GET /Conversation`, `PUT /Message/:id`, `DELETE /Conversation/:id` — all auto-generated from the schema.

## Step 3: Write the Helper Modules

Two small files in `lib/`. First, environment config (`lib/config.js`):

```javascript
const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const optional = (name, fallback) => process.env[name] ?? fallback

export const config = {
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    model: () => optional('CLAUDE_MODEL', 'claude-sonnet-4-5-20250514'),
  },
}
```

Then the embedding helper (`lib/embeddings.js`):

```javascript
import { init, embed as llamaEmbed } from 'harper-fabric-embeddings'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const modelsDir = resolve(__dirname, '../models')
const modelPath = resolve(modelsDir, 'bge-small-en-v1.5-q4_k_m.gguf')
const MODEL_URL =
  'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf'

async function ensureModel() {
  if (existsSync(modelPath)) return
  mkdirSync(modelsDir, { recursive: true })
  console.log('Downloading bge-small-en-v1.5 (~24 MB)...')
  const response = await fetch(MODEL_URL)
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`)
  await pipeline(response.body, createWriteStream(modelPath))
  console.log('Model ready.')
}

const initPromise = ensureModel().then(() => init({ modelPath }))

export async function embed(text) {
  await initPromise
  return llamaEmbed(text)
}
```

We're using [`harper-fabric-embeddings`](https://github.com/heskew/harper-fabric-embeddings) — a lightweight llama.cpp wrapper built specifically for Harper Fabric. It runs `bge-small-en-v1.5` locally via the native `@node-llama-cpp` addon. **No API key. No external service.** On first run it downloads the model (~24 MB) into `./models/` and caches it there forever after.

## Step 4: Build the Agent

This is the heart of the application. Create `resources/Agent.js`. Let's walk through it section by section.

### Public Access and Cost Constants

```javascript
import { Resource, tables } from 'harperdb'
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../lib/config.js'
import { embed } from '../lib/embeddings.js'

// Approximate pricing for Claude Sonnet (per token)
const COST_INPUT_PER_TOKEN  = 3  / 1_000_000   // $3  / 1M input tokens
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000   // $15 / 1M output tokens
const COST_PER_WEB_SEARCH   = 10 / 1_000       // $10 / 1K searches

// Anthropic web search tool — executed server-side, no external API key needed
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

// Normalize text for exact cache comparison
const normalize = (s) =>
  s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

// Cosine distance threshold for Harper's native HNSW vector search.
// Harper uses cosine *distance* (0 = identical, 2 = opposite), so this is
// equivalent to cosine similarity >= 0.88 (distance = 1 - similarity = 0.12).
const CACHE_DISTANCE_THRESHOLD = 0.12

export class Agent extends Resource {
  static loadAsInstance = false

  async post(target, data) {
    target.checkPermission = false  // Public access — V2 Resource API pattern
    // ...
  }
}
```

Two things worth noting here. First, `static loadAsInstance = false` is the V2 Resource API pattern in Harper — it means Harper calls `post()` as a static method rather than constructing an instance per request. Second, `target.checkPermission = false` grants public access. This is the V2 pattern; the V1 method (`allowRead()`) is ignored when `loadAsInstance = false`.

**Gotcha:** Don't name your Resource class the same as a `@table` in your schema. If you name the class `Message`, Harper shadows `tables.Message` and you lose access to the table. Rename the class (e.g., `Agent`) to avoid this.

### Embedding First

```javascript
// 1. Embed first — before any DB writes to avoid holding transactions open
const userEmbedding = await embed(message)
```

Embed the user's message before opening any database transactions. The embedding call runs llama.cpp locally and takes a few hundred milliseconds — you don't want that happening inside a write transaction.

### Two-Layer Semantic Cache

This is the most interesting part of the agent. Before calling Claude at all, we check two caches:

```javascript
// Layer 1: Exact text match within this conversation
const prevSame = recent.find(
  (m) => m.id !== userMsgId &&
         m.role === 'user' &&
         m.content &&
         normalize(m.content) === normalize(message)
)
if (prevSame) {
  const pIdx = recent.indexOf(prevSame)
  cachedReply = recent.slice(pIdx + 1).find((m) => m.role === 'assistant') ?? null
}
```

Layer 1 is simple: normalize both strings (lowercase, strip punctuation, collapse whitespace) and check for an exact match in the current conversation's history. No extra DB query — we already loaded history.

```javascript
// Layer 2: Harper-native HNSW vector search with distance threshold
if (!cachedReply) {
  const nearbyMsgs = tables.Message.search({
    conditions: {
      attribute: 'embedding',
      comparator: 'lt',
      value: CACHE_DISTANCE_THRESHOLD,
      target: userEmbedding,
    },
    limit: 10,
  })

  for await (const match of nearbyMsgs) {
    if (match.id === userMsgId || match.role !== 'user') continue
    // Find the assistant reply that followed this question
    const matchConvMsgs = []
    const matchHistory = tables.Message.search({
      conditions: [{ attribute: 'conversationId', value: match.conversationId }],
      limit: 100,
    })
    for await (const m of matchHistory) matchConvMsgs.push(m)
    matchConvMsgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const midx = matchConvMsgs.findIndex((m) => m.id === match.id)
    const reply = matchConvMsgs.slice(midx + 1).find((m) => m.role === 'assistant')
    if (reply) { cachedReply = reply; break }
  }
}
```

Layer 2 uses Harper's native HNSW vector index for semantic similarity. The key is the `conditions` form with `comparator: 'lt'` — this tells Harper's index to return only messages whose cosine distance from `userEmbedding` is less than 0.12 (equivalent to cosine similarity ≥ 0.88). Harper executes this entirely inside the index — no full table scan, no in-memory math.

**Wrong approach (don't do this):**
```javascript
// Bad: fetches ALL messages, does cosine math in JS
const all = tables.Message.search({ sort: { attribute: 'embedding', target: userEmbedding } })
for await (const m of all) {
  const sim = cosineSimilarity(userEmbedding, m.embedding) // manual, slow
  if (sim > 0.88) { ... }
}
```

**Right approach:** pass the threshold to Harper and let the index do the filtering server-side. One round-trip, no JS math, scales to millions of records.

### Returning a Cache Hit

```javascript
if (cachedReply) {
  const origMsg = await tables.Message.get(cachedReply.id)
  const savedCost = origMsg?.cost ?? 0
  const stats = await tables.Stats.get('global')
  await tables.Stats.put({
    id: 'global',
    totalSaved: ((stats?.totalSaved) ?? 0) + savedCost,
    cacheHits:  ((stats?.cacheHits)  ?? 0) + 1,
    updatedAt:  new Date().toISOString(),
  })
  return {
    conversationId,
    message: { role: 'assistant', content: cachedReply.content },
    meta: {
      latencyMs: Date.now() - startTime,
      tokens: { input: 0, output: 0, total: 0 },
      cost:   { input: 0, output: 0, total: 0, saved: savedCost },
      vectorContext: { hit: true, count: 1, cached: true },
    },
  }
}
```

On a cache hit, we look up the original response's stored cost and add it to the global `Stats` record. One thing to watch: `tables.Stats.get('global')` returns `null` on an empty database (before any stats have been written). Always default with `?? 0`.

### Calling Claude with Web Search

```javascript
let apiResponse = await getClient().messages.create({
  model: config.anthropic.model(),
  max_tokens: 1024,
  tools: [WEB_SEARCH_TOOL],
  system: systemPrompt,
  messages,
})

// Handle pause_turn — server hit the max_uses limit mid-response; continue once
if (apiResponse.stop_reason === 'pause_turn') {
  apiResponse = await getClient().messages.create({
    model: config.anthropic.model(),
    max_tokens: 1024,
    tools: [WEB_SEARCH_TOOL],
    system: systemPrompt,
    messages: [...messages, { role: 'assistant', content: apiResponse.content }],
  })
}
```

`web_search_20250305` is Anthropic's built-in server-side search tool — you pass it in the `tools` array and Anthropic executes the searches on their infrastructure. No Google API key, no SerpAPI, no external service. When the model hits the `max_uses` limit mid-answer, it stops with `stop_reason: 'pause_turn'`. You continue by passing the partial response back as an assistant turn.

### Joining Web Search Response Blocks

```javascript
// The API splits the answer across multiple text blocks and may emit a text block
// BEFORE the web search tool call (e.g., "Let me look that up...").
// Strategy: take only text blocks that appear AFTER the last non-text block.
const lastToolIdx = apiResponse.content.reduce(
  (acc, b, i) => b.type !== 'text' ? i : acc, -1
)
const assistantContent = apiResponse.content
  .slice(lastToolIdx + 1)
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('')
  .trim()
```

This is a subtle gotcha. When web search is used, the response `content` array contains a mix of `text` blocks (sentence fragments), `tool_use` blocks (search requests), and `tool_result` blocks (search results). Two problems:

1. The model often emits a text block *before* the first search ("Let me look that up...") — that's not the answer, it's narration.
2. The actual answer may be split across multiple text blocks with no separator between them.

The fix: find the index of the last non-text block (the last search result), then join all text blocks that come after it. Those are the real answer fragments. Join with `''` — they're already continuous prose.

**JS template literal gotcha:** If you're embedding regex or escape sequences inside a JS template literal (for example, to generate a script tag in HTML), remember that backslashes are consumed by the template literal parser. `\n` becomes a newline, `\*` becomes `*`, `\d` becomes `d`. Use `\\n`, `\\*`, `\\d` in template literals that are meant to produce source code strings.

### Per-Response Metadata

Every response includes a `meta` object:

```javascript
return {
  conversationId,
  message: { role: 'assistant', content: assistantContent },
  meta: {
    latencyMs,
    tokens: { input: input_tokens, output: output_tokens, total: input_tokens + output_tokens },
    cost: {
      input:  +(input_tokens  * COST_INPUT_PER_TOKEN).toFixed(6),
      output: +(output_tokens * COST_OUTPUT_PER_TOKEN).toFixed(6),
      search: +searchCost.toFixed(6),
      total:  +totalCost.toFixed(6),
    },
    webSearches,
    vectorContext: { hit: context.length > 0, count: context.length, cached: false },
  },
}
```

Cache hits show `tokens: 0`, `cost.total: 0`, and `cost.saved: X` — the cost that would have been charged without the cache.

### The PublicStats Resource

```javascript
export class PublicStats extends Resource {
  static loadAsInstance = false

  async get(target) {
    target.checkPermission = false
    return await tables.Stats.get('global') ?? { id: 'global', totalSaved: 0, cacheHits: 0 }
  }
}
```

`GET /PublicStats/global` returns the global savings stats without requiring authentication. Note: we export `PublicStats` from `Agent.js` — Harper picks up all exported `Resource` subclasses from a file. Also note the class is named `PublicStats`, not `Stats` — if you named it `Stats`, it would shadow `tables.Stats` and break every DB access.

## Step 5: Build the Chat UI

One of the elegant things about Harper is that a `Resource` can serve HTML — you don't need a separate frontend server. Create `resources/Chat.js`:

```javascript
import { Resource } from 'harperdb'

export class Chat extends Resource {
  static loadAsInstance = false

  async get(target) {
    target.checkPermission = false
    const html = `<!DOCTYPE html>
<html>
<!-- full chat UI HTML here -->
</html>`
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}
```

`GET /Chat` returns the full chat interface. The UI is a two-column layout:

- **Left sidebar**: Harper architecture SVG diagram showing the data flow (User Query → Harper Agent → Vector Store → Semantic Cache → Local SLM → cache hit free or cache miss → Claude Sonnet → embed & store back), plus a live savings panel showing total USD saved and cache hit count fetched from `GET /PublicStats/global`.
- **Right panel**: Chat interface with message history, a text input, and per-message metadata badges showing latency, token count, cost, web search count, and whether the response was a cache hit.

The UI uses Harper's brand colors (B-Tree Green `#66ffcc`, Quantum Purple `#312556`) and Ubuntu font from Google Fonts. Metadata on each message looks like:

```
342ms · 847 tokens · $0.0142 · 2 searches · 3 memories
```

Or for a cache hit:

```
12ms · 0 tokens · $0.00 · saved $0.0142
```

The savings panel polls `GET /PublicStats/global` on load and after each message, so the displayed total updates live as you chat.

## Step 6: Run It

```bash
npm run dev
```

Harper starts at `http://localhost:9926`. Open `http://localhost:9926/Chat` for the browser UI, or use the API directly:

```bash
# Start a conversation
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "My favorite programming language is Rust"}'

# Returns:
# {
#   "conversationId": "abc-123",
#   "message": { "role": "assistant", "content": "..." },
#   "meta": { "latencyMs": 1842, "tokens": { "total": 312 }, "cost": { "total": 0.000987 }, ... }
# }

# Ask again — cache hit, instant and free
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is my favourite programming language?"}'

# Returns with meta.cost.total = 0, meta.cost.saved = 0.000987

# Check global savings
curl http://localhost:9926/PublicStats/global
# { "totalSaved": 0.000987, "cacheHits": 1, ... }
```

The auto-generated REST APIs work too:

```bash
# List all conversations
curl http://localhost:9926/Conversation

# Get all messages for a conversation
curl "http://localhost:9926/Message?conversationId=abc-123"
```

## Step 7: Deploy

Create a cluster on [Harper Fabric](https://fabric.harper.fast/), add the credentials to your `.env`:

```
CLI_TARGET=https://your-instance.your-org.harperfabric.com:9925/
CLI_TARGET_USERNAME=your-username
CLI_TARGET_PASSWORD=your-password
```

Then deploy:

```bash
npm run deploy
```

Your agent is now running globally on Harper Fabric. No Docker, no Kubernetes, no cloud console, no CI/CD pipeline.

## Why Harper for Agents?

After building this, here's what stands out:

**Zero glue code.** In a traditional stack, you'd need a database driver, an ORM, a vector database client, an API framework, route definitions, a caching layer, and deployment configuration. With Harper, the schema *is* the database, the API, and the vector store. The config file is 6 lines.

**Semantic caching eliminates LLM costs at scale.** Questions answered by the cache cost exactly $0.00. The two-layer approach — exact match first, then HNSW similarity search with a 0.88 cosine similarity threshold — catches both repeated questions and rephrased variants. Over time, a popular agent builds up a dense cache that handles most queries for free.

**Vector search is a schema directive, not a service.** Adding semantic memory to an agent is usually a project in itself — pick a vector database, manage embeddings, handle the query pipeline. Here it's one line in the schema: `@indexed(type: "HNSW", distance: "cosine")`. And the native `conditions` API with `comparator: 'lt'` lets you do threshold-filtered vector search entirely inside the index — no full scans, no JS cosine math.

**Local embeddings, no API key.** `harper-fabric-embeddings` runs `bge-small-en-v1.5` via llama.cpp, right in the same Node.js process. No Voyage AI account. No OpenAI billing. No embedding service to manage. One dependency, zero extra credentials.

**Everything runs in one process.** The database, vector index, semantic cache, API server, chat UI, and your agent code all share the same runtime. No network hops between services. No cold starts. Sub-millisecond access to stored data.

**A Resource can serve anything.** A `Resource` subclass isn't limited to JSON APIs — `Chat.js` serves a full HTML+CSS+JS chat interface from `GET /Chat`. No Express, no Vite, no separate frontend server. One project, one deploy, one runtime.

**Deploy is one command.** `harperdb deploy .` pushes your code and data schema to Harper Fabric. Rolling restarts, replication, and global distribution are handled for you.

**TypeScript works without a build step.** Harper strips types natively via Node.js. No tsc, no webpack, no build pipeline.

## What's Next

This is a starting point. Here's where you could take it:

- **Add tool use** — give Claude tools that read and write to Harper tables, turning it into a task-execution agent
- **Real-time streaming** — use Harper's built-in pub/sub (SSE, WebSocket, MQTT) to stream responses as they arrive
- **Multi-agent coordination** — multiple agents communicating through Harper's pub/sub system
- **MCP integration** — expose your Harper data to other AI tools via the [Harper MCP server](https://github.com/HarperFast/harperdb-mcp-server)
- **Tune the cache threshold** — 0.12 cosine distance is a good default; lower it for stricter matching, raise it for more aggressive caching

The [full source code](https://github.com/stephengoldberg/agent-example-harper) is on GitHub. Clone it, add your Anthropic key, and start building.
