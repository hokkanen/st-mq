import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { householdSpans, forecastHousehold, householdReference, householdReferenceSummary } from '../src/charging/history.js';
import { HouseholdReference, summarizeHousehold, predictHousehold, HOUR, DAY } from '../src/charging/history-reference.js';
import { seedVoltage } from './voltage-fixture.js';

const now = Date.parse('2026-09-15T01:00:00Z');
const options = { now, deadlineAt: now + HOUR, input: 'live', voltageV: 230, timezone: 'UTC',
  weather: [{ start: now, end: now + HOUR, outdoorC: -20 }] };
function fixture(t) {
  const store = new Store(':memory:'), dir = mkdtempSync(join(tmpdir(), 'charging-history-'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
async function legacy(store, dir, dates, { temperature = -20, current = [6, 7, 8], charger = [0, 0, 0], prefix = 'example', step = 15 * 60_000 } = {}) {
  let electrical = 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n';
  let thermal = 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n';
  for (const date of dates) {
    const start = Date.parse(`${date}T01:00:00Z`);
    for (let at = start; at <= start + HOUR; at += step) {
      electrical += `${at / 1000},${[...charger, ...current.map((value, phase) => value + charger[phase])].join(',')}\n`;
      thermal += `${at / 1000},8,15,21,12,${temperature}\n`;
    }
  }
  const easee = join(dir, `${prefix}-easee.csv`), stmq = join(dir, `${prefix}-stmq.csv`);
  writeFileSync(easee, electrical); writeFileSync(stmq, thermal);
  await importCsv(store, easee, { kind: 'easee' }); await importCsv(store, stmq, { kind: 'stmq' });
}
function energy(store, signal, value, start, end, quality = []) {
  store.observation({ source: 'easee', device: 'example-property', signal, value, unit: 'kWh', sourceTime: end,
    receivedAt: end, quality, raw: { intervalStart: start, intervalEnd: end } });
}
function peerEnergy(store, phaseKw, start, end) {
  phaseKw.forEach((value,index)=>energy(store,`ev2_energy_l${index+1}`,value*(end-start)/HOUR,start,end));
}
function nativeHour(store, date, { current = [3, 4, 5], temperature = -20, peer = true, step = HOUR } = {}) {
  const start = Date.parse(`${date}T01:00:00Z`);
  for (let at = start; at < start + HOUR; at += step) {
    const end = Math.min(start + HOUR, at + step);
    for (let phase = 1; phase <= 3; phase++) {
      energy(store, `property_energy_l${phase}`, current[phase - 1] * 230 / 1000 * (end - at) / HOUR, at, end);
      energy(store, `ev1_energy_l${phase}`, 0, at, end);
    }
    if (peer) peerEnergy(store, [0, 0, 0], at, end);
  }
  store.observation({ source: 'mqtt', device: 'example-outdoor', signal: 'outdoor_temperature', value: temperature,
    unit: 'degC', sourceTime: start, receivedAt: start, quality: [] });
}
function addNight(reference, date, { current = [5, 5, 5], outdoorC = -20, step = HOUR, priority = 1 } = {}) {
  const start = Date.parse(`${date}T01:00:00Z`), spans = [];
  for (let at = start; at < start + HOUR; at += step) spans.push({ start: at, end: Math.min(start + HOUR, at + step), phaseCurrentA: current, outdoorC });
  for (const entry of summarizeHousehold(spans, { timezone: 'UTC', priority })) reference.add(entry);
}

test('two original 0.7.5 nights immediately provide a temperature and phase aware reference without Charger 2 records', async t => {
  const { store, dir } = fixture(t);
  await legacy(store, dir, ['2026-02-14', '2026-02-15'], { charger: [10, 10, 10] });
  const before = store.db.prepare('SELECT count(*) AS n FROM observations').get().n;
  const [forecast] = forecastHousehold(store, options);
  assert.deepEqual(forecast.phaseCurrentA, [6, 7, 8]);
  assert.equal(forecast.reference.nights, 2);
  assert.equal(forecast.reference.limited, true);
  assert.equal(forecast.reference.legacy, true);
  assert.equal(forecast.reference.unknownCharger2, true);
  assert.equal(forecast.reference.method, 'similar-conditions');
  assert.deepEqual(forecast.reference.temperatureRangeC, [-20, -20]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM observations').get().n, before, 'Prediction never writes derived rows into source history');
  assert.equal(householdReferenceSummary([forecast]).nights, 2);
});

test('known Charger 2 intervals are subtracted from an imported reference, without requiring modern property energy', async t => {
  const { store, dir } = fixture(t), date = '2026-02-14', start = Date.parse(`${date}T01:00:00Z`);
  seedVoltage(store, now - HOUR);
  await legacy(store, dir, [date], { current: [10, 11, 12] });
  peerEnergy(store, [4,4,4].map(value=>value*230/1000), start, start + HOUR);
  const [forecast] = forecastHousehold(store, options);
  forecast.phaseCurrentA.forEach((value, phase) => assert.ok(Math.abs(value - (6 + phase)) < 1e-10));
  assert.equal(forecast.reference.unknownCharger2, false);
});

test('imported household references reject incomplete or conflicting Charger 2 phase cohorts', async t => {
  const { store, dir } = fixture(t), start = Date.parse('2026-02-14T01:00:00Z');
  seedVoltage(store, now - HOUR);
  await legacy(store, dir, ['2026-02-14'], { current: [10, 11, 12] });
  energy(store, 'ev2_energy_l2', 1, start, start + HOUR);
  assert.equal(forecastHousehold(store, options)[0].reference.noHistory, true,
    'An L2-only cohort is an explicit recording gap even without an L1 row');
  for (const phase of [1, 3]) store.observation({ source: 'shelly-evse', device: 'another-invented-meter',
    signal: `ev2_energy_l${phase}`, value: 1, unit: 'kWh', sourceTime: start + HOUR, receivedAt: start + HOUR,
    quality: [], raw: { intervalStart: start, intervalEnd: start + HOUR } });
  assert.equal(forecastHousehold(store, options)[0].reference.noHistory, true,
    'Phase rows from distinct meters cannot be combined into a complete charger interval');
});

test('summer observations do not erase last winter cold references; new comparable cold nights progressively replace them', () => {
  const reference = new HouseholdReference({ timezone: 'UTC' });
  addNight(reference, '2025-01-10', { current: [10, 10, 10] });
  addNight(reference, '2025-01-11', { current: [10, 10, 10] });
  for (let day = 1; day <= 31; day++) addNight(reference, `2026-08-${String(day).padStart(2, '0')}`, { current: [1, 1, 1], outdoorC: 18 });
  let forecast = predictHousehold(reference, { at: now, now, outdoorC: -20 });
  assert.ok(forecast.phaseCurrentA[0] > 9.9);
  assert.equal(forecast.reference.nights, 2);
  for (let day = 1; day <= 10; day++) addNight(reference, `2026-09-${String(day).padStart(2, '0')}`, { current: [4, 4, 4] });
  forecast = predictHousehold(reference, { at: now, now, outdoorC: -20 });
  assert.ok(forecast.phaseCurrentA[0] > 4 && forecast.phaseCurrentA[0] < 4.7, 'Replacement depends on new comparable evidence, not intervening mild months');
});

test('dense polling cannot outweigh sparse nights and short phase load patterns survive averaging', () => {
  const sparse = new HouseholdReference({ timezone: 'UTC' }), dense = new HouseholdReference({ timezone: 'UTC' });
  for (const reference of [sparse, dense]) addNight(reference, '2026-09-13', { current: [2, 4, 6] });
  addNight(sparse, '2026-09-14', { current: [10, 12, 14], step: HOUR });
  addNight(dense, '2026-09-14', { current: [10, 12, 14], step: 1000 });
  const predict = reference => predictHousehold(reference, { at: now, now, outdoorC: -20 });
  assert.deepEqual(predict(dense).phaseCurrentA, predict(sparse).phaseCurrentA);
  const start = now - DAY, cyclic = new HouseholdReference({ timezone: 'UTC' });
  for (const entry of summarizeHousehold([
    { start, end: start + HOUR / 2, phaseCurrentA: [2, 3, 4], outdoorC: -20 },
    { start: start + HOUR / 2, end: start + HOUR, phaseCurrentA: [24, 24, 24], outdoorC: -20 },
  ], { timezone: 'UTC' })) cyclic.add(entry);
  const forecast = predict(cyclic);
  assert.equal(forecast.scenarios.length, 2);
  assert.deepEqual(forecast.phaseCurrentA, [13, 13.5, 14]);
  assert.equal(forecast.scenarios.reduce((sum, scenario) => sum + scenario.weight, 0), 1);
});

test('native intervals have source precedence over duplicate imports and append refresh only replaces the affected date', async t => {
  const { store, dir } = fixture(t);
  await legacy(store, dir, ['2026-09-13'], { current: [12, 12, 12] });
  await legacy(store, dir, ['2026-09-13'], { current: [10, 10, 10], prefix: 'newer-copy' });
  nativeHour(store, '2026-09-13', { current: [3, 4, 5], step: HOUR / 2 });
  let [forecast] = forecastHousehold(store, options);
  assert.deepEqual(forecast.phaseCurrentA, [3, 4, 5]);
  assert.equal(forecast.reference.nights, 1);
  const cached = householdReference(store, options);
  assert.equal(householdReference(store, options), cached, 'Repeated planning reuses the compact index');
  nativeHour(store, '2026-09-14', { current: [5, 6, 7], step: HOUR / 2 });
  [forecast] = forecastHousehold(store, options);
  assert.equal(forecast.reference.nights, 2);
  assert.ok(forecast.phaseCurrentA[0] > 3 && forecast.phaseCurrentA[0] < 5);
  assert.equal(householdReference(store, options), cached);
});

test('a missing peer does not discard native idle history; explicit invalid energy is a real gap', t => {
  const { store } = fixture(t), start = now - DAY;
  nativeHour(store, '2026-09-14', { peer: false });
  let [forecast] = forecastHousehold(store, options);
  assert.deepEqual(forecast.phaseCurrentA, [3, 4, 5]);
  assert.equal(forecast.reference.unknownCharger2, true);
  for (let phase = 1; phase <= 3; phase++) energy(store, `ev2_energy_l${phase}`, null, start, start + HOUR, ['integration_gap']);
  [forecast] = forecastHousehold(store, options);
  assert.equal(forecast.reference.noHistory, true);
  assert.deepEqual(forecast.phaseCurrentA, [0, 0, 0]);
});

test('broader temperature and hourly references precede zero fallback; no-history reason is explicit', t => {
  const { store } = fixture(t);
  const [empty] = forecastHousehold(store, options);
  assert.equal(empty.reference.noHistory, true);
  assert.equal(empty.reference.method, 'no-history');
  nativeHour(store, '2026-09-14', { temperature: 15 });
  const [broad] = forecastHousehold(store, options);
  assert.equal(broad.reference.noHistory, false);
  assert.equal(broad.reference.method, 'broader-temperature');
  assert.deepEqual(broad.phaseCurrentA, [3, 4, 5]);
  const [otherHour] = forecastHousehold(store, { ...options, now: now + 2 * HOUR, deadlineAt: now + 3 * HOUR });
  assert.equal(otherHour.reference.method, 'broader-history');
  assert.deepEqual(otherHour.phaseCurrentA, [3, 4, 5]);
});

test('legacy gaps and original absence quality do not teach an artificial zero-load occupied night', async t => {
  const { store, dir } = fixture(t);
  await legacy(store, dir, ['2026-04-15'], { current: [1, 1, 1] });
  await legacy(store, dir, ['2026-02-15'], { prefix: 'gapped', step: HOUR });
  const [forecast] = forecastHousehold(store, options);
  assert.equal(forecast.reference.noHistory, true);
});

test('source precedence and explicit zeros do not count duplicate energy twice', () => {
  const start = now - DAY, raw = { intervalStart: start, intervalEnd: start + HOUR };
  const rows = [1, 2, 3].flatMap(phase => [
    { signal: `property_energy_l${phase}`, value: 2, unit: 'kWh', raw, quality: [], id: phase },
    { signal: `ev1_energy_l${phase}`, value: 0, unit: 'kWh', raw, quality: [], id: phase + 3 },
  ]);
  rows.push({ ...rows[0] }, { ...rows[0], value: 1, id: 10 });
  const spans = householdSpans(rows, { voltageV: 230 });
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].phaseCurrentA, [1000 / 230, 2000 / 230, 2000 / 230]);
});

test('multi-year reference memory is bounded by conditions and independent nights', () => {
  const reference = new HouseholdReference({ timezone: 'UTC' });
  const start = Date.parse('2016-01-01T00:00:00Z');
  for (let day = 0; day < 3650; day++) {
    const date = new Date(start + day * DAY).toISOString().slice(0, 10);
    const outdoorC = Math.round(15 * Math.sin(day * 2 * Math.PI / 365));
    for (let hour = 0; hour < 24; hour++) reference.add({ date, night: date, hour, at: start + day * DAY + hour * HOUR,
      priority: 0, coverageMs: HOUR, outdoorC, trailingOutdoorC: outdoorC, unknownCharger2: true, legacy: true,
      patterns: [{ phaseCurrentA: [6, 7, 8], durationMs: HOUR }] });
  }
  assert.ok(reference.entries().length <= 7 * 24 * 32);
  const forecast = predictHousehold(reference, { at: now, now, outdoorC: -15 });
  assert.ok(forecast.reference.nights <= 20);
  assert.equal(forecast.reference.noHistory, false);
});

test('forward evaluation cannot learn from the coming night and advancing the clock activates newly available intervals', t => {
  const { store } = fixture(t);
  nativeHour(store, '2026-09-14', { current: [4, 4, 4] });
  nativeHour(store, '2026-09-15', { current: [20, 20, 20] });
  const [before] = forecastHousehold(store, options);
  assert.deepEqual(before.phaseCurrentA, [4, 4, 4], 'The future night is held out despite already being present in the evaluation database');
  assert.equal(before.reference.nights, 1);
  const [after] = forecastHousehold(store, { ...options, now: now + DAY, deadlineAt: now + DAY + HOUR });
  assert.equal(after.reference.nights, 2);
  assert.ok(after.phaseCurrentA[0] > 4 && after.phaseCurrentA[0] < 20);
});

test('a native recording gap supersedes an overlapping imported estimate instead of reviving it as known coverage', async t => {
  const { store, dir } = fixture(t), start = now - DAY;
  await legacy(store, dir, ['2026-09-14'], { current: [12, 12, 12] });
  for (let phase = 1; phase <= 3; phase++) energy(store, `property_energy_l${phase}`, null, start, start + HOUR, ['integration_gap']);
  const [forecast] = forecastHousehold(store, options);
  assert.equal(forecast.reference.noHistory, true);
});

test('ordinary voltage changes reuse the history index while converting native power with the current voltage', t => {
  const { store } = fixture(t);
  nativeHour(store, '2026-09-14', { current: [4, 4, 4] });
  const [first] = forecastHousehold(store, options), cached = householdReference(store, options);
  const [second] = forecastHousehold(store, { ...options, voltageV: 240 });
  assert.equal(householdReference(store, { ...options, voltageV: 240 }), cached);
  assert.deepEqual(first.phaseCurrentA, [4, 4, 4]);
  assert.ok(second.phaseCurrentA.every(value => Math.abs(value - 4 * 230 / 240) < 1e-10));
});

test('a short native fragment replaces only its interval and retains the remaining imported hour through later refreshes', async t => {
  const { store, dir } = fixture(t), start = now - DAY;
  await legacy(store, dir, ['2026-09-14'], { current: [12, 12, 12] });
  for (let phase = 1; phase <= 3; phase++) {
    energy(store, `property_energy_l${phase}`, 4 * 230 / 1000 / 4, start, start + HOUR / 4);
    energy(store, `ev1_energy_l${phase}`, 0, start, start + HOUR / 4);
  }
  let [forecast] = forecastHousehold(store, options);
  assert.ok(forecast.phaseCurrentA.every(value => Math.abs(value - 10) < 1e-10));
  assert.equal(forecast.coverageMs, HOUR);
  store.observation({ source: 'mqtt', device: 'example-outdoor', signal: 'outdoor_temperature', value: -20,
    unit: 'degC', sourceTime: start, receivedAt: start, quality: [] });
  [forecast] = forecastHousehold(store, options);
  assert.ok(forecast.phaseCurrentA.every(value => Math.abs(value - 10) < 1e-10));
  assert.equal(forecast.coverageMs, HOUR);
  const [changedVoltage] = forecastHousehold(store, { ...options, voltageV: 240 });
  assert.ok(changedVoltage.phaseCurrentA.every(value => Math.abs(value - (12 * 0.75 + 4 * 230 / 240 * 0.25)) < 1e-10),
    'Original current snapshots retain amperes; only energy-derived phase currents change with supply voltage');
});

test('a later recorded Charger 2 interval updates an already cached imported night', async t => {
  const { store, dir } = fixture(t), start = Date.parse('2026-02-14T01:00:00Z');
  seedVoltage(store, now - HOUR);
  await legacy(store, dir, ['2026-02-14'], { current: [10, 11, 12] });
  const [before] = forecastHousehold(store, options);
  assert.deepEqual(before.phaseCurrentA, [10, 11, 12]);
  peerEnergy(store, [4,4,4].map(value=>value*230/1000), start, start + HOUR);
  const [after] = forecastHousehold(store, options);
  after.phaseCurrentA.forEach((value, phase) => assert.ok(Math.abs(value - (6 + phase)) < 1e-10));
  assert.equal(after.reference.unknownCharger2, false);
});

test('the first mature voltage estimate enables retrospective CSV conversion and peer subtraction', async t => {
  const { store, dir } = fixture(t);
  await legacy(store, dir, ['2026-02-14'], { current: [10, 11, 12] });
  const start = Date.parse('2026-02-14T01:00:00Z');
  peerEnergy(store, [4,4,4].map(value=>value*230/1000), start, start + HOUR);
  const withoutVoltage = { ...options, voltageV: null };
  const [initial] = forecastHousehold(store, withoutVoltage);
  assert.deepEqual(initial.phaseCurrentA, [10, 11, 12]);
  seedVoltage(store, now - HOUR);
  const [ready] = forecastHousehold(store, options);
  ready.phaseCurrentA.forEach((value, phase) => assert.ok(Math.abs(value - (6 + phase)) < 1e-10));
  assert.equal(ready.reference.unknownCharger2, false);
  assert.equal(ready.reference.retrospectiveVoltage, true);
  assert.equal(householdReferenceSummary([ready]).retrospectiveVoltage, true);
  const reference = householdReference(store, options);
  seedVoltage(store, now, [240, 240, 240]);
  const [later] = forecastHousehold(store, { ...options, voltageV: 240 });
  assert.equal(householdReference(store, { ...options, voltageV: 240 }), reference);
  later.phaseCurrentA.forEach((value, phase) => assert.ok(Math.abs(value - (6 + phase) * 230 / 240) < 1e-10));
});
