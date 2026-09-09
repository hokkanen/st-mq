import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarTicks, chartQuery, createChartLoader, finnishDate, historyDatasets, historySeriesAt, selectedRange, shiftDate, validDate, visible, historyValueLabel, coefficientStatusLabel } from '../chart/history-model.js';
import { MODEL_COEFFICIENT_INFO, RIGHT_AXIS_SIGNALS } from '../src/domain/history-series.js';

test('calendar controls use Finnish dates across UTC midnight, leap days and both clock changes', () => {
  assert.equal(finnishDate(Date.parse('2026-09-07T21:30:00Z')), '2026-09-08');
  assert.deepEqual(selectedRange('yesterday', Date.parse('2026-03-29T21:30:00Z')), { startDate: '2026-03-29', endDate: '2026-03-30' });
  assert.deepEqual(selectedRange('tomorrow', Date.parse('2026-10-24T22:30:00Z')), { startDate: '2026-10-25', endDate: '2026-10-26' });
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate('2026-01-01<script>'), false);
  assert.throws(() => shiftDate('2026-02-30', 1), /valid calendar/);
});

test('left axis groups remain exclusive while all shared temperatures and prices survive every choice', () => {
  const shared = ['indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast', 'all_in_price', 'spot_price'];
  for (const [left, expected] of [['power', ['property_power', 'auxiliary_power', 'charger_power']], ['phases', ['property_current_l1', 'property_current_l2', 'property_current_l3', 'ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3']], ['integral', ['heating_integral']],
    ...['learning_profit','learning_aux_profit','learning_recovery_error','learning_indoor_temperature'].map(name => [name, [name]]), ['solar_radiation', ['solar_radiation', 'solar_forecast']]]) {
    const datasets = historyDatasets({}, left);
    assert.deepEqual(datasets.filter(dataset => dataset.yAxisID === 'left').map(dataset => dataset.key), expected);
    assert.deepEqual(datasets.filter(dataset => dataset.yAxisID === 'right').map(dataset => dataset.key), shared);
    assert.equal(datasets.find(dataset => dataset.key === 'all_in_price').hidden, false);
    assert.equal(datasets.find(dataset => dataset.key === 'spot_price').hidden, false);
  }
  assert.equal(visible('dhwr'), false);
  assert.equal(visible('heatOff'), true);
  assert.equal(visible('compressorSpace'), true);
  assert.equal(visible('compressorDhw'), true);
  assert.equal(visible('operatingMode'), true);
  assert.equal(visible('spot_price', { spot_price: false }), false, 'Explicit saved choices win over new defaults');
});

test('axis ticks stay on whole Finnish hours and calendar days across DST with exact outer bounds', () => {
  const hours = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const range of [
    { startDate: '2026-03-29', endDate: '2026-03-29', from: Date.parse('2026-03-28T22:00Z'), to: Date.parse('2026-03-29T21:00Z') },
    { startDate: '2026-10-25', endDate: '2026-10-25', from: Date.parse('2026-10-24T21:00Z'), to: Date.parse('2026-10-25T22:00Z') },
  ]) {
    const ticks = calendarTicks(range, 9);
    assert.equal(ticks[0].value, range.from); assert.equal(ticks.at(-1).value, range.to);
    assert.ok(ticks.every(tick => hours.format(tick.value).endsWith(':00')));
    assert.ok(ticks.every((tick, index) => !index || tick.value > ticks[index - 1].value));
  }
  const range = { startDate: '2026-03-25', endDate: '2026-04-05', from: Date.parse('2026-03-24T22:00Z'), to: Date.parse('2026-04-05T21:00Z') };
  const ticks = calendarTicks(range, 5);
  assert.ok(ticks.length <= 5);
  assert.ok(ticks.every(tick => hours.format(tick.value) === '00:00'));
  assert.deepEqual(ticks.map(tick => finnishDate(tick.value)), ['2026-03-25', '2026-03-28', '2026-03-31', '2026-04-03', '2026-04-06']);
});

