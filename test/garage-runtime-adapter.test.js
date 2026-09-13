import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageModel, updateGarageModel } from '../src/garage/model.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { createGarageAdapter, createGarageSimulationTransport } from '../src/garage/adapter.js';

const HOUR = 3_600_000, MINUTE = 60_000, BASE = 1_800_000_000_000;
const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const flush = () => new Promise(resolve => setImmediate(resolve));
// This saved, explicit synthetic seed exercises planner/consumer integration.
// Its deliberately assigned validation statistics are not installed evidence.
function syntheticSeed(settings) {
  let model = createGarageModel({ seedAt: BASE - 96 * HOUR });
  for (let i = 0; i < 384; i++) model = updateGarageModel(model, { at: BASE - 96 * HOUR + i * HOUR / 4,
    rearC: 7, frontC: 6.7, outdoorC: 0, available: true, baselineVerified: true,
    powerKw: .3, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0 }, settings);
  model.evidence.offIntervals = 12;
  for (const metrics of Object.values(model.heldOut)) Object.assign(metrics, { n: 30, absolute: 1.5, square: .15, signed: 0 });
  model.rear.values = [.02, .10, .55, .5, .012, .012, .04, .04];
  model.front.values = [.55, .012, .07, .06, 0, 0, 0, 0];
  model.native.values = [.26, .012, .35, .1];
  return model;
}
function setup(t) {
  let now = BASE, owner = true, stateSequence = 0;
  const settings = garageSettings({ enabled: true, frontRequired: true, aggressiveness: 100, protection: { approved: true } });
  const store = new Store(':memory:');
  appendGarageEntry(store, 'mqtt', 'context', {}, settings, BASE - 1, { key: 'explicit-synthetic-fixture-seed', seed: syntheticSeed(settings) });
  const config = { input: 'mqtt', garage: { ...settings, adapter: { stateTopic: 'fixture/garage/state' } } };
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'active' } };
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now, canControl: () => owner });
  const commands = [];
  const adapter = createGarageAdapter({ settings: config.garage.adapter, clock: () => now,
    hostSession: 'fixture-host', canControl: () => owner,
    onState: value => runtime.adapterChanged(value), persisted: store.getState(runtime.keys.adapter),
    onEnergy: value => runtime.ingestEnergy(value),
    simulationTransport: createGarageSimulationTransport(async command => { commands.push(command); }) });
  runtime.setAdapter(adapter);
  function temperatures(rear = 7, front = 6.7) {
    for (const [signal, value] of [['garage_temperature', rear], ['garage_temperature_2', front], ['outdoor_temperature', 0]])
      engine.latest[signal] = { signal, value, unit: 'degC', sourceTime: now, receivedAt: now, quality: [],
        source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: signal };
  }
  function state(patch = {}) {
    const value = structuredClone(TEMPLATE);
    value.sequence = ++stateSequence; value.observedAt = now;
    value.baseline.measuredAt = now; value.native.power.measuredAt = now;
    for (const field of Object.values(value.health)) field.measuredAt = now;
    value.challenge = { value: `runtime-fixture-challenge-${stateSequence}`, expiresAt: now + 30_000 };
    adapter.receive('fixture/garage/state', JSON.stringify({ ...value, ...patch }), {}, now);
  }
  function accepted(command = commands.at(-1), patch = {}) {
    state({ native: { power: { value: command.action === 'release' ? 'on' : 'off', measuredAt: now } },
      restorationPending: command.action !== 'release',
      lease: command.action === 'release' ? null : { episodeId: command.episodeId,
        endpointAt: command.endpointAt, expiresAt: command.requestedExpiryAt },
      result: { commandId: command.commandId, episodeId: command.episodeId, sequence: command.sequence,
        action: command.action, status: command.action === 'release' ? 'native-confirmed' : 'accepted' }, ...patch });
  }
  const prices = [100, 100, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1].map((value, i) => ({
    start: BASE + i * HOUR, end: BASE + (i + 1) * HOUR, allInCentsPerKWh: value }));
  const forecast = [{ start: BASE, end: BASE + 12 * HOUR, outdoorC: 0, issuedAt: BASE }];
  async function tick() { runtime.tick({ now, prices, forecast }); await runtime.dispatch; await flush(); }
  temperatures(); adapter.setConnected(true); state();
  t.after(async () => { await runtime.close({ restore: false }); await adapter.close({ restore: false }); store.close(); });
  return { runtime, adapter, store, engine, commands, state, accepted, temperatures, tick,
    at(value) { now = value; }, now: () => now, owner(value) { owner = value; } };
}

