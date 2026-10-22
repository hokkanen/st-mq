import test from 'node:test';
import assert from 'node:assert/strict';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { getFirewoodBenefit, maintainFirewoodProjection } from '../src/app/firewood-benefit.js';
import { firewoodSimulationIdentity } from '../src/domain/firewood-benefit.js';
import { createChartService } from '../src/app/chart-service.js';
import { firewoodFixture, START, DAY, HOUR, WINDOW } from './helpers/firewood-fixture.js';

function catalog(f) {
  return f.projection.db.prepare('SELECT cursor,digest FROM snapshots ORDER BY cursor').all();
}

test('a new fire preserves the exact earlier prefix through model revision adoption and restart', t => {
  const f = firewoodFixture(t); f.finish();
  const before = catalog(f), cursor = f.projection.latest('mqtt').cursor;
  const load = addFireplace(f.source, 'mqtt', { kg: 6, requestId: 'forward-load' }, f.args.now + 1);
  const args = { ...f.args, now: f.args.now + 2 };
  assert.notEqual(getFirewoodBenefit(args).summary.preparing, true);
  assert.deepEqual(catalog(f), before, 'Saving a current load must not discard or rewrite earlier states');
  assert.deepEqual(getFirewoodBenefit(args), f.oracle(args));
  assert.equal(maintainFirewoodProjection(args).processed, 0);
  f.saveModel((_model, checkpoint) => { checkpoint.fireplaceRevision = load.revision; });
  f.reopen();
  assert.equal(f.projection.latest('mqtt').cursor, cursor);
  assert.equal(f.finish(args), 0, 'Revision adoption must not fall back through the seed model');
  assert.deepEqual(getFirewoodBenefit(args), f.oracle(args));
  assert.deepEqual(catalog(f), before);
});

test('new fires catch up only new learning while removals retain exact historical correction', t => {
  const f = firewoodFixture(t); f.finish();
  const oldCursor = f.projection.latest('mqtt').cursor;
  const load = addFireplace(f.source, 'mqtt', { kg: 6, requestId: 'forward-tail-load' }, f.args.now + 1);
  f.append(10 * 96 + 1);
  const args = { ...f.args, now: f.args.now + WINDOW,
    range: { from: f.args.range.from, to: f.args.now + WINDOW },
    priceIntervals: [{ start: f.args.range.from, end: f.args.now + WINDOW, price: 20 }] };
  assert.equal(f.finish(args), 1);
  assert.ok(f.projection.latest('mqtt').cursor > oldCursor);
  assert.deepEqual(getFirewoodBenefit(args), f.oracle(args));
  removeFireplace(f.source, 'mqtt', { id: load.id, requestId: 'remove-tail-load' }, args.now + 1);
  assert.equal(getFirewoodBenefit({ ...args, now: args.now + 1 }).summary.preparing, true);
  f.finish({ ...args, now: args.now + 1 });
  assert.deepEqual(getFirewoodBenefit({ ...args, now: args.now + 1 }), f.oracle({ ...args, now: args.now + 1 }));
});

test('metadata-only model updates retain simulation and complete electrical evidence', t => {
  const f = firewoodFixture(t); f.finish();
  const expected = f.oracle(), before = catalog(f);
  f.saveModel(model => {
    model.provenance.status = 'current-holdout-failed';
    model.energy.episodes += 1; model.energy.relativeUncertainty = 1.2;
    model.uncertainty = { points: [{ hours: 1, errorC: 1 }], extrapolationCPerHour: 0.5 };
  });
  assert.equal(f.finish(), 0);
  assert.deepEqual(catalog(f), before);
  assert.deepEqual(getFirewoodBenefit(f.args), expected);
  assert.deepEqual(getFirewoodBenefit(f.args), f.oracle());
});

