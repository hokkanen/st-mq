import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageModel, updateGarageModel } from '../src/garage/model.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { createGarageAdapter, createGarageSimulationTransport } from '../src/garage/adapter.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';
import { rememberGarageTemperature } from '../src/garage/temperature-evidence.js';

const HOUR = 3_600_000, MINUTE = 60_000, BASE = 1_800_000_000_000;
const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const flush = () => new Promise(resolve => setImmediate(resolve));
// This saved, explicit synthetic seed exercises planner/consumer integration.
// Its deliberately assigned validation statistics are not installed evidence.
function syntheticSeed(settings) {
  let model = createGarageModel({ seedAt: BASE - 96 * HOUR, roomTargetC: 10 });
  for (let i = 0; i < 384; i++) model = updateGarageModel(model, { at: BASE - 96 * HOUR + i * HOUR / 4,
    rearC: 7, frontC: 6.7, outdoorC: 0, available: true, baselineVerified: true,
    powerKw: .3, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0 }, settings);
  model.evidence.offIntervals = 12;
  for (const metrics of Object.values(model.heldOut)) Object.assign(metrics, { n: 30, absolute: 1.5, square: .15, signed: 0 });
  model.rear.values = [.02];
  model.front.values = [.025];
  model.native.values = [.5];
  return assignGaragePlanningEvidence(model);
}
function setup(t, { expensiveHours = 2, totalHours = 12, forecastOutdoorC = 0 } = {}) {
  let now = BASE, owner = true, stateSequence = 0;
  const settings = garageSettings({ enabled: true, minOnMs: 0, savingsStrategy: 'savings', protection: { approved: true } });
  const store = new Store(':memory:');
  appendGarageEntry(store, 'mqtt', 'context', {}, settings, BASE - 1, { key: 'explicit-synthetic-fixture-seed', seed: syntheticSeed(settings) });
  store.setState('garage:configuration:mqtt', settings);
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
  runtime.exposure = knownGarageReserve(runtime.settings, { at: BASE });
  function temperatures(rear = 7, front = 6.7, outdoor = 0) {
    for (const [signal, value] of [['garage_temperature', rear], ['garage_temperature_2', front], ['outdoor_temperature', outdoor]])
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
  const prices = Array.from({ length: totalHours }, (_, i) => i < expensiveHours ? 100 : 1).map((value, i) => ({
    start: BASE + i * HOUR, end: BASE + (i + 1) * HOUR, allInCentsPerKWh: value }));
  const forecast = [{ start: BASE, end: BASE + totalHours * HOUR, outdoorC: forecastOutdoorC, issuedAt: BASE }];
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
    f.at(BASE + minute * MINUTE); f.temperatures(); f.accepted(f.commands.at(-1)); await f.tick();
  }
  assert.equal(f.commands.length, 6);
  assert.equal(f.commands[1].action, 'renew');
  assert.equal(f.commands[1].episodeId, id);
  assert.equal(f.commands[1].endpointAt, endpoint);
  assert.deepEqual(f.runtime.episode.frozenModel, frozen);
  assert.equal(f.runtime.episode.pauseId, id);
  assert.equal(f.runtime.episode.id, assessmentId);
  assert.ok(f.runtime.checkpoint.model.at > frozen.at);
});

test('managed OFF holds transport-only probe loss to the original120s deadline without planner renewals', async t => {
  for (const signal of ['garage_temperature', 'garage_temperature_2']) await t.test(signal, async t => {
    const f = setup(t); f.temperatures(7, 6.7, 5); await f.tick();
    const start = f.commands.at(-1);
    assert.equal(start.action, 'start');
    assert.equal(start.requestedExpiryAt, BASE + 120_000);
    f.at(BASE + 1_000); f.accepted(start); await flush();
    f.at(BASE + 10_000);
    f.engine.latest[signal] = { ...f.engine.latest[signal], value: null, sourceTime: f.now(), receivedAt: f.now(),
      quality: ['missing', 'mqtt-disconnected'], raw: { timeBasis: 'availability-transition', usableForControl: false } };
    f.accepted(start); await f.tick();
    assert.equal(f.commands.length, 1);
    assert.equal(f.runtime.status().temperatureHold.active, true);
    assert.equal(f.runtime.protection.safeToPause, false, 'held evidence is never new pause permission');
    assert.equal(f.runtime.read()[signal === 'garage_temperature' ? 'rearC' : 'frontC'], null);
    f.at(BASE + 60_000); f.accepted(start); await f.tick();
    assert.equal(f.commands.length, 1, 'planner cadence cannot renew a held OFF lease');
    f.at(BASE + 119_999); f.accepted(start); await f.tick();
    assert.equal(f.commands.length, 1);
    f.at(BASE + 120_000); f.accepted(start); await f.tick();
    assert.equal(f.commands.at(-1).action, 'release');
    assert.equal(f.runtime.status().temperatureHold.active, false);
  });
});

