import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { getChartData } from '../src/app/chart-data.js';
import { HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';
import { historyDatasets, historyStateLabel } from '../chart/history-model.js';

const MINUTE = 60_000, BASE = Date.parse('2026-09-24T09:00:00Z');
const ACTIVE = 'garage_compressor_active', FREQUENCY = 'garage_compressor_frequency';

// Independent synthetic transcription of cnPublishTelemetry/cnField in the Pill
// publisher. In particular its booleans have unit:"boolean", and successful
// native replies remain observed-unverified rather than control-qualified.
// Do not derive this external wire shape from the application's decoder table.
function publishedField(value, measuredAt, extra = {}) {
  return { value, measuredAt, ageMs: 0, supported: value !== null,
    unit: typeof value === 'boolean' ? 'boolean' : 'Hz', decodeVerified: value !== null,
    quality: 'observed-unverified', raw: value === true ? 1 : value === false ? 0 : value,
    accuracyVerified: false, meterScope: 'unverified', ...extra };
}

function fixture(t, { disk = false } = {}) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'mitsubishi-history-test-')) : null;
  const path = directory ? join(directory, 'history.sqlite') : ':memory:';
  let store = new Store(path), recorder = new Recorder(store), now = BASE, sequence = 0;
  const emitted = [], results = [];
  // Use the production ingest method between the adapter and recorder, with no
  // controllers, connections, providers or household configuration involved.
  const engine = { config: { input: 'mqtt' }, clock: () => now, store, recorder,
    rememberObservation() {} };
  const adapter = createGarageAdapter({
    settings: { driver: 'shelly-cn105', stateTopic: 'synthetic/cn105/state',
      telemetryTopic: 'synthetic/cn105/telemetry', maxAgeMs: 2 * MINUTE },
    clock: () => now,
    onObservation(observation) { emitted.push(observation); results.push(Engine.prototype.ingest.call(engine, observation)); },
  });
  adapter.setConnected(true);
  t.after(async () => {
    await adapter.close({ restore: false });
    store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return {
    adapter, emitted, results,
    get store() { return store; },
    at(offset) { now = BASE + offset; },
    send(fields, { packet = {}, envelope = {} } = {}) {
      adapter.receive('synthetic/cn105/telemetry', JSON.stringify({
        schema: 'shelly-cn105/v1', deviceId: 'synthetic-pump', bootId: 'synthetic-boot-a',
        sequence: ++sequence, observedAt: now, fields, ...envelope,
      }), packet, now);
    },
    state(extra = {}) {
      adapter.receive('synthetic/cn105/state', JSON.stringify({
        schema: 'shelly-cn105/v1', deviceId: 'synthetic-pump', bootId: 'synthetic-boot-a',
        sessionId: 'synthetic-session', sequence: ++sequence, observedAt: now, mode: 'monitoring',
        health: Object.fromEntries(['device', 'driver', 'pump'].map(key => [key, { value: true, measuredAt: now }])),
        native: { power: { value: 'on', measuredAt: now } }, ...extra,
      }), {}, now);
    },
    rows(signal = ACTIVE) { return store.observations({ signal }); },
    chart(left = ACTIVE, extra = {}) {
      return getChartData({ store, input: 'mqtt', startDate: '2026-09-24', endDate: '2026-09-24',
        now, left, ...extra });
    },
    reopen() {
      assert(directory, 'Reopen needs a temporary on-disk database');
      store.close(); store = new Store(path); recorder = new Recorder(store);
      Object.assign(engine, { store, recorder });
    },
  };
}

test('publisher-shaped on/off reports survive SQLite reopen and draw the compressor state and shading', t => {
  const f = fixture(t, { disk: true });
  f.send({ compressorActive: publishedField(true, BASE), compressorFrequency: publishedField(38, BASE) });
  f.at(30_000);
  f.send({ compressorActive: publishedField(true, BASE + 30_000) });
  assert.equal(f.rows().length, 1, 'unchanged genuine reports extend coverage without duplicating values');
  f.reopen();
  f.at(MINUTE);
  f.send({ compressorActive: publishedField(false, BASE + MINUTE), compressorFrequency: publishedField(0, BASE + MINUTE) });
  f.at(4 * MINUTE);
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.value, row.unit, row.sourceTime]), [[1, 'state', BASE], [0, 'state', BASE + MINUTE]]);
  assert(rows.every(row => row.quality.includes('observed-unverified') && row.raw.usableForControl === false));
  assert(rows.every(row => row.raw.diagnosticAvailable === true && row.raw.accuracyVerified === false
    && row.raw.contractVersion === 'shelly-cn105/v1' && row.raw.supported === true));
  assert(rows.every(row => row.raw.recorder.status === 'fresh'));
  assert.equal(f.adapter.status(BASE + MINUTE).telemetry.compressorActive.usable, false,
    'recording a diagnostic never promotes it into a control/learning input');
  assert.equal(f.adapter.status(BASE + MINUTE).native.compressorActive, undefined);
  assert(HISTORY_AXIS_BY_KEY[ACTIVE].signals.includes(ACTIVE));
  for (const axis of [ACTIVE, FREQUENCY, 'power', 'temperatures']) {
    const chart = f.chart(axis);
    assert.deepEqual(chart.shading.compressorGarage, [{ start: BASE, end: BASE + MINUTE }], axis);
    if (axis === ACTIVE) {
      assert(chart.series[ACTIVE].some(point => point.x === BASE && point.y === 1));
      assert(chart.series[ACTIVE].some(point => point.x === BASE + MINUTE && point.y === 0));
      assert(chart.series[ACTIVE].some(point => point.x === BASE + 3 * MINUTE && point.y === null));
      const dataset = historyDatasets(chart.series, { leftSignals: [ACTIVE], rightSignals: [] }).find(row => row.key === ACTIVE);
      assert.equal(dataset.stepped, true);
      assert.equal(dataset.spanGaps, false);
      assert.equal(dataset.yAxisID, 'left');
      assert.equal(dataset.hidden, false);
      assert.equal(historyStateLabel(ACTIVE, 1), 'Active');
      assert.equal(historyStateLabel(ACTIVE, 0), 'Inactive');
    }
    if (axis === FREQUENCY) assert(chart.series[FREQUENCY].some(point => point.y === 0), 'zero Hz is real data');
  }
  assert.deepEqual(f.chart(ACTIVE, { viewFrom: BASE + 20_000, viewTo: BASE + 80_000 }).shading.compressorGarage,
    [{ start: BASE + 20_000, end: BASE + MINUTE }]);
});

