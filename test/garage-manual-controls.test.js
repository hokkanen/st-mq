import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { createGarageAdapter, createGarageSimulationTransport } from '../src/garage/adapter.js';
import { createAppServer } from '../src/app/server.js';

const BASE = 1_800_000_000_000, MINUTE = 60_000;
const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, { live = false, approved = true } = {}) {
  let now = BASE, sequence = 0, owner = true;
  const store = new Store(':memory:');
  const config = { input: 'mqtt', garage: { enabled: true, savingsStrategy: 'gentle', minOnMs: 0,
    protection: { approved }, adapter: { stateTopic: 'fixture/garage/state' } } };
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'active' } };
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now, canControl: () => owner });
  const commands = [];
  const adapter = createGarageAdapter({ settings: config.garage.adapter, clock: () => now, hostSession: 'fixture-host',
    canControl: () => owner, onState: value => runtime.adapterChanged(value),
    ...(live ? {} : { simulationTransport: createGarageSimulationTransport(async command => { commands.push(command); }) }) });
  runtime.setAdapter(adapter);
  runtime.exposure = knownGarageReserve(runtime.settings, { at: BASE });
  function temperatures(rear = 9, front = 8) {
    for (const [signal, value] of [['garage_temperature', rear], ['garage_temperature_2', front], ['outdoor_temperature', 0]])
      engine.latest[signal] = { value, sourceTime: now, receivedAt: now, quality: [], source: 'fixture-temperature', device: signal };
  }
  function state(command = null, patch = {}) {
    const value = structuredClone(TEMPLATE);
    value.sequence = ++sequence; value.observedAt = now; value.baseline.measuredAt = now;
    value.native.power.measuredAt = now;
    for (const field of Object.values(value.health)) field.measuredAt = now;
    value.challenge = { value: `manual-fixture-challenge-${sequence}`, expiresAt: now + 30_000 };
    if (command) Object.assign(value, {
      native: { power: { value: command.action === 'release' ? 'on' : 'off', measuredAt: now } },
      restorationPending: command.action !== 'release',
      lease: command.action === 'release' ? null : { episodeId: command.episodeId,
        endpointAt: command.endpointAt, expiresAt: command.requestedExpiryAt },
      result: { commandId: command.commandId, episodeId: command.episodeId, sequence: command.sequence,
        action: command.action, status: 'native-confirmed' },
    });
    adapter.receive('fixture/garage/state', JSON.stringify({ ...value, ...patch }), {}, now);
  }
  temperatures(); adapter.setConnected(true); state();
  t.after(async () => { await runtime.close({ restore: false }); await adapter.close({ restore: false }); store.close(); });
  return { runtime, adapter, store, engine, config, commands, temperatures, state,
    at(value) { now = value; }, now: () => now, owner(value) { owner = value; },
    async tick() { runtime.tick({ now }); await runtime.dispatch; await flush(); } };
}

test('garage pause selects Normal; manual Off uses bounded renewed leases without economic training', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 30 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'normal' });
  assert.equal(f.runtime.status().heatingControls.manualChanged, false);
  assert.equal(f.runtime.status().heatingControls.warning, null);
  await f.runtime.setHeating({ mode: 'off' });
  const first = f.commands.at(-1);
  assert.equal(first.action, 'start');
  assert.equal(first.endpointAt, BASE + 30 * MINUTE);
  assert.equal(first.requestedExpiryAt, BASE + 3 * MINUTE);
  assert.equal(f.runtime.episode, null, 'manual selection must not create an economic savings assessment');
  for (let minute = 1; minute <= 5; minute++) {
    f.at(BASE + minute * MINUTE); f.temperatures(); f.state(f.commands.at(-1)); await f.tick();
  }
  const renewal = f.commands.at(-1);
  assert.equal(renewal.action, 'renew');
  assert.equal(renewal.episodeId, first.episodeId);
  assert.equal(renewal.endpointAt, first.endpointAt);
  const controls = f.runtime.status().heatingControls;
  assert.equal(controls.selectedMode, 'off'); assert.equal(controls.confirmed, true);
  assert.equal(controls.manualChanged, true); assert.match(controls.warning, /paused/);
});