test('managed OFF transport grace is revoked by a sensor fault or insufficient freeze reserve', async t => {
  for (const reason of ['sensor fault', 'exhausted front reserve', 'source replacement', 'colder outdoor evidence']) await t.test(reason, async t => {
    const f = setup(t); f.temperatures(7, 6.7, 5); await f.tick(); const start = f.commands.at(-1);
    f.at(BASE + 1_000); f.accepted(start); await flush();
    f.at(BASE + 10_000);
    f.engine.latest.garage_temperature = { ...f.engine.latest.garage_temperature, value: null,
      sourceTime: f.now(), receivedAt: f.now(), quality: ['missing', 'device-offline'],
      raw: { timeBasis: 'availability-transition', usableForControl: false } };
    f.accepted(start); await f.tick();
    assert.equal(f.commands.length, 1);
    f.at(BASE + 11_000);
    if (reason === 'sensor fault') f.engine.latest.garage_temperature = {
      ...f.engine.latest.garage_temperature, sourceTime: f.now(), receivedAt: f.now(), quality: ['sensor-unavailable'] };
    if (reason === 'exhausted front reserve') Object.assign(f.runtime.exposure.locations.front,
      { estimatedC: 0, energyJPerM: 0 });
    if (reason === 'source replacement') {
      f.temperatures(7, 6.7, 5); f.engine.latest.garage_temperature_2.device = 'invented-replacement';
    }
    if (reason === 'colder outdoor evidence') f.engine.latest.outdoor_temperature = {
      ...f.engine.latest.outdoor_temperature, value: -30, sourceTime: f.now(), receivedAt: f.now() };
    f.accepted(start); await f.tick();
    assert.equal(f.commands.at(-1).action, 'release');
  });
});

test('a timed manual OFF uses the same transport grace and an explicit Normal choice ends it', async t => {
  const f = setup(t); f.temperatures(7, 6.7, 5);
  await f.runtime.setTemporary({ pauseUntil: new Date(BASE + HOUR).toISOString() });
  await f.runtime.setHeating({ mode: 'off' });
  const start = f.commands.at(-1);
  assert.equal(start.action, 'start');
  assert.equal(start.requestedExpiryAt, BASE + 120_000);
  f.at(BASE + 1_000); f.accepted(start); await flush();
  f.at(BASE + 10_000);
  f.engine.latest.garage_temperature_2 = { ...f.engine.latest.garage_temperature_2, value: null,
    sourceTime: f.now(), receivedAt: f.now(), quality: ['missing', 'device-offline'],
    raw: { timeBasis: 'availability-transition', usableForControl: false } };
  f.accepted(start); await f.tick();
  assert.equal(f.runtime.activeManual().mode, 'off');
  assert.equal(f.runtime.status().temperatureHold.active, true);
  assert.equal(f.commands.length, 1);
  await f.runtime.setHeating({ mode: 'normal' });
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.status().temperatureHold.active, false);
});

test('silent temperature reports preserve an existing OFF lease through the60s planner tick but never extend120s', async t => {
  const f = setup(t); await f.tick(); const start = f.commands.at(-1);
  f.at(BASE + 1_000); f.accepted(start); await flush();
  f.at(BASE + 60_000); f.accepted(start); await f.tick();
  assert.equal(f.commands.length, 1);
  assert.equal(f.runtime.status().temperatureHold.active, true);
  f.at(BASE + 119_999); f.accepted(start); await f.tick();
  assert.equal(f.commands.length, 1);
  f.at(BASE + 120_000); f.accepted(start); await f.tick();
  assert.equal(f.commands.at(-1).action, 'release');
});

