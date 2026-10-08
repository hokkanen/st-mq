import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile, readdir } from 'node:fs/promises';
import { Store } from '../src/storage/store.js';
import { recoveryCoverageReport, validRecoveryCoverageReport, RECOVERY_OUTAGE_LIMIT } from '../src/recovery/coverage-report.js';
import { Recorder } from '../src/storage/recorder.js';
import { SIGNAL_INFO } from '../src/domain/history-series.js';
import { recoveryPreview } from '../src/recovery/service.js';
import { fixture, start, HOUR, observation } from './helpers/recovery-fixture.js';

function stores(t) {
  const master = new Store(':memory:'), donor = new Store(':memory:');
  t.after(() => { master.close(); donor.close(); }); return { master, donor, input: 'mqtt', now: start + 100 * HOUR };
}
function outage(store, from, to, { signal = 'indoor_temperature', status = 'unavailable', source = 'synthetic', observationId = null } = {}) {
  store.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,samples,observation_id)
    VALUES(?,'invented-house',?,?,?,?,NULL,2,?)`).run(source,signal,status,from,to,observationId);
}
const category = (report, name) => report.categories.find(row => row.name === name);

test('category ranges show source extensions without inferring gaps from sparse measurements', async t => {
  const f = stores(t);
  observation(f.master,start + HOUR); observation(f.master,start + 3 * HOUR);
  for (const offset of [0,2,4]) observation(f.donor,start + offset * HOUR);
  f.donor.event('synthetic-event', {}, start);
  const report = await recoveryCoverageReport(f), temperatures = category(report,'temperatures');
  assert.deepEqual(temperatures.master, { count: 2, from: start + HOUR, to: start + 3 * HOUR, undated: 0 });
  assert.equal(temperatures.source.outsideMaster.before.count,1);
  assert.equal(temperatures.source.outsideMaster.before.from,start);
  assert.equal(temperatures.source.outsideMaster.after.count,1);
  assert.equal(category(report,'events').source.outsideMaster.withoutMasterRange.count,1);
  assert.deepEqual(report.outages.items,[]);
  assert.equal(report.outages.total,0);
  assert.equal(validRecoveryCoverageReport(report),true);
  for (const corrupt of [
    { ...report,path: '/invented/private.sqlite' },
    { ...report,outages: { ...report.outages,items: [{ signal: 'private-device',from: start,to: start,status: 'stale',potentialCoverage: true }],total: 1 } },
    { ...report,categories: report.categories.map((row,i) => i ? row : { ...row,source: { ...row.source,privateData: 'hidden' } }) },
  ]) assert.equal(validRecoveryCoverageReport(corrupt),false);
});

test('phase energy gaps use their explicit interval bounds once, instead of repeating their receipt markers', async t => {
  const f = stores(t), from = start + HOUR,to = start + 4 * HOUR;
  new Recorder(f.master).energyGap({ source: 'shelly-evse',device: 'invented-charger',prefix: 'ev2',
    start: from,end: to,receivedAt: to + 1000,quality: ['meter-report-gap'] });
  observation(f.donor,start + 2 * HOUR,0.2,{ signal: 'ev2_energy_l2',unit: 'kWh',
    raw: { intervalStart: start + HOUR,intervalEnd: start + 2 * HOUR } });
  const report = await recoveryCoverageReport(f);
  assert.equal(report.outages.total,1);
  assert.deepEqual(report.outages.items,[{ signal: null,energyPrefix: 'ev2',basis: 'energy-interval',
    from,to,status: 'unavailable',potentialCoverage: true }]);
  assert.equal(validRecoveryCoverageReport(report),true);
  for (const change of [{ to: from },{ energyPrefix: null },{ signal: 'indoor_temperature' },{ status: 'stale' }]) {
    assert.equal(validRecoveryCoverageReport({ ...report,outages: { ...report.outages,
      items: [{ ...report.outages.items[0],...change }] } }),false);
  }
});

test('excluded charging reports have dates without claiming merged coverage or extending an unfinished report', async t => {
  const f = stores(t);
  f.donor.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,ended_at,summary,checkpoint)
    VALUES('mqtt','charger-2','invented-report','invented-association',?,NULL,'{}','{}')`).run(start);
  f.donor.db.prepare(`INSERT INTO charging_report_events(namespace,charger_id,report_id,at,category,payload)
    VALUES('mqtt','charger-2','invented-report',?,'synthetic','{}')`).run(start + HOUR);
  const report = await recoveryCoverageReport(f);
  assert.equal(category(report,'charging_reports').source.from,start);
  assert.equal(category(report,'charging_reports').source.to,start);
  assert.equal(category(report,'charging_report_events').source.to,start + HOUR);
  assert.equal(validRecoveryCoverageReport(report),true);
});

