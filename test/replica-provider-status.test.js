import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { chargingSettings } from '../src/charging/settings.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { dashboardProviders } from '../chart/provider-status.js';

const at = Date.parse('2026-10-06T09:00:00Z');
const sourceAt = at - 60_000, receivedAt = at - 30_000;
const formatTime = value => new Date(value).toISOString();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('actual replica provider categories consistently describe saved evidence while empty datasets and original clocks remain distinct', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-provider-replica-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'snapshot.sqlite'), store = new Store(dbPath);
  store.event('decision', { input: 'mqtt' }, at);
  store.setState('providers:health', {
    easee: { status: 'ok', lastSuccessAt: receivedAt, currentReadings: { property: { qualityIssues: [], lastSuccessAt: receivedAt } },
      localOcpp: { available: true, connected: true, setup: { state: 'ready' } } },
    temperatures: { status: 'ok', source: 'mqtt-temperature' },
    market: { status: 'ok', source: 'entsoe', lastSuccessAt: sourceAt },
    weather: { status: 'ok', source: 'fmi', lastSuccessAt: sourceAt },
    outdoor: { status: 'ok', source: 'fmi', lastSuccessAt: sourceAt },
  });
  store.setState('provider:market', { fetchedAt: sourceAt, intervals: [{ start: at, end: at + 3_600_000, spotCtPerKwh: 0 }] });
  store.setState('provider:weather', { fetchedAt: sourceAt, forecast: [{ start: at, end: at + 3_600_000,
    issuedAt: sourceAt, fetchedAt: receivedAt, outdoorC: 0, solarRadiationWm2: 0, source: 'fmi' }] });
  for (const [source, signal, value, unit] of [
    ['mqtt-temperature', 'indoor_temperature', 20, 'degC'], ['shelly-mqtt', 'garage_temperature', 0, 'degC'],
    ['fmi', 'outdoor_temperature', 0, 'degC'], ['easee', 'property_energy_l1', .01, 'kWh'],
    ['shelly-evse', 'ev2_energy_l1', 0, 'kWh'], ['shelly-evse', 'ev2_energy_l2', null, 'kWh'],
  ]) store.observation({ source, device: 'synthetic-provider-device', signal, value, unit, sourceTime: sourceAt,
    receivedAt, quality: value === null ? ['missing'] : [], raw: { timeBasis: 'source-measured' } });
  const settings = chargingSettings();
  store.setState('charging:mqtt', { version: 6, chargers: {}, view: { settings,
    chargers: CHARGER_DEFINITIONS.map(definition => buildCharger({ definition, settings: settings.chargers[definition.id], now: at })),
    vehicleFeeds: [
      { id: 'bmw', label: 'BMW', provider: 'bmw-cardata', topic: 'synthetic/vehicles/bmw',
        reception: { brokerConnected: true, subscribed: true, lastLiveAt: receivedAt },
        setup: { available: true, fields: { soc: { value: 0, measuredAt: sourceAt, receivedAt, available: true } } } },
      { id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: 'synthetic/vehicles/tesla/#',
        reception: { brokerConnected: true, subscribed: true } },
    ] } });
  store.close();
  const digest = hash(dbPath), publication = { dbPath, generation: 'synthetic-provider-snapshot', sourceAt: at,
    verifiedAt: at, digest, bytes: readFileSync(dbPath).length };
  let now = at;
  const app = await startReplica({ config: { topology: 'mirror', role: 'slave', input: 'mqtt', addon: false,
    host: '127.0.0.1', port: 0, token: '', mirror: { directory }, connections: { equipment: { devices: [] } } },
    clock: () => now, readPublication: async () => publication, installSignalHandlers: false,
    makeChartService: () => ({ overview: async () => ({}), close: async () => {} }) });
  t.after(() => app.close());
  const status = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`)).json();
  const groups = dashboardProviders(status, { now, formatTime });
  assert.deepEqual(groups.map(group => group.overviewTitle),
    ['Electricity consumption', 'Electricity prices', 'Vehicle telemetry', 'Main temperatures & Weather']);
  assert.deepEqual(groups.map(group => group.display.state), Array(4).fill('Recorded snapshot'));
  assert(groups.every(group => !group.display.attention && group.sourceStates.every(source => source.tone === 'pending')));
  const dataset = signal => groups.flatMap(group => group.datasets).find(row => row.signals.includes(signal));
  assert.equal(dataset('ev2_energy_l1').state, 'Recorded snapshot');
  assert.equal(dataset('ev2_current_l1').state, 'No saved readings');
  assert.equal(dataset('property_current_l1').state, 'No saved readings');
  assert.equal(dataset('garage_temperature').value, '0.0 °C');
  assert.equal(dataset('solar_forecast').state, 'Recorded snapshot');
  assert.equal(dataset('all_in_price').state, 'No saved readings');
  assert.match(dataset('garage_temperature').reported, new RegExp(formatTime(sourceAt).replaceAll('.', '\\.')));
  assert.equal(groups[2].datasets.find(row => row.label === 'BMW').state, 'Recorded snapshot');
  assert.equal(groups[2].datasets.find(row => row.label === 'Tesla').state, 'No saved readings');
  assert.equal(groups[0].localConnection.readings.label, 'Recorded snapshot');
  assert.equal(groups[0].localConnection.readings.tone, 'pending');
  assert.doesNotMatch(JSON.stringify(groups), /Waiting for readings|Partly available|Fresh charger electricity readings are available/);
  now += 7 * 86_400_000;
  const older = dashboardProviders(app.status(), { now, formatTime });
  assert.deepEqual(older.map(group => group.display.state), Array(4).fill('Recorded snapshot'));
  assert(older.every(group => /snapshot is out of date/.test(group.display.detail)));
  assert.equal(older[0].datasets.find(row => row.signals.includes('ev2_energy_l1')).reported,
    dataset('ev2_energy_l1').reported, 'Aging the copy never renews source measurements');
  assert.equal(older[3].datasets.find(row => row.signals.includes('solar_forecast')).state, 'Recorded snapshot',
    'Saved forecast coverage belongs to the publication boundary, not today');
  assert.equal(hash(dbPath), digest);
});

test('recorded forecasts distinguish unknown issuance from download time and retain backup solar clocks', () => {
  const forecast = { start: at, end: at + 3_600_000, outdoorC: 0, solarRadiationWm2: 0,
    source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: receivedAt };
  const status = { readOnly: true, readView: { snapshotAt: at, liveAvailable: false }, forecast: [forecast],
    providers: { weather: { status: 'snapshot', source: 'openmeteo' } } };
  let group = dashboardProviders(status, { now: at, formatTime })[0];
  assert(group.datasets.every(row => row.state === 'Recorded snapshot'));
  assert(group.datasets.every(row => row.reported === `Fetched ${formatTime(receivedAt)} (just now) · Issue time unavailable`));
  assert.doesNotMatch(JSON.stringify(group.datasets), /Issued /);
  forecast.issuedAt = sourceAt;
  group = dashboardProviders(status, { now: at, formatTime })[0];
  assert(group.datasets.every(row => row.reported === `Fetched ${formatTime(receivedAt)} (just now) · Issue time unavailable`),
    'An explicitly fetched-snapshot basis cannot establish provider issuance');
  forecast.source = 'fmi';
  forecast.issuedAt = sourceAt;
  forecast.issuedAtBasis = 'provider-result-time';
  forecast.solar = { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: receivedAt };
  status.providers.weather = { status: 'snapshot', source: 'fmi', acquisition: { solarSource: 'openmeteo' } };
  group = dashboardProviders(status, { now: at, formatTime })[0];
  assert.equal(group.datasets.find(row => row.signals.includes('outdoor_forecast')).reported,
    `Fetched ${formatTime(receivedAt)} (just now) · Issued ${formatTime(sourceAt)} (1 min ago)`);
  assert.equal(group.datasets.find(row => row.signals.includes('solar_forecast')).reported,
    `Fetched ${formatTime(receivedAt)} (just now) · Issue time unavailable`);
});
