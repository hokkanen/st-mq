import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { VoltageEstimator, createVoltageReader, readPlanningVoltage, voltageRecordingStatus, voltageTelemetryAt, VOLTAGE_MATURITY_MS } from '../src/storage/voltage.js';

const MINUTE = 60000, HOUR = 60 * MINUTE, START = Date.UTC(2026, 0, 1);
function fixture(t, input = 'providers') {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = START;
  const recorder = new Recorder(store, { clock: () => now });
  let estimator = new VoltageEstimator(store, { recorder, input, clock: () => now });
  return { store, recorder, get estimator() { return estimator; }, setNow(at) { now = at; },
    restart() { estimator = new VoltageEstimator(store, { recorder, input, clock: () => now }); },
    put(at, voltages = [231, 232, 233], extra = {}) {
      now = at;
      voltages.forEach((value, phase) => estimator.ingest({ source: input === 'simulated' ? 'simulation' : 'easee',
        device: 'invented-grid-meter', signal: `property_voltage_l${phase + 1}`, value, unit: 'V',
        sourceTime: at, receivedAt: at, quality: [], raw: { acquisitionOnly: true, voltageMapping: 'phase-neutral' }, ...extra }));
    },
    plan() { return readPlanningVoltage(store, { input, now }); },
  };
}
function formed(f, from = START, voltages) {
  for (let at = from; at <= from + HOUR; at += MINUTE) f.put(at, voltages);
}
function estimate(store, at, values, { input = 'providers', receivedAt = at, mature = true } = {}) {
  for (let phase = 0; phase < 3; phase++) store.observation({ source: 'voltage-estimate', device: input,
    signal: `voltage_estimate_l${phase + 1}`, value: values[phase], unit: 'V', sourceTime: at, receivedAt,
    quality: ['estimated'], raw: { voltageMature: mature, voltageSource: 'invented-meter',
      voltageAvailability: 'reporting', basis: 'time-weighted-voltage-estimate' } });
}

test('valid elapsed phase coverage matures independently and tiny voltage drift adds no historical rows', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 24 * 60; minute++) {
    f.put(START + minute * MINUTE, [231 + .02 * Math.sin(minute), 232, minute < 30 ? null : 233]);
    if (minute === 59) assert.deepEqual(f.plan().voltageV, [null, null, null]);
    if (minute === 60) {
      assert.equal(f.plan().available, false); assert.equal(f.plan().voltageV[1], 232);
      assert.equal(f.plan().voltageV[2], null);
    }
  }
  assert.equal(f.plan().available, true);
  assert.equal(f.store.observations().length, 7, 'initial rows, L3 acquisition recovery, and maturity only');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM state WHERE key LIKE ?').get('voltage:estimate:%').n, 1);
  const voltageRows = f.recorder.status(START + 24 * HOUR).parameters;
  assert(voltageRows.every(row => row.threshold >= .5 && row.thresholdUnit === 'V'));
  assert(f.plan().voltageV[0] < 231.01 && f.plan().voltageV[0] > 230.99);
});

test('duplicates, invalid units, retained reports and missing source coverage cannot mature voltage', t => {
  const f = fixture(t);
  f.put(START);
  for (let i = 1; i <= 70; i++) f.put(START + i * MINUTE, [231, 232, 233], { sourceTime: START });
  assert.deepEqual(f.plan().voltageV, [null, null, null]);
  f.put(START + 80 * MINUTE);
  for (let i = 81; i <= 150; i++) f.put(START + i * MINUTE, [231, 232, 233], { unit: 'kWh' });
  f.put(START + 160 * MINUTE, [231, 232, 233], { raw: { voltageMapping: 'phase-neutral', retained: true } });
  assert.deepEqual(f.plan().voltageV, [null, null, null]);
  const state = f.store.getState('voltage:estimate:providers');
  assert(state.phases.every(candidate => candidate.coverageMs === 5 * MINUTE),
    'only the original source report freshness window can contribute without new telemetry');
});

