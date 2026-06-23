import { Resource, tables, models } from 'harper'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import { config } from '../lib/config.js'

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

const getModel = () =>
  config.provider() === 'vertex' ? config.vertex.model() : config.anthropic.model()

const SYSTEM_PROMPT = `You are a helpful, concise assistant. Answer only the user's current question. \
Do NOT summarize, repeat, or reference prior conversation context in your response — use it silently \
as background knowledge only if it is directly relevant. Never recite or recap previous answers.`

// Approximate pricing for Claude Sonnet 4.5 (per token)
const COST_INPUT_PER_TOKEN = 3 / 1_000_000  // $3  / 1M input tokens
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000  // $15 / 1M output tokens
const COST_PER_WEB_SEARCH = 10 / 1_000      // $10 / 1K searches

// Anthropic web search tool — executed server-side, no external API key needed.
// Not available on Vertex AI without an org policy change.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
const isVertex = () => config.provider() === 'vertex'

// Cosine distance threshold for Harper's native HNSW vector search.
// Harper uses cosine *distance* (0 = identical, 2 = opposite), so this is
// equivalent to cosine similarity >= 0.88 (distance = 1 - similarity = 0.12).
// NOTE: tuned for the configured embedding model (models.embedding.text-embed in
// the Harper instance config) — revisit if you swap the model, since absolute
// distances shift.
const CACHE_DISTANCE_THRESHOLD = 0.12

// Embed query text via Harper's model API (the same "text-embed" model the @embed
// directive uses at write time, so query and stored vectors are comparable).
// Stored Message embeddings are populated automatically by @embed — this is only
// needed for the query-side vector used as the HNSW search target.
async function embedQuery(text) {
  const [vector] = await models.embed(text, { model: 'text-embed' })
  // models.embed returns Float32Array; convert to a plain array for the search target.
  return Array.from(vector)
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

    // 1. Embed the query first — before any DB writes to avoid holding transactions open.
    //    Used as the target vector for the semantic-cache HNSW search below.
    const t1 = Date.now()
    const userEmbedding = await embedQuery(message)
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

    // 3. Store the user message. The `embedding` field is populated automatically
    //    by the @embed directive (schemas/schema.graphql) from `content` at write
    //    time, which also updates the HNSW index before this put resolves.
    const t3 = Date.now()
    const userMsgId = crypto.randomUUID()
    await tables.Message.put({
      id: userMsgId,
      conversationId,
      role: 'user',
      content: message,
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
      limit: 10,
    })

    for await (const match of nearbyMsgs) {
      if (match.id === userMsgId || match.role !== 'user') continue
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

    // Return the cached answer — zero LLM cost
    if (cachedReply) {
      const t5 = Date.now()
      let savedCost = 0
      try {
        const origMsg = await tables.Message.get(cachedReply.id)
        savedCost = origMsg?.cost ?? 0
        const stats = await tables.Stats.get('global')
        await tables.Stats.put({
          id: 'global',
          totalSaved: ((stats?.totalSaved) ?? 0) + savedCost,
          cacheHits: ((stats?.cacheHits) ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        })
      } catch { }
      const tStats = Date.now() - t5
      console.log('[Agent] cache hit stats update:', tStats + 'ms')
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

    // 5. Call Claude with web search enabled — standalone question, no conversation history.
    //    Anthropic executes searches server-side, no external search API or key required.
    const messages = [{ role: 'user', content: message }]

    const tools = isVertex() ? [] : [WEB_SEARCH_TOOL]

    let apiResponse = await getClient().messages.create({
      model: getModel(),
      max_tokens: 1024,
      ...(tools.length && { tools }),
      system: SYSTEM_PROMPT,
      messages,
    })

    // Handle pause_turn — server hit the max_uses limit mid-response; continue once
    if (apiResponse.stop_reason === 'pause_turn') {
      apiResponse = await getClient().messages.create({
        model: getModel(),
        max_tokens: 1024,
        ...(tools.length && { tools }),
        system: SYSTEM_PROMPT,
        messages: [...messages, { role: 'assistant', content: apiResponse.content }],
      })
    }

    const latencyMs = Date.now() - startTime

    // The API can split the answer across multiple text blocks (sentence fragments joined
    // without separators) and may emit a text block BEFORE the web search tool call.
    // Strategy: find the last non-text block (tool use / search result) and take only the
    // text blocks that follow it — these form the actual answer. Join with '' since the
    // fragments are already continuous prose. Falls back to all text blocks if no tools used.
    const lastToolIdx = apiResponse.content.reduce((acc, b, i) => b.type !== 'text' ? i : acc, -1)
    const assistantContent = apiResponse.content
      .slice(lastToolIdx + 1)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    const { input_tokens, output_tokens } = apiResponse.usage
    const webSearches = apiResponse.usage?.server_tool_use?.web_search_requests ?? 0

    // 9. Store the assistant's response. As with the user message, @embed computes
    //    and indexes the embedding from `content` automatically at write time.
    const assistantMsgId = crypto.randomUUID()
    const searchCost = webSearches * COST_PER_WEB_SEARCH
    const totalCost = (input_tokens * COST_INPUT_PER_TOKEN) + (output_tokens * COST_OUTPUT_PER_TOKEN) + searchCost
    await tables.Message.put({
      id: assistantMsgId,
      conversationId,
      role: 'assistant',
      content: assistantContent,
      cost: totalCost,
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
        tokens: {
          input: input_tokens,
          output: output_tokens,
          total: input_tokens + output_tokens,
        },
        cost: {
          input: +(input_tokens * COST_INPUT_PER_TOKEN).toFixed(6),
          output: +(output_tokens * COST_OUTPUT_PER_TOKEN).toFixed(6),
          search: +searchCost.toFixed(6),
          total: +totalCost.toFixed(6),
        },
        webSearches,
        vectorContext: { hit: false, count: 0, cached: false },
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
