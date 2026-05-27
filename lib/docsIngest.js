// Harper docs ingestion: fetch llms.txt → enumerate doc pages → fetch each
// page's raw markdown → chunk by headings → embed → persist.
//
// Why llms.txt: docs.harperdb.io/llms.txt is an LLM-targeted index that lists
// every doc page with its canonical /...md URL. It's the cleanest possible
// source of truth — no HTML parsing, no link discovery heuristics, no
// scraping the rendered site.

import { embed } from './embeddings.js';

const DOCS_BASE = 'https://docs.harperdb.io';
const LLMS_TXT_URL = `${DOCS_BASE}/llms.txt`;

// Chunking parameters. Most Harper doc pages are 1–3K chars per top-level
// section; we split on H2/H3 and concatenate adjacent small sections to hit
// MIN_CHARS. Anything above MAX_CHARS gets a soft split on paragraph breaks.
const MIN_CHARS = 400;
const MAX_CHARS = 1800;

// Concurrency limit for HTTP fetches (be polite to docs.harperdb.io).
const FETCH_CONCURRENCY = 6;

// Concurrency limit for embed calls — vLLM happily handles batches, but the
// scope.models.embed() facade is one-call-per-input today, so this just caps
// the parallel-fan-out.
const EMBED_CONCURRENCY = 8;

/**
 * Fetch and parse https://docs.harperdb.io/llms.txt into a list of doc-page
 * URLs (absolute, .md-suffixed). Skips the search page (it's a stub) and
 * dedupes — llms.txt occasionally lists the same page under multiple sections.
 */
export async function fetchLlmsTxt(baseUrl = DOCS_BASE) {
	const url = `${baseUrl}/llms.txt`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
	const text = await res.text();
	const links = parseLlmsTxtLinks(text, baseUrl);
	const filtered = links.filter((l) => !l.url.endsWith('/search.md'));
	// Dedupe by URL, keeping the first title we saw.
	const seen = new Map();
	for (const link of filtered) if (!seen.has(link.url)) seen.set(link.url, link);
	return [...seen.values()];
}

/**
 * Parse links of the form `- [Title](/path.md): description` out of an
 * llms.txt body. Returns absolute URLs and the markdown title text.
 *
 * Doesn't try to parse the "## section" headings — they're informational and
 * we don't currently use them. (Adding the section as a tag on each DocChunk
 * would be a reasonable future improvement.)
 */
export function parseLlmsTxtLinks(text, baseUrl = DOCS_BASE) {
	const out = [];
	const linkRe = /^- \[([^\]]+)\]\((\/[^)]+\.md)\)/;
	for (const line of text.split('\n')) {
		const m = line.match(linkRe);
		if (!m) continue;
		const [, title, path] = m;
		out.push({ title: title.trim(), url: `${baseUrl}${path}` });
	}
	return out;
}

/**
 * Fetch one doc page's raw markdown. Returns null on 404 / network failure
 * (logged but non-fatal — ingestion continues with the other pages).
 */
export async function fetchMarkdown(url) {
	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn(`[docsIngest] ${url} → HTTP ${res.status}`);
			return null;
		}
		return await res.text();
	} catch (err) {
		console.warn(`[docsIngest] ${url} → ${err.message}`);
		return null;
	}
}

/**
 * Split a markdown document into heading-bounded chunks suitable for embedding.
 *
 * Strategy:
 *   1. Walk lines, tracking the current heading path (H1 > H2 > H3).
 *   2. Start a fresh chunk on every H2/H3 boundary (and at H1, but most pages
 *      have exactly one H1).
 *   3. After splitting, merge adjacent chunks under MIN_CHARS so trivial
 *      "## See also" subsections don't become their own meaningless rows.
 *   4. Hard-split chunks above MAX_CHARS at paragraph boundaries.
 *
 * Each chunk carries its `headingPath` so the LLM can see context like
 * "Configuration > Storage > Compaction" when reading the snippet.
 */
export function chunkMarkdown(md, source) {
	const lines = md.split('\n');
	const stack = []; // [{level, text}] — current heading ancestry
	let pageTitle = source.title;
	const chunks = [];
	let current = newChunk(stack, source);

	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].trim().replace(/\s*\{#[^}]+\}\s*$/, ''); // strip {#anchor}
			if (level === 1 && !pageTitle) pageTitle = text;

			// Drop stack entries at or below this level.
			while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
			stack.push({ level, text });

			// Close out the current chunk on H2/H3 boundaries (H1 too, but rare
			// to have more than one).
			if (level <= 3) {
				if (current.content.trim()) chunks.push(finalize(current));
				current = newChunk(stack, source);
				continue;
			}
			// H4+ headings get inlined into the chunk content rather than starting
			// a new chunk — typical Harper docs use H4 for sub-points.
			current.content += line + '\n';
		} else {
			current.content += line + '\n';
		}
	}
	if (current.content.trim()) chunks.push(finalize(current));

	// Merge tiny adjacent chunks (same parent heading).
	const merged = [];
	for (const ch of chunks) {
		const last = merged[merged.length - 1];
		if (last && last.charCount < MIN_CHARS && ch.headingPath.startsWith(last.headingPath.split(' > ').slice(0, 2).join(' > '))) {
			last.content += '\n\n' + ch.content;
			last.charCount = last.content.length;
			last.headingPath = ch.headingPath; // adopt the deeper path so retrieval sees the most specific breadcrumb
			continue;
		}
		merged.push(ch);
	}

	// Soft-split any oversize chunks at paragraph breaks.
	const out = [];
	for (const ch of merged) {
		if (ch.charCount <= MAX_CHARS) {
			out.push(ch);
			continue;
		}
		out.push(...softSplit(ch));
	}

	// Stamp page title onto every chunk for retrieval-time display.
	for (const ch of out) ch.title = pageTitle ?? source.title;
	return out;
}

