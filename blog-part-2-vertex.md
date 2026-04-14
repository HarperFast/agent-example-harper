---
title: "Run Your Harper AI Agent on Google Cloud Vertex AI — 3 Files Changed"
published: false
description: "Part 2: Switch the Harper AI agent from Anthropic's direct API to Google Cloud Vertex AI. Same Claude, same agent, enterprise-grade GCP billing and data residency."
tags: ai, gcp, harperdb, claude
series: "Harper AI Agent"
---

In [Part 1](https://dev.to/harperfast/build-a-conversational-ai-agent-on-harper-in-5-minutes-4l4) we built a conversational AI agent on Harper — semantic cache, vector memory, local embeddings, web search, chat UI — all in one process. It talked to Claude through Anthropic's direct API.

That works great for solo developers and startups. But if your org runs on Google Cloud, you probably want Claude going through Vertex AI — same billing, same IAM, same audit logs as everything else in your GCP project.

Good news: it took three file changes and zero rewrites to the agent logic.

## Why Vertex AI?

If you're already on GCP, running Claude through Vertex means:

- **Consolidated billing** — Claude costs show up in the same invoice as your Compute Engine, BigQuery, and Cloud Storage
- **IAM and org policies** — control who can call Claude with the same roles and permissions you already manage
- **Data residency** — choose regional, multi-region, or global endpoints depending on where your data needs to stay
- **No API key management** — authenticate with GCP service accounts instead of passing around Anthropic API keys
- **Quota controls** — set per-project, per-model token limits through GCP's quota system

The underlying model is identical. Same Claude, same capabilities, same response quality. The only difference is the front door.

## What We Changed

The Anthropic SDK and the Vertex SDK share the same `messages.create()` interface. The only difference is how you initialize the client.

### 1. Install the Vertex SDK

```bash
npm install @anthropic-ai/vertex-sdk
```

One new dependency. It sits alongside `@anthropic-ai/sdk` — both stay installed so you can switch between providers with an environment variable.

### 2. Update the config (`lib/config.js`)

Before — Anthropic-only:

```javascript
export const config = {
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    model: () => optional('CLAUDE_MODEL', 'claude-sonnet-4-5-20250929'),
  },
}
```

After — provider-aware:

```javascript
export const config = {
  provider: () => optional('LLM_PROVIDER', 'anthropic'),
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    model: () => optional('CLAUDE_MODEL', 'claude-sonnet-4-5-20250929'),
  },
  vertex: {
    projectId: () => required('VERTEX_PROJECT_ID'),
    region: () => optional('VERTEX_REGION', 'global'),
    model: () => optional('VERTEX_MODEL', 'claude-sonnet-4-6'),
  },
}
```

`LLM_PROVIDER` controls which path the agent takes. Default is `anthropic`, so existing deployments don't break.

### 3. Update the agent (`resources/Agent.js`)

The client initialization goes from a one-liner to a conditional:

```javascript
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'

let _client
const getClient = () => {
  if (_client) return _client
  if (config.provider() === 'vertex') {
    _client = new AnthropicVertex({
      projectId: config.vertex.projectId(),
      region: config.vertex.region(),
    })
  } else {
    _client = new Anthropic({ apiKey: config.anthropic.apiKey() })
  }
  return _client
}
```

Every downstream call — `getClient().messages.create(...)` — stays exactly the same. The Vertex SDK is API-compatible with the Anthropic SDK. Same `messages`, same `tools`, same `system`, same `max_tokens`. No refactoring.

The only functional difference: Anthropic's server-side web search tool isn't available on Vertex by default (it requires a GCP org policy change), so we skip it:

```javascript
const tools = isVertex() ? [] : [WEB_SEARCH_TOOL]

let apiResponse = await getClient().messages.create({
  model: getModel(),
  max_tokens: 1024,
  ...(tools.length && { tools }),
  system: SYSTEM_PROMPT,
  messages,
})
```

That's it. The semantic cache, vector context, local embeddings, cost tracking, chat UI — all untouched.

## GCP Setup (5 Minutes)

If you don't have a GCP project yet, create one at [console.cloud.google.com](https://console.cloud.google.com). Then:

**1. Enable the Vertex AI API:**

```
https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=YOUR_PROJECT_ID
```

**2. Enable Claude in the Model Garden:**

Go to [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden), search "Claude", pick the model you want (e.g. Claude Sonnet 4.6), and enable it. You'll agree to Anthropic's terms here.

**3. Request quota:**

New projects start with 0 tokens/min for partner models. Go to [IAM & Admin → Quotas](https://console.cloud.google.com/iam-admin/quotas), filter for your Claude model, and request an increase. Even 100K tokens/min is plenty for testing.

**4. Create a service account:**

Go to IAM → Service Accounts → Create. Give it the **Vertex AI User** role. Download the JSON key.

**5. Configure `.env`:**

```env
LLM_PROVIDER=vertex
VERTEX_PROJECT_ID=my-gcp-project
VERTEX_REGION=us-east5
GOOGLE_APPLICATION_CREDENTIALS=./my-service-account-key.json
```

**6. Start the agent:**

```bash
npm run dev
```

Open `http://localhost:9926/Chat` and start chatting. The agent is now running Claude through your GCP project.

## Switching Back

Want to go back to Anthropic's direct API? Change one line:

```env
LLM_PROVIDER=anthropic
```

Restart. Done. Web search comes back automatically.

## What Didn't Change

This is the part worth emphasizing. Switching to Vertex AI required zero changes to:

- **The semantic cache** — Harper's HNSW vector search doesn't care where the LLM response came from
- **The local embeddings** — `bge-small-en-v1.5` runs in-process regardless of LLM provider
- **The schema** — same three tables, same vector index, same TTL
- **The chat UI** — same HTML, same WebSocket-free polling, same sidebar stats
- **The cost tracking** — token counts come back in the same format from both SDKs
- **The deployment** — `harperdb deploy .` works the same way

Harper handles everything below the LLM call. The LLM call itself is a single function with two possible backends. Swapping backends is a config change, not a rewrite.

## The Full Picture

```
.env: LLM_PROVIDER=vertex
         │
         ▼
┌─────────────────────────┐
│      resources/Agent.js │
│                         │
│  getClient() ─────────► AnthropicVertex (GCP credentials)
│  getModel()  ─────────► claude-sonnet-4-6
│                         │
│  Everything else:       │
│  same cache, same       │
│  embeddings, same       │
│  vector search, same    │
│  cost tracking          │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│         Harper          │
│  DB + Vector + Cache +  │
│  API + Embeddings       │
│  (unchanged)            │
└─────────────────────────┘
```

## Try It

The repo is at [github.com/stephengoldberg/agent-example-harper](https://github.com/stephengoldberg/agent-example-harper). Clone it, pick your provider, and `npm run dev`.

If you're already running the agent from Part 1, the diff is small:

```bash
npm install @anthropic-ai/vertex-sdk
# Update .env with your GCP config
npm run dev
```

Three files changed. Zero agent logic rewritten. Same Claude, enterprise-grade GCP integration.
