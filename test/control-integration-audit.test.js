import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { CONTROL_DEFAULTS, validateSettings } from '../src/app/config.js';
import { LEARNING_ALGORITHM, replayLearningJournal } from '../src/app/committed-learning.js';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { delayed = false, automationEnabled = true, startAt = Date.parse('2026-09-07T21:00:00Z') } = {}) {
  const store = new Store(':memory:'), commands = [], pending = [], circulation = [];
  let now = startAt, indoorC = 21.2;
  const config = { input: 'mqtt', settings: validateSettings({ comfort: { targetC: 21, maxDropC: 2, maxRiseC: 2 } }),
    control: { ...CONTROL_DEFAULTS, learningTrials: false } };
  const transport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publish(batch) {
    commands.push({ at: now, batch: [...batch] });
    return delayed ? new Promise(resolve => pending.push(resolve)) : Promise.resolve({ status: 'mqtt', sent: true, actual: null });
  }, publishDhwr:async on=>{circulation.push({at:now,on});return {status:'mqtt',sent:true};} };
  const engine = new Engine({ store, config, commandTransport: transport, clock: () => now });
  engine.automation.set('home', automationEnabled);
  const ingest = (signal, value) => engine.ingest({ source: signal === 'outdoor_temperature' ? 'fmi' : 'synthetic',
    device: 'invented-house', signal, value, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] });
  const intervals = Array.from({ length: 24 }, (_, index) => ({ start: now + index * 15 * MINUTE,
    end: now + (index + 1) * 15 * MINUTE, outdoorC: 10, solarRadiationWm2: 0, price: index === 0 ? 2000 : 1 }));
  store.setState('provider:market', { fetchedAt: now, intervals: intervals.map(row => ({ ...row,
    spotCtPerKwh: row.price, unit: 'c/kWh', vatIncluded: false })) });
  store.setState('provider:weather', { issuedAt: now, fetchedAt: now, forecast: [{ start: now,
    end: now + 6 * HOUR, outdoorC: 10, solarRadiationWm2: 0, issuedAt: now, fetchedAt: now, source: 'synthetic' }] });
  store.setState('contract:mqtt', { mode: 'billing', periods: [{ from: 0, to: null, marginCtPerKwh: 0,
    taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night', transferRates: { vatIncluded: false,
      dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] });
  ingest('indoor_temperature', 21.2); ingest('outdoor_temperature', 10);
  t.after(async () => {
    for (const resolve of pending.splice(0)) resolve({ status: 'mqtt', sent: true, actual: null });
    await engine.dispatchPending;
    engine.executor.closed = true;
    clearTimeout(engine.executor.timer);
    await engine.h66?.close();
    store.close();
  });
  return { store, engine, config, commands, circulation, get now() { return now; },
    room(value) { indoorC=value;ingest('indoor_temperature',indoorC); },
    advance(milliseconds) { now += milliseconds; ingest('indoor_temperature', indoorC); ingest('outdoor_temperature', 10); },
    async acknowledge() {
      await nextTurn();
      assert.equal(pending.length, 1, 'Exactly one synthetic command batch is awaiting acknowledgement');
      pending.shift()({ status: 'mqtt', sent: true, actual: null });
      await engine.dispatchPending;
    },
    async settle() { await engine.dispatchPending; await nextTurn(); },
    plan() {
      // Deliberate synthetic evidence isolates integration timing and ownership;
      // statistical identification and forecast acceptance have separate tests.
      const model = initialAdaptiveModel(config.control);
      model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
        parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
      model.equipmentResponse = { phases: { reduction: { ratio: 0.1, trainingEpisodes: 3, treatmentKey: 'reduction-only-v1' } },
        validation: { phases: { reduction: { accepted: true, episodes: 3, maeDuty: 0.05, maxDurationHours: 0.5, treatmentKey: 'reduction-only-v1' } } } };
      model.uncertainty = { points: [{ hours: 0.25, errorC: 0.1 }, { hours: 24, errorC: 0.1 }], extrapolationCPerHour: 0.05 };
      model.forecastValidation = { accepted: true, episodes: 3, maxReductionHours: 0.5 };
      engine.checkpoint = restoreAdaptiveCheckpoint(null, config.control);
      engine.checkpoint.model = model;
      const schedule = { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + 15 * MINUTE, roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
      const args = { model, intervals, initialState: { indoorC: 21.2, reserveC: 21.2 }, targetC: 21, config: config.control };
      engine.pendingPlan = { ...args, schedule, reference: null, referenceLabel: 'continuous normal operation',
        prediction: evaluateCycle({ ...args, schedule }), referencePrediction: evaluateCycle(args), trial: false };
    },
    native() {
      const values = { '0203': 19, '0212': 47, '0208': 62, '2201': 1, '1A01': 1, '1A07': 0, '3104': 0 };
      const writes = [], decoder = createH66Decoder({ deviceId: 'invented-gateway' });
      const receive = (register, value) => {
        values[register] = value;
        const decoded = decoder.decode({ topic: `invented-gateway/HP/${register}`, payload: String(value), receivedAt: now });
        h66.ingest(decoded);
        engine.ingest({ source: 'husdata-h66', device: 'invented-gateway', signal: decoded.signal, value: decoded.value,
          unit: decoded.unit, sourceTime: now, receivedAt: now, quality: decoded.issues,
          raw: { usableForControl: decoded.usableForControl, verified: true, retained: false } });
      };
      const h66 = createH66Controller({ deviceId: 'invented-gateway', store, clock: () => now,
        config: { writeEnabled: true, readbackTimeoutMs: 100 }, publish: async (topic, payload) => {
          const register = topic.split('/').at(-1), value = Number(payload);
          writes.push({ at: now, register, value });
          queueMicrotask(() => receive(register, value));
        } });
      const refresh = () => { for (const [register, value] of Object.entries(values)) receive(register, value); };
      h66.setConnected(true); refresh(); engine.setH66(h66);
      return { h66, values, writes, receive, refresh };
    },
  };
}

test('a delayed acknowledgement starts cycle accounting at actual completion', async t => {
  const r = setup(t, { delayed: true }); r.plan();
  const requestedAt = r.now, status = r.engine.tick();
  assert.equal(status.execution.status, 'pending');
  assert.equal(status.decision.phase, 'reduction');
  assert.equal(r.engine.cycles.active(), null);
  r.advance(20_000);
  await r.acknowledge();
  const cycle = r.engine.cycles.active();
  assert.ok(cycle, 'Confirmed delivery creates the cycle');
  assert.equal(cycle.startedAt, r.now);
  assert.notEqual(cycle.startedAt, requestedAt);
  assert.equal(cycle.lastSample.timestamp, r.now);
  assert.equal(cycle.lastSample.windowStart, r.now);
  assert.equal(cycle.lastSample.windowEnd, r.now);
  assert.equal(cycle.plan.intervals[0].start, r.now);
  assert.equal(cycle.actual.coveredHours, 0);
});

test('settings changed while delivery is pending remain current in the acknowledged context', async t => {
  const r = setup(t, { delayed: true }); r.plan(); r.engine.tick();
  r.advance(5_000);
  r.engine.updateSettings({ ...r.engine.settings, occupancy: { mode: 'away', returnAt: null },
    comfort: { ...r.engine.settings.comfort, targetC: 22.4 } });
  r.advance(15_000);
  await r.acknowledge();
  const contexts = r.store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
    .filter(entry => entry.payload.value.controlContext);
  const latest = contexts.at(-1);
  assert.equal(latest.at, r.now);
  assert.equal(latest.payload.value.controlContext.phase, 'reduction');
  assert.equal(latest.payload.value.controlContext.regime, 'away');
  assert.equal(latest.payload.value.controlContext.targetC, 22.4);
  assert.equal(r.engine.settings.occupancy.mode, 'away');
  assert.deepEqual(replayLearningJournal(r.store, 'mqtt', null, { rebuild: true }), r.engine.checkpoint);
});

test('a manual mode1 change during compressor-only recovery remains owned by the user', async t => {
  const r = setup(t); r.plan();
  const start = r.engine.tick(); await r.settle();
  assert.ok(r.engine.cycles.active(), JSON.stringify(start.decision.reasons));
  // Native telemetry becomes available before recovery, so the real executor
  // can verify and own its compressor-only mode2 setting.
  const native = r.native();
  r.advance(MINUTE); native.refresh();
  r.engine.cycles.shorten(r.now, 'synthetic-recovery-transition');
  const recovery = r.engine.tick(); await r.settle();
  assert.equal(recovery.decision.phase, 'recovery');
  assert.equal(recovery.decision.recoveryCompressorOnly, true);
  assert.equal(native.values['2201'], 2);
  assert.equal(native.h66.status().obligations['2201'].expected, 2);

  native.receive('2201', 1);
  await nextTurn();
  const revision = native.h66.status().externalChangeRevision, writesBeforeTicks = native.writes.length;
  assert.ok(revision > 0);
  for (let tick = 0; tick < 2; tick++) {
    r.advance(MINUTE); native.refresh();
    const status = r.engine.tick(); await r.settle();
    assert.equal(native.values['2201'], 1);
    assert.equal(native.h66.status().externalChangeRevision, revision);
    assert.ok(status.decision.reasons.includes('native-settings-changed'));
    assert.equal(status.decision.recoveryCompressorOnly, false);
  }
  assert.equal(native.writes.slice(writesBeforeTicks).some(write => write.register === '2201' && write.value === 2), false);
});

test('recovery releases AUX for cold rooms, then restores DHW and scheduled circulation at the same fixed deadline', async t => {
  const r=setup(t,{startAt:Date.parse('2026-09-07T09:00:00Z')});r.plan();
  r.engine.tick();await r.settle();
  const native=r.native();
  r.advance(MINUTE);native.refresh();
  r.engine.cycles.shorten(r.now,'synthetic-recovery-transition');
  let cycle=r.engine.cycles.active();cycle.observerState.reserveC=10;r.engine.cycles.save(cycle);
  let status=r.engine.tick();await r.settle();
  const deadline=r.engine.cycles.active().recoveryHoldUntil;
  assert.equal(status.decision.recoveryHoldActive,true);
  assert.equal(deadline,r.now+HOUR);
  assert.deepEqual(native.values['0212'],40);assert.equal(native.values['0208'],50);
  assert.equal(native.values['2201'],2);assert.deepEqual(r.circulation,[]);
  r.room(20.4);
  for(let step=0;step<6;step++){
    r.advance(10*MINUTE);native.refresh();status=r.engine.tick();await r.settle();
    assert.equal(status.decision.phase,'recovery');
    assert.equal(status.decision.recoveryHoldUntil,deadline,'Polling cannot extend the shared hold');
    assert.equal(status.decision.recoveryCompressorOnly,false,'Cold room permits AUX throughout the rest of recovery');
    if(r.now<deadline){
      assert.equal(status.decision.recoveryHoldActive,true);
      assert.equal(native.values['0212'],40);assert.equal(native.values['0208'],50);
      assert.equal(native.values['2201'],1);assert.deepEqual(r.circulation,[]);
    }
  }
  assert.equal(status.decision.recoveryHoldActive,false);
  assert.equal(native.values['0212'],47);assert.equal(native.values['0208'],62);
  assert.equal(status.decision.dhwr.requested,true);
  assert.deepEqual(r.circulation,[{at:deadline,on:true}]);
});

test('pausing price control during recovery restores native DHW settings for an explicit hot-water override', async t=>{
  const r=setup(t);r.plan();r.engine.tick();await r.settle();
  const native=r.native();r.advance(MINUTE);native.refresh();
  r.engine.cycles.shorten(r.now,'synthetic-recovery-transition');r.engine.tick();await r.settle();
  assert.equal(native.values['0212'],40);assert.equal(native.values['2201'],2);
  r.engine.setTemporary({pauseUntil:new Date(r.now+HOUR).toISOString()});await r.settle();
  assert.equal(r.engine.cycles.active(),null);
  assert.equal(native.values['0212'],47);assert.equal(native.values['0208'],62);assert.equal(native.values['2201'],1);
  await r.engine.testHeating({command:'circulation'});
  assert.deepEqual(r.circulation,[{at:r.now,on:true}]);
});

test('an expiry-timer AUX release stays latched when fresh warm observations arrive',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=setup(t);r.plan();
  const first=r.engine.tick();await r.settle();
  const native=r.native();
  await r.engine.executor.execute({...first.decision,recoveryAuxRestrictionAllowed:true},{automationEnabled: true,now:r.now});
  assert.equal(r.engine.cycles.active()?.plan.executionOwner,r.engine.executor.status().recoveryOnExpiry.owner);
  r.advance(15*MINUTE);native.refresh();
  t.mock.timers.tick(15*MINUTE);await nextTurn();
  if(r.engine.executor.pending)await r.engine.executor.pending;
  const saved=r.engine.executor.status();
  assert.equal(saved.phase,'recovery');
  assert.equal(saved.recoveryAuxReleasedAt,r.now);
  assert.equal(native.values['2201'],1,'An expired temperature assessment permits native AUX');
  assert.equal(native.values['0212'],40);assert.equal(native.values['0208'],50);
  const status=r.engine.tick();await r.settle();
  assert.equal(status.decision.recoveryCompressorOnly,false);
  assert.equal(status.decision.recoveryHoldUntil,saved.recoveryHoldUntil);
  assert.equal(native.values['2201'],1,'Fresh warm observations cannot re-block AUX during the same hold');
});

