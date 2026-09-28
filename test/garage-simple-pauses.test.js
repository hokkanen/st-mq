import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { garageSettings, GARAGE_PREFERENCE_VERSION } from '../src/garage/settings.js';
import { garagePauseStartReason } from '../src/garage/door-state.js';
import { createGarageModel } from '../src/garage/model.js';
import { planGarage } from '../src/garage/planner.js';
import { appendGarageEntry, replayGarageJournal } from '../src/garage/learning.js';
import { startGarageAssessment, updateGarageAssessment, completeGarageAssessment } from '../src/garage/episodes.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';

const HOUR = 3_600_000, MINUTE = 60_000, NOW = Date.parse('2026-01-01T10:00:00Z');
function candidate(extra = {}) {
  const settings = garageSettings({ enabled: true, savingsStrategy: 'savings', protection: { approved: true } });
  const model = assignGaragePlanningEvidence(createGarageModel({ seedAt: NOW, roomTargetC: 10 }));
  model.normalReference.interceptC = 10; model.normalReference.frontC = 9;
  const observation = { at: NOW, rearAt: NOW, frontAt: NOW, rearC: 10, frontC: 9,
    outdoorC: -5, available: true, baselineVerified: true, doorFront: false };
  return { now: NOW, settings, model, observation,
    exposure: knownGarageReserve(settings, { at: NOW, rearC: 10, frontC: 9 }), restorationDelayMs: 2 * MINUTE,
    prices: [150, 150, 5, 5, 5, 5, 5, 5, 5, 5].map((price, i) => ({
      start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, priceCtPerKwh: price })),
    forecast: [{ start: NOW, end: NOW + 10 * HOUR, outdoorC: -5, issuedAt: NOW }], ...extra };
}

test('one worthwhile continuous target reduction has no preheat and repays an explicit recovery allowance', () => {
  const args = candidate(), plan = planGarage(args);
  assert.equal(plan.nextAction, 'target');
  assert.equal(plan.reductionUntil, NOW + 2 * HOUR);
  assert.equal(plan.recoveryKwh, plan.avoidedKwh * 1.25);
  assert.ok(plan.scoreEur > args.settings.minSavingsEur);
  assert.equal(plan.steps.filter((row, i, rows) => row.demandReduced && (i === 0 || !rows[i - 1].demandReduced)).length, 1);
  assert.ok(plan.steps.every(row => row.rearC <= args.observation.rearC && Number.isFinite(row.targetC)));
  assert.ok(!plan.steps.at(-1).demandReduced, 'protection includes the heating response delay after restoring the normal target');
});

test('minor and flat price differences preserve normal heating', () => {
  for (const series of [[8, 7], [200, 200], [-10, -10]]) {
    const args = candidate(); args.prices = args.prices.map((row, i) => ({ ...row, priceCtPerKwh: series[Math.min(i, 1)] }));
    assert.equal(planGarage(args).nextAction, 'normal');
  }
});

test('open and unknown configured doors share the strictly below 2 C admission limit', () => {
  for (const outdoorC of [-10, 1.99, 2, 2.01, 4, null, undefined, NaN]) {
    for (const open of [false, true, null, undefined, 'closed']) {
      const reason = !Number.isFinite(outdoorC) ? 'outdoor-temperature-unavailable'
        : outdoorC < 2 && open !== false ? 'garage-door-open-or-unknown-below-2c' : null;
      assert.equal(garagePauseStartReason({ outdoorC, doors: {
        first: { required: true, open }, second: { required: true, open: false },
      } }), reason);
      assert.equal(garagePauseStartReason({ outdoorC, doorEvidenceRequired: true, doorFront: open }), reason);
    }
  }
  assert.equal(garagePauseStartReason({ outdoorC: -10, doors: { unused: { required: false, open: null } } }), null);
  const args = candidate(); args.observation.doorFront = true;
  assert.equal(planGarage(args).reason, 'garage-door-open-or-unknown-below-2c');
  args.activeEpisode = { state: 'reducing', reductionUntil: NOW + 2 * HOUR };
  assert.equal(planGarage(args).nextAction, 'target', 'opening reassesses actual protection without unconditional cancellation');
  Object.assign(args.observation, { doorEvidenceRequired: true, doorFront: null });
  assert.equal(planGarage(args).nextAction, 'target', 'unknown doors receive the same ongoing protection treatment');
  args.observation.frontC = null;
  assert.equal(planGarage(args).nextAction, 'normal', 'ongoing permission never overrides missing protection evidence');
});

