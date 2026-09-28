import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { getChartData } from '../src/app/chart-data.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { isRecordedDataset } from '../src/storage/recorded-datasets.js';
import { CARAVAN_DEHUMIDIFIER_STATES, HISTORY_AXES, SIGNAL_INFO } from '../src/domain/history-series.js';
import { INDOOR_SIGNALS, GARAGE_TEMPERATURE_SIGNALS, indoorWeights } from '../src/domain/indoor-sensors.js';
import { historyDatasets, historySeriesAt, historyValueLabel } from '../chart/history-model.js';
import { historyTooltipLabel } from '../chart/history-chart.js';
import { explorerActivityTrack, explorerSelection } from '../chart/series-explorer.js';
import { recordingRows } from '../chart/recording.js';

const start = Date.parse('2026-09-14T10:00:00Z');
const stateSignal = 'caravan_dehumidifier_state';
const signals = ['caravan_temperature', 'caravan_humidity', stateSignal];
const liveSignals = ['caravan_power', 'caravan_current', 'caravan_active', 'blu_ht_battery', 'blu_ht_rssi',
  'caravan_dehumidifier_power', 'caravan_dehumidifier_fan_speed', 'caravan_dehumidifier_target_humidity',
  'caravan_dehumidifier_temperature', 'caravan_dehumidifier_humidity', 'caravan_dehumidifier_mode', 'caravan_dehumidifier_swing'];
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

test('only caravan air, interval energy and combined appliance state record; battery and other appliance values do not', t => {
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
  assert.equal(adaptive.count, 3, 'Appliance state has its separate exact-change dataset');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 4);
});