test('charger fills and shared outdoor visibility retain exact missing and negative values', () => {
  const series = { property_power: [{ x: 1, y: 2 }, { x: 2, y: null }, { x: 3, y: 4 }], heating_integral: [{ x: 1, y: -300 }], all_in_price: [{ x: 1, y: -2 }, { x: 2, y: -2 }, { x: 2, y: null }] };
  const preferences = { outdoor_temperature: false, spot_price: true };
  const power = historyDatasets(series, 'power', preferences);
  assert.equal(power.find(dataset => dataset.key === 'charger_power').fill, 'origin');
  assert.equal(power.find(dataset => dataset.key === 'auxiliary_power').fill, 'origin');
  assert(power.find(dataset => dataset.key === 'auxiliary_power').order > power.find(dataset => dataset.key === 'charger_power').order, 'Chart.js draws auxiliary first, then overlays charger');
  assert(power.every(dataset => !dataset.stack), 'Power fills use independent zero baselines');
  assert.equal(power.find(dataset => dataset.key === 'charger_power').stepped, true);
  assert.equal(power.find(dataset => dataset.key === 'property_power').stepped, true);
  assert.equal(power.find(dataset => dataset.key === 'property_power').fill, false);
  assert.deepEqual(power.find(dataset => dataset.key === 'property_power').data, series.property_power);
  assert.deepEqual(power.find(dataset => dataset.key === 'property_power').pointRadius, [2, 0, 2], 'Isolated valid totals remain visible between gaps');
  assert.equal(power.find(dataset => dataset.key === 'outdoor_forecast').hidden, true);
  assert.deepEqual(power.find(dataset => dataset.key === 'outdoor_forecast').borderDash, [5, 4]);
  assert.equal(power.find(dataset => dataset.key === 'spot_price').hidden, false);
  assert.equal(historyDatasets(series, 'integral', preferences)[0].data[0].y, -300);
  assert.deepEqual(power.find(dataset => dataset.key === 'all_in_price').data, series.all_in_price);
  assert.ok(power.every(dataset => !dataset.spanGaps && dataset.tension === 0));
});

test('chart queries preserve selected dates without expanding to forecast horizon', () => {
  assert.equal(chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'power' }), '/api/chart?start=2026-09-08&end=2026-09-08&left=power&points=800');
  assert.throws(() => chartQuery({ startDate: '2026-09-08', endDate: '2026-09-07', left: 'power' }), /end date/);
  assert.throws(() => chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'injected' }), /left axis/);
});

test('coefficient history keeps exact replay metadata and visible steps alongside shared right-axis readings', () => {
  for (const [key, info] of Object.entries(MODEL_COEFFICIENT_INFO)) {
    const points = [{ x: 1000, y: 0.018, modelCoefficient: true, coefficientStatus: 'initial' },
      { x: 2000, y: 0.0187, modelCoefficient: true, coefficientStatus: 'fitted', modelUpdatedAt: 2000 },
      { x: 3000, y: null }];
    const datasets = historyDatasets({ [key]: points }, key);
    const coefficient = datasets.find(dataset => dataset.yAxisID === 'left');
    assert.equal(coefficient.key, key);
    assert.equal(coefficient.label, info.label);
    assert.equal(coefficient.data, points);
    assert.equal(coefficient.stepped, true);
    assert.equal(coefficient.spanGaps, false);
    assert.equal(coefficient.tension, 0);
    assert.deepEqual(datasets.filter(dataset => dataset.yAxisID === 'right').map(dataset => dataset.key), RIGHT_AXIS_SIGNALS);
    assert(chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: key }).includes(`left=${key}`));
  }
  assert.equal(historyValueLabel('model_coefficient_heat_loss', 0.0187, '1/h · heat loss'), '0.0187 1/h');
  assert.equal(historyValueLabel('model_coefficient_compressor_response', 0.7503, '°C/h'), '0.750 °C/h');
  assert.equal(historyValueLabel('model_coefficient_solar_response', 0, '°C/h per kW/m²'), '0.000 °C/h per kW/m²');
  assert.equal(historyValueLabel('model_coefficient_auxiliary_response', 0.135, '°C/kWh'), '0.135 °C/kWh');
  assert.equal(historyValueLabel('model_controller_phase', 2, 'state'), 'Tariff reduction');
  assert.equal(historyValueLabel('indoor_temperature', 21.256, '°C'), '21.26 °C');
  assert.match(coefficientStatusLabel('initial'), /Initial estimate/);
  assert.match(coefficientStatusLabel('fitted'), /Fitted in the accepted model/);
  assert.match(coefficientStatusLabel('retained'), /Retained value \/ awaiting evidence/);
  assert.match(coefficientStatusLabel(), /unavailable/);
});

test('quick navigation cancels obsolete downloads even if their transport ignores cancellation', async () => {
  const requests = [];
  const loader = createChartLoader({ api: (path, { signal }) => new Promise(resolve => requests.push({ path, signal, resolve })) });
  const first = loader.load({ startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' });
  await Promise.resolve();
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = loader.load({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'phases' });
  await Promise.resolve();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ chosen: 'tomorrow' });
  assert.deepEqual(await second, { chosen: 'tomorrow' });
  requests[0].resolve({ chosen: 'old day' });
  await rejection;
  loader.close();
});

