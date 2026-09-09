import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';
import { createFireplaceActions } from '../chart/fireplace.js';

async function fixture(t, { input = 'providers' } = {}) {
  const store = new Store(':memory:');
  let now = Date.parse('2026-09-09T12:00:00Z');
  const config = { input, settings: validateSettings() };
  const engine = new Engine({ store, config, clock: () => now });
  const token = 'synthetic-fireplace-api-access-token';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await engine.closeFireplace();
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { headers, ...options });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const post = (payload, { path = '/api/fireplace', ...options } = {}) => call(path,
    { method: 'POST', body: JSON.stringify(payload), ...options });
  const count = () => store.db.prepare('SELECT COUNT(*) n FROM fireplace_events').get().n;
  return { store, engine, base, headers, call, post, count, advance: ms => { now += ms; } };
}

test('fireplace HTTP routes require authentication and same-origin JSON before recording anything', async t => {
  const { base, headers, call, post, count } = await fixture(t);
  const payload = { requestId: 'invented-auth-load', kg: 8 };
  assert.equal((await call('/api/fireplace', { headers: {} })).status, 401);
  assert.equal((await post(payload, { headers: {} })).status, 401);
  assert.equal((await post({ requestId: 'invented-remove', id: 1 }, { path: '/api/fireplace/remove', headers: {} })).status, 401);
  assert.equal((await post(payload, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await post({ requestId: 'invented-remove', id: 1 },
    { path: '/api/fireplace/remove', headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await post(payload, { headers: { Authorization: headers.Authorization } })).status, 400);
  assert.equal((await post(payload, { body: '{invalid' })).status, 400);
  assert.equal(count(), 0);
  const success = await post(payload, { headers: { ...headers, Origin: base } });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.equal(success.body.entries[0].kg, 8);
  assert.equal(count(), 1);
});

test('fireplace API validates whole kilograms, server timestamps, request identities and load IDs', async t => {
  const { post, count } = await fixture(t);
  for (const payload of [null, [], {}, { requestId: 'invented', kg: '8' }, { requestId: 'invented', kg: 1 },
    { requestId: 'invented', kg: 11 }, { requestId: 'invented', kg: 2.5 }, { requestId: '', kg: 8 },
    { requestId: 'bad identity', kg: 8 }, { requestId: 'invented', kg: 8, at: 0 },
    { requestId: 'invented', kg: 8, input: 'simulated' }]) {
    assert.equal((await post(payload)).status, 400);
  }
  for (const payload of [{ requestId: 'invented-remove', id: 0 }, { requestId: 'invented-remove', id: '1' },
    { requestId: 'invented-remove', id: 1.5 }, { requestId: 'invented-remove', id: 123 }]) {
    assert.equal((await post(payload, { path: '/api/fireplace/remove' })).status, 400);
  }
  assert.equal(count(), 0);
});

test('real HTTP retries are idempotent, new same-time additions remain distinct and removals retain original entries', async t => {
  const { post, call, count, engine, advance } = await fixture(t);
  const first = await post({ requestId: 'invented-load-one', kg: 2 });
  const second = await post({ requestId: 'invented-load-two', kg: 10 });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(second.body.entries.length, 2);
  assert.notEqual(first.body.entries[0].id, second.body.entries[0].id);
  assert.equal(first.body.entries[0].at, engine.clock());
  assert.equal(second.body.entries[0].at, engine.clock());
  advance(1_000);
  const retry = await post({ requestId: 'invented-load-one', kg: 2 });
  assert.equal(retry.status, 200); assert.equal(count(), 2);
  assert.deepEqual(retry.body.entries, second.body.entries);
  assert.equal((await post({ requestId: 'invented-load-one', kg: 8 })).status, 409);
  const removal = { requestId: 'invented-removal', id: second.body.entries[0].id };
  const removed = await post(removal, { path: '/api/fireplace/remove' });
  assert.equal(removed.status, 200); assert.equal(removed.body.entries.length, 2);
  assert.equal(removed.body.entries[0].removedAt, engine.clock());
  assert.equal(removed.body.entries[1].removedAt, null);
  assert.equal(removed.body.lastAt, first.body.entries[0].at);
  assert.equal(removed.body.rebuild.status, 'idle');
  advance(1_000);
  const repeatedRemoval = await post(removal, { path: '/api/fireplace/remove' });
  assert.equal(repeatedRemoval.status, 200);
  assert.deepEqual(repeatedRemoval.body.entries, removed.body.entries);
  assert.equal(count(), 3, 'one load per intentional addition and one correction, regardless of retry count');
  const status = await call('/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.fireplace.entries, removed.body.entries);
});

test('a failure after source commit returns 503 and the UI retries the original request without duplicating wood', async t => {
  const { engine, call, count } = await fixture(t);
  let fail = true, identifier = 0;
  engine.onTemporaryChange = () => { if (fail) throw new Error('invented-internal-failure-details'); };
  const attempts = [];
  const actions = createFireplaceActions({ makeRequestId: () => `invented-id-${++identifier}`, request: async (path, body) => {
    const response = await call(path, { method: 'POST', body: JSON.stringify(body) });
    attempts.push({ path, body, status: response.status });
    if (response.status !== 200) throw Object.assign(new Error(response.body.error), { status: response.status });
    return response.body;
  } });
  actions.update((await call('/api/fireplace')).body);
  assert.equal(await actions.add(8), false);
  assert.equal(attempts[0].status, 503);
  assert.equal(count(), 1, 'the source row is already durable even though follow-up failed');
  assert.equal(actions.snapshot().pending.body.requestId, 'invented-id-1');
  assert.match(actions.snapshot().message, /without adding a duplicate/);
  assert(!JSON.stringify(actions.snapshot()).includes('invented-internal-failure-details'));
  fail = false;
  assert.equal(await actions.retry(), true);
  assert.equal(attempts[1].status, 200);
  assert.deepEqual(attempts[1].body, attempts[0].body);
  assert.equal(count(), 1);
  assert.equal(actions.snapshot().view.entries[0].kg, 8);
  assert.equal(actions.snapshot().pending, null);
});

test('a post-commit removal failure remains retryable and does not append the same correction twice', async t => {
  const { engine, call, post, count } = await fixture(t);
  const added = await post({ requestId: 'invented-load', kg: 8 });
  const removal = { requestId: 'invented-removal', id: added.body.entries[0].id };
  engine.onTemporaryChange = () => { throw new Error('invented-internal-removal-failure'); };
  const failed = await post(removal, { path: '/api/fireplace/remove' });
  assert.equal(failed.status, 503);
  assert(!failed.body.error.includes('invented-internal'));
  assert.equal(count(), 2);
  assert.notEqual((await call('/api/fireplace')).body.entries[0].removedAt, null);
  engine.onTemporaryChange = undefined;
  assert.equal((await post(removal, { path: '/api/fireplace/remove' })).status, 200);
  assert.equal(count(), 2);
});

test('public rebuild status stays updating until activation and reports completion as idle', async t => {
  const { store, call } = await fixture(t);
  for (const [internal, expected] of [['pending', 'pending'], ['running', 'running'], ['ready', 'running'],
    ['current', 'idle'], ['failed', 'failed']]) {
    store.setState('fireplace:rebuild:providers', { status: internal, revision: 0, requiresRebuild: internal !== 'current' });
    const response = await call('/api/fireplace');
    assert.equal(response.status, 200);
    assert.equal(response.body.rebuild.status, expected);
    assert.equal(response.body.requiresRebuild, internal !== 'current');
  }
});

test('offline history advertises unavailable recording and cannot create a fireplace event', async t => {
  const { call, post, count } = await fixture(t, { input: 'offline' });
  const response = await call('/api/fireplace');
  assert.equal(response.status, 200); assert.equal(response.body.available, false);
  assert.equal((await post({ requestId: 'invented-load', kg: 8 })).status, 400);
  assert.equal(count(), 0);
});
