import { Resource, tables } from 'harperdb';
import { ingestAll } from '../lib/docsIngest.js';

/**
 * POST /DocsIngest — kick off a full re-ingestion of docs.harperdb.io into
 * the DocChunk table. Returns an `IngestRun` row with the summary.
 *
 * Synchronous: the response only returns when ingestion completes (typically
 * 30–120 seconds for the full corpus, depending on embed throughput).
 *
 * Idempotent: each chunk's ID is a hash of (sourceUrl, chunk-index), so
 * re-running the ingest overwrites prior rows rather than duplicating them.
 *
 * Body is optional: `{ baseUrl?: string }` to override the default of
 * https://docs.harperdb.io — useful for testing against a staging docs site.
 */
export class DocsIngest extends Resource {
	static loadAsInstance = false;

	async post(target, data) {
		// Open-by-default for now since these demo apps don't have auth wired up;
		// in production this would gate on `super_user` role. The ingest is
		// idempotent + non-destructive so the worst a stray POST can do is burn
		// some GPU embedding cycles.
		target.checkPermission = false;

		const baseUrl = data?.baseUrl;
		const runId = new Date().toISOString();

		await tables.IngestRun.put({
			id: runId,
			status: 'running',
			startedAt: runId,
			pageCount: 0,
			chunkCount: 0,
			errorCount: 0,
		});

		try {
			const summary = await ingestAll({ tables, baseUrl });
			const row = {
				id: runId,
				status: summary.errorCount === 0 ? 'complete' : 'complete_with_errors',
				...summary,
				notes: `Ingested from ${baseUrl ?? 'https://docs.harperdb.io'}`,
			};
			await tables.IngestRun.put(row);
			return row;
		} catch (err) {
			const row = {
				id: runId,
				status: 'failed',
				startedAt: runId,
				finishedAt: new Date().toISOString(),
				notes: err.message ?? String(err),
			};
			await tables.IngestRun.put(row);
			err.statusCode = 500;
			throw err;
		}
	}

	// GET /DocsIngest — return the most recent IngestRun rows so operators can
	// see when docs were last refreshed without hand-crafting a query.
	async get(target) {
		target.checkPermission = false;
		const runs = tables.IngestRun.search({ conditions: [], limit: 10 });
		const out = [];
		for await (const run of runs) out.push(run);
		out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
		return { runs: out };
	}
}
