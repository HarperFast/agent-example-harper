// Thin wrapper around `scope.models.embed()` (harper#510). The host's
// configured backend (Ollama on Fabric GPU hosts, or any backend configured
// via the `models:` block in harperdb-config.yaml / env vars) handles the
// actual inference. Returns a plain Array<number> for compatibility with
// Harper's HNSW vector index storage.

export async function embed(text) {
	const scope = globalThis.harperScope;
	if (!scope) {
		throw new Error('Harper scope not yet captured — modelCapture plugin must run before first embed call');
	}
	const [vector] = await scope.models.embed(text);
	return Array.from(vector);
}