test('warm unknown doors allow a worthwhile plan, and a scheduled plan rechecks the cold boundary', () => {
  const args = candidate();
  Object.assign(args.observation, { outdoorC: 2, doorEvidenceRequired: true, doorFront: null,
    doors: { first: { required: true, open: null } } });
  args.forecast = args.forecast.map(row => ({ ...row, outdoorC: 2 }));
  const plan = planGarage(args);
  assert.equal(plan.nextAction, 'target');
  args.scheduledOpportunity = plan;
  args.observation.outdoorC = 1.99;
  assert.equal(planGarage(args).reason, 'garage-door-open-or-unknown-below-2c');
  args.observation.outdoorC = null;
  assert.equal(planGarage(args).reason, 'outdoor-temperature-unavailable');
});

test('ongoing target reduction cannot extend the original endpoint across drifting planner ticks', () => {
  const args = candidate(), endpoint = NOW + 2 * HOUR;
  args.now += 7 * MINUTE;
  Object.assign(args.observation, { at: args.now, rearAt: args.now, frontAt: args.now });
  args.exposure = knownGarageReserve(args.settings, { at: args.now, rearC: 10, frontC: 9 });
  args.activeEpisode = { state: 'reducing', reductionUntil: endpoint };
  const plan = planGarage(args);
  assert.equal(plan.nextAction, 'target'); assert.ok(plan.reductionUntil <= endpoint);
  assert.equal(plan.reductionUntil, endpoint);
});

test('current, unknown and forecast charging do not affect new, scheduled or continuing pauses', () => {
  for (const phase of ['new', 'scheduled', 'continuing']) {
    const args = candidate(), initial = planGarage(args);
    if (phase === 'scheduled') args.scheduledOpportunity = initial;
    if (phase === 'continuing') args.activeEpisode = { state: 'reducing', reductionUntil: initial.reductionUntil };
    const original = planGarage(args);
    for (const charging of [
      { ev1Active: true, ev1Kw: 11, ev2Active: true, ev2Kw: 22 },
      { ev1Active: false, ev1Kw: 0, ev2Active: false, ev2Kw: 0 },
      { ev1Active: null, ev1Kw: null, ev2Active: null, ev2Kw: null,
        evEvidenceRequired: { ev1: true, ev2: true } },
    ]) {
      Object.assign(args.observation, charging);
      args.forecast = args.forecast.map(row => ({ ...row, ev1Kw: 22, ev2Kw: 22, powerKw: 99 }));
      assert.deepEqual(planGarage(args), original, phase);
    }
  }
});

test('forecast must cover the pause and useful-heating delay', () => {
  const args = candidate(); args.forecast[0].end = NOW + HOUR;
  assert.equal(planGarage(args).nextAction, 'normal');
});

