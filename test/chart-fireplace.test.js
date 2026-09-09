import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Envelope, getChartData } from '../src/app/chart-data.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';
import { createChartService } from '../src/app/chart-service.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { addFireplaceInputs, addFirewoodOutcomes, FIREPLACE_INPUT_NAMES, FIREWOOD_OUTCOME_NAMES } from '../src/app/chart-fireplace.js';
import { FIREPLACE_RESPONSE } from '../src/domain/fireplace.js';
import { HISTORY_AXES } from '../src/domain/history-series.js';

const HOUR = 3_600_000, start = Date.parse('2026-09-08T08:00:00Z');
function envelopes(keys, range) {
  return Object.fromEntries(keys.map(key => [key, new Envelope(range.from, range.to, 4000)]));
}
function inputs(store, range, now = range.to, input = 'providers') {
  const values = envelopes(FIREPLACE_INPUT_NAMES, range);
  const meta = addFireplaceInputs({ store, input, range, now, envelopes: values });
  return { meta, series: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.values()])) };
}

test('manual chart inputs preserve simultaneous additions, correction revision, source isolation and read-only projection', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = addFireplace(store, 'providers', { requestId: 'synthetic-a', kg: 8 }, start);
  addFireplace(store, 'providers', { requestId: 'synthetic-b', kg: 6 }, start);
  addFireplace(store, 'simulated', { requestId: 'synthetic-c', kg: 2 }, start);
  const range = { from: start - HOUR, to: start + 2 * HOUR };
  store.db.exec('PRAGMA query_only=ON');
  const original = inputs(store, range);
  assert.deepEqual(original.series.firewood_load.map(row => [row.x, row.y, row.loadCount]), [[start, 14, 2]]);
  assert(original.series.model_fireplace_release.some(row => row.x < start && row.y === null));
  assert(original.series.model_fireplace_release.some(row => row.x >= start && row.y > 0));
  assert.equal(inputs(store, range, range.to, 'simulated').series.firewood_load[0].y, 2);
  assert(!JSON.stringify(original).includes('synthetic-'), 'Retry identifiers stay private to the source log');
  store.db.exec('PRAGMA query_only=OFF');
  removeFireplace(store, 'providers', { requestId: 'synthetic-remove', id: first.id }, range.to);
  const corrected = inputs(store, range);
  assert.equal(corrected.series.firewood_load[0].y, 6);
  assert.notEqual(corrected.meta.revision, original.meta.revision);
  assert.equal(inputs(store, range, start + HOUR).series.firewood_load[0].y, 14, 'Future corrections cannot enter an earlier as-of view');
});

test('release plots earlier loads, known zero after removals, and a load exactly at now', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = addFireplace(store, 'providers', { requestId: 'synthetic-tail', kg: 8 }, start);
  const range = { from: start + 48 * HOUR, to: start + 50 * HOUR };
  const tail = inputs(store, range);
  assert.equal(tail.series.firewood_load.length, 0);
  assert(tail.series.model_fireplace_release.some(row => row.y > 0));
  removeFireplace(store, 'providers', { requestId: 'synthetic-tail-remove', id: first.id }, range.to);
  const removed = inputs(store, range);
  assert(removed.series.model_fireplace_release.some(row => row.y === 0));
  assert(removed.series.model_fireplace_release.every(row => row.y === 0 || row.y === null));
  addFireplace(store, 'providers', { requestId: 'synthetic-now', kg: 10 }, range.to);
  assert.equal(inputs(store, range).series.firewood_load[0].x, range.to);
});

