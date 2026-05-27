// Thin wrapper around `scope.models.embed()` (harper#510). The host's
// configured backend (Ollama on Fabric GPU hosts, or any backend configured
// via the `models:` block in harperdb-config.yaml / env vars) handles the
// actual inference. Returns a plain Array<number> for compatibility with
// Harper's HNSW vector index storage.
//
// `opts.detachFromRequest` — when true, passes a never-aborting AbortSignal
// so the embed call doesn't get killed if the originating HTTP request goes
// away (e.g. a proxy timeout fires before a long-running ingestion finishes).
// scope.models.embed() picks up `ctx.signal` from the ALS-bound request
// Context by default; an explicit `opts.signal` wins over it.

const NEVER_ABORT = new AbortController().signal;

export async function embed(text, opts = {}) {
	const scope = globalThis.harperScope;
	if (!scope) {
		throw new Error('Harper scope not yet captured — modelCapture plugin must run before first embed call');
	}
	const embedOpts = opts.detachFromRequest ? { signal: NEVER_ABORT } : undefined;
	const [vector] = await scope.models.embed(text, embedOpts);
	return Array.from(vector);
}