test('persisted appliance state keeps only necessary identity and evidence clocks from live metadata', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const lineage = { identity: 'a'.repeat(64), fieldTimestamps: { power: start, fanSpeed: start - 500 }, readingsMatch: true, sensorDeviceId: 'blu_ht',
    airObservedAt: start - 3000, humidityObservedAt: start - 2000, applianceHumidityObservedAt: start - 1000 };
  const raw = { ...report(stateSignal, 3).raw, ...lineage, fieldTimestamps: { ...lineage.fieldTimestamps, humidity: start - 1000 },
    fanSpeed: 'high', mode: 'auto', targetHumidity: 55, swing: 'fixed_90', temperature: 14, humidity: 63,
    capabilities: { fanSpeed: ['low', 'high'] }, stateLabels: { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' }, payload: 'appliance live payload' };
  recorder.record({ ...report(stateSignal, 3), raw });
  const persisted = store.observations().find(row => row.signal === stateSignal);
  assert.equal(persisted.value, 3); assert.equal(persisted.unit, 'state');
  assert.deepEqual(Object.fromEntries(Object.keys(lineage).map(key => [key, persisted.raw[key]])), lineage);
  assert.deepEqual(Object.keys(persisted.raw).sort(), [...Object.keys(lineage), 'reportIntervalMs', 'reportGraceMs', 'recorder'].sort(),
    'Native settings, sensor readings and payloads never enter recorded state metadata');
  recorder.record({ ...report(stateSignal, 0, start + 1000), raw });
  const off = store.observations().find(row => row.signal === stateSignal && row.value === 0);
  assert.deepEqual(off.raw.fieldTimestamps, { power: start }, 'Off does not require or retain a fan clock');
  recorder.record({ ...report('garage_door1_open', 1), device: 'door1', unit: 'state', raw });
  const other = store.observations().find(row => row.signal === 'garage_door1_open');
  assert(Object.keys(lineage).every(key => !Object.hasOwn(other.raw, key)), 'The metadata allowance applies only to Caravan appliance state');
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

test('dehumidifier Off/Low/Medium/High transitions, viewport edges and dense plots contain only recorded states or gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const expected = [0, 1, 2, 3];
  assert.deepEqual(CARAVAN_DEHUMIDIFIER_STATES, { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' });
  for (let i = 0; i < 120; i++) recorder.record(report(stateSignal, expected[i % expected.length], start + i * 1000));
  recorder.record({ ...report(stateSignal, null, start + 120_000), quality: ['missing'] });
  const stored = store.db.prepare('SELECT value FROM observations WHERE signal=? ORDER BY source_time').all(stateSignal);
  assert.equal(stored.length, 121, 'Every transition survives recording');
  assert.deepEqual(stored.slice(0, expected.length).map(row => row.value), expected);
  for (const options of [{ points: 100 }, { viewFrom: start + 500, viewTo: start + 10_500 }]) {
    const payload = chart(store, stateSignal, options), points = payload.series[stateSignal];
    assert(points.length > 0);
    assert(points.every(point => point.y === null || Object.hasOwn(CARAVAN_DEHUMIDIFIER_STATES, point.y)));
    assert(!points.some(point => point.interpolated === true));
    const dataset = historyDatasets(payload.series, { leftSignals: [stateSignal], rightSignals: [] }).find(dataset => dataset.key === stateSignal);
    assert.equal(dataset.stepped, true);
    assert.equal(dataset.cubicInterpolationMode, 'default');
    if (options.viewFrom) assert.deepEqual(points.find(point => point.x === options.viewFrom)?.y, 0);
    else assert(points.some(point => point.x >= start + 120_000 && point.y === null));
  }
  for (const [value, label] of Object.entries(CARAVAN_DEHUMIDIFIER_STATES)) {
    assert.equal(historyValueLabel(stateSignal, Number(value), 'state'), label);
    const tooltip = historyTooltipLabel({ dataset: { key: stateSignal, label: 'Caravan dehumidifier', unit: 'state' },
      parsed: { x: start, y: Number(value) }, raw: { x: start, y: Number(value) } });
    assert.match(tooltip, new RegExp(`Caravan dehumidifier: ${label}`));
    assert.match(tooltip, /not used for learning/);
  }
  const view = explorerSelection(stateSignal);
  assert.deepEqual(view.leftSignals, []);
  assert.deepEqual(view.tracks, [stateSignal], 'Categorical readings use labelled activity rows, not a numeric value axis');
  const track = explorerActivityTrack(stateSignal);
  assert.deepEqual(track.values, { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' });
  assert.deepEqual(track.legend.map(row => row.label), ['Off', 'Low', 'Medium', 'High', 'Unknown']);
  assert.equal(new Set(Object.values(track.colors)).size, 4, 'Every known state has a distinguishable activity color');
});

test('unsupported dehumidifier codes are gaps and retired series have no current interpretation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start });
  const values = [0, 1.5, 2, 3, 4, -1, 1];
  for (const [i, value] of values.entries()) recorder.record(report(stateSignal, value, start + i * 60_000));
  const points = chart(store, stateSignal).series[stateSignal];
  assert(points.length > 0);
  assert(points.every(point => point.y === null || [0, 1, 2, 3].includes(point.y)));
  for (const index of [1, 4]) assert(points.some(point => point.x === start + index * 60_000 && point.y === null));
  assert(!points.some(point => point.x >= start + 4 * 60_000 && point.x < start + 6 * 60_000 && point.y !== null));
  for (const value of ['1', 'auto', 1.5, 4, -1]) assert.equal(historyValueLabel(stateSignal, value, 'state'), 'Unknown');
  for (const retired of ['caravan_dehumidifier_active', 'caravan_dehumidifier_running_state']) {
    assert.equal(SIGNAL_INFO[retired], undefined);
    assert.equal(isRecordedDataset(report(retired, 1)), false);
    assert.throws(() => explorerSelection(retired), /supported/);
  }
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

test('caravan power uses each original energy interval duration and retains gaps and measured provenance', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const record = (from, to, value, quality = []) => store.observation({ source: 'shelly-mqtt', device: 'caravan',
    signal: 'caravan_energy', value, unit: 'kWh', sourceTime: start + to, receivedAt: start + to, quality,
    raw: { intervalStart: start + from, intervalEnd: start + to, durationMs: to - from,
      basis: 'meter-counter-delta', learningRole: 'history-only' } });
  record(0, 15_000, 0.005); record(15_000, 60_000, 0.005);
  record(90_000, 120_000, 0.005); record(120_000, 150_000, 0.005, ['meter-counter-reset']);
  // Live watts are deliberately impossible here: the projected power must
  // continue to come only from original metered energy, even if such a row exists.
  store.observation({ source: 'shelly-mqtt', device: 'caravan', signal: 'caravan_power', value: 99,
    unit: 'kW', sourceTime: start, receivedAt: start, quality: [], raw: {} });
  const payload = chart(store, 'caravan_power'), points = payload.series.caravan_power;
  const finite = points.filter(point => Number.isFinite(point.y));
  assert.deepEqual([...new Set(finite.map(point => JSON.stringify([
    point.intervalStart - start, point.intervalEnd - start, point.y,
  ])))].map(value => JSON.parse(value)), [[0, 15_000, 1.2], [15_000, 60_000, 0.4], [90_000, 120_000, 0.6]]);
  for (const [at, expected] of [[0, 1.2], [15_000, 0.4], [90_000, 0.6]])
    assert(finite.some(point => point.x === start + at && point.y === expected));
  for (const point of finite) {
    assert.equal(point.source, 'shelly-mqtt');
    assert.equal(point.basis, 'meter-counter-delta');
    assert.equal(point.fromEnergy, true);
    assert.equal(point.learningRole, 'history-only');
    const expected = point.x < start + 15_000 ? [0, 15_000] : point.x < start + 60_000 ? [15_000, 60_000] : [90_000, 120_000];
    assert.deepEqual([point.intervalStart - start, point.intervalEnd - start], expected);
  }
  assert(points.some(point => point.x === start + 60_000 && point.y === null));
  assert(!points.some(point => point.x >= start + 60_000 && point.x < start + 90_000 && Number.isFinite(point.y)));
  assert(!points.some(point => point.x >= start + 120_000 && Number.isFinite(point.y)), 'Invalid energy and the tail remain unavailable');
  const clipped = chart(store, 'caravan_power', { viewFrom: start + 20_000, viewTo: start + 40_000 }).series.caravan_power;
  assert(clipped.some(point => point.x === start + 20_000 && point.y === 0.4
    && point.intervalStart === start + 15_000 && point.intervalEnd === start + 60_000), 'Viewport clipping cannot change the divisor or original interval provenance');
  const energyPayload = chart(store, 'caravan_energy');
  const energy = energyPayload.series.caravan_energy.filter(point => Number.isFinite(point.y));
  assert.deepEqual(energy.map(({ x, y }) => [x - start, y]), [[15_000, 0.005], [60_000, 0.005], [120_000, 0.005]], 'Original energy remains available without conversion');
  assert.deepEqual(payload.timingBenefit, energyPayload.timingBenefit, 'A new drawing projection does not change tariff comparisons');
  const named = chart(store, undefined, { view: 'caravan_power' });
  assert.deepEqual(named.series.caravan_power, points, 'Named view and explorer use the same original intervals');
});

test('caravan power exposes durable pending meter intervals without recording watts or extending past evidence', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => start + 45_000 });
  for (let i = 0; i < 3; i++) recorder.recordEnergy({ source: 'shelly-mqtt', device: 'caravan', prefix: 'caravan',
    start: start + i * 15_000, end: start + (i + 1) * 15_000, energies: [0.005], powers: [1.2] });
  assert.equal(store.observations().filter(row => row.signal === 'caravan_energy').length, 1);
  const points = chart(store, 'caravan_power', { now: start + 45_000 }).series.caravan_power;
  const pending = points.filter(point => point.pending);
  assert(pending.length > 0);
  for (const point of pending) {
    assert.equal(point.y, 1.2); assert.equal(point.basis, 'meter-counter-delta');
    assert.equal(point.source, 'shelly-mqtt'); assert.equal(point.learningRole, 'history-only');
    assert.equal(point.intervalStart, start + 15_000); assert.equal(point.intervalEnd, start + 45_000);
  }
  assert(points.some(point => point.x === start + 45_000 && point.y === null));
  assert(!points.some(point => point.x >= start + 45_000 && Number.isFinite(point.y)));
  assert(!store.observations().some(row => row.signal === 'caravan_power'));
  assert(!chart(store, 'caravan_power', { now: start + 30_000 }).series.caravan_power.some(point => point.pending),
    'A pending interval observed later is unavailable to an earlier chart cutoff');
});

test('caravan power cannot be created from live watts without original meter intervals', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.observation({ source: 'mqtt-equipment', device: 'caravan', signal: 'caravan_power', value: 0.8,
    unit: 'kW', sourceTime: start, receivedAt: start, quality: [], raw: {} });
  assert.deepEqual(chart(store, 'caravan_power').series.caravan_power, []);
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
    targetHumidity: 55, swing: 'fixed_90', identity: 'a'.repeat(64), capabilities: { power: ['off', 'on'] }, timestamp: now }));
  assert.deepEqual(new Set(store.observations().map(row => row.signal)), new Set(signals));
  const persistedAppliance = store.observations().find(row => row.signal === stateSignal);
  assert.equal(persistedAppliance.value, 3);
  assert.equal(persistedAppliance.raw.identity, 'a'.repeat(64));
  assert.deepEqual(persistedAppliance.raw.fieldTimestamps, { power: now, fanSpeed: now });
  assert(!['fanSpeed', 'mode', 'targetHumidity', 'swing', 'temperature', 'humidity', 'runningState'].some(key => Object.hasOwn(persistedAppliance.raw, key)));
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