test('cached reports and source-age timestamps never extend compressor activity past the measurement deadline', t => {
  const f = fixture(t);
  f.at(10_000);
  f.send({ compressorActive: publishedField(true, null, { ageMs: 10_000 }) },
    { envelope: { observedAt: null, observedAgeMs: 0 } });
  f.at(90_000);
  f.send({ compressorActive: publishedField(true, null, { ageMs: 90_000 }) },
    { envelope: { observedAt: null, observedAgeMs: 0 } });
  f.at(3 * MINUTE);
  const [row] = f.rows();
  assert.equal(f.rows().length, 1);
  assert.equal(row.sourceTime, BASE);
  assert.equal(row.receivedAt, BASE + 10_000);
  assert.equal(row.raw.timeBasis, 'receipt-minus-source-age');
  assert(row.quality.includes('reconstructed-source-time'));
  const chart = f.chart();
  assert.deepEqual(chart.shading.compressorGarage, [{ start: BASE + 10_000, end: BASE + 2 * MINUTE }]);
  assert(chart.series[ACTIVE].some(point => point.x === BASE + 2 * MINUTE && point.y === null));
  assert(chart.series[ACTIVE].filter(point => point.y !== null).every(point => point.observedAt === BASE));
});

test('unavailable or malformed compressor readings create gaps, never a recorded or plotted idle state', async t => {
  const cases = [
    ['unsupported', { value: null, unit: null, supported: false, decodeVerified: false, quality: 'unsupported' }],
    ['wrong unit', { value: false, unit: null }],
    ['invalid value', { value: 0 }],
    ['unverified decoder', { decodeVerified: false }],
    ['stale source', { measuredAt: BASE, ageMs: 2 * MINUTE }, 2 * MINUTE],
    ['stale publisher', { quality: 'stale' }],
    ['unknown publisher', { quality: 'unknown' }],
    ['future source', { measuredAt: BASE + 2 * MINUTE }],
    ['no source clock', { measuredAt: null, ageMs: null }],
  ];
  for (const [name, patch, receivedOffset = 30_000] of cases) await t.test(name, t => {
    const f = fixture(t);
    f.send({ compressorActive: publishedField(true, BASE) });
    f.at(receivedOffset);
    f.send({ compressorActive: publishedField(true, BASE + receivedOffset, patch) });
    f.at(receivedOffset + 30_000);
    assert.equal(f.rows().at(-1).value, null);
    assert.equal(f.rows().at(-1).raw.usableForControl, false);
    const chart = f.chart();
    assert.deepEqual(chart.shading.compressorGarage, [{ start: BASE, end: BASE + receivedOffset }]);
    assert(chart.series[ACTIVE].some(point => point.x === BASE + receivedOffset && point.y === null));
    assert(!chart.series[ACTIVE].some(point => point.y === 0), name);
  });
});

