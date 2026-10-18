import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, START, HOUR } from './helpers/charging-joint-fixture.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';

async function drain(runtime) {
  for (let i = 0; i < 20; i++) {
    await runtime.planningFlight;
    await new Promise(resolve => setImmediate(resolve));
    await runtime.flexibilityFlight;
    if (!runtime.flexibilityScheduled && !runtime.flexibilityFlight) return;
  }
  assert.fail('Comparison queue did not settle');
}

async function ready(t) {
  const f = await fixture(t), runtime = f.runtime;
  let futurePrice = 10, forecastStart = 24, fetchedAt = START;
  runtime.engine.contract = () => ({ periods: [{ from: 0, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0,
    tariff: 'day-night', transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0,
      winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] });
  runtime.engine.electricityForecast = { snapshot: () => ({ enabled: true, available: true, fetchedAt,
    generatedAt: fetchedAt, expiresAt: START + 48 * HOUR,
    intervals: Array.from({ length: 48 }, (_, i) => ({ start: START + i * HOUR, end: START + (i + 1) * HOUR,
      spotCtPerKwh: i >= forecastStart ? futurePrice : 10, unit: 'c/kWh', vatIncluded: false, predicted: true })) }) };
  f.cars.charger1.allows = f.cars.charger2.allows = false;
  const calls = [], compare = runtime.plannerService.compare.bind(runtime.plannerService);
  runtime.plannerService.compare = async (options, comparison) => {
    calls.push(comparison.chargerId);
    return compare(options, comparison);
  };
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  await f.connect('charger1'); await f.connect('charger2'); await f.plan(); await drain(runtime);
  return { ...f, get now() { return f.now; }, runtime, calls, drain: () => drain(runtime),
    forecast(value, start = 24) { futurePrice = value; forecastStart = start; fetchedAt = f.now; },
    async assess() { await runtime.updatePlan(f.now, { background: true }); await drain(runtime); } };
}

test('both cards receive automatic cached comparisons and published snapshots without browser requests', async t => {
  const f = await ready(t);
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).flexibility.preview?.available, true, JSON.stringify(f.view(id).flexibility));
    assert.equal(f.view(id).flexibility.comparisonPending, false);
    const saved = readChargingRuntime(f.store, 'charging:mqtt').view.chargers.find(row => row.id === id);
    assert.deepEqual(saved.flexibility.preview, f.view(id).flexibility.preview);
    assert.equal(saved.flexibility.comparisonPending, false);
  }
  const before = f.calls.length, view = f.view('charger1');
  const results = await Promise.all(Array.from({ length: 3 }, () => f.runtime.previewFlexibility('charger1', {
    association: view.association, sessionId: view.request.sessionId, revision: view.request.revision })));
  assert(results.every(result => result.comparison.available));
  assert.equal(f.calls.length, before, 'Browsers reuse the same completed comparison');
});

test('normal planning tolerances suppress clock churn and subthreshold household drift for savings too', async t => {
  const f = await ready(t), before = f.calls.length;
  for (let i = 0; i < 6; i++) {
    f.advance(1000); f.forecast(10);
    f.runtime.household = f.runtime.household.map(row => ({ ...row,
      phaseCurrentA: row.phaseCurrentA.map(value => value + .01) }));
    await f.assess();
  }
  assert.equal(f.calls.length, before, 'Changed but immaterial inputs must not enter the worker');
  assert.equal(f.runtime.chargers.charger1.flexibilityRefresh.dueAt, null);
});

test('tomorrow-only price changes refresh both comparisons after normal settling without a normal search', async t => {
  const f = await ready(t), before = f.calls.length;
  let normalSearches = 0;
  const request = f.runtime.plannerService.request.bind(f.runtime.plannerService);
  f.runtime.plannerService.request = options => { normalSearches++; return request(options); };
  f.advance(1000); f.forecast(-5); await f.assess();
  assert.equal(f.calls.length, before);
  const due = f.runtime.chargers.charger1.flexibilityRefresh.dueAt;
  assert.equal(due, f.now + 10_000);
  f.advance(5000); f.forecast(-5); await f.assess();
  assert.equal(f.runtime.chargers.charger1.flexibilityRefresh.dueAt, due, 'Identical forecast receipts cannot extend settling');
  f.advance(5000); await f.assess();
  assert.equal(f.calls.length, before + 2);
  assert.equal(normalSearches, 0, 'The changed forecast is outside the ordinary joint horizon');
  for (const id of ['charger1', 'charger2']) assert(f.view(id).flexibility.preview.savingsCents > 0);
  await f.assess(); assert.equal(f.calls.length, before + 2);
});

