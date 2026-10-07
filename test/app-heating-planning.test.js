import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatingPlanning } from '../src/app/heating-planning.js';
import { chooseCycle } from '../src/control/planner.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

function rig(t) {
  const requests = [];
  const engine = { suspended: false, allowed: true,
    automation: { features: { home: { enabled: true, revision: 1 } } },
    automationTarget: () => 'a'.repeat(64), canControl() { return this.allowed; },
    automationEnabled() { return this.automation.features.home.enabled; } };
  const service = { request(input) {
    return new Promise((resolve, reject) => requests.push({ input, resolve, reject }));
  }, async close() { for (const request of requests) request.resolve(null); } };
  const planner = new HeatingPlanning(engine, service);
  t.after(() => planner.close());
  const input = heatingExplorerFixture();
  return { engine, planner, input, requests, async complete(result = chooseCycle(input), index = requests.length - 1) {
    requests[index].resolve(result);
    await planner.pending?.promise;
  } };
}

test('background search returns Normal immediately and revalidates its plan with current measurements', async t => {
  const r = rig(t);
  assert.equal(r.planner.choose(r.input).phase, 'normal');
  assert.equal(r.requests.length, 1);
  const result = chooseCycle(r.input);
  assert.ok(result.plan, 'Synthetic independent price spike admits a reduction');
  await r.complete(result);
  const updated = structuredClone(r.input);
  updated.now += 30_000;
  updated.observations.indoor.value = 21.1;
  updated.observations.indoor.observedAt = updated.now;
  const adopted = r.planner.choose(updated);
  assert.ok(adopted.plan);
  assert.equal(adopted.plan.generatedAt, updated.now);
  assert.equal(adopted.plan.initialState.indoorC, 21.1);
  assert.equal(adopted.phase, 'reduction');
});

for (const change of ['stale indoor', 'missing prices', 'native permission', 'trial budget']) {
  test(`worker result cannot bypass current ${change}`, async t => {
    const r = rig(t);
    r.planner.choose(r.input);
    const result = chooseCycle(r.input);
    if (change === 'trial budget') result.plan.trial = true;
    await r.complete(result);
    const current = structuredClone(r.input);
    if (change === 'stale indoor') current.observations.indoor.stale = true;
    if (change === 'missing prices') current.prices = [];
    if (change === 'native permission') current.equipment.externalChangeRevision = 1;
    if (change === 'trial budget') current.trialBudgetRemainingCents = 0;
    assert.equal(r.planner.choose(current).plan, null);
  });
}

for (const change of ['pause', 'authority', 'configuration', 'model', 'sensor correction', 'fireplace correction', 'expiry']) {
  test(`completed Home search is fenced after ${change}`, async t => {
    const r = rig(t);
    r.planner.choose(r.input);
    await r.complete();
    const current = structuredClone(r.input);
    if (change === 'pause') r.engine.automation.features.home.enabled = false;
    if (change === 'authority') r.engine.allowed = false;
    if (change === 'configuration') current.config.maxReductionHours = 1;
    if (change === 'model') current.checkpoint.model.parameters.lossPerHour *= 2;
    if (change === 'sensor correction') current.checkpoint.sensorRevision = 1;
    if (change === 'fireplace correction') current.checkpoint.fireplaceRevision = 1;
    if (change === 'expiry') current.now += 120_001;
    assert.equal(r.planner.choose(current).plan, null);
  });
}

test('intervening manual control, closure and superseded requests cannot resurrect search results', async t => {
  const r = rig(t);
  r.planner.choose(r.input);
  const original = r.planner.pending.promise;
  r.planner.invalidate();
  r.planner.choose(r.input);
  r.requests[0].resolve(chooseCycle(r.input));
  await original;
  assert.equal(r.planner.completed, null);
  assert.equal(r.requests.length, 2);
  await r.planner.close();
  assert.equal(r.planner.choose(r.input).plan, null);
});

test('worker failure keeps Normal and cannot trigger an immediate retry loop', async t => {
  const r = rig(t);
  r.planner.choose(r.input);
  r.requests[0].reject(new Error('Synthetic worker failure'));
  await r.planner.pending.promise;
  assert.deepEqual(r.planner.choose(r.input).reasons, ['heating-planning-unavailable']);
  assert.equal(r.requests.length, 1);
});
