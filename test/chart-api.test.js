import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { createChartService } from '../src/app/chart-service.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-api-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const now = Date.parse('2026-09-07T09:00:00Z');
  const config = { ...loadConfig({}, directory), input: 'providers', connections: {} };
  const engine = new Engine({ store, config, clock: () => now });
  const service = createChartService({ store });
  const token = 'synthetic-chart-api-access-token';
  const server = createAppServer({ store, engine, chartService: service, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine, now, base: `http://127.0.0.1:${server.address().port}`, headers: { Authorization: `Bearer ${token}` } };
}

test('chart API requires authentication and rejects malformed date/axis/point selections', async t => {
  const { base, headers } = await fixture(t);
  assert.equal((await fetch(`${base}/api/chart`)).status, 401);
  for (const query of ['start=2026-02-31', 'start=2026-09-08&end=2026-09-07', 'left=arbitrary_signal', 'points=999999', 'start=not-a-date']) {
    const response = await fetch(`${base}/api/chart?${query}`, { headers });
    assert.equal(response.status, 400, query);
  }
  const response = await fetch(`${base}/api/chart`, { headers: { ...headers, Origin: 'https://untrusted.example' } });
  assert.equal(response.status, 403);
});

test('chart defaults to today in Finland and includes shared right-axis data for every left axis', async t => {
  const { base, headers, store, now } = await fixture(t);
  store.observation({ source: 'smartthings', device: 'fixture-room', signal: 'indoor_temperature',
    value: 21.3, unit: 'degC', sourceTime: now - 3600000, receivedAt: now, quality: [] });
  for (const left of ['power', 'phases', 'integral']) {
    const response = await fetch(`${base}/api/chart?left=${left}`, { headers });
    assert.equal(response.status, 200);
    const chart = await response.json();
    assert.equal(chart.range.startDate, '2026-09-07');
    assert.equal(chart.range.endDate, '2026-09-07');
    assert.equal(chart.range.from, Date.parse('2026-09-06T21:00:00Z'));
    assert.equal(chart.range.to, Date.parse('2026-09-07T21:00:00Z'));
    assert.equal(chart.series.indoor_temperature.some(p => p.y === 21.3), true);
    for (const signal of ['all_in_price', 'spot_price', 'outdoor_temperature', 'garage_temperature']) assert.ok(Array.isArray(chart.series[signal]));
    assert.equal(JSON.stringify(chart).includes('connections'), false);
  }
});

test('dated contract edits invalidate chart pricing without filling uncovered historical dates', async t => {
  const { base, headers, store, engine, now } = await fixture(t);
  store.observation({ source: 'csv:stmq', device: 'legacy_stmq', signal: 'spot_price', value: -5,
    unit: 'c/kWh_ex_vat', sourceTime: now - 3600000, receivedAt: now, quality: ['historical', 'corrected_historical_price', 'excludes_vat_and_other_charges'] });
  const read = () => fetch(`${base}/api/chart?start=2026-09-07&end=2026-09-07`, { headers }).then(response => response.json());
  assert.equal((await read()).series.all_in_price.some(p => Number.isFinite(p.y)), false);
  engine.addContractPeriod({ effectiveDate: '2026-09-07', marginCtPerKwh: 0.5, taxCtPerKwh: 2, vatRate: 0.25, tariff: 'day-night' });
  const priced = await read();
  assert.ok(priced.series.all_in_price.some(p => Math.abs(p.y - 0.215) < 0.000001));
  assert.ok(priced.series.spot_price.some(p => p.y === -5));
  assert.equal((await fetch(`${base}/api/status`, { headers }).then(r => r.json())).liveWrites, false);
});

test('Finnish DST chart days preserve 23 and 25 hours with explicit selected bounds', async t => {
  const { base, headers } = await fixture(t);
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const response = await fetch(`${base}/api/chart?start=${date}&end=${date}`, { headers });
    assert.equal(response.status, 200);
    const chart = await response.json();
    assert.equal((chart.range.to - chart.range.from) / 3600000, hours);
  }
});
