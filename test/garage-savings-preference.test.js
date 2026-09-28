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
function candidate(savingsStrategy = 'balanced', values = [200, 200, 200, 200, ...Array(16).fill(5)]) {
  const settings = garageSettings({ enabled: true, savingsStrategy, protection: { approved: true } });
  const model = assignGaragePlanningEvidence(createGarageModel({ seedAt: NOW, roomTargetC: 10 }));
  model.normalReference.interceptC = 10; model.normalReference.frontC = 9;
  return { now: NOW, settings, model,
    observation: { at: NOW, rearAt: NOW, frontAt: NOW, rearC: 10, frontC: 9,
      outdoorC: 8, available: true, baselineVerified: true, doorFront: false },
    exposure: knownGarageReserve(settings, { at: NOW, rearC: 10, frontC: 9 }), restorationDelayMs: 2 * MINUTE,
    prices: values.map((price, i) => ({ start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, priceCtPerKwh: price })),
    forecast: [{ start: NOW, end: NOW + values.length * HOUR, outdoorC: 8, issuedAt: NOW }] };
}
const hours = plan => (plan.plannedReductionUntil - plan.reductionFrom) / HOUR;
function advance(args, at) {
  args.now = at;
  Object.assign(args.observation, { at, rearAt: at, frontAt: at });
  args.exposure = knownGarageReserve(args.settings, { at, rearC: 10, frontC: 9 });
}

test('named strategies share explicit economic rules and never change protection', () => {
  for (const [savingsStrategy, minimumBenefitEur, retainedBenefitFraction] of [
    ['gentle', .75, .6], ['balanced', .5, .8], ['savings', .25, 1],
  ]) {
    const settings = garageSettings({ savingsStrategy });
    assert.deepEqual(garageSavingsPreference(settings), { minimumBenefitEur, retainedBenefitFraction });
    assert.deepEqual(settings.protection, garageSettings().protection);
  }
  assert.equal(garageSavingsPreference({ minSavingsEur: 2, savingsStrategy: 'gentle' }).minimumBenefitEur, 3);
});

test('gentle, balanced and more-savings strategies select progressively longer worthwhile windows', () => {
  const plans = ['gentle', 'balanced', 'savings'].map(value => planGarage(candidate(value)));
  assert.deepEqual(plans.map(hours), [2.5, 3.25, 4]);
  assert.deepEqual(plans.map(plan => (plan.reductionFrom - NOW) / HOUR), [1.5, .75, 0]);
  for (const [index, preference] of ['gentle', 'balanced', 'savings'].entries()) {
    const policy = garageSavingsPreference({ savingsStrategy: preference });
    assert.ok(plans[index].scoreEur >= plans[2].scoreEur * policy.retainedBenefitFraction);
    assert.ok(plans[index].scoreEur > policy.minimumBenefitEur);
    assert.equal(plans[index].preferenceVersion, GARAGE_PREFERENCE_VERSION);
  }
});

test('the monetary hurdle admits smaller opportunities only at higher preferences; gentle still starts sufficiently valuable pauses', () => {
  for (const [price, expected] of [[150, ['normal', 'normal', 'target']],
    [200, ['normal', 'target', 'target']], [300, ['target', 'target', 'target']]]) {
    assert.deepEqual(['gentle', 'balanced', 'savings'].map(value => planGarage(candidate(value, [price, ...Array(12).fill(5)])).nextAction), expected);
  }
});

test('equal-length qualifying windows prefer greater benefit, then the earlier start', () => {
  const equal = planGarage(candidate('gentle', [300, ...Array(10).fill(5), 300, ...Array(16).fill(5)]));
  assert.equal(hours(equal), 1); assert.equal(equal.reductionFrom, NOW);
  const later = planGarage(candidate('balanced', [150, ...Array(10).fill(5), 200, ...Array(16).fill(5)]));
  assert.equal(hours(later), 1); assert.equal(later.reductionFrom, NOW + 11 * HOUR);
});

