import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { sourceTimeAdmission, observationTimeAdmitted } from '../src/domain/time-evidence.js';
import { lastIndoorReading, indoorReadingUsable } from '../src/app/indoor-readings.js';
import { committedLearningSample } from '../src/app/committed-learning.js';
import { VoltageEstimator, readPlanningVoltage } from '../src/storage/voltage.js';
import { ElectricityAccumulator } from '../src/domain/electricity.js';
import { recordedEnergyGroups, recordedEnergyStart } from '../src/storage/energy-history.js';
import { getChartData } from '../src/app/chart-data.js';

const T = Date.UTC(2026, 0, 1), MINUTE = 60_000;
const temperature = (value, sourceTime, receivedAt, admittedAt) => ({ source: 'mqtt-temperature', device: 'synthetic-room',
  signal: 'indoor_temperature', value, unit: 'degC', sourceTime, receivedAt, quality: [],
  raw: admittedAt === undefined ? {} : { timeAdmission: sourceTimeAdmission({ sourceTime, receivedAt, now: admittedAt }) } });

test('deferred temperature survives recording and restart without entering an earlier causal prefix', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = T, recorder = new Recorder(store, { clock: () => now });
  recorder.record(temperature(20, T, T));
  now = T + MINUTE + 450;
  const incoming = temperature(22, T + MINUTE + 400, T + MINUTE, now);
  const saved = recorder.record(incoming).observation;
  assert.deepEqual(saved.raw.timeAdmission, incoming.raw.timeAdmission);
  assert.equal(saved.sourceTime, incoming.sourceTime);
  assert.equal(saved.receivedAt, incoming.receivedAt);
  assert.equal(saved.raw.recorder.status, 'fresh');
  const earlier = incoming.sourceTime;
  assert.equal(lastIndoorReading(store, { signal: incoming.signal, at: earlier, input: 'mqtt' }).value, 20);
  assert.equal(committedLearningSample({ store, input: 'mqtt', at: earlier }).indoorC, 20);
  assert.equal(lastIndoorReading(store, { signal: incoming.signal, at: now, input: 'mqtt' }).value, 22);
  assert.equal(committedLearningSample({ store, input: 'mqtt', at: now }).indoorC, 22);
  assert.equal(store.db.prepare('SELECT start_at FROM recorder_coverage ORDER BY id DESC LIMIT 1').get().start_at, now);
  recorder = new Recorder(store, { clock: () => now });
  const status = recorder.status(now);
  const row = [...status.parameters, ...status.exactParameters].find(row => row.signal === incoming.signal);
  assert.equal(row.freshness.reasons.includes('source-time-after-receipt'), false);
  assert.equal(lastIndoorReading(store, { signal: incoming.signal, at: now, input: 'mqtt' }).receivedAt, incoming.receivedAt);
});

test('unadmitted future history remains excluded after catch-up and cannot borrow another report proof', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => T + 1000 });
  for (const row of [temperature(21, T + 1, T), {
    ...temperature(22, T + 400, T, T + 400), sourceTime: T + 401,
  }]) {
    assert.equal(recorder.record(row, { force: true }).observation.raw.recorder.status, 'stale');
  }
  assert.equal(lastIndoorReading(store, { signal: 'indoor_temperature', at: T + MINUTE, input: 'mqtt' }), null);
});

test('deferred voltage forms an estimate at admission and preserves candidate clocks across restart', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = T + 500, recorder = new Recorder(store, { clock: () => now });
  let voltage = new VoltageEstimator(store, { recorder, input: 'providers', clock: () => now });
  for (let phase = 1; phase <= 3; phase++) voltage.ingest({ source: 'easee', device: 'synthetic-meter',
    signal: `property_voltage_l${phase}`, value: 230, unit: 'V', sourceTime: T + 400, receivedAt: T,
    quality: [], raw: { acquisitionOnly: true, voltageMapping: 'phase-neutral',
      timeAdmission: sourceTimeAdmission({ sourceTime: T + 400, receivedAt: T, now }) } });
  assert.deepEqual(readPlanningVoltage(store, { input: 'providers', now }).voltageV, [230, 230, 230]);
  assert.deepEqual(readPlanningVoltage(store, { input: 'providers', now: T + 400 }).voltageV, [null, null, null]);
  voltage = new VoltageEstimator(store, { recorder, input: 'providers', clock: () => now });
  assert.deepEqual(readPlanningVoltage(store, { input: 'providers', now }).voltageV, [230, 230, 230]);
  const candidates = store.getState('voltage:estimate:providers').candidates;
  for (const candidate of Object.values(candidates)) {
    assert.equal(candidate.sourceTime, T + 400); assert.equal(candidate.receivedAt, T); assert.equal(candidate.admittedAt, now);
  }
});