test('cache coalesces duplicate polls, preserves fast return navigation and expires live data sooner', async () => {
  let time = Date.parse('2026-09-07T12:00:00Z'), calls = 0;
  const loader = createChartLoader({ now: () => time, api: async () => ({ call: ++calls }) });
  const today = { startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' };
  const past = { ...today, startDate: '2026-09-01', endDate: '2026-09-01' };
  const first = loader.load(today), duplicate = loader.load(today);
  assert.equal(first, duplicate);
  assert.deepEqual(await first, { call: 1 });
  time += 15_000;
  assert.deepEqual(await loader.load(today), { call: 1 });
  assert.deepEqual(await loader.load(past), { call: 2 });
  assert.deepEqual(await loader.load(today), { call: 1 });
  time += 60_000;
  assert.deepEqual(await loader.load(today), { call: 3 });
  assert.deepEqual(await loader.load(past), { call: 2 });
  loader.invalidate();
  assert.deepEqual(await loader.load(past), { call: 4 });
});
test('a live year view refreshes at five-minute intervals to keep frequent status polling inexpensive',async()=>{
  let time=Date.parse('2026-09-08T12:00Z'),calls=0;
  const loader=createChartLoader({now:()=>time,api:async()=>({call:++calls})});
  const year={startDate:'2025-09-09',endDate:'2026-09-08',left:'power'};
  assert.equal((await loader.load(year)).call,1);
  time+=60000;assert.equal((await loader.load(year)).call,1);
  time+=240000;assert.equal((await loader.load(year)).call,2);
  assert.equal((await loader.load(year,{force:true})).call,3);
});

test('bounded response cache evicts least recently used date/axis combinations', async () => {
  let calls = 0;
  const loader = createChartLoader({ api: async () => ({ call: ++calls }), maxEntries: 2 });
  const base = { startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' };
  await loader.load(base);
  await loader.load({ ...base, left: 'phases' });
  assert.deepEqual(await loader.load(base), { call: 1 });
  await loader.load({ ...base, left: 'integral' });
  assert.deepEqual(await loader.load({ ...base, left: 'phases' }), { call: 4 });
  loader.close();
});

test('all measured lines carry their last value to each fresh status time without changing cached history', async () => {
  const from = Date.parse('2026-09-07T00:00:00+03:00'), recordedAt = from + 3_600_000;
  let now = from + 4 * 3_600_000, calls = 0;
  const keys = ['indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'property_power', 'charger_power',
    ...['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)), 'heating_integral'];
  const series = Object.fromEntries(keys.map((key, index) => [key, [{ x: recordedAt, y: index - 3 }]]));
  for (const key of ['all_in_price', 'spot_price', 'outdoor_forecast']) series[key] = [{ x: recordedAt, y: 5 }];
  const original = { range: { from, to: from + 24 * 3_600_000 }, now, series };
  const before = structuredClone(original);
  const loader = createChartLoader({ now: () => now, api: async () => { calls++; return original; } });
  const selection = { startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' };
  for (let poll = 0; poll < 3; poll++, now += 15_000) {
    const cached = await loader.load(selection);
    const display = historySeriesAt(cached, now);
    for (const key of keys) {
      assert.deepEqual(display[key].at(-1), { x: now, y: series[key][0].y, carriedForward: true, observedAt: recordedAt });
      assert.equal(display[key].length, 2, 'Each refresh starts from original history');
    }
    for (const key of ['all_in_price', 'spot_price', 'outdoor_forecast']) assert.equal(display[key], series[key]);
    assert.deepEqual(original, before);
  }
  assert.equal(calls, 1, 'The tail moves while the HTTP response stays cached');
  loader.close();
});

test('old readings can start a live day, while missing, historical and future readings remain unextended', () => {
  const from = 1_000_000, now = from + 100_000, to = from + 200_000;
  const payload = { range: { from, to }, now, series: {
    indoor_temperature: [], garage_temperature: [{ x: from + 10, y: 12 }, { x: from + 20, y: null }],
    outdoor_temperature: [], property_power: [{ x: now + 1, y: 3 }], charger_power: [],
  }, meta: { lastReadings: { indoor_temperature: { x: from - 86_400_000, y: 21 },
    garage_temperature: { x: from + 20, y: null }, outdoor_temperature: { x: from - 10, y: null },
    charger_power: { x: from - 86_400_000, y: 0 } } } };
  const display = historySeriesAt(payload);
  assert.deepEqual(display.indoor_temperature, [from, now].map(x => ({ x, y: 21, carriedForward: true, observedAt: from - 86_400_000 })));
  assert.deepEqual(display.charger_power, [from, now].map(x => ({ x, y: 0, carriedForward: true, observedAt: from - 86_400_000 })));
  for (const key of ['garage_temperature', 'outdoor_temperature', 'property_power']) assert.equal(display[key], payload.series[key]);
  assert.equal(historySeriesAt(payload, to), payload.series, 'Past dates retain recorded historical gaps');
  assert.equal(historySeriesAt(payload, from - 1), payload.series, 'Future dates do not invent observations');
  assert.equal(historySeriesAt(payload, NaN), payload.series);
});
