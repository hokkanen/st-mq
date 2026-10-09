import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardProviders, describeProvider, easeeLocalConnectionDisplay, outdoorSourceLabel, providerName, providerSeries, temperatureReadingStatus } from '../chart/provider-status.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';

const now = Date.parse('2026-09-07T10:00:00Z');
const options = { now, formatTime: value => new Date(value).toISOString().slice(11, 16) };
const easeeReadings = () => ({ charger: { qualityIssues: [], error: null, lastSuccessAt: now },
  property: { qualityIssues: [], error: null, lastSuccessAt: now } });
const shellySignals = [
  ...['current', 'voltage'].flatMap(field => [1, 2, 3].map(phase => `ev2_${field}_l${phase}`)),
  'ev2_active_power', ...[1, 2, 3].map(phase => `ev2_active_power_l${phase}`),
  ...[1, 2, 3].map(phase => `ev2_energy_l${phase}`), 'ev2_import_energy_counter',
];
const shellyReadings = () => ({ maxAgeMs: 60_000, controlReady: true, readings: Object.fromEntries(shellySignals
  .filter(signal => !signal.startsWith('ev2_energy'))
  .map(signal => [signal, { value: 0, available: true, sourceTime: now, quality: [] }])) });
const temperature = (source, value = 21, extra = {}) => ({ source, value, observedAt: now, stale: false, ...extra });
const completeDashboard = () => ({ now, input: 'mqtt', observations: {
  indoor: temperature('mqtt-temperature'), garage: temperature('shelly-mqtt', 16), outdoor: temperature('fmi', 4),
}, charging: { vehicleFeeds: [
  { id: 'bmw', label: 'BMW', provider: 'bmw-cardata', enabled: true, topic: 'fixture/vehicles/bmw',
    reception: { brokerConnected: true, subscriptionStatus: 'subscribed', lastLiveAt: now } },
  { id: 'tesla', label: 'Tesla', provider: 'teslamate', enabled: true, topic: 'fixture/vehicles/tesla/#',
    reception: { brokerConnected: true, subscriptionStatus: 'subscribed', lastLiveAt: now } },
] }, providers: {
  easee: { status: 'ok', currentReadings: easeeReadings(), deviceTransports: { charger: 'ocpp', property: 'stream' } },
  'shelly-evse': { status: 'ok', reason: 'physical-meter', enabled: true, ...shellyReadings() },
  market: { status: 'ok', source: 'entsoe' }, weather: { status: 'ok', source: 'fmi' },
} });

test('configured data overview has four consistent categories with both vehicle sources together', () => {
  const entries = dashboardProviders(completeDashboard(), options);
  assert.deepEqual(entries.map(row => row.key), ['electricity', 'market', 'vehicle-telemetry', 'main-temperatures']);
  assert.deepEqual(entries.map(row => row.overviewTitle),
    ['Electricity consumption', 'Electricity prices', 'Vehicle telemetry', 'Main temperatures & Weather']);
  assert.deepEqual(entries.map(row => row.source), ['Easee, Shelly EVSE', 'ENTSO-E', 'BMW CarData, TeslaMate', 'MQTT, Shelly, FMI']);
  assert.ok(entries.every(row => row.display.state === 'Available' && row.introduction?.length > 40));
  assert.deepEqual(entries[2].sourceStates.map(row => [row.label, row.state]), [['BMW CarData', 'Connected'], ['TeslaMate', 'Connected']]);
  assert.deepEqual(entries[2].datasets.map(row => [row.label, row.source, row.state]),
    [['BMW', 'BMW CarData', 'Connected'], ['Tesla', 'TeslaMate', 'Connected']]);
  assert.ok(entries[2].datasets.every(row => row.description && row.reported.startsWith('Reported ')));
  assert.doesNotMatch(JSON.stringify(entries[2].datasets), /fixture\/vehicles|brokerConnected|subscriptionStatus/);
  assert.deepEqual(entries[3].sections.map(row => row.title), ['Main temperatures', 'Weather forecast']);
  assert.doesNotMatch(JSON.stringify(entries[0]), /BMW|CarData|TeslaMate/);
});

test('electricity sections keep property, local Charger 1 and MQTT Charger 2 readings complete and distinct', () => {
  const [group] = dashboardProviders(completeDashboard(), options);
  assert.deepEqual(group.sections.map(row => row.title), ['Easee cloud', 'Easee OCPP', 'Shelly EVSE']);
  const [cloud, ocpp, shelly] = group.sections;
  assert.match(cloud.description, /Property.*Equalizer.*Easee cloud/);
  assert.match(ocpp.description, /Charger 1.*local OCPP.*cloud.*backup/);
  assert.match(shelly.description, /Charger 2.*MQTT/);
  assert.ok(cloud.datasets.every(row => row.signals.every(signal => signal.startsWith('property_') || signal === 'ev1_session_energy_check')));
  assert.ok(cloud.datasets.some(row => row.signals.includes('ev1_session_energy_check')));
  assert.ok(ocpp.datasets.every(row => row.signals.every(signal => signal.startsWith('ev1_') && signal !== 'ev1_session_energy_check')));
  assert.ok(ocpp.datasets.every(row => row.source.includes('Easee local OCPP')));
  assert.deepEqual(shelly.datasets.flatMap(row => row.signals), shellySignals);
  const signals = group.sections.flatMap(section => section.datasets.flatMap(row => row.signals));
  assert.equal(signals.length, new Set(signals).size, 'Every electrical signal has a single owning section');
  assert.deepEqual([...signals].sort(), group.datasets.flatMap(row => row.signals).sort());
});

test('vehicle overview follows each MQTT feed and keeps quiet vehicles and electricity health independent', () => {
  const cases = [
    [{ brokerConnected: true, subscriptionStatus: 'pending' }, 'Partly available', false, 'Awaiting subscription'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed' }, 'Available', false, 'Connected'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed', lastLiveAt: now - 7 * 86_400_000 }, 'Available', false, 'Connected'],
    [{ brokerConnected: false, subscriptionStatus: 'disconnected' }, 'Needs attention', true, 'Disconnected'],
    [{ brokerConnected: true, subscriptionStatus: 'failed' }, 'Needs attention', true, 'Subscription failed'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed', invalidReason: 'invalid-soc' }, 'Needs attention', true, 'Invalid vehicle report'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed', available: false, reason: 'vehicle-feed-stale' }, 'Needs attention', true, 'Vehicle feed stale'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed', available: false, reason: 'vehicle-observation-storage-pending' }, 'Partly available', false, 'Saving vehicle report'],
    [{ brokerConnected: true, subscriptionStatus: 'subscribed', available: false, reason: 'vehicle-observation-admission-failed' }, 'Needs attention', true, 'Vehicle report not accepted'],
  ];
  for (const index of [0, 1]) for (const [reception, state, attention, sourceState] of cases) {
    const status = completeDashboard();
    status.charging.vehicleFeeds[index].reception = reception;
    const entries = dashboardProviders(status, options), vehicle = entries.find(row => row.key === 'vehicle-telemetry');
    assert.equal(vehicle.display.state, state);
    assert.equal(vehicle.display.attention, attention);
    assert.equal(vehicle.sourceStates[index].state, sourceState);
    assert.equal(entries[0].display.state, 'Available');
  }
  const status = completeDashboard();
  for (const feed of status.charging.vehicleFeeds) feed.reception = { brokerConnected: true, subscriptionStatus: 'pending' };
  assert.equal(dashboardProviders(status, options)[2].display.state, 'Waiting for readings');
  for (const feed of status.charging.vehicleFeeds) feed.enabled = false;
  assert.equal(dashboardProviders(status, options)[2].display.state, 'Not enabled');
  status.charging.vehicleFeeds[0].enabled = true;
  status.charging.vehicleFeeds[0].reception.subscriptionStatus = 'subscribed';
  status.providers.easee = { status: 'error', error: 'HTTP-503' };
  const entries = dashboardProviders(status, options);
  assert.equal(entries[0].display.state, 'Needs attention');
  assert.equal(entries[2].display.state, 'Available');
  for (const [reason, state, attention] of [
    ['vehicle-observation-storage-pending', 'Saving vehicle report', false],
    ['vehicle-observation-admission-failed', 'Vehicle report not accepted', true],
  ]) {
    const display = describeProvider('teslamate', { status: 'degraded', reason, lastMessageAt: now - 60_000 }, options);
    assert.equal(display.state, state); assert.equal(display.attention, attention);
    assert.match(display.detail, /Vehicle readings are unavailable.*original times/);
    assert.match(display.detail, /Last MQTT message 09:59/);
    assert.doesNotMatch(display.detail, /logger|unhealthy|storage-pending|admission-failed/);
  }
});

