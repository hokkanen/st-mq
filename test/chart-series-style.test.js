import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDatasets, historySeriesAt, defaultPalette } from '../chart/history-model.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';
import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { temperatureIntervalKnots } from '../chart/temperature-curves.js';

const observations = [{ x: 0, y: 15 }, { x: 10, y: 17 }, { x: 20, y: null }, { x: 30, y: 16 }];
const descriptor = (leftSignals, rightSignals = []) => ({ leftSignals, rightSignals });

test('curated view datasets contain only their selected quantities and preserve independent forecast controls', () => {
  const view = CHART_VIEW_BY_KEY.garage;
  const data = historyDatasets({}, view, { ...view.defaults, outdoor_temperature: false, outdoor_forecast: true,
    garage_native_indoor_temperature: true });
  assert.deepEqual(data.map(row => row.key), [...view.leftSignals, ...view.rightSignals]);
  assert(!data.some(row => row.key.endsWith('_price') || row.key === 'model_indoor_temperature'));
  assert.equal(data.find(row => row.key === 'outdoor_forecast').hidden, false);
  assert.equal(data.find(row => row.key === 'outdoor_temperature').hidden, true);
  assert.equal(data.find(row => row.key === 'garage_native_indoor_temperature').hidden, false);
  assert.equal(new Set(['garage_temperature', 'garage_temperature_2', 'garage_native_indoor_temperature']
    .map(key => data.find(row => row.key === key).borderColor)).size, 3);
});

test('axis strokes do not change interpolation and forecast or price patterns take precedence', () => {
  const keys = ['bedroom_temperature', 'garage_native_indoor_temperature', 'garage_model_front', 'room_setting',
    'learning_indoor_temperature', 'outdoor_forecast', 'solar_forecast', 'solar_radiation', 'model_solar_radiation', 'spot_price'];
  const series = Object.fromEntries(keys.map(key => [key, observations]));
  for (const axis of ['left', 'right']) {
    const data = historyDatasets(series, axis === 'left' ? descriptor(keys) : descriptor([], keys));
    for (const row of data) {
      const forecast = ['outdoor_forecast', 'solar_forecast'].includes(row.key);
      const solarEstimate = ['solar_radiation', 'model_solar_radiation'].includes(row.key);
      assert.deepEqual(row.borderDash, forecast ? [8, 3, 2, 3] : solarEstimate ? [] : row.key === 'spot_price' ? [1, 3]
        : axis === 'right' ? [6, 4] : [], row.key);
      assert.equal(row.spanGaps, false);
      assert.equal(row.data, observations, 'Display styles never rewrite source samples');
    }
    for (const key of ['bedroom_temperature', 'garage_native_indoor_temperature', 'garage_model_front', 'outdoor_forecast', 'room_setting', 'learning_indoor_temperature']) {
      assert.equal(data.find(row => row.key === key).cubicInterpolationMode, 'monotone');
      assert.equal(data.find(row => row.key === key).stepped, false);
    }
    for (const key of ['model_solar_radiation'])
      assert.equal(data.find(row => row.key === key).stepped, true, key);
  }
});

test('recorded quantities use deliberate time semantics across axes, with no phase fills', () => {
  const keys = ['property_power', 'auxiliary_power', 'ev1_current_l1', 'compressor_hours', 'model_coefficient_heat_loss',
    'compressor_active', 'heating_integral', 'caravan_humidity', 'firewood_load', 'garage_native_energy'];
  for (const axis of ['left', 'right']) {
    const datasets = historyDatasets(Object.fromEntries(keys.map(key => [key, observations])),
      axis === 'left' ? descriptor(keys) : descriptor([], keys));
    const byKey = Object.fromEntries(datasets.map(row => [row.key, row]));
    for (const key of keys.slice(0, 6).filter(key => key !== 'compressor_hours')) assert.equal(byKey[key].stepped, true, `${axis}: ${key}`);
    assert.equal(byKey.compressor_hours.showLine, false);
    assert.equal(byKey.compressor_hours.pointBackgroundColor, 'transparent');
    assert.equal(byKey.heating_integral.stepped, false);
    assert.equal(byKey.heating_integral.cubicInterpolationMode, 'default');
    assert.equal(byKey.caravan_humidity.cubicInterpolationMode, 'monotone');
    for (const key of ['firewood_load', 'garage_native_energy']) {
      assert.equal(byKey[key].showLine, false);
      assert(byKey[key].pointRadius >= 4);
    }
    assert.equal(byKey.auxiliary_power.fill, false);
    assert.equal(byKey.ev1_current_l1.fill, false);
  }
});

test('charging bands stay semantically coloured and translucent without changing measured totals', () => {
  const view = CHART_VIEW_BY_KEY.power;
  const series = { property_power: [{ x: 0, y: 10 }, { x: 10, y: 10 }],
    charger_power: [{ x: 0, y: 2 }, { x: 10, y: 2 }], charger2_power: [{ x: 0, y: 3 }, { x: 10, y: 3 }],
    auxiliary_power: [{ x: 0, y: 4 }, { x: 10, y: 4 }] };
  const data = historyDatasets(series, view, { ...view.defaults, auxiliary_power: true });
  const charger = data.find(row => row.key === 'charger_power'), charger2 = data.find(row => row.key === 'charger2_power');
  assert.equal(charger.borderColor, defaultPalette.ev);
  assert.equal(charger2.borderColor, defaultPalette.ev2);
  assert.notEqual(charger.backgroundColor, charger.borderColor);
  assert.equal(charger2.data[0].y, 5);
  assert.equal(charger2.data[0].componentValue, 3);
  assert.equal(data.find(row => row.key === 'property_power').data, series.property_power);
  assert.equal(data.find(row => row.key === 'auxiliary_power').data, series.auxiliary_power);
});

