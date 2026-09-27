import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Chart from 'chart.js/auto';
import { Store } from '../src/storage/store.js';
import { chartRange, Envelope, getChartData } from '../src/app/chart-data.js';
import { addGarageHistory } from '../src/app/chart-garage.js';
import { createChartService } from '../src/app/chart-service.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { appendGarageEntry, applyGarageEntry, garageCorrectionContext } from '../src/garage/learning.js';
import { createGarageModel, garageModelSummary, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { GARAGE_COEFFICIENT_INFO, GARAGE_OUTCOME_INFO, HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';
import { historyDatasets } from '../chart/history-model.js';
import { clipChartSeries } from '../chart/chart-resolution.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, range = chartRange({ startDate: '2026-09-08' });
const rear = 'garage_outcome_rear_reference', front = 'garage_outcome_front_reference';
const rearError = 'garage_outcome_rear_error', frontError = 'garage_outcome_front_error', benefit = 'garage_outcome_benefit';
const replayKeys = [rear, front, rearError, frontError];
function chart(store, selected, options = {}) {
  const selectedRange = options.range ?? range;
  const envelopes = Object.fromEntries(selected.map(key => [key, new Envelope(selectedRange.from, selectedRange.to, 800)]));
  const stats = addGarageHistory({ store, range: selectedRange, now: range.to, input: 'providers', envelopes, ...options });
  return { stats, series: Object.fromEntries(Object.entries(envelopes).map(([key, value]) => [key, value.values()])) };
}
function seedModel({ initialized = true, errors = true } = {}) {
  const seed = createGarageModel({ seedAt: range.from, roomTargetC: 8 });
  if (initialized) Object.assign(seed.normalReference, { initialized: true, interceptC: 8.1, frontC: 7.8,
    qualifiedHours: 2.5, samples: 12, availableSince: range.from - 10 * HOUR, settledC: 8.1 });
  if (errors) seed.validation.episodes = [
    { id: 0, role: 'validation', clean: true, complete: true, thermalPassed: true, trainingSupportHours: 1,
      offHours: 1, recoveryHours: 3, offRearRmse: 0, offFrontRmse: .2, rearRmse: .1, frontRmse: .2, rearBias: 0, frontBias: 0 },
    { id: 1, role: 'validation', clean: true, complete: false, thermalPassed: false, trainingSupportHours: 1,
      offHours: 2, recoveryHours: 6, offRearRmse: .6, offFrontRmse: .8, rearRmse: .6, frontRmse: .8, rearBias: 0, frontBias: 0 },
    { id: 2, role: 'training', clean: true, complete: true, offHours: 1, offRearRmse: 9, offFrontRmse: 9 },
    { id: 3, role: 'validation', clean: false, complete: true, offHours: 1, offRearRmse: 9, offFrontRmse: 9 },
  ];
  return seed;
}
function seed(store, model = seedModel(), input = 'providers', at = range.from) {
  return appendGarageEntry(store, input, 'context', {}, garageSettings(), at, { seed: model });
}
function sample(store, at, input = 'providers', changes = {}) {
  return appendGarageEntry(store, input, 'sample', { at, rearAt: at, rearC: 8.1, frontAt: at, frontC: 7.8,
    outdoorAt: at, outdoorC: -5, available: true, baselineAccepted: true, doorFront: false, doorRear: false,
    ev1Kw: 0, ev2Kw: 0, powerKw: .4, powerQuality: 'provisional', ...changes }, garageSettings(), at);
}
function cycle(store, id, { assessment, ...changes } = {}, input = 'providers') {
  const value = { id, status: 'completed', startedAt: range.from - HOUR, endedAt: range.from + HOUR,
    algorithmVersion: GARAGE_ALGORITHM_VERSION, ...changes,
    assessment: { algorithmVersion: GARAGE_ALGORITHM_VERSION, stage: 'completed', basis: 'garage-frozen-normal-reference',
      includesGarageOnly: true, profitCents: 125, uncertaintyCents: 25, referenceCostCents: 200, actualCostCents: 75,
      electricityBasis: 'qualified-recorded-electricity', ...assessment } };
  store.cycle(`garage:${input}`, value); return value;
}
function renderReference(t, payload, bounds) {
  const canvas = { width: 1000, height: 500 };
  const ctx = new Proxy({ canvas, measureText: value => ({ width: String(value).length * 7 }) }, { get: (target, key) => target[key] ?? (() => {}) });
  canvas.getContext = () => ctx;
  const datasets = historyDatasets(clipChartSeries(payload.series, bounds), { leftSignals: [], rightSignals: [rear] });
  const plot = new Chart(canvas, { type: 'line', data: { datasets }, options: {
    responsive: false, animation: false, parsing: false,
    scales: { x: { type: 'linear', min: bounds.from, max: bounds.to }, right: { type: 'linear', position: 'right' } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  } });
  t.after(() => plot.destroy());
  return at => {
    const point = plot.getDatasetMeta(0).dataset.interpolate({ x: plot.scales.x.getPixelForValue(at) }, 'x');
    return point && !Array.isArray(point) ? plot.scales.right.getValueForPixel(point.y) : undefined;
  };
}

test('garage outcomes project achieved references and all clean held-out OFF errors without private model payloads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const model = seedModel(); model.syntheticPrivateIdentifier = 'synthetic-do-not-disclose';
  seed(store, model);
  const expected = garageModelSummary(model), original = store.learningJournal({ input: 'garage:providers' });
  store.db.exec('PRAGMA query_only=ON');
  const result = chart(store, replayKeys);
  assert.equal(result.series[rear][0].y, 8.1); assert.equal(result.series[front][0].y, 7.8);
  for (const [key, value] of [[rearError, expected.validation.offRearRmse], [frontError, expected.validation.offFrontRmse]]) {
    assert.equal(result.series[key][0].y, value);
    assert.equal(result.series[key][0].evidenceCount, 2, 'Failed clean holdouts remain part of prediction quality');
    assert.equal(result.series[key][0].evidenceHours, 3);
    assert.equal(result.series[key][0].outcomeBasis, 'rolling-clean-held-out-off-episode-rmse');
  }
  assert.equal(result.series[rear][0].evidenceCount, 12);
  assert.equal(result.series[rear][0].evidenceHours, 2.5);
  for (const points of Object.values(result.series)) assert(points.every(point => point.modelOutcome === true
    && point.algorithmVersion === GARAGE_ALGORITHM_VERSION && typeof point.correctionRevision === 'string'
    && point.inputSource === 'Recorded garage inputs' && point.modelUpdatedAt === range.from));
  assert(!JSON.stringify(result).includes('synthetic-do-not-disclose'));
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), original);
});