test('availability report periods retain original evidence bounds without promising recovery', async t => {
  const f = stores(t);
  for (const offset of [1,3,5,7]) outage(f.master,start + offset * HOUR,start + (offset + 1) * HOUR);
  observation(f.donor,start + HOUR + 1000,0, { device: 'another-route-identity' });
  observation(f.donor,start + 3 * HOUR + 1000,21, { quality: ['stale'] });
  observation(f.donor,start + 5 * HOUR + 1000,21, { source: 'simulation' });
  observation(f.donor,start + 7 * HOUR + 1000,21, { signal: 'outdoor_temperature' });
  const report = await recoveryCoverageReport(f);
  assert.equal(report.outages.total,4);
  assert.deepEqual(report.outages.items.map(row => row.potentialCoverage),[false,false,false,true]);
  assert.equal(report.outages.items[0].to,start + 8 * HOUR,'The unavailable period is not extended to now');
  assert(!JSON.stringify(report).includes('another-route-identity'));
  assert.equal(report.counts,undefined);
});

test('retained point notifications group their signals without inventing an outage duration or coverage', async t => {
  const f = stores(t), at = start + HOUR, signals = Object.keys(SIGNAL_INFO).slice(0,28);
  for (const signal of signals) {
    const observationId = observation(f.master,at,null,{ signal,quality: ['retained','unavailable'] });
    outage(f.master,at,at,{ signal,observationId });
    observation(f.donor,at,21,{ signal });
  }
  observation(f.master,at + 1000,21,{ signal: signals[0] });
  const before = f.master.db.prepare('SELECT * FROM recorder_coverage').all();
  const report = await recoveryCoverageReport(f);
  assert.deepEqual(report.outages.counts,{ energyIntervals: 0,reportPeriods: 0,pointEvents: 28 });
  assert.equal(report.outages.total,28);
  assert.equal(report.outages.omitted,0);
  assert.deepEqual(report.outages.items,[{ signal: null,energyPrefix: null,basis: 'receipt-coverage',
    from: at,to: at,status: 'unavailable',potentialCoverage: false,records: 28,signals: signals.sort(),reason: 'retained' }]);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage').all(),before);
  assert.equal(validRecoveryCoverageReport(report),true);
  const item = report.outages.items[0];
  for (const bad of [
    { ...item,records: 0 },{ ...item,signals: ['private-device'] },{ ...item,signals: [signals[0],signals[0]] },
    { ...item,source: '/invented/private.sqlite' },{ ...item,reason: 'arbitrary-reason' },
  ]) assert.equal(validRecoveryCoverageReport({ ...report,outages: { ...report.outages,items: [bad] } }),false);
  assert.equal(validRecoveryCoverageReport({ ...report,outages: { ...report.outages,counts: { energyIntervals: 28,reportPeriods: 0,pointEvents: 0 } } }),false);
  assert.equal(validRecoveryCoverageReport({ ...report,outages: { ...report.outages,omitted: 1 } }),false);
  const withoutMetadata = structuredClone(report);
  delete withoutMetadata.outages.counts;
  withoutMetadata.outages.total = 1;
  for (const key of ['records','signals','reason']) delete withoutMetadata.outages.items[0][key];
  assert.equal(validRecoveryCoverageReport(withoutMetadata),true,'Aggregate display metadata is optional');
});

