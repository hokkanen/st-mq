import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/charging-joint-fixture.js';

for (const limiter of [true, false]) for (const priority of ['balanced', 'charger1', 'charger2'])
  test(`economic permission stays stable through changing actual draw with ${priority} priority and limiter ${limiter}`, async t => {
    const f = await fixture(t, { limiter });
    await f.connect('charger1'); await f.connect('charger2');
    for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
    await f.automatic('charger1', true); await f.automatic('charger2', true); await f.priority(priority); await f.plan();
    const execution = () => ['charger1', 'charger2'].map(id => f.view(id).control.execution);
    const initial = structuredClone(execution()), before = f.commands.length;
    for (const [first, second] of [[16,16], [8,8], [16,6], [6,16], [8,8]]) {
      f.cars.charger1.demandA = first; f.cars.charger2.demandA = second;
      f.advance(30_000);
      for (const role of ['current_limit', 'start_charging']) f.fields[role] = { ...f.fields[role], at: f.now, source: 'sys' };
      await f.settle();
      assert.deepEqual(execution(), initial, 'Own load changes must not replace accepted charging periods');
      for (const id of ['charger1', 'charger2']) assert.notEqual(f.view(id).identification.phase, 'pausing');
    }
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), [], 'Routine draw readback must not alternate charging permissions');
  });

test('economic current sharing still responds to actual peer stopping and returning', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.priority('charger1'); await f.plan();
  const before = f.commands.length;
  f.cars.charger1.demandA = 0; f.advance(30_000); await f.settle();
  assert.equal(f.fields.start_charging.value, true, 'A physically idle peer need not waste the remaining live capacity');
  f.cars.charger1.demandA = 16; f.advance(30_000); await f.settle();
  assert.equal(f.fields.start_charging.value, false, 'A returning preferred load must immediately regain its capacity');
  assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging').map(command => command.value), [true, false]);
});
