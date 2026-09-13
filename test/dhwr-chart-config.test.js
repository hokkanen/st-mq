import test from 'node:test';
import assert from 'node:assert/strict';
import { controlConfiguration } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { getChartData } from '../src/app/chart-data.js';

const start = Date.parse('2026-09-10T09:00Z'), MINUTE = 60_000;
test('DHWR duration is bounded and configurable without changing its ten-minute default', () => {
  assert.equal(controlConfiguration().dhwrPulseMinutes, 10);
  for (const value of [1, 2.5, 20, 60]) assert.equal(controlConfiguration({ dhwr_duration_minutes: value }).dhwrPulseMinutes, value);
  for (const value of [0, -1, 61, NaN, '10', null]) assert.throws(() => controlConfiguration({ dhwr_duration_minutes: value }));
});

test('DHWR chart respects longer configured runs and recorded early OFF without changing legacy pulses', () => {
  const store = new Store(':memory:');
  try {
    const put = (value, at, raw) => store.observation({ source: 'controller', device: 'offline', signal: 'dhwr_request',
      value, unit: 'state', sourceTime: at, receivedAt: at, quality: ['requested'], raw });
    put(1, start, { expiresAt: start + 20 * MINUTE });
    put(0, start + 15 * MINUTE, {});
    put(1, start + 30 * MINUTE, { expiresAt: start + 50 * MINUTE });
    store.observation({ source: 'st-mq-csv', device: 'legacy', signal: 'requested_heat_mode', value: 60,
      unit: 'legacy_command', sourceTime: start + 60 * MINUTE, receivedAt: start + 60 * MINUTE });
    const result = getChartData({ store, input: 'offline', now: start + 90 * MINUTE,
      startDate: '2026-09-10', endDate: '2026-09-10', detailSignals: ['dhwr_request'] });
    assert.deepEqual(result.shading.dhwr, [
      { start, end: start + 15 * MINUTE },
      { start: start + 30 * MINUTE, end: start + 50 * MINUTE },
      { start: start + 60 * MINUTE, end: start + 70 * MINUTE },
    ]);
  } finally { store.close(); }
});
