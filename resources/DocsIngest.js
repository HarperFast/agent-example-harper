import { Resource, tables } from 'harperdb';
import { ingestAll } from '../lib/docsIngest.js';

/**
 * POST /DocsIngest — kick off a full re-ingestion of docs.harperdb.io into
 * the DocChunk table. Returns immediately with the run ID; the actual work
 * runs in the background.
 *
 * Why async: full ingest of the ~370-page corpus takes 30–120s, often longer
 * than the upstream HTTP proxy's idle timeout (nginx/symphony will close the
 * connection well before the embed pipeline finishes). Detaching the work
 * from the request lifecycle is the only reliable shape — `GET /DocsIngest`
 * returns the latest IngestRun rows for status checking.
 *
 * Idempotent: each chunk's ID is a hash of (sourceUrl, chunk-index), so
 * re-running the ingest overwrites prior rows rather than duplicating them.
 *
 * Body is optional: `{ baseUrl?: string }` to override the default of
 * https://docs.harperdb.io — useful for testing against a staging docs site.
 *
 * Response: 202 with `{ id, status: "running" }`. Poll `GET /DocsIngest`
 * for the same `id` to watch it move through `running → complete` or
 * `complete_with_errors / failed`.
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

		// Fire-and-forget. `void` makes the floating-promise lint-clean and
		// signals the intent: the response should return as soon as the run
		// is recorded, not wait for embedding to finish.
		void runIngestAndRecord(runId, baseUrl);

		// 202 Accepted — work is in progress, client polls GET /DocsIngest.
		target.statusCode = 202;
		return {
			id: runId,
			status: 'running',
			startedAt: runId,
			poll: '/DocsIngest',
		};
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

/**
 * Background ingestion runner. Wraps the orchestrator with status-row updates
 * + error handling. Caught errors land in the IngestRun row (status: failed)
 * so the operator can see why an ingest stopped without dredging hdb.log.
 *
 * `tables` is captured at module-import time and is safe to use here — Harper
 * keeps it valid for the lifetime of the component process.
 */
async function runIngestAndRecord(runId, baseUrl) {
	try {
		const summary = await ingestAll({ tables, baseUrl });
		await tables.IngestRun.put({
			id: runId,
			status: summary.errorCount === 0 ? 'complete' : 'complete_with_errors',
			...summary,
			notes: `Ingested from ${baseUrl ?? 'https://docs.harperdb.io'}`,
		});
	} catch (err) {
		console.error('[DocsIngest] background run failed:', err.stack ?? err);
		await tables.IngestRun.put({
			id: runId,
			status: 'failed',
			startedAt: runId,
			finishedAt: new Date().toISOString(),
			notes: err.message ?? String(err),
		});
	}
}
