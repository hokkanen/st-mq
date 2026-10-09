import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/charging-joint-fixture.js';

async function externalCurrent(f, value) {
  f.advance(1000);
  f.fields.current_limit = { value, at: f.now, source: 'rpc' };
  await f.settle();
}

async function adjust(f, householdA = 0) {
  f.household.currentA = householdA;
  f.advance(5000);
  await f.runtime.reconcileShellyObservation();
}

test('a confirmed connection supersedes a pre-plug adjustable current with Automatic off', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await externalCurrent(f, 9);
  assert.equal(f.fields.current_limit.value, 9);
  f.cars.charger2.demandA = 16;
  await f.connect('charger2');
  await adjust(f);
  const view = f.view('charger2');
  assert.equal(view.settings.enabled, false);
  assert.equal(view.control.manualCurrentA, null);
  assert.equal(f.fields.current_limit.value, 16);
  assert.ok(f.commands.some(command => command.role === 'current_limit' && command.value === 16));
  assert.equal(view.control.limiter.fallback, false);
});

test('a later native current cap survives owned adjustments and restart but expires at the next connection', async t => {
  const f = await fixture(t, { budgetA: 25 });
  f.cars.charger2.demandA = 16;
  await f.connect('charger2');
  await adjust(f);
  await externalCurrent(f, 9);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  assert.equal(f.fields.current_limit.value, 9);
  const session = f.view('charger2').request.sessionId;

  await adjust(f, 19);
  assert.equal(f.fields.current_limit.value, 6, 'Real household load can require a lower owned setting');
  assert.equal(f.view('charger2').control.manualCurrentA, 9, 'The owned setting does not replace the external cap');
  await adjust(f);
  assert.equal(f.fields.current_limit.value, 9);
  await f.restart();
  await adjust(f);
  assert.equal(f.view('charger2').request.sessionId, session);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  assert.equal(f.fields.current_limit.value, 9);

  await f.disconnect('charger2');
  await f.connect('charger2');
  await adjust(f);
  assert.notEqual(f.view('charger2').request.sessionId, session);
  assert.equal(f.view('charger2').control.manualCurrentA, null);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.view('charger2').settings.enabled, false);
});

test('an owned current setting stays adjustable across polling and same-session restart', async t => {
  const f = await fixture(t, { budgetA: 25 });
  f.cars.charger2.demandA = 16;
  await f.connect('charger2');
  await adjust(f, 16);
  assert.equal(f.fields.current_limit.value, 9);
  assert.equal(f.view('charger2').control.manualCurrentA, null);
  await f.settle();
  await f.restart();
  await adjust(f);
  assert.equal(f.fields.current_limit.value, 16, 'A previously confirmed owned 9 A write is not a native cap');
  assert.equal(f.view('charger2').control.manualCurrentA, null);
});

test('a newer same-value native current selection has session precedence over the earlier owned write', async t => {
  const f = await fixture(t, { budgetA: 25 });
  f.cars.charger2.demandA = 16;
  await f.connect('charger2');
  await adjust(f, 16);
  assert.equal(f.fields.current_limit.value, 9);
  assert.equal(f.view('charger2').control.manualCurrentA, null);
  await externalCurrent(f, 9);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  await adjust(f);
  assert.equal(f.fields.current_limit.value, 9, 'A distinct native selection survives recovered property headroom');
});

test('Use automatic supersedes the current-session native cap while adopting economic scheduling', async t => {
  const f = await fixture(t, { budgetA: 25 });
  f.cars.charger2.demandA = 16;
  await f.connect('charger2');
  await f.plan();
  await externalCurrent(f, 9);
  let view = f.view('charger2');
  assert.equal(view.control.manualCurrentA, 9);
  assert.equal(view.control.takeover.available, true);
  await f.runtime.useAutomatic('charger2', { ...f.scope('charger2'), controlRevision: view.controls.revision,
    takeoverToken: view.control.takeover.token });
  await adjust(f);
  view = f.view('charger2');
  assert.equal(view.settings.enabled, true);
  assert.equal(view.control.manualCurrentA, null);
  assert.equal(f.fields.current_limit.value, f.runtime.configuration.chargers.charger2.fallbackCurrentA,
    'The economic wait keeps the idle fallback after superseding the external cap');
  assert.equal(view.control.reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false, 'Taking control does not skip the selected cheap charging period');
  const commandBoundary = f.commands.length;
  f.advance(view.plan.startAt - f.now);
  await f.settle();
  const resumed = f.commands.slice(commandBoundary);
  const current = resumed.findIndex(command => command.role === 'current_limit' && command.value === 16);
  const start = resumed.findIndex(command => command.role === 'start_charging' && command.value === true);
  assert.ok(current >= 0 && start > current, 'The unrestricted allocation is confirmed before the scheduled Start');
  assert.equal(f.view('charger2').control.manualCurrentA, null);
  assert.equal(f.fields.current_limit.value, 16);
});

test('the Automatic scheduling switch does not supersede a later native current cap', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2');
  await f.plan();
  await externalCurrent(f, 9);
  await f.automatic('charger2', true);
  await adjust(f);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  assert.equal(f.fields.current_limit.value, 9);
  await f.automatic('charger2', false);
  await adjust(f);
  assert.equal(f.view('charger2').control.manualCurrentA, 9);
  assert.equal(f.fields.current_limit.value, 9);
});

test('the explicit current-control opt-out preserves a pre-plug native setting', async t => {
  const f = await fixture(t, { limiter: false, budgetA: 25 });
  await externalCurrent(f, 9);
  await f.connect('charger2');
  await f.plan();
  await adjust(f);
  assert.equal(f.fields.current_limit.value, 9);
  await f.automatic('charger2', true);
  await adjust(f);
  assert.equal(f.fields.current_limit.value, 9);
  assert.equal(f.commands.filter(command => command.role === 'current_limit').length, 0);
});

for (const limiter of [false, true])
  test(`the takeover forecast supersedes only the adjustable current policy; limiter ${limiter}`, async t => {
    const f = await fixture(t, { limiter, budgetA: 25 });
    await f.connect('charger2');
    await f.plan();
    await externalCurrent(f, 9);
    const view = f.view('charger2'), candidates = [];
    const calculate = f.runtime.plannerService.request.bind(f.runtime.plannerService);
    t.mock.method(f.runtime.plannerService, 'request', options => {
      if (f.runtime.chargers.charger2.takeoverAttempt) {
        const candidate = options.chargers.find(charger => charger.id === 'charger2');
        candidates.push({ nativeLimit: candidate.values.nativeCurrentA.value,
          savedLimit: candidate.control.manualCurrentA, maximum: candidate.values.maximumCurrentA.value,
          observedSetting: candidate.values.currentA.value,
          publishedLimit: f.view('charger2').values.nativeCurrentA.value });
      }
      return calculate(options);
    });
    await f.runtime.useAutomatic('charger2', { ...f.scope('charger2'), controlRevision: view.controls.revision,
      takeoverToken: view.control.takeover.token });
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0].nativeLimit, limiter ? null : 9);
    assert.equal(candidates[0].savedLimit, limiter ? null : 9);
    assert.equal(candidates[0].publishedLimit, 9, 'The prospective plan does not erase the unconfirmed native restriction');
    assert.equal(candidates[0].observedSetting, 9, 'Native readback remains observed, even when a candidate supersedes its instruction');
    assert.equal(candidates[0].maximum, 16, 'The fixed charger ceiling is retained');
  });
