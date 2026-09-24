import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings, garageSavingsPreference, GARAGE_PREFERENCE_VERSION } from '../src/garage/settings.js';
import { createGarageModel } from '../src/garage/model.js';
import { planGarage } from '../src/garage/planner.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';

const HOUR = 3_600_000, MINUTE = 60_000, NOW = Date.parse('2026-01-01T10:00:00Z');
function candidate(aggressiveness = 50, values = [200, 200, 200, 200, ...Array(16).fill(5)]) {
  const settings = garageSettings({ enabled: true, aggressiveness, protection: { approved: true } });
  const model = assignGaragePlanningEvidence(createGarageModel({ seedAt: NOW }));
  model.normalReference.interceptC = 10; model.normalReference.frontC = 9;
  return { now: NOW, settings, model,
    observation: { at: NOW, rearAt: NOW, frontAt: NOW, rearC: 10, frontC: 9,
      outdoorC: 8, available: true, baselineVerified: true, doorFront: false },
    exposure: knownGarageReserve(settings, { at: NOW, rearC: 10, frontC: 9 }), restorationDelayMs: 2 * MINUTE,
    prices: values.map((price, i) => ({ start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, priceCtPerKwh: price })),
    forecast: [{ start: NOW, end: NOW + values.length * HOUR, outdoorC: 8, issuedAt: NOW }] };
}
const hours = plan => (plan.plannedPauseUntil - plan.pauseFrom) / HOUR;
function advance(args, at) {
  args.now = at;
  Object.assign(args.observation, { at, rearAt: at, frontAt: at });
  args.exposure = knownGarageReserve(args.settings, { at, rearC: 10, frontC: 9 });
}

test('the shared preference scales economics smoothly around the configured midpoint without changing protection', () => {
  for (const [aggressiveness, minimumBenefitEur, retainedBenefitFraction] of [
    [0, .75, .6], [25, .625, .7], [50, .5, .8], [75, .375, .9], [100, .25, 1],
  ]) {
    const settings = garageSettings({ aggressiveness });
    assert.deepEqual(garageSavingsPreference(settings), { minimumBenefitEur, retainedBenefitFraction });
    assert.deepEqual(settings.protection, garageSettings().protection);
  }
  assert.equal(garageSavingsPreference({ minSavingsEur: 2, aggressiveness: 25 }).minimumBenefitEur, 2.5);
});

test('zero, balanced and maximum preference select progressively longer worthwhile windows', () => {
  const plans = [0, 50, 100].map(value => planGarage(candidate(value)));
  assert.deepEqual(plans.map(hours), [2.5, 3.25, 4]);
  assert.deepEqual(plans.map(plan => (plan.pauseFrom - NOW) / HOUR), [1.5, .75, 0]);
  for (const [index, preference] of [0, 50, 100].entries()) {
    const policy = garageSavingsPreference({ aggressiveness: preference });
    assert.ok(plans[index].scoreEur >= plans[2].scoreEur * policy.retainedBenefitFraction);
    assert.ok(plans[index].scoreEur > policy.minimumBenefitEur);
    assert.equal(plans[index].preferenceVersion, GARAGE_PREFERENCE_VERSION);
  }
  assert.ok(hours(planGarage(candidate(25))) < hours(planGarage(candidate(75))), 'Positive settings have distinct behavior');
});

test('the monetary hurdle admits smaller opportunities only at higher preferences; zero still starts sufficiently valuable pauses', () => {
  for (const [price, expected] of [[100, ['available', 'available', 'pause']],
    [150, ['available', 'pause', 'pause']], [200, ['pause', 'pause', 'pause']]]) {
    assert.deepEqual([0, 50, 100].map(value => planGarage(candidate(value, [price, ...Array(12).fill(5)])).nextAction), expected);
  }
});

test('equal-length qualifying windows prefer greater benefit, then the earlier start', () => {
  const equal = planGarage(candidate(0, [200, ...Array(10).fill(5), 200, ...Array(16).fill(5)]));
  assert.equal(hours(equal), 1); assert.equal(equal.pauseFrom, NOW);
  const later = planGarage(candidate(50, [150, ...Array(10).fill(5), 200, ...Array(16).fill(5)]));
  assert.equal(hours(later), 1); assert.equal(later.pauseFrom, NOW + 11 * HOUR);
});