test('combined temperature and forecast summary preserves backup and attention with unique actual source names', () => {
  const status = completeDashboard();
  status.providers.weather = { status: 'fallback', source: 'fmi', acquisition: { solarSource: 'mixed' } };
  status.forecast = [
    { start: now, end: now + 3_600_000, outdoorC: 4, solarRadiationWm2: 20, source: 'fmi', solar: { source: 'fmi' } },
    { start: now + 3_600_000, end: now + 7_200_000, outdoorC: 5, solarRadiationWm2: 40, source: 'fmi', solar: { source: 'openmeteo' } },
  ];
  let group = dashboardProviders(status, options)[3];
  assert.equal(group.display.state, 'Using backup');
  assert.equal(group.backup, true);
  assert.equal(group.source, 'MQTT, Shelly, FMI, Open-Meteo');
  assert.deepEqual(group.sourceStates.map(row => row.label), ['MQTT', 'Shelly', 'FMI', 'Open-Meteo']);
  assert.equal(group.datasets.find(row => row.signals.includes('solar_forecast')).source, 'FMI + Open-Meteo');
  assert.equal(group.datasets.find(row => row.signals.includes('outdoor_temperature')).state, 'Available');
  status.observations.garage.observedAt = now - 3 * 3_600_000;
  group = dashboardProviders(status, options)[3];
  assert.equal(group.display.state, 'Needs attention');
  assert.equal(group.backup, true);
  assert.equal(group.sourceStates.find(row => row.label === 'Shelly').tone, 'attention');
  status.observations.garage.observedAt = now;
  status.weatherStatus = 'stale-forecast';
  group = dashboardProviders(status, options)[3];
  assert.equal(group.display.state, 'Needs attention');
  assert.match(group.display.detail, /forecast is out of date/);
  assert.equal(group.datasets.find(row => row.signals.includes('outdoor_temperature')).state, 'Available');
});

test('inactive weather sources do not reduce healthy temperature availability or invent source names', () => {
  for (const weatherStatus of ['disabled', 'not-configured']) {
    const status = completeDashboard();
    status.providers.weather = { status: weatherStatus };
    const group = dashboardProviders(status, options)[3];
    assert.equal(group.display.state, 'Available');
    assert.equal(group.source, 'MQTT, Shelly, FMI');
    assert.ok(group.sections.find(section => section.key === 'forecast').datasets.every(row =>
      row.state === (weatherStatus === 'disabled' ? 'Not enabled' : 'Not configured')));
  }
});

test('forecast age follows the contributing publications, including separately fetched solar backup', () => {
  const status = completeDashboard(), hour = 3_600_000;
  status.providers.weather = { status: 'fallback', source: 'fmi', lastSuccessAt: now,
    acquisition: { selected: 'fmi', solarSource: 'mixed' } };
  status.forecast = [0, 1].map(index => ({ start: now + index * hour, end: now + (index + 1) * hour,
    source: 'fmi', outdoorC: 5, solarRadiationWm2: 0, issuedAt: now - 2 * hour,
    issuedAtBasis: 'provider-result-time', fetchedAt: now - hour, solar: { basis: 'forecast' } }));
  status.forecast[1].solar = { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now - 15 * 60_000 };
  const forecasts = () => dashboardProviders(status, options).find(row => row.key === 'main-temperatures')
    .sections.find(section => section.key === 'forecast').datasets;
  let [outdoor, solar] = forecasts();
  assert.equal(outdoor.reported, 'Fetched 09:00 (1 h ago) · Issued 08:00 (2 h ago)');
  assert.equal(solar.source, 'FMI + Open-Meteo', 'Primary rows without duplicate solar source fields still retain FMI provenance');
  assert.equal(solar.reported, 'FMI: Fetched 09:00 (1 h ago) · Issued 08:00 (2 h ago); Open-Meteo: Fetched 09:45 (15 min ago) · Issue time unavailable');
  status.providers.weather.lastSuccessAt += 10 * 60_000;
  assert.equal(forecasts()[0].reported, outdoor.reported, 'Reading health again cannot refresh the forecast publication');
  delete status.forecast[1].solar.fetchedAt;
  [outdoor, solar] = forecasts();
  assert.match(solar.reported, /Open-Meteo: Fetch time unavailable · Issue time unavailable$/,
    'Missing backup clocks cannot borrow the primary forecast clocks');
  status.forecast[1].solar.fetchedAt = now + 1;
  assert.match(forecasts()[1].reported, /Open-Meteo: Fetch time unavailable/);
});

test('a forecast containing multiple publication times shows their range and oldest age', () => {
  const status = completeDashboard(), hour = 3_600_000;
  status.forecast = [0, 1].map(index => ({ start: now + index * hour, end: now + (index + 1) * hour,
    source: 'openmeteo', outdoorC: 0, solarRadiationWm2: 0, issuedAt: null,
    issuedAtBasis: 'fetched-snapshot', fetchedAt: now - (index + 1) * hour }));
  const group = dashboardProviders(status, options).find(row => row.key === 'main-temperatures');
  const rows = group.sections.find(section => section.key === 'forecast').datasets;
  assert.ok(rows.every(row => row.reported === 'Fetched 08:00 – 09:00 (oldest 2 h ago) · Issue time unavailable'));
});

test('a Shelly garage front sensor appears before forecast sources without duplicating sources', () => {
  const status = completeDashboard();
  status.observations.garage.source = 'mqtt-temperature';
  status.observations.garageFront = temperature('shelly-mqtt', 15);
  const group = dashboardProviders(status, options)[3];
  assert.equal(group.source, 'MQTT, Shelly, FMI');
  assert.equal(group.display.state, 'Available');
  assert.equal(group.datasets.find(row => row.signals.includes('garage_temperature_2')).source, 'Shelly');
});

test('dashboard groups measured temperatures and forecasts under their actual sources', () => {
  const entries = dashboardProviders({ input: 'providers', observations: {
    indoor: temperature('mqtt-temperature'), garage: temperature('mqtt-temperature', 16), outdoor: temperature('fmi', 4),
  }, providers: { temperatures: { source: 'mqtt-temperature', status: 'ok', lastSuccessAt: now },
    easee: { status: 'ok' }, market: { status: 'ok', source: 'entsoe' },
    weather: { status: 'ok', source: 'fmi' }, outdoor: { status: 'ok', source: 'fmi', lastSuccessAt: now } } }, options);
  assert.deepEqual(entries.map(row => row.key), ['electricity', 'market', 'main-temperatures']);
  const grouped = entries[2];
  assert.equal(grouped.display.title, 'Main temperatures & Weather · MQTT, FMI');
  assert.equal(grouped.display.state, 'Available');
  assert.equal(grouped.source, 'MQTT, FMI');
  assert.deepEqual(grouped.series.map(row => row.source), ['MQTT', 'MQTT', 'FMI', 'FMI', 'FMI']);
  assert.deepEqual(grouped.series.flatMap(row => row.signals), ['indoor_temperature', 'garage_temperature', 'outdoor_temperature',
    'outdoor_forecast', 'solar_radiation', 'solar_forecast']);
  assert.match(grouped.series[1].detail, /Rear pipe-location air measurement.*does not establish protection readiness/);
  assert.match(grouped.display.detail, /Temperature downloads · MQTT: Last successful download 10:00/);
  assert.match(grouped.display.detail, /Outdoor downloads · FMI: Observed at a nearby weather station. Last successful download 10:00/);
});

test('selected live temperatures take precedence over downloaded provider source without requiring a garage sensor', () => {
  const status = { input: 'mqtt', observations: {
    indoor: temperature('mqtt-temperature'), outdoor: temperature('fmi', 4), garage: { value: null, stale: true },
  }, providers: { temperatures: { status: 'disabled' }, outdoor: { source: 'openmeteo', status: 'fallback' } } };
  const [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.title, 'Main temperatures & Weather · MQTT, FMI');
  assert.equal(grouped.display.state, 'Available');
  assert.equal(grouped.display.attention, false);
  assert.equal(grouped.backup, false);
  assert.equal(grouped.series[1].source, null);
  assert.match(grouped.series[1].detail, /No current reading received/);
  assert.equal(grouped.series[2].source, 'FMI');
  status.observations.garage = temperature('mqtt-temperature', 16, { stale: true });
  assert.equal(dashboardProviders(status, options)[0].display.state, 'Available');
});

test('failed outdoor downloads remain actionable even with a recent selected reading', () => {
  const status = { input: 'providers', observations: {
    indoor: temperature('mqtt-temperature'), outdoor: temperature('fmi', 4),
  }, providers: { temperatures: { source: 'mqtt-temperature', status: 'degraded', qualityIssues: ['missing'] },
    outdoor: { source: 'fmi', status: 'error', error: 'HTTP-503' } } };
  let [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.state, 'Needs attention');
  assert.match(grouped.display.detail, /Outdoor downloads · FMI:.*Download failed \(HTTP 503\)/);
  status.observations.outdoor = temperature('fmi', 4);
  [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.state, 'Needs attention');
  assert.equal(grouped.series[2].source, 'FMI');
  assert.match(grouped.display.detail, /Outdoor downloads · FMI:.*Download failed \(HTTP 503\)/);
  status.providers.temperatures.error = 'HTTP-401';
  assert.equal(dashboardProviders(status, options)[0].display.state, 'Needs attention');
});

test('unusable required temperatures cannot inherit an Available state from successful downloads', () => {
  for (const key of ['indoor', 'outdoor']) {
    for (const unavailable of [null, { value: null, stale: true }, temperature('fmi', 4, { stale: true }),
      temperature('fmi', 4, { observedAt: now + 1 }),
      ...(key === 'outdoor' ? [temperature('fmi', 4, { observedAt: now - 31 * 60_000 })] : [])]) {
      const observations = { indoor: temperature('mqtt-temperature'), outdoor: temperature('fmi', 4), [key]: unavailable };
      const [grouped] = dashboardProviders({ input: 'providers', observations,
        providers: { outdoor: { status: 'ok', source: 'fmi', lastSuccessAt: now } } }, options);
      assert.equal(grouped.display.state, 'Needs attention');
      assert.equal(grouped.display.attention, true);
    }
  }
  const [waiting] = dashboardProviders({ input: 'mqtt' }, options);
  assert.equal(waiting.display.state, 'Waiting for readings');
  assert.equal(waiting.display.attention, false);
});

