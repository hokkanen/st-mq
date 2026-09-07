import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Envelope, chartRange, getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';
import { importCsv } from '../src/storage/history.js';
import { historySeriesAt } from '../chart/history-model.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const from = Date.parse('2026-01-15T00:00:00+02:00');
const now = from + 12 * HOUR;
const date = '2026-01-15';
function put(store, signal, value, at, extra = {}) {
  store.observation({ source: 'test-fixture', device: 'house', signal, value,
    unit: signal.includes('current') ? 'A' : signal === 'spot_price' ? 'c/kWh_ex_vat' : 'degC',
    sourceTime: at, receivedAt: at, ...extra });
}
function get(store, extra = {}) { return getChartData({ store, now, startDate: date, endDate: date, ...extra }); }
const contract = { periods: [{ from: from - 10 * HOUR, marginCtPerKwh: 0.4, taxCtPerKwh: 2.2, vatRate: 0.255, tariff: 'day-night' }] };
const interval = (start, end, value) => ({ start, end, spotCtPerKwh: value, unit: 'c/kWh', vatIncluded: false, source: 'fixture' });

test('Finnish inclusive calendar dates preserve 23/25-hour days and reject invalid ranges', () => {
  assert.equal(chartRange({ startDate: '2026-03-29', now }).to - chartRange({ startDate: '2026-03-29', now }).from, 23 * HOUR);
  assert.equal(chartRange({ startDate: '2026-10-25', now }).to - chartRange({ startDate: '2026-10-25', now }).from, 25 * HOUR);
  assert.equal(chartRange({ startDate: '2026-01-15', endDate: '2026-01-16', now }).to - from, 48 * HOUR);
  assert.equal(chartRange({ now: Date.parse('2026-01-14T22:30:00Z') }).startDate, date);
  assert.throws(() => chartRange({ startDate: '2026-02-30', now }), /Invalid/);
  assert.throws(() => chartRange({ startDate: '2026-01-16', endDate: date, now }), /End date/);
  assert.throws(() => chartRange({ startDate: '2000-01-01', endDate: date, now }), /ten years/);
});

test('combined power requires all three phases from the same timestamp and acquisition', () => {
  const store = new Store(':memory:');
  try {
    for (let phase = 1; phase <= 3; phase++) put(store, `property_current_l${phase}`, phase * 10, from);
    put(store, 'property_current_l1', 10, from + MINUTE);
    put(store, 'property_current_l2', 20, from + MINUTE);
    put(store, 'property_current_l3', 30, from + MINUTE + 1);
    for (let phase = 1; phase <= 3; phase++) put(store, `ev1_current_l${phase}`, 6, from + 2 * MINUTE,
      { receivedAt: from + 2 * MINUTE + phase });
    const result = get(store);
    assert.equal(result.series.property_power[0].y, 13.8);
    assert(result.series.property_power.some(point => point.x === from + MINUTE && point.y === null));
    assert(result.series.charger_power.every(point => point.y === null));
    assert.match(result.meta.powerEstimate, /estimated kW, not metered/);
    assert(!Object.hasOwn(result.series, 'property_current_l1'));
    const phaseView = get(store, { left: 'phases' });
    assert.equal(phaseView.series.property_current_l1[0].y, 10);
    assert(!Object.hasOwn(phaseView.series, 'property_power'));
  } finally { store.close(); }
});

test('Easee power combines one acquisition with independent phase event timestamps', () => {
  const store = new Store(':memory:');
  try {
    const receivedAt = from + MINUTE;
    const timestamps = [from - 4 * HOUR, from - 45 * MINUTE, from + 1300];
    for (let phase = 1; phase <= 3; phase++) {
      put(store, `property_current_l${phase}`, phase * 10, timestamps[phase - 1], {
        source: 'easee', device: 'fixture-equalizer', receivedAt,
        // Older adapter versions flagged both devices when only the idle
        // charger's timestamps lagged. The chart rechecks each device itself.
        quality: ['current_snapshot_not_energy', 'asynchronous_snapshot'],
      });
      put(store, `ev1_current_l${phase}`, 0, from - 2 * HOUR, {
        source: 'easee', device: 'fixture-charger', receivedAt,
        quality: ['current_snapshot_not_energy', 'stale', 'asynchronous_snapshot'],
      });
    }
    put(store, 'indoor_temperature', 21, from + 500);
    const result = get(store);
    assert.deepEqual(result.series.property_power, [{ x: timestamps[2], y: 13.8 }]);
    assert.deepEqual(result.meta.lastReadings.property_power, { x: timestamps[2], y: 13.8 });
    assert.equal(historySeriesAt(result).property_power.at(-1).y, 13.8);
    assert.equal(historySeriesAt(result).charger_power.at(-1).y, 0);
    assert.equal(result.series.indoor_temperature[0].y, 21);
    const phaseView = get(store, { left: 'phases' });
    for (let phase = 1; phase <= 3; phase++)
      assert.equal(phaseView.meta.lastReadings[`property_current_l${phase}`].x, timestamps[phase - 1]);
  } finally { store.close(); }
});