test('unpaused garage manual Off restores at the next controller update', async t => {
  const f = setup(t);
  await f.runtime.setHeating({ mode: 'off' });
  assert.equal(f.commands[0].requestedExpiryAt, BASE + MINUTE);
  f.at(BASE + 1000); f.temperatures(); f.state(f.commands[0]); await f.tick();
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().heatingControls.holdUntil, null);
  assert.equal(f.store.getState(f.runtime.keys.manual), null);
});

test('resetting and ending a garage pause restore the original Normal selection', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 10 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  f.at(BASE + 1000); f.temperatures(); f.state(f.commands[0]); await flush();
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 20 * MINUTE).toISOString() });
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().heatingControls.manualChanged, false);
  f.at(BASE + 2000); f.state(f.commands.at(-1)); await flush();
  await f.runtime.setHeating({ mode: 'off' });
  f.at(BASE + 3000); f.state(f.commands.at(-1)); await flush();
  await f.runtime.setTemporary({ pauseUntil: null });
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().temporary.pauseActive, false);
});

test('garage pause expiry releases manual Off independently of a planner update', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  f.at(BASE + 1000); f.state(f.commands[0]); await flush();
  f.at(BASE + MINUTE); f.temperatures(); f.state(f.commands[0]);
  f.runtime.expireControls(f.now()); await f.runtime.dispatch; await flush();
  assert.equal(f.runtime.status().temporary.pauseActive, false);
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().heatingControls.manualChanged, false);
});

test('manual garage Off still requires both sensors and approved freeze protection', async t => {
  const f = setup(t);
  delete f.engine.latest.garage_temperature_2;
  await assert.rejects(f.runtime.setHeating({ mode: 'off' }), /freeze-protection/);
  assert.equal(f.commands.length, 0);
  const unapproved = setup(t, { approved: false });
  await assert.rejects(unapproved.runtime.setHeating({ mode: 'off' }), /freeze-protection/);
  assert.equal(unapproved.commands.length, 0);
});

test('freeze protection overrides manual Off during a price-control pause', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 30 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  f.at(BASE + 1000); f.state(f.commands[0]); await flush();
  f.at(BASE + MINUTE); f.temperatures(-10, 8); f.state(f.commands[0]); f.runtime.safetyTick(); await flush();
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().temporary.pauseActive, true);
  assert.equal(f.runtime.status().heatingControls.manualChanged, false);
});

test('unsupported live garage adapter never sends manual commands; price-control pause remains usable', async t => {
  const f = setup(t, { live: true });
  await f.runtime.setTemporary({ pauseUntilLocal: '2027-02-01T12:00' });
  const status = f.runtime.status();
  assert.equal(status.temporary.pauseUntilLocal, '2027-02-01T12:00');
  assert.equal(status.temporary.available, true);
  assert.equal(status.heatingControls.available, false);
  await assert.rejects(f.runtime.setHeating({ mode: 'off' }), /direct heat-pump control is not available/);
  await assert.rejects(f.runtime.setHeating({ mode: 'normal' }), /direct heat-pump control is not available/);
  assert.equal(f.commands.length, 0);
});

test('temporary override availability distinguishes operating mode from offline input', async t => {
  const f = setup(t);
  for (const mode of ['shadow', 'monitoring']) {
    f.engine.settings.mode = mode;
    assert.equal(f.runtime.heatingControls().available, false);
    assert.equal(f.runtime.heatingControls().reason, 'Temporary heating overrides require Active mode.');
  }
  f.runtime.input = 'offline';
  assert.equal(f.runtime.heatingControls().reason, 'Temporary heating overrides are unavailable with offline input.');
  f.runtime.input = 'mqtt'; f.engine.settings.mode = 'active';
  assert.equal(f.runtime.heatingControls().available, true);
});

