import test from 'node:test';
import assert from 'node:assert/strict';
import { dhwrEligible } from '../src/control/dhwr.js';
const HOUR = 3_600_000, now = Date.parse('2026-09-06T09:00:00Z');
test('DHWR local-time boundaries follow Helsinki in winter, summer and DST transitions', () => {
  for (const [date, offset] of [['2026-01-02', '+02:00'], ['2026-07-02', '+03:00'],
    ['2026-03-29', '+03:00'], ['2026-10-25', '+02:00']]) {
    assert.equal(dhwrEligible(`${date}T05:44:00${offset}`, null), false);
    assert.equal(dhwrEligible(`${date}T05:45:00${offset}`, null), true);
    assert.equal(dhwrEligible(`${date}T19:45:00${offset}`, null), true);
    assert.equal(dhwrEligible(`${date}T19:46:00${offset}`, null), false);
    assert.equal(dhwrEligible(`${date}T02:00:00${offset}`, null), false);
  }
});

test('DHWR recency persists independently and exact 52.5 minutes is eligible', () => {
  assert.equal(dhwrEligible(now, now - 52.5 * 60_000), true);
  assert.equal(dhwrEligible(now, now - 52.5 * 60_000 + 1), false);
  assert.equal(dhwrEligible(now, now + HOUR), false);
  assert.equal(dhwrEligible(now, 'corrupt'), false);
  assert.equal(dhwrEligible(now, null, 'reduction'), false);

});
