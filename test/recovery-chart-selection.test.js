import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, observation, recover, start, W, HOUR } from './helpers/recovery-fixture.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { createChartService } from '../src/app/chart-service.js';
import { Recorder } from '../src/storage/recorder.js';
import { exportCsv, parseCsvLine } from '../src/storage/history.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { chartCoverageRows } from '../src/app/chart-coverage.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';
import { householdReference, forecastHousehold } from '../src/charging/history.js';
import { seedVoltage } from './voltage-fixture.js';

const DAY = 24 * HOUR;
const observationCounts = overview => overview.accounting.selection.tables.find(row => row.name === 'observations');
async function select(f, recoveryId, active) {
  const args = { store: f.master, input: 'mqtt', recoveryId, active, signal: f.signal };
  return reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
}

test('cached historical charts, CSV export and stored inventory follow completed recovery decisions', async t => {
  let service;
  t.after(async () => { await service?.close(); });
  const f = fixture(t);
  observation(f.master, start, 20);
  service = createChartService({ store: f.master });
  const originalOverview = await service.overview();
  assert.equal(observationCounts(originalOverview).retainedRows, 1);
  assert.equal((await service.overview()).cache.hit, true);
  const donor = await f.donor(); observation(donor, start + W, 999);
  const result = await recover(f, await f.snapshot(donor));
  observation(f.master, start + 2 * W, 21);
  const args = { input: 'mqtt', startDate: '2026-01-01', endDate: '2026-01-01',
    now: start + 2 * DAY, left: 'indoor_temperature' };
  assert((await service.query(args)).series.indoor_temperature.some(row => row.y === 999));
  assert.equal((await service.query(args)).meta.cacheHit, true);
  const recoveredOverview = await service.overview();
  assert.equal(recoveredOverview.cache.hit, false, 'completed recovery renews the stored inventory before its ordinary five-minute expiry');
  assert.equal(observationCounts(recoveredOverview).retainedRows, 3);
  const head = f.master.db.prepare('SELECT MAX(id) id FROM observations').get().id;
  await select(f, result.report.recoveryId, false);
  assert.equal(f.master.db.prepare('SELECT MAX(id) id FROM observations').get().id, head);
  const reverted = await service.query(args);
  assert.notEqual(reverted.meta.cacheHit, true, 'selection changes invalidate a cached past date even with unchanged observation heads');
  assert(!reverted.series.indoor_temperature.some(row => row.y === 999));
  assert(reverted.series.indoor_temperature.some(row => row.y === 21), 'later local recordings survive');
  assert.equal((await service.query(args)).meta.cacheHit, true);
  const excludedOverview = await service.overview();
  assert.equal(excludedOverview.cache.hit, false);
  assert.equal(observationCounts(excludedOverview).retainedRows, 3);
  assert.equal(observationCounts(excludedOverview).selectedRows, 2);
  assert.equal(excludedOverview.accounting.selection.excludedSourceRows, 1);
  const output = join(f.directory, 'selected-history.csv');
  assert.equal((await exportCsv(f.master, output, { signal: 'indoor_temperature' })).rows, 2);
  const csv = (await readFile(output, 'utf8')).trim().split('\n').slice(1).map(parseCsvLine);
  assert.deepEqual(csv.map(row => Number(row[4])), [20, 21]);
  await select(f, result.report.recoveryId, true);
  const restored = await service.query(args);
  assert.notEqual(restored.meta.cacheHit, true);
  assert(restored.series.indoor_temperature.some(row => row.y === 999));
  assert.equal((await service.overview()).accounting.selection.excludedSourceRows, 0);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 3);
});

test('reverting recovered periodic readings removes their coverage without inventing a replacement reading', async t => {
  const f = fixture(t), donor = await f.donor(), recorder = new Recorder(donor);
  recorder.record({ source: 'mqtt-temperature', device: 'synthetic-recovery-room', signal: 'indoor_temperature',
    value: 26, unit: 'degC', sourceTime: start, receivedAt: start, quality: [],
    raw: { reportIntervalMs: 15 * 60_000, reportGraceMs: 2 * 60_000 } });
  const recovered = await recover(f, await f.snapshot(donor));
  const options = { from: start, to: start + HOUR, now: start + HOUR, input: 'mqtt', signals: ['indoor_temperature'] };
  assert([...chartCoverageRows(f.master, options)].some(row => row.value === 26));
  assert.equal(lastIndoorReading(f.master, { signal: 'indoor_temperature', input: 'mqtt', at: start + 60_000 }).value, 26);
  await select(f, recovered.report.recoveryId, false);
  assert.deepEqual([...chartCoverageRows(f.master, options)], []);
  assert.equal(lastIndoorReading(f.master, { signal: 'indoor_temperature', input: 'mqtt', at: start + 60_000 }), null);
  assert.equal(new Recorder(f.master).committedAt('indoor_temperature', start + 60_000), null);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM recorder_coverage').get().n, 1);
  await select(f, recovered.report.recoveryId, true);
  assert([...chartCoverageRows(f.master, options)].some(row => row.value === 26));
});

function energy(store, at, currents) {
  for (const prefix of ['property', 'ev1', 'ev2']) for (let phase = 1; phase <= 3; phase++)
    observation(store, at + HOUR, prefix === 'property' ? currents[phase - 1] * 0.23 : 0, {
      source: 'easee', device: `synthetic-${prefix}`, signal: `${prefix}_energy_l${phase}`, unit: 'kWh', quality: [],
      raw: { intervalStart: at, intervalEnd: at + HOUR } });
}

test('energy selection and cached household forecasts drop reverted recovery while retaining later local evidence', async t => {
  const f = fixture(t);
  seedVoltage(f.master, start - HOUR);
  const donor = await f.donor(); energy(donor, start + HOUR, [30, 30, 30]);
  const result = await recover(f, await f.snapshot(donor));
  energy(f.master, start + DAY + HOUR, [3, 4, 5]);
  const options = { now: start + 2 * DAY + HOUR, deadlineAt: start + 2 * DAY + 2 * HOUR,
    input: 'live', voltageV: 230, timezone: 'UTC' };
  const before = householdReference(f.master, options);
  assert.equal(householdReference(f.master, options), before, 'ordinary reads reuse the household index');
  assert.equal(forecastHousehold(f.master, options)[0].reference.nights, 2);
  const energyOptions = { from: start, to: start + 2 * DAY, now: options.now, input: 'mqtt', prefix: 'property' };
  assert.equal([...recordedEnergyGroups(f.master, energyOptions)].length, 2);
  const head = f.master.db.prepare('SELECT MAX(id) id FROM active_observations').get().id;
  await select(f, result.report.recoveryId, false);
  assert.equal(f.master.db.prepare('SELECT MAX(id) id FROM active_observations').get().id, head);
  const after = householdReference(f.master, options);
  assert.notEqual(after, before, 'published recovery selection rebuilds the forecast even with unchanged observation maximum');
  const forecast = forecastHousehold(f.master, options)[0];
  assert.equal(forecast.reference.nights, 1);
  forecast.phaseCurrentA.forEach((value, index) => assert(Math.abs(value - [3, 4, 5][index]) < 1e-8));
  const selected = [...recordedEnergyGroups(f.master, energyOptions)];
  assert.equal(selected.length, 1);
  assert.equal(selected[0].start, start + DAY + HOUR);
  assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM observations WHERE signal='property_energy_l1'").get().n, 2);
  await select(f, result.report.recoveryId, true);
  assert.equal(forecastHousehold(f.master, options)[0].reference.nights, 2);
});