test('every chart axis uses the model burn timescale for merged, corrected fireplace activity', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const burnMs = FIREPLACE_RESPONSE.burnHours * HOUR;
  addFireplace(store, 'providers', { requestId: 'synthetic-strip-first', kg: 8 }, start);
  const reload = addFireplace(store, 'providers', { requestId: 'synthetic-strip-reload', kg: 4 }, start + burnMs / 2);
  const args = { store, input: 'providers', now: start + 2 * burnMs, startDate: '2026-09-08' };
  store.db.exec('PRAGMA query_only=ON');
  for (const { key: left } of HISTORY_AXES) {
    const chart = getChartData({ ...args, left });
    assert.deepEqual(chart.shading.fireplace, [{ start, end: start + 1.5 * burnMs }], left);
    assert.equal(chart.meta.fireplaceInputs.burnHours, FIREPLACE_RESPONSE.burnHours);
    assert.equal(chart.meta.fireplaceInputs.responseVersion, FIREPLACE_RESPONSE.version);
    assert(!JSON.stringify(chart.shading.fireplace).includes('synthetic-'));
  }
  store.db.exec('PRAGMA query_only=OFF');
  removeFireplace(store, 'providers', { requestId: 'synthetic-strip-remove', id: reload.id }, args.now);
  assert.deepEqual(getChartData(args).shading.fireplace, [{ start, end: start + burnMs }]);
  assert.deepEqual(getChartData({ ...args, now: args.now - 1 }).shading.fireplace,
    [{ start, end: start + 1.5 * burnMs }], 'A later removal cannot change an earlier as-of view');
});

test('fireplace activity clips earlier ignitions and unfinished burns to elapsed dates with source isolation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const from = Date.parse('2026-09-07T21:00:00Z'), burnMs = FIREPLACE_RESPONSE.burnHours * HOUR;
  const now = from + 3 * burnMs;
  addFireplace(store, 'providers', { requestId: 'synthetic-strip-before', kg: 8 }, from - burnMs / 2);
  addFireplace(store, 'providers', { requestId: 'synthetic-strip-open', kg: 8 }, now - burnMs / 2);
  addFireplace(store, 'providers', { requestId: 'synthetic-strip-future', kg: 8 }, now + burnMs);
  addFireplace(store, 'simulated', { requestId: 'synthetic-strip-simulation', kg: 8 }, from + burnMs);
  addFireplace(store, 'mqtt', { requestId: 'synthetic-strip-mqtt', kg: 8 }, from);
  const args = { store, now, startDate: '2026-09-08', left: 'power' };
  assert.deepEqual(getChartData({ ...args, input: 'providers' }).shading.fireplace,
    [{ start: from, end: from + burnMs / 2 }, { start: now - burnMs / 2, end: now }]);
  assert.deepEqual(getChartData({ ...args, input: 'simulated' }).shading.fireplace,
    [{ start: from + burnMs, end: from + 2 * burnMs }]);
  assert.deepEqual(getChartData({ ...args, input: 'mqtt' }).shading.fireplace,
    [{ start: from, end: from + burnMs }]);
  assert.deepEqual(getChartData({ ...args, input: 'offline' }).shading.fireplace, []);
  addFireplace(store, 'providers', { requestId: 'synthetic-strip-next-day', kg: 8 }, from + 24 * HOUR - burnMs / 2);
  const tomorrow = getChartData({ ...args, input: 'providers', now: from + 25 * HOUR,
    startDate: '2026-09-08' });
  assert.deepEqual(tomorrow.shading.fireplace.at(-1),
    { start: from + 24 * HOUR - burnMs / 2, end: tomorrow.range.to });
});

test('dense fireplace activity keeps bounded occupied fractions without double-counting overlapping additions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const burnMs = FIREPLACE_RESPONSE.burnHours * HOUR, count = 450, points = 100;
  for (let i = 0; i < count; i++) {
    const at = start + i * 2 * burnMs;
    addFireplace(store, 'providers', { requestId: `synthetic-dense-strip-${i}`, kg: 4 }, at);
    addFireplace(store, 'providers', { requestId: `synthetic-dense-overlap-${i}`, kg: 4 }, at);
  }
  const now = start + (count * 2 - 1) * burnMs;
  const chart = getChartData({ store, input: 'providers', now, startDate: '2026-09-08',
    endDate: new Date(now).toISOString().slice(0, 10), points });
  assert(chart.shading.fireplace.length <= points);
  assert(chart.shading.fireplace.every(row => row.aggregated && row.fraction > 0 && row.fraction <= 1));
  const occupiedMs = chart.shading.fireplace.reduce((sum, row) => sum + (row.end - row.start) * row.fraction, 0);
  assert(Math.abs(occupiedMs - count * burnMs) < 1, 'Occupied time counts the union of burn windows');
});