test('temperature knot reduction keeps changed readings and source evidence without fabricating envelope gaps', () => {
  const points = [
    { x: 0, y: 10, intervalStart: 0, intervalEnd: 10, source: 'room' },
    { x: 5, y: 11, intervalStart: 0, intervalEnd: 10, source: 'room' },
    { x: 9, y: 11, intervalStart: 0, intervalEnd: 10, source: 'room' },
    { x: 20, y: 12, intervalStart: 20, intervalEnd: 30, source: 'room' },
    { x: 25, y: 12, intervalStart: 20, intervalEnd: 30, source: 'external' },
    { x: 30, y: null },
  ];
  const reduced = temperatureIntervalKnots(points);
  assert(reduced.includes(points[0]) && reduced.includes(points[1]), 'Real changes within an interval survive');
  assert(reduced.includes(points[3]) && reduced.includes(points[4]), 'A source change survives');
  assert.deepEqual(reduced.filter(point => point.y === null), [points[5]], 'Reduced-away intervals are not missing-data evidence');
  assert(reduced.every(point => points.includes(point)), 'Every plotted knot retains its original provenance');
  const encoded = [0, 10, 20].flatMap(start => [start, start + 9].map(x => ({
    x, y: start, intervalStart: start, intervalEnd: start + 10, quality: ['good'], source: 'room',
  })));
  assert.deepEqual(temperatureIntervalKnots(JSON.parse(JSON.stringify(encoded))).map(point => point.x), [0, 10, 20, 29],
    'JSON-decoded quality arrays do not restore artificial staircase edges');
});

test('optional same-phase charger bands retain phase hues with distinct source shades', () => {
  const view = CHART_VIEW_BY_KEY.phases;
  const points = Array.from({ length: 60 }, (_, x) => ({ x, y: x % 4 }));
  const datasets = historyDatasets(Object.fromEntries(view.leftSignals.map(key => [key, points])), view);
  for (const phase of [1, 2, 3]) {
    const rows = ['property', 'ev1', 'ev2'].map(prefix => datasets.find(row => row.key === `${prefix}_current_l${phase}`));
    assert.equal(rows[0].borderColor, defaultPalette[`phase${phase}`]);
    assert.equal(new Set(rows.map(row => row.borderColor)).size, 3, 'Sources remain distinguishable on the same phase');
    assert.deepEqual(rows.map(row => row.borderDash), [[], [], []]);
    assert(rows.every(row => row.pointStyle === 'circle'));
    assert(rows.slice(1).every(row => row.kind === 'fill' && row.pointRadius.every(radius => radius === 0)));
    assert.equal(rows[0].fill, false);
    assert.equal(rows[1].fill, 'origin');
    assert.equal(rows[2].fill, datasets.indexOf(rows[1]));
    assert(rows.every(row => row.stepped === true));
  }
});

test('comparable equipment roles have distinct colours within each view', () => {
  for (const keys of [
    ['supply_temperature', 'return_temperature', 'heating_setpoint', 'maximum_supply_setting'],
    ['model_indoor_temperature', 'model_target_temperature', 'learning_indoor_temperature'],
    ['heating_pump_speed', 'brine_pump_speed'], ['learning_profit', 'learning_aux_profit'],
    ['compressor_hours', 'dhw_hours', 'auxiliary_3kw_hours', 'auxiliary_6kw_hours'],
  ]) {
    const rows = historyDatasets({}, descriptor(keys));
    assert.equal(new Set(rows.map(row => row.borderColor)).size, keys.length, keys.join(', '));
  }
});

test('garage interval and counter tooltips preserve their distinct quantity and evidence', () => {
  const label = (key, raw) => historyTooltipLabel({ dataset: { key, label: 'Garage energy', unit: 'kWh' }, parsed: { x: 10, y: 2 }, raw });
  assert.match(label('garage_native_energy', { auditOnly: true }), /cumulative native meter counter; not interval consumption/);
  assert.doesNotMatch(label('garage_native_energy', { auditOnly: true }), /recorded interval energy/);
  assert.match(label('garage_energy', { basis: 'counter-delta', accuracyVerified: true }), /native meter difference.*accuracy verified/);
  assert.match(label('garage_energy', { basis: 'power-trapezoid', provisional: true, accuracyVerified: false }), /integrated reported power.*provisional estimate.*accuracy unverified/);
  assert.match(label('garage_energy', { basis: 'unsupported-private-value' }), /measurement basis unavailable/);
  assert.doesNotMatch(label('garage_energy', { basis: 'unsupported-private-value' }), /unsupported-private-value/);
});

test('both garage probes and bounded interpreted readings share honest held tails and expiry gaps', () => {
  const reading = { x: 10, y: 12, periodicCoverage: true, observedAt: 10, reportExpiresAt: 40 };
  const keys = ['garage_temperature', 'garage_temperature_2', 'garage_native_indoor_temperature'];
  const source = { range: { from: 0, to: 100 }, now: 20, series: Object.fromEntries(keys.map(key => [key, [reading]])) };
  for (const key of keys) {
    const fresh = historySeriesAt(source, 30)[key].at(-1);
    assert.equal(fresh.x, 30); assert.equal(fresh.y, 12); assert.equal(fresh.observedAt, 10); assert.equal(fresh.carriedForward, true);
    assert.equal(historySeriesAt(source, 50)[key].at(-1).y, null);
  }
  const unbounded = [{ x: 10, y: 12 }];
  assert.equal(historySeriesAt({ ...source, series: { garage_native_indoor_temperature: unbounded } }, 50).garage_native_indoor_temperature, unbounded);
  assert.equal(source.series.garage_temperature_2.length, 1);
});
