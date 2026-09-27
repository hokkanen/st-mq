import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { createChartService } from '../src/app/chart-service.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { historicalHeatPumpIntervals, recordHeatPumpConfiguration } from '../src/app/chart-heat-pump.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const day = chartRange({ startDate: '2026-01-15', now: Date.parse('2026-01-16T12:00:00Z') });
const start = day.from;
const config = { heatPumpCompressorKw: 3, circulationKw: 0.08, auxRatedKw: 9 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const observation = (signal, value, at, extra = {}) => ({ source: 'husdata-h66', device: 'invented-gateway', signal, value,
  unit: signal === 'compressor_active' ? 'state' : '%', sourceTime: at, receivedAt: at,
  quality: [], raw: { verified: true, usableForControl: true }, ...extra });
const record = (store, at, duty = 1, output = 0, extra = {}) => {
  for (const [signal, value] of [['compressor_active', duty], ['auxiliary_output', output]]) store.observation(observation(signal, value, at, extra));
};
const intervals = (store, now, input = 'mqtt') => [...historicalHeatPumpIntervals({ store: { db: store.db }, range: day, now, input })];
const energy = rows => rows.reduce((sum, row) => sum + (row.kw ?? 0) * (row.end - row.start) / HOUR, 0);
const at = (rows, time) => rows.find(row => row.start <= time && row.end > time)?.kw;

test('nominal configuration changes split energy at their actual time and never rewrite older power', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  record(store, start, 1, 33);
  recordHeatPumpConfiguration(store, 'mqtt', config, start + MINUTE);
  recordHeatPumpConfiguration(store, 'mqtt', config, start + 2 * MINUTE);
  recordHeatPumpConfiguration(store, 'mqtt', { ...config, heatPumpCompressorKw: 4, auxRatedKw: 12 }, start + 3 * MINUTE);
  recordHeatPumpConfiguration(store, 'simulated', { ...config, heatPumpCompressorKw: 99 }, start + 4 * MINUTE);
  const result = intervals(store, start + 5 * MINUTE);
  assert.equal(at(result, start), null, 'No current-settings assumption before the first saved configuration');
  near(at(result, start + MINUTE), 6.08);
  near(at(result, start + 3 * MINUTE), 8.08);
  near(energy(result), (2 * 6.08 + 2 * 8.08) / 60);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE type='heat-pump-power-config'").get().n, 3);
  assert.equal(result.find(row => row.kw === 6.08).configId, 1);
  assert.equal(result.find(row => row.kw === 8.08).configId, 2);
  assert.deepEqual(intervals(store, start + 3 * MINUTE), result.filter(row => row.end <= start + 3 * MINUTE));
});

test('missing or unverified readbacks expire promptly and never fall back to a saved model estimate', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  record(store, start, 1, 0);
  store.observation(observation('heat_pump_power', 99, start, { source: 'controller-estimate', unit: 'kW' }));
  const before = intervals(store, start + 12 * MINUTE);
  near(at(before, start), 3.08);
  assert.equal(at(before, start + 5 * MINUTE), null);
  record(store, start + 6 * MINUTE, 1, 0, { raw: { usableForControl: true } });
  record(store, start + 7 * MINUTE, 1, null);
  record(store, start + 8 * MINUTE, 1, 0, { quality: ['retained'] });
  record(store, start + 9 * MINUTE, 0, 0);
  const result = intervals(store, start + 12 * MINUTE);
  for (const minute of [5, 6, 7, 8]) assert.equal(at(result, start + minute * MINUTE), null);
  assert.equal(at(result, start + 9 * MINUTE), 0, 'Recorded off states are known zero energy, not a missing period');
  near(energy(result), 3.08 * 5 / 60);
});

