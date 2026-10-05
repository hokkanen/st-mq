import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, START, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

for (const priority of ['balanced', 'charger1', 'charger2'])
  test(`economic waiting survives polling and restart with ${priority} priority`, async t => {
    const f = await fixture(t, { limiter: false });
    await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
    await f.connect('charger1'); await f.connect('charger2'); await f.priority(priority); await f.plan();
    const periods = () => ['charger1', 'charger2'].map(id => f.view(id).control.execution?.periods);
    const accepted = structuredClone(periods());
    assert.ok(accepted.every(rows => rows?.[0].startAt > f.now));
    let before = f.commands.length;
    for (let tick = 0; tick < 6; tick++) { f.advance(30_000); await f.settle(); }
    assert.deepEqual(periods(), accepted);
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), []);
    await f.restart();
    assert.deepEqual(periods(), accepted, 'Restart must preserve accepted economic waiting');
    before = f.commands.length;
    for (let tick = 0; tick < 6; tick++) { f.advance(30_000); await f.settle(); }
    assert.deepEqual(periods(), accepted);
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), []);
  });

test('balanced economic allocation keeps a short-capacity turn through repeated readback', async t => {
  const f = await fixture(t, { budgetA: 6 });
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  const active = () => f.runtime.status().coordination.allocations.find(row => row.start <= f.now && row.end > f.now);
  const winner = () => Object.entries(active().chargers).find(([, row]) => row.currentA >= 6)?.[0];
  const first = winner(), before = f.commands.length;
  assert.ok(first);
  for (let tick = 0; tick < 12; tick++) {
    f.advance(30_000); await f.settle();
    assert.equal(winner(), first, 'Polling must preserve the existing 15-minute allocation slice');
  }
  assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
    || command.chargerId === 'charger1'), [], 'An unchanged economic allocation must not cause start/stop commands');
});

async function chargingBeforePriceRevision(t) {
  const f = await fixture(t);
  const rates = values => values.map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  f.runtime.tick({ prices: rates([5, 5, 50, 50]) }); await f.settle();
  await f.connect('charger1'); await f.connect('charger2');
  await f.edit('charger1', { capacityKwh: 5 }); await f.edit('charger2', { capacityKwh: 5 });
  f.advance(30 * MINUTE); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).values.charging.value, true);
    assert.ok(f.view(id).control.execution?.planId);
  }
  f.revise = () => f.runtime.tick({ prices: rates([5, 5, 50, 1]), force: true });
  return f;
}

test('new cheaper prices pause both adopted programs while preserving both deadlines and restart state', async t => {
  const f = await chargingBeforePriceRevision(t);
  const prior = ['charger1', 'charger2'].map(id => structuredClone(f.view(id).control.execution));
  f.revise(); await f.settle();
  for (const [index, id] of ['charger1', 'charger2'].entries()) {
    const charger = f.view(id);
    assert.notEqual(charger.control.execution.planId, prior[index].planId);
    assert.equal(charger.control.execution.finalStartAt, START + 3 * HOUR);
    assert.equal(charger.control.execution.deadlineAt, prior[index].deadlineAt);
    assert.equal(charger.forecast.feasible, true);
    assert.ok(charger.forecast.accounting.every(row => row.priceCtPerKwh === 1));
  }
  assert.equal(f.fields.start_charging.value, false, 'The adopted C2 economic pause is independently read back');
  assert.equal(f.runtime.status().coordination.adopted.feasible, true);
  const shellyExecution = structuredClone(f.view('charger2').control.execution);
  await f.restart();
  assert.deepEqual(f.view('charger2').control.execution, shellyExecution);
  assert.equal(f.fields.start_charging.value, false);
});

test('a failed Charger 2 replacement preserves the previously adopted program', async t => {
  const f = await chargingBeforePriceRevision(t);
  const prior = structuredClone(f.view('charger2').control.execution);
  f.rejectShellyWrites(true); f.revise(); await f.settle();
  assert.deepEqual(f.view('charger2').control.execution, prior);
  assert.equal(f.fields.start_charging.value, true, 'The rejected pause did not change native permission');
  assert.notEqual(f.view('charger2').control.execution.planId, f.view('charger2').plan.id);
  assert.equal(f.view('charger2').control.phase, 'uncertain');
});

test('a new peer program does not consume a pending price improvement before joint service is comparable', async t => {
  const f = await fixture(t);
  const rates = values => values.map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  await f.automatic('charger1', true);
  f.runtime.tick({ prices: rates([5, 5, 50, 50]) }); await f.settle();
  await f.connect('charger1'); await f.edit('charger1', { capacityKwh: 5 });
  f.advance(30 * MINUTE);
  f.cars.charger2.allows = false;
  await f.connect('charger2'); await f.edit('charger2', { capacityKwh: 5 });
  assert.equal(f.view('charger2').control.execution, null);
  // A newly received price publication is assessed in the same reconciliation
  // that enables this peer, before it has any adopted application program.
  f.runtime.prices = rates([5, 5, 50, 1]);
  await f.automatic('charger2', true); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).control.execution.finalStartAt, START + 3 * HOUR);
    assert.equal(f.view(id).forecast.feasible, true);
  }
});
