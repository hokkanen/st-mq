import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { seedVoltage } from './voltage-fixture.js';
import { getChartData } from '../src/app/chart-data.js';
import { ChargingAllowanceHistory } from '../src/charging/allowance-history.js';
import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';
import { selectedChartView, readChartPreferences } from '../chart/chart-views.js';
import { explorerSelection } from '../chart/series-explorer.js';
import { activityTracks } from '../chart/chart-overlays.js';
import { historyDatasets, historySeriesAt, defaultPalette } from '../chart/history-model.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';

const start = Date.parse('2026-10-05T06:00:00Z'), MINUTE = 60_000;
const query = (store, extra = {}) => getChartData({ store, input: 'providers', now: start + 60 * MINUTE,
  startDate: '2026-10-05', endDate: '2026-10-05', view: 'charging_currents', ...extra });
function propertyInterval(store, index, currents, duration = MINUTE) {
  const from = start + index * duration, end = from + duration;
  for (const [phase, current] of currents.entries()) store.observation({ source: 'easee', device: 'synthetic-property',
    signal: `property_energy_l${phase + 1}`, value: current === null ? null : current * 230 / 1000 * duration / 3600_000,
    unit: 'kWh', sourceTime: end, receivedAt: end, quality: current === null ? ['missing'] : ['estimated'],
    raw: { intervalStart: from, intervalEnd: end, durationMs: duration, basis: 'integrated-power-phase-allocation' } });
}
const status = (chargerId, mode, allowanceA, at) => ({ mode, allowanceA, maximumCurrentA: 16,
  reportedAllowanceA: null, reason: mode === 'fallback' ? 'feed-unavailable' : 'property-headroom',
  source: chargerId === 'charger1' ? 'easee-equalizer' : 'st-mq-load-balancing',
  measuredAt: at, receivedAt: at, sourceTimes: [], sourceEpoch: null, limiter: null });
const put = (history, chargerId, mode, allowanceA, offset) => history.observe({ chargerId,
  association: (chargerId === 'charger1' ? 'a' : 'b').repeat(64), status: status(chargerId, mode, allowanceA, start + offset) }, start + offset);

test('charging currents replaces the session view while All series preserves C1 native checks and no balancing strips', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const view = selectedChartView({ view: 'charging_currents' });
  assert.deepEqual(view.leftSignals, ['property_current_max', 'ev1_current_allowance', 'ev2_current_allowance', 'ev2_current_fallback']);
  assert.equal(view.unit, 'A'); assert(view.rightSignals.includes('model_indoor_temperature'));
  assert.deepEqual(view.tracks, []);
  assert(!Object.hasOwn(CHART_VIEW_BY_KEY, 'session_checks'));
  assert.throws(() => query(store, { view: 'session_checks' }), /Unknown chart view/);
  assert.throws(() => selectedChartView({ view: 'session_checks' }), /Choose a chart view/);
  const preferences = readChartPreferences({ getItem: () => JSON.stringify({ view: 'session_checks', views: { session_checks: {} } }) });
  assert.equal(preferences.view, 'power'); assert(!Object.hasOwn(preferences.views, 'session_checks'));
  assert(!activityTracks.some(track => track.key === 'shellyLimiter'));
  assert(Object.values(CHART_VIEW_BY_KEY).every(row => !row.tracks.includes('shellyLimiter')));
  assert.deepEqual(explorerSelection('charger2_power').tracks, []);
  assert.deepEqual(explorerSelection('ev1_session_energy_check').leftSignals, ['ev1_session_energy_check']);
  recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'synthetic-complete', start, end: start + MINUTE,
    estimatedKwh: 1, referenceKwh: 1.1, complete: true, quality: [] });
  const checks = query(store, { view: undefined, left: 'ev1_session_energy_check' });
  assert.deepEqual(checks.series.ev1_session_energy_check.map(({ x, y }) => [x, y]), [[start + MINUTE, 1.1]]);
  assert(!Object.keys(query(store).series).some(key => key.includes('session')));
});

test('property maximum uses each original phase group before display reduction and keeps missing phases as gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seedVoltage(store, start);
  const values = Array.from({ length: 500 }, (_, index) => index === 251 ? [2, null, 3]
    : index % 3 === 0 ? [12, 2, 3] : index % 3 === 1 ? [2, 10, 3] : [2, 3, 8]);
  values.forEach((currents, index) => propertyInterval(store, index, currents, 1000));
  const before = store.observations({ limit: 2000 });
  const chart = query(store, { points: 100 }), curve = chart.series.property_current_max;
  assert(curve.some(point => point.y === null && point.x >= start + 251_000 && point.x < start + 252_000));
  for (const point of curve.filter(point => Number.isFinite(point.y))) {
    const currents = values[Math.floor((point.x - start) / 1000)];
    assert(currents.every(Number.isFinite));
    assert(Math.abs(point.y - Math.max(...currents)) < 1e-8, 'A decimated maximum must still belong to its original instant');
    assert.equal(point.equivalentCurrent, true);
  }
  const detail = query(store, { viewFrom: start + 123_200, viewTo: start + 124_800 });
  assert(Math.abs(detail.series.property_current_max.find(point => point.x === start + 123_200).y - 12) < 1e-8);
  assert.deepEqual(store.observations({ limit: 2000 }), before, 'Projection never stores another property-current signal');
  assert(!Object.keys(chart.series).some(key => /^property_current_l[123]$/.test(key)));
});

