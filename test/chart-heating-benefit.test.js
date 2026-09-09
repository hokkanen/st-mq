import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { getHeatingBenefit } from '../src/app/chart-heating-benefit.js';
import { createChartService } from '../src/app/chart-service.js';

const HOUR = 3_600_000;
const date = '2026-09-08';
const range = chartRange({ startDate: date, now: Date.parse('2026-09-09T12:00:00Z') });
const now = range.to + HOUR;
function save(store, id, changes = {}, input = 'providers') {
  const cycle = { id: `synthetic-${id}`, status: 'completed', startedAt: range.from + HOUR,
    endedAt: range.from + 3 * HOUR,
    assessment: { profitCents: 125, uncertaintyCents: 25, referenceCostCents: 300,
      actualSpaceHeatingCostCents: 175, basis: 'estimated-space-heating-execution-and-reference' }, ...changes };
  store.cycle(input, cycle);
  return cycle;
}
function summary(store, changes = {}) { return getHeatingBenefit({ store, input: 'providers', range, now, ...changes }); }

test('heating model totals full cycles by completion date, with exact range and input boundaries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  save(store, 'earlier-start', { startedAt: range.from - 4 * HOUR, endedAt: range.from });
  save(store, 'today');
  save(store, 'too-early', { startedAt: range.from - 2 * HOUR, endedAt: range.from - 1 });
  save(store, 'next-day', { endedAt: range.to });
  save(store, 'another-input', {}, 'simulated');
  const before = store.cycles({ input: 'providers' });
  const result = summary(store);
  assert.equal(result.status, 'estimated');
  assert.equal(result.valueEuro, 2.5);
  assert.deepEqual(result.counts, { assessed: 2, completed: 2, unassessed: 0, incomplete: 0, active: 0, startedBeforeSelection: 1 });
  assert.equal(result.selectionBasis, 'cycles-completed-in-range');
  assert.equal(result.firstStartedAt, range.from - 4 * HOUR);
  assert.equal(result.lastEndedAt, range.from + 3 * HOUR);
  assert.deepEqual(result.estimateRange, { lowerEuro: 2, upperEuro: 3 });
  assert.equal(result.referenceCostEuro, 6);
  assert.equal(result.actualSpaceHeatingCostEuro, 3.5);
  assert.deepEqual(store.cycles({ input: 'providers' }), before, 'Summaries never alter stored assessments or frozen history');
  assert(!JSON.stringify(result).includes('synthetic-'), 'Private cycle identifiers are not returned');
});

test('uncorrected comparable assessments alone contribute; excluded attempts stay visible as counts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  save(store, 'active', { status: 'active', endedAt: null });
  save(store, 'incomplete', { status: 'incomplete' });
  save(store, 'corrected-null', { assessment: { profitCents: null, basis: 'unassessed-corrected-fireplace-history' } });
  save(store, 'unattributable', { assessment: { profitCents: 50, basis: 'unassessed-missing-space-heating-attribution' } });
  save(store, 'unknown-basis', { assessment: { profitCents: 50, basis: 'old-whole-cycle-estimate' } });
  const corrected = save(store, 'correction-marker', { fireplaceCorrectionRevision: 2 });
  save(store, 'string-number', { assessment: { ...corrected.assessment, profitCents: '125' } });
  let result = summary(store);
  assert.equal(result.valueEuro, null);
  assert.equal(result.reason, 'no-assessed-cycles');
  assert.deepEqual(result.counts, { assessed: 0, completed: 5, unassessed: 5, incomplete: 1, active: 1, startedBeforeSelection: 0 });
  save(store, 'valid-negative', { assessment: { profitCents: -10, basis: 'estimated-space-heating-execution-and-reference' } });
  result = summary(store);
  assert.equal(result.valueEuro, -0.1);
  assert.equal(result.estimateRange, null, 'Missing uncertainty is never invented');
  assert.equal(result.referenceCostEuro, null);
  assert.equal(result.actualSpaceHeatingCostEuro, null);
});

test('zero is available only with assessed cycles and selected totals have no rolling-cycle limit', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(summary(store).reason, 'no-completed-cycles');
  assert.equal(summary(store).valueEuro, null);
  for (let i = 0; i < 40; i++) save(store, `cycle-${i}`, {
    assessment: { profitCents: i % 2 ? -10 : 10, basis: 'estimated-space-heating-execution-and-reference' },
  });
  const result = summary(store);
  assert.equal(result.status, 'estimated');
  assert.equal(result.valueEuro, 0);
  assert.equal(result.counts.assessed, 40);
  assert.equal(summary(store, { now: range.from }).reason, 'no-elapsed-time');
  assert.equal(summary(store, { now: range.from + 2 * HOUR }).valueEuro, null, 'Future completions cannot enter an elapsed selection');
  assert.equal(summary(store, { now: range.from + 3 * HOUR }).counts.assessed, 40, 'A completion recorded exactly now is included');
});

test('heating card receives the same total on every chart axis and resolution, independently of rolling metric observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  save(store, 'chart-assessment');
  store.observation({ source: 'controller-learning', device: 'providers', signal: 'learning_profit',
    value: 99, unit: 'EUR/cycle', sourceTime: range.from, receivedAt: range.from,
    quality: ['estimated'], raw: { count: 30, basis: 'Synthetic rolling mean' } });
  const args = { store, input: 'providers', now, startDate: date, endDate: date };
  for (const [left, points] of [['power', 100], ['integral', 800], ['learning_profit', 2000]]) {
    const chart = getChartData({ ...args, left, points });
    assert.deepEqual(chart.heatingBenefit, summary(store));
    assert.equal(chart.heatingBenefit.valueEuro, 1.25);
  }
});

test('historical worker cache follows assessment edits without telemetry and ignores unrelated state or observation tapes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chart-heating-benefit-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const args = { input: 'providers', now, startDate: date, endDate: date };
  const cycle = save(store, 'cache-assessment');
  assert.equal((await service.query(args)).heatingBenefit.valueEuro, 1.25);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.setState('synthetic-unrelated-checkpoint', { tick: 2 });
  store.cycle('providers', { ...cycle, observations: [{ synthetic: true }] });
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.cycle('providers', { ...cycle, assessment: { ...cycle.assessment, profitCents: -50 } });
  let result = await service.query(args);
  assert.notEqual(result.meta.cacheHit, true);
  assert.equal(result.heatingBenefit.valueEuro, -0.5);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.cycle('providers', { ...cycle, assessment: { ...cycle.assessment, profitCents: null,
    basis: 'unassessed-corrected-fireplace-history' } });
  result = await service.query(args);
  assert.notEqual(result.meta.cacheHit, true);
  assert.equal(result.heatingBenefit.valueEuro, null);
  assert.equal(result.heatingBenefit.counts.unassessed, 1);
});