test('selected room settings and missing holdouts remain unknown while achieved zero and zero error are retained', t => {
  const empty = new Store(':memory:'), zero = new Store(':memory:'); t.after(() => { empty.close(); zero.close(); });
  seed(empty, seedModel({ initialized: false, errors: false }));
  const missing = chart(empty, replayKeys);
  for (const points of Object.values(missing.series)) assert(points.length && points.every(point => point.y === null));
  const model = seedModel(); model.normalReference.interceptC = 0;
  model.validation.episodes = [model.validation.episodes[0]];
  seed(zero, model);
  const result = chart(zero, [rear, rearError]);
  assert(result.series[rear].every(point => point.y === 0));
  assert(result.series[rearError].every(point => point.y === 0 && point.evidenceCount === 1));
});

test('outcome and coefficient selections share one read-only replay and equal reference values retain new evidence', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const entry = seed(store), first = sample(store, range.from + MINUTE);
  let scanned = 0;
  const facade = { db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    if (!sql.includes('SELECT * FROM learning_journal WHERE input=? AND id>? AND id<=?')) return statement;
    return { *iterate(...args) { for (const row of statement.iterate(...args)) { scanned++; yield row; } } };
  } } };
  chart(facade, Object.keys(GARAGE_COEFFICIENT_INFO));
  const before = chart(facade, replayKeys);
  assert.equal(scanned, 2, 'Selecting outcomes reuses coefficient replay');
  const second = sample(store, range.from + 2 * MINUTE);
  const after = chart(facade, [...Object.keys(GARAGE_COEFFICIENT_INFO), ...replayKeys]);
  assert.equal(scanned, 3);
  const context = garageCorrectionContext(store, 'providers');
  const checkpoint = [entry, first, second].reduce((state, value) => applyGarageEntry(state, value, context), null);
  assert.equal(after.series[rear].at(-1).y, before.series[rear].at(-1).y);
  assert(after.series[rear].at(-1).evidenceCount > before.series[rear].at(-1).evidenceCount);
  assert.equal(after.series[rear].at(-1).evidenceCount, garageModelSummary(checkpoint.model).normalReference.samples);
  for (const key of replayKeys) assert.deepEqual(after.series[key], chart(store, [key]).series[key]);
  chart(facade, replayKeys, { now: range.from + MINUTE });
  assert.equal(scanned, 5, 'Earlier as-of replays only the eligible prefix');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
});