test('every strategy retains minimum reduction time, forecast coverage, fresh pipes and explicit protection approval', () => {
  for (const savingsStrategy of ['gentle', 'balanced', 'savings']) for (const change of [
    args => { args.forecast[0].end = NOW + args.settings.minOffMs - MINUTE; },
    args => { args.forecast = []; },
    args => { args.observation.frontC = null; },
    args => { args.settings.protection.approved = false; },
    args => { args.restorationDelayMs = null; },
  ]) {
    const args = candidate(savingsStrategy); change(args);
    assert.equal(planGarage(args).nextAction, 'normal');
  }
});

test('scheduled windows stay fixed until admission and renewals do not repeatedly shorten their remaining duration', () => {
  for (const preference of ['gentle', 'balanced']) {
    const args = candidate(preference), planned = planGarage(args);
    args.scheduledOpportunity = planned;
    for (let at = NOW + 7 * MINUTE; at < planned.reductionFrom; at += 7 * MINUTE) {
      advance(args, at);
      const waiting = planGarage(args);
      assert.equal(waiting.state, 'waiting');
      assert.equal(waiting.reductionFrom, planned.reductionFrom); assert.equal(waiting.plannedReductionUntil, planned.plannedReductionUntil);
    }
    advance(args, planned.reductionFrom);
    assert.equal(planGarage(args).nextAction, 'target');
    args.scheduledOpportunity = null;
    for (let at = planned.reductionFrom + 7 * MINUTE; at < planned.plannedReductionUntil; at += 7 * MINUTE) {
      advance(args, at);
      args.observation.available = true;
      args.activeEpisode = { state: 'reducing', reductionStartedAt: planned.reductionFrom, authorizedEndAt: planned.plannedReductionUntil };
      const ongoing = planGarage(args);
      assert.equal(ongoing.nextAction, 'target'); assert.equal(ongoing.reductionUntil, planned.plannedReductionUntil);
    }
  }
});

