import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers } from '../src/charging/planner.js';
import { createChargingPlannerService } from '../src/charging/planner-service.js';
import { chargingPlannerWorkload } from './support/charging-planner-workload.js';

const HOUR = 3_600_000, now = Date.parse('2026-10-03T00:00:00Z');
const reading = value => ({ value, available: true, assumed: false });
function smallRequest(id = 'charger1') {
  return { now, supply: { configuredBudgetCurrentA: [16, 16, 16] },
    prices: [30, 30, 1, 1, 30, 30].map((priceCtPerKwh, index) => ({
      start: now + index * HOUR / 4, end: now + (index + 1) * HOUR / 4, priceCtPerKwh,
    })),
    chargers: [{ id, label: id, requiredGridKwh: 4.14, deadlineAt: now + 1.5 * HOUR,
      settings: { enabled: true }, capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: true },
      values: { connected: reading(true), charging: reading(false), currentA: reading(16), maximumCurrentA: reading(16),
        actualCurrentA: reading(0), voltageV: reading(230), powerKw: reading(0), minimumSoc: reading(80),
        vehicleCeilingSoc: reading(80), soc: reading(20) }, control: {}, telemetry: {},
    }],
  };
}
function serviceFor(t) {
  const service = createChargingPlannerService();
  t.after(() => service.close());
  return service;
}

test('worker preserves the complete planner result and selects available cheap delivery', async t => {
  const service = serviceFor(t), options = smallRequest(), before = structuredClone(options);
  const result = await service.request(options);
  assert.deepEqual(result, planChargers(options));
  assert.equal(result.plans.charger1.feasible, true);
  assert.ok(result.plans.charger1.startAt >= now + HOUR / 2);
  assert.ok(result.plans.charger1.finishAt <= now + HOUR);
  assert.deepEqual(options, before, 'Worker planning cannot mutate live request inputs');
});

test('worker preserves optimistic future capacity across transient fallback and explicit opt-out changes', async t => {
  const service = serviceFor(t), options = smallRequest('charger2'), charger = options.chargers[0];
  charger.capabilities = { scheduling: true, currentControl: true, externalLoadBalancing: false };
  charger.configuration = { maximumCurrentA: 16, limiterEnabled: true, fallbackCurrentA: 12 };
  charger.requiredGridKwh = 14;
  const initial = await service.request(options);
  assert.equal(initial.plans.charger2.feasible, true);
  assert.ok(Math.abs(initial.plans.charger2.deliveredGridKwh - 14) < 1e-6);
  charger.configuration.limiterEnabled = false; charger.capabilities.currentControl = false;
  assert.equal((await service.request(options)).plans.charger2.feasible, true);
  charger.configuration.limiterEnabled = true; charger.capabilities.currentControl = true;
  charger.configuration.fallbackCurrentA = 8;
  const lower = await service.request(options);
  assert.equal(lower.plans.charger2.feasible, true);
  assert.ok(Math.abs(lower.plans.charger2.deliveredGridKwh - 14) < 1e-6);
});

test('busy worker retains its running request and only the newest waiting request', async t => {
  const service = serviceFor(t);
  const first = service.request(smallRequest('first'));
  const superseded = service.request(smallRequest('superseded'));
  const newest = service.request(smallRequest('newest'));
  assert.equal(await superseded, null);
  const [firstResult, newestResult] = await Promise.all([first, newest]);
  assert.deepEqual(Object.keys(firstResult.plans), ['first']);
  assert.deepEqual(Object.keys(newestResult.plans), ['newest']);
  assert.equal(firstResult.plans.first.feasible, true);
  assert.equal(newestResult.plans.newest.feasible, true);
});

test('control work interrupts an optional comparison instead of waiting behind it', async t => {
  const service = serviceFor(t), options = smallRequest();
  const comparison = { chargerId: 'charger1', normalReadyByAt: options.chargers[0].deadlineAt,
    deferredReadyByAt: options.chargers[0].deadlineAt + 24 * HOUR };
  const preview = service.compare(options, comparison);
  const control = service.request(smallRequest('control'));
  assert.equal(await preview, null, 'The optional result is withdrawn as soon as native planning needs the worker');
  const result = await control;
  assert.equal(result.plans.control.feasible, true);
  assert.deepEqual(result, planChargers(smallRequest('control')));
  assert.equal((await service.compare(options, comparison)).available, true, 'A later comparison still works');
});

test('interrupting a comparison retains only the newest control and closes all waiting callers', async t => {
  const service = serviceFor(t), options = smallRequest();
  const comparison = { chargerId: 'charger1', normalReadyByAt: options.chargers[0].deadlineAt,
    deferredReadyByAt: options.chargers[0].deadlineAt + 24 * HOUR };
  const preview = service.compare(options, comparison);
  const superseded = service.request(smallRequest('superseded'));
  const newest = service.request(smallRequest('newest'));
  const queuedPreview = service.compare(options, comparison);
  const closing = service.close();
  assert.deepEqual(await Promise.all([preview, superseded, newest, queuedPreview]), [null, null, null, null]);
  await closing;
  assert.equal(await service.request(options), null);
});

test('closing resolves both pending requests without publishing a plan or accepting more work', async t => {
  const service = serviceFor(t);
  const active = service.request(smallRequest());
  const queued = service.request(smallRequest('queued'));
  const closing = service.close();
  assert.deepEqual(await Promise.all([active, queued]), [null, null]);
  await closing;
  assert.equal(await service.request(smallRequest()), null);
  await service.close();
});

