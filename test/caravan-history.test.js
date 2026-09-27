import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { getChartData } from '../src/app/chart-data.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { isRecordedDataset } from '../src/storage/recorded-datasets.js';
import { CARAVAN_RUNNING_STATES, HISTORY_AXES, SIGNAL_INFO } from '../src/domain/history-series.js';
import { INDOOR_SIGNALS, GARAGE_TEMPERATURE_SIGNALS, indoorWeights } from '../src/domain/indoor-sensors.js';
import { historyDatasets, historySeriesAt, historyValueLabel } from '../chart/history-model.js';
import { historyTooltipLabel } from '../chart/history-chart.js';
import { explorerSelection } from '../chart/series-explorer.js';
import { recordingRows } from '../chart/recording.js';

const start = Date.parse('2026-09-14T10:00:00Z');
const stateSignal = 'caravan_dehumidifier_running_state';
const signals = ['caravan_temperature', 'caravan_humidity', stateSignal];
const liveSignals = ['caravan_power', 'caravan_current', 'caravan_active', 'blu_ht_battery', 'blu_ht_rssi',
  'caravan_dehumidifier_power', 'caravan_dehumidifier_fan_speed', 'caravan_dehumidifier_target_humidity'];
const report = (signal, value, at = start) => ({ source: 'mqtt-equipment',
  device: signal === stateSignal ? 'caravan_dehumidifier' : 'blu_ht', signal, value,
  unit: signal === stateSignal ? 'state' : signal === 'caravan_temperature' ? '°C' : '%',
  sourceTime: at, receivedAt: at, quality: [], raw: { reportIntervalMs: 60_000, reportGraceMs: 120_000 } });
const chart = (store, left, options = {}) => getChartData({ store, input: 'mqtt', now: start + 600_000,
  startDate: '2026-09-14', endDate: '2026-09-14', left, ...options });

test('caravan catalogue exists without manufacturing telemetry and never joins heating inputs', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const signal of signals) {
    assert(HISTORY_AXES.some(axis => axis.key === signal && axis.group === 'Caravan'));
    const row = SIGNAL_INFO[signal];
    assert.equal(row.role, 'History only');
    assert.equal(row.status, undefined);
    assert(!recordingRows().some(row => row.signal === signal), 'The active recorder table does not invent a recorded stream');
    assert.deepEqual(chart(store, signal).series[signal], []);
    assert(!INDOOR_SIGNALS.includes(signal));
    assert(!GARAGE_TEMPERATURE_SIGNALS.includes(signal));
  }
  assert.throws(() => indoorWeights({ indoorSensorWeights: { caravan_temperature: 1 } }), /Invalid indoor sensor/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
});

test('only caravan air, interval energy and running state record; battery and live equipment values do not', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  for (const signal of liveSignals) {
    const observation = report(signal, 50);
    assert.equal(isRecordedDataset(observation), false);
    assert.equal(recorder.record(observation).saved, false);
  }
  for (const [signal, value] of [['caravan_temperature', 14.1], ['caravan_humidity', 63], [stateSignal, 0]])
    assert.equal(recorder.record(report(signal, value)).saved, true);
  assert.equal(recorder.record({ ...report('caravan_energy', 0.42), unit: 'kWh' }).saved, true);
  assert.deepEqual(new Set(store.db.prepare('SELECT signal FROM observations').all().map(row => row.signal)), new Set([...signals, 'caravan_energy']));
  const recording = recorder.status(start);
  assert.deepEqual(new Set([...recording.parameters, ...recording.exactParameters].map(row => row.signal)), new Set([...signals, 'caravan_energy']));
  const adaptive = getDatabaseOverview({ store, now: start }).groups.flatMap(group => group.items).find(row => row.id === 'adaptive-observations');
  assert.equal(adaptive.count, 3, 'Running state has its separate exact-change dataset');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 4);
});

test('caravan temperature and humidity use the same source deadline, with explicit gaps and recovery', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  for (const [signal, value] of [['caravan_temperature', 14.1], ['caravan_humidity', 63]]) {
    recorder.record(report(signal, value));
    recorder.record(report(signal, value, start + 60_000));
    recorder.record(report(signal, value + 1, start + 360_000));
    const payload = chart(store, signal), points = payload.series[signal];
    assert(points.some(point => point.y === value));
    assert(points.some(point => point.x === start + 240_000 && point.y === null));
    assert(!points.some(point => point.x >= start + 240_000 && point.x < start + 360_000 && point.y !== null));
    assert(points.some(point => point.x === start + 360_000 && point.y === value + 1));
    assert(points.some(point => point.x === start + 540_000 && point.y === null));
    assert.equal(historySeriesAt(payload, start + 660_000)[signal].at(-1).y, null);
  }
});