test('even maximum preference retains minimum OFF time, forecast coverage, fresh pipes and explicit protection approval', () => {
  for (const change of [
    args => { args.forecast[0].end = NOW + args.settings.minOffMs - MINUTE; },
    args => { args.forecast = []; },
    args => { args.observation.frontC = null; },
    args => { args.settings.protection.approved = false; },
    args => { args.restorationDelayMs = null; },
  ]) {
    const args = candidate(100); change(args);
    assert.equal(planGarage(args).nextAction, 'available');
  }
});

test('scheduled windows stay fixed until admission and renewals do not repeatedly shorten their remaining duration', () => {
  for (const preference of [0, 50]) {
    const args = candidate(preference), planned = planGarage(args);
    args.scheduledOpportunity = planned;
    for (let at = NOW + 7 * MINUTE; at < planned.pauseFrom; at += 7 * MINUTE) {
      advance(args, at);
      const waiting = planGarage(args);
      assert.equal(waiting.state, 'waiting');
      assert.equal(waiting.pauseFrom, planned.pauseFrom); assert.equal(waiting.plannedPauseUntil, planned.plannedPauseUntil);
    }
    advance(args, planned.pauseFrom);
    assert.equal(planGarage(args).nextAction, 'pause');
    args.scheduledOpportunity = null;
    for (let at = planned.pauseFrom + 7 * MINUTE; at < planned.plannedPauseUntil; at += 7 * MINUTE) {
      advance(args, at);
      args.observation.available = false;
      args.activeEpisode = { state: 'paused', pauseStartedAt: planned.pauseFrom, authorizedEndAt: planned.plannedPauseUntil };
      const ongoing = planGarage(args);
      assert.equal(ongoing.nextAction, 'renew'); assert.equal(ongoing.pauseUntil, planned.plannedPauseUntil);
    }
  }
});

function runtimeFixture(t, aggressiveness = 50) {
  const args = candidate(aggressiveness), store = new Store(':memory:'); let now = NOW;
  const settings = garageSettings({ ...args.settings, minOnMs: 0 });
  appendGarageEntry(store, 'mqtt', 'context', {}, settings, NOW - 1, { key: 'test-planning-seed', seed: args.model });
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'active' } };
  const runtime = new GarageRuntime({ store, engine, config: { input: 'mqtt', garage: settings }, clock: () => now });
  const commands = [], safety = [], native = { automaticControl: true, liveControlSupported: true, phase: 'ready', episode: null,
    native: { power: 'on', powerAt: now }, health: { pumpCommunicating: true }, baselineAccepted: true,
    limits: { restorationDelayMs: 2 * MINUTE, maxLeaseMs: 180_000 } };
  runtime.setAdapter({ status: () => native, safetyTick: async data => { safety.push(data); },
    nativeControls: () => ({ available: true, busy: false, settings: {
      fan: { available: true, supported: true, value: 'auto', values: ['auto', 'quiet'] } } }),
    setNativeSetting: async () => {},
    plannerTick: async data => {
      commands.push(data);
      if (data.valid) {
        native.phase = 'paused'; native.native.power = 'off';
        native.episode = { id: data.plan.id, endpointAt: data.plan.pauseUntil, status: 'paused' };
      }
    }, release: async () => {} });
  const report = at => {
    now = at; native.native.powerAt = at;
    for (const [signal, value] of [['garage_temperature', 10], ['garage_temperature_2', 9], ['outdoor_temperature', 8]])
      engine.latest[signal] = { source: 'test', device: signal, signal, value, unit: 'degC', sourceTime: at, receivedAt: at, quality: [] };
    runtime.exposure = knownGarageReserve(settings, { at, rearC: 10, frontC: 9 });
  };
  const tick = async at => { report(at); runtime.tick({ now: at, prices: args.prices, forecast: args.forecast }); await runtime.dispatch; };
  report(NOW);
  t.after(async () => { await runtime.close({ restore: false }); store.close(); });
  return { runtime, store, engine, commands, safety, report, tick };
}