test('two-hour indoor readings remain normal while outdoor freshness stays separate', () => {
  const indoor = temperature('mqtt-temperature', 21, { observedAt: now - 2 * 3_600_000 });
  const status = { input: 'mqtt', observations: { indoor, outdoor: temperature('husdata-h66', 4) } };
  const [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.state, 'Available');
  assert.equal(grouped.display.attention, false);
  assert.deepEqual(temperatureReadingStatus(indoor, options), { usable: true, attention: false, detail: 'Observed 08:00' });
  assert.equal(temperatureReadingStatus(indoor, { ...options, outdoor: true }).usable, false);
  const older = temperatureReadingStatus({ ...indoor, observedAt: indoor.observedAt - 1 }, options);
  assert.equal(older.usable, true);
  assert.equal(older.attention, true);
  assert.match(older.detail, /Needs attention.*Using last known reading.*over 2 hours old/);
});

test('last known indoor values show room warnings and timestamps without blocking the average', () => {
  const observedAt = now - 48 * 3_600_000;
  const held = { observedAt, held: true, needsAttention: true, attentionReasons: ['old-reading', 'disconnected'] };
  const indoor = temperature('indoor-average', 21, { ...held,
    attentionSensors: [{ signal: 'bedroom_temperature', observedAt, reasons: held.attentionReasons }] });
  const status = { input: 'mqtt', observations: { indoor,
    upstairs: temperature('mqtt-temperature', 22), downstairs: temperature('mqtt-temperature', 20),
    bedroom: temperature('mqtt-temperature', 21, held), outdoor: temperature('husdata-h66', 4) } };
  const [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.state, 'Needs attention');
  assert.match(grouped.display.detail, /Average indoor: Needs attention.*Using last known readings: Bedroom observed 10:00.*over 2 hours old.*sensor disconnected/);
  assert.match(grouped.series[2].detail, /Using last known reading from 10:00.*sensor disconnected/);
  const summary = temperatureReadingStatus(indoor, options);
  assert.equal(summary.usable, true);
  assert.match(summary.detail, /Bedroom observed/);
  status.observations.indoor.attentionSensors.push({ signal: 'invented-private-room', observedAt, reasons: ['invented-private-reason'] });
  status.observations.bedroom.attentionReasons.push('invented-private-reason');
  assert.doesNotMatch(JSON.stringify(dashboardProviders(status, options)), /invented-private/);
});

test('recent disconnected room and old optional garage remain usable with actionable source warnings', () => {
  const status = { input: 'mqtt', observations: {
    indoor: temperature('mqtt-temperature', 21, { held: true, needsAttention: true, attentionReasons: ['disconnected'] }),
    outdoor: temperature('husdata-h66', 4),
  } };
  const reading = temperatureReadingStatus(status.observations.indoor, options);
  assert.equal(reading.usable, true);
  assert.match(reading.detail, /sensor disconnected/);
  assert.doesNotMatch(reading.detail, /over 2 hours/);
  status.observations.indoor = temperature('mqtt-temperature', 21);
  status.observations.garage = temperature('mqtt-temperature', 16, { observedAt: now - 3 * 3_600_000 });
  const [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.state, 'Needs attention');
  assert.match(grouped.series[1].detail, /Using last known reading from 07:00.*over 2 hours old/);
});

test('temperature group retains outdoor fallback diagnostics without exposing unknown source data', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const status = { input: 'providers', observations: {
    indoor: temperature(secret), garage: temperature(secret, 16), outdoor: temperature('openmeteo', 4),
  }, providers: { outdoor: { status: 'fallback', source: 'openmeteo',
    acquisition: { primary: 'fmi', selected: 'openmeteo', attempts: [{ source: 'fmi', status: 'error', error: 'HTTP-429' }] },
    nextAttemptAt: now + 300_000, device: secret, body: secret } } };
  const [grouped] = dashboardProviders(status, options);
  assert.equal(grouped.display.title, 'Main temperatures & Weather · Open-Meteo');
  assert.equal(grouped.display.state, 'Using backup');
  assert.equal(grouped.backup, true);
  assert.match(grouped.display.detail, /FMI: rate limited \(HTTP 429\).*Next FMI try 10:05/);
  assert.match(grouped.series[2].detail, /FMI nearby station.*Open-Meteo.*backup/);
  assert.doesNotMatch(JSON.stringify(grouped), /private-secret|provider\.example|https:/);
});

test('offline and simulated dashboards do not invent live temperature providers', () => {
  for (const input of ['offline', 'simulated']) {
    assert.deepEqual(dashboardProviders({ input, providers: { temperatures: { status: 'disabled' } } }, options), []);
  }
});

test('H66 provider catalogue covers every decoded register without claiming tariff readback', () => {
  const series = providerSeries('h66');
  const decoded = Object.values(H66_REGISTERS).map(({ signal }) => signal === 'integral' ? 'heating_integral' : signal);
  assert.deepEqual(series.flatMap(row => row.signals).sort(), decoded.sort());
  assert.deepEqual(providerSeries('husdata-h66'), series);
  assert.ok(series.every(row => row.source === 'H66' && row.label && row.unit && row.detail));
  assert.match(series.find(row => row.signals.includes('tariff_reduction_setting')).detail,
    /does not confirm that tariff control is active/);
});

test('electricity groups only physical meters and keeps Tesla vehicle health separate',()=>{
  const entries=dashboardProviders({providers:{easee:{status:'ok',currentReadings:easeeReadings()},'shelly-evse':{status:'ok',reason:'physical-meter',...shellyReadings()},teslamate:{status:'ok',reason:'vehicle-observation'}}},options);
  const group=entries.find(row=>row.key==='electricity');
  assert.equal(group.source,'Easee, Shelly EVSE');assert.equal(group.display.state,'Available');
  const physical=providerSeries('shelly-evse');assert.deepEqual(physical.flatMap(row=>row.signals),shellySignals);
  assert.deepEqual(providerSeries('teslamate'),[]);
  assert.match(group.display.detail,/Physical charger meter/);
});
test('physical Charger 2 commissioning and unavailable telemetry remain visible',()=>{
  const providers={easee:{status:'ok',currentReadings:easeeReadings()},'shelly-evse':{status:'ok',reason:'physical-meter',...shellyReadings(),controlReady:false}};
  let group=dashboardProviders({providers},options).find(row=>row.key==='electricity');
  assert.equal(group.display.attention,false);assert.match(group.display.detail,/control requires supported live capabilities/);
  providers['shelly-evse']={status:'waiting',reason:'awaiting-mqtt'};group=dashboardProviders({providers},options).find(row=>row.key==='electricity');
  assert.equal(group.display.state,'Partly available');assert.match(group.display.detail,/physical Charger 2 MQTT/);
  providers['shelly-evse']={status:'disabled',reason:'not-enabled'};assert.equal(dashboardProviders({providers},options).find(row=>row.key==='electricity').display.state,'Available');
});
test('unknown physical EVSE diagnostics never expose raw payloads',()=>{
  for(const reason of ['synthetic-private-device','constructor','__proto__']) {
    const display=describeProvider('shelly-evse',{status:'degraded',reason},options);
    assert.equal(display.attention,true);assert.doesNotMatch(JSON.stringify(display),/synthetic-private|constructor|__proto__/);
  }
});

test('Shelly groups required native inputs into four electrical feeds', () => {
  const rows = providerSeries('shelly-evse');
  assert.equal(rows.length, 4);
  for (const field of ['current', 'voltage']) {
    const row = rows.find(row => row.signals.includes(`ev2_${field}_l1`));
    assert.deepEqual(row.signals, [1, 2, 3].map(phase => `ev2_${field}_l${phase}`));
    assert.equal(row.source, 'Shelly EVSE');
  }
  assert.match(rows.find(row => row.signals.includes('ev2_import_energy_counter')).detail, /without separate phase energy counters/);
  assert.doesNotMatch(JSON.stringify(rows), /TeslaMate|Phase distribution is not recorded/);
  const phases=rows.find(row=>row.signals.includes('ev2_energy_l1'));
  assert.equal(phases.source,'Calculated from Shelly EVSE');
  assert.match(phases.detail,/Estimated phase distribution/);
  assert.match(phases.detail,/sum to measured total consumption/);
  assert.deepEqual(rows.find(row => row.signals.includes('ev2_active_power')).signals,
    ['ev2_active_power', 'ev2_active_power_l1', 'ev2_active_power_l2', 'ev2_active_power_l3']);
  assert(!rows.some(row => row.signals.some(signal => /session/.test(signal))));
  assert(!rows.some(row=>row.signals.includes('ev2_energy')));
});

test('grouped Shelly feeds require their native recording inputs', () => {
  for (const signal of ['ev2_import_energy_counter', 'ev2_active_power_l2']) {
    const health = { status: 'ok', reason: 'physical-meter', ...shellyReadings() };
    delete health.readings[signal];
    const group = dashboardProviders({ providers: { 'shelly-evse': health } }, options)[0];
    assert.notEqual(group.datasets.find(row => row.signals.includes(signal)).state, 'Available');
    if (signal === 'ev2_active_power_l2')
      assert.notEqual(group.datasets.find(row => row.signals.includes('ev2_energy_l1')).state, 'Available');
    assert.notEqual(group.display.state, 'Available');
    health.readings[signal] = { value: 0, available: true, sourceTime: now - 60_001, quality: [] };
    assert.equal(dashboardProviders({ providers: { 'shelly-evse': health } }, options)[0].display.state,
      'Needs attention');
  }
});