test('a new training time withdraws old evidence without redoing the thermal prefix', t => {
  const f = firewoodFixture(t); f.finish();
  assert.ok(getFirewoodBenefit(f.args).summary.evidence.normalObservedHours > 100);
  const cursor = f.projection.latest('mqtt').cursor;
  f.saveModel(model => { model.trainedAt = new Date(f.args.now).toISOString(); });
  assert.equal(f.finish(), 0);
  assert.equal(f.projection.latest('mqtt').cursor, cursor);
  assert.equal(f.projection.latest('mqtt').state.evidenceAfter, f.args.now);
  const result = getFirewoodBenefit(f.args);
  assert.equal(result.summary.evidence.normalObservedHours, 0);
  assert.equal(result.summary.evidence.electricalValidated, false);
  assert.deepEqual(result, f.oracle());
  f.reopen(); assert.equal(f.finish(), 0);
  const changes = f.projection.db.prepare('SELECT total_changes() n').get().n;
  for (let n = 0; n < 5; n++) assert.equal(f.finish(), 0);
  assert.equal(f.projection.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('training-time changes within an evidence bin reaccumulate the original complete segments', t => {
  const f = firewoodFixture(t); f.finish();
  f.saveModel(model => { model.trainedAt = new Date(START + 8 * DAY + 5 * HOUR + 7 * 60_000).toISOString(); });
  const processed = f.finish();
  assert.ok(processed > 0 && processed < 10 * 96, 'Only the affected suffix should be replayed');
  assert.deepEqual(getFirewoodBenefit(f.args), f.oracle());
  f.saveModel(model => { model.trainedAt = new Date(START + 7 * DAY + 13 * HOUR).toISOString(); });
  f.finish();
  assert.deepEqual(getFirewoodBenefit(f.args), f.oracle(), 'Moving the evidence boundary backwards must recover eligible evidence');
});

for (const [name, change] of [
  ['heating coefficient', model => { model.parameters.lossPerHour *= 1.05; }],
  ['normal response', model => { model.equipmentResponse.phases.normal = { ratio: 0.7, treatmentKey: 'normal' }; }],
  ['auxiliary calibration', model => { model.energy.auxiliaryRiskScale = 2; }],
  ['floor response', model => { model.floor = { enabled: true, capacityKwhPerC: 2, nativeCapacityKwhPerC: 10,
    exchangeKwPerC: 0.1, groundLossKwPerC: 0.01, groundC: 10, openAllocationFraction: 0.4, closedAllocationFraction: 0.05 }; }],
  ['fireplace validation', model => { model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' }, fireplaceCPerKg: { status: 'identified' } },
    fireplace: { accepted: true, trainingBurns: 3, validationBurns: 3 } }; }],
]) test(`a changed ${name} still invalidates affected numerical states`, t => {
  const f = firewoodFixture(t, { days: 3 }); f.finish();
  const before = firewoodSimulationIdentity(f.source.getState('adaptive:mqtt').model);
  f.saveModel(change);
  assert.notDeepEqual(firewoodSimulationIdentity(f.source.getState('adaptive:mqtt').model), before);
  assert.equal(getFirewoodBenefit(f.args).summary.preparing, true);
  f.finish(); assert.deepEqual(getFirewoodBenefit(f.args), f.oracle());
});

test('future-source activation replays only its saved suffix across interleaved IDs and restart', t => {
  const f = firewoodFixture(t); f.finish();
  const old = catalog(f);
  f.append(10 * 96 + 4);
  f.append(10 * 96 + 1);
  let args = { ...f.args, now: f.args.now + WINDOW,
    range: { from: f.args.range.from, to: f.args.now + WINDOW },
    priceIntervals: [{ start: f.args.range.from, end: f.args.now + 4 * WINDOW, price: 20 }] };
  assert.equal(f.finish(args), 2);
  assert.deepEqual(getFirewoodBenefit(args), f.oracle(args));
  f.reopen(); args = { ...args, now: f.args.now + 4 * WINDOW, range: { from: f.args.range.from, to: f.args.now + 4 * WINDOW } };
  assert.equal(f.finish(args), 2, 'Activation must replay the two affected rows rather than the archive');
  assert.ok(old.every(row => catalog(f).some(saved => saved.cursor === row.cursor)), 'Unaffected source prefix survives activation');
  assert.deepEqual(getFirewoodBenefit(args), f.oracle(args));
});

test('real maintenance advances its own clock after an ordinary append without another chart request', async t => {
  const f = firewoodFixture(t, { days: 3, file: true }); let now = f.args.now;
  const service = createChartService({ store: f.source, cacheDays: 0, cacheBytes: 64 * 1024 * 1024, warmCache: false, clock: () => now });
  t.after(() => service.close());
  await service.query({ input: 'mqtt', now, startDate: '2026-01-03', view: 'power', summaryOnly: true });
  const wait = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'Current-clock maintenance must catch up'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  await wait(() => service.cacheStatus().resident?.firewood?.complete);
  const old = f.projection.latest('mqtt').cursor;
  f.append(3 * 96 + 1); now += WINDOW;
  await wait(() => f.projection.latest('mqtt').at === now);
  assert.ok(f.projection.latest('mqtt').cursor > old);
  assert.equal(f.projection.db.prepare('SELECT next_at FROM generation WHERE input=?').get('mqtt').next_at, null);
});
