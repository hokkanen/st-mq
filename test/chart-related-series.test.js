import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voltageStore } from './voltage-fixture.js';
import { importCsv } from '../src/storage/history.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { createHistoricalPricing } from '../src/app/chart-prices.js';
import { validateContract } from '../src/domain/prices.js';
import { historySeriesAt } from '../chart/history-model.js';
import { RelatedStepSampler, alignRelatedSamples } from '../src/app/chart-related-series.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const start = Date.parse('2026-09-08T08:00:00Z');
const property = [2, 15, 1, 12, 4, 10, 3], charger = [0, 0, 0, 8, 2, 6, 1];
const auxiliary = [0, 0, 0, 3, 0, 3, 0], second = [0, 0, 0, 1, 1, 1, 1];
const args = { input: 'providers', now: start + 24 * HOUR, startDate: '2026-01-01', endDate: '2026-09-08', points: 100 };
function put(store, signal, value, at, unit = 'A', raw) {
  store.observation({ source: 'synthetic', device: 'synthetic-device', signal, value, unit,
    sourceTime: at, receivedAt: at, quality: [], raw });
}
function coherent(series, names) {
  const original = names.map(name => series[name]);
  const from = Math.max(...original.map(rows => rows[0]?.x ?? Infinity));
  const to = Math.min(...original.map(rows => rows.at(-1)?.x ?? -Infinity));
  const channels = original.map(rows => rows.filter(point => point.x >= from && point.x <= to));
  assert(channels.every(rows => rows.length === channels[0].length));
  for (let index = 0; index < channels[0].length; index++) {
    const points = channels.map(rows => rows[index]);
    assert(points.every(point => point.x === points[0].x), 'Related channels share both step-edge positions');
    if (points.every(point => Number.isFinite(point.y)))
      assert(points[0].y + 1e-9 >= points.slice(1).reduce((sum, point) => sum + point.y, 0),
        `A displayed component sum cannot exceed its coherent original total at ${points[0].x}`);
  }
}

test('coarsened native power and phase channels retain the corresponding property value at charger peaks', t => {
  const store = voltageStore(); t.after(() => store.close());
  for (let index = 0; index < property.length; index++) {
    const at = start + index * MINUTE;
    for (let phase = 1; phase <= 3; phase++) {
      put(store, `property_current_l${phase}`, property[index] / 3 / 0.23, at);
      put(store, `ev1_current_l${phase}`, charger[index] / 3 / 0.23, at);
    }
    put(store, 'auxiliary_power', auxiliary[index], at, 'kW');
  }
  const power = getChartData({ store, ...args, left: 'power' });
  assert.equal(power.meta.relatedSampling.basis, 'shared-original-step-times');
  coherent(power.series, ['property_power', 'auxiliary_power', 'charger_power']);
  assert(power.series.charger_power.some(point => Math.abs(point.y - 8) < 1e-9), 'The real peak is not clamped away');
  const atPeak = power.series.property_power.find(point => point.x === start + 3 * MINUTE && point.y !== null);
  assert(Math.abs(atPeak.y - 12) < 1e-9);
  assert(!atPeak.displayBoundary, 'A recovered original reading keeps its original observed timestamp');
  for (const phase of [1, 2, 3]) {
    const phases = getChartData({ store, ...args, left: 'phases' });
    coherent(phases.series, [`property_current_l${phase}`, `ev1_current_l${phase}`]);
  }
  // A real source inconsistency remains visible: alignment changes presentation,
  // never a measurement merely to fit an expected household relationship.
  for (let phase = 1; phase <= 3; phase++) put(store, `ev1_current_l${phase}`, 40 / 3 / 0.23, start + 3 * MINUTE);
  const actualViolation = getChartData({ store, ...args, left: 'power' });
  assert(actualViolation.series.charger_power.some(point => Math.abs(point.y - 40) < 1e-9));
});