test('settings updates retain the configured preheat and recovery policy for display',async t=>{
  const r=setup(t,{automationEnabled: false});
  r.engine.updateSettings({...r.engine.settings,preheatRoomBoostC:1});await r.settle();
  assert.equal(r.engine.settings.preheatRoomBoostC,r.engine.control.preheatRoomBoostC);
  assert.equal(r.engine.settings.recoveryHoldMinutes,r.engine.control.recoveryHoldMinutes);
});

test('old algorithm history is refused both at startup and when a background seed arrives', async t => {
  const r = setup(t, { automationEnabled: false });
  const history = restoreAdaptiveCheckpoint(null, r.config.control);
  history.algorithmVersion = 'committed-house-v2';
  history.baselineC = 24; history.comfortReference = { targetC: 24 };
  history.model.parameters.lossPerHour = 0.09;
  history.model.validation = { accepted: true };
  r.store.setState('adaptive:history', history);
  const initial = r.engine.readAdaptive(r.now);
  assert.equal(initial.baselineC, null);
  assert.equal(initial.model.validation, null);
  assert.notEqual(initial.model.parameters.lossPerHour, history.model.parameters.lossPerHour);
  r.engine.tick(); await r.settle();
  r.advance(MINUTE);
  r.store.setState('adaptive:history', history);
  r.engine.tick(); await r.settle();
  assert.equal(r.engine.checkpoint.baselineC, null);
  assert.equal(r.engine.checkpoint.model.validation, null);
  assert.equal(r.store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
    .some(entry => entry.payload.value.historySeed), false);
});