test('Shelly phase availability follows each native reading and keeps inactive chargers inactive', () => {
  const health = { status: 'ok', reason: 'physical-meter', maxAgeMs: 60_000, readings: Object.fromEntries(
    [1, 2, 3].map(phase => [`ev2_current_l${phase}`, { value: 6, available: true, sourceTime: now, quality: [] }])) };
  const dataset = () => dashboardProviders({ providers: { 'shelly-evse': health } }, options)[0].datasets.find(row => row.signals[0] === 'ev2_current_l1');
  assert.equal(dataset().state, 'Available');
  delete health.readings.ev2_current_l3;
  assert.equal(dataset().state, 'Partly available');
  health.readings = {};
  assert.equal(dataset().state, 'Waiting for readings');
  health.readings.ev2_current_l1 = { value: 6, available: false, sourceTime: now, quality: ['retained'] };
  assert.equal(dataset().state, 'Waiting for readings');
  health.readings.ev2_current_l1 = { value: 6, available: true, sourceTime: now - 60_001, quality: [] };
  assert.equal(dataset().state, 'Needs attention', 'Cached available state cannot outlive the source measurement');
  health.readings.ev2_current_l1.sourceTime = now + 1;
  assert.equal(dataset().state, 'Needs attention');
  health.status = 'disabled';
  health.reason = 'not-enabled';
  assert.equal(dataset().state, 'Not enabled');
});

test('Shelly native freshness reaches the source summary while commissioning remains a separate warning', () => {
  const health = { status: 'ok', reason: 'physical-meter', ...shellyReadings() };
  const group = () => dashboardProviders({ providers: { 'shelly-evse': health } }, options)[0];
  assert.equal(group().display.state, 'Available');
  health.readings.ev2_current_l1.sourceTime = now - 60_001;
  assert.equal(group().display.state, 'Needs attention');
  assert.equal(group().sourceStates.find(row => row.label === 'Shelly EVSE').tone, 'attention');
  health.readings.ev2_current_l1.sourceTime = now;
  delete health.readings.ev2_voltage_l3;
  assert.equal(group().display.state, 'Partly available');
  Object.assign(health, shellyReadings(), { controlReady: false });
  const uncommissioned = group();
  assert.equal(uncommissioned.display.state, 'Available');
  assert.equal(uncommissioned.datasets.find(row => row.signals[0] === 'ev2_current_l1').state, 'Available');
  assert.equal(uncommissioned.datasets.find(row => row.signals[0] === 'ev2_energy_l1').state, 'Available');
  assert(uncommissioned.datasets.filter(row => row.signals[0].startsWith('ev2_')).every(row => row.state === 'Available'));
});

test('Easee provider catalogue includes acquired fields and one Charger 1 session check without a lifetime counter', () => {
  const series = providerSeries('easee');
  const signals = series.flatMap(row => row.signals);
  for (const [prefix, fields] of Object.entries(ELECTRICITY_FIELDS)) {
    for (const [, name] of fields) assert.ok(signals.includes(`${prefix}_${name}`), `${prefix}_${name}`);
    for (const phase of [1, 2, 3]) assert.ok(signals.includes(`${prefix}_energy_l${phase}`));
  }
  assert.ok(series.filter(row => row.signals.some(signal => signal.endsWith('_counter')))
    .every(row => /does not correct recorded energy or train/.test(row.detail)));
  assert.ok(series.filter(row => row.signals.some(signal => /_energy_l[123]$/.test(signal)))
    .every(row => row.source === 'Calculated from Easee cloud' && /derives power/.test(row.detail)));
  assert.match(series.find(row => row.signals.includes('ev1_voltage_l1')).detail, /verified phase mapping/);
  assert(!signals.includes('ev1_lifetime_energy_counter'));
  assert.deepEqual(series.filter(row=>row.signals.includes('ev1_session_energy_check')).map(row=>row.label),['Charger 1 session check']);
  assert(series.filter(row=>row.signals.some(signal=>signal.startsWith('ev1_'))).every(row=>row.label.startsWith('Charger 1')));
});

test('provider catalogue preserves market fallback and the separate weather solar source', () => {
  const market = providerSeries('market', { source: 'elering' });
  assert.equal(market[0].source, 'Elering');
  assert.match(market[0].detail, /excluding VAT.*ENTSO-E.*primary.*Elering.*backup/);
  assert.match(market[1].source, /^Calculated/);
  const weather = providerSeries('weather', { source: 'fmi', acquisition: { solarSource: 'openmeteo' } });
  assert.equal(weather[0].source, 'FMI');
  assert.equal(weather[1].source, 'Open-Meteo');
  assert.match(weather[1].detail, /earlier forecast publications, not measured sunshine/);
  assert.equal(providerSeries('weather', { acquisition: { selected: 'fmi', solarSource: 'mixed' } })[1].source,
    'FMI + Open-Meteo');
  assert.match(providerSeries('outdoor', { source: 'openmeteo' })[0].detail, /FMI nearby station.*Open-Meteo.*backup/);
});

test('temperature catalogue distinguishes the optional adapter and MQTT sensor history from live outdoor selection', () => {
  assert.equal(providerSeries('temperatures')[0].source, 'Configured temperature adapter');
  const mqtt = providerSeries('mqtt-temperature');
  assert.equal(mqtt[0].source, 'MQTT');
  assert.deepEqual(mqtt.flatMap(row => row.signals), ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature']);
  assert.match(mqtt.find(row => row.signals.includes('outdoor_temperature')).detail,
    /recorded for history.*Live outdoor control selects FMI or Open-Meteo/);
});

test('indoor provider rows show the three physical sensors separately from their model average', () => {
  const status = { input: 'providers', observations: {
    indoor: temperature('indoor-average', 21), upstairs: temperature('mqtt-temperature', 22),
    downstairs: temperature('mqtt-temperature', 20), bedroom: temperature('mqtt-temperature', 21),
    outdoor: temperature('fmi', 4),
  }, providers: { temperatures: { source: 'mqtt-temperature', status: 'ok', lastSuccessAt: now } } };
  const [grouped] = dashboardProviders(status, options);
  assert.deepEqual(grouped.series.map(row => row.label), ['Upstairs', 'Downstairs', 'Bedroom', 'Garage rear temperature', 'Outdoor temperature']);
  assert.deepEqual(grouped.series.flatMap(row => row.signals), ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature']);
  assert.equal(grouped.display.title, 'Main temperatures & Weather · MQTT, FMI');
  assert.ok(grouped.series.slice(0, 3).every(row => row.source === 'MQTT'));
  assert.equal(grouped.display.state, 'Available');
  assert.match(grouped.series[0].detail, /recorded separately/);
  status.providers.temperatures.error = 'HTTP-401';
  assert.equal(dashboardProviders(status, options)[0].display.state, 'Needs attention', 'composite source must not hide failures affecting its sensors');
});

test('catalogue rejects unknown names and never includes provider bodies or identifiers', () => {
  const untrusted = 'https://provider.example/?token=private-secret';
  const health = { source: untrusted, device: untrusted, body: untrusted,
    acquisition: { selected: untrusted, primary: untrusted, solarSource: untrusted } };
  for (const job of ['market', 'weather', 'outdoor', 'easee', 'h66', 'temperatures', 'mqtt-temperature', untrusted,
    'constructor', '__proto__']) {
    assert.doesNotMatch(JSON.stringify(providerSeries(job, health)), /private-secret|provider\.example|https:|constructor|__proto__/);
  }
  assert.deepEqual(providerSeries(untrusted, health), []);
  for (const job of ['market', 'weather', 'outdoor', 'temperatures']) {
    assert.doesNotThrow(() => providerSeries(job, null));
  }
});

test('healthy backup is named and its primary retry respects both cooldown and polling schedule', () => {
  const health = { status: 'fallback', source: 'elering', lastSuccessAt: now, nextAttemptAt: now + 3_600_000,
    acquisition: { primary: 'entsoe', selected: 'elering', fallbackUsed: true,
      attempts: [{ source: 'entsoe', status: 'error', error: 'HTTP-429' }, { source: 'elering', status: 'ok' }] },
    sourceBackoff: { entsoe: { nextAttemptAt: now + 1_800_000, error: 'HTTP-429' } } };
  let result = describeProvider('market', health, options);
  assert.equal(result.title, 'Electricity market · Elering');
  assert.equal(result.state, 'Using backup');
  assert.equal(result.attention, false);
  assert.match(result.detail, /ENTSO-E: rate limited \(HTTP 429\)/);
  assert.match(result.detail, /Next ENTSO-E try 11:00/);
  health.sourceBackoff.entsoe.nextAttemptAt = now + 7_200_000;
  result = describeProvider('market', health, options);
  assert.match(result.detail, /Next ENTSO-E try 12:00/);
});

test('weather card descriptions distinguish nearby station and model estimate', () => {
  const common = { status: 'ok', lastSuccessAt: now };
  assert.equal(outdoorSourceLabel('fmi'), 'FMI nearby station');
  assert.equal(outdoorSourceLabel('openmeteo'), 'Open-Meteo model estimate');
  assert.match(describeProvider('outdoor', { ...common, source: 'fmi' }, options).detail, /Observed at a nearby weather station/);
  const modeled = describeProvider('outdoor', { ...common, source: 'openmeteo' }, options);
  assert.equal(modeled.title, 'Outdoor temperature · Open-Meteo');
  assert.match(modeled.detail, /Model estimate for the area/);
  assert.doesNotMatch(modeled.detail, /Observed|Measured/);
  assert.equal(describeProvider('weather', { ...common, source: 'fmi' }, options).title, 'Weather forecast · FMI');
  assert.equal(describeProvider('weather', { ...common, source: 'openmeteo' }, options).title, 'Weather forecast · Open-Meteo');
});

test('missing primary configuration does not advertise a retry and both failed providers stay visible', () => {
  const health = { status: 'fallback', source: 'elering', nextAttemptAt: now + 3_600_000,
    acquisition: { primary: 'entsoe', selected: 'elering', attempts: [{ source: 'entsoe', status: 'not-configured' }] } };
  assert.doesNotMatch(describeProvider('market', health, options).detail, /Next .*try/);
  health.status = 'error'; health.error = 'HTTP-503';
  health.acquisition.attempts = [{ source: 'entsoe', status: 'error', error: 'HTTP-401' }, { source: 'elering', status: 'error', error: 'HTTP-503' }];
  const result = describeProvider('market', health, options);
  assert.equal(result.state, 'Needs attention');
  assert.equal(result.attention, true);
  assert.match(result.detail, /ENTSO-E: access denied \(HTTP 401\)/);
  assert.match(result.detail, /Elering: download failed \(HTTP 503\)/);
});

test('mixed weather fallback identifies the solar provider while keeping FMI temperature', () => {
  const common = { status: 'fallback', source: 'fmi', lastSuccessAt: now,
    acquisition: { primary: 'fmi', selected: 'fmi', solarSource: 'openmeteo', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: 'incomplete' }, { source: 'openmeteo', status: 'ok' }] } };
  const result = describeProvider('weather', common, options);
  assert.equal(result.title, 'Weather forecast · FMI');
  assert.equal(result.state, 'Using backup');
  assert.match(result.detail, /Solar radiation uses the Open-Meteo forecast/);
  assert.match(result.detail, /temperature or solar forecast coverage is incomplete/);
  assert.doesNotMatch(result.detail, /price coverage/);
  common.acquisition.solarSource = 'mixed';
  assert.match(describeProvider('weather', common, options).detail, /FMI with Open-Meteo forecasts filling missing intervals/);
});