test('invalid ingress blocks OFF immediately even when ordinary latest retains a valid older reading', async t => {
  const f = setup(t); await f.tick(); const start = f.commands.at(-1);
  f.at(BASE + 1_000); f.accepted(start); await flush();
  const original = structuredClone(f.engine.latest.garage_temperature_2);
  f.at(BASE + 10_000);
  rememberGarageTemperature(f.engine.garageTemperatureEvidence, { ...original, value: 100,
    sourceTime: f.now(), receivedAt: f.now(), quality: ['invalid_value'] }, f.now());
  f.accepted(start); await f.tick();
  assert.deepEqual(f.engine.latest.garage_temperature_2, original);
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.pausePermission(f.now(), f.runtime.read()).allowed, false);
});

test('OFF source identity is bound before the first acknowledgement arrives', async t => {
  for (const replacement of [false, true]) await t.test(replacement ? 'replacement' : 'transport loss', async t => {
    const f = setup(t); f.temperatures(7, 6.7, 5); await f.tick(); const start = f.commands.at(-1);
    f.at(BASE + 10_000);
    if (replacement) { f.temperatures(7, 6.7, 5); f.engine.latest.garage_temperature_2.device = 'invented-new-front'; }
    else f.engine.latest.garage_temperature_2 = { ...f.engine.latest.garage_temperature_2, value: null,
      sourceTime: f.now(), receivedAt: f.now(), quality: ['missing', 'device-offline'],
      raw: { timeBasis: 'availability-transition', usableForControl: false } };
    f.accepted(start); await f.tick();
    assert.equal(f.commands.at(-1).action, replacement ? 'release' : 'start');
    assert.equal(f.runtime.status().temperatureHold.active, !replacement);
  });
});

