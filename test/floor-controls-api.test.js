import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { Store } from '../src/storage/store.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const command = { channel: 2, enabled: true, durationSeconds: 900,
  requestId: 'manual-circuit-two', scope: 'current-connection-scope' };

function fixture(overrides = {}) {
  const calls = [];
  const engine = { config: { input: 'mqtt' }, clock: () => NOW, canControl: () => true,
    floorOverride: { manual: async input => calls.push(input) },
    status: () => ({ now: NOW, preheatValves: { mode: 'manual' } }), ...overrides };
  engine.controlFloor = input => Engine.prototype.controlFloor.call(engine, input);
  return { engine, calls };
}

test('individual floor controls pass their original bounded scope to the adapter', async () => {
  const f = fixture();
  assert.deepEqual(await f.engine.controlFloor(command), f.engine.status());
  assert.deepEqual(f.calls, [{ ...command, now: NOW }]);
  await f.engine.controlFloor({ ...command, enabled: false });
  assert.equal(f.calls[1].enabled, false);
});

test('floor API rejects malformed, unbounded and retired command shapes before dispatch', async () => {
  const f = fixture();
  const invalid = [null, [], {}, { ...command, channel: 0 }, { ...command, channel: 5 },
    { ...command, channel: '2' }, { ...command, enabled: 1 },
    { ...command, durationSeconds: 901 }, { ...command, durationSeconds: 0 }, { ...command, durationSeconds: 59 },
    { ...command, durationSeconds: 1.5 }, { ...command, requestId: '' },
    { ...command, requestId: 'retired/request' }, { ...command, scope: '' },
    { ...command, deviceId: 'retired-device' }, { ...command, until: NOW + 900_000 },
    ...Object.keys(command).map(key => Object.fromEntries(Object.entries(command).filter(([field]) => field !== key)))];
  for (const input of invalid) await assert.rejects(f.engine.controlFloor(input), TypeError);
  assert.deepEqual(f.calls, []);
});

test('floor control cannot actuate from simulation, history, or lost master authority', async () => {
  for (const overrides of [{ config: { input: 'simulated' } }, { config: { input: 'offline' } },
    { canControl: () => false }, { floorOverride: null }]) {
    const f = fixture(overrides);
    await assert.rejects(f.engine.controlFloor(command), error => error.statusCode === 409);
    assert.deepEqual(f.calls, []);
  }
});

test('HTTP floor controls retain admin equipment permissions and never dispatch from standby', async t => {
  const store = new Store(':memory:');
  const f = fixture();
  let authority = true;
  const server = createAppServer({ store, engine: f.engine,
    token: 'synthetic-floor-admin-password', familyToken: 'synthetic-floor-family-password',
    controlAuthority: { canControl: () => authority, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const post = token => fetch(`http://127.0.0.1:${server.address().port}/api/equipment/floor`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  });
  let response = await post('synthetic-floor-family-password');
  assert.equal(response.status, 403); await response.json();
  assert.deepEqual(f.calls, []);
  response = await post('synthetic-floor-admin-password');
  assert.equal(response.status, 200); await response.json();
  assert.equal(f.calls.length, 1);
  f.engine.floorOverride.manual = async () => { throw Object.assign(new Error('synthetic-sensitive-native-payload'), { code: 'FLOOR_UNCONFIRMED' }); };
  response = await post('synthetic-floor-admin-password');
  assert.equal(response.status, 409);
  const rejected = await response.json();
  assert.equal(rejected.code, 'FLOOR_UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(rejected), /synthetic-sensitive/);
  f.engine.floorOverride.manual = async () => { throw new Error('synthetic-sensitive-transport-detail'); };
  response = await post('synthetic-floor-admin-password');
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /synthetic-sensitive/);
  authority = false;
  response = await post('synthetic-floor-admin-password');
  assert.equal(response.status, 409); await response.json();
  assert.equal(f.calls.length, 1);
});

test('manual masks never become a pooled learning treatment and stale output stays unknown', () => {
  const floor = { enabled: true, active: false, mode: 'manual', restorationPending: false,
    devices: [{ available: true, channels: [1, 2, 3, 4].map(id => ({ id, output: true })) }] };
  const engine = { clock: () => NOW, preheatValveStatus: () => floor };
  assert.equal(Engine.prototype.floorOverrideMode.call(engine), 'partial');
  floor.active = true;
  assert.equal(Engine.prototype.floorOverrideMode.call(engine), 'partial');
  floor.active = false;
  floor.devices[0].available = false;
  assert.equal(Engine.prototype.floorOverrideMode.call(engine), 'unknown');
});