for (const trial of [false, true]) for (const missing of ['treatment', 'recovery']) test(`actual Engine ends ${trial ? 'trial' : 'validated'} continuation when ${missing} coverage disappears`, async t => {
  const r = setup(t); if (trial) r.native(); r.plan();
  if (trial) {
    r.engine.control.learningTrials = true;
    r.engine.checkpoint.samples = Array.from({ length: 4 }, (_, i) => ({ timestamp: new Date(r.now - (4 - i) * 15 * MINUTE).toISOString(),
      indoorC: 21.2, outdoorC: 10, phase: 'normal', regime: 'occupied', quality: [] }));
    r.engine.checkpoint.cursor = r.engine.checkpoint.samples.at(-1).timestamp;
    r.engine.checkpoint.health.usableSamples = 4;
    r.engine.pendingPlan.trial = true;
  }
  const admitted = r.engine.tick(); await r.settle();
  assert.equal(admitted.decision.phase, 'reduction', JSON.stringify(admitted.decision.reasons));
  const cycle = r.engine.cycles.active(); assert(cycle, 'The real Engine has admitted and activated a cycle');
  assert.equal(cycle.plan.trial, trial);
  const weather = r.store.getState('provider:weather');
  weather.forecast[0].end = missing === 'treatment' ? r.now + 5 * MINUTE : cycle.plan.schedule.reductionEnd + 30 * MINUTE;
  r.store.setState('provider:weather', weather);
  r.advance(MINUTE);
  const continued = r.engine.tick(); await r.settle();
  assert.equal(continued.decision.phase, 'recovery');
  assert(continued.decision.reasons.includes('control-or-forecast-coverage-lost'));
  assert.equal(r.commands.at(-1).batch.at(-1), 'normal');
  assert.equal(r.engine.executor.status().legacyOutstanding, false);
});
