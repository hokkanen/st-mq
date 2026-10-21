import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sample, observation, recover, start, W } from './helpers/recovery-fixture.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { readCoefficientCoverage, readCoefficientEvents, createCoefficientGeneration, appendCoefficientEvents } from '../src/storage/coefficient-history.js';
import { MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { emptyCoefficientProjection } from '../src/domain/coefficient-projection.js';
import { getChartData } from '../src/app/chart-data.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';

function context(store, at, lossPerHour) {
  appendLearningRecord(store, 'mqtt', 'context', { timestamp: at,
    historySeed: { model: initialAdaptiveModel({ thermalPriors: { lossPerHour } }), source: { basis: 'invented-recovery-coefficients' } },
  }, { config: {} });
}
async function revise(f, recoveryId, active) {
  const args = { store: f.master, input: 'mqtt', recoveryId, active, signal: f.signal };
  return reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
}
function selected(f, checkpoint) {
  const coverage = readCoefficientCoverage(f.master, { input: 'mqtt' });
  assert.equal(coverage.epoch, f.master.learningEpoch('mqtt'));
  assert.equal(coverage.cursor, checkpoint.journalCursor);
  assert.equal(coverage.fireplaceRevision, checkpoint.fireplaceRevision ?? 0);
  assert.equal(coverage.sensorRevision, checkpoint.sensorRevision ?? 0);
  const events = readCoefficientEvents(f.master, { input: 'mqtt' });
  assert(events.length > 0);
  for (const event of events) assert.deepEqual(Object.keys(event.coefficients).sort(), Object.keys(MODEL_COEFFICIENT_INFO).sort());
  return { coverage, events };
}

test('recovery revert and restore publish all four coefficient histories with their matching model and preserved prefix', async t => {
  const f = fixture(t);
  context(f.master, start, .02); sample(f.master, start + W);
  const prior = replayLearningJournal(f.master, 'mqtt'), original = selected(f, prior);
  const donor = await f.donor(); context(donor, start + 2 * W, .04); sample(donor, start + 3 * W);
  replayLearningJournal(donor, 'mqtt');
  context(f.master, start + 4 * W, .06); sample(f.master, start + 5 * W);
  const later = replayLearningJournal(f.master, 'mqtt', prior), before = selected(f, later);
  assert.equal(before.coverage.generation, original.coverage.generation);
  const result = await recover(f, await f.snapshot(donor), { onProgress(value) {
    if (['projecting', 'rebuilding', 'publishing'].includes(value.phase))
      assert.equal(readCoefficientCoverage(f.master, { input: 'mqtt' }).generation, before.coverage.generation,
        'unpublished staged coefficient rows cannot replace the selected chart history');
  } });
  let data = selected(f, result.checkpoint);
  assert.notEqual(data.coverage.generation, before.coverage.generation);
  assert(data.events.some(event => event.at === start && event.coefficients.model_coefficient_heat_loss.value === .02), 'proven old prefix stays visible');
  assert(data.events.some(event => event.at === start + 2 * W && event.coefficients.model_coefficient_heat_loss.value === .04), 'recovered change is recorded');
  assert.equal(data.events.at(-1).coefficients.model_coefficient_heat_loss.value, .06, 'later local model choice remains');
  for (const key of Object.keys(MODEL_COEFFICIENT_INFO)) {
    const chart = getChartData({ store: f.master, input: 'mqtt', startDate: '2026-01-01', now: start + 6 * W, left: key });
    assert(chart.series[key].some(point => Number.isFinite(point.y)), `${key} reads committed history directly`);
  }
  const abandoned=f.master.transaction(()=>{
    const source=f.master.db.prepare('SELECT id FROM learning_journal WHERE input=? ORDER BY id LIMIT 1').get('mqtt');
    const cursor=Number(f.master.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,source_entry_id)
      SELECT 'revision:invented-unpublished',input,key||':abandoned',kind,at,algorithm_version,COALESCE(source_entry_id,id)
      FROM learning_journal_entries WHERE id=?`).run(source.id).lastInsertRowid);
    const projection={cursor,at:start,learned:[],fitted:[],blocked:false,coefficients:data.events[0].coefficients};
    const generation=createCoefficientGeneration(f.master,'mqtt',{epoch:'revision:invented-unpublished',projection:emptyCoefficientProjection()});
    appendCoefficientEvents(f.master,generation,{events:[{cursor,at:start,coefficients:projection.coefficients,projection}],projection});
    return{cursor,generation};
  });
  let changed = await revise(f, result.report.recoveryId, false); data = selected(f, changed.checkpoint);
  assert.equal(f.master.db.prepare('SELECT id FROM coefficient_generations WHERE id=?').get(abandoned.generation),undefined,
    'a known abandoned staging generation is removed before its journal row');
  assert.equal(f.master.db.prepare('SELECT id FROM learning_journal_entries WHERE id=?').get(abandoned.cursor),undefined);
  assert(!data.events.some(event => event.coefficients.model_coefficient_heat_loss.value === .04));
  assert.equal(data.events.at(-1).coefficients.model_coefficient_heat_loss.value, .06);
  changed = await revise(f, result.report.recoveryId, true); data = selected(f, changed.checkpoint);
  assert(data.events.some(event => event.coefficients.model_coefficient_heat_loss.value === .04));
  assert.equal(data.events.at(-1).coefficients.model_coefficient_heat_loss.value, .06);
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('observation-only recovery and reversal leave selected model coefficient generation unchanged', async t => {
  const f = fixture(t); context(f.master, start, .02); sample(f.master, start + W);
  const checkpoint = replayLearningJournal(f.master, 'mqtt'), original = selected(f, checkpoint);
  const donor = await f.donor(); observation(donor, start + 2 * W, 22);
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(readCoefficientCoverage(f.master, { input: 'mqtt' }).generation, original.coverage.generation);
  for (const active of [false, true]) {
    await revise(f, result.report.recoveryId, active);
    const coverage=readCoefficientCoverage(f.master, { input: 'mqtt' });
    const selection=f.master.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
    assert.equal(coverage.selection,selection,'unchanged numerical history adopts the atomically published observation selection fence');
    assert.deepEqual({...coverage,selection:original.coverage.selection},original.coverage,
      'observation selection changes preserve the coefficient generation, source revisions and numerical boundary');
    assert.deepEqual(readCoefficientEvents(f.master, { input: 'mqtt' }), original.events);
  }
});
