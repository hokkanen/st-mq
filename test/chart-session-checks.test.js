import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { getChartData } from '../src/app/chart-data.js';
import { recordChargingSessionCheck, chargingSessionCheckSummaries } from '../src/app/charging-session-checks.js';
import { HISTORY_AXES } from '../src/domain/history-series.js';
import { historyDatasets, historySeriesAt } from '../chart/history-model.js';

const HOUR = 3_600_000, start = Date.parse('2026-02-03T10:00:00Z');

test('meter checks offer one finalized-session entry per charger and no charger cumulative or asymmetric energy axes', () => {
  const meterChecks = HISTORY_AXES.filter(axis => axis.group === 'Meter checks');
  assert.deepEqual(meterChecks.map(axis => axis.label), ['Property meter counter', 'Charger 1', 'Charger 2']);
  assert.deepEqual(meterChecks.map(axis => axis.key), ['property_import_energy_counter', 'ev1_session_energy_check', 'tesla_session_energy_check']);
  assert(!HISTORY_AXES.some(axis => ['ev1_lifetime_energy_counter', 'ev1_session_energy_counter', 'ev2_energy'].includes(axis.key)));
});

test('charger meter charts project each saved session reference once, distinguish excluded comparisons and never hold between sessions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const put = (source, key, offset, referenceKwh, complete = true) => recordChargingSessionCheck(store, {
    source, sessionKey: key, start: start + offset * HOUR, end: start + (offset + 1) * HOUR,
    estimatedKwh: 12, referenceKwh, complete, quality: complete ? [] : ['incomplete-coverage'],
  });
  put('easee', 'invented-first', 0, 10);
  put('easee', 'invented-first', 0, 10);
  put('easee', 'invented-second', 2, 8, false);
  put('teslamate', 'invented-other', 0, 9);
  put('teslamate', 'invented-missing-reference', 2, null, false);
  put('easee', 'invented-future', 5, 30);
  put('easee', 'invented-old', -48, 40);
  store.observation({ source: 'invented-raw', device: 'invented-device', signal: 'ev1_session_energy_check',
    sourceTime: start + HOUR, receivedAt: start + HOUR, value: 999, unit: 'kWh', quality: [] });
  const counts = () => ['events', 'state', 'observations', 'energy_audits'].map(table => store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const before = counts();
  const options = { store, input: 'providers', startDate: '2026-02-03', endDate: '2026-02-03', now: start + 4 * HOUR };
  const one = getChartData({ ...options, left: 'ev1_session_energy_check' });
  const two = getChartData({ ...options, left: 'tesla_session_energy_check' });
  assert.deepEqual(one.series.ev1_session_energy_check.map(point => [point.x, point.y]), [[start + HOUR, 10], [start + 3 * HOUR, 8]]);
  assert.deepEqual(two.series.tesla_session_energy_check.map(point => [point.x, point.y]), [[start + HOUR, 9], [start + 3 * HOUR, null]]);
  assert.equal(one.meta.chargingSessions.records, 2);
  const first = one.series.ev1_session_energy_check[0], partial = one.series.ev1_session_energy_check[1];
  assert(first.auditOnly && first.sessionCheck && first.comparisonEligible);
  assert.equal(first.estimatedKwh, 12);
  assert.equal(first.referenceBasis, 'electricity-meter');
  assert.equal(first.sessionStart, start);
  assert.equal(partial.comparisonEligible, false);
  assert.equal(two.series.tesla_session_energy_check[0].referenceBasis, 'energy-added');
  assert(!JSON.stringify(one.series).includes('invented-'), 'Chart metadata exposes no session or device identities');
  for (const chart of [one, two]) {
    const dataset = historyDatasets(chart.series, chart.left).find(row => row.key === chart.left);
    assert.equal(dataset.showLine, false);
    assert.equal(dataset.fill, false);
    const shown = historySeriesAt(chart, options.now + HOUR);
    assert.deepEqual(shown[chart.left], chart.series[chart.left], 'Session references cannot be extended as ongoing measurements');
  }
  assert.equal(chargingSessionCheckSummaries(store)[0].summary.excludedSessions, 1);
  assert.deepEqual(counts(), before, 'Session charts and summary calculations are read-only projections');
});