test('runtime dispatch uses the same 2 C rule for open and unknown doors, even while charging', async t => {
  for (const outdoor of [1.99, 2, 2.01]) for (const open of [true, null]) {
    await t.test(`${outdoor} C, door ${open === null ? 'unknown' : 'open'}`, async t => {
      const f = setup(t, { forecastOutdoorC: outdoor }), signal = 'garage_door1_open';
      f.runtime.config.connections = { equipment: { devices: [{ enabled: true, ownedSignals: [signal] }] } };
      const reports = () => {
        f.temperatures(7, 6.7, outdoor);
        if (open !== null) f.engine.latest[signal] = { signal, source: 'mqtt-equipment', device: 'invented-door', value: 1,
          sourceTime: f.now(), receivedAt: f.now(), quality: [], raw: { availabilityConfirmed: true, confirmedAt: f.now() } };
        for (const phase of [1, 2, 3]) {
          const name = `ev1_current_l${phase}`;
          f.engine.latest[name] = { signal: name, source: 'easee', device: 'invented-charger', value: 16,
            sourceTime: f.now(), receivedAt: f.now(), quality: [] };
        }
      };
      reports(); await f.tick();
      assert.equal(f.runtime.read().ev1Active, true);
      assert.equal(f.runtime.read().doorFront, open);
      if (outdoor < 2) {
        assert.equal(f.runtime.plan.reason, 'garage-door-open-or-unknown-below-2c');
        assert.equal(f.commands.length, 0);
        return;
      }
      assert.equal(f.runtime.plan.nextAction, 'pause');
      assert.equal(f.commands.at(-1).action, 'start');
      const endpoint = f.commands.at(-1).endpointAt;
      f.at(BASE + MINUTE); reports(); f.accepted(); await f.tick();
      assert.equal(f.commands.at(-1).action, 'renew');
      assert.equal(f.commands.at(-1).endpointAt, endpoint);
      f.at(BASE + MINUTE + 1000); reports();
      f.engine.latest.garage_temperature_2.value = null;
      f.accepted(); await flush();
      assert.equal(f.commands.at(-1).action, 'release', 'Charging and warm weather never replace required probe evidence');
    });
  }
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

test('missing HA door feedback blocks a cold start and a later outage still obeys independent probe protection', async t => {
  const f = setup(t), signal = 'garage_door1_open';
  f.runtime.config.connections = { equipment: { devices: [{ enabled: true, ownedSignals: [signal] }] } };
  await f.tick();
  assert.equal(f.runtime.read().doorFront, null);
  assert.equal(f.runtime.read().available, true);
  assert.equal(f.runtime.plan.reason, 'garage-door-open-or-unknown-below-2c');
  assert.equal(f.commands.length, 0, 'A replacement host missing HA status keeps normal heating available');

  f.engine.latest[signal] = { signal, source: 'mqtt-equipment', device: 'invented-door', value: 0,
    sourceTime: BASE, receivedAt: BASE, quality: [], raw: { availabilityConfirmed: true, confirmedAt: BASE } };
  await f.tick();
  assert.equal(f.commands.at(-1).action, 'start');
  f.at(BASE + MINUTE); f.temperatures();
  f.engine.latest[signal] = { ...f.engine.latest[signal], value: null, receivedAt: f.now(), quality: ['bridge-offline'],
    raw: { availabilityConfirmed: false } };
  f.accepted(); await f.tick();
  assert.equal(f.runtime.read().doorFront, null);
  assert.equal(f.commands.at(-1).action, 'renew', 'Door loss alone does not cancel an already protected pause');
  assert.equal(f.runtime.episode.accounting.qualified, false, 'An outage cannot establish clean savings evidence');

  f.at(BASE + MINUTE + 1000); f.temperatures();
  f.engine.latest.garage_temperature_2 = { ...f.engine.latest.garage_temperature_2,
    value: null, quality: ['mqtt-disconnected'] };
  f.accepted(); await flush();
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.runtime.protection.safeToPause, false);
  assert.equal(f.adapter.status().restorePending, true);
});

test('runtime persistence failure requests release through the real consumer and retains the saved obligation', async t => {
  const f = setup(t); await f.tick(); f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  f.at(f.now() + 1000); f.temperatures(); f.accepted(); await flush();
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
  assert.equal(f.commands.length, 2);
  assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
  assert.equal(f.adapter.status().phase, 'restoring');
});

test('runtime and acquisition graceful close request release once and keep accounting recovery separate', async t => {
  const f = setup(t); await f.tick(); f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  f.at(f.now() + 1000); f.temperatures(); f.accepted(); await flush();
  await f.runtime.close({ restore: true }); await f.adapter.close({ restore: true });
  assert.equal(f.commands.filter(command => command.action === 'release').length, 1);
  assert.equal(f.runtime.episode.phase, 'recovery');
  assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.store.getState(f.runtime.keys.adapter).restorePending, true);
});

test('recovery blocks another pause and preserves frozen accounting and unrecovered front debt', async t => {
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
  assert.equal(later.action, 'release');
  assert.equal(f.commands.filter(command => command.action === 'start').length, 1);
  assert.equal(f.runtime.plan.reason, 'normal-heating-recovery');
  assert.equal(f.runtime.episode.id, assessmentId);
  assert.equal(f.runtime.episode.pauseId, first.episodeId);
  assert.deepEqual(f.runtime.episode.frozenModel, frozen);
  assert.ok(f.runtime.status().episode.heatDebt.frontC > .25, 'new permission does not erase front recovery debt');
});


test('a multi-day endpoint uses short host permissions and still restores on sensor expiry', async t => {
  const f = setup(t, { expensiveHours: 60, totalHours: 140, forecastOutdoorC: 5 });
  await f.tick();
  const first = f.commands.at(-1);
  assert.equal(first.action, 'start');
  assert.equal(first.endpointAt, BASE + 60 * HOUR);
  assert.ok(first.requestedExpiryAt <= BASE + 3 * MINUTE);
  f.at(BASE + MINUTE); f.temperatures(); f.accepted(); await f.tick();
  const renewal = f.commands.at(-1);
  assert.equal(renewal.action, 'renew');
  assert.equal(renewal.endpointAt, first.endpointAt);
  assert.equal(renewal.episodeId, first.episodeId);
  assert.ok(renewal.requestedExpiryAt <= f.now() + 3 * MINUTE);
  f.at(BASE + 3 * MINUTE); f.runtime.lastPlannerAt = f.now();
  f.accepted(renewal); await flush();
  assert.equal(f.commands.at(-1).action, 'release');
  assert.equal(f.adapter.status().restorePending, true);
});