test('unchanged source voltage matures only with bounded genuine same-device telemetry coverage', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 65; minute++) f.put(START + minute * MINUTE, [231, 232, 233], {
    sourceTime: START, quality: minute > 5 ? ['stale'] : [], raw: { voltageMapping: 'phase-neutral',
      deviceConnection: { connected: true, observedAt: START }, deviceTelemetryAt: START + minute * MINUTE },
  });
  assert.deepEqual(f.plan().voltageV, [231, 232, 233]);
  assert(f.store.getState('voltage:estimate:providers').phases
    .every(candidate => candidate.coverageMs === 65 * MINUTE && candidate.lastObservedAt === START));
  const freshSourceTime = f.plan().phases[0].at;
  for (let minute = 66; minute <= 100; minute++) f.put(START + minute * MINUTE, [231, 232, 233], {
    sourceTime: START, quality: ['stale'], raw: { voltageMapping: 'phase-neutral',
      deviceConnection: { connected: true, observedAt: START }, deviceTelemetryAt: START + 65 * MINUTE },
  });
  assert.equal(f.plan().phases[0].availability, 'held');
  assert(f.store.getState('voltage:estimate:providers').phases
    .every(candidate => candidate.coverageMs === 82 * MINUTE), 'cached telemetry expires after its configured grace');
  assert(f.plan().phases[0].at > freshSourceTime, 'loss of continuing telemetry is a recorded boundary');
});

test('unverified terminal pairs and nonlocal vehicle voltage never create estimator state', t => {
  const f = fixture(t);
  f.put(START, [231, 232, 233], { signal: 'ev1_voltage_l1', raw: { voltageMapping: 'terminal-pair-unverified' } });
  f.put(START, [231, 232, 233], { source: 'teslamate', raw: { voltageMapping: 'phase-neutral' } });
  assert.equal(f.store.getState('voltage:estimate:providers'), null);
  assert.equal(f.store.observations().length, 0);
});

test('restart retains exact smoothing state; an outage holds recorded estimates and does not add coverage', t => {
  const f = fixture(t); formed(f);
  const before = f.plan();
  f.restart();
  assert.deepEqual(f.plan(), before);
  f.setNow(START + 2 * HOUR); f.estimator.tick(START + 2 * HOUR);
  assert.deepEqual(f.plan().voltageV, [231, 232, 233]);
  assert(f.plan().phases.every(phase => phase.availability === 'held'));
  const rows = f.store.observations().length;
  f.estimator.tick(START + 3 * HOUR);
  assert.equal(f.store.observations().length, rows);
  f.put(START + 3 * HOUR, [245, 246, 247]);
  assert.deepEqual(f.plan().voltageV, [231, 232, 233], 'unknown outage time never weights a new endpoint');
  assert(f.store.getState('voltage:estimate:providers').phases
    .every(candidate => candidate.coverageMs === VOLTAGE_MATURITY_MS));
  for (let at = START + 3 * HOUR + MINUTE; at <= START + 4 * HOUR; at += MINUTE) f.put(at, [245, 246, 247]);
  assert(f.plan().voltageV[0] > 232 && f.plan().voltageV[0] < 233);
  assert(f.store.observations().length < rows + 18, 'the 0.5 V floor aggregates gradual EWMA drift');
});

test('historical reader uses causal publication and only explicit old CSV queries use first mature estimates', t => {
  const f = fixture(t);
  estimate(f.store, START, [null, null, null], { mature: false });
  estimate(f.store, START + HOUR, [231, 232, 233]);
  estimate(f.store, START + 2 * HOUR, [235, 236, 237]);
  estimate(f.store, START + 3 * HOUR, [239, 240, 241], { receivedAt: START + 4 * HOUR });
  estimate(f.store, START + HOUR, [211, 212, 213], { input: 'simulated' });
  const reader = createVoltageReader(f.store, { input: 'offline', now: START + 3 * HOUR });
  assert.deepEqual(reader(START - HOUR).voltageV, [null, null, null]);
  assert.deepEqual(reader(START - HOUR, { allowFuture: true }).voltageV, [231, 232, 233]);
  assert.equal(reader(START - HOUR, { allowFuture: true }).basis, 'retrospective-voltage-estimate');
  assert.deepEqual(reader(START + 90 * MINUTE).voltageV, [231, 232, 233]);
  assert.deepEqual(reader(START + 3 * HOUR).voltageV, [235, 236, 237], 'later receipt is unavailable at historical cutoff');
  assert.deepEqual([...reader.boundaries(START, START + 4 * HOUR)], [START + HOUR, START + 2 * HOUR]);
  assert.deepEqual(createVoltageReader(f.store, { input: 'simulated', now: START + 3 * HOUR })(START + 2 * HOUR).voltageV, [211, 212, 213]);
  assert.deepEqual(createVoltageReader(f.store, { now: START + 30 * MINUTE })(START - HOUR, { allowFuture: true }).voltageV, [null, null, null]);
});