test('queued calculations retain their submitted prices and limits when the caller changes its objects', async t => {
  const service = serviceFor(t), options = smallRequest();
  const first = service.request(smallRequest('first'));
  const expected = planChargers(structuredClone(options));
  const queued = service.request(options);
  options.prices[2].priceCtPerKwh = 500;
  options.chargers[0].values.maximumCurrentA.value = 6;
  assert.deepEqual(await queued, expected);
  await first;
});

test('a structured-clone failure is sanitized and a subsequent request gets a working worker', async t => {
  const service = serviceFor(t);
  const invalid = smallRequest();
  invalid.chargers[0].values.soc.provenance = () => 'synthetic private detail';
  await assert.rejects(service.request(invalid),
    { message: 'Charging planning is temporarily unavailable.' });
  const result = await service.request(smallRequest());
  assert.equal(result.plans.charger1.feasible, true);
});

test('a failed calculation rejects only that request and the newest queued request still completes', async t => {
  const service = serviceFor(t);
  const failed = assert.rejects(service.request({ ...smallRequest(), prices: null }),
    { message: 'Charging planning is temporarily unavailable.' });
  const next = service.request(smallRequest());
  await failed;
  assert.equal((await next).plans.charger1.feasible, true);
});

test('equivalent recent inputs reuse the calculation time and return independent complete results', async t => {
  const service = serviceFor(t), options = smallRequest();
  const first = await service.request(options), expected = structuredClone(first);
  first.plans.charger1.periods[0].startAt = -1;
  first.plans.charger1.warnings.push('Synthetic caller mutation');
  const second = await service.request({ ...options, now: now + 1000 });
  assert.deepEqual(second, expected, 'Reusing a plan retains its original computation timestamp and unaffected nested data');
  second.plans.charger1.soc.value = 99;
  assert.deepEqual(await service.request({ ...options, now: now + 2000 }), expected);
});

test('transport receipts and prior display output do not repeat an unchanged numerical search', async t => {
  const service = serviceFor(t), options = smallRequest();
  const first = await service.request(options);
  const refreshed = structuredClone(options);
  refreshed.now += 1000;
  refreshed.chargers[0].telemetry = { receivedAt: refreshed.now, powerHistory: [1, 2, 3] };
  refreshed.chargers[0].values.currentA.at = refreshed.now;
  refreshed.chargers[0].values.currentA.receivedAt = refreshed.now;
  refreshed.chargers[0].control.updatedAt = refreshed.now;
  refreshed.chargers[0].control.phase = 'reading';
  refreshed.chargers[0].plan = first.plans.charger1;
  refreshed.chargers[0].diagnostics = { samples: 20 };
  assert.deepEqual(await service.request(refreshed), first);
});

test('changed electrical limits and SoC evidence replace a cached calculation', async t => {
  const service = serviceFor(t), options = smallRequest();
  await service.request(options);
  const limited = structuredClone(options);
  limited.now += 1000;
  limited.chargers[0].values.maximumCurrentA.value = 8;
  const result = await service.request(limited);
  assert.equal(result.at, limited.now);
  assert.ok(result.allocations.every(row => (row.chargers.charger1?.currentA ?? 0) <= 8));
  limited.now += 1000;
  limited.chargers[0].values.soc.measuredAt = now - HOUR;
  const evidence = await service.request(limited);
  assert.equal(evidence.at, limited.now);
  assert.equal(evidence.plans.charger1.soc.measuredAt, now - HOUR,
    'Current result provenance cannot come from a cached older SoC report');
});

test('calculation age and clock reversal force a new plan instead of renewing cached evidence', async t => {
  const service = serviceFor(t), options = smallRequest();
  assert.equal((await service.request(options)).at, now);
  assert.equal((await service.request({ ...options, now: now + 29_999 })).at, now);
  assert.equal((await service.request({ ...options, now: now + 30_000 })).at, now + 30_000);
  assert.equal((await service.request({ ...options, now: now - 1000 })).at, now - 1000);
});

test('crossing a scheduled start recomputes before the ordinary cache age expires', async t => {
  const service = serviceFor(t), options = smallRequest();
  options.now = now + HOUR / 2 - 10_000;
  const waiting = await service.request(options);
  assert.equal(waiting.plans.charger1.startAt, now + HOUR / 2);
  assert.equal((await service.request({ ...options, now: now + HOUR / 2 - 1 })).at, options.now);
  const starting = await service.request({ ...options, now: now + HOUR / 2 });
  assert.equal(starting.at, now + HOUR / 2);
  assert.equal(starting.plans.charger1.startAt, now + HOUR / 2);
});

test('a full-day joint search leaves main-thread heartbeats running after the worker has warmed up', async t => {
  const service = serviceFor(t);
  await service.request(smallRequest());
  let beats = 0, pending = true, lastBeat = performance.now(), largestGapMs = 0;
  const heartbeat = setInterval(() => {
    const at = performance.now();
    if (pending) { beats++; largestGapMs = Math.max(largestGapMs, at - lastBeat); }
    lastBeat = at;
  }, 5);
  t.after(() => clearInterval(heartbeat));
  const result = await service.request(chargingPlannerWorkload()).finally(() => { pending = false; });
  assert.ok(beats >= 3, `Other main-thread work must run repeatedly during the joint search; observed ${beats} heartbeats`);
  assert.equal(result.plans.charger1.feasible, true);
  assert.equal(result.plans.charger2.feasible, true);
  t.diagnostic(`96 price intervals, two chargers, six household scenarios: ${beats} heartbeats; largest observed gap ${largestGapMs.toFixed(1)} ms`);
});