test('dehumidifier enum transitions, viewport edges and dense plots contain only recorded states or gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const expected = [0, 4, 1, 3, 2];
  for (let i = 0; i < 120; i++) recorder.record(report(stateSignal, expected[i % expected.length], start + i * 1000));
  recorder.record({ ...report(stateSignal, null, start + 120_000), quality: ['missing'] });
  const stored = store.db.prepare('SELECT value FROM observations WHERE signal=? ORDER BY source_time').all(stateSignal);
  assert.equal(stored.length, 121, 'Every transition survives recording');
  assert.deepEqual(stored.slice(0, 5).map(row => row.value), expected);
  for (const options of [{ points: 100 }, { viewFrom: start + 500, viewTo: start + 10_500 }]) {
    const payload = chart(store, stateSignal, options), points = payload.series[stateSignal];
    assert(points.length > 0);
    assert(points.every(point => point.y === null || Object.hasOwn(CARAVAN_RUNNING_STATES, point.y)));
    assert(!points.some(point => point.interpolated === true));
    const dataset = historyDatasets(payload.series, { leftSignals: [stateSignal], rightSignals: [] }).find(dataset => dataset.key === stateSignal);
    assert.equal(dataset.stepped, true);
    assert.equal(dataset.cubicInterpolationMode, 'default');
    if (options.viewFrom) assert.deepEqual(points.find(point => point.x === options.viewFrom)?.y, 0);
    else assert(points.some(point => point.x >= start + 120_000 && point.y === null));
  }
  for (const [value, label] of Object.entries(CARAVAN_RUNNING_STATES)) {
    assert.equal(historyValueLabel(stateSignal, Number(value), 'state'), label);
    const tooltip = historyTooltipLabel({ dataset: { key: stateSignal, label: 'Caravan dehumidifier', unit: 'state' },
      parsed: { x: start, y: Number(value) }, raw: { x: start, y: Number(value) } });
    assert.match(tooltip, new RegExp(`Caravan dehumidifier: ${label}`));
    assert.match(tooltip, /not used for learning/);
  }
  const view = explorerSelection(stateSignal);
  assert.deepEqual(view.leftSignals, []);
  assert.deepEqual(view.tracks, [stateSignal], 'Categorical readings use labelled activity rows, not a numeric value axis');
});

test('non-enum dehumidifier samples are gaps and never interpreted as fractional fan states', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [i, value] of [0, 1.5, 5, 4].entries()) store.observation(report(stateSignal, value, start + i * 60_000));
  const points = chart(store, stateSignal).series[stateSignal];
  assert(!points.some(point => point.y === 1.5 || point.y === 5));
});

test('caravan meter energy uses adaptive total-power recording with measured lineage and exact increments', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const interval = (index, power = 1.2) => ({ source: 'mqtt-equipment', device: 'caravan', prefix: 'caravan',
    start: start + index * 15_000, end: start + (index + 1) * 15_000,
    energies: [power * 15_000 / 3_600_000], powers: [power] });
  for (let i = 0; i < 24; i++) recorder.recordEnergy(interval(i));
  let observations = store.observations().filter(row => row.signal === 'caravan_energy');
  assert.equal(observations.length, 1, 'Constant consumption continues in the durable interval without heartbeat records');
  const resumed = new Recorder(store, { clock: () => start + 360_000 });
  assert.equal(resumed.recordEnergy(interval(23)).reason, 'duplicate-interval');
  assert.equal(resumed.flush(start + 360_000, { force: true }).length, 1);
  observations = store.observations().filter(row => row.signal === 'caravan_energy');
  assert(Math.abs(observations.reduce((sum, row) => sum + row.value, 0) - 0.12) < 1e-12);
  assert(observations.every(row => row.raw.basis === 'meter-counter-delta' && row.raw.learningRole === 'history-only'));
  assert.deepEqual(observations.map(row => row.raw.durationMs), [15_000, 345_000]);
  const status = resumed.status(start + 360_000).parameters.find(row => row.signal === 'caravan_energy');
  assert.equal(status.thresholdUnit, 'kW');
  assert.equal(status.optimizedQuantity, 'total-power');
  assert.equal(status.freshness.status, 'recorded-interval');
  assert.equal(status.freshness.maxAgeMs, null);
  const payload = chart(store, 'caravan_energy');
  assert(payload.series.caravan_energy.some(row => row.basis === 'meter-counter-delta'));
  const power = chart(store, 'power');
  assert(!power.series.property_power.some(row => Number.isFinite(row.y)));
  assert(!power.series.charger_power.some(row => Number.isFinite(row.y)));
});