test('unknown source names, codes and provider response text cannot expose URLs or secrets in the UI', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const result = describeProvider(secret, { status: secret, source: secret, error: secret,
    acquisition: { primary: 'fmi', selected: secret, attempts: [{ source: 'fmi', status: 'error', error: secret }] } }, options);
  assert.equal(providerName(secret), null);
  assert.equal(outdoorSourceLabel(secret), null);
  assert.equal(result.title, 'Data provider');
  assert.equal(result.state, 'Status pending');
  assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:/);
  assert.match(result.detail, /FMI: download failed/);
});

test('waiting providers show their scheduled download and distinguish a due request', () => {
  const health = { status: 'waiting', lastSuccessAt: now - 3_600_000, nextAttemptAt: now + 300_000 };
  const result = describeProvider('temperatures', health, options);
  assert.equal(result.state, 'Waiting');
  assert.match(result.detail, /Last successful download 09:00/);
  assert.match(result.detail, /Next download 10:05/);
  assert.equal(result.attention, false);
  health.nextAttemptAt = now;
  assert.match(describeProvider('temperatures', health, options).detail, /Download is due/);
});

test('Easee describes old readings without reporting different measurement times', () => {
  const result = describeProvider('easee', { status: 'degraded', lastSuccessAt: now, error: null,
    nextAttemptAt: now + 300_000, currentReadings: { property: { qualityIssues: ['property_stale', 'asynchronous_snapshot'] } } }, options);
  assert.equal(result.state, 'Needs attention');
  assert.equal(result.attention, true);
  assert.match(result.detail, /Last successful download 10:00/);
  assert.match(result.detail, /Property current readings have old source timestamps/);
  assert.doesNotMatch(result.detail, /measured at different times|asynchronous/);
  assert.doesNotMatch(result.detail, /download failed|No successful download|Next try/);
});

test('Easee names stream and REST acquisition without warning on working backup', () => {
  for (const [state, transport, detail] of [
    ['connected', 'stream', /Last acquisition used the live stream\./],
    ['retrying', 'rest', /Live stream reconnecting\. Last acquisition used REST backup\./],
    ['connected', 'mixed', /Last acquisition combined live stream readings and REST backup\./],
  ]) {
    const health = { status: 'ok', lastSuccessAt: now, currentReadings: easeeReadings(), transport,
      stream: { state, connected: state === 'connected' } };
    const display = describeProvider('easee', health, options);
    assert.equal(display.state, 'Available');
    assert.equal(display.attention, false);
    assert.match(display.detail, /Last successful acquisition 10:00\./);
    assert.match(display.detail, detail);
    const [group] = dashboardProviders({ providers: { easee: health } }, options);
    assert.equal(group.display.state, 'Available');
    assert.equal(group.sourceStates[0].tone, 'available');
    assert.match(group.display.detail, detail);
  }
});

test('Easee stream connectivity does not hide stale property readings or failed backup', () => {
  for (const transport of ['stream', 'rest', 'mixed']) {
    const stale = describeProvider('easee', { status: 'degraded', lastSuccessAt: now,
      transport, stream: { state: 'connected', connected: true }, currentReadings: { property: { qualityIssues: ['property_stale'] } },
      staleSourceTimes: { property_stale: now - 3_600_000 } }, options);
    assert.equal(stale.attention, true);
    assert.equal(stale.state, 'Needs attention');
    assert.match(stale.detail, /Property current readings: oldest source reading is 1 h old/);
  }
  const failed = describeProvider('easee', { status: 'error', lastSuccessAt: now - 60_000,
    transport: 'rest', stream: { state: 'retrying', connected: false }, error: 'HTTP-429',
    nextAttemptAt: now + 300_000 }, options);
  assert.equal(failed.attention, true);
  assert.match(failed.detail, /Rate limited \(HTTP 429\)/);
  assert.match(failed.detail, /Next try 10:05/);
});

test('Easee stream lifecycle and transport metadata only produce known display text', () => {
  const secret = 'https://provider.example/?token=private-secret';
  for (const [state, detail] of [
    ['idle', 'Live stream has not started.'], ['connecting', 'Connecting to the live stream.'],
    ['subscribing', 'Live stream connected; preparing readings.'], ['closed', 'Live stream stopped.'],
  ]) {
    const display = describeProvider('easee', { status: 'waiting', transport: secret,
      stream: { state, error: secret, products: secret, retryAt: secret } }, options);
    assert.equal(display.attention, false);
    assert.match(display.detail, /No successful acquisition recorded/);
    assert(display.detail.includes(detail));
    assert.doesNotMatch(JSON.stringify(display), /private-secret|provider\.example|https:/);
  }
  for (const state of [secret, 'constructor', '__proto__', {}, null]) {
    const display = describeProvider('easee', { status: 'ok', lastSuccessAt: now, currentReadings: easeeReadings(),
      stream: { state, connected: true }, transport: secret }, options);
    assert.equal(display.detail, 'Last successful download 10:00.');
  }
});

test('Easee ignores timestamp mismatch and charger age in cached degraded statuses', () => {
  for (const qualityIssues of [['asynchronous_snapshot'], ['charger_stale'], ['charger_stale', 'asynchronous_snapshot']]) {
    for (const status of ['ok', 'degraded']) {
      const display = describeProvider('easee', { status, currentReadings: { charger: { qualityIssues } }, error: null, failures: 1 }, options);
      assert.equal(display.state, 'Available');
      assert.equal(display.attention, false);
      assert.doesNotMatch(display.detail, /measured at different times|asynchronous/);
    }
  }
});

test('Easee shares its last complete download while naming affected readings in issues and retry', () => {
  const display = describeProvider('easee', { status: 'degraded', error: 'HTTP-429', nextAttemptAt: now + 300_000,
    lastSuccessAt: now - 3_600_000,
    currentReadings: {
      charger: { qualityIssues: ['missing', 'invalid_unit'], error: 'HTTP-429', lastSuccessAt: now - 3_600_000 },
      property: { qualityIssues: ['negative_current', 'source_time_unknown'], error: null, lastSuccessAt: now },
    } }, options);
  assert.equal(display.attention, true);
  const [download, ...issues] = display.detail.split(/\.\s*/).filter(Boolean);
  assert.equal(download, 'Last successful download 09:00');
  for (const sentence of issues) {
    assert.match(sentence, /Charger|Property|property/, sentence);
  }
  assert.equal(display.detail.match(/successful download/g).length, 1);
  assert.match(display.detail, /Charger 1 readings: Some current readings are missing\./);
  assert.match(display.detail, /Charger 1 readings: Some readings have unsupported units\./);
  assert.match(display.detail, /Property readings: Some current readings are negative\./);
  assert.match(display.detail, /Property readings: Some readings have no source timestamp\./);
  assert.match(display.detail, /Charger 1 readings: Rate limited \(HTTP 429\)\./);
  assert.doesNotMatch(display.detail, /Property readings: (Rate limited|Download failed)/);
  assert.match(display.detail, /Charger 1 and property readings: Next try 10:05\./);
});

test('scoped charger age stays informational and scopes all other current notes', () => {
  const informational = { status: 'degraded', qualityIssues: ['charger_stale', 'asynchronous_snapshot'],
    staleSourceTimes: { charger_stale: now - 90 * 60_000 },
    currentReadings: { charger: { qualityIssues: ['charger_stale', 'asynchronous_snapshot'], error: null, lastSuccessAt: now } } };
  const display = describeProvider('easee', informational, options);
  assert.equal(display.state, 'Available');
  assert.equal(display.attention, false);
  assert.match(display.detail, /Charger 1 current readings: oldest source reading is 1 h 30 min old\. Attention threshold 30 min/);
  assert.doesNotMatch(display.detail, /[Pp]roperty|different times|asynchronous/);
  for (const key of ['charger', 'property']) {
    for (const flag of ['future_source_time', 'source_time_unknown', 'implausible_current', 'negative_current',
      'invalid_numeric', 'invalid_unit', 'conflicting_duplicate', 'missing', 'provider_error', 'missing_configuration']) {
      const result = describeProvider('easee', { status: 'degraded',
        currentReadings: { [key]: { qualityIssues: [flag], error: null, lastSuccessAt: null } } }, options);
      const subject = key === 'charger' ? 'Charger 1' : 'Property';
      assert.equal(result.attention, true, flag);
      const [download, ...issues] = result.detail.split(/\.\s*/).filter(Boolean);
      assert.equal(download, 'No successful download recorded');
      for (const sentence of issues) assert.ok(sentence.startsWith(subject), sentence);
    }
  }
});