test('recorder floor compares against last publication and source or availability changes remain visible', t => {
  const f = fixture(t), put = (value, at, raw = {}) => f.recorder.record({ source: 'voltage-estimate', device: 'providers',
    signal: 'voltage_estimate_l1', value, unit: 'V', sourceTime: at, receivedAt: at, quality: ['estimated'],
    raw: { voltageSource: 'invented-meter', voltageMature: true, voltageAvailability: 'reporting', ...raw } });
  assert.equal(put(231, START).saved, true);
  for (let i = 1; i <= 5; i++) assert.equal(put(231 + i / 10, START + i * MINUTE).saved, false);
  assert.equal(put(231.6, START + 6 * MINUTE).saved, true);
  assert.equal(put(231.61, START + 7 * MINUTE, { voltageAvailability: 'held' }).reason, 'quality-or-availability');
  assert.equal(put(231.61, START + 8 * MINUTE, { voltageSource: 'invented-meter-2' }).reason, 'quality-or-availability');
});

test('late estimate receipt is a causal boundary even when its source timestamp predates the query', t => {
  const f = fixture(t);
  estimate(f.store, START, [231, 232, 233], { receivedAt: START + 3 * HOUR });
  const reader = createVoltageReader(f.store, { now: START + 5 * HOUR });
  assert.deepEqual(reader(START + HOUR).voltageV, [null, null, null]);
  assert.deepEqual([...reader.boundaries(START, START + 4 * HOUR)], [START + 3 * HOUR]);
  assert.deepEqual(reader(START + 4 * HOUR).voltageV, [231, 232, 233]);
  assert.deepEqual(reader(START + HOUR).voltageV, [null, null, null], 'cached later lookup never leaks back');
});

test('configuration removes obsolete source ownership without deleting historical voltage evidence', t => {
  const f = fixture(t);
  const initial = { property: { source: 'easee', device: 'invented-grid-meter', mapping: 'phase-neutral' }, ev1: null };
  f.estimator.reconcileSources(initial); formed(f);
  assert.equal(f.plan().available, true);
  f.setNow(START + 2 * HOUR);
  f.estimator.reconcileSources({ property: null, ev1: null });
  assert.deepEqual(f.plan().voltageV, [null, null, null]);
  f.put(START + 2 * HOUR + MINUTE);
  assert.deepEqual(f.plan().voltageV, [null, null, null], 'unconfigured source cannot regain ownership');
  assert.deepEqual(createVoltageReader(f.store, { now: START + 3 * HOUR })(START + 90 * MINUTE).voltageV, [231, 232, 233]);
  f.restart(); assert.deepEqual(f.plan().voltageV, [null, null, null]);
});

test('malformed and retired voltage checkpoints fail closed before mutation', t => {
  const f = fixture(t); formed(f);
  const saved = f.store.getState('voltage:estimate:providers');
  const invalid = [
    { ...saved, version: 'voltage-ewma-v1' }, { ...saved, unexpected: true },
    { ...saved, candidates: [] },
    { ...saved, phases: saved.phases.map(row => ({ ...row, inputs: 12 })) },
    { ...saved, phases: saved.phases.map(row => ({ ...row, input: '4' })) },
    { ...saved, candidates: { ...saved.candidates, '4:4': saved.candidates['4:0'] } },
    { ...saved, candidates: { ...saved.candidates, '4:0': { ...saved.candidates['4:0'], healthyMs: -1 } } },
    { ...saved, published: [ { ...saved.published[0], device: 'simulated' }, ...saved.published.slice(1) ] },
  ];
  const rows = f.store.observations().length;
  for (const state of invalid) {
    f.store.setState('voltage:estimate:providers', state);
    assert.throws(() => f.restart(), /Unsupported voltage estimate state/);
    assert.equal(f.store.observations().length, rows);
    assert.deepEqual(f.store.getState('voltage:estimate:providers'), state);
  }
});

test('explicit provider failure and stream interruption break coverage immediately before recovery', t => {
  const f = fixture(t); formed(f);
  f.put(START + HOUR + MINUTE, [null, null, null], { raw: { acquisitionOnly: true }, sourceTime: null, quality: ['provider_error'] });
  assert(f.plan().phases.every(phase => phase.availability === 'held'), 'unmapped null failures still end an established source');
  f.put(START + HOUR + 2 * MINUTE, [231, 232, 233], { sourceTime: START + HOUR });
  assert(f.plan().phases.every(phase => phase.availability === 'held'), 'a cached report cannot recover failure');
  f.put(START + HOUR + 3 * MINUTE);
  let state = f.store.getState('voltage:estimate:providers');
  assert(state.phases.every(candidate => candidate.coverageMs === HOUR));
  f.setNow(START + HOUR + 3 * MINUTE + 1000);
  f.estimator.interrupt({ source: 'easee', devices: ['invented-grid-meter'] });
  assert(f.plan().phases.every(phase => phase.availability === 'held'));
  f.put(START + HOUR + 4 * MINUTE);
  state = f.store.getState('voltage:estimate:providers');
  assert(state.phases.every(candidate => candidate.coverageMs === HOUR), 'a short outage is not hidden inside maturity coverage');
});