test('missing reports stay gaps when fresh running resumes and retained or duplicate packets cannot revive activity', t => {
  const f = fixture(t);
  f.send({ compressorActive: publishedField(true, BASE) });
  f.at(4 * MINUTE);
  f.send({ compressorActive: publishedField(false, BASE + 4 * MINUTE) }, { packet: { retain: true } });
  assert.equal(f.results.at(-1).reason, 'retained-periodic-report');
  f.send({ compressorActive: publishedField(false, BASE + 4 * MINUTE) }, { packet: { dup: true } });
  assert.equal(f.rows().length, 1);
  f.at(5 * MINUTE);
  f.send({ compressorActive: publishedField(true, BASE + 5 * MINUTE) });
  f.at(8 * MINUTE);
  const chart = f.chart();
  assert.deepEqual(chart.shading.compressorGarage, [
    { start: BASE, end: BASE + 2 * MINUTE },
    { start: BASE + 5 * MINUTE, end: BASE + 7 * MINUTE },
  ]);
  assert(chart.series[ACTIVE].some(point => point.x === BASE + 2 * MINUTE && point.y === null));
  assert(chart.series[ACTIVE].some(point => point.x === BASE + 5 * MINUTE && point.y === 1));
  assert(!chart.series[ACTIVE].some(point => point.y === 0));
  assert(f.chart(ACTIVE, { viewFrom: BASE + 3 * MINUTE, viewTo: BASE + 4 * MINUTE })
    .series[ACTIVE].every(point => point.y === null));
});

test('disconnect and reconnect require a new source measurement before compressor history resumes', t => {
  const f = fixture(t);
  f.send({ compressorActive: publishedField(true, BASE) });
  f.at(30_000); f.adapter.setConnected(false);
  f.at(40_000); f.adapter.setConnected(true);
  f.send({ compressorActive: publishedField(true, BASE) });
  f.at(MINUTE);
  const interrupted = f.chart();
  assert.deepEqual(interrupted.shading.compressorGarage, [{ start: BASE, end: BASE + 30_000 }]);
  assert(interrupted.series[ACTIVE].some(point => point.x === BASE + 30_000 && point.y === null));
  f.send({ compressorActive: publishedField(false, BASE + MINUTE) });
  const recovered = f.chart();
  assert(recovered.series[ACTIVE].some(point => point.x === BASE + MINUTE && point.y === 0));
  assert.deepEqual(recovered.shading.compressorGarage, interrupted.shading.compressorGarage);
});

test('a new adapter boot ends previous compressor evidence even if its first packet has another field', t => {
  const f = fixture(t);
  f.send({ compressorActive: publishedField(true, BASE) });
  f.at(30_000);
  f.send({ compressorFrequency: publishedField(0, BASE + 30_000) },
    { envelope: { bootId: 'synthetic-boot-b', sequence: 1 } });
  f.at(MINUTE);
  const chart = f.chart();
  assert.deepEqual(chart.shading.compressorGarage, [{ start: BASE, end: BASE + 30_000 }]);
  assert(chart.series[ACTIVE].some(point => point.x === BASE + 30_000 && point.y === null));
  assert(!chart.series[ACTIVE].some(point => point.y === 0), 'zero frequency never invents a direct off report');
  f.send({ compressorActive: publishedField(false, BASE + MINUTE) },
    { envelope: { bootId: 'synthetic-boot-b', sequence: 2 } });
  assert.equal(f.rows().at(-1).value, 0);
});

test('explicit communication health loss ends shading while unrelated native settings cannot extend it', async t => {
  for (const key of ['device', 'driver', 'pump']) await t.test(key, t => {
    const f = fixture(t);
    f.state();
    f.send({ compressorActive: publishedField(true, BASE) });
    f.at(30_000);
    f.state({ health: { [key]: { value: false, measuredAt: BASE + 30_000 } } });
    f.at(45_000);
    f.state({ native: { power: { value: 'off', measuredAt: BASE + 45_000 },
      targetC: { value: 'invalid', measuredAt: BASE + 45_000 } } });
    f.at(MINUTE);
    const chart = f.chart();
    assert.deepEqual(chart.shading.compressorGarage, [{ start: BASE, end: BASE + 30_000 }]);
    assert(chart.series[ACTIVE].some(point => point.x === BASE + 30_000 && point.y === null));
    assert(!chart.series[ACTIVE].some(point => point.y === 0), 'power setting is not compressor activity');
    assert.equal(f.rows().at(-1).value, null);
  });
});

test('a retained packet cannot cause the recorder to discard a subsequent real disconnect', t => {
  const f = fixture(t);
  f.send({ compressorActive: publishedField(true, BASE) });
  f.at(15_000);
  f.send({ compressorActive: publishedField(false, BASE + 15_000) }, { packet: { retain: true } });
  f.at(30_000); f.adapter.setConnected(false);
  f.at(MINUTE);
  const gap = f.rows().at(-1);
  assert.equal(gap.value, null);
  assert(gap.quality.includes('mqtt-disconnected'));
  assert(!gap.quality.includes('retained'));
  assert.equal(gap.receivedAt, BASE + 30_000);
  assert.deepEqual(f.chart().shading.compressorGarage, [{ start: BASE, end: BASE + 30_000 }]);
});