test('diagnostics group only exact source, evidence bounds, status and reason without exposing private names', async t => {
  const f = stores(t), at = start + HOUR;
  outage(f.master,at,at);
  outage(f.master,at,at,{ signal: 'outdoor_temperature' });
  outage(f.master,at,at,{ signal: 'private-signal-name' });
  outage(f.master,at,at,{ source: 'private-other-source' });
  outage(f.master,at + 1,at + 1);
  outage(f.master,at,at,{ status: 'failed' });
  const observationId = observation(f.master,at,null,{ quality: ['retained','unavailable'] });
  outage(f.master,at,at,{ observationId });
  outage(f.master,at,at + 1);
  outage(f.master,at,at + 2);
  outage(f.master,at,f.now + 1);
  const report = await recoveryCoverageReport(f), rows = report.outages.items;
  assert.deepEqual(report.outages.counts,{ energyIntervals: 0,reportPeriods: 2,pointEvents: 7 });
  assert.equal(rows.length,7);
  assert.equal(rows.filter(row => row.records === 3).length,1);
  assert.equal(rows.find(row => row.records === 3).signals.length,2);
  assert(!JSON.stringify(report).includes('private-'));
  assert.equal(validRecoveryCoverageReport(report),true);
});

test('point notifications cannot displace recorded energy gaps or report periods and omitted counts retain grouped records', async t => {
  const f = stores(t);
  new Recorder(f.master).energyGap({ source: 'shelly-evse',device: 'invented-charger',prefix: 'ev2',
    start,end: start + 1000,receivedAt: start + 1000 });
  for (let i = 0; i < RECOVERY_OUTAGE_LIMIT + 8; i++) {
    const at = start + HOUR + i * 1000;
    for (const signal of ['indoor_temperature','outdoor_temperature']) {
      outage(f.master,at,at,{ signal });
      outage(f.master,at,at + 500,{ signal });
    }
  }
  const report = await recoveryCoverageReport(f);
  assert.deepEqual(report.outages.counts,{ energyIntervals: 1,reportPeriods: 216,pointEvents: 216 });
  assert.equal(report.outages.items.length,201);
  assert.equal(report.outages.items.filter(row => row.basis === 'energy-interval').length,1);
  assert(report.outages.items.every((row,index,rows) => index === 0 || rows[index - 1].from >= row.from),
    'Displayed kinds retain chronological order when combined');
  assert.equal(report.outages.total,433);
  assert.equal(report.outages.omitted,32);
  assert.equal(validRecoveryCoverageReport(report),true);
});

test('source interval overlap and fresh unchanged reports count as potential evidence while unavailable evidence does not', async t => {
  const f = stores(t), from = start + HOUR, to = start + 2 * HOUR;
  outage(f.master,from,to,{ signal: 'ev2_energy_l1' });
  observation(f.donor,start + 3 * HOUR,0.3,{ signal: 'ev2_energy_l1', unit: 'kWh', raw: { intervalStart: start, intervalEnd: start + 3 * HOUR } });
  outage(f.master,from,to);
  const id = observation(f.donor,start,21);
  f.donor.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
    VALUES('synthetic','invented-house','indoor_temperature','fresh',?,?,?,?,3)`).run(start,to,to,id);
  const report = await recoveryCoverageReport(f);
  assert(report.outages.items.every(row => row.potentialCoverage));
  assert.equal(category(report,'energy').source.from,start,'Energy range starts at its original interval boundary');
  assert.equal(category(report,'energy').source.to,start + 3 * HOUR);
});

test('energy merely touching an outage and future, disconnected or malformed evidence do not claim potential coverage', async t => {
  for (const scenario of ['touches-start','touches-end','future-receipt','future-source','disconnected','invalid-geometry']) await t.test(scenario,async t => {
    const f = stores(t),from = start + HOUR,to = start + 2 * HOUR;
    new Recorder(f.master).energyGap({ source: 'shelly-evse',device: 'invented-charger',prefix: 'ev2',start: from,end: to });
    const end = scenario === 'touches-start' ? from : scenario === 'touches-end' ? to + HOUR : to;
    const begin = scenario === 'touches-start' ? start : scenario === 'touches-end' ? to : from;
    const id = observation(f.donor,end,0.2,{ signal: 'ev2_energy_l1',unit: 'kWh',
      receivedAt: scenario === 'future-receipt' ? f.now + 1000 : scenario === 'future-source' ? end - 1 : end,
      quality: scenario === 'disconnected' ? ['mqtt-disconnected'] : [],
      raw: { intervalStart: begin,intervalEnd: scenario === 'invalid-geometry' ? end - 1 : end } });
    f.donor.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES('synthetic','invented-house','ev2_energy_l1','fresh',?,?,?,?,2)`).run(end,end,end,id);
    assert.equal((await recoveryCoverageReport(f)).outages.items[0].potentialCoverage,false);
  });
});

