import { selectedChartView } from '../chart/chart-views.js';
import { explorerSelection } from '../chart/series-explorer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarTicks, chartQuery, createChartLoader, defaultPalette, finnishDate, historyDatasets, historySeriesAt, selectedRange, dateSelection, shiftDate, validDate, visible, historyValueLabel, coefficientStatusLabel, sessionPointDetail } from '../chart/history-model.js';
import { stackPowerSeries } from '../chart/power-stack.js';
import { MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { Envelope } from '../src/app/chart-data.js';

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

test('the renderer requires current view descriptors instead of obsolete left-axis selections', () => {
  assert.throws(() => historyDatasets({}, 'power'), /chart view/);
  assert.throws(() => historyDatasets({}), /chart view/);
  assert.equal(visible('dhwr', { dhwr: false }), false);
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

test('the power view offers the saved average while explorer rooms keep their measured colours', () => {
  const series = { model_indoor_temperature: [{ x: 1, y: 20.5 }], indoor_temperature: [{ x: 1, y: 23 }],
    downstairs_temperature: [{ x: 1, y: 20 }], bedroom_temperature: [{ x: 1, y: 19 }], garage_temperature: [{ x: 1, y: 12 }] };
  const datasets = historyDatasets(series, selectedChartView({ view: 'power' }));
  const average = datasets.find(row => row.key === 'model_indoor_temperature');
  assert.equal(average.label, 'Average indoor');
  assert.equal(average.data, series.model_indoor_temperature);
  assert.equal(average.yAxisID, 'right');
  assert.equal(average.borderColor, '#81ca99');
  assert.equal(average.stepped, false);
  for (const [key, label, color] of [['indoor_temperature', 'Upstairs', 'upstairs'],
    ['downstairs_temperature', 'Downstairs', 'downstairs'], ['bedroom_temperature', 'Bedroom', 'bedroom']]) {
    assert(!datasets.some(row => row.key === key), `${label} is not another default indoor line`);
    const selected = historyDatasets(series, explorerSelection(key), { [key]: false });
    const room = selected.find(row => row.key === key);
    assert.equal(room.label, label);
    assert.equal(room.yAxisID, 'right');
    assert.equal(room.data, series[key]);
    assert.equal(room.borderColor, defaultPalette[color]);
    assert.equal(room.hidden, true);
    assert.equal(selected.filter(row => row.key === 'model_indoor_temperature').length, 0, 'A raw room does not add unrelated context');
  }
  const palette = { ...defaultPalette, indoor: '#112233', outdoor: '#445566' };
  const themed = historyDatasets(series, selectedChartView({ view: 'power' }), {}, palette);
  assert.equal(themed.find(row => row.key === 'model_indoor_temperature').borderColor, palette.indoor);
  assert.equal(themed.find(row => row.key === 'outdoor_temperature').borderColor, palette.outdoor);
});

test('the property-temperature view keeps both garage probes and all rooms on one axis', () => {
  const rooms = ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature'];
  const signals = [...rooms, 'garage_temperature', 'garage_temperature_2'];
  const series = Object.fromEntries(signals.map((key, index) => [key, [{ x: 1, y: 23 - index * 2 }]]));
  series.model_indoor_temperature = [{ x: 1, y: 21 }];
  const datasets = historyDatasets(series, selectedChartView({ view: 'temperatures' }));
  assert.equal(datasets.filter(row => row.yAxisID === 'left').length, 0);
  assert(signals.every(key => datasets.find(row => row.key === key).yAxisID === 'right'));
  assert.equal(new Set(datasets.map(row => row.key)).size, datasets.length, 'The shared garage reading is not duplicated on the right axis');
  for (const key of signals) {
    assert.equal(datasets.filter(row => row.key === key).length, 1);
    assert.equal(datasets.find(row => row.key === key).data, series[key]);
  }
  assert.equal(datasets.find(row => row.key === 'model_indoor_temperature').yAxisID, 'right');
  assert.equal(datasets.find(row => row.key === 'outdoor_temperature').yAxisID, 'right');
  assert.equal(datasets.find(row => row.key === 'garage_temperature').yAxisID, 'right');
  const roomAndAverage = datasets.filter(row => [...rooms, 'model_indoor_temperature'].includes(row.key));
  assert.equal(new Set(roomAndAverage.map(row => row.borderColor)).size, 4);
  const garage = historyDatasets({ garage_temperature: [{ x: 1, y: 12 }] }, selectedChartView({ view: 'power' }), { garage_temperature: false })
    .find(row => row.key === 'garage_temperature');
  assert.equal(garage.yAxisID, 'right');
  assert.equal(garage.borderColor, defaultPalette.garage);
  assert.equal(garage.hidden, true, 'Garage retains its own visibility preference');
  assert.equal(garage.data[0].y, 12);
  assert(chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'temperatures' }).includes('left=temperatures'));
});

test('charger fills and independent forecast visibility retain exact missing and negative values', () => {
  const series = { property_power: [{ x: 1, y: 2 }, { x: 2, y: null }, { x: 3, y: 4 }], heating_integral: [{ x: 1, y: -300 }], all_in_price: [{ x: 1, y: -2 }, { x: 2, y: -2 }, { x: 2, y: null }] };
  const preferences = { outdoor_temperature: false, outdoor_forecast: false, spot_price: true };
  const power = historyDatasets(series, selectedChartView({ view: 'power' }), preferences);
  assert.equal(power.find(dataset => dataset.key === 'charger_power').fill, 'origin');
  assert.equal(power.find(dataset => dataset.key === 'charger_power').powerStacked, false);
  assert.equal(power.find(dataset => dataset.key === 'auxiliary_power').fill, false);
  assert(power.find(dataset => dataset.key === 'auxiliary_power').order < power.find(dataset => dataset.key === 'charger_power').order, 'The auxiliary line remains visible above the charging fill');
  assert(power.every(dataset => !dataset.stack), 'Explicit cumulative coordinates keep unrelated totals and right-axis readings out of the stack');
  assert.equal(power.find(dataset => dataset.key === 'charger_power').stepped, true);
  assert.equal(power.find(dataset => dataset.key === 'property_power').stepped, true);
  assert.equal(power.find(dataset => dataset.key === 'property_power').fill, false);
  assert.deepEqual(power.find(dataset => dataset.key === 'property_power').data, series.property_power);
  assert.deepEqual(power.find(dataset => dataset.key === 'property_power').pointRadius, [5, 0, 5], 'Isolated valid totals remain visible between gaps');
  assert.equal(power.find(dataset => dataset.key === 'outdoor_forecast').hidden, true);
  assert.deepEqual(power.find(dataset => dataset.key === 'outdoor_forecast').borderDash, [8, 3, 2, 3]);
  assert.equal(power.find(dataset => dataset.key === 'spot_price').hidden, false);
  assert.equal(historyDatasets(series, { leftSignals: ['heating_integral'], rightSignals: [] }, preferences)[0].data[0].y, -300);
  assert.deepEqual(power.find(dataset => dataset.key === 'all_in_price').data, series.all_in_price);
  assert.ok(power.every(dataset => !dataset.spanGaps && dataset.tension === 0));
});

test('charger fills align independent step times without incorporating estimated auxiliary heat', () => {
  const series = { auxiliary_power: [{ x: 0, y: 2 }, { x: 10, y: 3 }, { x: 20, y: 3 }],
    charger_power: [{ x: 0, y: 5, source: 'simulation' }, { x: 5, y: 4, source: 'simulation' }, { x: 20, y: 4, source: 'simulation' }],
    charger2_power: [{ x: 0, y: 2, source: 'meter' }, { x: 10, y: 3, source: 'meter' }, { x: 20, y: 3, source: 'meter' }],
    property_power: [{ x: 0, y: 12 }, { x: 20, y: 12 }] };
  const before = structuredClone(series);
  const datasets = historyDatasets(series, selectedChartView({ view: 'power' }));
  const auxiliary = datasets.find(dataset => dataset.key === 'auxiliary_power');
  const charger = datasets.find(dataset => dataset.key === 'charger_power');
  const charger2 = datasets.find(dataset => dataset.key === 'charger2_power');
  assert.equal(auxiliary.fill, false);
  assert.equal(auxiliary.data, series.auxiliary_power);
  assert.equal(charger.fill, 'origin');
  assert.equal(charger2.fill, datasets.indexOf(charger));
  assert.equal(charger2.powerStacked, true);
  assert.deepEqual(charger.data.map(({ x, y }) => [x, y]), [[0, 5], [5, 4], [10, 4], [20, 4]]);
  assert.deepEqual(charger2.data.map(({ x, y, componentValue }) => [x, y, componentValue]), [[0, 7, 2], [5, 6, 2], [10, 7, 3], [20, 7, 3]]);
  assert.equal(charger.data[2].source, 'simulation');
  assert.equal(datasets.find(dataset => dataset.key === 'property_power').data, series.property_power);
  assert.equal(datasets.find(dataset => dataset.key === 'property_power').fill, false);
  assert.deepEqual(series, before, 'Stack coordinates never overwrite source power observations');
  const onlyCharger = historyDatasets(series, selectedChartView({ view: 'power' }), { auxiliary_power: false, charger2_power: false });
  assert.equal(onlyCharger.find(dataset => dataset.key === 'charger_power').data, series.charger_power);
  assert.equal(onlyCharger.find(dataset => dataset.key === 'charger_power').fill, 'origin');
  assert.equal(onlyCharger.find(dataset => dataset.key === 'charger_power').powerStacked, false);
  assert.equal(onlyCharger.find(dataset => dataset.key === 'auxiliary_power').hidden, true);
  const onlyAuxiliary = historyDatasets(series, selectedChartView({ view: 'power' }), { charger_power: false });
  assert.equal(onlyAuxiliary.find(dataset => dataset.key === 'auxiliary_power').data, series.auxiliary_power);
  assert.equal(onlyAuxiliary.find(dataset => dataset.key === 'auxiliary_power').fill, false);
  assert.equal(onlyAuxiliary.find(dataset => dataset.key === 'charger_power').hidden, true);
});

test('power histories without shared auxiliary observations keep both original components visible', () => {
  const charger = [{ x: 0, y: 5, source: 'simulation' }, { x: 10, y: 5, source: 'simulation' }];
  for (const auxiliary of [[], [{ x: 30, y: 2 }]]) {
    const datasets = historyDatasets({ auxiliary_power: auxiliary, charger_power: charger }, selectedChartView({ view: 'power' }));
    const chargerDataset = datasets.find(dataset => dataset.key === 'charger_power');
    const auxiliaryDataset = datasets.find(dataset => dataset.key === 'auxiliary_power');
    assert.equal(chargerDataset.powerStacked, false, 'No shared observation can support a cumulative position');
    assert.equal(chargerDataset.fill, 'origin');
    assert.equal(chargerDataset.data, charger, 'Known charger history remains visible at its own recorded power');
    assert.equal(chargerDataset.hidden, false);
    assert.equal(auxiliaryDataset.data, auxiliary);
    assert.equal(auxiliaryDataset.fill, false);
    assert.equal(auxiliaryDataset.hidden, false);
  }
});

test('only charging fills stack while legend choices preserve every remaining component', () => {
  const series = Object.fromEntries([['auxiliary_power',2],['charger_power',4],['charger2_power',7],['property_power',15]]
    .map(([key,y])=>[key,[{x:0,y},{x:10,y}]]));
  const original = structuredClone(series);
  for (const preferences of [{},{auxiliary_power:false},{charger_power:false},{charger2_power:false},
    {auxiliary_power:false,charger_power:false}]) {
    const datasets=historyDatasets(series, selectedChartView({ view: 'power' }),preferences);
    let total=0, previous;
    const auxiliary = datasets.find(row => row.key === 'auxiliary_power');
    assert.equal(auxiliary.fill, false);
    assert.equal(auxiliary.data, series.auxiliary_power);
    for(const key of ['charger_power','charger2_power']) {
      const dataset=datasets.find(row=>row.key===key);
      if(preferences[key]===false) { assert.equal(dataset.hidden,true);continue; }
      total+=series[key][0].y;
      assert.equal(dataset.data[0].y,total,`${key} stacked value`);
      assert.equal(dataset.fill,previous?datasets.indexOf(previous):'origin');
      assert.equal(dataset.data[0].componentValue??dataset.data[0].y,series[key][0].y,'tooltip retains own power');
      if(previous)assert(previous.order>dataset.order,'lower fill draws first');
      previous=dataset;
    }
    assert.equal(datasets.find(row=>row.key==='property_power').data,series.property_power);
    assert.equal(datasets.find(row=>row.key==='charger_power').label,'Charger 1');
    assert.equal(datasets.find(row=>row.key==='charger2_power').label,'Charger 2');
    assert.notEqual(datasets.find(row=>row.key==='charger_power').borderColor,datasets.find(row=>row.key==='property_power').borderColor);
    assert.equal(datasets.find(row=>row.key==='charger2_power').borderColor,defaultPalette.ev2);
  }
  assert.deepEqual(series,original,'display stack does not change recorded component histories');
  assert.deepEqual(historyDatasets({}, selectedChartView({ view: 'phases' })).filter(row=>row.key.startsWith('ev1_')).map(row=>row.label),
    ['Charger 1 L1','Charger 1 L2','Charger 1 L3']);
});

test('session check axes show single reference points, including hollow excluded comparisons, without extending readings', () => {
  for(const [key,label,basis] of [['ev1_session_energy_check','Charger 1','electricity-meter']]) {
    const points=[{x:2,y:10,sessionCheck:true,referenceBasis:basis,comparisonEligible:true},
      {x:4,y:3,sessionCheck:true,referenceBasis:basis,comparisonEligible:false}];
    const dataset=historyDatasets({[key]:points}, explorerSelection(key)).find(row=>row.key===key);
    assert.equal(dataset.label,label);
    assert.equal(dataset.showLine,false);
    assert.equal(dataset.pointRadius,5);
    assert.equal(dataset.pointBackgroundColor,'transparent');
    assert.deepEqual(dataset.pointBorderWidth,[2,1]);
    assert.equal(historySeriesAt({now:8,range:{from:0,to:10},series:{[key]:points}})[key],points);
    assert.match(sessionPointDetail(points[0]),/included in session averages/);
    assert.match(sessionPointDetail(points[1]),/excluded from session averages/);
    assert.match(sessionPointDetail(points[0]),/session electricity meter/);
  }
});

test('stack alignment retains duplicate interval edges and their original tooltip provenance', () => {
  const auxiliary = [{ x: 0, y: 2 }, { x: 10, y: 3 }, { x: 20, y: 3 }];
  const charger = [{ x: 0, y: 5, intervalStart: 0, intervalEnd: 10 }, { x: 10, y: 5, intervalStart: 0, intervalEnd: 10 },
    { x: 10, y: 4, intervalStart: 10, intervalEnd: 20 }, { x: 20, y: 4, intervalStart: 10, intervalEnd: 20 }];
  const aligned = stackPowerSeries([auxiliary, charger]);
  assert.deepEqual(aligned[0].map(({ x, y }) => [x, y]), [[0, 2], [10, 2], [10, 3], [20, 3]]);
  assert.deepEqual(aligned[1].map(({ x, y, componentValue }) => [x, y, componentValue]), [[0, 7, 5], [10, 7, 5], [10, 7, 4], [20, 7, 4]]);
  assert.deepEqual(aligned[1].map(({ intervalStart, intervalEnd }) => [intervalStart, intervalEnd]), [[0, 10], [0, 10], [10, 20], [10, 20]]);
  const withBreak = stackPowerSeries([auxiliary, [charger[0], { x: 10, y: 5 }, { x: 10, y: null }, { x: 10, y: 4 }, charger.at(-1)]]);
  assert.deepEqual(withBreak[1].filter(point => point.x === 10).map(point => point.y), [7, null, 7], 'A same-timestamp break must survive');
});

test('stack alignment never invents a baseline outside auxiliary coverage or across either data gap', () => {
  const auxiliary = [{ x: 5, y: 2 }, { x: 10, y: 2 }, { x: 11, y: null }, { x: 20, y: 3 }, { x: 30, y: 3 }];
  const charger = [{ x: 0, y: 5 }, { x: 7, y: 5 }, { x: 15, y: 4 }, { x: 25, y: 4 }, { x: 40, y: 4 }];
  const aligned = stackPowerSeries([auxiliary, charger]);
  const at = x => aligned[1].find(point => point.x === x);
  assert.equal(at(0).y, null);
  assert.equal(at(7).y, 7);
  assert.equal(at(11).y, null);
  assert.equal(at(15).y, null);
  assert.equal(at(25).y, 7);
  assert.equal(at(40).y, null);
  assert.equal(at(15).componentValue, 4, 'Unavailable stacked position does not reinterpret the recorded charger reading');
  const gap = stackPowerSeries([[{ x: 0, y: 2 }, { x: 10, y: 2 }, { x: 20, y: 2 }], [{ x: 0, y: 5 }, { x: 15, y: null }, { x: 20, y: 4 }]]);
  assert.equal(gap[1].find(point => point.x === 10).y, null, 'Adding a lower boundary must not bridge a charger gap');
  assert(stackPowerSeries([[], charger])[1].every(point => point.y === null));
});

test('stack alignment preserves continuous energy coverage after the API envelope reduces interval points', () => {
  const envelope = new Envelope(0, 100, 1);
  for (const [index, y] of [5, 5, 1, 1, 9, 9, 4, 4, 4, 4].entries()) {
    const start = index * 10, end = start + 10;
    const detail = { intervalStart: start, intervalEnd: end, fromEnergy: true };
    envelope.add(start, y, detail); envelope.add(end - 1, y, detail);
  }
  envelope.add(100, null);
  const reduced = envelope.values();
  assert(reduced.length < 21, 'Exercise actual API point reduction');
  const auxiliary = [0, 10, 30, 50, 80, 100].map(x => ({ x, y: 2 }));
  const aligned = stackPowerSeries([auxiliary, reduced]);
  assert(aligned[1].filter(point => point.x < 100).every(point => Number.isFinite(point.y)), 'Retained interval metadata must not fabricate gaps between continuous display segments');
  assert.deepEqual(aligned[1].filter(point => point.y === null).map(point => point.x), [100]);
  assert.equal(aligned[1].find(point => point.x === 10).intervalEnd, 10, 'Tooltip provenance survives even where intervening intervals were reduced');
  assert.equal(aligned[1].find(point => point.x === 10).componentValue, 5);
});

test('stacked energy gaps follow explicit missing markers while held tails retain their status', () => {
  const auxiliary = [{ x: 0, y: 2 }, { x: 15, y: 2 }, { x: 30, y: 2 }];
  const interval = { x: 0, y: 5, intervalStart: 0, intervalEnd: 10, fromEnergy: true };
  const aligned = stackPowerSeries([auxiliary, [interval, { ...interval, x: 9 }, { x: 10, y: null }, { x: 19, y: null },
    { x: 20, y: 4, intervalStart: 20, intervalEnd: 30 }, { x: 29, y: 4, intervalStart: 20, intervalEnd: 30 }, { x: 30, y: null }]]);
  assert.equal(aligned[1].find(point => point.x === 10).y, null);
  assert.equal(aligned[1].find(point => point.x === 15).y, null);
  assert.equal(aligned[1].find(point => point.x === 30).y, null);
  const held = stackPowerSeries([auxiliary, [interval, { ...interval, x: 30, carriedForward: true, observedAt: 0 }]]);
  const midpoint = held[1].find(point => point.x === 15);
  assert.equal(midpoint.y, 7);
  assert.equal(midpoint.componentValue, 5);
  assert.equal(midpoint.carriedForward, true);
  assert.equal(midpoint.observedAt, 0);
  assert.equal(midpoint.intervalEnd, 10, 'Held display tails do not rewrite the measurement interval');
});

test('chart queries preserve selected dates without expanding to forecast horizon', () => {
  assert.equal(chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'power' }), '/api/chart?start=2026-09-08&end=2026-09-08&left=power&points=800');
  assert.throws(() => chartQuery({ startDate: '2026-09-08', endDate: '2026-09-07', left: 'power' }), /end date/);
  assert.throws(() => chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: 'injected' }), /chart view or series/);
});