test('reference reset, source correction and reversal create gaps and invalidate cached outcome provenance', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seed(store);
  const before = chart(store, replayKeys);
  const change = addSensorChange(store, 'providers', { signal: 'garage_temperature_2', reason: 'replacement', requestId: 'fixture-change' }, range.from + MINUTE);
  appendGarageEntry(store, 'providers', 'context', { sensorChangeId: change.id }, garageSettings(), range.from + MINUTE);
  const changed = chart(store, replayKeys);
  assert(changed.series[rear].some(point => point.x === range.from + MINUTE && point.y === null));
  assert.equal(changed.series[rearError].at(-1).y, null);
  const original = store.learningJournal({ input: 'garage:providers' });
  revertSensorChange(store, 'providers', { id: change.id, requestId: 'fixture-revert' }, range.from + 2 * MINUTE);
  const restored = chart(store, replayKeys);
  assert.equal(restored.series[rear].at(-1).y, 8.1);
  assert.notEqual(restored.series[rear][0].correctionRevision, before.series[rear][0].correctionRevision);
  assert.deepEqual(store.learningJournal({ input: 'garage:providers' }), original);
  appendGarageEntry(store, 'providers', 'context', { normalReferenceReset: true, roomTargetC: 9 }, garageSettings(), range.from + 3 * MINUTE);
  const reset = chart(store, replayKeys);
  assert.equal(reset.series[rear].at(-1).y, null, 'A new selected setting is not achieved warmth');
  assert.equal(reset.series[rearError].at(-1).y, null, 'Reset validation cannot inherit prior holdouts');
});

test('achieved reference detail keeps genuine neighboring cubic knots and cannot interpolate through reset gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seed(store);
  for (const [minutes, rearC] of [[10, 8.1], [20, 8.5], [30, 8.3], [40, 8.4]])
    sample(store, range.from + minutes * MINUTE, 'providers', { rearC });
  appendGarageEntry(store, 'providers', 'context', { normalReferenceReset: true, roomTargetC: 9 }, garageSettings(), range.from + 45 * MINUTE);
  const options = { store, input: 'providers', startDate: range.startDate, left: rear, now: range.from + 50 * MINUTE };
  const overview = getChartData(options);
  const view = { from: range.from + 25 * MINUTE, to: range.from + 27 * MINUTE };
  const detail = getChartData({ ...options, viewFrom: view.from, viewTo: view.to });
  assert(detail.series[rear].some(point => point.displayContext && point.x === range.from + 30 * MINUTE));
  assert(!overview.series[rear].some(point => point.x === range.from + 20 * MINUTE - 1));
  const full = renderReference(t, overview, { from: range.from, to: options.now });
  const zoom = renderReference(t, overview, view), fetched = renderReference(t, detail, view);
  for (const minutes of [25, 26, 27]) {
    const at = range.from + minutes * MINUTE;
    assert(Math.abs(full(at) - zoom(at)) < 1e-8);
    assert(Math.abs(full(at) - fetched(at)) < 1e-8);
  }
  assert(Math.abs(fetched(view.from) - fetched(view.to)) > 1e-6, 'Finite reference updates form a curve, not a held viewport');
  const gap = { from: range.from + 46 * MINUTE, to: range.from + 48 * MINUTE };
  const missing = getChartData({ ...options, viewFrom: gap.from, viewTo: gap.to });
  assert.equal(renderReference(t, missing, gap)(range.from + 47 * MINUTE), undefined);
});