test('property maximum requires all historical phase voltages and uses the same interval basis as phase loading', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  propertyInterval(store, 0, [10, 9.5, 6]);
  assert(query(store).series.property_current_max.every(point => point.y === null));
  seedVoltage(store, start, [230, 230, 230]);
  seedVoltage(store, start + MINUTE / 2, [250, 230, 230]);
  const series = query(store).series.property_current_max;
  assert.equal(series.find(point => point.x === start).y, 10);
  assert.equal(series.find(point => point.x === start + MINUTE / 2).y, 9.5);
  const tooltip = historyTooltipLabel({ dataset: { key: 'property_current_max', label: 'Property highest phase', unit: 'A' },
    parsed: series[0], raw: series[0] });
  assert.match(tooltip, /highest simultaneous phase.*interval average.*unity power factor/);
});

test('allowance series preserve zero and fallback zero, exact transitions, gaps and separate source clocks', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = new ChargingAllowanceHistory({ store, input: 'providers' });
  for (const id of ['charger1', 'charger2']) { put(history, id, 'unrestricted', 16, 0); put(history, id, 'unrestricted', 16, 5000); }
  put(history, 'charger1', 'limited', 10.5, 10_000); put(history, 'charger1', 'limited', 10.5, 15_000);
  put(history, 'charger2', 'limited', 0, 10_000); put(history, 'charger2', 'limited', 0, 15_000);
  put(history, 'charger2', 'fallback', 0, 20_000); put(history, 'charger2', 'fallback', 0, 25_000);
  put(history, 'charger2', 'fallback', 12, 30_000); put(history, 'charger2', 'fallback', 12, 35_000);
  put(history, 'charger2', 'unknown', null, 40_000); put(history, 'charger2', 'unknown', null, 45_000);
  put(history, 'charger2', 'limited', 8, 50_000); put(history, 'charger2', 'limited', 8, 55_000);
  const chart = query(store, { points: 100 }), { ev1_current_allowance: first, ev2_current_allowance: second, ev2_current_fallback: fallback } = chart.series;
  assert(first.some(point => point.y === 10.5));
  assert(second.some(point => point.x === start + 10_000 && point.y === 0));
  assert(second.some(point => point.x === start + 20_000 && point.y === null));
  assert(fallback.some(point => point.x === start + 20_000 && point.y === 0));
  assert(fallback.some(point => point.x === start + 30_000 && point.y === 12));
  assert(second.filter(point => point.x >= start + 20_000 && point.x < start + 50_000).every(point => point.y === null));
  assert(fallback.filter(point => point.x < start + 20_000 || point.x >= start + 35_000).every(point => point.y === null));
  assert(!JSON.stringify(chart.series).includes('a'.repeat(64)));
  assert(!Object.hasOwn(chart, 'limiterHistory'));
  assert.equal(chart.meta.chargingAllowances.charger2.truncated, false);
  assert.deepEqual(historySeriesAt(chart, chart.now + MINUTE).ev2_current_allowance, second, 'Browser never extends allowance beyond observed coverage');
  const point = fallback.find(point => point.y === 12);
  const text = historyTooltipLabel({ dataset: { key: 'ev2_current_fallback', label: 'Charger 2 fallback', unit: 'A' }, parsed: point, raw: point });
  assert.match(text, /fallback cap.*not measured draw or charging permission.*decision time.*received/);
  assert.doesNotMatch(text, /st-mq|source measured/i);
});

test('charging allowance styles remain stepped and unfilled, with purple dash-dot fallback and temperature context', () => {
  const view = selectedChartView({ view: 'charging_currents' });
  for (const interpolation of [true, false]) {
    const datasets = historyDatasets({}, view, view.defaults, defaultPalette, { interpolation });
    for (const key of view.leftSignals) {
      const row = datasets.find(row => row.key === key);
      assert.equal(row.stepped, true); assert.equal(row.fill, false); assert.equal(row.spanGaps, false); assert.equal(row.yAxisID, 'left');
      assert.deepEqual(row.borderDash, key === 'ev2_current_fallback' ? [8, 3, 2, 3] : []);
    }
    assert.equal(datasets.find(row => row.key === 'ev2_current_fallback').borderColor, defaultPalette.learning);
    assert.notEqual(datasets.find(row => row.key === 'ev1_current_allowance').borderColor, datasets.find(row => row.key === 'ev2_current_allowance').borderColor);
    assert.equal(datasets.find(row => row.key === 'model_indoor_temperature').yAxisID, 'right');
  }
});