function runtimeFixture(t, extra = {}, seed = null) {
  const store = new Store(':memory:'); let now = NOW, owner = true;
  const engine = { latest: {}, lastKnownTemperatures: {}, automationEnabled: () => true };
  const config = { input: 'mqtt', garage: garageSettings({ enabled: true, savingsStrategy: 'savings', protection: { approved: true }, ...extra }) };
  if (seed) {
    appendGarageEntry(store, 'mqtt', 'context', {}, config.garage, NOW - 1, { key: 'explicit-test-seed', seed });
    store.setState('garage:configuration:mqtt', config.garage);
  }
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now, canControl: () => owner });
  const calls = [], native = { pauseControl: false, health: { pumpCommunicating: true },
    native: { power: 'on', powerAt: now }, nativeSettingsReady: true, nativeHeatingReady: true, baselineAccepted: true, limits: { restorationDelayMs: MINUTE } };
  runtime.setAdapter({ status: () => native, release: async data => calls.push(data), safetyTick: async () => {} });
  const reports = () => {
    native.native.powerAt = now;
    for (const [signal, value] of [['garage_temperature', 10], ['garage_temperature_2', 9], ['outdoor_temperature', -5]])
      engine.latest[signal] = { source: 'test', device: signal, signal, value, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] };
  };
  reports(); runtime.exposure = knownGarageReserve(config.garage, { at: now, rearC: 10, frontC: 9 });
  t.after(async () => { await runtime.close({ restore: false }); store.close(); });
  return { runtime, store, config, engine, calls, native, reports, at: value => { now = value; }, owner: value => { owner = value; } };
}

test('minimum normal heating requires continuous fresh ON evidence and restarts on a gap', t => {
  const f = runtimeFixture(t); f.runtime.safetyTick();
  assert.equal(f.runtime.normalHeatingSince, NOW);
  for (let i = 1; i < 181; i++) { f.at(NOW + i * MINUTE); f.reports(); f.runtime.safetyTick(); }
  assert.equal(f.runtime.status().planningLimits.normalHeatingReadyAt, NOW + 3 * HOUR);
  f.at(NOW + 185 * MINUTE); f.reports(); f.runtime.safetyTick();
  assert.equal(f.runtime.normalHeatingSince, NOW + 185 * MINUTE);
  f.native.native.power = 'off'; f.runtime.safetyTick();
  assert.equal(f.runtime.normalHeatingSince, null);
});

test('daily limit counts every attempted episode by its Finnish start day, including incomplete attempts', t => {
  const f = runtimeFixture(t);
  for (const [id, startedAt] of [['before', Date.parse('2025-12-31T21:59:00Z')],
    ['today', Date.parse('2025-12-31T22:00:00Z')], ['tomorrow', Date.parse('2026-01-01T22:00:00Z')]])
    f.store.cycle('garage:mqtt', { id, startedAt, status: 'incomplete', endedAt: startedAt + MINUTE });
  assert.equal(f.runtime.pauseStartsToday(NOW), 1);
});

test('unmetered completed savings pay the full recovery energy; metered recovery is not charged twice', () => {
  for (const metered of [false, true]) {
    const model = createGarageModel({ seedAt: NOW, roomTargetC: 10 });
    const first = { at: NOW, rearC: 10, frontC: 10, outdoorC: 0, available: true, demandReduced: true, roomTargetC: 10, effectiveTargetC: 5 };
    let account = startGarageAssessment(model, first);
    for (let minute = 1; minute <= 240; minute++) {
      const on = minute >= 60;
      account = updateGarageAssessment(account, model, { ...first, at: NOW + minute * MINUTE, demandReduced: !on, effectiveTargetC: on ? 10 : 5 },
        { priceCtPerKwh: minute <= 60 ? 100 : 5, recordedKwh: metered ? minute <= 60 ? 0 : 1 / 60 : null });
      if (minute === 60) assert.equal(completeGarageAssessment(account), null);
    }
    assert.ok(Math.abs(account.recoveryAllowanceKwh - (metered ? .625 : .46875)) < 1e-8);
    assert.ok(Math.abs(account.recoveryAllowanceKwh - account.recoveryAccountedKwh) < 1e-8);
    assert.ok(Math.abs(account.actualKwh - (metered ? 3 : 2.09375)) < 1e-8);
    account.actualState = structuredClone(account.referenceState);
    assert.ok(completeGarageAssessment(account));
  }
});