test('recorded interval power aligns every load and phase while retaining original energy provenance', t => {
  const store = voltageStore(); t.after(() => store.close());
  for (let index = 0; index < property.length; index++) {
    const at = start + index * MINUTE, end = at + MINUTE;
    for (const [prefix, value] of [['property', property[index]], ['ev1', charger[index]], ['ev2', second[index]]])
      for (let phase = 1; phase <= 3; phase++) put(store, `${prefix}_energy_l${phase}`, value / 60 / 3,
        end, 'kWh', { intervalStart: at, intervalEnd: end });
    put(store, 'auxiliary_power', auxiliary[index], at, 'kW');
  }
  store.db.exec('PRAGMA query_only=ON');
  const power = getChartData({ store, ...args, left: 'power' });
  coherent(power.series, ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power']);
  for (const name of ['property_power', 'charger_power', 'charger2_power'])
    assert(power.series[name].filter(point => point.y !== null).every(point => point.fromEnergy
      && point.intervalEnd - point.intervalStart === MINUTE));
  const phases = getChartData({ store, ...args, left: 'phases' });
  for (const phase of [1, 2, 3]) coherent(phases.series, [`property_current_l${phase}`, `ev1_current_l${phase}`]);
  const detail = getChartData({ store, ...args, left: 'power', viewFrom: start, viewTo: start + 7 * MINUTE, points: 2000 });
  for (const name of ['property_power', 'charger_power', 'charger2_power']) {
    const peak = Math.max(...power.series[name].map(point => point.y ?? -Infinity));
    assert(Math.abs(peak - Math.max(...detail.series[name].map(point => point.y ?? -Infinity))) < 1e-9);
  }
});

test('compact CSV power and phases share their original timestamps and coherent values', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chart-related-'));
  const store = voltageStore(); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'synthetic-easee.csv');
  writeFileSync(path, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
    ...property.map((value, index) => [(start + index * MINUTE) / 1000,
      ...Array(3).fill(charger[index] / 3 / 0.23), ...Array(3).fill(value / 3 / 0.23)].join(','))].join('\n'));
  await importCsv(store, path, { kind: 'easee' });
  for (const left of ['power', 'phases']) {
    const result = getChartData({ store, ...args, left, now: Date.now() });
    assert(result.meta.relatedSampling);
    if (left === 'power') coherent(result.series, ['property_power', 'charger_power']);
    else for (const phase of [1, 2, 3]) coherent(result.series, [`property_current_l${phase}`, `ev1_current_l${phase}`]);
  }
});

test('shared sampling keeps source duplicate precedence and disconnects an omitted later outage', () => {
  const propertySampler = new RelatedStepSampler(0, 100, [0, 10, 100]);
  for (const [x, y] of [[0, 10], [10, 10], [10, 20], [20, null], [30, 20], [50, null], [60, 20], [100, 20]])
    propertySampler.add(x, y, { source: 'synthetic' });
  const chargerSampler = new RelatedStepSampler(0, 100, [0, 10, 100]);
  for (const [x, y] of [[0, 5], [10, 5], [10, 15], [100, 15]]) chargerSampler.add(x, y);
  const result = alignRelatedSamples({ property: propertySampler.values(), charger: chargerSampler.values() });
  coherent(result, ['property', 'charger']);
  assert.deepEqual(result.property.filter(point => point.x === 10).map(point => point.y), [20]);
  assert.deepEqual(result.charger.filter(point => point.x === 10).map(point => point.y), [15]);
  assert(result.property.some(point => point.y === null && point.x > 10 && point.x < 100),
    'A source gap omitted by the initial pixel envelope still interrupts the plotted line');
  assert(result.property.length <= 7, 'Memory/output follow shared targets, not the number of source gaps');
  assert.deepEqual(propertySampler.values(), propertySampler.values(), 'Reading the projection is idempotent');
  const explicitEdges = alignRelatedSamples({ property: [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 100, y: 20 }],
    charger: [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 15 }, { x: 100, y: 15 }] });
  coherent(explicitEdges, ['property', 'charger']);
  assert.deepEqual(explicitEdges.property.filter(point => point.x === 10).map(point => point.y), [10, 20]);
});

test('conflicting original interval projections become unavailable while sequential tails remain readable', t => {
  const store = voltageStore(); t.after(() => store.close());
  for (const [at, end, kw] of [[start, start + 2 * MINUTE, 3], [start + MINUTE, start + 3 * MINUTE, 6],
    [start + MINUTE, start + 3 * MINUTE, 9], [start + 3 * MINUTE, start + 4 * MINUTE, 3]])
    for (let phase = 1; phase <= 3; phase++) put(store, `ev1_energy_l${phase}`,
      kw * (end - at) / HOUR / 3, end, 'kWh', { intervalStart: at, intervalEnd: end });
  for (let phase = 1; phase <= 3; phase++) {
    put(store, `ev1_current_l${phase}`, 1, start - MINUTE);
    put(store, `ev1_current_l${phase}`, 99, start + MINUTE);
  }
  const result = getChartData({ store, ...args, left: 'power' });
  assert(result.meta.relatedSampling);
  assert(result.series.charger_power.every((point, index, rows) => !index || point.x >= rows[index - 1].x));
  assert(!result.series.charger_power.some(point => point.x < start + 3 * MINUTE && point.x >= start && Number.isFinite(point.y)));
  assert.equal(result.meta.recordedEnergy.conflicts, 1);
  assert(result.series.charger_power.some(point => point.x >= start + 3 * MINUTE && Math.abs(point.y - 3) < 1e-9));
  assert(!result.series.charger_power.some(point => point.y > 10), 'Legacy currents cannot overtake recorded energy after handover');
  const range = { from: start, to: start + 4 * MINUTE };
  const original = new Envelope(range.from, range.to, 2000);
  addRecordedEnergy({ store, range, now: args.now, input: args.input,
    envelopes: { charger_power: original }, timing: { addEnergy() {} } });
  const fine = new Map(original.values().map(point => [point.x, point.y]));
  for (const point of result.series.charger_power.filter(point => !point.displayBoundary && point.x >= start))
    assert.equal(point.y, fine.get(point.x), 'Coarse original points retain the fine projection’s duplicate handling');
});