test('Easee total power accepts independent event clocks but rejects missing phases and mixed devices or acquisitions', () => {
  const store = new Store(':memory:');
  try {
    const phase = (number, at, extra = {}) => put(store, `property_current_l${number}`, 10, at, {
      source: 'easee', device: 'fixture-equalizer', receivedAt: from + MINUTE, ...extra,
    });
    phase(1, from); phase(2, from + 100); phase(3, from + 30_000);
    phase(1, from + MINUTE, { receivedAt: from + 2 * MINUTE });
    phase(2, from + MINUTE + 100, { receivedAt: from + 2 * MINUTE });
    phase(3, from + MINUTE + 30_001, { receivedAt: from + 2 * MINUTE });
    phase(1, from + 2 * MINUTE, { receivedAt: from + 3 * MINUTE });
    phase(2, from + 2 * MINUTE + 100, { receivedAt: from + 3 * MINUTE });
    phase(3, from + 2 * MINUTE + 200, { receivedAt: from + 3 * MINUTE + 1 });
    phase(1, from + 3 * MINUTE, { receivedAt: from + 4 * MINUTE });
    phase(2, from + 3 * MINUTE + 100, { receivedAt: from + 4 * MINUTE });
    phase(3, from + 3 * MINUTE + 200, { receivedAt: from + 4 * MINUTE, device: 'other-fixture-equalizer' });
    phase(1, from + 4 * MINUTE, { receivedAt: from + 5 * MINUTE });
    phase(2, from + 4 * MINUTE + 100, { receivedAt: from + 5 * MINUTE });
    const result = get(store);
    assert.deepEqual(result.series.property_power.filter(point => point.y !== null), [
      { x: from + 30_000, y: 6.9 }, { x: from + MINUTE + 30_001, y: 6.9 },
    ]);
    assert.equal(result.meta.lastReadings.property_power.y, null);
    assert.equal(historySeriesAt(result).property_power.at(-1).y, null, 'A missing latest phase cannot revive an earlier total');
  } finally { store.close(); }
});

test('Easee power loads unchanged phases outside historical scan bounds without joining other polls', () => {
  const store = new Store(':memory:');
  try {
    const receivedAt = from + HOUR;
    const timestamps = [from - 5 * 24 * HOUR, from - 4 * HOUR, from + MINUTE];
    for (const [i, at] of timestamps.entries()) put(store, `property_current_l${i + 1}`, 10, at, {
      source: 'easee', device: 'fixture-equalizer', receivedAt, quality: ['asynchronous_snapshot', 'stale'],
    });
    const count = store.db.prepare('SELECT count(*) AS total FROM observations').get().total;
    for (const chartNow of [now, now + 2 * 24 * HOUR]) {
      const result = get(store, { now: chartNow });
      assert.deepEqual(result.series.property_power, [{ x: from + MINUTE, y: 6.9 }]);
      assert.deepEqual(result.meta.lastReadings.property_power, { x: from + MINUTE, y: 6.9 });
    }
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM observations').get().total, count);
  } finally { store.close(); }
});