test('daily savings preserve partial coverage and negative estimates across a Finnish 23-hour day', () => {
  const range = { from: Date.parse('2026-03-28T22:00:00Z'), to: Date.parse('2026-03-29T21:00:00Z') };
  assert.equal(range.to - range.from, 23 * HOUR);
  const values = envelopes(FIREWOOD_OUTCOME_NAMES, range);
  addFirewoodOutcomes({ range, now: range.to, envelopes: values, result: {
    summary: { status: 'provisional', fireplaceRevision: 2, modelVersion: 'synthetic-model' },
    intervals: [{ start: range.from, end: range.to, benefitCents: -125, avoidedKwh: 5,
      includedMs: 10 * HOUR, missingMs: 13 * HOUR, status: 'provisional' }],
  } });
  const euro = values.firewood_savings.values()[0], kwh = values.firewood_electricity_avoided.values()[0];
  assert.equal(euro.y, -1.25); assert.equal(kwh.y, 5);
  assert.equal(euro.coverage, 10 / 23); assert.equal(euro.partial, true);
  assert.equal(euro.status, 'provisional'); assert.equal(euro.intervalEnd, range.to);
});

test('daily outcomes keep missing days null and split a 25-hour Finnish day correctly', () => {
  const range = { from: Date.parse('2026-10-24T21:00:00Z'), to: Date.parse('2026-10-26T22:00:00Z') };
  const boundary = Date.parse('2026-10-25T22:00:00Z');
  const values = envelopes(FIREWOOD_OUTCOME_NAMES, range);
  addFirewoodOutcomes({ range, now: range.to, envelopes: values, result: {
    summary: { status: 'validated' }, intervals: [{ start: range.from, end: boundary,
      benefitCents: 250, avoidedKwh: 10, includedMs: 25 * HOUR, status: 'validated' }],
  } });
  const rows = values.firewood_savings.values();
  assert.deepEqual(rows.map(row => row.y), [2.5, null]);
  assert.equal(rows[0].coverage, 1); assert.equal(rows[0].partial, false);
  assert.equal(rows[1].status, 'unavailable');
});

test('chart API uses all-in price history and agrees between the card and daily axes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  addFireplace(store, 'providers', { requestId: 'synthetic-priced-fire', kg: 8 }, start);
  for (let i = 0; i <= 32; i++) {
    const at = start + i * HOUR / 4;
    const value = { timestamp: at, windowStart: at - HOUR / 4, windowEnd: at,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', targetC: 21,
      thermalCompressorDuty: 0.5, thermalAuxKw: 0, quality: [] };
    appendLearningRecord(store, 'providers', 'sample', value);
  }
  const now = start + 8 * HOUR;
  const args = { store, input: 'providers', now, startDate: '2026-09-08',
    contract: { periods: [{ from: start - HOUR, marginCtPerKwh: 0.4,
      taxCtPerKwh: 2.2, vatRate: 0.255, tariff: 'day-night' }] },
    market: { fetchedAt: start, intervals: [{ start, end: now,
      spotCtPerKwh: 10, unit: 'c/kWh', vatIncluded: false, source: 'synthetic' }] } };
  const euro = getChartData({ ...args, left: 'firewood_savings' });
  const kwh = getChartData({ ...args, left: 'firewood_electricity_avoided' });
  assert(euro.firewoodBenefit.valueEuro > 0);
  assert.equal(euro.series.firewood_savings[0].y, euro.firewoodBenefit.valueEuro);
  assert.equal(kwh.series.firewood_electricity_avoided[0].y, euro.firewoodBenefit.electricityAvoidedKwh);
  assert.equal(euro.firewoodBenefit.coverage.includedMs, 8 * HOUR);
  assert(euro.series.firewood_savings[0].partial, 'Elapsed selection also includes earlier hours without supported fire history');
});

test('historical worker caches refresh on model publication and fireplace corrections without new telemetry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chart-fireplace-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const load = addFireplace(store, 'providers', { requestId: 'synthetic-cache', kg: 8 }, start);
  const args = { input: 'providers', now: start + 48 * HOUR, startDate: '2026-09-08', left: 'firewood_load' };
  assert.equal((await service.query(args)).series.firewood_load[0].y, 8);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.setState('adaptive:providers', { checkpointDigest: 'synthetic-new-model' });
  assert.notEqual((await service.query(args)).meta.cacheHit, true);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  removeFireplace(store, 'providers', { requestId: 'synthetic-cache-remove', id: load.id }, args.now);
  assert.equal((await service.query(args)).series.firewood_load.length, 0);
});
