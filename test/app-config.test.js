import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateSettings } from '../src/app/config.js';
import { requireLegacyLive } from '../src/app/legacy-gate.js';

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