test('fresh saved coverage supports longer recorder intervals and a failure breaks it at acquisition time', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  const recorder = new Recorder(store, { });
  for (let minute = 0; minute <= 10; minute++) for (const signal of ['compressor_active', 'auxiliary_output'])
    recorder.record(observation(signal, signal === 'compressor_active' ? 1 : 0, start + minute * MINUTE));
  assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 2);
  near(energy(intervals(store, start + 10 * MINUTE)), 3.08 / 6);
  const failureAt = start + 10 * MINUTE + 15_000;
  recorder.recordFailure({ source: 'husdata-h66', device: 'invented-gateway', signal: 'compressor_active', unit: 'state', at: failureAt });
  // Connection recovery still needs a newly usable source value.
  recorder.record(observation('compressor_active', 1, start + 11 * MINUTE));
  const result = intervals(store, start + 12 * MINUTE);
  assert.equal(at(result, failureAt), null);
  near(at(result, start + 11 * MINUTE), 3.08);
  near(energy(result), 3.08 * (11 * MINUTE + 15_000) / HOUR);
});

test('a cached unchanged source clock cannot extend heat-pump coverage indefinitely', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  const recorder = new Recorder(store, { });
  for (const minute of [0, 4, 6, 10]) for (const signal of ['compressor_active', 'auxiliary_output'])
    recorder.record(observation(signal, signal === 'compressor_active' ? 1 : 0, start, { receivedAt: start + minute * MINUTE }));
  const result = intervals(store, start + 12 * MINUTE);
  near(energy(result), 3.08 * 5 / 60);
  for (const minute of [5, 6, 10]) assert.equal(at(result, start + minute * MINUTE), null);
});

test('future coverage confirmations cannot renew the inputs of an earlier chart query', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  const recorder = new Recorder(store, { });
  for (let minute = 0; minute <= 10; minute++) for (const signal of ['compressor_active', 'auxiliary_output'])
    recorder.record(observation(signal, signal === 'compressor_active' ? 1 : 0, start + minute * MINUTE));
  const result = intervals(store, start + 8 * MINUTE);
  near(energy(result), 3.08 * 5 / 60);
  assert.equal(at(result, start + 5 * MINUTE), null);
});

test('a silent acquisition gap remains a gap even when unchanged values share one saved observation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  const recorder = new Recorder(store, { });
  for (const minute of [0, 10]) for (const signal of ['compressor_active', 'auxiliary_output'])
    recorder.record(observation(signal, signal === 'compressor_active' ? 1 : 0, start + minute * MINUTE));
  assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 2, 'No change to value selection or thresholds');
  assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, 4, 'Separate confirmations preserve the silent gap');
  const result = intervals(store, start + 12 * MINUTE);
  near(energy(result), 3.08 * 7 / 60);
  assert.equal(at(result, start + 7 * MINUTE), null);
  near(at(result, start + 10 * MINUTE), 3.08);
});

test('a delayed fresh arrival retains the information gap before its receipt', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  const recorder = new Recorder(store, { });
  for (const [sourceMinute, receivedMinute] of [[0, 0], [4, 6]]) for (const signal of ['compressor_active', 'auxiliary_output'])
    recorder.record(observation(signal, signal === 'compressor_active' ? 1 : 0, start + sourceMinute * MINUTE,
      { receivedAt: start + receivedMinute * MINUTE }));
  assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, 4,
    'The previous source expired before the later receipt even though source validity overlaps');
  const result = intervals(store, start + 8 * MINUTE);
  near(energy(result), 3.08 * 7 / 60);
  assert.equal(at(result, start + 5 * MINUTE), null);
  near(at(result, start + 6 * MINUTE), 3.08);
});

test('switching physical acquisition mode back restores that mode’s dated assumptions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  record(store, start);
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  recordHeatPumpConfiguration(store, 'providers', { ...config, heatPumpCompressorKw: 4 }, start + MINUTE);
  recordHeatPumpConfiguration(store, 'mqtt', config, start + 2 * MINUTE);
  const result = intervals(store, start + 3 * MINUTE);
  near(at(result, start), 3.08); near(at(result, start + MINUTE), 4.08); near(at(result, start + 2 * MINUTE), 3.08);
});

test('simulation and different devices cannot supply missing physical equipment inputs', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  recordHeatPumpConfiguration(store, 'simulated', config, start);
  store.observation(observation('compressor_active', 1, start));
  store.observation(observation('auxiliary_output', 0, start, { device: 'invented-other-gateway' }));
  record(store, start, 0.5, 0, { source: 'simulation', device: 'invented-simulation', raw: null, quality: ['simulated'] });
  assert.equal(energy(intervals(store, start + MINUTE)), 0);
  assert.ok(intervals(store, start + MINUTE).every(row => row.kw === null));
  near(energy(intervals(store, start + MINUTE, 'simulated')), 1.54 / 60);
});

