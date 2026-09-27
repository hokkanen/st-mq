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
    const importId=Number(store.db.prepare("INSERT INTO imports(kind,sha256,path,status,started_at,completed_at) VALUES('stmq','synthetic','synthetic.csv','complete',?,?)").run(start,start).lastInsertRowid);
    store.observation({ source: 'csv:stmq', device: 'legacy_stmq', signal: 'requested_heat_mode', value: 60,
      unit: 'legacy_command', sourceTime: start + 60 * MINUTE, receivedAt: start + 60 * MINUTE,
      provenance:{importId,rowNumber:1} });
    const result = getChartData({ store, input: 'offline', now: start + 90 * MINUTE,
      startDate: '2026-09-10', endDate: '2026-09-10', detailSignals: ['dhwr_request'] });
    assert.deepEqual(result.shading.dhwr, [
      { start, end: start + 15 * MINUTE },
      { start: start + 30 * MINUTE, end: start + 50 * MINUTE },
      { start: start + 60 * MINUTE, end: start + 70 * MINUTE },
    ]);
  } finally { store.close(); }
});

test('DHWR request shading remains independent of separately selectable recorded feedback', () => {
  const store = new Store(':memory:');
  try {
    const put = (signal, value, at, raw) => store.observation({ source: signal === 'dhwr_active' ? 'mqtt-equipment' : 'controller',
      device: signal === 'dhwr_active' ? 'dhwr' : 'offline', signal, value, unit: 'state', sourceTime: at, receivedAt: at, raw });
    put('dhwr_request', 1, start, { expiresAt: start + 60 * MINUTE });
    put('dhwr_active', 0, start + 5 * MINUTE, { verified: true, eventOnly: true });
    put('dhwr_active', 1, start + 10 * MINUTE, { verified: true, eventOnly: true });
    put('dhwr_active', 0, start + 20 * MINUTE, { verified: true, eventOnly: true });
    put('dhwr_active', 1, start + 30 * MINUTE, { verified: true, eventOnly: true });
    put('dhwr_active', null, start + 35 * MINUTE, { verified: false });
    put('dhwr_active', 1, start + 40 * MINUTE, { verified: true, maxAgeMs: 2 * MINUTE });
    const result = getChartData({ store, input: 'offline', now: start + 60 * MINUTE,
      startDate: '2026-09-10', endDate: '2026-09-10' });
    assert.deepEqual(result.shading.dhwr, [{ start,end:start+60*MINUTE }]);
    assert.match(result.meta.dhwrBasis, /Requested circulation/);
    assert.match(result.meta.dhwrBasis, /feedback is shown separately/);
  } finally { store.close(); }
});