function feed(f, at, input, { phase = null, value = 231, quality = [], ...extra } = {}) {
  f.setNow(at);
  const source = 'easee', slot = input === 4 ? 'property' : 'ev1';
  for (const index of phase === null ? [0, 1, 2] : [phase]) f.estimator.ingest({ source,
    device: input === 4 ? 'invented-grid-meter' : 'invented-charger',
    signal: `${slot}_voltage_l${index + 1}`, value, unit: 'V', quality, sourceTime: at, receivedAt: at,
    raw: { voltageMapping: 'phase-neutral', transport: input === 1 ? 'ocpp' : 'cloud' }, ...extra });
}

test('initial priority is OCPP, charger cloud, Equalizer independently per phase and without double coverage', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 60; minute++) {
    const at = START + minute * MINUTE;
    feed(f, at, 4, { value: 220 }); feed(f, at, 2, { value: 228 });
    feed(f, at, 1, { value: 232, phase: 0 }); feed(f, at, 1, { value: 234, phase: 2 });
  }
  assert.deepEqual(f.plan().voltageV, [232, 228, 234]);
  const state = f.store.getState('voltage:estimate:providers');
  assert.deepEqual(state.phases.map(row => row.coverageMs), [HOUR, HOUR, HOUR]);
  assert.deepEqual(state.phases.map(row => row.inputs), [1, 2, 1]);
  assert.deepEqual(state.phases.map(row => row.input), [1, 2, 1]);
  assert.deepEqual(state.phases.map(row => row.selected), ['1:0', '2:1', '1:2']);
});

test('fallback preserves the shared accumulator and historical contributors; preferred return waits for stable coverage', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 60; minute++) {
    feed(f, START + minute * MINUTE, 1); feed(f, START + minute * MINUTE, 2, { value: 241 });
  }
  const historicalAt = START + HOUR, mature = f.plan();
  assert.deepEqual(mature.phases.map(row => row.inputs), [1, 1, 1]);
  f.setNow(START + 61 * MINUTE);
  f.estimator.interrupt({ source: 'easee', devices: ['invented-charger'], transport: 'cloud' });
  assert(f.plan().phases.every(row => row.availability === 'reporting'), 'cloud interruption does not stop OCPP');
  f.estimator.interrupt({ source: 'easee', devices: ['invented-charger'], transport: 'ocpp' });
  assert.deepEqual(f.plan().voltageV, mature.voltageV, 'fallback begins without an instantaneous voltage jump');
  for (let minute = 61; minute <= 66; minute++) feed(f, START + minute * MINUTE, 2, { value: 241 });
  let state = f.store.getState('voltage:estimate:providers');
  assert.deepEqual(state.phases.map(row => row.input), [2, 2, 2]);
  assert.deepEqual(state.phases.map(row => row.inputs), [3, 3, 3]);
  assert(state.phases.every(row => row.mean > 231 && row.mean < 231.2));
  for (let minute = 67; minute <= 71; minute++) {
    feed(f, START + minute * MINUTE, 1); feed(f, START + minute * MINUTE, 2, { value: 241 });
    assert(f.store.getState('voltage:estimate:providers').phases.every(row => row.selected.startsWith('2:')));
  }
  feed(f, START + 72 * MINUTE, 1);
  state = f.store.getState('voltage:estimate:providers');
  assert(state.phases.every(row => row.selected.startsWith('1:')), 'five minutes confirms preferred-source return');
  feed(f, START + 73 * MINUTE, 1);
  assert.deepEqual(f.plan().phases.map(row => row.input), [1, 1, 1]);
  assert.deepEqual(f.plan().phases.map(row => row.inputs), [3, 3, 3]);
  const old = createVoltageReader(f.store, { input: 'providers', now: START + 73 * MINUTE })(historicalAt);
  assert.deepEqual(old.phases.map(row => row.inputs), [1, 1, 1], 'today\'s mixed inputs cannot alter yesterday\'s record');
  f.restart(); assert.deepEqual(f.plan().phases.map(row => row.inputs), [3, 3, 3]);
});