test('runtime preserves a waiting opportunity and starts at its selected time even at zero preference', async t => {
  const f = runtimeFixture(t, 0);
  await f.tick(NOW);
  const selected = structuredClone(f.runtime.plan);
  assert.equal(selected.state, 'waiting'); assert.equal(f.runtime.episode, null);
  assert.equal(f.commands.at(-1).valid, false);
  await f.tick(NOW + 7 * MINUTE);
  assert.equal(f.runtime.plan.pauseFrom, selected.pauseFrom);
  await f.tick(selected.pauseFrom);
  assert.equal(f.runtime.plan.nextAction, 'pause'); assert.equal(f.commands.at(-1).valid, true);
  assert.equal(f.runtime.episode.pauseUntil, selected.plannedPauseUntil);
  f.report(selected.pauseFrom + MINUTE); f.runtime.safetyTick();
  assert.equal(f.safety.at(-1).valid, true, 'Zero preference retains automatic safety-loop permission');
  await f.tick(selected.pauseFrom + MINUTE);
  assert.equal(f.runtime.plan.nextAction, 'renew'); assert.equal(f.runtime.plan.pauseUntil, selected.plannedPauseUntil);
});

test('runtime cancels waiting windows when protection fails, settings change or price control is paused', async t => {
  const f = runtimeFixture(t);
  await f.tick(NOW);
  assert.ok(f.runtime.scheduledOpportunity);
  delete f.engine.latest.garage_temperature_2;
  f.runtime.tick({ now: NOW, prices: candidate().prices, forecast: candidate().forecast }); await f.runtime.dispatch;
  assert.equal(f.runtime.scheduledOpportunity, null); assert.equal(f.commands.at(-1).valid, false);
  await f.tick(NOW);
  f.runtime.settings.aggressiveness = 100;
  await f.tick(NOW);
  assert.equal(f.runtime.plan.nextAction, 'pause', 'A changed preference selects again instead of inheriting the waiting window');
  const paused = runtimeFixture(t);
  await paused.tick(NOW);
  await paused.runtime.setTemporary({ pauseUntil: new Date(NOW + HOUR).toISOString() });
  await paused.tick(NOW + MINUTE);
  assert.equal(paused.runtime.scheduledOpportunity, null); assert.equal(paused.commands.at(-1).valid, false);
});

test('daily starts and minimum normal-heating time still block opportunities at maximum preference', async t => {
  const f = runtimeFixture(t, 100);
  f.runtime.settings.minOnMs = 3 * HOUR;
  await f.tick(NOW);
  assert.equal(f.runtime.plan.reason, 'minimum-normal-heating-time'); assert.equal(f.commands.at(-1).valid, false);
  f.runtime.settings.minOnMs = 0;
  f.store.cycle('garage:mqtt', { id: 'already-attempted', startedAt: NOW - MINUTE, status: 'incomplete', endedAt: NOW });
  await f.tick(NOW);
  assert.equal(f.runtime.plan.reason, 'daily-pause-limit'); assert.equal(f.commands.at(-1).valid, false);
});

test('accepted Normal and native selections discard the waiting window before automatic controls expire', async t => {
  for (const action of ['normal', 'native']) {
    const f = runtimeFixture(t);
    await f.tick(NOW);
    const previousStart = f.runtime.plan.pauseFrom;
    f.report(NOW + 7 * MINUTE);
    if (action === 'normal') await f.runtime.setHeating({ mode: 'normal' });
    else await f.runtime.setNativeSettings({ setting: 'fan', value: 'quiet' });
    assert.equal(f.runtime.scheduledOpportunity, null, action);
    await f.tick(NOW + 7 * MINUTE);
    assert.equal(f.runtime.manual, null, 'An unpaused Normal selection ends at the next controller update');
    assert.notEqual(f.runtime.plan.pauseFrom, previousStart, 'The next update selects afresh');
  }
});

test('an asynchronous native request cannot repopulate a discarded waiting window', async t => {
  const f = runtimeFixture(t);
  await f.tick(NOW);
  let finish;
  f.runtime.adapter.setNativeSetting = () => new Promise(resolve => { finish = resolve; });
  const request = f.runtime.setNativeSettings({ setting: 'fan', value: 'quiet' });
  assert.equal(f.runtime.scheduledOpportunity, null);
  assert.equal(f.runtime.manualBusy, true);
  await f.tick(NOW + MINUTE);
  assert.equal(f.runtime.scheduledOpportunity, null);
  finish(); await request;
});