test('charging, unknown configured charging, baseline loss and source changes retain costs but withhold savings', () => {
  const model = createGarageModel({ seedAt: NOW, roomTargetC: 10 });
  const first = { at: NOW, rearC: 10, frontC: 9, outdoorC: 0, available: true, demandReduced: true, roomTargetC: 10, effectiveTargetC: 5,
    baselineAccepted: true, sourceEpoch: 'first' };
  for (const change of [{ ev1Kw: 11 }, { ev2Active: true }, { inputDisturbed: true },
    { ev1Kw: null, evEvidenceRequired: { ev1: true } }, { baselineAccepted: false }, { sourceEpoch: 'changed' }]) {
    const account = updateGarageAssessment(startGarageAssessment(model, first), model,
      { ...first, at: NOW + MINUTE, ...change }, { recordedKwh: .01, priceCtPerKwh: 100 });
    assert.equal(account.qualified, false, JSON.stringify(change));
    assert.equal(account.actualKwh, .01); assert.equal(completeGarageAssessment(account), null);
  }
});

test('invalid observed electricity cannot evade unmetered recovery allowance', () => {
  const model = createGarageModel({ seedAt: NOW, roomTargetC: 10 });
  for (const powerKw of [-1, 9, NaN]) {
    let account = startGarageAssessment(model, { at: NOW, rearC: 10, frontC: 10, outdoorC: 0, available: true, demandReduced: true, roomTargetC: 10, effectiveTargetC: 5 });
    for (let minute = 1; minute <= 240; minute++) account = updateGarageAssessment(account, model,
      { at: NOW + minute * MINUTE, rearC: 10, frontC: 10, outdoorC: 0, available: true, demandReduced: minute < 60, roomTargetC: 10, effectiveTargetC: minute < 60 ? 5 : 10,
        powerKw, powerQuality: 'provisional' }, { recordedKwh: -1, priceCtPerKwh: 10 });
    assert.ok(Math.abs(account.actualKwh - 2.09375) < 1e-8);
    assert.equal(account.recordedMs, 0); assert.ok(account.uncertaintyCents > 0);
  }
});

test('busy tick cannot create a phantom episode or consume a daily start', t => {
  const f = runtimeFixture(t, { minOnMs: 0 }, candidate().model);
  f.runtime.roomTemperature.targetC = 10; f.runtime.roomTemperature.prepared = true;
  f.runtime.roomTemperatureTick = () => {};
  f.runtime.manualBusy = true;
  const args = candidate(); f.runtime.tick({ now: NOW, prices: args.prices, forecast: args.forecast });
  assert.equal(f.runtime.plan.nextAction, 'target');
  assert.equal(f.runtime.episode, null); assert.equal(f.runtime.pauseStartsToday(), 0);
});

test('safety-loop charging pulse is committed once even when both temperature reports are unchanged', t => {
  const f = runtimeFixture(t), original = f.runtime.read.bind(f.runtime);
  let charging = false;
  f.runtime.read = now => ({ ...original(now), ev1Active: charging });
  f.runtime.safetyTick(); f.runtime.captureSample(NOW, f.runtime.read());
  charging = true; f.at(NOW + 10_000); f.runtime.safetyTick();
  charging = false; f.at(NOW + 20_000); f.runtime.safetyTick();
  f.at(NOW + MINUTE); f.reports(); f.runtime.safetyTick(); f.runtime.captureSample(NOW + MINUTE, f.runtime.read());
  assert.equal(f.runtime.checkpoint.model.previous.inputDisturbed, true);
  assert.equal(f.runtime.inputDisturbed, false);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
});