function runtimeFixture(t, savingsStrategy = 'balanced') {
  const args = candidate(savingsStrategy), store = new Store(':memory:'); let now = NOW;
  const settings = garageSettings({ ...args.settings, minOnMs: 0 });
  appendGarageEntry(store, 'mqtt', 'context', {}, settings, NOW - 1, { key: 'test-planning-seed', seed: args.model });
  store.setState('garage:configuration:mqtt', settings);
  const engine = { latest: {}, lastKnownTemperatures: {}, automationEnabled: () => true };
  const runtime = new GarageRuntime({ store, engine, config: { input: 'mqtt', garage: settings }, clock: () => now });
  const commands = [], safety = [], native = { pauseControl: true, liveControlSupported: true, phase: 'ready', episode: null,
    nativeSettingsReady: true, nativeHeatingReady: true, native: { power: 'on', powerAt: now }, health: { pumpCommunicating: true }, baselineAccepted: true,
    limits: { restorationDelayMs: 2 * MINUTE, maxLeaseMs: 180_000 } };
  runtime.setAdapter({ status: () => native, safetyTick: async data => { safety.push(data); },
    nativeControls: () => ({ available: true, busy: false, settings: {
      fan: { available: true, supported: true, value: 'auto', values: ['auto', 'quiet'] } } }),
    setNativeSetting: async () => {},
    plannerTick: async data => { commands.push(data); }, release: async () => {} });
  // This fixture isolates scheduling; full broker/ACK behavior is covered by room-temperature integration.
  runtime.roomTemperature.targetC = 10; runtime.roomTemperature.prepared = true;
  runtime.roomTemperature.deliveredTarget = () => runtime.automaticTarget?.targetC ?? 10;
  runtime.roomTemperatureTick = () => {};
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

test('runtime preserves a waiting opportunity and starts at its selected time even at gentle strategy', async t => {
  const f = runtimeFixture(t, 'gentle');
  await f.tick(NOW);
  const selected = structuredClone(f.runtime.plan);
  assert.equal(selected.state, 'waiting'); assert.equal(f.runtime.episode, null);
  assert.equal(f.runtime.automaticTarget, null);
  await f.tick(NOW + 7 * MINUTE);
  assert.equal(f.runtime.plan.reductionFrom, selected.reductionFrom);
  await f.tick(selected.reductionFrom);
  assert.equal(f.runtime.plan.nextAction, 'target'); assert.equal(f.runtime.automaticTarget.targetC, f.runtime.settings.reducedRoomTargetC);
  assert.equal(f.runtime.episode.pauseUntil, selected.plannedReductionUntil);
  f.report(selected.reductionFrom + MINUTE); f.runtime.safetyTick();
  assert.ok(f.runtime.automaticTarget, 'Gentle strategy retains the qualified target reduction');
  assert.equal(f.commands.length, 0, 'Price automation cannot dispatch a power lease');
  await f.tick(selected.reductionFrom + MINUTE);
  assert.equal(f.runtime.plan.nextAction, 'target'); assert.equal(f.runtime.plan.targetUntil, selected.plannedReductionUntil);
});

test('runtime cancels waiting windows when protection fails, settings change or price control is paused', async t => {
  const f = runtimeFixture(t);
  await f.tick(NOW);
  assert.ok(f.runtime.scheduledOpportunity);
  delete f.engine.latest.garage_temperature_2;
  f.runtime.tick({ now: NOW, prices: candidate().prices, forecast: candidate().forecast }); await f.runtime.dispatch;
  assert.equal(f.runtime.scheduledOpportunity, null); assert.equal(f.runtime.automaticTarget, null);
  await f.tick(NOW);
  f.runtime.settings.savingsStrategy = 'savings';
  await f.tick(NOW);
  assert.equal(f.runtime.plan.nextAction, 'target', 'A changed preference selects again instead of inheriting the waiting window');
  const paused = runtimeFixture(t);
  await paused.tick(NOW);
  await paused.runtime.setTemporary({ pauseUntil: new Date(NOW + HOUR).toISOString() });
  await paused.tick(NOW + MINUTE);
  assert.equal(paused.runtime.scheduledOpportunity, null); assert.equal(paused.runtime.automaticTarget, null);
});

test('daily starts and minimum normal-heating time still block opportunities at more-savings strategy', async t => {
  const f = runtimeFixture(t, 'savings');
  f.runtime.settings.minOnMs = 3 * HOUR;
  await f.tick(NOW);
  assert.equal(f.runtime.plan.reason, 'minimum-normal-heating-time'); assert.equal(f.runtime.automaticTarget, null);
  f.runtime.settings.minOnMs = 0;
  f.store.cycle('garage:mqtt', { id: 'already-attempted', startedAt: NOW - MINUTE, status: 'incomplete', endedAt: NOW });
  await f.tick(NOW);
  assert.equal(f.runtime.plan.reason, 'daily-pause-limit'); assert.equal(f.runtime.automaticTarget, null);
});

test('accepted Normal and native selections discard the waiting window before automatic controls expire', async t => {
  for (const action of ['normal', 'native']) {
    const f = runtimeFixture(t);
    await f.tick(NOW);
    const previousStart = f.runtime.plan.reductionFrom;
    f.report(NOW + 7 * MINUTE);
    if (action === 'normal') await f.runtime.setHeating({ mode: 'normal' });
    else { f.runtime.roomTemperature.targetC = null; await f.runtime.setNativeSettings({ setting: 'fan', value: 'quiet' });
      f.runtime.roomTemperature.targetC = 10; }
    assert.equal(f.runtime.scheduledOpportunity, null, action);
    await f.tick(NOW + 7 * MINUTE);
    assert.equal(f.runtime.manual, null, 'An unpaused Normal selection ends at the next controller update');
    assert.notEqual(f.runtime.plan.reductionFrom, previousStart, 'The next update selects afresh');
  }
});

test('an asynchronous native request cannot repopulate a discarded waiting window', async t => {
  const f = runtimeFixture(t);
  await f.tick(NOW);
  let finish;
  f.runtime.adapter.setNativeSetting = () => new Promise(resolve => { finish = resolve; });
  f.runtime.roomTemperature.targetC = null;
  const request = f.runtime.setNativeSettings({ setting: 'fan', value: 'quiet' });
  assert.equal(f.runtime.scheduledOpportunity, null);
  assert.equal(f.runtime.manualBusy, true);
  await f.tick(NOW + MINUTE);
  assert.equal(f.runtime.scheduledOpportunity, null);
  finish(); await request;
});