test('Easee power keeps missing or unknown-time phases invalid after a complete older poll', () => {
  for (const invalid of [{ value: null }, { sourceTime: null }, { sourceTime: now + MINUTE, quality: ['future_source_time'] }]) {
    const store = new Store(':memory:');
    try {
      const putPhase = (phase, at, extra = {}) => store.observation({ source: 'easee', device: 'fixture-equalizer',
        signal: `property_current_l${phase}`, value: 10, unit: 'A', sourceTime: at, receivedAt: at, ...extra });
      for (const phase of [1, 2, 3]) putPhase(phase, from);
      putPhase(1, from + MINUTE);
      putPhase(2, from - HOUR, { receivedAt: from + MINUTE });
      putPhase(3, from - 2 * HOUR, { receivedAt: from + MINUTE, ...invalid });
      const result = get(store);
      assert.equal(result.meta.lastReadings.property_power.y, null);
      assert.equal(historySeriesAt(result).property_power.at(-1).y, null);
    } finally { store.close(); }
  }
});

test('a newer invalid Easee poll supersedes a complete poll with the same source timestamps', () => {
  const store = new Store(':memory:');
  try {
    for (const receivedAt of [from + MINUTE, from + 2 * MINUTE]) {
      for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`,
        phase === 3 && receivedAt === from + 2 * MINUTE ? null : 10, from, {
          source: 'easee', device: 'fixture-equalizer', receivedAt,
        });
    }
    const result = get(store);
    assert.deepEqual(result.series.property_power, [{ x: from, y: null }]);
    assert.equal(historySeriesAt(result).property_power.at(-1).y, null);
  } finally { store.close(); }
});

test('all right-axis history stays present; bad readings and long gaps remain breaks, absence remains visible', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 20, from, { quality: ['absence_heating_off_approximate', 'excluded_occupied_training'] });
    put(store, 'indoor_temperature', 0, from + HOUR, { quality: ['suspect_zero_indoor'] });
    put(store, 'indoor_temperature', 21, from + 8 * HOUR);
    put(store, 'garage_temperature', 12, from + 10 * HOUR);
    put(store, 'outdoor_temperature', -4, from + 10 * HOUR);
    put(store, 'heating_integral', -200, from + HOUR, { unit: 'degree-minutes' });
    put(store, 'indoor_temperature', 98, now + MINUTE);
    const result = get(store, { left: 'integral' });
    assert.equal(result.series.indoor_temperature[0].y, 20);
    assert(result.series.indoor_temperature.some(point => point.y === null));
    assert(!result.series.indoor_temperature.some(point => point.y === 98));
    assert.equal(result.series.garage_temperature[0].y, 12);
    assert.equal(result.series.outdoor_temperature[0].y, -4);
    assert.equal(result.series.heating_integral[0].y, -200);
  } finally { store.close(); }
});

test('shading respects bounded historical requests, ten-minute DHWR and verified auxiliary episodes', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'requested_heat_mode', 0, from - 5 * MINUTE, { quality: ['requested_not_observed'], unit: 'legacy_command' });
    put(store, 'requested_heat_mode', 15, from + 10 * MINUTE);
    put(store, 'requested_heat_mode', 60, from + HOUR);
    put(store, 'requested_heat_mode', 15, from + 2 * HOUR);
    put(store, 'requested_heat_mode', 0, from + 4 * HOUR);
    const aux = { source: 'husdata-h66', unit: '%', raw: { verified: 'Installed fixture verification', usableForControl: true } };
    put(store, 'auxiliary_output', 50, from + HOUR, aux);
    put(store, 'auxiliary_output', 0, from + HOUR + 2 * MINUTE, aux);
    put(store, 'auxiliary_output', 100, from + 3 * HOUR, { ...aux, raw: { verified: null } });
    store.counter({ signal: 'auxiliary_3kw_hours', value: 500, observedDate: date });
    store.event('decision', { input: 'offline', action: 'reduction', commands: ['heatoff'], execution: 'shadow' }, from + 6 * HOUR);
    const result = get(store);
    assert.deepEqual(result.shading.heatOff, [{ start: from, end: from + 10 * MINUTE }, { start: from + 4 * HOUR, end: from + 4 * HOUR + 30 * MINUTE }]);
    assert.deepEqual(result.shading.dhwr, [{ start: from + HOUR, end: from + HOUR + 10 * MINUTE }]);
    assert.deepEqual(result.shading.auxHeat, [{ start: from + HOUR, end: from + HOUR + 2 * MINUTE }]);
  } finally { store.close(); }
});

test('all-in history uses effective-dated rates and never substitutes spot when rates are missing', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'spot_price', -4, from);
    put(store, 'spot_price', 8, from + 8 * HOUR);
    const unconfigured = get(store);
    assert.equal(unconfigured.series.spot_price[0].y, -4);
    assert.deepEqual(unconfigured.series.all_in_price, []);
    const priced = get(store, { contract });
    assert(Math.abs(priced.series.all_in_price[0].y - ((-4 + 0.4 + 2.2) * 1.255 + 1.96)) < 1e-10);
    assert(Math.abs(priced.series.all_in_price.at(-1).y - ((8 + 0.4 + 2.2) * 1.255 + 3.34)) < 1e-10);
    const futureRates = { periods: [{ ...contract.periods[0], from: from + 7 * HOUR }] };
    const partial = get(store, { contract: futureRates });
    assert.equal(partial.series.all_in_price[0].y, null);
    assert(partial.series.all_in_price.at(-1).y > 0);
  } finally { store.close(); }
});

test('stored market snapshots preserve old prices and latest differently partitioned revisions win', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'spot_price', 99, from);
    store.snapshot({ kind: 'market', source: 'fixture', fetchedAt: from - HOUR,
      payload: { intervals: [interval(from, from + HOUR, 1)] } });
    store.snapshot({ kind: 'market', source: 'fixture', fetchedAt: from,
      payload: { intervals: [interval(from + 15 * MINUTE, from + 30 * MINUTE, 2)] } });
    const result = get(store, { contract });
    assert.equal(result.series.spot_price[0].y, 1);
    assert.equal(result.series.spot_price.find(point => point.x === from + 15 * MINUTE).y, 2);
    assert.equal(result.series.spot_price.find(point => point.x === from + 30 * MINUTE).y, 1);
    assert(!result.series.spot_price.some(point => point.y === 99));
    const oldView = get(store, { now: from + 20 * 24 * HOUR });
    assert(oldView.series.spot_price.some(point => point.y === 2));
  } finally { store.close(); }
});

test('weather and future prices are clipped to selected days and stale forecasts stay absent', () => {
  const store = new Store(':memory:');
  try {
    const market = { fetchedAt: now, intervals: [interval(from, from + 24 * HOUR, 5), interval(from + 24 * HOUR, from + 48 * HOUR, 5)] };
    const forecast = [{ start: from, end: from + 48 * HOUR, outdoorC: -5, issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now }];
    const weather = { fetchedAt: now, forecast };
    const result = get(store, { market, weather });
    assert(result.series.spot_price.every(point => point.x >= from && point.x < from + 24 * HOUR));
    assert.equal(result.series.outdoor_forecast[0].x, now);
    assert(result.series.outdoor_forecast.every(point => point.x < from + 24 * HOUR));
    const tomorrow = get(store, { market, weather, startDate: '2026-01-16', endDate: '2026-01-16' });
    assert.equal(tomorrow.range.from, from + 24 * HOUR);
    assert.equal(tomorrow.series.outdoor_forecast[0].x, from + 24 * HOUR);
    assert.deepEqual(get(store, { weather: { fetchedAt: now - 7 * HOUR, forecast } }).series.outdoor_forecast, []);
  } finally { store.close(); }
});

test('simulation remains isolated and only the supplied known synthetic outlook is shown', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 21, from, { source: 'simulation' });
    put(store, 'indoor_temperature', 18, from);
    const simulated = { prices: [{ start: now, end: now + HOUR, allInCentsPerKWh: 7 }],
      forecast: [{ start: now, end: now + HOUR, outdoorC: -2 }] };
    const result = get(store, { input: 'simulated', simulated });
    assert.equal(result.series.indoor_temperature[0].y, 21);
    assert.equal(result.series.all_in_price[0].x, now);
    assert.equal(result.series.all_in_price.at(-1).x, now + HOUR - 1);
    assert.equal(get(store).series.indoor_temperature[0].y, 18);
  } finally { store.close(); }
});

test('pixel envelope retains peaks, endpoints and missing-data breaks within a bounded response', () => {
  const envelope = new Envelope(0, 100_000, 100);
  for (let x = 0; x < 100_000; x++) envelope.add(x, x === 12345 ? 999 : x === 56789 ? -999 : x === 100 ? null : Math.sin(x));
  const result = envelope.values();
  assert(result.length <= 700);
  assert.equal(result[0].x, 0);
  assert.equal(result.at(-1).x, 99999);
  assert(result.some(point => point.y === 999));
  assert(result.some(point => point.y === -999));
  assert(result.some(point => point.x === 100 && point.y === null));
});

test('combined history scans beyond old 5000-row limit and retains both date-range ends', () => {
  const store = new Store(':memory:');
  try {
    store.transaction(() => {
      for (let index = 0; index < 12_000; index++) put(store, 'indoor_temperature', index === 8000 ? 30 : 20, from + index * 1000);
    });
    const result = get(store, { points: 100 });
    assert.equal(result.meta.rawRows, 12_000);
    assert.equal(result.series.indoor_temperature[0].x, from);
    assert.equal(result.series.indoor_temperature.at(-1).x, from + 11_999_000);
    assert(result.series.indoor_temperature.some(point => point.y === 30));
    assert(result.series.indoor_temperature.length <= 700);
  } finally { store.close(); }
});

test('compact original-row queries match expanded observations for duplicates, missing phases, gaps and source precedence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-import-'));
  const store = new Store(':memory:');
  try {
    const stmqPath = join(directory, 'stmq.csv'), easeePath = join(directory, 'easee.csv');
    writeFileSync(stmqPath, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n' + [
      [from - HOUR, 2, 0, 20, 11, -2], [from, 3, 0, 20, 11, -2],
      [from + HOUR, -4, 60, 21, '', -3], [from + HOUR, -3, 60, 22, 12, -3],
      [from + 6 * HOUR, 2, 15, 0, 11, -2], [from + 8 * HOUR, 3, 0, 20, 11, -2],
    ].map(([at, ...values]) => [at / 1000, ...values].join(',')).join('\n'));
    writeFileSync(easeePath, 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n' + [
      [from, 2, 2, 2, 4, 5, 6], [from + HOUR, 2, '', 2, 4, 5, 6],
      [from + HOUR, 3, 3, 3, 5, 6, 7], [from + 8 * HOUR, 2, 2, 2, 4, 5, 6],
    ].map(([at, ...values]) => [at / 1000, ...values].join(',')).join('\n'));
    await importCsv(store, stmqPath, { kind: 'stmq' });
    await importCsv(store, easeePath, { kind: 'easee' });
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 10, from + HOUR);
    put(store, 'indoor_temperature', 23, from + HOUR);
    for (const left of ['power', 'phases', 'integral']) {
      const single = get(store, { left, contract, points: 2000 });
      const long = get(store, { left, contract, points: 2000, endDate: '2026-01-24' });
      assert.deepEqual(long.series, single.series, `${left}: compact and expanded points must agree`);
      assert.deepEqual(long.shading, single.shading, `${left}: shading must agree`);
      assert.equal(long.meta.invalidRows, single.meta.invalidRows);
      assert.equal(long.meta.rawRows, single.meta.rawRows);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker cache invalidates on new observations; aborts release the bounded queue and shutdown rejects work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-test-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const service = createChartService({ store, maxQueue: 1 });
  const args = { now, startDate: date, endDate: date };
  try {
    put(store, 'indoor_temperature', 20, from);
    const cancellation = new AbortController();
    const first = service.query(args, { signal: cancellation.signal });
    await assert.rejects(service.query(args), /Too many pending/);
    cancellation.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal((await service.query(args)).series.indoor_temperature[0].y, 20);
    assert.equal((await service.query(args)).meta.cacheHit, true);
    put(store, 'indoor_temperature', 22, from + HOUR);
    const refreshed = await service.query(args);
    assert.equal(refreshed.series.indoor_temperature.at(-1).y, 22);
    assert.notEqual(refreshed.meta.cacheHit, true);
    await service.close();
    await assert.rejects(service.query(args), /closed/);
  } finally { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native scalar readings remain authoritative when CSV history is imported later, for every date-range path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-precedence-'));
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 21, from);
    put(store, 'indoor_temperature', 23, from);
    put(store, 'spot_price', 9, from);
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 10 + phase, from);
    const stmqPath = join(directory, 'stmq.csv'), easeePath = join(directory, 'easee.csv');
    writeFileSync(stmqPath, `unix_time,price,heat_on,temp_in,temp_ga,temp_out\n${from / 1000},2,15,18,11,-2\n${from / 1000},3,15,19,12,-3\n`);
    writeFileSync(easeePath, `unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n${from / 1000},2,2,2,4,5,6\n${from / 1000},3,3,3,5,6,7\n`);
    await importCsv(store, stmqPath, { kind: 'stmq' });
    await importCsv(store, easeePath, { kind: 'easee' });
    for (const left of ['power', 'phases', 'integral']) {
      const single = get(store, { left, contract, points: 2000 });
      const long = get(store, { left, contract, points: 2000, endDate: '2026-01-24' });
      assert.equal(single.series.indoor_temperature[0].y, 23, `${left}: newest native temperature wins`);
      assert.equal(single.series.spot_price[0].y, 9, `${left}: native spot price wins`);
      assert.equal(single.series.garage_temperature[0].y, 12, `${left}: newest imported row wins without native data`);
      if (left === 'phases') assert.equal(single.series.property_current_l1[0].y, 11);
      assert.deepEqual(long.series, single.series, `${left}: range length cannot change source precedence`);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('live charts recover old unchanged readings and expose original timestamps for display-only tails', () => {
  const store = new Store(':memory:');
  try {
    const recordedAt = from - 2 * 24 * HOUR;
    for (const [signal, value] of [['indoor_temperature', 21], ['garage_temperature', 12], ['outdoor_temperature', -4]])
      put(store, signal, value, recordedAt);
    for (const phase of [1, 2, 3]) {
      put(store, `property_current_l${phase}`, phase, recordedAt);
      put(store, `ev1_current_l${phase}`, 0, recordedAt);
    }
    // An update before the visible day must supersede an older seed without
    // inserting an artificial missing marker at the start of the day.
    put(store, 'garage_temperature', 13, from - HOUR);
    put(store, 'heating_integral', -200, recordedAt, { unit: 'degree-minutes' });
    const count = store.db.prepare('SELECT count(*) AS total FROM observations').get().total;
    for (const left of ['power', 'phases', 'integral']) {
      const result = get(store, { left });
      const projected = historySeriesAt(result, now);
      for (const key of ['indoor_temperature', 'garage_temperature', 'outdoor_temperature',
        ...(left === 'power' ? ['property_power', 'charger_power'] : left === 'phases'
          ? ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)) : ['heating_integral'])]) {
        assert.equal(projected[key][0].x, from, `${key} starts at the chosen day`);
        assert.equal(projected[key].at(-1).x, now, `${key} reaches now`);
        assert.equal(projected[key].at(-1).observedAt, key === 'garage_temperature' ? from - HOUR : recordedAt);
        assert.equal(result.series[key].length, 0, 'The API still describes actual recorded history');
      }
      assert.equal(projected.garage_temperature.at(-1).y, 13);
      assert.deepEqual(result.series.spot_price, []);
    }
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM observations').get().total, count, 'Projection never appends observations');
    assert.deepEqual(get(store, { now: now + 3 * 24 * HOUR }).series.indoor_temperature, [], 'Historical selections stay unchanged');
  } finally { store.close(); }
});

test('latest invalid readings and incomplete current acquisitions cannot revive old carried-forward values', () => {
  const store = new Store(':memory:');
  try {
    const old = from - 2 * 24 * HOUR;
    put(store, 'indoor_temperature', 21, old);
    put(store, 'indoor_temperature', 0, old + HOUR, { quality: ['suspect_zero_indoor'] });
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 5, old);
    put(store, 'property_current_l1', 6, old + HOUR);
    put(store, 'garage_temperature', 14, old, { source: 'simulation' });
    const result = get(store);
    assert.equal(result.meta.lastReadings.indoor_temperature.y, null);
    assert.equal(result.meta.lastReadings.property_power.y, null);
    const projected = historySeriesAt(result);
    assert.deepEqual(projected.indoor_temperature, []);
    assert.deepEqual(projected.property_power, []);
    assert.deepEqual(projected.garage_temperature, [], 'Non-simulation charts cannot seed from synthetic readings');
    assert.equal(historySeriesAt(get(store, { input: 'simulated' })).garage_temperature.at(-1).y, 14);
  } finally { store.close(); }
});
