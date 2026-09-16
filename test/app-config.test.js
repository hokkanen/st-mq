import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig as readConfig, configurationSource, validateSettings, recordingConfiguration, acquisitionConfiguration, teslamateConfiguration, indoorSensorWeightsConfiguration } from '../src/app/config.js';
import { requireLegacyLive } from '../src/app/legacy-gate.js';
import { chargingConfiguration } from '../src/charging/config.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadConfig = (env = {}, cwd) => readConfig({ HOME: '/missing-stmq-test-home', ...env }, cwd);

test('default startup is shadow with simulated devices, no provider connections and no real comfort target', () => {
  const cfg = loadConfig({}, '/missing-repository');
  assert.equal(cfg.input, 'simulated');
  assert.equal(cfg.settings.mode, 'shadow');
  assert.equal(cfg.settings.comfort.targetC, null);
  assert.deepEqual(cfg.connections, {});
  assert.equal(cfg.dbPath, '/missing-repository/var/simulation.sqlite');
});
test('recording and acquisition options are independent, configurable and validated',()=>{
  assert.deepEqual(recordingConfiguration(),{maxIntervalMs:300000,annualBudgetBytes:10000000000});
  assert.deepEqual(recordingConfiguration({max_interval_minutes:2,annual_budget_gb:4}),{maxIntervalMs:120000,annualBudgetBytes:4000000000});
  assert.equal(acquisitionConfiguration().easeeIntervalMs,15000);
  assert.equal(acquisitionConfiguration().electricityTelemetryMaxAgeMs,1020000);
  assert.equal(acquisitionConfiguration({electricity_telemetry_max_age_seconds:600}).electricityTelemetryMaxAgeMs,600000);
  assert.throws(()=>acquisitionConfiguration({electricity_telemetry_max_age_seconds:0}));
  assert.equal(acquisitionConfiguration({weather_poll_minutes:60}).weatherIntervalMs,3600000);
  for(const options of [{max_interval_minutes:0},{annual_budget_gb:-1},{annual_budget_gb:'10'}])assert.throws(()=>recordingConfiguration(options));
  assert.throws(()=>acquisitionConfiguration({easee_poll_seconds:1}));
});
test('TeslaMate opt-in uses existing MQTT and validates exact car/geofence/namespace settings', t => {
  assert.equal(teslamateConfiguration().enabled, false);
  assert.equal(teslamateConfiguration().homeGeofence, 'Home');
  assert.equal(teslamateConfiguration().chargerIdentification, false);
  assert.equal(teslamateConfiguration({ charger_identification: true }).chargerIdentification, true);
  assert.equal(teslamateConfiguration({ chargerIdentification: true }).chargerIdentification, true);
  assert.throws(() => teslamateConfiguration({ charger_identification: 'true' }));
  assert.equal(teslamateConfiguration({ car_id: 2, charger_assignment: 'easee', max_age_seconds: 120 }).carId, '2');
  assert.equal(teslamateConfiguration({ charger_assignment: 'easee' }).chargerAssignment, 'easee');
  for (const input of [{ car_id: '1/#' }, { home_geofence: '' }, { namespace: '#' }, { enabled: 'true' },
    { charger_assignment: 'guess' }, { max_age_seconds: 0 }, { max_age_seconds: '120' }]) assert.throws(() => teslamateConfiguration(input));
  const directory = mkdtempSync(join(tmpdir(), 'stmq-teslamate-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'options.json');
  writeFileSync(path, JSON.stringify({ mqtt: { address: '' }, teslamate: { enabled: true } }));
  assert.throws(() => loadConfig({ STMQ_INPUT: 'providers', STMQ_CONFIG: path }, directory), /existing MQTT/);
  writeFileSync(path, JSON.stringify({ mqtt: { address: 'mqtt://invented.invalid' }, teslamate: { enabled: true } }));
  const config = loadConfig({ STMQ_INPUT: 'providers', STMQ_CONFIG: path }, directory);
  assert.equal(config.connections.teslamate.enabled, true);
  assert.equal(config.connections.teslamate.homeGeofence, 'Home');
});
test('all indoor and garage MQTT topics are exact and keep private configuration unchanged',t=>{
  const directory=mkdtempSync(join(tmpdir(),'stmq-temperature-config-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'options.json');
  const original=JSON.stringify({mqtt:{address:'mqtt://invented.invalid',indoor_temperature_topic:'invented/indoor',
    downstairs_temperature_topic:'invented/downstairs',bedroom_temperature_topic:'invented/bedroom',garage_temperature_topic:'invented/garage'}});
  writeFileSync(path,original);
  const config=loadConfig({STMQ_INPUT:'mqtt',STMQ_CONFIG:path},directory);
  assert.deepEqual(config.connections.mqtt.temperatureTopics,{indoor_temperature:'invented/indoor',
    downstairs_temperature:'invented/downstairs',bedroom_temperature:'invented/bedroom',garage_temperature:'invented/garage'});
  assert.deepEqual(config.control.indoorSensorWeights, { indoor_temperature: 1/3, downstairs_temperature: 1/3, bedroom_temperature: 1/3 });
  assert.equal(readFileSync(path,'utf8'),original);
  writeFileSync(path,JSON.stringify({mqtt:{indoor_temperature_topic:'invented/#'}}));
  assert.throws(()=>loadConfig({STMQ_INPUT:'mqtt',STMQ_CONFIG:path},directory),/topic/);
  writeFileSync(path,JSON.stringify({mqtt:{address:'mqtt://invented.invalid',
    indoor_temperature_topic:'invented/shared',bedroom_temperature_topic:'invented/shared'}}));
  assert.throws(()=>loadConfig({STMQ_INPUT:'mqtt',STMQ_CONFIG:path},directory),/different MQTT topic/);
});
test('indoor learning weights have stable configured membership, optional explicit preferences and no private identifiers', () => {
  assert.deepEqual(indoorSensorWeightsConfiguration(), { indoor_temperature: 1 });
  const connections = { mqtt: { temperatureTopics: { downstairs_temperature: 'invented/downstairs',
    bedroom_temperature: 'invented/bedroom' } } };
  const automatic = indoorSensorWeightsConfiguration(undefined, connections);
  assert.deepEqual(automatic, { indoor_temperature: 1/3, downstairs_temperature: 1/3, bedroom_temperature: 1/3 });
  assert.deepEqual(indoorSensorWeightsConfiguration({}, connections), automatic);
  assert.equal(JSON.stringify(automatic).includes('invented'), false);
  assert.deepEqual(indoorSensorWeightsConfiguration({ bedroom_temperature: 3, indoor_temperature: 0, downstairs_temperature: 1 }, connections),
    { downstairs_temperature: 0.25, bedroom_temperature: 0.75 });
  for (const invalid of [{ outdoor_temperature: 1 }, { indoor_temperature: -1 }, { indoor_temperature: '1' },
    { indoor_temperature: Infinity }, { indoor_temperature: 0 },
    { indoor_temperature: 0, downstairs_temperature: 0, bedroom_temperature: 0 }, [], null])
    assert.throws(() => indoorSensorWeightsConfiguration(invalid, connections), /Indoor sensor weights/);
  assert.throws(() => indoorSensorWeightsConfiguration({ downstairs_temperature: 1 }), /configured/);
});

test('indoor report deadlines default to seventy minutes plus five-minute grace and remain configurable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-report-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const read = mqtt => {
    writeFileSync(path, JSON.stringify({ mqtt: { address: 'mqtt://invented.invalid', ...mqtt } }), { mode: 0o600 });
    return loadConfig({ STMQ_INPUT: 'mqtt', STMQ_CONFIG: path }, directory).connections.mqtt;
  };
  assert.equal(read({}).temperatureReportIntervalMs, 4_200_000);
  assert.equal(read({}).temperatureReportGraceMs, 300_000);
  assert.equal(read({ temperature_report_interval_minutes: 0 }).temperatureReportIntervalMs, 0);
  assert.equal(read({ temperature_report_interval_minutes: 20, temperature_report_grace_seconds: 30 }).temperatureReportGraceMs, 30_000);
  for (const settings of [{ temperature_report_interval_minutes: -1 }, { temperature_report_interval_minutes: '15' },
    { temperature_report_grace_seconds: -1 }, { temperature_report_grace_seconds: 901 }]) assert.throws(() => read(settings));
});
test('add-on default indoor weights include the required nested object and retain automatic sensor membership', () => {
  const addon = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  // Supervisor AppOptions._check_missing_options requires dictionary fields
  // even when all their children are optional; the public default must exist.
  assert.deepEqual(addon.options.controller.indoor_sensor_weights, {});
  assert(Object.values(addon.schema.controller.indoor_sensor_weights).every(type => type.endsWith('?')));
  assert.deepEqual(indoorSensorWeightsConfiguration(addon.options.controller.indoor_sensor_weights), { indoor_temperature: 1 });
  assert.deepEqual(indoorSensorWeightsConfiguration(addon.options.controller.indoor_sensor_weights,
    { mqtt: { downstairs_temperature_topic: 'invented/downstairs', bedroom_temperature_topic: 'invented/bedroom' } }),
  { indoor_temperature: 1/3, downstairs_temperature: 1/3, bedroom_temperature: 1/3 });
});
test('explicit indoor weights load through the public schema and survive disabled replica acquisition', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-indoor-weight-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify({ controller: { input: 'providers', indoor_sensor_weights: {
    indoor_temperature: 1, downstairs_temperature: 2, bedroom_temperature: 2,
  } }, mqtt: { downstairs_temperature_topic: 'invented/downstairs', bedroom_temperature_topic: 'invented/bedroom' } }));
  for (const role of ['primary', 'replica']) {
    const config = loadConfig({ STMQ_CONFIG: path, STMQ_ROLE: role }, directory);
    assert.deepEqual(config.control.indoorSensorWeights, { indoor_temperature: 0.2, downstairs_temperature: 0.4, bedroom_temperature: 0.4 });
    if (role === 'replica') assert.deepEqual(config.connections, {});
  }
});
test('legacy write gate requires the exact separate acknowledgement', () => {
  for (const value of [undefined, '', 'true', '1']) assert.throws(() => requireLegacyLive({ STMQ_LEGACY_LIVE: value }));
  assert.doesNotThrow(() => requireLegacyLive({ STMQ_LEGACY_LIVE: 'I_CONFIRM_LIVE_CONTROL' }));
});
test('network binding requires authentication and add-on persistent path is independent of cwd', () => {
  assert.throws(() => loadConfig({ STMQ_HOST: '0.0.0.0' }, '/missing-repository'), /token/i);
  const cfg = loadConfig({ STMQ_ADDON: '1', STMQ_HOST: '0.0.0.0', STMQ_API_TOKEN: 'a'.repeat(32) });
  assert.equal(cfg.dbPath, '/config/st-mq/simulation.sqlite');
  assert.equal(cfg.dataDir, '/data/st-mq');
  assert.equal(cfg.legacyDbPath, '/data/st-mq/simulation.sqlite');
  assert.equal(cfg.addon, true);
});
test('settings reject invalid target, mode, drop and occupancy', () => {
  for (const input of [{ mode: 'auto' }, { comfort: { targetC: 0 } }, { comfort: { maxDropC: 5 } }, { occupancy: { mode: 'inferred-away' } }]) {
    assert.throws(() => validateSettings(input));
  }
  assert.equal(validateSettings({ comfort: { targetC: 21 } }).comfort.targetC, 21);
});

