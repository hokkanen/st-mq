import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, START, HOUR } from './helpers/charging-joint-fixture.js';

test('a rare household peak preserves Charger 2 economic waiting and native Stop authority', async t => {
  const f = await fixture(t);
  // Synthetic history has ample capacity most of the time, with a brief peak
  // leaving only 4 A. It represents temporary balancing pauses, not an all-day
  // restriction on the adjustable charger.
  f.runtime.historyService = { close() {}, async request({ now, deadlineAt }) {
    return [{ start: now, end: deadlineAt, phaseCurrentA: [0.1128, 0.1128, 0.1128],
      scenarios: [{ phaseCurrentA: [0, 0, 0], weight: 0.9906 },
        { phaseCurrentA: [12, 12, 12], weight: 0.0094 }] }];
  } };
  f.runtime.historyAt = null;
  const prices = Array.from({ length: 24 }, (_, hour) => ({ start: START + hour * HOUR,
    end: START + (hour + 1) * HOUR, price: hour < 20 ? 30 : 1 }));
  await f.automatic('charger2', true);
  await f.connect('charger2');
  await f.edit('charger2', { readyBy: '02:00', capacityKwh: 60 });
  f.runtime.tick({ prices, force: true });
  await f.settle();

  const charger = f.view('charger2');
  assert.ok(charger.deadlineAt - f.now > 23 * HOUR, 'The session has nearly a full day remaining');
  assert.equal(charger.forecast.feasible, true, 'A brief high load must not erase every charging opportunity');
  assert.ok(charger.forecast.powerKw > 10, 'Expected delivery includes the low-load part of the history');
  assert.equal(charger.forecast.shortfallGridKwh, 0);
  assert.equal(charger.control.reason, 'economic-wait');
  assert.ok(charger.plan.periods[0].startAt >= START + 20 * HOUR, 'The request fits in the cheaper late period');
  assert.equal(f.fields.start_charging.value, false);
  assert.ok(charger.forecast.accounting.every(row => row.priceCtPerKwh === 1));

  f.advance(5000);
  f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  await f.settle();
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
  const commandCount = f.commands.length;
  f.advance(START + 20 * HOUR - f.now);
  await f.settle();
  assert.equal(f.fields.start_charging.value, false, 'Reaching the cheap period cannot override a later native Stop');
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
  assert.equal(f.commands.slice(commandCount).some(row => row.role === 'start_charging' && row.value), false);
});
