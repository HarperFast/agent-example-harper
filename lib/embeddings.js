import { models } from 'harper';

// `models.embed()` (harper#510) dispatches to whatever embedding backend the host
// has configured — Ollama on Fabric GPU hosts, or any backend named in the
// `models:` block of harperdb-config.yaml. Returns a plain Array<number> because
// Harper's HNSW index stores arrays, not the Float32Array the API returns.

export async function embed(text) {
	const [vector] = await models.embed(text);
	return Array.from(vector);
}
