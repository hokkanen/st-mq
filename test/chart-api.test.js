import test from 'node:test';
import { seedVoltage } from './voltage-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { createChartService } from '../src/app/chart-service.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-api-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const now = Date.parse('2026-09-07T09:00:00Z');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'providers', connections: {}, ...overrides };
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
  return { store, engine, service, now, base: `http://127.0.0.1:${server.address().port}`, headers: { Authorization: `Bearer ${token}` } };
}

test('chart API requires authentication and rejects malformed date/axis/point selections', async t => {
  const { base, headers } = await fixture(t);
  assert.equal((await fetch(`${base}/api/chart`)).status, 401);
  for (const query of ['start=2026-02-31', 'start=2026-09-08&end=2026-09-07', 'left=arbitrary_signal', 'view=arbitrary_view', 'view=constructor', 'view=garage&left=power', 'points=999999', 'start=not-a-date']) {
    const response = await fetch(`${base}/api/chart?${query}`, { headers });
    assert.equal(response.status, 400, query);
  }
  const response = await fetch(`${base}/api/chart`, { headers: { ...headers, Origin: 'https://untrusted.example' } });
  assert.equal(response.status, 403);
});

test('named-view API and worker cache keep distinct context and source selection for overview and detail', async t => {
  const { base, headers, store, now } = await fixture(t);
  const at = now - 24 * 3_600_000;
  for (const [signal, value] of [['garage_native_indoor_temperature', 12], ['supply_temperature', 35], ['return_temperature', 28]])
    store.observation({ source: 'synthetic-view', device: 'synthetic-equipment', signal, value, unit: 'degC', sourceTime: at, receivedAt: at });
  const read = async (view, detail = false) => {
    const response = await fetch(`${base}/api/chart?start=2026-09-06&view=${view}${detail ? `&viewFrom=${at - 60_000}&viewTo=${at + 60_000}` : ''}`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const garage = await read('garage');
  assert.equal(garage.view, 'garage');
  assert(garage.series.garage_native_indoor_temperature.some(point => point.y === 12));
  assert(!Object.hasOwn(garage.series, 'supply_temperature'));
  assert.equal((await read('garage')).meta.cacheHit, true);
  const water = await read('heating_water');
  assert.notEqual(water.meta.cacheHit, true);
  assert(water.series.supply_temperature.some(point => point.y === 35));
  assert(water.series.return_temperature.some(point => point.y === 28));
  assert(!Object.hasOwn(water.series, 'garage_native_indoor_temperature'));
  const detail = await read('garage', true);
  assert.equal(detail.meta.detail, true);
  assert.equal(detail.view, 'garage');
  assert.notEqual(detail.meta.cacheHit, true);
  assert(detail.series.garage_native_indoor_temperature.some(point => point.y === 12));
});

test('real worker historical cache follows meter audits and finalized sessions but retains unrelated event hits',async t=>{
  const {base,headers,store,now}=await fixture(t);
  const read=left=>fetch(`${base}/api/chart?start=2026-09-06&end=2026-09-06&left=${left}`,{headers}).then(r=>r.json());
  const meter='property_import_energy_counter',session='ev1_session_energy_check';
  await read(meter);assert.equal((await read(meter)).meta.cacheHit,true);
  store.event('synthetic-operational',{ok:true},now);assert.equal((await read(meter)).meta.cacheHit,true);
  store.energyAudit({source:'easee',device:'synthetic-property',signal:meter,sourceTime:now-24*3600000,receivedAt:now,value:123});
  const updated=await read(meter);assert.notEqual(updated.meta.cacheHit,true);assert(updated.series[meter].some(point=>point.y===123));
  await read(session);assert.equal((await read(session)).meta.cacheHit,true);
  recordChargingSessionCheck(store,{source:'easee',sessionKey:'synthetic-cache-session',start:now-25*3600000,end:now-24*3600000,
    estimatedKwh:7,referenceKwh:7,complete:true,quality:[]});
  const final=await read(session);assert.notEqual(final.meta.cacheHit,true);assert(final.series[session].some(point=>point.y===7));
});
test('historical worker cache reevaluates receipt eligibility when only the as-of clock advances or rolls back',async t=>{
  const {store,service,now}=await fixture(t),sourceTime=now-24*3600000;
  for(const [value,receivedAt] of [[20,now],[21,now+1000]])store.observation({source:'mqtt-temperature',device:'synthetic-asof',
    signal:'indoor_temperature',unit:'degC',sourceTime,receivedAt,value});
  const args={input:'providers',startDate:'2026-09-06',endDate:'2026-09-06',left:'indoor_temperature',points:100,now};
  const first=await service.query(args);assert(first.series.indoor_temperature.some(point=>point.y===20));
  assert(!(first.series.indoor_temperature.some(point=>point.y===21)));
  assert.equal((await service.query(args)).meta.cacheHit,true);
  const advanced=await service.query({...args,now:now+1000});assert.notEqual(advanced.meta.cacheHit,true);
  assert(advanced.series.indoor_temperature.some(point=>point.y===21));
  const rolledBack=await service.query(args);assert.notEqual(rolledBack.meta.cacheHit,true);
  assert(rolledBack.series.indoor_temperature.some(point=>point.y===20));
  assert(!(rolledBack.series.indoor_temperature.some(point=>point.y===21)));
});

test('worker cache renews an unchanged periodic report within the same fifteen-second cache bucket',async t=>{
  const {engine,base,headers,now}=await fixture(t),age=17*60_000;
  const report=at=>engine.recorder.record({source:'mqtt-temperature',device:'invented-periodic-room',signal:'indoor_temperature',
    value:20,unit:'degC',sourceTime:at,receivedAt:at,quality:[],raw:{reportIntervalMs:15*60_000,reportGraceMs:2*60_000}});
  report(now-15*60_000);
  const read=()=>fetch(`${base}/api/chart?start=2026-08-01&end=2026-09-07&left=indoor_temperature`,{headers}).then(response=>response.json());
  const first=await read(),cached=await read();
  assert.equal(cached.meta.cacheHit,true);
  assert.equal(first.meta.lastReadings.indoor_temperature.reportExpiresAt,now+2*60_000);
  assert.equal(report(now).saved,false);
  const renewed=await read();
  assert.notEqual(renewed.meta.cacheHit,true);
  assert.equal(renewed.meta.lastReadings.indoor_temperature.reportExpiresAt,now+age);
});
test('recorded energy checks always include property availability and real charger summaries without private identifiers',async t=>{
  const {base,headers,store,now}=await fixture(t);
  assert.equal((await fetch(`${base}/api/energy-audits`)).status,401);
  const read=()=>fetch(`${base}/api/energy-audits`,{headers}).then(response=>response.json());
  const empty = await read();
  assert.equal(empty[0].kind,'property-meter-summary');
  assert.equal(empty[0].summary.status,'no-readings');
  assert.equal(empty[0].summary.latestReading,null);
  assert.deepEqual(empty.slice(1).map(row => row.source), ['easee', 'shelly-evse']);
  assert(empty.slice(1).every(row => row.summary.recordedSessions === 0 && row.summary.differencePercent === null));
  for(const [at,value] of [[now-60000,10],[now,10.03]])store.energyAudit({source:'easee',device:'invented-property',
    signal:'property_import_energy_counter',sourceTime:at,receivedAt:at,value});
  for(let phase=1;phase<=3;phase++)store.observation({source:'easee',device:'invented-property',
    signal:`property_energy_l${phase}`,sourceTime:now,receivedAt:now,value:0.01,unit:'kWh',quality:['estimated'],
    raw:{intervalStart:now-60000,intervalEnd:now}});
  // Property cumulative readings cannot invent finalized charger sessions.
  const withoutSessions = await read();
  assert(withoutSessions.slice(1).every(row => row.summary.recordedSessions === 0));
  recordChargingSessionCheck(store, { source:'easee',sessionKey:'invented-session',start:now-60000,end:now,
    estimatedKwh:1.1,referenceKwh:1,complete:true,quality:[] });
  recordChargingSessionCheck(store, { source:'shelly-evse',sessionKey:'invented-tesla-session',start:now-60000,end:now,
    estimatedKwh:1.2,referenceKwh:1,complete:false,quality:['incomplete-coverage'] });
  const auditCount=store.energyAudits().length;
  const response=await fetch(`${base}/api/energy-audits`,{headers});assert.equal(response.status,200);
  const rows=await response.json();
  assert.deepEqual(rows.map(row=>row.signal),['property_import_energy_counter','ev1_session_energy_check','shelly_session_energy_check']);
  assert.equal(rows[0].summary.status,'compared');
  assert.equal(rows[0].summary.readingCount,2);
  assert.deepEqual(rows[0].summary.latestReading,{valueKwh:10.03,sourceTime:now,receivedAt:now});
  assert.equal(rows[0].summary.comparison.start,now-60000);
  assert.equal(rows[0].summary.comparison.end,now);
  assert.ok(Math.abs(rows[0].summary.comparison.differenceKwh)<1e-12);
  assert.deepEqual(rows[0].summary.lastSuccessfulComparison,rows[0].summary.comparison);
  assert.equal(rows[1].summary.comparedSessions,1);
  assert.equal(rows[1].summary.referenceKwh,1);
  assert(Math.abs(rows[1].summary.differencePercent-10)<1e-10);
  assert.equal(rows[2].summary.recordedSessions,1);
  assert.equal(rows[2].summary.excludedSessions,1);
  assert.equal(rows[2].summary.differencePercent,null);
  assert(rows.every(row=>!Object.hasOwn(row,'device')&&!Object.hasOwn(row,'value')));
  assert(!JSON.stringify(rows).includes('invented-'));
  assert.equal(store.energyAudits().length,auditCount,'summary never deletes audit history');
});
test('every catalogue axis works, including historical meter references without learning use',async t=>{
  const {base,headers,store,now}=await fixture(t);
  store.energyAudit({source:'easee',device:'invented-property',signal:'property_import_energy_counter',sourceTime:now-60000,receivedAt:now,value:123,quality:[]});
  for(const source of ['easee','shelly-evse'])recordChargingSessionCheck(store,{source,sessionKey:'invented-finalized-session',
    start:now-3600000,end:now-60000,estimatedKwh:6,referenceKwh:5,complete:true,quality:[]});
  const {HISTORY_AXES}=await import('../src/domain/history-series.js');
  for(const axis of HISTORY_AXES) {
    const response=await fetch(`${base}/api/chart?left=${axis.key}`,{headers});
    assert.equal(response.status,200,axis.key);
    const chart=await response.json();
    for(const signal of axis.signals)assert(Array.isArray(chart.series[signal]),signal);
    if(axis.key==='property_import_energy_counter')assert(chart.series[axis.key].some(row=>row.y===123&&row.auditOnly));
    if(['ev1_session_energy_check','shelly_session_energy_check'].includes(axis.key))
      assert(chart.series[axis.key].some(row=>row.y===5&&row.auditOnly&&row.sessionCheck));
  }
});

test('chart defaults to today in Finland and includes shared right-axis data for every left axis', async t => {
  const { base, headers, store, now } = await fixture(t);
  store.observation({ source: 'mqtt-temperature', device: 'fixture-room', signal: 'indoor_temperature',
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
  seedVoltage(store, now - 2 * 3_600_000);
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
  assert.ok(priced.series.all_in_price.some(p => Math.abs(p.y - (-5 + .5 + 2 + 2.66) * 1.25) < 0.000001));
  assert.ok(priced.series.spot_price.some(p => p.y === -5));
  assert.equal((await fetch(`${base}/api/status`, { headers }).then(r => r.json())).automation.home.enabled, false);
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

test('chart viewport API validates immutable bounds and caches independent detail responses', async t => {
  const { base, headers, now, store } = await fixture(t);
  const viewFrom = now - 2 * 3_600_000, viewTo = now - 3_600_000;
  const selected = 'start=2024-01-01&end=2026-09-07';
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-room', signal: 'indoor_temperature',
    value: 21.3, unit: 'degC', sourceTime: viewFrom + 60_000, receivedAt: now, quality: [] });
  for (const query of [`viewFrom=${viewFrom}`, `viewTo=${viewTo}`, 'viewFrom=&viewTo=',
    `viewFrom=NaN&viewTo=${viewTo}`, `viewFrom=${viewFrom + 0.5}&viewTo=${viewTo}`,
    `viewFrom=${viewTo}&viewTo=${viewFrom}`, `viewFrom=${viewTo}&viewTo=${viewTo}`,
    `viewFrom=${Date.parse('2023-12-31T00:00:00Z')}&viewTo=${viewTo}`,
    `viewFrom=${viewFrom}&viewTo=${Date.parse('2026-09-09T00:00:00Z')}`]) {
    const response = await fetch(`${base}/api/chart?${selected}&${query}`, { headers });
    assert.equal(response.status, 400, query);
  }
  const read = (from, to) => fetch(`${base}/api/chart?${selected}&viewFrom=${from}&viewTo=${to}`, { headers })
    .then(async response => { assert.equal(response.status, 200); return response.json(); });
  const first = await read(viewFrom, viewTo);
  assert.equal(first.meta.detail, true);
  assert.equal(first.range.from, viewFrom);
  assert.equal(first.range.to, viewTo);
  assert.equal(first.selection.from, Date.parse('2023-12-31T22:00:00Z'));
  assert.equal(first.selection.to, Date.parse('2026-09-07T21:00:00Z'));
  assert(first.series.indoor_temperature.some(point => point.y === 21.3));
  assert(!Object.hasOwn(first, 'heatingBenefit'));
  assert.equal((await read(viewFrom, viewTo)).meta.cacheHit, true);
  const moved = await read(viewTo, viewTo + 60_000);
  assert.notEqual(moved.meta.cacheHit, true);
  assert.equal(moved.range.from, viewTo);
  assert.equal(moved.range.to, viewTo + 60_000);
  assert(!moved.series.indoor_temperature.some(point => point.x >= moved.range.from
    && point.x <= moved.range.to && point.y === 21.3), 'A cached reading cannot become an observation in the moved viewport');
  const context = moved.series.indoor_temperature.filter(point => point.x < moved.range.from || point.x > moved.range.to);
  assert(context.some(point => point.x === viewFrom + 60_000 && point.y === 21.3));
  assert(context.every(point => point.displayContext && point.x >= moved.range.from - 3 * 3_600_000
    && point.x <= Math.min(now, moved.range.to + 3 * 3_600_000)), 'Only explicitly bounded real interpolation context is outside the viewport');
  assert(context.filter(point => point.x < moved.range.from).length <= 8);
  assert(context.filter(point => point.x > moved.range.to).length <= 8);
  assert.notDeepEqual(moved.series.indoor_temperature, first.series.indoor_temperature);
  const cachedMoved = await read(viewTo, viewTo + 60_000), cachedFirst = await read(viewFrom, viewTo);
  assert.equal(cachedMoved.meta.cacheHit, true);
  assert.equal(cachedFirst.meta.cacheHit, true);
  assert.deepEqual(cachedMoved.series, moved.series);
  assert.deepEqual(cachedFirst.series, first.series);
});