test('sparse achieved references retain exact cubic detail outside sensor context without crossing selected dates or now', t => {
  const store = new Store(':memory:'), freshStore = new Store(':memory:'); t.after(() => { store.close(); freshStore.close(); });
  for (const target of [store, freshStore]) {
    seed(target);
    for (let hour = 0; hour <= 26; hour++) sample(target, range.from + hour * HOUR, 'providers', { rearC: 8.1 + hour * .005 });
  }
  const options = { store, input: 'providers', startDate: range.startDate, endDate: '2026-09-09', left: rear,
    now: range.from + 26.5 * HOUR };
  const view = { from: range.from + 21.5 * HOUR, to: range.from + 21.75 * HOUR };
  const overview = getChartData(options);
  const detail = getChartData({ ...options, viewFrom: view.from, viewTo: view.to });
  const fresh = getChartData({ ...options, store: freshStore, viewFrom: view.from, viewTo: view.to });
  assert.deepEqual(detail.series[rear], fresh.series[rear]);
  assert(detail.series[rear].some(point => point.displayContext && point.x === range.from + 18 * HOUR));
  assert(detail.series[rear].some(point => point.displayContext && point.x === range.from + 25 * HOUR));
  assert(detail.series[rear].filter(point => point.x < view.from).length <= 8);
  assert(detail.series[rear].filter(point => point.x > view.to).length <= 8);
  const fullPlot = renderReference(t, overview, { from: range.from, to: options.now });
  const zoom = renderReference(t, overview, view), fetched = renderReference(t, detail, view);
  for (const at of [view.from, (view.from + view.to) / 2, view.to]) {
    assert(Math.abs(fullPlot(at) - zoom(at)) < 1e-8);
    assert(Math.abs(fullPlot(at) - fetched(at)) < 1e-8);
  }
  assert(Math.abs(fetched(view.from) - fetched(view.to)) > 1e-6);
  for (const cutoff of [{ endDate: range.startDate }, { now: range.from + 23 * HOUR }]) {
    const bounded = getChartData({ ...options, ...cutoff, viewFrom: view.from, viewTo: view.to });
    const last = cutoff.endDate ? range.to : cutoff.now;
    assert(bounded.series[rear].every(point => point.x <= last));
    assert.equal(renderReference(t, bounded, view)(view.from), overview.series[rear].find(point => point.x === range.from + 18 * HOUR).y);
  }
  const coefficient = Object.keys(GARAGE_COEFFICIENT_INFO)[0];
  const short = getChartData({ ...options, left: coefficient, viewFrom: view.from, viewTo: view.to });
  assert.equal(short.meta.garageHistory.replayedRecords, 23, 'Coefficient-only detail stops before later source records');
});

test('outcome replay isolates inputs, future dependency order, unsupported versions and fresh epochs', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seed(store);
  const other = seedModel(); other.normalReference.interceptC = 11;
  seed(store, other, 'simulated');
  assert.equal(chart(store, [rear], { input: 'simulated' }).series[rear][0].y, 11);
  assert.equal(chart(store, [rear], { input: 'offline' }).series[rear].length, 0);
  sample(store, range.from + 30 * MINUTE); sample(store, range.from + 10 * MINUTE);
  assert.equal(chart(store, [rear], { now: range.from + 20 * MINUTE }).stats.replayedRecords, 1);
  store.appendLearningJournal('garage:providers', { kind: 'context', at: range.from + 31 * MINUTE,
    algorithmVersion: 'unsupported-future', payload: { value: {} } });
  sample(store, range.from + 32 * MINUTE);
  const blocked = chart(store, replayKeys);
  assert.equal(blocked.stats.unsupportedRecords, 1); assert.equal(blocked.stats.invalidRecords, 1);
  for (const points of Object.values(blocked.series)) assert.equal(points.at(-1).y, null);
  store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?)').run('garage:providers', 'fixture-fresh-epoch');
  seed(store, seedModel({ initialized: false, errors: false }));
  const fresh = chart(store, replayKeys);
  assert.equal(fresh.stats.replayedRecords, 1);
  for (const points of Object.values(fresh.series)) assert(points.every(point => point.y === null));
});