test('adaptive caravan energy closes pending intervals at gaps and never covers unknown electricity', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const record = (from, to, energy = 0.005) => recorder.recordEnergy({ source: 'shelly-mqtt', device: 'caravan', prefix: 'caravan',
    start: start + from, end: start + to, energies: [energy], powers: [energy * 3_600_000 / (to - from)] });
  record(0, 15_000); record(15_000, 30_000);
  recorder.energyGap({ source: 'shelly-mqtt', device: 'caravan', prefix: 'caravan',
    start: start + 30_000, end: start + 90_000, quality: ['missing-report'] });
  record(90_000, 105_000);
  const points = chart(store, 'caravan_energy').series.caravan_energy;
  assert(points.some(point => point.x === start + 30_000 && point.y === 0.005));
  assert(!points.some(point => point.x > start + 30_000 && point.x <= start + 90_000 && Number.isFinite(point.y)));
  assert(points.some(point => point.x === start + 105_000 && point.y === 0.005));
});

test('MQTT caravan air and dehumidifier reports reach the recorder with their real expiry policy and live-only diagnostics', async t => {
  const store = new Store(':memory:'); let now = start;
  const recorder = new Recorder(store, { clock: () => now });
  const settings = equipmentConfiguration({ devices: [
    { id: 'blu_ht', kind: 'temperature', area: 'garage', signal: 'caravan_temperature',
      connection: 'mqtt:invented/caravan/air', max_age_seconds: 180,
      mqtt: { state_path: 'temperature', timestamp_path: 'timestamp' }, readings: [
        { key: 'humidity', signal: 'caravan_humidity', unit: '%', path: 'humidity', required: true },
        { key: 'battery', unit: '%', path: 'battery', record: false },
        { key: 'rssi', unit: 'dBm', path: 'rssi', record: false },
      ] },
    { id: 'caravan_dehumidifier', area: 'garage', kind: 'dehumidifier', max_age_seconds: 120,
      connection: 'mqtt:invented/caravan/dehumidifier/state', dehumidifier_control: true,
      mqtt: { command_topic: 'invented/caravan/dehumidifier/set', timestamp_path: 'timestamp',
        availability_topic: 'invented/caravan/dehumidifier/availability' } },
  ] });
  const capture = createEquipmentCapture({ store, settings,
    engine: { clock: () => now, recorder, ingest: row => recorder.record(row) }, publish: async () => {} });
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  assert.equal(store.observations().length, 0, 'Configured future hardware creates no samples');
  const reportAir = at => capture.receive('invented/caravan/air',
    JSON.stringify({ temperature: 14.1, humidity: 63, battery: 100, rssi: -81, timestamp: at }));
  reportAir(now);
  const device = capture.status().devices.find(row => row.id === 'blu_ht');
  assert.equal(device.readings.blu_ht_battery.value, 100);
  assert.equal(device.readings.blu_ht_rssi.value, -81);
  capture.receive('invented/caravan/dehumidifier/availability', 'online');
  capture.receive('invented/caravan/dehumidifier/state', JSON.stringify({ power: 'on', mode: 'auto', fanSpeed: 'high',
    targetHumidity: 55, swing: 'fixed_90', timestamp: now }));
  assert.deepEqual(new Set(store.observations().map(row => row.signal)), new Set(signals));
  for (const signal of signals) {
    const age = signal === stateSignal ? 120_000 : 180_000;
    const stored = store.observations().find(row => row.signal === signal);
    assert.equal(stored.raw.reportIntervalMs, age);
    assert.equal(stored.raw.reportGraceMs, 0);
    const payload = chart(store, signal), points = payload.series[signal];
    assert(points.some(point => point.x === start + age && point.y === null));
    assert(!points.some(point => point.x >= start + age && Number.isFinite(point.y)));
    const live = chart(store, signal, { now: start + 60_000 });
    const advanced = historySeriesAt(live, start + 190_000)[signal];
    assert(advanced.some(point => point.x === start + age && point.y === null));
  }
  await capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'off' });
  assert.equal(store.observations().length, 3, 'An MQTT command is not a physical state sample');
  now = start + 181_000; capture.tick();
  reportAir(now);
  for (const signal of ['caravan_temperature', 'caravan_humidity']) {
    const points = chart(store, signal).series[signal];
    assert(points.some(point => point.x === start + 180_000 && point.y === null));
    assert(points.some(point => point.x === now && Number.isFinite(point.y)));
  }
});