test('durable open energy contributes dates and potential outage coverage without becoming saved observations', async t => {
  const f = stores(t), from = start + HOUR, to = start + 2 * HOUR;
  outage(f.master,from,to,{ signal: 'ev2_energy_l2' });
  f.donor.setState(`recorder:energy:${JSON.stringify(['shelly-evse','invented-charger','ev2'])}`,
    { pending: { start: from,end: to,receivedAt: to,energies: [0.1,0.1,0.1],quality: [] } });
  const report = await recoveryCoverageReport(f);
  assert.equal(report.outages.items[0].potentialCoverage,true);
  assert.equal(category(report,'recorder_pending_energy').source.count,3);
  assert.equal(category(report,'recorder_pending_energy').source.from,from);
  assert.equal(f.donor.observations().length,0);
});

test('selected history and bounded outage details exclude reverted evidence without erasing original records', async t => {
  const f = stores(t);
  for (let i = 0; i < RECOVERY_OUTAGE_LIMIT + 8; i++) outage(f.master,start + i * 1000,start + i * 1000 + 500);
  observation(f.donor,start);
  f.donor.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations','1')").run();
  const report = await recoveryCoverageReport(f);
  assert.equal(category(report,'temperatures').source.count,0);
  assert.equal(report.outages.items.length,RECOVERY_OUTAGE_LIMIT);
  assert.equal(report.outages.total,RECOVERY_OUTAGE_LIMIT + 8);
  assert.equal(report.outages.omitted,8);
  assert.equal(report.outages.items[0].from,start + (RECOVERY_OUTAGE_LIMIT + 7) * 1000);
  assert.equal(f.donor.db.prepare('SELECT COUNT(*) n FROM observations').get().n,1);
});

test('worker check stays read only, uses a consistent master snapshot and leaves live writers responsive', { timeout: 20000 }, async t => {
  const f = fixture(t), donor = new Store(`${f.directory}/unrelated-source.sqlite`);
  t.after(()=>donor.close());
  observation(f.master,start); observation(donor,start + HOUR);
  donor.transaction(() => {
    for (let i = 0; i < 10000; i++) observation(donor,start + 2 * HOUR + i * 1000);
  });
  const donorPath = await f.snapshot(donor), donorBefore = await readFile(donorPath), files = await readdir(f.directory);
  const historyBefore = f.master.observations(), statesBefore = f.master.db.prepare('SELECT * FROM state').all();
  let writes = 0, maxWriteMs = 0, first = true;
  const report = await recoveryPreview({ masterPath: f.master.path,donorPath,signal: t.signal,onProgress(value) {
    if (value.phase !== 'checking') return;
    if (!first) return; first = false;
    const before = performance.now(); observation(f.master,start + 20 * HOUR);
    maxWriteMs = Math.max(maxWriteMs,performance.now() - before); writes++;
  } });
  assert.equal(report.coverage.categories.find(row => row.name === 'temperatures').master.to,start,
    'All category summaries use the master snapshot pinned before concurrent writes');
  assert.equal(report.status,'checked'); assert.equal(report.model.status,'not-assessed');
  assert.equal(report.counts,undefined); assert.equal(writes,1);
  assert(maxWriteMs < 1000);
  assert.deepEqual(f.master.observations().slice(0,1),historyBefore);
  assert.equal(f.master.observations().length,2,'Only the explicitly concurrent writer added history');
  assert.deepEqual(f.master.db.prepare('SELECT * FROM state').all(),statesBefore);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM recovery_runs').get().n,0);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM history_recoveries').get().n,0);
  assert.deepEqual(await readFile(donorPath),donorBefore);
  assert.deepEqual(await readdir(f.directory),files,'No trial database is created');
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  t.diagnostic(JSON.stringify({ donorRows: 10001, concurrentWrites: writes,maxWriteMs: Math.round(maxWriteMs) }));
});