test('ordinary native OFF and ON boundaries preserve a clean learning episode', t => {
  const f = runtimeFixture(t, {}, candidate().model);
  for (let minute = 0; minute <= 4; minute++) {
    const at = NOW + minute * MINUTE; f.at(at); f.reports();
    f.native.native.power = minute >= 1 && minute <= 3 ? 'off' : 'on';
    f.runtime.safetyTick(); f.runtime.captureSample(at, f.runtime.read());
  }
  assert.equal(f.runtime.checkpoint.model.validation.active.clean, true);
  assert.equal(f.runtime.checkpoint.model.previous.inputDisturbed, false);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
});

test('changed-weather recovery closes without savings after sustained normal operation and resets references in replay', t => {
  const model = candidate().model, f = runtimeFixture(t, {}, model);
  const first = { at: NOW, rearC: 10, frontC: 9, outdoorC: 0, available: true };
  f.runtime.startEpisode('test-recovery', { preferenceVersion: GARAGE_PREFERENCE_VERSION, policyVersion: 'garage-room-target-v1', targetUntil: NOW + HOUR }, first, NOW);
  f.runtime.episode.phase = 'recovery'; f.runtime.episode.accounting.qualified = false;
  f.runtime.protection = { requiredFresh: true };
  for (let minute = 0; minute <= 480; minute++) {
    const at = NOW + minute * MINUTE; f.at(at);
    f.runtime.exposure = knownGarageReserve(f.config.garage, { at, rearC: 7, frontC: 6 });
    f.runtime.advanceEpisode({ at, rearAt: at, frontAt: at, rearC: 7, frontC: 6, outdoorC: -10,
      available: true, demandReduced: false, baselineAccepted: true }, [], at);
    if (minute < 480) assert.ok(f.runtime.episode);
  }
  assert.equal(f.runtime.episode, null);
  const completed = f.store.cycles({ input: 'garage:mqtt' })[0];
  assert.equal(completed.status, 'incomplete'); assert.equal(completed.assessment, null);
  assert.equal(completed.reason, 'sustained-normal-operation-reference-reset');
  assert.equal(f.runtime.checkpoint.model.normalReference.initialized, false);
  assert.equal(f.runtime.checkpoint.model.previous, null);
  assert.deepEqual(f.runtime.checkpoint.model.rear, model.rear, 'temperature requalification retains cooling evidence');
  assert.equal(f.runtime.checkpoint.model.validation.active, null);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
});

test('incomplete recovery reset is atomic when clearing the saved episode fails', t => {
  const model = candidate().model, f = runtimeFixture(t, {}, model);
  f.runtime.startEpisode('test-atomic-recovery', { preferenceVersion: GARAGE_PREFERENCE_VERSION, policyVersion: 'garage-room-target-v1', targetUntil: NOW + HOUR },
    { at: NOW, rearC: 10, frontC: 9, outdoorC: 0, available: true }, NOW);
  const before = structuredClone(f.runtime.checkpoint), original = f.store.setState;
  f.store.setState = function (key, value) {
    if (key === f.runtime.keys.episode && value === null) throw new Error('test clear failure');
    return original.call(this, key, value);
  };
  assert.throws(() => f.runtime.finishEpisode('incomplete', 'test-reference-reset', null,
    { resetNormalReference: true }), /clear failure/);
  f.store.setState = original;
  assert.ok(f.runtime.episode); assert.deepEqual(f.runtime.checkpoint, before);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), before);
  assert.equal(f.store.cycles({ input: 'garage:mqtt' })[0].status, 'active');
});