test('provider opt-in reuses optional connection fields without requiring H66 or modifying configuration', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-provider-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'options.json');
  const options = { mqtt: { address: 'mqtt://invented.invalid', indoor_temperature_topic: 'invented/upstairs',
    downstairs_temperature_topic: 'invented/downstairs', bedroom_temperature_topic: 'invented/bedroom',
    garage_temperature_topic: 'invented/garage' },
    geoloc: { latitude: '60', longitude: '25', country_code: 'fi' } };
  for (const contents of [options, { options }]) for (const input of ['providers', 'mqtt']) {
    const original = JSON.stringify(contents);
    writeFileSync(path, original);
    const config = loadConfig({ STMQ_INPUT: input, STMQ_CONFIG: path, STMQ_DATA_DIR: directory });
    assert.equal(config.input, input);
    assert.equal(config.deviceId, undefined);
    assert.deepEqual(config.control.indoorSensorWeights, { indoor_temperature: 1/3, downstairs_temperature: 1/3, bedroom_temperature: 1/3 });
    assert.deepEqual(config.connections.mqtt.temperatureTopics, { indoor_temperature: 'invented/upstairs',
      downstairs_temperature: 'invented/downstairs', bedroom_temperature: 'invented/bedroom', garage_temperature: 'invented/garage' });
    assert.equal(config.dbPath, join(directory, 'st-mq.sqlite'));
    assert.equal(config.settings.comfort.targetC, null);
    assert.equal(config.settings.comfort.maxDropC, 1);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  assert.throws(() => loadConfig({ STMQ_INPUT: 'simulated', STMQ_CONFIG: '/missing/credentials.json' }), /existing/);
});

