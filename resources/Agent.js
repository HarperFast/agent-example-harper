import { Resource, tables } from 'harperdb'
import { embed } from '../lib/embeddings.js'
import { searchDocs } from './DocsSearch.js'

// Base assistant prompt — used when no RAG context is available (no docs
// ingested yet, or the user asks something off-topic that surfaces no
// relevant chunks).
const BASE_SYSTEM_PROMPT = `You are a helpful, concise assistant for the Harper database / Fabric platform. \
Answer only the user's current question. Do NOT summarize, repeat, or reference prior conversation context in your response — use it silently \
as background knowledge only if it is directly relevant. Never recite or recap previous answers.`

// RAG variant — used when DocsSearch returned at least one chunk. The model
// is instructed to ground its answer in the supplied context AND to cite the
// source URLs it relied on, so users can verify the docs claim themselves.
const RAG_SYSTEM_PREFIX = `You are a documentation assistant for Harper (a database / streaming / Fabric platform). \
Answer the user's question using the Harper documentation excerpts provided below as your primary source. \
If the excerpts don't contain a clear answer, say so plainly — do not invent details. \
Cite the source URLs you relied on at the end of your answer in the form "Sources: <url>, <url>".\n\nDocumentation excerpts:`

// Top-K chunks retrieved from DocChunk on each generate call. Five is a
// reasonable starting point: enough to cover related sub-topics, not so many
// that the prompt explodes past the model's effective context window.
const RAG_TOP_K = 5
// Reject doc chunks above this cosine distance — anything further away is
// almost certainly noise that would distract the model rather than help.
// Calibrate as we see retrieval quality on real questions.
const RAG_MAX_DISTANCE = 0.6

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
// Harper uses cosine *distance* (0 = identical, 2 = opposite). 0.15 ≈ cosine
// similarity 0.85 — loose enough to catch rewordings and related phrasings
// ("describe the moon landing" / "tell me about apollo 11"), tight enough
// that the matched reply is reasonably on-topic.
const CACHE_DISTANCE_THRESHOLD = 0.15

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

    // Harper's HNSW `lt` filter doesn't always cull matches outside the threshold,
    // so we apply a hard check using the distance we computed ourselves.
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
      // The matched message's reply must be the IMMEDIATELY following message.
      // `.find()` would walk past any subsequent user-msgs (cache hits that didn't
      // generate a reply) and pull an unrelated answer from much later in the
      // conversation — e.g. matching "is soccer fun" but returning the assistant
      // reply to a later "what is 2 plus 3" question in the same conversation.
      const next = matchConvMsgs[midx + 1]
      if (next?.role === 'assistant') {
        cachedReply = next
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

    // 5. Retrieve relevant Harper-doc chunks for RAG. Uses the already-computed
    //    `userEmbedding` indirectly: searchDocs re-embeds the query for its own
    //    `headingPath\n\ncontent` input shape — minor duplication, big retrieval-
    //    quality win because the chunks were embedded with their breadcrumb too.
    //    On corpus-empty (ingest not yet run) or no-results, we fall through to
    //    the non-RAG prompt — the chat still works, it just won't cite docs.
    const tRag = Date.now()
    let ragResults = []
    try {
      const out = await searchDocs(message, { k: RAG_TOP_K, maxDistance: RAG_MAX_DISTANCE })
      ragResults = out.results ?? []
    } catch (err) {
      // RAG is best-effort — log and continue with the plain prompt rather than
      // failing the whole chat turn over a search hiccup.
      console.warn('[Agent] RAG search failed:', err.message)
    }
    const ragMs = Date.now() - tRag
    timing.ragMs = ragMs

    const systemPrompt = ragResults.length > 0
      ? buildRagSystemPrompt(ragResults)
      : BASE_SYSTEM_PROMPT

    // 6. Generate via scope.models.generate() — routes to whatever backend the host
    //    has configured for `models.generative.default` (vLLM on Fabric GPU hosts,
    //    Ollama / OpenAI / Anthropic on other deployments).
    const scope = globalThis.harperScope
    if (!scope) {
      throw new Error('Harper scope not yet captured — modelCapture plugin must run before first generate call')
    }

    const result = await scope.models.generate(
      {
        messages: [{ role: 'user', content: message }],
        system: systemPrompt,
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
        rag: ragResults.length > 0
          ? {
              count: ragResults.length,
              sources: ragResults.map((r) => ({
                url: humanizeDocUrl(r.sourceUrl),
                title: r.title,
                headingPath: r.headingPath,
                distance: +r.distance.toFixed(4),
              })),
            }
          : { count: 0, sources: [] },
      },
    }
  }
}

// Format the retrieved chunks for the system prompt. Each chunk is delimited
// so the model can tell where one excerpt ends and the next begins, and we
// include the source URL inline so the model has somewhere natural to cite
// from. Total length is bounded by the chunk MAX_CHARS × RAG_TOP_K.
function buildRagSystemPrompt(results) {
  const blocks = results.map((r, i) => {
    const url = humanizeDocUrl(r.sourceUrl)
    const breadcrumb = r.headingPath ? ` — ${r.headingPath}` : ''
    return `[#${i + 1}] ${r.title}${breadcrumb}\nSource: ${url}\n\n${r.content}`
  })
  return `${RAG_SYSTEM_PREFIX}\n\n${blocks.join('\n\n---\n\n')}`
}

// llms.txt links point at the .md sources; rewrite to the human-browsable
// URL for citation display. e.g. /reference/v4/database/schema.md → /reference/v4/database/schema
function humanizeDocUrl(url) {
  return url?.replace(/\.md$/, '') ?? url
}

export class PublicStats extends Resource {
  static loadAsInstance = false

  async get(target) {
    target.checkPermission = false
    return await tables.Stats.get('global') ?? { id: 'global', totalSaved: 0, cacheHits: 0 }
  }
}
