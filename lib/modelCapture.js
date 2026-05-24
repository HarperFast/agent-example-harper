// Plugin entry — captures the Scope object so `resources/*.js` can call
// `scope.models.embed()` against the host's configured embedding backend.
//
// Harper's `scope` is passed to plugins via `handleApplication(scope)` but
// isn't exposed as a global to Resource classes. This tiny plugin stashes the
// Scope on `globalThis.harperScope` at app boot, then `lib/embeddings.js`
// reads it from there.

export function handleApplication(scope) {
	globalThis.harperScope = scope;
}
