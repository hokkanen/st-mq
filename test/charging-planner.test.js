import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChargingDeadline } from '../src/charging/settings.js';
import { acceptSocReading, effectiveSoc } from '../src/charging/soc.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-01-15T00:00:00Z');

test('deadline resolves local dates, spring gaps and autumn ambiguity consistently', () => {
  assert.equal(resolveChargingDeadline(Date.parse('2026-01-15T05:00:00Z'), '06:00', 'Europe/Helsinki'), Date.parse('2026-01-16T04:00:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-03-28T22:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-10-24T21:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-10-25T00:30:00Z'));
});

function payload(soc, measuredAt, readingId, sequence) {
  return { soc, measuredAt, readingId, sequence };
}

test('MQTT keeps original old measurement times and rejects duplicates, older and invalid readings', () => {
  const originalAt = now - 120 * 24 * HOUR;
  const first = acceptSocReading(null, JSON.stringify(payload(31, originalAt, 'reading-1')), { now });
  assert.equal(first.accepted, true);
  assert.equal(first.reading.measuredAt, originalAt);
  assert.equal(effectiveSoc({ automatic: first.reading, now }).soc, 31);
  assert.equal(acceptSocReading(first.reading, payload(31, originalAt, 'reading-1'), { now: now + HOUR }).reason, 'duplicate-reading');
  assert.equal(acceptSocReading(first.reading, payload(90, originalAt - 1, 'reading-older'), { now }).reason, 'older-reading');
  assert.equal(acceptSocReading(first.reading, payload(101, now, 'reading-2'), { now }).reason, 'invalid-soc');
  assert.equal(acceptSocReading(first.reading, payload(90, '2026-01-15 00:00', 'reading-2'), { now }).reason, 'invalid-measurement-time');
  assert.equal(acceptSocReading(first.reading, payload(90, '2025-02-31T00:00:00Z', 'reading-2'), { now }).reason, 'invalid-measurement-time');
  assert.equal(acceptSocReading(first.reading, '{bad', { now }).reason, 'malformed-json');
});

test('unknown measurement clocks remain unknown and sequence orders cached observations', () => {
  const first = acceptSocReading(null, payload(30, null, 'reading-1', 2), { now });
  assert.equal(first.reading.measuredAt, null);
  const next = acceptSocReading(first.reading, payload(35, null, 'reading-2', 3), { now: now + HOUR });
  assert.equal(next.accepted, true);
  assert.equal(acceptSocReading(next.reading, payload(25, null, 'reading-old', 1), { now }).accepted, false);
  assert.equal(effectiveSoc({ automatic: next.reading, now }).measuredAt, null);
});

test('automatic SoC takes priority over a remembered fallback, including zero percent', () => {
  const fallbackSoc = 40;
  const automatic = acceptSocReading(null, payload(65, now + HOUR, 'reading-1'), { now: now + HOUR }).reading;
  assert.equal(effectiveSoc({ fallbackSoc, automatic }).soc, 65);
  const zero = effectiveSoc({ fallbackSoc, automatic: { ...automatic, soc: 0 } });
  assert.equal(zero.soc, 0);
  assert.equal(zero.source, 'mqtt');
  assert.equal(zero.assumed, false);
  const fallback = effectiveSoc({ fallbackSoc: 35, automatic: { soc: 101 } });
  assert.equal(fallback.soc, 35);
  assert.equal(fallback.assumed, true);
  assert.equal(Object.hasOwn(fallback, 'expiresAt'), false);
  assert.equal(effectiveSoc().soc, 20);
});

test('MQTT topic association separates readings and retained vehicle facts without requiring vehicle identities', () => {
  const first = acceptSocReading(null, { ...payload(30, now, 'first'), usableCapacityKwh: 70 }, { now, association: 'charger-a/topic' });
  assert.equal(first.accepted, true);
  assert.equal(Object.hasOwn(first.reading, 'vehicleId'), false);
  assert.equal(Object.hasOwn(first.reading, 'sourceId'), false);
  const same = acceptSocReading(first.reading, payload(20, now - HOUR, 'second'), { now, association: 'charger-a/topic' });
  assert.equal(same.reason, 'older-reading');
  const changed = acceptSocReading(first.reading, payload(20, now - HOUR, 'second'), { now, association: 'charger-b/topic' });
  assert.equal(changed.accepted, true);
  assert.equal(changed.reading.association, 'charger-b/topic');
  assert.equal(Object.hasOwn(changed.reading, 'usableCapacityKwh'), false);
});
