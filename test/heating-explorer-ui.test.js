import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatingExplorerState, heatingComparisonMetrics } from '../chart/heating-explorer.js';

const now = Date.parse('2026-09-30T09:00:00Z');
const makeResult = (extra = {}) => ({ snapshotId: 'synthetic-snapshot', snapshotAt: now, expiresAt: now + 60_000,
  controls: [{ key: 'maxReductionHours', value: 4 }, { key: 'maxDropC', value: 1.5 }],
  current: { outcomes: { maxIndoorDropC: .7 } }, scenario: { outcomes: { maxIndoorDropC: 1.1 }, schedule: { reductionStart: now, reductionEnd: now + 6 * 3_600_000 } },
  comparison: { additionalBenefitCents: 55, additionalIndoorDropC: .4 }, application: { allowed: true }, ...extra });

test('exploration pins conditions and changes only local values until explicit comparison', async () => {
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => now, request: async (path, body) => {
    requests.push({ path, body }); return makeResult(path.endsWith('/simulate') ? { previewId: 'synthetic-preview' } : {});
  } });
  await state.load(); state.edit('maxReductionHours', 8); state.edit('unknownLimit', 99);
  assert.equal(requests.length, 1);
  assert.deepEqual(state.snapshot().limits, { maxReductionHours: 8, maxDropC: 1.5 });
  await state.compare();
  assert.deepEqual(requests[1], { path: '/api/heating/explorer/simulate', body: {
    snapshotId: 'synthetic-snapshot', limits: { maxReductionHours: 8 },
  } });
  assert.equal(state.snapshot().dirty, false);
  assert.equal(state.snapshot().limits.maxReductionHours, 8, 'server current controls do not reset a hypothetical draft');
  state.reset();
  assert.equal(state.snapshot().dirty, true);
  assert.equal(state.snapshot().limits.maxReductionHours, 4);
  assert.equal(requests.length, 2, 'reset is also read only');
});

test('busy requests suppress duplicate calculations and edits', async () => {
  let finish;
  const state = createHeatingExplorerState({ clock: () => now, request: () => new Promise(resolve => { finish = resolve; }) });
  const loading = state.load();
  assert.equal(await state.load(), false);
  state.edit('maxReductionHours', 8);
  assert.deepEqual(state.snapshot().limits, {});
  finish(makeResult()); await loading;
});

test('a late read cannot restore private comparison data after sign-out', async () => {
  let finish;
  const state = createHeatingExplorerState({ clock: () => now, request: () => new Promise(resolve => { finish = resolve; }) });
  const loading = state.load(); state.clear(); finish(makeResult());
  assert.equal(await loading, false);
  assert.equal(state.snapshot().result, null);
  assert.equal(state.snapshot().busy, false);
});

test('edited and expired previews cannot be applied and expiration does not shift the reference', async () => {
  let clock = now;
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => clock, request: async (path, body) => {
    requests.push({ path, body }); return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); state.edit('maxReductionHours', 6);
  assert.equal(await state.apply(), false);
  await state.compare(); clock += 60_001;
  assert.equal(state.snapshot().stale, true);
  assert.equal(await state.apply(), false);
  assert.equal(await state.compare(), false);
  assert.equal(state.snapshot().result.snapshotAt, now);
  assert.equal(requests.length, 2);
});

test('failed refresh retains the draft while withdrawing previous execution eligibility', async () => {
  let calls = 0;
  const state = createHeatingExplorerState({ clock: () => now, request: async () => {
    if (calls++) throw Object.assign(new Error('sensitive household detail'), { status: 503 });
    return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); state.edit('maxReductionHours', 8);
  assert.equal(await state.load(), false);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(state.snapshot().result.snapshotId, 'synthetic-snapshot');
  assert.equal(state.snapshot().stale, true);
  assert.equal(await state.apply(), false);
  assert(!state.snapshot().message.includes('sensitive'));
});

test('only the reviewed preview is submitted and approval receipts survive refreshed conditions', async () => {
  const requests = []; let clock = now;
  const state = createHeatingExplorerState({ clock: () => clock, request: async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith('/apply')) return { activeTrial: { id: 'synthetic-trial', status: 'pending' } };
    return makeResult({ previewId: 'synthetic-preview', expiresAt: now + 2 * 86400_000 });
  } });
  await state.load(); assert.equal(await state.apply(), true);
  assert.deepEqual(requests[1], { path: '/api/heating/explorer/apply', body: { previewId: 'synthetic-preview' } });
  assert.equal(state.snapshot().result.activeTrial.status, 'pending');
  assert.equal(await state.apply(), false, 'a completed submission cannot be sent again');
  await state.load();
  assert.match(state.snapshot().receipt.message, /approved/);
  clock = now + 86400_000; assert.equal(state.snapshot().receipt, null);
});

test('uncertain approval cannot be blindly retried and does not claim success', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async path => {
    if (path.endsWith('/apply')) throw new TypeError('connection lost');
    return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); assert.equal(await state.apply(), false);
  assert.equal(state.snapshot().stale, true);
  assert.equal(state.snapshot().receipt.error, true);
  assert.match(state.snapshot().message, /not be confirmed/);
  assert.equal(await state.apply(), false);
});

test('a stale server rejection retains the frozen comparison and requests refresh', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async path => {
    if (path.endsWith('/simulate')) throw Object.assign(new Error('internal stale state'), { status: 409 });
    return makeResult();
  } });
  await state.load(); state.edit('maxReductionHours', 8);
  assert.equal(await state.compare(), false);
  assert.match(state.snapshot().message, /Refresh conditions/);
  assert.equal(state.snapshot().stale, true);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
});

test('cancel is limited to a pending or running cycle and leaves restoration visible', async () => {
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => now, request: async (path, body) => {
    requests.push({ path, body });
    return path.endsWith('/cancel') ? { activeTrial: { status: 'cancelled' } }
      : makeResult({ activeTrial: { status: 'running' } });
  } });
  assert.equal(await state.cancel(), false);
  await state.load(); assert.equal(await state.cancel(), true);
  assert.deepEqual(requests[1], { path: '/api/heating/explorer/cancel', body: {} });
  assert.match(state.snapshot().receipt.message, /recovery and restoration still continue/);
  assert.equal(await state.cancel(), false);
});

test('comparison cards preserve negative savings and unknown average predictions', () => {
  const metrics = heatingComparisonMetrics(makeResult({ comparison: { additionalBenefitCents: -25, additionalIndoorDropC: .4 } }));
  assert.equal(metrics[0].value, '−€0.25');
  assert.equal(metrics[1].value, '1.1 °C');
  assert.equal(metrics[2].value, '6 h');
  const missing = heatingComparisonMetrics({ current: { outcomes: null }, scenario: { outcomes: null }, comparison: {} });
  assert.equal(missing[0].value, 'Unavailable');
  assert.equal(missing[1].value, 'Unavailable');
  assert.equal(missing[2].value, 'No reduction');
});

test('actual cycle updates leave pinned forecasts and hypothetical edits intact', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async () => makeResult({ activeTrial: { id: 'one', status: 'pending' } }) });
  await state.load(); state.edit('maxReductionHours', 8);
  const frozen = state.snapshot().result.scenario;
  state.updateTrial({ id: 'one', status: 'running' });
  assert.equal(state.snapshot().result.activeTrial.status, 'running');
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(state.snapshot().result.scenario, frozen);
  state.updateTrial({ id: 'one', status: 'completed', outcome: { profitCents: 12 } });
  assert.equal(state.snapshot().result.activeTrial.outcome.profitCents, 12);
  assert.equal(state.snapshot().dirty, true);
});