test('explicit standalone options configure permanent settings without enabling connections in simulation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-controller-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'options.json');
  writeFileSync(path, JSON.stringify({ options: {
    controller: { input: 'simulated', mode: 'monitoring', max_drop_c: 0.7, web_token: 'synthetic-token-is-long-enough' },
    electricity: { margin_ct_per_kwh_ex_vat: 0.8, vat_percent: 10, transfer_tariff: 'seasonal',
      winter_day_transfer_ct_per_kwh_ex_vat: 5, effective_date: '2026-01-01' },
    entsoe: { token: 'synthetic-should-not-be-exposed' },
  } }));
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_HOST: '0.0.0.0', STMQ_DATABASE_DIR: join(directory, 'shared') }, directory);
  assert.equal(config.settings.mode, 'monitoring');
  assert.equal(config.settings.comfort.maxDropC, 0.7);
  assert.deepEqual(config.connections, {});
  assert.equal(config.priceSettings.marginCtPerKwh, 0.8);
  assert.equal(config.priceSettings.vatRate, 0.1);
  assert.equal(config.priceSettings.transferRates.winterDayCtPerKwh, 5);
  assert.equal(config.priceSettings.transferRates.vatIncluded, false);
  assert.equal(config.dbPath, join(directory, 'shared/simulation.sqlite'));
  assert.equal(config.legacyDbPath, join(directory, 'var/simulation.sqlite'));
  const overridden = loadConfig({ STMQ_CONFIG: path, STMQ_MODE: 'shadow', STMQ_MAX_DROP_C: '1.2' }, directory);
  assert.equal(overridden.settings.mode, 'shadow');
  assert.equal(overridden.settings.comfort.maxDropC, 1.2);
});

