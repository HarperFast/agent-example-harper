import { models } from 'harper';

// `models.embed()` (harper#510) dispatches to the host's configured embedding backend.
// Harper's HNSW index stores arrays, so the returned Float32Array is converted.

export async function embed(text) {
	const [vector] = await models.embed(text);
	return Array.from(vector);
}