test('runtime planner starts and renews the real fixture consumer with one frozen episode and fixed endpoint', async t => {
  const f = setup(t); await f.tick();
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].action, 'start');
  const id = f.commands[0].episodeId, endpoint = f.commands[0].endpointAt, assessmentId = f.runtime.episode.id;
  const frozen = structuredClone(f.runtime.episode.frozenModel);
  assert.equal(f.runtime.episode.pauseId, id);
  assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
  for (let minute = 1; minute <= 5; minute++) {
    f.at(BASE + minute * MINUTE); f.temperatures(); f.accepted(f.commands[0]); await f.tick();
  }
  assert.equal(f.commands.length, 2);
  assert.equal(f.commands[1].action, 'renew');
  assert.equal(f.commands[1].episodeId, id);
  assert.equal(f.commands[1].endpointAt, endpoint);
  assert.deepEqual(f.runtime.episode.frozenModel, frozen);
  assert.equal(f.runtime.episode.pauseId, id);
  assert.equal(f.runtime.episode.id, assessmentId);
  assert.ok(f.runtime.checkpoint.model.at > frozen.at);
});

test('exact external sensor expiry releases an active lease; native ON and health cannot replace front evidence', async t => {
  const f = setup(t); await f.tick();
  f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  f.at(BASE + 3 * MINUTE); f.runtime.lastPlannerAt = f.now();
  f.engine.latest.garage_temperature.sourceTime = f.now();
  f.engine.latest.garage_temperature.receivedAt = f.now();
  f.accepted(f.commands[0]); await flush();
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.runtime.read().frontC, null);
  assert.equal(f.runtime.protection.safeToPause, false);
  const release = f.commands.at(-1);
  f.at(BASE + 3 * MINUTE + 1000); f.accepted(release); await flush();
  assert.equal(f.adapter.status().restorePending, false);
  assert.equal(f.runtime.protection.safeToPause, false);
  const count = f.commands.length;
  for (let i = 0; i < 10; i++) { f.runtime.safetyTick(); await flush(); }
  assert.equal(f.commands.length, count);
});

test('runtime persistence failure requests release through the real consumer and retains the saved obligation', async t => {
  const f = setup(t); await f.tick(); f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  const original = f.store.setState;
  f.store.setState = () => { throw new Error('runtime fixture persistence failure'); };
  try {
    f.runtime.safetyTick(); await flush();
    assert.equal(f.commands.at(-1).action, 'release');
    assert.equal(f.adapter.status().restorePending, true);
    assert.ok(f.adapter.status().faults.includes('restoration-state-storage-failed'));
    assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
    assert.equal(f.runtime.protection.safeToPause, false);
  } finally { f.store.setState = original; }
});

test('runtime authority loss and duplicate close cannot send competing ON or resume a paused episode', async t => {
  const f = setup(t); await f.tick(); f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  f.owner(false); f.runtime.safetyTick(); await flush();
  await f.runtime.close({ restore: true }); await f.adapter.close({ restore: true });
  await f.runtime.close({ restore: true }); await f.adapter.close({ restore: true });
  assert.equal(f.commands.length, 1);
  assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
  assert.equal(f.adapter.status().phase, 'restoring');
});

test('runtime and acquisition graceful close request release once and keep accounting recovery separate', async t => {
  const f = setup(t); await f.tick(); f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  await f.runtime.close({ restore: true }); await f.adapter.close({ restore: true });
  assert.equal(f.commands.filter(command => command.action === 'release').length, 1);
  assert.equal(f.runtime.episode.phase, 'recovery');
  assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
});

test('a later pause uses a new adapter episode while preserving frozen accounting and unrecovered front debt', async t => {
  const f = setup(t); await f.tick(); const first = f.commands[0];
  const frozen = structuredClone(f.runtime.episode.frozenModel), assessmentId = f.runtime.episode.id;
  f.at(BASE + MINUTE); f.temperatures(); f.accepted(first); await f.tick();
  f.at(BASE + 2 * MINUTE); f.temperatures(7, 6.2); f.accepted(first);
  await f.runtime.release('fixture-early-release'); const release = f.commands.at(-1);
  assert.equal(release.action, 'release');
  f.accepted(release); await f.tick();
  assert.equal(f.runtime.episode.phase, 'recovery');
  assert.equal(f.adapter.status().restorePending, false);
  for (let minute = 3; minute <= 33; minute++) {
    f.at(BASE + minute * MINUTE); f.temperatures(7, 6.2); f.state(); await f.tick();
    if (f.commands.at(-1).action === 'start') break;
  }
  const later = f.commands.at(-1);
  assert.equal(later.action, 'start');
  assert.notEqual(later.episodeId, first.episodeId);
  assert.ok(later.issuedAt >= BASE + 32 * MINUTE, 'runtime minimum ON lock remains binding');
  assert.equal(f.runtime.episode.id, assessmentId);
  assert.equal(f.runtime.episode.pauseId, later.episodeId);
  assert.deepEqual(f.runtime.episode.frozenModel, frozen);
  assert.ok(f.runtime.status().episode.heatDebt.frontC > .25, 'new permission does not erase front recovery debt');
});