test('Easee waiting, unknown errors and untrusted scope fields produce only named safe sentences', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const health = { status: 'waiting', nextAttemptAt: now + 300_000,
    currentReadings: { property: { qualityIssues: [], error: null, lastSuccessAt: null } } };
  assert.equal(describeProvider('easee', health, options).detail,
    'No successful download recorded. Property readings: Next download 10:05.');
  health.currentReadings.property = { qualityIssues: [secret, 'asynchronous_snapshot', 'constructor'], error: secret, lastSuccessAt: secret };
  health.currentReadings[secret] = { qualityIssues: ['missing'], error: secret };
  const display = describeProvider('easee', health, options);
  assert.match(display.detail, /Property readings: Download failed\./);
  assert.doesNotMatch(JSON.stringify(display), /private-secret|provider\.example|https:|constructor|different times/);
});

test('cached request failures do not present generated empty fields as defective device readings', () => {
  const display = describeProvider('easee', { status: 'degraded', error: 'provider-network-error',
    currentReadings: { property: { qualityIssues: ['provider_error', 'missing', 'source_time_unknown'],
      error: 'provider-network-error', lastSuccessAt: now - 60_000 } } }, options);
  assert.equal(display.attention, true);
  assert.match(display.detail, /Property readings: Network request failed\./);
  assert.doesNotMatch(display.detail, /missing|no source timestamp/);
});

test('Easee download sentence is shared across healthy and partially successful current snapshots', () => {
  for (const health of [
    { lastSuccessAt: now, currentReadings: {
      charger: { lastSuccessAt: now, qualityIssues: [] }, property: { lastSuccessAt: now, qualityIssues: [] },
    } },
    { lastSuccessAt: now, currentReadings: { charger: { lastSuccessAt: now, qualityIssues: [] } } },
  ]) {
    assert.equal(describeProvider('easee', { status: 'ok', ...health }, options).detail,
      'Last successful download 10:00.');
  }
  const partial = describeProvider('easee', { status: 'degraded', lastSuccessAt: null,
    currentReadings: {
      charger: { lastSuccessAt: now, qualityIssues: [] },
      property: { lastSuccessAt: null, qualityIssues: [], error: 'HTTP-503' },
    } }, options);
  assert.equal(partial.detail, 'No successful download recorded. Property readings: Download failed (HTTP 503).');
});

test('download errors retain retry details alongside existing reading quality warnings', () => {
  const result = describeProvider('easee', { status: 'error', lastSuccessAt: now - 3_600_000,
    error: 'HTTP-429', nextAttemptAt: now + 300_000, currentReadings: { property: { qualityIssues: ['property_stale'], error: 'HTTP-429' } } }, options);
  assert.equal(result.attention, true);
  assert.match(result.detail, /Property current readings have old source timestamps/);
  assert.match(result.detail, /Rate limited \(HTTP 429\)/);
  assert.match(result.detail, /Next try 10:05/);
  assert.doesNotMatch(result.detail, /Next download/);
});

test('Easee identifies old charger and property timestamps and only property staleness needs attention', () => {
  for (const [qualityIssues, status, charger, property] of [
    [['charger_stale'], 'ok', true, false],
    [['property_stale'], 'degraded', false, true],
    [['charger_stale', 'property_stale'], 'degraded', true, true],
    [[], 'ok', false, false],
  ]) {
    const result = describeProvider('easee', { status, lastSuccessAt: now, currentReadings: {
      charger: { qualityIssues: qualityIssues.filter(flag => flag === 'charger_stale') },
      property: { qualityIssues: qualityIssues.filter(flag => flag === 'property_stale') },
    } }, options);
    assert.equal(result.state, property ? 'Needs attention' : 'Available');
    assert.equal(result.attention, property);
    assert.equal(result.detail.includes('Charger 1 current readings have old source timestamps.'), charger);
    assert.equal(result.detail.includes('Property current readings have old source timestamps.'), property);
    assert.doesNotMatch(result.detail, /Some readings have old source timestamps/);
  }
});

test('informational charger timestamps do not hide other Easee problems', () => {
  for (const health of [
    { status: 'degraded', qualityIssues: ['charger_stale', 'implausible_current'] },
    { status: 'error', qualityIssues: ['charger_stale'], error: 'HTTP-503' },
  ]) {
    const result = describeProvider('easee', { lastSuccessAt: now, ...health, currentReadings: { charger: { qualityIssues: health.qualityIssues, error: health.error } } }, options);
    assert.equal(result.state, 'Needs attention');
    assert.equal(result.attention, true);
    assert.match(result.detail, /Charger 1 current readings have old source timestamps/);
    assert.match(result.detail, /implausible|Download failed/);
  }
});

test('source ages show elapsed time and the separate attention threshold for each device', () => {
  for (const [minutes, age] of [[30, '30 min'], [59.99, '1 h'], [60, '1 h'],
    [89.99, '1 h 30 min'], [90, '1 h 30 min'], [119.99, '2 h'], [120, '2 h'], [150, '2 h 30 min']]) {
    const result = describeProvider('easee', { status: 'degraded', lastSuccessAt: now,
      currentReadings: { charger: { qualityIssues: ['charger_stale'] }, property: { qualityIssues: ['property_stale'] } },
      staleSourceTimes: { charger_stale: now - 48 * 3_600_000, property_stale: now - minutes * 60_000 } }, options);
    assert.ok(result.detail.includes(`Property current readings: oldest source reading is ${age} old.`), result.detail);
    assert.match(result.detail, /Charger 1 current readings: oldest source reading is 2 d old\./);
    assert.match(result.detail, /Attention threshold 30 min/);
    assert.equal(result.attention, true);
  }
  const health = { status: 'degraded', qualityIssues: ['stale'], staleSourceTimes: { stale: now - 135 * 60_000 } };
  assert.match(describeProvider('temperatures', health, options).detail, /2 h 15 min old.*Attention threshold 2 h/);
  assert.match(describeProvider('temperatures', health, { ...options, now: now + 30 * 60_000 }).detail, /2 h 45 min old.*Attention threshold 2 h/);
});

test('missing or invalid age metadata keeps current scoped warnings without displaying provider text', () => {
  for (const at of [undefined, null, NaN, Infinity, -1, 0, now + 60_000, String(now - 3_600_000),
    'https://provider.example/?token=private-secret', { value: now - 3_600_000 }]) {
    const result = describeProvider('easee', { status: 'ok', currentReadings: { charger: { qualityIssues: ['charger_stale'] } },
      staleSourceTimes: { charger_stale: at } }, options);
    assert.match(result.detail, /Charger 1 current readings have old source timestamps\./);
    assert.equal(result.attention, false);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:|NaN|Infinity/);
  }
});

test('quality messages are deduplicated and unknown provider text is never displayed', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const health = { status: 'degraded', lastSuccessAt: now,
    qualityIssues: ['implausible_temperature', 'suspect_zero_indoor', 'implausible_temperature',
      secret, 'constructor', '__proto__', { code: secret }] };
  const result = describeProvider('temperatures', health, options);
  assert.equal(result.detail.match(/Some temperature readings are implausible\./g).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:|constructor|__proto__/);
  health.qualityIssues = secret;
  assert.doesNotMatch(describeProvider('temperatures', health, options).detail, /private-secret/);
});
test('periodic temperature status distinguishes current coverage from an old unchanged value', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const options = { now, formatTime: at => new Date(at).toISOString().slice(11, 16) };
  const reading = { source: 'mqtt-temperature', value: 21, observedAt: now - 24 * 3_600_000,
    periodicReports: true, reportExpiresAt: now + 2 * 60_000, stale: false };
  const current = temperatureReadingStatus(reading, options);
  assert.equal(current.usable, true);
  assert.equal(current.attention, false);
  assert.match(current.detail, /reports current/);
  const missing = temperatureReadingStatus({ ...reading, stale: true, needsAttention: true,
    attentionReasons: ['missing-report'] }, options);
  assert.equal(missing.usable, false);
  assert.match(missing.detail, /Expected temperature report missing/);
});

test('provider names and entry bullets retain individual availability in a mixed group', () => {
  const [group] = dashboardProviders({ providers: {
    easee: { status: 'error', error: 'HTTP-503', currentReadings: {
      property: { qualityIssues: [], error: null }, charger: { qualityIssues: ['provider_error'], error: 'HTTP-503' },
    } }, 'shelly-evse': { status: 'ok', reason: 'physical-meter', ...shellyReadings() },
  } }, options);
  assert.deepEqual(group.sourceStates.map(({ label, tone }) => ({ label, tone })), [
    { label: 'Easee', tone: 'attention' }, { label: 'Shelly EVSE', tone: 'available' },
  ]);
  for (const row of group.series) assert.equal(row.tone, row.signals[0].startsWith('ev1_') ? 'attention' : 'available');
});

