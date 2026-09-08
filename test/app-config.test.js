import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateSettings, recordingConfiguration, acquisitionConfiguration } from '../src/app/config.js';
import { requireLegacyLive } from '../src/app/legacy-gate.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.equal(acquisitionConfiguration({weather_poll_minutes:60}).weatherIntervalMs,3600000);
  for(const options of [{max_interval_minutes:0},{annual_budget_gb:-1},{annual_budget_gb:'10'}])assert.throws(()=>recordingConfiguration(options));
  assert.throws(()=>acquisitionConfiguration({easee_poll_seconds:1}));
});
test('replacement indoor and garage MQTT topics are exact and keep private configuration unchanged',t=>{
  const directory=mkdtempSync(join(tmpdir(),'stmq-temperature-config-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'options.json');
  const original=JSON.stringify({mqtt:{address:'mqtt://invented.invalid',indoor_temperature_topic:'invented/indoor',garage_temperature_topic:'invented/garage'}});
  writeFileSync(path,original);
  const config=loadConfig({STMQ_INPUT:'mqtt',STMQ_CONFIG:path},directory);
  assert.deepEqual(config.connections.mqtt.temperatureTopics,{indoor_temperature:'invented/indoor',garage_temperature:'invented/garage'});
  assert.equal(readFileSync(path,'utf8'),original);
  writeFileSync(path,JSON.stringify({mqtt:{indoor_temperature_topic:'invented/#'}}));
  assert.throws(()=>loadConfig({STMQ_INPUT:'mqtt',STMQ_CONFIG:path},directory),/topic/);
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
  const original = JSON.stringify({ options: { smartthings: { token: 'synthetic', inside_temp_dev_id: 'fixture' },
    geoloc: { latitude: 60, longitude: 25, country_code: 'fi' } } });
  writeFileSync(path, original);
  const config = loadConfig({ STMQ_INPUT: 'providers', STMQ_CONFIG: path, STMQ_DATA_DIR: directory });
  assert.equal(config.input, 'providers');
  assert.equal(config.deviceId, undefined);
  assert.equal(config.connections.smartthings, undefined, 'Legacy SmartThings credentials do not enable acquisition');
  assert.equal(config.dbPath, join(directory, 'st-mq.sqlite'));
  assert.equal(config.settings.comfort.targetC, null);
  assert.equal(config.settings.comfort.maxDropC, 1);
  assert.equal(readFileSync(path, 'utf8'), original);
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
    smartthings: { token: 'synthetic-should-not-be-exposed' },
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

test('implicit standalone options supply permanent settings while legacy credentials alone keep simulated input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-safe-default-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'data'));
  const path = join(directory, 'data/options.json');
  writeFileSync(path, JSON.stringify({ controller: { mode: 'monitoring', max_drop_c: 0.6 },
    electricity: { tax_ct_per_kwh_ex_vat: 2.3 }, smartthings: { token: 'synthetic' } }));
  const config = loadConfig({}, directory);
  assert.equal(config.input, 'simulated');
  assert.equal(config.settings.mode, 'monitoring');
  assert.equal(config.settings.comfort.maxDropC, 0.6);
  assert.equal(config.priceSettings.taxCtPerKwh, 2.3);
  assert.deepEqual(config.connections, {});
  assert.throws(() => loadConfig({ STMQ_INPUT: 'providers' }, '/missing-repository'), /requires an existing/);
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
  assert.equal(defaults.control.compressorIntegralA1,null);assert.equal(defaults.control.compressorHysteresisC,null);
});
