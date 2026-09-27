import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';

const writes = ['/api/settings/reload', '/api/charging/ocpp-setup', '/api/charging/settings',
  ...['settings', 'control', 'resume', 'charge-now', 'identify'].map(action => `/api/charging/chargers/charger1/${action}`),
  ...['release', 'temporary', 'heating', 'native'].map(action => `/api/garage/${action}`),
  ...['recheck', 'switch', 'cover', 'dehumidifier', 'h66', 'test', 'test/restore'].map(action => `/api/equipment/${action}`),
  '/api/fireplace', '/api/fireplace/remove', '/api/sensor-changes', '/api/sensor-changes/revert',
  '/api/sensor-changes/retry-rebuild', '/api/dhwr/stop', '/api/temporary', '/api/database-export',
  '/api/test/h66', '/api/heating-test', '/api/override', '/api/settings', '/api/contract'];

async function fixture(t, { role = 'primary', pairContext, controlAuthority } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-readonly-gate-'));
  const store = new Store(':memory:'); store.setState('synthetic-history', { retained: true });
  let mutations = 0;
  const fireplace = { available: true, entries: [{ id: 'synthetic', at: Date.now(), removedAt: null }] };
  const engine = new Proxy({ status: () => ({ now: Date.now(), input: 'mqtt', liveWrites: true, fireplace }),
    fireplaceStatus: () => fireplace, clock: Date.now }, {
    get(target, key) { return key in target ? target[key] : () => { mutations++; throw Error('Mutation dispatched'); }; },
  });
  const server = createAppServer({ store, engine, role, pairContext, controlAuthority,
    chartService: { overview: async () => ({ available: true }) }, getDatabaseExportDirectory: () => root,
    reloadSettings: async () => { mutations++; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, url: `http://127.0.0.1:${server.address().port}`, mutations: () => mutations };
}

for (const kind of ['replica', 'protected', 'stopped']) test(`${kind} keeps read access and rejects every dashboard write without changing history`, async t => {
  const authority = { canControl: () => false, status: () => ({ role: 'protected' }), recovering: () => false };
  const f = await fixture(t, kind === 'replica' ? { role: 'replica' }
    : kind === 'protected' ? { pairContext: authority } : { controlAuthority: authority });
  const before = f.store.db.prepare('SELECT total_changes() n').get().n;
  for (const path of writes) {
    const response = await fetch(`${f.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, kind === 'replica' ? 405 : 409, path);
    assert.match((await response.json()).error, /read-only/);
  }
  const status = await (await fetch(`${f.url}/api/status`)).json();
  assert.equal(status.fireplace.readOnly, true);
  assert.equal(status.fireplace.entries[0].canRemove, false);
  const readFireplace = await (await fetch(`${f.url}/api/fireplace`)).json();
  assert.equal(readFireplace.available, false);
  assert.equal(readFireplace.entries[0].canRemove, false);
  const download = await fetch(`${f.url}/api/database-export`);
  assert.equal(download.status, 200); assert.ok((await download.arrayBuffer()).byteLength > 0);
  assert.equal(f.mutations(), 0);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(await readdir(f.root), [], 'No server-side database copy is created');
});

test('authority lost during a slow request body prevents a settings write', async t => {
  let allowed = true;
  const f = await fixture(t, { pairContext: { canControl: () => allowed, recovering: () => false, status: () => ({}) } });
  const response = new Promise((resolve, reject) => {
    const req = request(`${f.url}/api/settings/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.write('{');
    setTimeout(() => { allowed = false; req.end('}'); }, 30);
  });
  assert.equal(await response, 409); assert.equal(f.mutations(), 0);
});

test('authority lost while preparing a server-side copy prevents its publication', async t => {
  let allowed = true;
  const f = await fixture(t, { pairContext: { canControl: () => allowed, recovering: () => false, status: () => ({}) } });
  const backup = f.store.backup.bind(f.store);
  f.store.backup = async path => { await backup(path); allowed = false; };
  const response = await fetch(`${f.url}/api/database-export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 409);
  for (let i = 0; i < 100 && (await readdir(f.root)).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await readdir(f.root), []);
});
