import { Resource, tables } from 'harperdb'
import { embed } from '../lib/embeddings.js'

const SYSTEM_PROMPT = `You are a helpful, concise assistant. Answer only the user's current question. \
Do NOT summarize, repeat, or reference prior conversation context in your response — use it silently \
as background knowledge only if it is directly relevant. Never recite or recap previous answers.`

// Hypothetical Claude Sonnet 4.5 pricing used to estimate what each generation
// WOULD have cost if we'd called Anthropic instead of the local GPU. Real local
// compute cost is roughly $0 (sunk-cost GPU); the dashboard shows what we're
// saving by self-hosting + caching.
const CLAUDE_COST_INPUT_PER_TOKEN  = 3  / 1_000_000  // $3  / 1M input tokens
const CLAUDE_COST_OUTPUT_PER_TOKEN = 15 / 1_000_000  // $15 / 1M output tokens

// scope.models.generate() returns only { content, finishReason } today — the
// backend's token usage isn't surfaced to callers. Approximate with the
// ~4-chars-per-token rule of thumb for English; close enough for a comparator.
const estimateTokens = (text) => Math.max(1, Math.ceil((text?.length ?? 0) / 4))

const estimateClaudeCost = (promptTokens, completionTokens) =>
  promptTokens * CLAUDE_COST_INPUT_PER_TOKEN + completionTokens * CLAUDE_COST_OUTPUT_PER_TOKEN

// Normalize text for embedding cache key — lowercase, strip punctuation, collapse whitespace
const normalize = (s) =>
  s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

// Cosine distance threshold for Harper's native HNSW vector search.
// Harper uses cosine *distance* (0 = identical, 2 = opposite). 0.05 ≈ cosine
// similarity 0.95 — strict enough that semantically different queries
// ("describe the moon landing" vs "tell me about apollo 11") don't collide.
const CACHE_DISTANCE_THRESHOLD = 0.05

// HNSW search returns matches that satisfy the threshold but doesn't guarantee
// distance-ordered iteration. We compute distance ourselves and pick the closest.
function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 1 : 1 - dot / denom
}

// Get or compute an embedding, using Harper as a cache to skip the model on repeated text.
async function cachedEmbed(text) {
  const key = normalize(text)
  const cached = await tables.EmbeddingCache.get(key)
  if (cached?.embedding) return cached.embedding
  const embedding = await embed(text)
  await tables.EmbeddingCache.put({ id: key, embedding })
  return embedding
}

export class Agent extends Resource {
  static loadAsInstance = false