test('small household changes accumulate against the searched comparison until the normal threshold is crossed', async t => {
  const f = await ready(t), before = f.calls.length;
  for (let i = 0; i < 3; i++) {
    f.advance(1000);
    f.runtime.household = f.runtime.household.map(row => ({ ...row,
      phaseCurrentA: row.phaseCurrentA.map(value => value + .1) }));
    await f.assess();
    assert.equal(f.calls.length, before);
    assert.equal(Boolean(f.runtime.chargers.charger1.flexibilityRefresh.dueAt), i === 2);
  }
  f.advance(10_000); await f.assess();
  assert.equal(f.calls.length, before + 2);
});

test('changing future forecasts cannot postpone a comparison beyond normal maximum settling', async t => {
  const f = await ready(t), before = f.calls.length;
  f.advance(1000); f.forecast(-5); await f.assess();
  const firstAt = f.now;
  for (let i = 1; i <= 6; i++) {
    f.advance(9000); f.forecast(-5 - i); await f.settle(); await f.assess();
    assert.equal(f.calls.length, before);
    const state = f.runtime.chargers.charger1.flexibilityRefresh;
    assert(state.dueAt <= firstAt + 60_000, JSON.stringify({ i, firstAt, now: f.now, dueAt: state.dueAt,
      firstPendingAt: state.pending?.firstAt, lastPendingAt: state.pending?.lastAt }));
  }
  f.advance(6000); await f.settle(); await f.assess();
  assert.equal(f.calls.length, before + 2);
});

test('prices outside both comparison horizons and a delayed worker start do not cause repeated comparisons', async t => {
  const f = await ready(t), before = f.calls.length;
  f.advance(1000); f.forecast(-5, 47); await f.assess();
  assert.equal(f.calls.length, before, 'A changed forecast outside the compared horizon has no numerical effect');
  // Admit optional work, then model time advancing before its immediate runs.
  f.forecast(-5); await f.runtime.updatePlan(f.now, { background: true });
  f.advance(10_000); await f.runtime.updatePlan(f.now, { background: true });
  f.advance(250); await f.drain();
  assert.equal(f.calls.length, before + 2);
  for (const item of Object.values(f.runtime.chargers)) assert(item.flexibilityRefresh.until > f.now);
  await f.assess(); await f.assess();
  assert.equal(f.calls.length, before + 2, 'A period beginning at calculation time is not a future expiry');
});

test('manual requests join automatic work and a failed comparison does not spin on unchanged input', async t => {
  const f = await ready(t), view = f.view('charger1');
  const state = f.runtime.chargers.charger1.flexibilityRefresh;
  state.reason = 'planning-unavailable';
  let calls = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.runtime.plannerService.compare = () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); };
  const input = { association: view.association, sessionId: view.request.sessionId, revision: view.request.revision };
  const first = f.runtime.previewFlexibility('charger1', input);
  // A second request's admission can precede the optional worker's immediate.
  await f.runtime.planningFlight;
  const second = f.runtime.previewFlexibility('charger1', input);
  await started;
  await f.runtime.planningFlight;
  release({ available: false, reason: 'price-coverage-unavailable' });
  await Promise.all([first, second]); await f.drain();
  assert.equal(calls, 1);
  await f.assess(); await f.assess();
  assert.equal(calls, 1, 'Unavailable outcomes wait for changed inputs or an explicit retry');
  assert.equal(f.view('charger1').flexibility.preview.available, true, 'The previous dated estimate remains visible');
});

test('failed preview publication restores the previous estimate and refresh status together', async t => {
  const f = await ready(t), runtime = f.runtime;
  const original = f.view('charger1').flexibility.preview;
  const saved = readChargingRuntime(f.store, 'charging:mqtt');
  const state = runtime.chargers.charger1.flexibilityRefresh;
  state.reason = 'planning-unavailable';
  const persist = runtime.persist.bind(runtime);
  runtime.plannerService.compare = async () => ({ ...original, at: f.now + 1, savingsCents: 999 });
  runtime.persist = () => { persist(); throw Error('Synthetic publication failure'); };
  await assert.rejects(runtime.calculateFlexibilityPreview('charger1'), /Synthetic publication failure/);
  runtime.persist = persist;
  assert.deepEqual(f.view('charger1').flexibility.preview, original);
  assert.equal(state.reason, 'planning-unavailable');
  assert.deepEqual(readChargingRuntime(f.store, 'charging:mqtt'), saved);
  await runtime.calculateFlexibilityPreview('charger1');
  const published = readChargingRuntime(f.store, 'charging:mqtt').view.chargers.find(row => row.id === 'charger1');
  assert.equal(published.flexibility.preview.savingsCents, 999);
  assert.equal(published.flexibility.refreshReason, null);
});
