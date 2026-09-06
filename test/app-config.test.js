import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateSettings } from '../src/app/config.js';
import { requireLegacyLive } from '../src/app/legacy-gate.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('default startup is shadow with simulated devices, no credential reads and no real comfort target', () => {
  const cfg = loadConfig({}, '/missing-repository');
  assert.equal(cfg.input, 'simulated');
  assert.equal(cfg.settings.mode, 'shadow');
  assert.equal(cfg.settings.comfort.targetC, null);
  assert.deepEqual(cfg.connections, {});
  assert.equal(cfg.dbPath, '/missing-repository/var/simulation.sqlite');
});
test('legacy write gate requires the exact separate acknowledgement', () => {
  for (const value of [undefined, '', 'true', '1']) assert.throws(() => requireLegacyLive({ STMQ_LEGACY_LIVE: value }));
  assert.doesNotThrow(() => requireLegacyLive({ STMQ_LEGACY_LIVE: 'I_CONFIRM_LIVE_CONTROL' }));
});
test('network binding requires authentication and add-on persistent path is independent of cwd', () => {
  assert.throws(() => loadConfig({ STMQ_HOST: '0.0.0.0' }), /token/i);
  const cfg = loadConfig({ STMQ_ADDON: '1', STMQ_HOST: '0.0.0.0', STMQ_API_TOKEN: 'a'.repeat(32) });
  assert.equal(cfg.dbPath, '/data/st-mq/simulation.sqlite');
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
  assert.equal(config.connections.smartthings.inside_temp_dev_id, 'fixture');
  assert.equal(config.dbPath, join(directory, 'st-mq.sqlite'));
  assert.equal(config.settings.comfort.targetC, null);
  assert.equal(config.settings.comfort.maxDropC, 1);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(loadConfig({ STMQ_INPUT: 'simulated', STMQ_CONFIG: '/missing/credentials.json' }).connections, {});
});