test('deferred complete electrical samples preserve integration without an unavailable gap', () => {
  const accumulator = new ElectricityAccumulator();
  const rows = (receipt, lead = 0) => [
    ...[1,2,3].map(phase => [`current_l${phase}`, 10, 'A']),
    ...[1,2,3].map(phase => [`voltage_l${phase}`, 230, 'V']), ['active_power', 6.9, 'kW'],
  ].map(([signal, value, unit]) => ({ source: 'easee', device: 'synthetic-meter', signal: `property_${signal}`,
    value, unit, sourceTime: receipt + lead, receivedAt: receipt, quality: [],
    raw: lead ? { timeAdmission: sourceTimeAdmission({ sourceTime: receipt + lead, receivedAt: receipt, now: receipt + lead }) } : {} }));
  accumulator.sample(rows(T), T);
  const result = accumulator.sample(rows(T + 5000, 400), T + 5400);
  assert.equal(result.gaps.length, 0); assert.equal(result.intervals.length, 1);
  assert.ok(Math.abs(result.intervals[0].energies.reduce((a,b) => a+b,0) - 6.9 * 5400 / 3600000) < 1e-12);
});

test('deferred native energy remains causal in open and committed history and retains exact energy', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = T + 500, recorder = new Recorder(store, { clock: () => now });
  recorder.recordEnergy({ source: 'shelly-evse', device: 'synthetic-evse', prefix: 'ev2', start: T - 1000,
    end: T + 400, receivedAt: T, admittedAt: now, energies: [0.001,0.002,0.003], powers: [1,2,3], quality: [] });
  const options = at => ({ from: T - 2000, to: T + 1000, now: at, input: 'mqtt', prefix: 'ev2' });
  assert.deepEqual([...recordedEnergyGroups(store, options(T + 400))], []);
  const groups = [...recordedEnergyGroups(store, options(now))];
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].values, [0.001,0.002,0.003]);
  assert.equal(recordedEnergyStart(store, 'ev2', 'mqtt', now), T - 1000);
  recorder = new Recorder(store, { clock: () => now });
  assert.deepEqual([...recordedEnergyGroups(store, options(now))].map(group => group.values), [[0.001,0.002,0.003]]);
});

for (const boundary of [false, true]) test(`native aggregate admission survives ${boundary ? 'publication at an earlier packet receipt' : 'a following ordinary-clock increment'}`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = T + 1000, recorder = new Recorder(store, { clock: () => now });
  const interval = { source: 'shelly-evse', device: 'synthetic-evse', prefix: 'ev2',
    energies: [0.001,0,0], powers: [1,0,0], quality: [] };
  recorder.recordEnergy({ ...interval, start: T - 2000, end: T - 1000, receivedAt: T - 1000 });
  recorder.recordEnergy({ ...interval, start: T - 1000, end: T + 400, receivedAt: T, admittedAt: now });
  recorder.recordEnergy({ ...interval, start: T + 400, end: T + 600, receivedAt: T + 600,
    ...(boundary ? { powers: [3,0,0], admittedAt: now } : {}) });
  const options = at => ({ from: T - 1000, to: T + 800, now: at, input: 'mqtt', prefix: 'ev2' });
  assert.deepEqual([...recordedEnergyGroups(store, options(T + 700))], [], 'No constituent is available before deferred admission');
  assert.equal([...recordedEnergyGroups(store, options(now))].reduce((n, g) => n + g.values[0], 0), 0.002);
  if (boundary) {
    const prior = store.observations().find(row => row.signal === 'ev2_energy_l1' && row.sourceTime === T + 400);
    assert.equal(prior.receivedAt, T + 600);
    assert.equal(prior.raw.originalReportReceivedAt, T);
    assert.deepEqual(prior.raw.timeAdmission, { sourceTime: T + 400, receivedAt: T + 600, admittedAt: now });
  } else {
    assert.throws(() => recorder.flush(T + 700, { force: true }), /before.*admitted/);
    recorder.flush(now + 100, { force: true });
    const saved = store.observations().find(row => row.signal === 'ev2_energy_l1' && row.sourceTime === T + 600);
    assert.equal(saved.raw.originalReportReceivedAt, T + 600);
    assert.equal(saved.raw.timeAdmission.admittedAt, now + 100);
    assert.deepEqual([...recordedEnergyGroups(store, options(T + 700))], []);
  }
});

