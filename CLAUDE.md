# CLAUDE.md

## Harper Skills

This project uses Harper. Before making changes, install and read the Harper agent skills for best practices on schema design, resources, vector indexing, caching, and deployment:

```bash
npx skills add harperfast/skills
```

These skills provide LLM-consumable guidelines at https://github.com/HarperFast/skills — covering schema relationships, REST/WebSocket APIs, custom resources, vector indexing (HNSW), and caching patterns.

## Project Overview

Harper Demo Agent — a conversational AI agent running entirely on Harper. Harper provides the database, vector index, semantic cache, API server, model gateway, and deployment runtime in a single process; generation and embedding both go through Harper's `models` API, so the app carries no LLM SDK and no API key.

Live demo: https://agent-example.stephen-demo-org.harperfabric.com/Chat

## Tech Stack

- **Runtime:** Harper (harperdb) — unified DB/cache/vector/API
- **LLM:** `models.generate()` — routes to the host's configured `models.generative.default` backend (the shared inference process on Fabric GPU hosts; Ollama / OpenAI / Anthropic / Bedrock elsewhere)
- **Embeddings:** `models.embed()` — routes to the host's configured `models.embedding.default` backend
- **Language:** JavaScript (ES modules, `"type": "module"`)
- **License:** Apache 2.0

## Project Structure

```
config.yaml                  # Harper app config (rest, schema, resources)
schemas/schema.graphql       # Database schema — 3 tables, HNSW vector index, TTL
resources/Agent.js           # Agent endpoint (POST /Agent) + PublicStats (GET /PublicStats/global)
resources/Chat.js            # Chat UI (GET /Chat) — full HTML/CSS/JS served from a Resource
lib/embeddings.js            # Thin wrapper over `models.embed()`
.env                         # Deploy credentials only (not committed)
```

## Key Architecture Decisions

### Harper Resource API (V2)
- All resources use `static loadAsInstance = false` (V2 pattern)
- Public access: `target.checkPermission = false` inside each handler method
- **Do NOT use** `allowRead()` / `allowCreate()` — those are V1 methods, silently ignored in V2
- **Do NOT name** a Resource class the same as a `@table` — it shadows `tables.X` and breaks DB access (e.g. we use `PublicStats`, not `Stats`)

### Schema (schemas/schema.graphql)
- `@table(expiration: 3600)` — 1-hour TTL on Message and Conversation tables
- `@export` — auto-generates REST CRUD endpoints
- `@indexed(type: "HNSW", distance: "cosine")` — vector index on `embedding` field
- `@indexed` on `conversationId` — secondary index for conversation lookups
- `Stats` table has no TTL (cumulative savings persist indefinitely)

### Semantic Cache
1. **Embedding cache (`EmbeddingCache`):** keyed by a SHA-256 digest of the text with case and whitespace normalized (punctuation is preserved — the key selects a vector, so it must preserve identity) — a digest because Harper rejects a primary key over ~1978 bytes. Skips the embedding backend on exactly repeated text; it is not an answer cache.
2. **Answer cache — HNSW vector search:** Use Harper's native `conditions` search with `comparator: 'lt'` and `value: 0.15` (cosine distance). **Never scan a table and score it in JS** — the index does the filtering. `resources/Agent.js` does recompute cosine distance, but only over the ≤20 rows the index already returned, to rank them (HNSW iteration is not distance-ordered) and to re-check the bound; matches outside `lt` have been observed to survive it, which is worth confirming against harper core rather than leaving as app-side compensation.

### Models API access
- `import { models } from 'harper'` — `models` is a process-wide singleton, exported by the `harper` package and also available as a bare global. It is the same object as `scope.models`, so a `handleApplication(scope)` plugin that stashes the Scope on `globalThis` is not needed.
- `models.generate()` returns `usage` (`promptTokens` / `completionTokens`) passed through from the backend, but the field is optional — `resources/Agent.js` falls back to a length estimate and reports which it used as `meta.tokensAreMeasured`.

### Chat UI (resources/Chat.js)
- Full HTML/CSS/JS served from a single template literal via `new Response(HTML, ...)`
- **Critical:** All regex backslashes in embedded `<script>` must be doubled (`\\d`, `\\s`, `\\*`, `\\n`) because the JS template literal consumes single backslashes
- Backtick characters in regex must use `\\x60` (hex escape) to avoid terminating the template literal
- Mobile responsive: sidebar slides over on screens ≤ 700px
- Harper brand colors: B-Tree Green `#66ffcc`, Quantum Purple `#312556`, Cyber Grape `#7a3a87`, Bytecode Bloom `#c63368`

## Commands

```bash
npm run dev          # Start local dev server (http://localhost:9926)
npm run start        # Start production server
npm run deploy       # Deploy to Harper Fabric
```

## Model Configuration

The app names no model and holds no provider credentials. Backends are configured on the
Harper *host* — the `models:` block of `harperdb-config.yaml`, or the equivalent env vars —
under `models.embedding.default` and `models.generative.default`. With neither configured,
`POST /Agent` returns a `ModelBackendNotFoundError`.

`.env` is still read (see `loadEnv` in `config.yaml`) but only carries the Fabric deploy
credentials: `CLI_TARGET`, `CLI_TARGET_USERNAME`, `CLI_TARGET_PASSWORD`.

## Common Tasks

### Wipe the database
```bash
curl -s -X DELETE http://localhost:9926/Message/
curl -s -X DELETE http://localhost:9926/Conversation/
curl -s -X DELETE http://localhost:9926/Stats/
```

### Test the agent via API
```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What color is the sky?"}'
```

### Check savings
```bash
curl http://localhost:9926/PublicStats/global
```

## Gotchas

1. **Template literal backslashes** — `\n` inside a JS template literal becomes a real newline. Use `\\n` in Chat.js script sections. Same for `\d`, `\s`, `\*` in regex patterns.
2. **Resource class naming** — naming a class `Stats` when there's a `Stats` table shadows `tables.Stats`. Always use a different name (e.g. `PublicStats`).
3. **`tables.Stats.get()` on empty DB** — returns `null`, not `{}`. Always provide a fallback: `?? { id: 'global', totalSaved: 0, cacheHits: 0 }`.
4. **`models.generate().usage` is optional** — a backend that reports none leaves it undefined, so `meta.tokens` may be a length estimate. `meta.tokensAreMeasured` says which. Dollar amounts are always list-price Claude Sonnet, never the backend's real cost.
5. **V2 auth** — `target.checkPermission = false` is the only way to allow unauthenticated access when `loadAsInstance = false`. V1 methods (`allowRead`) are silently ignored.