test('standalone secrets use XDG config and repository options are no longer read', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-safe-default-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'st-mq'));
  mkdirSync(join(directory, 'data'));
  writeFileSync(join(directory, 'data/options.json'), JSON.stringify({ controller: { mode: 'active' } }));
  const path = join(directory, 'st-mq/secrets.json');
  writeFileSync(path, JSON.stringify({ controller: { mode: 'monitoring', max_drop_c: 0.6 },
    electricity: { tax_ct_per_kwh_ex_vat: 2.3 }, entsoe: { token: 'synthetic' } }));
  const config = loadConfig({ XDG_CONFIG_HOME: directory }, directory);
  assert.equal(config.input, 'simulated');
  assert.equal(config.settings.mode, 'monitoring');
  assert.equal(config.settings.comfort.maxDropC, 0.6);
  assert.equal(config.priceSettings.taxCtPerKwh, 2.3);
  assert.deepEqual(config.connections, {});
  assert.equal(config.configuration.privatePath, path);
  assert.equal(loadConfig({ STMQ_INPUT: 'providers', HOME: directory }, '/missing-repository').input, 'providers');
});

test('public defaults are reread before private overrides and explicit values survive merging', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-defaults-overlay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.config/st-mq'), { recursive: true });
  const manifest = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  manifest.options.controller.mode = 'monitoring';
  manifest.options.controller.learning_trials = true;
  manifest.options.electricity.tax_ct_per_kwh_ex_vat = 4;
  writeFileSync(join(directory, 'config.json'), JSON.stringify(manifest));
  const privatePath = join(directory, '.config/st-mq/secrets.json');
  writeFileSync(privatePath, JSON.stringify({ controller: { learning_trials: false, compressor_integral_a1: null },
    electricity: { tax_ct_per_kwh_ex_vat: 0 } }));
  const config = loadConfig({ HOME: directory }, directory);
  assert.equal(config.settings.mode, 'monitoring');
  assert.equal(config.control.learningTrials, false);
  assert.equal(config.control.compressorIntegralA1, null);
  assert.equal(config.priceSettings.taxCtPerKwh, 0);
  manifest.options.controller.mode = 'shadow';
  writeFileSync(join(directory, 'config.json'), JSON.stringify(manifest));
  const transaction = await configurationSource(config).prepare();
  assert.equal(transaction.config.settings.mode, 'shadow');
  assert.equal(transaction.config.control.learningTrials, false);
  await transaction.persist();
  await transaction.complete();
  assert.equal(readFileSync(privatePath, 'utf8').includes('learning_trials'), true);
  assert.equal(configurationSource(transaction.config), configurationSource(config));
});

test('add-on allows ingress bootstrap with no direct token and validates the candidate before application', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-ingress-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'secrets.json');
  writeFileSync(path, JSON.stringify({ controller: { web_token: '' } }));
  const config = loadConfig({ STMQ_ADDON: '1', STMQ_CONFIG: path }, directory);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.token, '');
  assert.equal(config.ingressPort, 8099);
  const initial = await configurationSource(config).prepare({ startup: true });
  assert.equal(initial.config.token, '');
  writeFileSync(path, JSON.stringify({ controller: { web_token: 'synthetic-short' } }));
  const invalid = loadConfig({ STMQ_ADDON: '1', STMQ_CONFIG: path }, directory);
  await assert.rejects(configurationSource(invalid).prepare({ startup: true }), /at least 24/);
});