test('deferred recovery overlap prevents double counting and admits only the uncovered gap', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = T + 500, recorder = new Recorder(store, { clock: () => now });
  for (let phase = 1; phase <= 3; phase++) {
    const id = store.observation({ source: 'shelly-evse', device: 'synthetic-evse', signal: `ev2_energy_l${phase}`,
      value: 0.001, unit: 'kWh', sourceTime: T + 200, receivedAt: T, quality: [],
      raw: { intervalStart: T - 100, intervalEnd: T + 200,
        timeAdmission: sourceTimeAdmission({ sourceTime: T + 200, receivedAt: T, now }) } });
    store.db.prepare('INSERT INTO recovery_provenance(donor_digest,table_name,donor_id,target_id,disposition) VALUES(?,?,?,?,?)')
      .run('synthetic-donor', 'observations', String(phase), String(id), 'missing');
  }
  const result = recorder.recordEnergy({ source: 'shelly-evse', device: 'synthetic-evse', prefix: 'ev2',
    start: T - 100, end: T + 400, receivedAt: T, admittedAt: now, energies: [0.002,0.002,0.002], powers: [1,1,1], quality: [] });
  assert.equal(result.reason, 'recovered-interval-overlap');
  assert.equal(result.observations.length, 3);
  for (const row of result.observations) {
    assert.equal(row.value, null); assert.equal(row.raw.intervalStart, T + 200);
    assert.equal(row.sourceTime, T + 400); assert.equal(observationTimeAdmitted(row, now), true);
    assert.equal(observationTimeAdmitted(row, T + 400), false);
  }
});

test('committed setting lookup preserves the causal prefix and original proof during held coverage', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = T, recorder = new Recorder(store, { clock: () => now });
  const row = (value, sourceTime, receivedAt, admittedAt) => ({ source: 'synthetic', device: 'synthetic-pump',
    signal: 'room_setting', value, unit: 'degC', sourceTime, receivedAt, quality: [],
    raw: admittedAt === undefined ? {} : { timeAdmission: sourceTimeAdmission({ sourceTime, receivedAt, now: admittedAt }) } });
  recorder.record(row(20, T, T)); now = T + 1000;
  recorder.record(row(21, T + 400, T, now));
  assert.equal(recorder.committedAt('room_setting', T + 700).value, 20);
  assert.equal(recorder.committedAt('room_setting', now).value, 21);
  now = T + 1500; recorder.record(row(21, T + 1400, T + 1000, now));
  const held = recorder.latestCommitted('room_setting');
  assert.equal(held.sourceTime, T + 400); assert.equal(held.receivedAt, T);
  assert.equal(held.reportObservedAt, T + 1400); assert.equal(observationTimeAdmitted(held, now), true);
});

test('native temperature chart keeps deferred measurements outside an earlier as-of query', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => T + 1000 });
  recorder.record(temperature(22, T + 400, T, T + 1000));
  const chart = now => getChartData({ store, input: 'mqtt', now, startDate: '2026-01-01', endDate: '2026-01-01', view: 'temperatures' });
  assert.equal(chart(T + 500).series.indoor_temperature.some(point => Number.isFinite(point.y)), false);
  assert.equal(chart(T + 1000).series.indoor_temperature.some(point => point.x === T + 400 && point.y === 22), true);
});

for (const extended of [false, true]) test(`deferred temperature policy and reconnect preserve original reports${extended ? ' after compact coverage advances' : ''}`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = T + 500, recorder = new Recorder(store, { clock: () => now });
  const routeSignature = 'a'.repeat(64), policy = { reportIntervalMs: 10 * MINUTE, reportGraceMs: 0 };
  const incoming = temperature(21, T + 400, T, now);
  Object.assign(incoming, { device: 'indoor_temperature', raw: { ...incoming.raw, ...policy, temperatureRouteSignature: routeSignature } });
  recorder.record(incoming);
  let report = incoming;
  if (extended) {
    now = T + 2500;
    report = { ...incoming, sourceTime: T + 2400, receivedAt: T + 2000,
      raw: { ...incoming.raw, timeAdmission: sourceTimeAdmission({ sourceTime: T + 2400, receivedAt: T + 2000, now }) } };
    assert.equal(recorder.record(report).saved, false);
  }
  now += 500; recorder = new Recorder(store, { clock: () => now });
  const changedPolicy = { ...policy, reportGraceMs: MINUTE };
  const changed = recorder.transitionTemperatureReportPolicy(report, changedPolicy, now);
  assert.equal(changed.observation.value, 21);
  assert.equal(indoorReadingUsable(changed.observation, now), true);
  assert.equal(changed.observation.receivedAt, now, 'Policy event keeps its separate receipt');
  assert.equal(changed.observation.raw.originalReportReceivedAt, report.receivedAt);
  assert.deepEqual(changed.observation.raw.originalReportTimeAdmission, report.raw.timeAdmission);
  now += 100;
  recorder.recordFailure({ source: report.source, device: report.device, signal: report.signal, unit: report.unit,
    at: now, quality: ['mqtt-disconnected'] });
  now += 100;
  const recovered = recorder.recoverTemperatureConnection(report, changedPolicy, now, { routeSignature });
  assert.equal(recovered.changed, true); assert.equal(recovered.observation.value, 21);
  assert.equal(indoorReadingUsable(recovered.observation, now), true);
  assert.equal(recovered.observation.raw.originalReportReceivedAt, report.receivedAt);
  assert.deepEqual(recovered.observation.raw.originalReportTimeAdmission, report.raw.timeAdmission);
  assert.equal(recovered.reportSourceTime, report.sourceTime);
});
