---
title: Build a Conversational AI Agent on Harper in 5 Minutes
published: false
description: Clone a repo, add an API key, and deploy a chat agent with semantic caching, vector memory, and web search — all running on Harper.
tags: ai, agents, harperdb, javascript
---

Building AI agents usually means stitching together a database, a vector store, a caching layer, an API server, and a deployment pipeline. Five services, five sets of credentials, and a weekend gone.

We built an agent that does all of that on [Harper](https://harper.fast) — database, vector search, semantic cache, API, and deployment in one runtime. The [full source](https://github.com/stephengoldberg/agent-example-harper) is open. Here's how to get it running.

## What You Get

A conversational chat agent powered by Claude with:

- **Semantic memory** — every message is embedded and stored. Ask a question from three conversations ago and it remembers, powered by Harper's built-in HNSW vector index.
- **Semantic caching** — ask the same question twice (or a rephrased version) and it answers instantly from Harper at **$0.00 LLM cost**. Over time, a popular agent builds a dense cache that handles most queries for free.
- **Web search** — Anthropic's built-in server-side search, no extra API key.
- **Local embeddings** — `bge-small-en-v1.5` runs locally via llama.cpp inside Harper. No embedding API, no extra cost.
- **A chat UI** — served directly from Harper at `/Chat` with per-response cost, latency, and token tracking.
- **A live savings counter** — tracks how much money the cache has saved across all conversations.

**[Live demo →](https://agent-example.stephen-demo-org.harperfabric.com/Chat)**

## Get It Running

Prerequisites: Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/stephengoldberg/agent-example-harper.git
cd agent-example-harper
npm install
```

Add your key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" > .env
```

Start it:

```bash
npm run dev
```

Open [http://localhost:9926/Chat](http://localhost:9926/Chat). That's it.

On first run, the embedding model (~24 MB) downloads automatically. Every run after that starts in seconds.

## See the Cache in Action

Ask a question — say, "Who is the president of the United States?" You'll see the metadata strip under the response:

```
LATENCY 5.2s · TOKENS 2,400 in / 150 out · COST $0.0098 · WEB 1 search
```

Now ask it again, or rephrase it — "who's the current US president?" The response comes back instantly:

```
LATENCY 0.03s · CACHE Served from Harper semantic cache — $0.00 · saved $0.0098
```

Same answer, zero LLM cost, sub-50ms. Harper's HNSW vector index found that the new question is semantically equivalent (cosine similarity ≥ 0.88) and served the cached response without calling Claude at all.

The savings panel in the sidebar tracks this across every conversation.

## How It Works

Everything runs inside Harper — a unified runtime that combines a database, vector index, cache, and API server in one process:

- **Harper Agent** — a JavaScript `Resource` class that handles `POST /Agent`. It's your agent logic, running in-process. No Express, no API framework.
- **Vector Store** — `@indexed(type: "HNSW", distance: "cosine")` in the schema. One line gives you a full vector index. Harper searches it natively with `conditions` and `comparator: 'lt'` — no in-memory math, no full scans.
- **Semantic Cache** — two layers. First: exact text match (free, instant). Second: Harper's HNSW index finds semantically similar past questions within a cosine distance threshold. Both run inside the database, not in your application code.
- **Local SLM** — `bge-small-en-v1.5` runs via llama.cpp in the same Node.js process. Embeddings cost nothing and never leave the machine.
- **Claude + Web Search** — the only external call. Only happens on cache misses. Anthropic's built-in server-side search means no Google API key.

The entire schema is 24 lines of GraphQL. The agent logic is ~200 lines of JavaScript. There's no ORM, no database driver, no vector database client, no caching library, and no route definitions.

## Deploy to Harper Fabric

```bash
npm run deploy
```

One command. Your agent is now running globally on [Harper Fabric](https://fabric.harper.fast/). No Docker, no Kubernetes, no CI/CD pipeline.

## Why Harper

The traditional stack for an AI agent with memory and caching looks like: Postgres + Pinecone + Redis + Express + Docker + a deployment pipeline. That's six services to configure, connect, and maintain.

With Harper it's one runtime:

| What | Traditional | Harper |
|---|---|---|
| Database | Postgres/MongoDB | Built in |
| Vector search | Pinecone/Weaviate | Built in (`@indexed(type: "HNSW")`) |
| Semantic cache | Redis + custom logic | Built in (native HNSW conditions search) |
| API server | Express/Fastify | Auto-generated from schema |
| Embeddings | OpenAI/Voyage API ($) | Local SLM, $0 |
| Deployment | Docker + K8s | `harperdb deploy .` |

The cache is the real story at scale. Every question that hits the cache saves you the full cost of a Claude API call — tokens, web searches, and all. The savings compound: the more your agent is used, the less it costs per query.

**[Clone the repo](https://github.com/stephengoldberg/agent-example-harper)**, add your Anthropic key, and try it.