test('garage pause survives restart but manual Off permission does not', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 30 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  const saved = f.store.getState(f.runtime.keys.adapter);
  assert.equal(saved.restorePending, true);
  await f.runtime.close({ restore: false });
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine, config: f.config, clock: f.now });
  t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.status().temporary.pauseActive, true);
  assert.equal(restarted.status().heatingControls.manualChanged, false);
  assert.equal(f.store.getState(restarted.keys.manual), null);
  assert.equal(f.store.getState(restarted.keys.adapter).restorePending, true);
});

test('a broker change retains freeze exposure and restoration duties without reviving saved room or Off permission', async t => {
  const f = setup(t);
  f.runtime.saveRoomTarget(7, BASE);
  f.store.setState(f.runtime.keys.exposure, f.runtime.exposure);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 30 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  const saved = f.store.getState(f.runtime.keys.adapter);
  const room = f.store.getState(f.runtime.keys.roomTemperature);
  const exposure = f.store.getState(f.runtime.keys.exposure);
  assert.equal(saved.restorePending, true);
  await f.runtime.close({ restore: false });
  const commands = f.commands.length;
  const config = { ...f.config, connections: { mqtt: { address: 'mqtt://127.0.0.1' } } };
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine, config, clock: f.now });
  t.after(() => restarted.close({ restore: false }));
  assert.equal(restarted.roomTemperature.targetC, null);
  assert.equal(restarted.read().roomTargetC, null);
  assert.equal(restarted.activeManual(), null);
  assert.equal(f.store.getState(restarted.keys.manual), null);
  assert.equal(restarted.status().temporary.pauseActive, true, 'Suspending automatic control grants no actuator permission');
  assert.deepEqual(restarted.exposure, exposure);
  assert.deepEqual(f.store.getState(restarted.keys.adapter), saved);
  assert.deepEqual(f.store.getState(restarted.keys.roomTemperature), room);
  const adapter = createGarageAdapter({ settings: config.garage.adapter, clock: f.now, persisted: saved,
    simulationTransport: createGarageSimulationTransport(async command => f.commands.push(command)) });
  t.after(() => adapter.close({ restore: false }));
  restarted.setAdapter(adapter);
  assert.equal(adapter.snapshot().restorePending, true);
  assert.equal(adapter.snapshot().episode.invalidated, true);
  assert.equal(adapter.snapshot().episode.status, 'restoring');
  assert.equal(adapter.status().automaticControl, false);
  assert.equal(f.commands.length, commands, 'Restart requires fresh device reconciliation before any restoration');
});

test('garage HTTP controls use the runtime owner and reject unsupported selections', async t => {
  const f = setup(t);
  const server = createAppServer({ engine: { garage: f.runtime, status: () => ({ garage: f.runtime.status() }) },
    store: f.store, chartService: { overview: async () => ({ rows: [] }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, input) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const pause = await post('/api/garage/temporary', { pauseUntil: new Date(BASE + 10 * MINUTE).toISOString() });
  assert.equal(pause.status, 200); assert.equal((await pause.json()).garage.temporary.pauseActive, true);
  const off = await post('/api/garage/heating', { mode: 'off' });
  assert.equal(off.status, 200); assert.equal((await off.json()).garage.heatingControls.requestedMode, 'off');
  assert.equal(f.commands.at(-1).action, 'start');
  assert.equal((await post('/api/garage/heating', { mode: 'preheat' })).status, 400);
  assert.equal((await post('/api/garage/temporary', { awayUntil: null })).status, 400);
});

test('failed garage pause persistence leaves the previous owner and OFF obligation intact', async t => {
  const f = setup(t);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + 10 * MINUTE).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  const previousPause = structuredClone(f.runtime.temporary), previousManual = structuredClone(f.runtime.manual);
  const original = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key === f.runtime.keys.temporary) throw new Error('fixture pause persistence failure');
    return original(key, value);
  };
  try { await assert.rejects(f.runtime.setTemporary({ pauseUntil: null }), /persistence failure/); }
  finally { f.store.setState = original; }
  assert.deepEqual(f.runtime.temporary, previousPause);
  assert.deepEqual(f.runtime.manual, previousManual);
  assert.equal(f.commands.length, 1);
});