test('each physical temperature uses its reading availability rather than the grouped source status', () => {
  const [group] = dashboardProviders({ input: 'mqtt', observations: {
    indoor: { value: 21, observedAt: now }, upstairs: { value: 21, observedAt: now, source: 'mqtt-temperature' },
    bedroom: { value: 20, observedAt: now, source: 'mqtt-temperature', needsAttention: true },
    outdoor: { value: 10, observedAt: now, source: 'fmi' }, garage: { configured: false },
  } }, options);
  assert.deepEqual(group.sourceStates.map(row => row.tone), ['attention', 'available']);
  assert.equal(group.series.find(row => row.signals[0] === 'indoor_temperature').tone, 'available');
  assert.equal(group.series.find(row => row.signals[0] === 'bedroom_temperature').tone, 'attention');
  assert.equal(group.series.find(row => row.signals[0] === 'garage_temperature').tone, 'pending');
});

test('expanded market datasets distinguish contract readiness from successful market downloads', () => {
  for (const [priceStatus, state, tone] of [
    ['contract-not-configured', 'Not configured', 'pending'],
    ['no-contract-coverage', 'Unavailable', 'attention'],
    ['partial-contract-coverage', 'Partial coverage', 'attention'],
  ]) {
    const [group] = dashboardProviders({ priceStatus, providers: { market: { status: 'ok', source: 'entsoe' } } }, options);
    assert.equal(group.display.state, 'Available');
    assert.equal(group.series[1].state, 'Available');
    assert.equal(group.datasets[0].state, 'Available');
    assert.equal(group.datasets[1].state, state);
    assert.equal(group.datasets[1].tone, tone);
    assert.match(group.datasets[1].statusDetail, /contract/);
  }
  for (const priceStatus of ['stale-market-data', 'incomplete-market-coverage']) {
    const [group] = dashboardProviders({ priceStatus, providers: { market: { status: 'ok' } } }, options);
    assert.ok(group.datasets.every(row => row.tone === 'attention'));
  }
});

test('expanded weather datasets distinguish primary temperatures from backup radiation', () => {
  const [group] = dashboardProviders({ weatherStatus: 'available', forecast: [
    { start: now, end: now + 3_600_000, outdoorC: 12, solarRadiationWm2: 120, source: 'fmi', solar: { source: 'openmeteo' } },
  ], providers: { weather: { status: 'fallback', source: 'fmi', acquisition: { solarSource: 'openmeteo', fallbackUsed: true } } } }, options);
  assert.equal(group.display.state, 'Using backup');
  assert.equal(group.series[0].state, 'Using backup');
  assert.equal(group.datasets[0].state, 'Available');
  assert.equal(group.datasets[0].tone, 'available');
  assert.equal(group.datasets[0].statusDetail, undefined);
  assert.equal(group.datasets[1].state, 'Using backup');
  assert.equal(group.datasets[1].source, 'Open-Meteo');
  assert.match(group.datasets[1].statusDetail, /solar radiation.*Open-Meteo/);
});

test('missing radiation cannot inherit available temperature status and zero radiation remains valid', () => {
  const status = { weatherStatus: 'available', forecast: [
    { start: now, end: now + 3_600_000, outdoorC: 12, solarRadiationWm2: null, source: 'fmi' },
  ], providers: { weather: { status: 'ok', source: 'fmi' } } };
  let [group] = dashboardProviders(status, options);
  assert.equal(group.datasets[0].state, 'Available');
  assert.equal(group.datasets[1].state, 'Unavailable');
  assert.equal(group.datasets[1].tone, 'attention');
  assert.match(group.datasets[1].statusDetail, /no usable solar radiation/);
  status.forecast[0].solarRadiationWm2 = 0;
  status.providers.weather.acquisition = { solarSource: 'fmi' };
  [group] = dashboardProviders(status, options);
  assert.ok(group.datasets.every(row => row.state === 'Available'));
  status.forecast.push({ start: now + 3_600_000, end: now + 7_200_000, outdoorC: 13, solarRadiationWm2: null, source: 'fmi' });
  [group] = dashboardProviders(status, options);
  assert.equal(group.datasets[0].state, 'Available');
  assert.equal(group.datasets[1].state, 'Partial coverage');
});

test('expanded forecast rows do not label expired or failed data available', () => {
  const status = { weatherStatus: 'stale-forecast', forecast: [], providers: { weather: { status: 'ok', source: 'fmi' } } };
  assert.ok(dashboardProviders(status, options)[0].datasets.every(row => row.tone === 'attention'));
  status.weatherStatus = 'available';
  status.forecast = [{ start: now, end: now + 3_600_000, outdoorC: 12, solarRadiationWm2: 0, source: 'fmi' }];
  status.providers.weather = { status: 'error', error: 'HTTP-503', source: 'fmi' };
  assert.ok(dashboardProviders(status, options)[0].datasets.every(row => row.tone === 'attention'));
});