test('frozen garage benefit points obey source, completion date, as-of and current assessment qualifications', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  cycle(store, 'positive');
  cycle(store, 'negative', { endedAt: range.from + 2 * HOUR, assessment: { profitCents: -50 } });
  cycle(store, 'zero', { endedAt: range.from + 3 * HOUR, assessment: { profitCents: 0 } });
  cycle(store, 'before-range', { startedAt: range.from - 2 * HOUR, endedAt: range.from - MINUTE });
  cycle(store, 'next-date', { endedAt: range.to });
  cycle(store, 'different-input', {}, 'simulated');
  const rejected = [
    { status: 'active', endedAt: null }, { status: 'incomplete' }, { startedAt: range.from + HOUR },
    { algorithmVersion: 'old-garage' }, { assessment: { algorithmVersion: 'old-garage' } },
    { assessment: { algorithmVersion: undefined } }, { assessment: { stage: 'forecast' } },
    { assessment: { basis: 'different-model' } }, { assessment: { includesGarageOnly: false } },
    { assessment: { includesGarageOnly: 1 } }, { assessment: { profitCents: '125' } },
    { assessment: { profitCents: true } }, { assessment: { profitCents: null } },
  ];
  rejected.forEach((changes, index) => cycle(store, `unqualified-${index}`, changes));
  store.db.exec('PRAGMA query_only=ON');
  const result = chart(store, [benefit]);
  assert.deepEqual(result.series[benefit].map(point => [point.x, point.y]), [
    [range.from + HOUR, 1.25], [range.from + 2 * HOUR, -.5], [range.from + 3 * HOUR, 0],
  ]);
  assert.equal(result.stats.assessmentRecords, 3);
  assert.deepEqual(chart(store, [benefit], { now: range.from + 2 * HOUR }).series[benefit].map(point => point.y), [1.25, -.5]);
  assert.equal(chart(store, [benefit], { input: 'offline' }).series[benefit].length, 0);
  const middle = chart(store, [benefit], { range: { ...range, from: range.from + 90 * MINUTE, to: range.from + 150 * MINUTE } });
  assert.deepEqual(middle.series[benefit].map(point => [point.x, point.y]), [[range.from + 2 * HOUR, -.5]], 'Events are neither carried from before selection nor extended past completion');
  assert(result.series[benefit].every(point => point.intervalStart === range.from - HOUR && point.intervalEnd === point.x
    && point.provisional === true && point.uncertaintyEuro === .25 && point.referenceCostEuro === 2 && point.actualCostEuro === .75));
});

test('benefit projection allowlists metadata and cannot be supplied by recorder observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  cycle(store, 'fixture-private-id', { frozenModel: { privateIdentifier: 'synthetic-do-not-disclose' },
    assessment: { electricityBasis: 'synthetic-do-not-disclose', uncertaintyCents: -1,
      referenceCostCents: true, actualCostCents: '75', privateIdentifier: 'synthetic-do-not-disclose' } });
  store.observation({ source: 'controller-learning', device: 'providers', signal: benefit, value: 999,
    unit: '€/episode', sourceTime: range.from + 2 * HOUR, receivedAt: range.from + 2 * HOUR });
  for (const left of Object.keys(GARAGE_OUTCOME_INFO)) assert.equal(HISTORY_AXIS_BY_KEY[left].signals[0], left);
  const result = getChartData({ store, input: 'providers', startDate: range.startDate, now: range.to, left: benefit });
  assert.equal(result.series[benefit].length, 1); assert.equal(result.series[benefit][0].y, 1.25);
  for (const field of ['electricityBasis', 'uncertaintyEuro', 'referenceCostEuro', 'actualCostEuro'])
    assert(!Object.hasOwn(result.series[benefit][0], field), field);
  assert(!JSON.stringify(result.series[benefit]).includes('synthetic-do-not-disclose'));
  assert(!JSON.stringify(result.series[benefit]).includes('fixture-private-id'));
});

test('worker-cached garage outcome queries match fresh reads and refresh corrected frozen assessments', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'garage-outcome-chart-'));
  const store = new Store(join(directory, 'fixture.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = cycle(store, 'fixture-episode'); seed(store);
  const args = { input: 'providers', now: range.to, startDate: range.startDate, left: benefit };
  const first = await service.query(args);
  assert.deepEqual(first.series[benefit], getChartData({ store, ...args }).series[benefit]);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.cycle('garage:providers', { ...saved, assessment: { ...saved.assessment, profitCents: -25 } });
  const changed = await service.query(args);
  assert.notEqual(changed.meta.cacheHit, true); assert.equal(changed.series[benefit][0].y, -.25);
  for (const left of replayKeys) {
    const worker = await service.query({ ...args, left });
    assert.deepEqual(worker.series[left], getChartData({ store, ...args, left }).series[left]);
  }
});