test('loss of all inputs holds the estimate, keeps coverage unchanged and reports its actual original clock', t => {
  const f = fixture(t); formed(f);
  f.setNow(START + 2 * HOUR); f.estimator.tick();
  const statuses = Object.values(voltageRecordingStatus(f.store, 'providers', START + 2 * HOUR));
  assert(statuses.every(row => row.reason === 'source-unavailable' && row.mature && !row.reporting));
  assert(statuses.every(row => row.coverageMs === HOUR && row.lastObservedAt === START + HOUR));
});

test('recording status exposes accumulating coverage without adding progress rows', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 35; minute++) f.put(START + minute * MINUTE);
  assert.equal(f.store.observations().length, 3);
  const statuses = Object.values(voltageRecordingStatus(f.store, 'providers', START + 35 * MINUTE));
  assert(statuses.every(row => row.coverageMs === 35 * MINUTE && row.reason === 'collecting' && row.reporting && !row.mature));
  assert(statuses.every(row => row.inputs === 4 && row.input === 4 && row.lastObservedAt === START + 35 * MINUTE));
});

test('unknown charger transport and cross-transport telemetry cannot provide voltage evidence', t => {
  const f = fixture(t);
  feed(f, START, 1, { raw: { voltageMapping: 'phase-neutral' } });
  assert.equal(f.store.getState('voltage:estimate:providers'), null);
  const original = { source: 'easee', device: 'invented-charger', signal: 'ev1_voltage_l1', value: 231,
    unit: 'V', sourceTime: START, raw: { transport: 'ocpp' }, quality: [] };
  const cloud = { ...original, sourceTime: START + HOUR, raw: { transport: 'cloud' } };
  assert.equal(voltageTelemetryAt([cloud, original], original, START + HOUR), START);
  assert.equal(voltageTelemetryAt([cloud], original, START + HOUR), null);
});

test('replacement of a contributing device resets its shared phase accumulator and preserves saved identity', t => {
  const f = fixture(t); formed(f);
  const old = f.plan();
  feed(f, START + HOUR + MINUTE, 4, { device: 'invented-replacement-meter', value: 241 });
  assert.deepEqual(f.plan().voltageV, [null, null, null]);
  assert(f.store.getState('voltage:estimate:providers').phases.every(row => row.coverageMs === 0));
  const prior = createVoltageReader(f.store, { input: 'providers', now: START + 2 * HOUR })(START + HOUR);
  assert.deepEqual(prior, old);
  assert(prior.phases.every(row => row.source.includes('invented-grid-meter')));
});

test('Charger 2 voltage is never a shared input, including simulation and mature-estimate fallback', t => {
  const f = fixture(t), simulated = fixture(t, 'simulated');
  const row = { source: 'shelly-evse', device: 'invented-evse', signal: 'ev2_voltage_l1', value: 249,
    unit: 'V', sourceTime: START, receivedAt: START, quality: [], raw: { voltageMapping: 'phase-neutral' } };
  assert.equal(f.estimator.ingest(row), false);
  assert.equal(simulated.estimator.ingest({ ...row, source: 'simulation' }), false);
  assert.equal(f.store.getState('voltage:estimate:providers'), null);
  assert.equal(simulated.store.getState('voltage:estimate:simulated'), null);
  formed(f);
  const before = f.store.getState('voltage:estimate:providers');
  f.setNow(START + HOUR + MINUTE);
  assert.equal(f.estimator.ingest({ ...row, sourceTime: START + HOUR + MINUTE, receivedAt: START + HOUR + MINUTE }), false);
  assert.deepEqual(f.store.getState('voltage:estimate:providers'), before);
  assert.throws(() => f.estimator.reconcileSources({ property: null, ev1: null, ev2: { source: 'shelly-evse', device: 'invented-evse', mapping: '[1,2,3]' } }), /Invalid voltage source policy/);
  assert.deepEqual(f.store.getState('voltage:estimate:providers'), before);
});


test('checkpoint contributors must have bounded feed evidence and the latest contributor must retain its device identity', t => {
  const f = fixture(t); formed(f);
  const saved = f.store.getState('voltage:estimate:providers'), rows = f.store.observations().length;
  for (const phases of [
    saved.phases.map(row => ({ ...row, inputs: 5 })),
    saved.phases.map(row => ({ ...row, device: 'invented-different-meter' })),
  ]) {
    const invalid = { ...saved, phases };
    f.store.setState('voltage:estimate:providers', invalid);
    assert.throws(() => f.restart(), /Unsupported voltage estimate state/);
    assert.deepEqual(f.store.getState('voltage:estimate:providers'), invalid);
    assert.equal(f.store.observations().length, rows);
  }
});