test('expanded temperature datasets include configured garage front with its own reading status', () => {
  const status = { input: 'mqtt', observations: {
    indoor: temperature('mqtt-temperature'), garage: temperature('mqtt-temperature', 16), outdoor: temperature('husdata-h66', 4),
  }, sensorChanges: { sensors: [{ signal: 'garage_temperature_2', configured: true }] } };
  const [initial] = dashboardProviders(status, options);
  let front = initial.datasets.find(row => row.signals[0] === 'garage_temperature_2');
  assert.equal(front.state, 'Waiting for readings');
  status.observations.garageFront = temperature('mqtt-equipment', 15, { periodicReports: true,
    reportExpiresAt: now - 1, stale: true, needsAttention: true, attentionReasons: ['missing-report'] });
  const [group] = dashboardProviders(status, options);
  front = group.datasets.find(row => row.signals[0] === 'garage_temperature_2');
  assert.equal(front.tone, 'attention');
  assert.equal(front.value, 'Unavailable');
  assert.equal(front.source, 'MQTT');
  assert.match(front.detail, /Expected temperature report missing/);
  assert.equal(initial.display.state, 'Available');
  assert.equal(group.display.state, 'Needs attention');
  assert.equal(group.display.attention, true);
  assert.deepEqual(group.series, initial.series);
  assert.deepEqual(group.datasets.flatMap(row => row.signals), ['indoor_temperature', 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature']);
});

test('garage front is not invented for sparse observations and valid held readings remain visible', () => {
  const status = { input: 'mqtt', observations: { indoor: temperature('mqtt-temperature'), outdoor: temperature('husdata-h66', 4) } };
  assert.ok(!dashboardProviders(status, options)[0].datasets.some(row => row.signals.includes('garage_temperature_2')));
  status.observations.garageFront = temperature('mqtt-temperature', 15, { held: true, observedAt: now - 3 * 3_600_000 });
  const front = dashboardProviders(status, options)[0].datasets.find(row => row.signals[0] === 'garage_temperature_2');
  assert.equal(front.tone, 'attention');
  assert.equal(front.value, '15.0 °C');
  assert.match(front.detail, /Using last known reading/);
});

test('retired unscoped Easee health and lastSuccess fields do not become current device status', () => {
  const display = describeProvider('easee', { status: 'ok', lastSuccess: now, qualityIssues: ['stale', 'property_stale'] }, options);
  assert.equal(display.state, 'Waiting for readings');
  assert.equal(display.detail, 'No successful download recorded. Current device reading status is unavailable.');
  assert.doesNotMatch(display.detail, /old source|Property current|Charger 1 current/);
});

test('Data and settings propagates the actual local/cloud source for each electrical device', () => {
  const group = dashboardProviders({ providers: { easee: { status: 'ok', currentReadings: easeeReadings(),
    deviceTransports: { charger: 'ocpp', property: 'stream' }, localOcpp: { configured: true, connected: true, available: true } } } }, options)
    .find(row => row.key === 'electricity');
  const rows = new Map(group.series.map(row => [row.signals[0], row]));
  assert.equal(rows.get('ev1_active_power').source, 'Easee local OCPP');
  assert.equal(rows.get('property_active_power').source, 'Easee cloud');
  assert.equal(rows.get('ev1_energy_l1').source, 'Calculated from Easee local OCPP');
  assert.match(rows.get('ev1_voltage_l1').detail, /phase-to-neutral/);
  assert.match(group.localConnection.detail, /OCPP handles charging authorization and schedules locally/);
  assert.doesNotMatch(group.localConnection.detail, /property|ST-MQ/);
});

test('automatic charger setup remains visible independently of working cloud readings', () => {
  const easee = { status: 'ok', currentReadings: easeeReadings(),
    localOcpp: { configured: true, connected: false, available: false,
      setup: { state: 'retrying', endpointSource: 'pair-vip', nextAttemptAt: now + 60_000 } } };
  const group = dashboardProviders({ providers: { easee } }, options).find(row => row.key === 'electricity');
  assert.equal(group.display.state, 'Available', 'A cloud setup failure does not invalidate usable electricity readings');
  assert.equal(group.localConnection.setup.tone, 'attention');
  assert.equal(group.localConnection.setup.label, 'Retrying setup');
  assert.match(group.localConnection.setup.detail, /retry automatically.*Next setup attempt 10:01/);
  assert.equal(group.localConnection.endpoint, 'Paired virtual address');
  assert.match(group.localConnection.detail, /other computer must be ready/);
  assert.equal(group.localConnection.readings.label, 'Waiting for connection');
  assert.match(group.localConnection.readings.detail, /cloud readings remain the backup/);
  assert.match(group.display.detail, /Charger setup: Retrying setup/);
});

test('completed setup does not imply complete fresh local measurements', () => {
  const localOcpp = { configured: true, connected: true, available: false,
    setup: { state: 'ready', endpointSource: 'configured' }, pendingConfiguration: ['MeterValuesSampledData'] };
  let display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.equal(display.setup.label, 'Setup complete');
  assert.match(display.outage, /shutdown, restart and paired handover keep local OCPP enabled/);
  assert.match(display.outage, /offline.*wait for authorization.*Restart the controller or explicitly disable Direct OCPP/);
  assert.match(display.outage, /expired pause does not restore cloud authorization/);
  assert.equal(display.readings.label, 'Waiting for readings');
  assert.match(display.readings.detail, /acknowledge measurement settings/);
  assert.equal(display.endpoint, 'Configured standalone address');
  localOcpp.available = true;
  localOcpp.pendingConfiguration = [];
  display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.equal(display.readings.label, 'Available');
  assert.equal(display.readings.tone, 'available');
  localOcpp.configurationFailures = ['MeterValuesAlignedData'];
  display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.equal(display.setup.label, 'Setup complete');
  assert.equal(display.readings.tone, 'attention');
  assert.match(display.readings.detail, /did not accept all measurement settings/);
});

test('completed charger setup schedules a connection check without implying another setup attempt', () => {
  const display = easeeLocalConnectionDisplay({ localOcpp: { available: true,
    setup: { state: 'ready', endpointSource: 'configured', nextAttemptAt: now + 60_000 } } }, options);
  assert.match(display.setup.detail, /Next connection check 10:01/);
  assert.doesNotMatch(JSON.stringify(display), /Next setup attempt|property readings|ST-MQ/);
});

test('connection recovery shows its own wait and stops promising retries after the bounded attempts', () => {
  const localOcpp = { configured: true, connected: false, available: false, setup: {
    state: 'connecting', reason: 'waiting-connection', nextAttemptAt: now + 60_000,
    recovery: { attempts: 1, nextAttemptAt: now + 15 * 60_000, exhausted: false },
  } };
  let display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.match(display.setup.detail, /Connection recovery no earlier than 10:15/);
  assert.doesNotMatch(display.setup.detail, /Next setup attempt/);
  Object.assign(localOcpp.setup, { state: 'retrying', reason: 'cloud-unavailable',
    recovery: { attempts: 3, nextAttemptAt: null, exhausted: true } });
  display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.equal(display.setup.label, 'Connection needs attention');
  assert.equal(display.setup.tone, 'attention');
  assert.match(display.setup.detail, /three-attempt limit.*Local OCPP remains enabled/);
  assert.doesNotMatch(display.setup.detail, /retry automatically|Next setup attempt|ST-MQ/);
  localOcpp.setup = { state: 'recovering', reason: 'reapplying-connection' };
  display = easeeLocalConnectionDisplay({ localOcpp }, options);
  assert.equal(display.setup.label, 'Recovering connection');
  assert.match(display.setup.detail, /same verified.*charging instructions are preserved/);
});

test('local setup readiness diagnostics distinguish storage and authorization from network failures', () => {
  for (const [reason, detail] of [
    ['listener-not-ready', /Waiting for local readiness checks/],
    ['transaction-state-unavailable', /transaction storage is unavailable/],
    ['incompatible-transaction-state', /transaction state does not match/],
    ['authorization-unavailable', /charging authorization is not ready/],
  ]) {
    const display = easeeLocalConnectionDisplay({ localOcpp: {
      setup: { state: 'waiting-listener', reason },
    } }, options);
    assert.match(display.setup.detail, detail);
    assert.doesNotMatch(display.setup.detail, /network port|cannot accept/);
  }
});

test('disabled local OCPP does not claim cloud availability during an independent cloud outage', () => {
  const display = easeeLocalConnectionDisplay({ status: 'failed', localOcpp: { connected: false,
    available: false, setup: { state: 'disabled' } } }, options);
  assert.match(display.readings.detail, /Cloud readings use their own connection and availability checks/);
  assert.doesNotMatch(display.readings.detail, /Cloud readings remain available/);
});

test('standalone endpoint ambiguity directs configuration without exposing private setup data', () => {
  const setup = { state: 'needs-endpoint', endpointSource: null, reason: 'synthetic-private-reason',
    endpoint: 'ws://synthetic-private-host:9001/ocpp', password: 'synthetic-private-password' };
  const display = easeeLocalConnectionDisplay({ localOcpp: { configured: false, setup } }, options);
  assert.equal(display.setup.label, 'Address needed');
  assert.match(display.setup.detail, /No unambiguous local address could be detected/);
  assert.match(display.setup.detail, /easee\.local_ocpp\.server_url to an address the charger can reach.*apply configuration/);
  assert.match(display.setup.detail, /Paired installations use their shared virtual address automatically/);
  assert.equal(display.endpoint, 'Address unavailable');
  assert.doesNotMatch(JSON.stringify(display), /synthetic-private/);
  for (const state of ['constructor', '__proto__', 'synthetic-private-state']) {
    setup.state = state;
    const unknown = easeeLocalConnectionDisplay({ localOcpp: { setup } }, options);
    assert.equal(unknown.setup.label, 'Checking setup');
    assert.doesNotMatch(JSON.stringify(unknown), /constructor|__proto__|synthetic-private/);
  }
});

test('live local endpoint display distinguishes automatic detection, explicit settings and shared pair address', () => {
  for (const [source, endpoint, expected] of [
    ['detected', 'ws://192.0.2.10:9001/ocpp', 'Detected standalone address: ws://192.0.2.10:9001/ocpp'],
    ['configured', 'wss://charger.example.invalid/ocpp', 'Configured standalone address: wss://charger.example.invalid/ocpp'],
    ['pair-vip', 'ws://192.0.2.30:9001/ocpp', 'Paired virtual address: ws://192.0.2.30:9001/ocpp'],
  ]) {
    const display = easeeLocalConnectionDisplay({ localOcpp: {
      setup: { state: 'connecting', endpointSource: source, endpoint },
    } }, options);
    assert.equal(display.endpoint, expected);
    assert.equal(display.setup.label, 'Waiting for connection');
    assert.equal(display.readings.label, 'Waiting for connection', 'Detecting an address does not confirm charger reachability');
    if (source === 'detected') {
      assert.match(display.detail, /cannot reach this address.*easee\.local_ocpp\.server_url.*apply configuration/);
      assert.match(display.detail, /Apply reviewed configuration again to detect the address after a network change/);
    } else if (source === 'configured') {
      assert.match(display.detail, /Leave easee\.local_ocpp\.server_url empty.*detect a local address automatically/);
    } else assert.match(display.detail, /shared address/);
  }
});

test('local endpoint display rejects private metadata, malformed URLs and unknown sources', () => {
  const forbidden = 'synthetic-private';
  for (const endpoint of [
    `ws://${forbidden}:secret@192.0.2.10:9001/ocpp`,
    `ws://192.0.2.10:9001/ocpp/${forbidden}`,
    `ws://192.0.2.10:9001/ocpp?token=${forbidden}`,
    `ws://192.0.2.10:9001/ocpp#${forbidden}`,
    `http://${forbidden}.invalid/ocpp`,
    `WS://${forbidden}.invalid/ocpp`,
    ` ws://${forbidden}.invalid/ocpp`,
    `ws://${forbidden}.invalid:80/ocpp`,
    `ws://${forbidden}.invalid/extra/../ocpp`,
    `ws://${forbidden}.invalid/ocpp?`,
    `ws://${forbidden}.invalid/ocpp#`,
    forbidden, null, 1, { href: forbidden },
  ]) {
    const display = easeeLocalConnectionDisplay({ localOcpp: {
      setup: { state: 'ready', endpointSource: 'configured', endpoint },
    } }, options);
    assert.equal(display.endpoint, 'Configured standalone address');
    assert.doesNotMatch(JSON.stringify(display), /synthetic-private/);
  }
  for (const endpointSource of [null, 'constructor', '__proto__', forbidden]) {
    const display = easeeLocalConnectionDisplay({ localOcpp: {
      setup: { state: 'ready', endpointSource, endpoint: `ws://${forbidden}.invalid/ocpp` },
    } }, options);
    assert.equal(display.endpoint, 'Address unavailable');
    assert.doesNotMatch(JSON.stringify(display), /synthetic-private|constructor|__proto__/);
  }
  for (const snapshot of [{ readOnly: true }, { status: 'snapshot' }]) {
    const display = easeeLocalConnectionDisplay({ ...snapshot, localOcpp: {
      setup: { state: 'ready', endpointSource: 'configured', endpoint: `ws://${forbidden}.invalid/ocpp` },
    } }, options);
    assert.equal(display.endpoint, 'Configured standalone address');
    assert.doesNotMatch(JSON.stringify(display), /synthetic-private/);
  }
});

test('native control readiness and exclusive cloud handover are pending rather than failed readings', () => {
  for (const [reason, label, detail] of [
    ['native-control-unavailable', 'Activation pending', /native scheduling and plug-in authorization.*current charging control is preserved/],
    ['cloud-schedule-active', 'Waiting for cloud schedule', /cloud schedule owns charging.*preserved.*waits to activate/],
    ['control-transition-pending', 'Control handover pending', /finishing the current charging instruction.*confirmed handover/],
  ]) {
    const group = dashboardProviders({ providers: { easee: { status: 'ok', currentReadings: easeeReadings(),
      localOcpp: { configured: true, setup: { state: 'blocked', reason, endpointSource: 'pair-vip' } } } } }, options)
      .find(row => row.key === 'electricity');
    assert.equal(group.display.state, 'Available');
    assert.equal(group.localConnection.setup.label, label);
    assert.equal(group.localConnection.setup.tone, 'pending');
    assert.match(group.localConnection.setup.detail, detail);
    assert.doesNotMatch(group.localConnection.detail, /cloud schedules.*unchanged|schedules.*still use.*cloud/);
  }
});
