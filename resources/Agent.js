import { createHash } from 'node:crypto'
import { logger, models, Resource, tables } from 'harper'
import { embed } from '../lib/embeddings.js'

const SYSTEM_PROMPT = `You are a helpful, concise assistant. Answer only the user's current question. \
Do NOT summarize, repeat, or reference prior conversation context in your response — use it silently \
as background knowledge only if it is directly relevant. Never recite or recap previous answers.`

// The savings tracker prices every generation at list-price Claude Sonnet 4.5 whichever
// backend actually ran it, so the dollars are a comparator, never a bill.
const CLAUDE_COST_INPUT_PER_TOKEN  = 3  / 1_000_000  // $3  / 1M input tokens
const CLAUDE_COST_OUTPUT_PER_TOKEN = 15 / 1_000_000  // $15 / 1M output tokens

// Fallback only: `models.generate()` passes the backend's token usage through, but the
// field is optional and a backend that reports none leaves it undefined.
const estimateTokens = (text) => Math.max(1, Math.ceil((text?.length ?? 0) / 4))

const estimateClaudeCost = (promptTokens, completionTokens) =>
  promptTokens * CLAUDE_COST_INPUT_PER_TOKEN + completionTokens * CLAUDE_COST_OUTPUT_PER_TOKEN

// Case and whitespace only. This key selects a stored *vector*, so it has to preserve
// identity: stripping punctuation collided `What is C++?` with `What is C#?`, handing the
// second asker the first one's embedding to be indexed as their own message.
const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()

// Harper rejects a primary key over ~1978 bytes and message text is unbounded.
const cacheKey = (text) => createHash('sha256').update(normalize(text)).digest('base64url')

// Cosine distance threshold for Harper's native HNSW vector search.
// Harper uses cosine *distance* (0 = identical, 2 = opposite). 0.15 ≈ cosine
// similarity 0.85 — loose enough to catch rewordings and related phrasings
// ("describe the moon landing" / "tell me about apollo 11"), tight enough
// that the matched reply is reasonably on-topic.
const CACHE_DISTANCE_THRESHOLD = 0.15

// Unequal lengths mean the host's embedding backend changed under the stored vectors.
// Report maximum distance rather than scoring a prefix.
function cosineDistance(a, b) {
  if (a.length !== b.length) return 2
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 1 : 1 - dot / denom
}

async function cachedEmbed(text) {
  const key = cacheKey(text)
  const cached = await tables.EmbeddingCache.get(key)
  if (cached?.embedding) return cached.embedding
  const embedding = await embed(text)
  await tables.EmbeddingCache.put({ id: key, embedding })
  return embedding
}

export class Agent extends Resource {
  // POST /Agent — send a message, get a response
  static async post(target, data) {
    target.checkPermission = false
    const startTime = Date.now()
    const body = await data
    const { message, conversationId: existingId } = body || {}
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

    // HNSW iteration is not distance-ordered, so rank here. The re-check is not redundant:
    // core's cosine helper zero-pads to the longer vector rather than rejecting a length
    // mismatch, so a row left from a different embedding backend can pass `lt`.
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
      if (midx === -1) continue
      // Only the IMMEDIATELY following message is this question's answer: scanning forward
      // would skip past later user messages that produced no reply of their own and return
      // an answer to a different question.
      const next = matchConvMsgs[midx + 1]
      if (next?.role === 'assistant') {
        cachedReply = next
        break
      }
    }
    const tCache = Date.now() - t4

    const timing = { embedMs: tEmbed, convMs: tConv, storeMs: tStore, cacheSearchMs: tCache }
    logger.debug('[Agent] timing:', timing)

    if (cachedReply) {
      const savedCost = cachedReply.cost ?? 0
      try {
        const stats = await tables.Stats.get('global')
        await tables.Stats.put({
          id: 'global',
          totalSaved: (stats?.totalSaved ?? 0) + savedCost,
          cacheHits: ((stats?.cacheHits) ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        })
      } catch (err) {
        logger.warn('[Agent] savings counter update failed', err)
      }
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

    // 5. Generate via models.generate() — routes to whatever backend the host
    //    has configured for `models.generative.default` (the shared inference process
    //    on Fabric GPU hosts, Ollama / OpenAI / Anthropic / Bedrock elsewhere).
    const result = await models.generate(
      {
        messages: [{ role: 'user', content: message }],
        system: SYSTEM_PROMPT,
      },
      { maxTokens: 1024 },
    )

    const latencyMs = Date.now() - startTime
    const assistantContent = result.content?.trim() ?? ''
    if (!assistantContent) {
      const err = new Error(`Model returned no content (finishReason: ${result.finishReason})`)
      err.statusCode = 502
      throw err
    }
    // A truncated or filtered answer is still worth returning, but persisting it would seed
    // the cache: every near-miss question thereafter is served the partial text as complete.
    const isComplete = result.finishReason === 'stop'
    const promptTokens = result.usage?.promptTokens ?? estimateTokens(SYSTEM_PROMPT + message)
    const completionTokens = result.usage?.completionTokens ?? estimateTokens(assistantContent)
    const tokensAreMeasured = result.usage?.promptTokens !== undefined
    const estimatedCost = estimateClaudeCost(promptTokens, completionTokens)

    // 9. Store the assistant's response. The cost rides along so a later cache hit on this
    //    question can credit it to `totalSaved`.
    if (isComplete) {
      // Not `cachedEmbed`: a generated reply is unique text, so the lookup always misses.
      // A failure here must not discard an answer already paid for, so the row is stored
      // unembedded; the candidate loop skips rows without an embedding.
      let assistantEmbedding
      try {
        assistantEmbedding = await embed(assistantContent)
      } catch (err) {
        logger.warn('[Agent] reply embedding failed; storing message unindexed', err)
      }
      await tables.Message.put({
        id: crypto.randomUUID(),
        conversationId,
        role: 'assistant',
        content: assistantContent,
        cost: estimatedCost,
        embedding: assistantEmbedding,
        createdAt: new Date().toISOString(),
      })
    }

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
        finishReason: result.finishReason,
        tokensAreMeasured,
      },
    }
  }
}

export class PublicStats extends Resource {
  static async get(target) {
    target.checkPermission = false
    return await tables.Stats.get('global') ?? { id: 'global', totalSaved: 0, cacheHits: 0 }
  }
}
