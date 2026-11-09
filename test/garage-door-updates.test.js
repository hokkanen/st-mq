import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { waitForDoorUpdate } from '../src/app/door-watch.js';
import { mergeDoorUpdate, retainNewerDoors, createGarageDoorWatch } from '../chart/garage-door-updates.js';

const projection = (revision, value = 0) => ({ input: 'providers', now: 1000 + revision,
  equipment: { doorRevision: { generation: 'fixture-generation', revision }, devices: [
    { id: 'fixture-door', kind: 'door', readings: { fixture_open: { value } } },
  ] } });
function sourceFixture() {
  let view = projection(1), closed = false;
  const listeners = new Set();
  return { listeners, status: () => view.equipment,
    subscribeDoors(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    advance(revision = 2) { view = projection(revision, 1); for (const fn of [...listeners]) fn(); },
    current: () => !closed, close() { closed = true; } };
}

test('door update merge preserves other equipment and rejects older full status and action replies', () => {
  const initial = projection(1);
  initial.equipment.devices.push({ id: 'fixture-pump', kind: 'switch' });
  initial.draft = 'unsaved';
  const updated = mergeDoorUpdate(initial, projection(3, 1));
  assert.equal(updated.draft, 'unsaved'); assert.equal(updated.equipment.devices[0].id, 'fixture-pump');
  assert.equal(updated.equipment.devices[1].readings.fixture_open.value, 1);
  assert.equal(mergeDoorUpdate(updated, projection(2)), updated);
  assert.deepEqual(retainNewerDoors(projection(2), updated, initial).equipment.devices, updated.equipment.devices.filter(d => d.kind === 'door'));
  assert.equal(retainNewerDoors(projection(2), updated, initial).equipment.doorRevision.revision, 3);
  const replacement = projection(1, 1); replacement.equipment.doorRevision.generation = 'fixture-replacement';
  assert.deepEqual(retainNewerDoors(initial, replacement, initial).equipment.doorRevision, replacement.equipment.doorRevision);
  assert.equal(retainNewerDoors(replacement, updated, initial), replacement, 'A fresh generation can replace an older one');
});

test('held door reads wake on events, retain renewals, time out cheaply and release cancelled listeners', async () => {
  const source = sourceFixture(), revision = JSON.stringify(source.status().doorRevision);
  const waiting = waitForDoorUpdate({ source, revision, current: source.current });
  source.advance();
  const update = await waiting;
  assert.equal(update.equipment.devices[0].readings.fixture_open.value, 1);
  assert.equal(source.listeners.size, 0);
  source.advance(3);
  assert.ok((await waitForDoorUpdate({ source, revision: update.revision, current: source.current })).equipment,
    'A change between request renewals returns immediately');
  const idle = await waitForDoorUpdate({ source, revision: JSON.stringify(source.status().doorRevision), current: source.current, timeoutMs: 5 });
  assert.equal(idle.equipment, undefined);
  const cancellation = new AbortController();
  const aborted = waitForDoorUpdate({ source, revision: idle.revision, current: source.current, signal: cancellation.signal });
  cancellation.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(source.listeners.size, 0);
  const revoked = waitForDoorUpdate({ source, revision: idle.revision, current: source.current, timeoutMs: 5 });
  source.close(); await assert.rejects(revoked, { statusCode: 409 });
  assert.equal(source.listeners.size, 0);
});

test('real HTTP door watch enforces authentication and family access without acquiring a history lease', async t => {
  const store = new Store(':memory:'), source = sourceFixture();
  let allowed = { enabled: true, token: 'fixture-admin', familyToken: 'fixture-family' }, writable = true;
  const engine = { config: { input: 'providers' }, clock: () => 1002, equipment: source };
  const server = createAppServer({ engine, store, getAccess: () => allowed, controlAuthority: { canControl: () => writable },
    getReadContext: () => { throw new Error('Door watches must not hold a history lease'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/garage/doors/watch`;
  const get = (token, suffix = '', signal) => fetch(url + suffix, { headers: { authorization: `Bearer ${token}` }, signal });
  assert.equal((await get('fixture-wrong')).status, 401);
  const initial = await get('fixture-family').then(r => r.json());
  assert.equal(initial.equipment.devices[0].kind, 'door');
  const pending = get('fixture-family', `?revision=${encodeURIComponent(initial.revision)}`);
  while (!source.listeners.size) await new Promise(resolve => setImmediate(resolve));
  source.advance();
  assert.equal((await pending).status, 200);
  assert.equal((await get('fixture-admin', '?unsupported=1')).status, 400);
  const held = get('fixture-admin', `?revision=${encodeURIComponent(JSON.stringify(source.status().doorRevision))}`);
  while (!source.listeners.size) await new Promise(resolve => setImmediate(resolve));
  allowed = { ...allowed, token: 'fixture-rotated' };
  assert.equal((await held).status, 401, 'Access is rechecked before releasing an awaited response');
  writable = false;
  assert.equal((await get('fixture-rotated')).status, 409);
  assert.equal(source.listeners.size, 0);
});

test('browser watcher renews idle reads without rendering, backs off and cancels on hiding or logout', async () => {
  let enabled = true, release, signal;
  const timers = [], updates = [], calls = [];
  const watch = createGarageDoorWatch({ enabled: () => enabled,
    request: (path, _, options) => { calls.push(path); signal = options.signal; return new Promise(resolve => { release = resolve; }); },
    onUpdate: update => updates.push(update), setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: () => {} });
  watch.update(); watch.update(); assert.equal(calls.length, 1);
  release({ revision: 'fixture-one', ...projection(1) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1); timers.at(-1).fn();
  assert.match(calls.at(-1), /revision=fixture-one/);
  release({ revision: 'fixture-one' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1, 'Idle timeout never refreshes dashboard content');
  timers.at(-1).fn(); enabled = false; watch.update();
  assert.equal(signal.aborted, true);
  release({ revision: 'fixture-late', ...projection(9) }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1, 'A cancelled response cannot restore signed-out data');
});

test('failed door watches back off to a bounded interval without fabricating updates', async () => {
  const timers = [], updates = [];
  const watch = createGarageDoorWatch({ enabled: () => true, request: async () => { throw new Error('Synthetic outage'); },
    onUpdate: value => updates.push(value), setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: () => {} });
  watch.update();
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setImmediate(resolve)); timers.at(-1).fn();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.map(t => t.delay), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.deepEqual(updates, []); watch.stop();
});
