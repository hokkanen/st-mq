import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { chartRange, chartRequestRange, getChartData } from '../src/app/chart-data.js';
import { recordHeatPumpConfiguration } from '../src/app/chart-heat-pump.js';
import { chartQuery } from '../chart/history-model.js';
import { seedChartPerformanceFixture, CHART_PERFORMANCE_CONTRACT } from '../scripts/lib/chart-performance-fixture.js';

const HOUR = 3_600_000, now = Date.parse('2026-10-26T12:00:00Z');
const summaryKeys = ['range', 'now', 'input', 'timingBenefit', 'heatingBenefit', 'heatingSavings', 'firewoodBenefit'];

test('comparison accounting equals the full chart through DST, gaps, incomplete prices and input selection', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const fixture = seedChartPerformanceFixture(store, { days: 3, now });
  recordHeatPumpConfiguration(store, 'providers', { heatPumpCompressorKw: 2, circulationKw: 0.1, auxRatedKw: 9 }, fixture.start);
  store.cycle('providers', { id: 'synthetic-completed-cycle', status: 'completed',
    startedAt: fixture.start, endedAt: now - HOUR,
    assessment: { basis: 'estimated-space-heating-execution-and-reference', profitCents: 75,
      uncertaintyCents: 20, referenceCostCents: 200, actualSpaceHeatingCostCents: 125 } });
  // Cross the selected left boundary and introduce conflicting physical energy.
  for (const phase of [1, 2, 3]) store.observation({ source: 'synthetic-other-meter', device: 'example-charger',
    signal: `ev1_energy_l${phase}`, value: 0.5, unit: 'kWh', quality: [],
    sourceTime: fixture.start + HOUR, receivedAt: fixture.start + HOUR,
    raw: { intervalStart: fixture.start - HOUR, intervalEnd: fixture.start + HOUR } });
  const states = store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
  const count = store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  for (const input of ['providers', 'offline', 'simulated']) for (const contract of [null, CHART_PERFORMANCE_CONTRACT]) {
    const args = { store, now, input, contract, view: 'power', startDate: '2026-10-24', endDate: '2026-10-26', points: 100 };
    const full = getChartData(args), summary = getChartData({ ...args, summaryOnly: true });
    for (const key of summaryKeys) assert.deepEqual(summary[key], full[key], `${input}: ${key}`);
    assert.deepEqual(summary.meta.priceAssumptions, full.meta.priceAssumptions);
    assert.deepEqual(summary.series, {}); assert.deepEqual(summary.shading, {});
    assert.equal(summary.meta.returnedPoints, 0);
  }
  assert.deepEqual(store.db.prepare('SELECT key,value FROM state ORDER BY key').all(), states);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, count);
});

test('summary reads omit property energy and chart learning projections', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const range = chartRange({ startDate: '2026-10-26', now });
  const queryContext = { voltageReader: {}, energyStart(prefix) { assert.equal(prefix, 'ev1'); return range.from; },
    *energyGroups(stats, prefix) {
      assert(['ev1', 'ev2'].includes(prefix), 'No full/property energy traversal');
      stats.rows = 3;
      yield { prefix, source: 'synthetic', start: range.from, end: range.from + HOUR, values: [0.5, 0.5, 0.5] };
    } };
  const facade = { db: { prepare(sql) {
    assert(!sql.includes('FROM learning_journal'), 'No chart-only model input projection');
    return store.db.prepare(sql);
  } } };
  const summary = getChartData({ store: facade, now, input: 'providers', view: 'power', summaryOnly: true,
    startDate: range.startDate, endDate: range.endDate, _queryContext: queryContext });
  assert.equal(summary.meta.summaryOnly, true);
});

test('summary requests reject detail, ambiguous and unsupported shapes at browser and worker boundaries', () => {
  const base = { view: 'power', startDate: '2026-10-26', endDate: '2026-10-26', summaryOnly: true };
  assert.match(chartQuery(base), /summary=1/);
  assert(!chartQuery({ ...base, summaryOnly: undefined }).includes('summary='));
  for (const changes of [{ summaryOnly: 'true' }, { view: 'garage' }, { view: undefined, left: 'power' },
    { viewFrom: now - HOUR, viewTo: now }, { viewTo: now }]) {
    assert.throws(() => chartQuery({ ...base, ...changes }));
    assert.throws(() => chartRequestRange({ ...base, ...changes }));
  }
});