test('dated-rate prices share source times, including negative spot and authoritative interval overrides', t => {
  const store = voltageStore(); t.after(() => store.close());
  const spots = [-2, 15, -3, 12, 4, 10, 3];
  const slot = 15 * MINUTE;
  const rates = { marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night',
    transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } };
  const contract = { periods: [{ ...rates, from: start - HOUR, to: start + 3 * slot },
    { ...rates, from: start + 3 * slot, marginCtPerKwh: 20 }] };
  const pricing = createHistoricalPricing(validateContract(contract));
  for (let index = 0; index < spots.length; index++) put(store, 'spot_price', spots[index], start + index * slot, 'c/kWh_ex_vat');
  for (const withMarket of [false, true]) {
    const market = withMarket ? { fetchedAt: start, intervals: spots.map((spotCtPerKwh, index) => ({
      start: start + index * slot, end: start + (index + 1) * slot,
      spotCtPerKwh: spotCtPerKwh - 1, unit: 'c/kWh', vatIncluded: false, source: 'Synthetic price fixture' })) } : undefined;
    const result = getChartData({ store, ...args, left: 'power', contract, market });
    assert(result.meta.relatedSampling.groups.some(group => group.includes('spot_price')));
    coherent(result.series, ['all_in_price', 'spot_price']);
    assert(result.series.spot_price.some(point => point.y < 0), 'Negative market prices remain visible');
    for (let index = 0; index < result.series.spot_price.length; index++) {
      const spot = result.series.spot_price[index], total = result.series.all_in_price[index];
      if (!Number.isFinite(spot.y) || !Number.isFinite(total.y)) continue;
      const originalIndex = Math.min(spots.length - 1, Math.floor((spot.x - start) / slot));
      assert.equal(spot.y, spots[originalIndex] - (withMarket ? 1 : 0));
      assert.equal(total.y, pricing.total(spot.x, spot.y).totalCtPerKwh);
    }
  }
});

test('coarse power and phases retain live carry-forward while real missing final readings still break it', t => {
  const store = voltageStore(); t.after(() => store.close());
  const now = start + 10 * MINUTE;
  for (let index = 0; index <= 6; index++) for (let phase = 1; phase <= 3; phase++) {
    const at = start + index * MINUTE;
    if (index <= 4) put(store, `property_current_l${phase}`, property[index] / 0.69, at);
    put(store, `ev1_current_l${phase}`, charger[index] / 0.69, at);
  }
  for (const left of ['power', 'phases']) for (const missing of [false, true]) {
    if (missing) for (let phase = 1; phase <= 3; phase++)
      put(store, `property_current_l${phase}`, null, start + 5 * MINUTE);
    const coarse = getChartData({ store, ...args, now, left });
    const fine = getChartData({ store, ...args, now, left, points: 2000, viewFrom: start, viewTo: now + MINUTE });
    const key = left === 'power' ? 'property_power' : 'property_current_l1';
    const coarseLast = historySeriesAt(coarse, now)[key].at(-1), fineLast = historySeriesAt(fine, now)[key].at(-1);
    assert.equal(coarseLast.x, fineLast.x);
    assert.equal(coarseLast.y, fineLast.y);
    assert.equal(coarseLast.carriedForward, fineLast.carriedForward);
    if (missing) { assert.equal(coarseLast.y, null); assert(!coarseLast.carriedForward); }
    else { assert.equal(coarseLast.x, now); assert(coarseLast.carriedForward); assert.equal(coarseLast.observedAt, start + 4 * MINUTE); }
    if (missing) store.db.prepare("DELETE FROM observations WHERE source_time=? AND signal LIKE 'property_current_l%'").run(start + 5 * MINUTE);
  }
});