test('coefficient history keeps exact replay metadata and visible steps alongside shared right-axis readings', () => {
  for (const [key, info] of Object.entries(MODEL_COEFFICIENT_INFO)) {
    const points = [{ x: 1000, y: 0.018, modelCoefficient: true, coefficientStatus: 'initial' },
      { x: 2000, y: 0.0187, modelCoefficient: true, coefficientStatus: 'fitted', modelUpdatedAt: 2000 },
      { x: 3000, y: null }];
    const datasets = historyDatasets({ [key]: points }, explorerSelection(key));
    const coefficient = datasets.find(dataset => dataset.yAxisID === 'left');
    assert.equal(coefficient.key, key);
    assert.equal(coefficient.label, info.label);
    assert.equal(coefficient.data, points);
    assert.equal(coefficient.stepped, true);
    assert.equal(coefficient.spanGaps, false);
    assert.equal(coefficient.tension, 0);
    assert.deepEqual(datasets.filter(dataset => dataset.yAxisID === 'right').map(dataset => dataset.key), ['all_in_price', 'spot_price']);
    assert(chartQuery({ startDate: '2026-09-08', endDate: '2026-09-08', left: key }).includes(`left=${key}`));
  }
  assert.equal(historyValueLabel('model_coefficient_heat_loss', 0.0187, '1/h · heat loss'), '0.0187 1/h');
  assert.equal(historyValueLabel('model_coefficient_hydronic_response', 0.0798, '°C/kWh thermal'), '0.0798 °C/kWh thermal');
  assert.equal(historyValueLabel('model_coefficient_solar_response', 0, '°C/h per kW/m²'), '0.000 °C/h per kW/m²');
  assert.equal(historyValueLabel('model_coefficient_fireplace_response', 0.135, '°C/kg'), '0.135 °C/kg');
  assert.equal(historyValueLabel('model_controller_phase', 2, 'state'), 'Tariff reduction');
  assert.equal(historyValueLabel('indoor_temperature', 21.256, '°C'), '21.26 °C');
  assert.equal(coefficientStatusLabel('observed'), 'Recorded normal-heating average');
  assert.match(coefficientStatusLabel('initial'), /Initial estimate/);
  assert.match(coefficientStatusLabel('fitted'), /Fitted in current model/);
  assert.match(coefficientStatusLabel('retained'), /Retained from an earlier fit/);
  assert.match(coefficientStatusLabel('fixed-prior'), /Fixed assumption/);
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

test('recorder updates allow slow chart requests to finish before fetching newer history', async () => {
  const requests = [];
  const loader = createChartLoader({ api: (path, { signal }) => new Promise(resolve => requests.push({ signal, resolve })) });
  const selection = { startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' };
  const first = loader.load(selection);
  await Promise.resolve();
  for (let poll = 0; poll < 10; poll++) assert.equal(loader.load(selection, { force: true }), first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve({ revision: 1 });
  assert.deepEqual(await first, { revision: 1 });
  const next = loader.load(selection);
  await Promise.resolve();
  assert.equal(requests.length, 2, 'An update during the query expires its cache for the next poll');
  requests[1].resolve({ revision: 2 });
  assert.deepEqual(await next, { revision: 2 });
  assert.deepEqual(await loader.load(selection), { revision: 2 });
  loader.close();
});

test('explicit configuration or correction invalidation still cancels pending chart history', async () => {
  const requests = [];
  const loader = createChartLoader({ api: (path, { signal }) => new Promise(resolve => requests.push({ signal, resolve })) });
  const selection = { startDate: '2026-09-07', endDate: '2026-09-07', left: 'power' };
  const first = loader.load(selection);
  await Promise.resolve();
  const rejected = assert.rejects(first, { name: 'AbortError' });
  loader.invalidate();
  assert.equal(requests[0].signal.aborted, true);
  const next = loader.load(selection, { force: true });
  await Promise.resolve();
  requests[1].resolve({ revision: 2 });
  assert.deepEqual(await next, { revision: 2 });
  requests[0].resolve({ revision: 1 });
  await rejected;
  loader.close();
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

test('start date changes select one day; choosing an end activates the inclusive range', () => {
  const selection = { startDate: '2026-09-08', endDate: '2026-09-15' };
  for (const startDate of ['2026-08-08', '2026-09-08', '2026-09-12', '2026-09-15']) {
    assert.deepEqual(dateSelection(selection, 'start', startDate), { startDate, endDate: startDate });
  }
  assert.deepEqual(dateSelection(selection, 'start', '2026-09-16'), { startDate: '2026-09-16', endDate: '2026-09-16' });
  assert.deepEqual(dateSelection({ startDate: '2026-09-08', endDate: '2026-09-08' }, 'start', '2026-08-08'),
    { startDate: '2026-08-08', endDate: '2026-08-08' });
  for (const value of ['', '2026-02-30']) assert.equal(dateSelection(selection, 'start', value), null);
  assert.deepEqual(dateSelection(selection, 'end', '2026-09-08'), { startDate: '2026-09-08', endDate: '2026-09-08' });
  assert.deepEqual(dateSelection(selection, 'end', '2026-09-20'), { startDate: '2026-09-08', endDate: '2026-09-20' });
  for (const value of ['2026-09-07', '', '2026-02-30']) assert.equal(dateSelection(selection, 'end', value), null);
});

test('smooth curves stay uncluttered and axis styles differ while price styling stays dotted', () => {
  const values = Array.from({ length: 200 }, (_, x) => ({ x, y: 20 + x / 10 }));
  const datasets = historyDatasets({ indoor_temperature: values, garage_temperature: values }, { leftSignals: ['indoor_temperature'], rightSignals: ['garage_temperature', 'all_in_price'] });
  const left = datasets.find(row => row.key === 'indoor_temperature');
  const right = datasets.find(row => row.key === 'garage_temperature');
  assert.equal(left.pointStyle, 'circle'); assert(left.pointRadius.every(radius => radius === 0));
  assert.equal(right.pointStyle, 'circle'); assert(right.pointRadius.every(radius => radius === 0));
  assert.deepEqual(left.borderDash, []); assert.deepEqual(right.borderDash, [6, 4]);
  assert(left.borderWidth < 1.8 && right.borderWidth < 1.8);
  assert.deepEqual(datasets.find(row => row.key === 'all_in_price').borderDash, [1, 3]);
});
