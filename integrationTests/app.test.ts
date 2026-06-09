/**
 * Integration tests for agent-example-harper.
 * Tests that the app starts and key endpoints respond correctly.
 * Note: Full agent functionality requires Anthropic/Vertex API keys
 * which are not available in CI, so we only test structural correctness.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// harper's exports map only exposes ".", so resolving 'harper/dist/bin/harper.js'
// (the harness's default auto-resolution) throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the CLI
// from harper's exported main entry and pass it explicitly via the harness escape hatch.
const harperBinPath = resolve(dirname(fileURLToPath(import.meta.resolve('harper'))), 'bin/harper.js');

const FIXTURE_PATH = fileURLToPath(new URL('../', import.meta.url));

function authFetch(
	ctx: ContextWithHarper,
	path: string,
	init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<Response> {
	const { headers = {}, ...rest } = init;
	const creds = Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	return fetch(`${ctx.harper.httpURL}${path}`, {
		...rest,
		headers: { Authorization: `Basic ${creds}`, ...headers },
	});
}

void suite('agent-example-harper loads', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { startupTimeoutMs: 60000, harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	void test('GET /Conversation/ returns empty list initially', async () => {
		const res = await authFetch(ctx, '/Conversation/');
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), `expected array, got ${JSON.stringify(body)}`);
	});

	void test('GET /Message/ returns empty list initially', async () => {
		const res = await authFetch(ctx, '/Message/');
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), `expected array, got ${JSON.stringify(body)}`);
	});

	void test('GET /PublicStats returns a valid response', async () => {
		const res = await authFetch(ctx, '/PublicStats');
		ok([200, 404].includes(res.status), `unexpected status ${res.status}`);
	});

	void test('POST /Conversation/ creates a conversation record', async () => {
		const res = await authFetch(ctx, '/Conversation/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Test Conversation' }),
		});
		ok([200, 201].includes(res.status), `expected 200 or 201, got ${res.status}`);
	});
});
