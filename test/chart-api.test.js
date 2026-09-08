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

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-api-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const now = Date.parse('2026-09-07T09:00:00Z');
  const config = { ...loadConfig({}, directory), input: 'providers', connections: {}, ...overrides };
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
test('meter diagnostics show one latest cumulative check per meter, preserving comparisons and privacy',async t=>{
  const {base,headers,store,now}=await fixture(t);
  assert.equal((await fetch(`${base}/api/energy-audits`)).status,401);
  const read=()=>fetch(`${base}/api/energy-audits`,{headers}).then(response=>response.json());
  assert.deepEqual(await read(),[]);
  for(const [at,value] of [[now-60000,10],[now,10.03]])store.energyAudit({source:'easee',device:'invented-property',
    signal:'property_import_energy_counter',sourceTime:at,receivedAt:at,value});
  for(let phase=1;phase<=3;phase++)store.observation({source:'easee',device:'invented-property',
    signal:`property_energy_l${phase}`,sourceTime:now,receivedAt:now,value:0.01,unit:'kWh',quality:['estimated'],
    raw:{intervalStart:now-60000,intervalEnd:now}});
  // Older property readings must survive more than a page of charger updates.
  for(let i=1;i<=25;i++)store.energyAudit({source:'easee',device:'invented-charger',signal:'ev1_lifetime_energy_counter',
    sourceTime:now+i*60000,receivedAt:now+i*60000,value:100+i});
  // Session history is retained, but never appears as another charger check.
  store.energyAudit({source:'easee',device:'invented-charger',signal:'ev1_session_energy_counter',
    sourceTime:now+26*60000,receivedAt:now+26*60000,value:5});
  // A delayed old observation must not replace the newest meter reading.
  store.energyAudit({source:'easee',device:'invented-charger',signal:'ev1_lifetime_energy_counter',
    sourceTime:now+30000,receivedAt:now+27*60000,value:100.5});
  const auditCount=store.energyAudits().length;
  const response=await fetch(`${base}/api/energy-audits`,{headers});assert.equal(response.status,200);
  const rows=await response.json();
  assert.deepEqual(rows.map(row=>row.signal),['property_import_energy_counter','ev1_lifetime_energy_counter']);
  assert.deepEqual(rows.map(row=>row.sourceTime),[now,now+25*60000]);
  assert.equal(rows[0].comparison.start,now-60000);
  assert.equal(rows[0].comparison.end,now);
  assert.ok(Math.abs(rows[0].comparison.differenceKwh)<1e-12);
  assert.equal(rows[1].comparison,null);
  assert(rows.every(row=>!Object.hasOwn(row,'device')&&!Object.hasOwn(row,'value')));
  assert(!JSON.stringify(rows).includes('invented-'));
  assert.equal(store.energyAudits().length,auditCount,'summary never deletes audit history');
});
test('every catalogue axis works, including historical meter references without learning use',async t=>{
  const {base,headers,store,now}=await fixture(t);
  store.energyAudit({source:'easee',device:'invented-device',signal:'ev1_lifetime_energy_counter',sourceTime:now-60000,receivedAt:now,value:123,quality:[]});
  const {HISTORY_AXES}=await import('../src/domain/history-series.js');
  for(const axis of HISTORY_AXES) {
    const response=await fetch(`${base}/api/chart?left=${axis.key}`,{headers});
    assert.equal(response.status,200,axis.key);
    const chart=await response.json();
    for(const signal of axis.signals)assert(Array.isArray(chart.series[signal]),signal);
    if(axis.key==='ev1_lifetime_energy_counter')assert(chart.series.ev1_lifetime_energy_counter.some(row=>row.y===123&&row.auditOnly));
  }
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

test('total-power API includes property phases reported minutes apart and preserves phase timestamps', async t => {
  const { base, headers, store, now } = await fixture(t);
  const propertyTimes = [now - 45 * 60_000, now - 10 * 60_000, now];
  for (const [i, sourceTime] of propertyTimes.entries()) {
    store.observation({ source: 'easee', device: 'fixture-property', signal: `property_current_l${i + 1}`,
      value: i + 1, unit: 'A', sourceTime, receivedAt: now, quality: ['current_snapshot_not_energy', 'asynchronous_snapshot'] });
    store.observation({ source: 'easee', device: 'fixture-charger', signal: `ev1_current_l${i + 1}`,
      value: 0, unit: 'A', sourceTime: now - 3_600_000, receivedAt: now,
      quality: ['current_snapshot_not_energy', 'stale'] });
  }
  const powerResponse = await fetch(`${base}/api/chart?left=power`, { headers });
  assert.equal(powerResponse.status, 200);
  const power = await powerResponse.json();
  assert(power.series.property_power.some(point => Math.abs(point.y - 1.38) < 0.000001));
  assert(power.series.charger_power.some(point => point.y === 0));
  assert.equal(power.meta.lastReadings.property_power.x, now);
  assert.equal(power.meta.lastReadings.charger_power.x, now - 3_600_000);
  const phases = await fetch(`${base}/api/chart?left=phases`, { headers }).then(response => response.json());
  for (const [i, sourceTime] of propertyTimes.entries()) {
    assert(phases.series[`property_current_l${i + 1}`].some(point => point.x === sourceTime && point.y === i + 1));
  }
});

test('dated contract edits invalidate chart pricing without filling uncovered historical dates', async t => {
  // An imported installation can have historical prices before its configured
  // rate coverage. Exercise that case independently of new-install defaults.
  const { base, headers, store, engine, now } = await fixture(t, { priceSettings: null });
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