test('standalone startup rejects unknown settings and malformed JSON without exposing their values', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-startup-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'secrets.json');
  writeFileSync(path, JSON.stringify({ mqtt: { password_typo: 'synthetic-sensitive-value' } }));
  assert.throws(() => loadConfig({ STMQ_CONFIG: path }, directory), error =>
    /Unknown configuration field: mqtt.password_typo/.test(error.message) && !error.message.includes('synthetic-sensitive-value'));
  writeFileSync(path, '{"mqtt":{"pw":"synthetic-sensitive-value');
  assert.throws(() => loadConfig({ STMQ_CONFIG: path }, directory), error =>
    /valid JSON/.test(error.message) && !error.message.includes('synthetic-sensitive-value'));
});

test('H66 verification paths resolve relative to the public add-on config folder or standalone workspace', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-h66-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'options.json');
  writeFileSync(path, JSON.stringify({ controller: { h66_verification_file: 'h66/verified.json' } }));
  assert.equal(loadConfig({ STMQ_ADDON: '1', STMQ_CONFIG: path }).h66Verification, '/config/h66/verified.json');
  assert.equal(loadConfig({ STMQ_CONFIG: path }, directory).h66Verification, join(directory, 'h66/verified.json'));
  assert.equal(loadConfig({ STMQ_CONFIG: path, STMQ_H66_VERIFICATION: '/tmp/fixture.json' }, directory).h66Verification, '/tmp/fixture.json');
});

test('add-on schema has explicit VAT basis, public database mount and no old scheduling mapping', () => {
  const addon = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(addon.backup, 'cold');
  assert.ok(addon.map.includes('share:rw'));
  assert.ok(addon.map.includes('addon_config:rw'));
  assert.equal(addon.options.temp_to_hours, undefined);
  assert.equal(addon.schema.temp_to_hours, undefined);
  assert.equal(addon.options.electricity.margin_ct_per_kwh_ex_vat, 0.33);
  assert.equal(addon.options.electricity.vat_percent, 25.5);
  assert.equal(addon.options.controller.max_drop_c, 1);
  assert.equal(addon.options.easee.charger_id, '');
  assert.equal(addon.schema.easee.charger_id, 'str?');
});

test('public charging defaults preserve runtime defaults and standalone topic changes load and reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'secrets.json');
  assert.deepEqual(loadConfig({}, directory).charging, chargingConfiguration());
  writeFileSync(path, JSON.stringify({ charging: { chargers: {
    charger1: { mqttTopic: 'synthetic/first/vehicle', efficiency: .85 },
    charger2: { mqttTopic: 'synthetic/second/vehicle' },
  } } }));
  const config = loadConfig({ STMQ_CONFIG: path }, directory);
  assert.deepEqual(config.charging.chargers, {
    charger1: { mqttTopic: 'synthetic/first/vehicle', efficiency: .85 },
    charger2: { mqttTopic: 'synthetic/second/vehicle', efficiency: .9 },
  });
  assert.deepEqual(config.connections, {}, 'Machine charging settings do not enable provider connections in simulation');
  writeFileSync(path, JSON.stringify({ charging: { chargers: {
    charger1: { mqttTopic: null }, charger2: { mqttTopic: '', efficiency: .95 },
  } } }));
  const next = (await configurationSource(config).prepare()).config;
  assert.deepEqual(next.charging.chargers, {
    charger1: { mqttTopic: null, efficiency: .9 }, charger2: { mqttTopic: null, efficiency: .95 },
  });
});

test('live MQTT can run without H66 and threshold configuration keeps native defaults separate from readings', t => {
  const directory=mkdtempSync(join(tmpdir(),'stmq-live-config-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'options.json');
  writeFileSync(path,JSON.stringify({controller:{input:'mqtt',mode:'active',compressor_integral_a1:-60,compressor_hysteresis_c:10},mqtt:{address:'mqtt://synthetic.invalid'}}));
  const cfg=loadConfig({STMQ_CONFIG:path},directory);
  assert.equal(cfg.input,'mqtt');assert.equal(cfg.settings.mode,'active');assert.equal(cfg.h66.enabled,false);
  assert.equal(cfg.control.auxIntegralA2,-990);assert.equal(cfg.control.auxHysteresisC,30);
  assert.equal(cfg.control.compressorIntegralA1,-60);assert.equal(cfg.control.compressorHysteresisC,10);
  const defaults=loadConfig({},'/missing-repository');
  assert.equal(defaults.control.compressorIntegralA1,-100);assert.equal(defaults.control.compressorHysteresisC,10);
});
