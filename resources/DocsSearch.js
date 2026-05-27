import { Resource, tables } from 'harperdb';
import { embed } from '../lib/embeddings.js';

/**
 * Ad-hoc semantic search across the ingested Harper docs.
 *
 * GET /DocsSearch?q=<query>&k=<topK>&maxDistance=<float>
 *   q             — required query string
 *   k             — number of results to return (default 5, max 25)
 *   maxDistance   — optional cosine-distance ceiling (default no filter)
 *
 * This endpoint is what the Agent calls under the hood for RAG, but it's
 * also useful as a standalone tool — point a docs-search UI at it, or hit
 * it from external automations.
 *
 * Returns:
 *   { query, results: [{ id, title, sourceUrl, headingPath, content, distance }] }
 */
export class DocsSearch extends Resource {
	static loadAsInstance = false;

	// Both GET (q in path: /DocsSearch/<query>) and POST (q in JSON body) work.
	// POST is the safer external-tooling shape — no URL-encoding gotchas with
	// query strings containing spaces or special chars; the body also carries
	// `k` and `maxDistance` directly. Agent.js imports `searchDocs()` and
	// bypasses HTTP entirely, so this surface is for ad-hoc external use.
	async get(target) {
		target.checkPermission = false;
		const q = target.id;
		if (!q) {
			const err = new Error('Missing query — POST a JSON body { q, k?, maxDistance? } or GET /DocsSearch/<query>');
			err.statusCode = 400;
			throw err;
		}
		return await searchDocs(decodeURIComponent(q), {});
	}

	async post(target, data) {
		target.checkPermission = false;
		const q = data?.q;
		if (!q) {
			const err = new Error('Missing required field: q');
			err.statusCode = 400;
			throw err;
		}
		return await searchDocs(q, {
			k: clampInt(data?.k, 5, 1, 25),
			maxDistance: typeof data?.maxDistance === 'number' ? data.maxDistance : null,
		});
	}
}

/**
 * Programmatic API used by Agent.js — same logic, but no Resource wrapping.
 *
 * Embed the query once, run an HNSW search, return up to `k` chunks sorted by
 * computed cosine distance. We post-sort because HNSW returns matches under
 * the threshold but doesn't guarantee distance-ascending order (same gotcha
 * the cache-match code in Agent.js documents).
 */
export async function searchDocs(query, { k = 5, maxDistance = null } = {}) {
	const queryVector = await embed(query);

	// Pull more candidates than `k` so the post-sort has something to chew on.
	// HNSW's `lt` comparator wants an upper bound on distance — when the caller
	// doesn't specify one, we use 2.0 (the cosine-distance max, i.e. "anything").
	const upper = maxDistance ?? 2.0;
	const matches = tables.DocChunk.search({
		conditions: {
			attribute: 'embedding',
			comparator: 'lt',
			value: upper,
			target: queryVector,
		},
		limit: Math.max(k * 4, 20),
	});

	const candidates = [];
	for await (const m of matches) {
		if (!m.embedding) continue;
		candidates.push({ ...m, distance: cosineDistance(queryVector, m.embedding) });
	}
	candidates.sort((a, b) => a.distance - b.distance);

	const top = candidates.slice(0, k).map(({ embedding, ...rest }) => rest);
	return { query, results: top };
}

function clampInt(raw, fallback, min, max) {
	const n = parseInt(raw, 10);
	if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
	return fallback;
}

function cosineDistance(a, b) {
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 1 : 1 - dot / denom;
}