test('sustained normal recovery cannot close on stale inputs, unaccepted baseline or unresolved restoration', t => {
  for (const blocker of ['stale', 'baseline', 'restore', 'pipe']) {
    const model = candidate().model, f = runtimeFixture(t, {}, model);
    const first = { at: NOW, rearC: 10, frontC: 9, outdoorC: 0, available: true };
    f.runtime.startEpisode(`test-${blocker}`, { preferenceVersion: GARAGE_PREFERENCE_VERSION, policyVersion: 'garage-room-target-v1', targetUntil: NOW + HOUR }, first, NOW);
    f.runtime.episode.phase = 'recovery'; f.runtime.episode.accounting.qualified = false;
    f.runtime.protection = { requiredFresh: blocker !== 'stale' };
    f.native.restorePending = blocker === 'restore';
    for (let minute = 0; minute <= 481; minute++) {
      const at = NOW + minute * MINUTE; f.at(at);
      f.runtime.exposure = knownGarageReserve(f.config.garage, { at, rearC: 7, frontC: 6 });
      if (blocker === 'pipe') f.runtime.exposure.locations.front.uncertain = true;
      f.runtime.advanceEpisode({ at, rearAt: at, frontAt: at, rearC: 7, frontC: 6,
        outdoorC: -10, available: true, demandReduced: false, baselineAccepted: blocker !== 'baseline' }, [], at);
    }
    assert.ok(f.runtime.episode, blocker);
    assert.equal(f.runtime.checkpoint.model.normalReference.initialized, true);
  }
});

test('a healthy target reduction beyond seven days retains its evidence until actual restoration', t => {
  const model = candidate().model, f = runtimeFixture(t, {}, model);
  const first = { at: NOW, rearC: 10, frontC: 9, outdoorC: 8, available: true, demandReduced: true, roomTargetC: 10, effectiveTargetC: 5,
    baselineAccepted: true, priceCtPerKwh: 100, priceStartAt: NOW - HOUR, priceEndAt: NOW + HOUR };
  f.runtime.startEpisode('long-pause-reporting', { preferenceVersion: GARAGE_PREFERENCE_VERSION, policyVersion: 'garage-room-target-v1', targetUntil: NOW + 24 * HOUR, recoveryHours: 270 }, first, NOW);
  f.runtime.automaticTarget = { id: 'long-pause-reporting', targetC: 5, until: NOW + 24 * HOUR };
  f.native.native.power = 'on';
  const episode = f.runtime.episode;
  episode.startedAt = NOW - 8 * 24 * HOUR;
  episode.accounting.reducedHours = 8 * 24;
  episode.accounting.at = NOW - MINUTE;
  episode.accounting.previous = { ...first, at: NOW - MINUTE };
  f.runtime.advanceEpisode(first, [], NOW);
  assert.equal(f.runtime.episode.phase, 'pause');
  assert.equal(f.runtime.episode.accounting.qualified, true);
  assert.notEqual(f.runtime.episode.reason, 'recovery-evidence-timeout');
});

test('long-pause changed-weather recovery cannot close at the old eight-hour fallback', t => {
  const model = candidate().model, f = runtimeFixture(t, {}, model);
  f.runtime.startEpisode('long-pause-recovery', { preferenceVersion: GARAGE_PREFERENCE_VERSION, policyVersion: 'garage-room-target-v1', targetUntil: NOW, recoveryHours: 30 },
    { at: NOW, rearC: 10, frontC: 9, outdoorC: 0, available: true }, NOW);
  f.runtime.episode.phase = 'recovery'; f.runtime.episode.accounting.qualified = false;
  f.runtime.episode.accounting.reducedHours = 24;
  f.runtime.protection = { requiredFresh: true };
  for (let minute = 0; minute <= 30 * 60; minute++) {
    const at = NOW + minute * MINUTE; f.at(at);
    f.runtime.exposure = knownGarageReserve(f.config.garage, { at, rearC: 7, frontC: 6 });
    f.runtime.advanceEpisode({ at, rearAt: at, frontAt: at, rearC: 7, frontC: 6, outdoorC: -10,
      available: true, demandReduced: false, baselineAccepted: true }, [], at);
    if (minute < 30 * 60) assert.ok(f.runtime.episode);
  }
  assert.equal(f.runtime.episode, null);
  const completed = f.store.cycles({ input: 'garage:mqtt' })[0];
  assert.equal(completed.status, 'incomplete'); assert.equal(completed.assessment, null);
  assert.equal(completed.reason, 'sustained-normal-operation-reference-reset');
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
});
