import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';

async function fixture(t, options = {}) {
  const store = new Store(':memory:'), actions = [];
  const modelReconstruction = {
    async status() { return { state: 'idle', job: null, storage: { bytes: 0, disposable: true } }; },
    async action(input) { actions.push(input); return { state: 'idle' }; },
    ...options.service,
  };
  const server = createAppServer({ store, chartService: { overview() {} }, modelReconstruction,
    // Reconstruction requests must work without opening an engine or mutating
    // the replicated database, including when no usable slave snapshot exists.
    getEngine() { throw new Error('The reconstruction route acquired controller state'); },
    token: 'synthetic-admin-model-reconstruction-access', familyToken: 'synthetic-family-model-reconstruction-access',
    ...options.server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path = '', { role = 'admin', method = 'GET', body, headers = {} } = {}) => fetch(`${base}/api/model-reconstruction${path}`, {
    method, headers: { ...(role ? { Authorization: `Bearer synthetic-${role}-model-reconstruction-access` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { store, actions, request };
}

test('authenticated users may read reconstruction status; only administrators manage local jobs', async t => {
  const { request, actions } = await fixture(t);
  assert.equal((await request('', { role: null })).status, 401);
  assert.equal((await request('', { role: 'family' })).status, 200);
  assert.equal((await request('', { role: 'family' }).then(response => response.json())).canManage, false);
  assert.equal((await request()).status, 200);
  assert.equal((await request().then(response => response.json())).canManage, true);
  assert.equal((await request('/action', { role: 'family', method: 'POST', body: { action: 'verify' } })).status, 403);
  assert.deepEqual(actions, []);
  assert.equal((await request('/action', { method: 'POST', body: { action: 'verify' } })).status, 202);
  assert.deepEqual(actions, [{ action: 'verify' }]);
});

test('slave administrators manage only the local verification progress without a snapshot or control authority', async t => {
  const { request, actions, store } = await fixture(t, { server: { role: 'slave',
    getReadContext() { throw new Error('The reconstruction route pinned a replica generation'); },
    controlAuthority: { canControl: () => false } } });
  const before = store.checkpoint();
  for (const action of ['verify', 'pause', 'resume', 'cancel', 'discard'])
    assert.equal((await request('/action', { method: 'POST', body: { action } })).status, 202, action);
  assert.equal((await request()).status, 200);
  assert.equal(actions.length, 5);
  assert.deepEqual(store.checkpoint(), before, 'Local maintenance grants no replicated write authority');
});

test('reconstruction actions retain same-origin and configuration-transition fences', async t => {
  let busy = false;
  const { request, actions } = await fixture(t, { server: { settingsReloadStatus: () => ({ busy }) } });
  assert.equal((await request('/action', { method: 'POST', body: { action: 'verify' },
    headers: { Origin: 'https://untrusted.example' } })).status, 403);
  busy = true;
  assert.equal((await request('/action', { method: 'POST', body: { action: 'verify' } })).status, 503);
  assert.deepEqual(actions, []);
  assert.equal((await request()).status, 200, 'Status remains available during configuration work');
  assert.equal((await request('?input=mqtt')).status, 400);
});

test('reconstruction failures do not expose local filenames or raw database errors', async t => {
  const privateMarker = '/private/invented/source-database.sqlite';
  const { request } = await fixture(t, { service: { async action() { throw new Error(`SQLITE_CORRUPT ${privateMarker}`); } } });
  const response = await request('/action', { method: 'POST', body: { action: 'verify' } });
  assert.equal(response.status, 503);
  assert(!JSON.stringify(await response.json()).includes(privateMarker));
});