test('engine preserves nominal settings on first use and changes without writing a standalone power series', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = start;
  const engineConfig = { input: 'simulated', control: config, settings: { mode: 'shadow' } };
  let engine = new Engine({ store, config: engineConfig, clock: () => now });
  engine.tick(); now += MINUTE; engine.tick();
  engine = new Engine({ store, config: engineConfig, clock: () => now }); engine.tick();
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE type='heat-pump-power-config'").get().n, 1);
  now += MINUTE;
  engine = new Engine({ store, config: { ...engineConfig, control: { ...config, heatPumpCompressorKw: 4 } }, clock: () => now }); engine.tick();
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE type='heat-pump-power-config'").get().n, 2);
  assert.equal(store.db.prepare("SELECT count(*) n FROM observations WHERE signal='heat_pump_power'").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM recorder_metrics WHERE key LIKE '%heat_pump_power%'").get().n, 0);
  assert.ok(intervals(store, now, 'simulated').some(row => row.kw !== null));
});

test('read-only worker and compact range reconstruct the same priced energy without depending on chart points', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-reconstructed-power-'));
  const store = new Store(join(directory, 'synthetic.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  recordHeatPumpConfiguration(store, 'mqtt', config, start);
  for (let minute = 0; minute <= 60; minute += 5) record(store, start + minute * MINUTE, minute < 30 ? 1 : 0, minute < 30 ? 33 : 0);
  const prices = { fetchedAt: start, intervals: [{ start, end: start + 30 * MINUTE, spotCtPerKwh: 0, unit: 'c/kWh', vatIncluded: false },
    { start: start + 30 * MINUTE, end: day.to, spotCtPerKwh: 20, unit: 'c/kWh', vatIncluded: false }] };
  const contract = { periods: [{ from: start, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night',
    transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] };
  const args = { input: 'mqtt', now: start + HOUR, startDate: day.startDate, endDate: day.endDate,
    left: 'heat_pump_power', market: prices, contract, points: 100 };
  const direct = getChartData({ ...args, store }), threaded = await service.query(args);
  assert.deepEqual(threaded.series, direct.series);
  assert.deepEqual(threaded.timingBenefit, direct.timingBenefit);
  near(direct.timingBenefit.heatPump.energyKwh, 3.04);
  assert.equal(direct.timingBenefit.heatPump.coverage, 1);
  const evidence = direct.timingBenefit.heatPump.evidence;
  assert.equal(evidence.energyBasis, 'reconstructed-equipment');
  assert.equal(evidence.timeBasis, 'recorded-interval-time');
  near(evidence.sources[0].energyKwh, 3.04);
  assert.deepEqual(evidence.sources.map(({ energyKwh, ...source }) => source), [{ key: 'observed', durationMs: HOUR,
    firstAt: start, lastAt: start + HOUR, share: 1 }]);
  assert.equal(evidence.auxiliaryAssumedMs, 0);
  assert.equal(evidence.auxiliaryUnknownMs, 0);
  const excluded = getChartData({ ...args, store, market: null });
  assert.equal(excluded.timingBenefit.heatPump.value, null);
  assert.equal(excluded.timingBenefit.heatPump.coverageDetails.powerMs, HOUR);
  assert.equal(excluded.timingBenefit.heatPump.coverageDetails.incompletePriceMs, HOUR);
  assert.equal(excluded.timingBenefit.heatPump.coverageDetails.missingPowerMs, 0);
  assert.ok(direct.series.heat_pump_power.some(row => row.y === 6.08));
  for (const extra of [{ left: 'learning_profit', points: 2000 }, { endDate: '2026-02-15', points: 100 }]) {
    const result = getChartData({ ...args, ...extra, store });
    assert.deepEqual(result.timingBenefit, direct.timingBenefit);
  }
  recordHeatPumpConfiguration(store, 'mqtt', { ...config, heatPumpCompressorKw: 4 }, start + 15 * MINUTE);
  const changed = await service.query(args);
  near(changed.timingBenefit.heatPump.energyKwh, 3.29);
  assert.notDeepEqual(changed.series.heat_pump_power, direct.series.heat_pump_power, 'Configuration-only changes invalidate the worker cache');
});

test('worker caches renew unchanged source coverage and growing pending energy without new observation IDs',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'stmq-source-coverage-cache-'));
  const store=new Store(join(directory,'synthetic.sqlite')),service=createChartService({store}),recorder=new Recorder(store);
  t.after(async()=>{await service.close();store.close();rmSync(directory,{recursive:true,force:true});});
  for(const signal of ['compressor_active','dhw_routing']) recorder.record(observation(signal,signal==='compressor_active'?1:0,start,{unit:'state'}));
  const args={input:'mqtt',now:start+9*MINUTE,startDate:day.startDate,endDate:day.endDate,left:'power'};
  const before=await service.query(args),revision=store.db.prepare('SELECT MAX(id) id FROM observations').get().id;
  const pastArgs={...args,startDate:'2026-01-14',endDate:'2026-01-14'};
  await service.query(pastArgs);
  assert.equal(before.shading.compressorHome.at(-1).end,start+5*MINUTE);
  for(const signal of ['compressor_active','dhw_routing']) recorder.record(observation(signal,signal==='compressor_active'?1:0,start+4*MINUTE,{unit:'state'}));
  assert.equal(store.db.prepare('SELECT MAX(id) id FROM observations').get().id,revision);
  const after=await service.query(args);
  assert.equal(after.shading.compressorHome.at(-1).end,start+9*MINUTE);
  assert.notEqual(after.meta.cacheHit,true);
  assert.equal((await service.query(pastArgs)).meta.cacheHit,true,'Current equipment reports preserve unrelated completed history');
  assert.equal((await service.query(args)).meta.cacheHit,true);

  const recordEnergy=minute=>recorder.recordEnergy({source:'synthetic-charger',device:'synthetic-charger',prefix:'ev2',
    start:start+minute*MINUTE,end:start+(minute+1)*MINUTE,energies:[0.1],powers:[6],quality:[]});
  recordEnergy(0);recordEnergy(1);
  const energyBefore=await service.query(args),energyRevision=store.db.prepare('SELECT MAX(id) id FROM observations').get().id;
  await service.query(pastArgs);
  recordEnergy(2);
  assert.equal(store.db.prepare('SELECT MAX(id) id FROM observations').get().id,energyRevision);
  const energyAfter=await service.query(args);
  assert.ok(energyBefore.series.charger2_power.some(row=>row.intervalEnd===start+2*MINUTE));
  assert.ok(energyAfter.series.charger2_power.some(row=>row.intervalEnd===start+3*MINUTE));
  assert.notEqual(energyAfter.meta.cacheHit,true);
  assert.equal((await service.query(pastArgs)).meta.cacheHit,true,'An unrelated current tail preserves completed historical plots');

  const asOfArgs={...args,now:start+3*MINUTE};
  assert.ok((await service.query(asOfArgs)).series.charger2_power.some(row=>row.pending));
  recordEnergy(3);
  const asOfAfter=await service.query(asOfArgs);
  assert.notEqual(asOfAfter.meta.cacheHit,true,'A tail extended beyond the receipt cutoff is no longer eligible');
  assert.ok(asOfAfter.series.charger2_power.every(row=>!row.pending));

  const simulationEnergy=minute=>recorder.recordEnergy({source:'simulation',device:'synthetic-simulation',prefix:'ev2',
    start:start+minute*MINUTE,end:start+(minute+1)*MINUTE,energies:[0.1],powers:[6],quality:['simulated']});
  simulationEnergy(0);simulationEnergy(1);
  await service.query(args);
  const simulatedArgs={...args,input:'simulated'};
  await service.query(simulatedArgs);
  simulationEnergy(2);
  assert.equal((await service.query(args)).meta.cacheHit,true,'Simulation tails do not invalidate physical history');
  assert.notEqual((await service.query(simulatedArgs)).meta.cacheHit,true);
});