  // POST /Agent — send a message, get a response
  async post(target, data) {
    target.checkPermission = false
    const startTime = Date.now()
    const { message, conversationId: existingId } = data || {}
    if (!message) {
      const err = new Error('Missing required field: message')
      err.statusCode = 400
      throw err
    }

    // 1. Embed first — before any DB writes to avoid holding transactions open
    const t1 = Date.now()
    const userEmbedding = await cachedEmbed(message)
    const tEmbed = Date.now() - t1

    // 2. Create or reuse a conversation
    const t2 = Date.now()
    const conversationId = existingId || crypto.randomUUID()
    if (!existingId) {
      await tables.Conversation.put({
        id: conversationId,
        title: message.slice(0, 100),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
    const tConv = Date.now() - t2

    // 3. Store the user message with its embedding
    const t3 = Date.now()
    const userMsgId = crypto.randomUUID()
    await tables.Message.put({
      id: userMsgId,
      conversationId,
      role: 'user',
      content: message,
      embedding: userEmbedding,
      createdAt: new Date().toISOString(),
    })
    const tStore = Date.now() - t3

    // 4. Semantic cache — Harper-native HNSW vector search with distance threshold.
    //    HNSW search returns matches under the threshold but iteration order isn't
    //    guaranteed to be distance-ascending, so we collect candidates, compute
    //    cosine distance ourselves, and pick the closest valid one.
    const t4 = Date.now()
    let cachedReply = null
    const nearbyMsgs = tables.Message.search({
      conditions: {
        attribute: 'embedding',
        comparator: 'lt',
        value: CACHE_DISTANCE_THRESHOLD,
        target: userEmbedding,
      },
      limit: 20,
    })

    const candidates = []
    for await (const match of nearbyMsgs) {
      if (match.id === userMsgId || match.role !== 'user' || !match.embedding) continue
      candidates.push({ match, distance: cosineDistance(userEmbedding, match.embedding) })
    }
    candidates.sort((a, b) => a.distance - b.distance)

    // Debug: print what the search returned along with the actual computed distance.
    // Harper's HNSW `lt` filter doesn't always cull things outside the threshold,
    // so we apply a hard check using the distance we computed ourselves.
    if (candidates.length > 0) {
      console.log('[Agent] cache candidates:', candidates.slice(0, 5).map((c) => ({
        id: c.match.id,
        role: c.match.role,
        dist: +c.distance.toFixed(4),
        content: c.match.content?.slice(0, 60),
      })))
    }
    const filtered = candidates.filter((c) => c.distance <= CACHE_DISTANCE_THRESHOLD)

    for (const { match } of filtered) {
      const matchConvMsgs = []
      const matchHistory = tables.Message.search({
        conditions: [{ attribute: 'conversationId', value: match.conversationId }],
        limit: 100,
      })
      for await (const m of matchHistory) matchConvMsgs.push(m)
      matchConvMsgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const midx = matchConvMsgs.findIndex((m) => m.id === match.id)
      const reply = matchConvMsgs.slice(midx + 1).find((m) => m.role === 'assistant')
      if (reply) {
        cachedReply = reply
        break
      }
    }
    const tCache = Date.now() - t4

    const timing = { embedMs: tEmbed, convMs: tConv, storeMs: tStore, cacheSearchMs: tCache }
    console.log('[Agent] timing:', JSON.stringify(timing))

    // Return the cached answer — zero LLM call. We credit the original message's
    // estimated cost to `totalSaved` so the dashboard shows the running benefit
    // of the semantic cache (and self-hosting more broadly).
    if (cachedReply) {
      let savedCost = 0
      try {
        const origMsg = await tables.Message.get(cachedReply.id)
        savedCost = origMsg?.cost ?? 0
        const stats = await tables.Stats.get('global')
        await tables.Stats.put({
          id: 'global',
          totalSaved: (stats?.totalSaved ?? 0) + savedCost,
          cacheHits: ((stats?.cacheHits) ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        })
      } catch {}
      return {
        conversationId,
        message: { role: 'assistant', content: cachedReply.content },
        meta: {
          latencyMs: Date.now() - startTime,
          timing,
          tokens: { input: 0, output: 0, total: 0 },
          cost: { input: 0, output: 0, total: 0, saved: savedCost },
          vectorContext: { hit: true, count: 1, cached: true },
        },
      }
    }

    // 5. Generate via scope.models.generate() — routes to whatever backend the host
    //    has configured for `models.generative.default` (vLLM on Fabric GPU hosts,
    //    Ollama / OpenAI / Anthropic on other deployments).
    const scope = globalThis.harperScope
    if (!scope) {
      throw new Error('Harper scope not yet captured — modelCapture plugin must run before first generate call')
    }

    const result = await scope.models.generate(
      {
        messages: [{ role: 'user', content: message }],
        system: SYSTEM_PROMPT,
      },
      { maxTokens: 1024 },
    )

    const latencyMs = Date.now() - startTime
    const assistantContent = result.content?.trim() ?? ''
    const promptTokens = estimateTokens(SYSTEM_PROMPT + message)
    const completionTokens = estimateTokens(assistantContent)
    const estimatedCost = estimateClaudeCost(promptTokens, completionTokens)

    // 9. Store the assistant's response with its embedding. We persist the
    //    *hypothetical* Claude cost so a future cache-hit on this same message
    //    can credit that amount to `totalSaved`.
    const assistantMsgId = crypto.randomUUID()
    const assistantEmbedding = await cachedEmbed(assistantContent)
    await tables.Message.put({
      id: assistantMsgId,
      conversationId,
      role: 'assistant',
      content: assistantContent,
      cost: estimatedCost,
      embedding: assistantEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 10. Update conversation timestamp
    await tables.Conversation.put({
      id: conversationId,
      updatedAt: new Date().toISOString(),
    })

    return {
      conversationId,
      message: { role: 'assistant', content: assistantContent },
      meta: {
        latencyMs,
        timing,
        tokens: {
          input: promptTokens,
          output: completionTokens,
          total: promptTokens + completionTokens,
        },
        cost: {
          input: +(promptTokens * CLAUDE_COST_INPUT_PER_TOKEN).toFixed(6),
          output: +(completionTokens * CLAUDE_COST_OUTPUT_PER_TOKEN).toFixed(6),
          total: +estimatedCost.toFixed(6),
          // `saved` is what cache hits credit; on a real generation it stays 0.
          saved: 0,
        },
        vectorContext: { hit: false, count: 0, cached: false },
      },
    }
  }
}

export class PublicStats extends Resource {
  static loadAsInstance = false

  async get(target) {
    target.checkPermission = false
    return await tables.Stats.get('global') ?? { id: 'global', totalSaved: 0, cacheHits: 0 }
  }
}