function newChunk(stack, source) {
	return {
		sourceUrl: source.url,
		headingPath: stack.map((s) => s.text).join(' > '),
		title: source.title,
		content: '',
	};
}

function finalize(chunk) {
	chunk.content = chunk.content.trim();
	chunk.charCount = chunk.content.length;
	return chunk;
}

function softSplit(chunk) {
	const paras = chunk.content.split(/\n{2,}/);
	const result = [];
	let buf = '';
	for (const p of paras) {
		if ((buf + '\n\n' + p).length > MAX_CHARS && buf) {
			result.push({ ...chunk, content: buf.trim(), charCount: buf.trim().length });
			buf = p;
		} else {
			buf = buf ? buf + '\n\n' + p : p;
		}
	}
	if (buf.trim()) result.push({ ...chunk, content: buf.trim(), charCount: buf.trim().length });
	return result;
}

/**
 * Deterministic ID for a chunk so re-ingestion is idempotent — same URL + same
 * chunk index ⇒ same ID, so we overwrite rather than duplicate.
 *
 * Uses crypto.subtle.digest (built into Node 20+, no extra dep).
 */
async function chunkId(sourceUrl, index) {
	const buf = new TextEncoder().encode(`${sourceUrl}#${index}`);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Embed a chunk and persist. Returns the row that was written. Errors propagate.
 *
 * The embedded text is `headingPath\n\ncontent` — including the breadcrumb in
 * the embed input nudges retrieval toward semantic matches on the heading even
 * when the body wording differs from the user query.
 */
export async function embedAndStore(DocChunk, source, chunk, index, ingestedAt) {
	const id = await chunkId(source.url, index);
	const embedInput = chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.content}` : chunk.content;
	const embedding = await embed(embedInput);
	const row = {
		id,
		sourceUrl: source.url,
		title: chunk.title,
		headingPath: chunk.headingPath,
		content: chunk.content,
		charCount: chunk.charCount,
		embedding,
		ingestedAt,
	};
	await DocChunk.put(row);
	return row;
}

/**
 * Bounded-concurrency map: process `items` with `worker`, no more than
 * `limit` in flight at a time. Returns an array of results in input order;
 * thrown errors are caught and replaced with `{ error }` so one bad page
 * doesn't tank the whole ingestion.
 */
async function mapLimit(items, limit, worker) {
	const results = new Array(items.length);
	let idx = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = idx++;
			if (i >= items.length) return;
			try {
				results[i] = await worker(items[i], i);
			} catch (err) {
				results[i] = { error: err.message ?? String(err) };
			}
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * Top-level orchestrator: full re-ingestion of docs.harperdb.io.
 *
 * Steps:
 *   1. Fetch llms.txt → list of pages
 *   2. Fetch each page's markdown (bounded concurrency)
 *   3. Chunk each page
 *   4. Embed + persist every chunk (bounded concurrency)
 *
 * Returns a summary the resource can store in `IngestRun`.
 *
 * Memory note: we keep all chunks in memory before embedding rather than
 * streaming page-by-page, because the embed step is the time-dominant phase
 * and we want maximum parallelism across the whole corpus. The Harper docs
 * top out at ~150 pages × ~5 chunks each — well under any sane memory limit.
 */
export async function ingestAll({ tables, baseUrl = DOCS_BASE, log = console.log } = {}) {
	const startedAt = new Date().toISOString();
	log(`[docsIngest] starting at ${startedAt}, base=${baseUrl}`);

	const pages = await fetchLlmsTxt(baseUrl);
	log(`[docsIngest] llms.txt → ${pages.length} pages`);

	// Fetch all markdown bodies in parallel.
	const bodies = await mapLimit(pages, FETCH_CONCURRENCY, async (page) => ({
		page,
		md: await fetchMarkdown(page.url),
	}));

	// Chunk every page.
	const work = []; // [{source, chunk, index}]
	for (const { page, md } of bodies) {
		if (!md) continue;
		const chunks = chunkMarkdown(md, page);
		chunks.forEach((c, i) => work.push({ source: page, chunk: c, index: i }));
	}
	log(`[docsIngest] chunked → ${work.length} chunks`);

	// Embed + store. Errors become `{ error }` entries in results.
	let errorCount = 0;
	await mapLimit(work, EMBED_CONCURRENCY, async ({ source, chunk, index }) => {
		try {
			await embedAndStore(tables.DocChunk, source, chunk, index, startedAt);
		} catch (err) {
			errorCount++;
			log(`[docsIngest] embed failed for ${source.url} chunk ${index}: ${err.message}`);
			throw err; // rethrown so mapLimit records the failure
		}
	});

	const finishedAt = new Date().toISOString();
	const summary = {
		startedAt,
		finishedAt,
		pageCount: pages.length,
		chunkCount: work.length,
		errorCount,
	};
	log(`[docsIngest] done in ${(Date.parse(finishedAt) - Date.parse(startedAt)) / 1000}s — ${JSON.stringify(summary)}`);
	return summary;
}
