import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSettings, resolveChargingDeadline } from '../src/charging/settings.js';
import { acceptSocReading, createManualSoc, effectiveSoc } from '../src/charging/soc.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-01-15T00:00:00Z');

test('deadline resolves local dates, spring gaps and autumn ambiguity consistently', () => {
  assert.equal(resolveChargingDeadline(Date.parse('2026-01-15T05:00:00Z'), '06:00', 'Europe/Helsinki'), Date.parse('2026-01-16T04:00:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-03-28T22:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-10-24T21:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-10-25T00:30:00Z'));
});

function payload(soc, measuredAt, readingId, sequence) {
  return { vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', soc, measuredAt, readingId, sequence };
}

test('MQTT keeps original old measurement times and rejects duplicates, older and mismatched readings', () => {
  const originalAt = now - 120 * 24 * HOUR;
  const first = acceptSocReading(null, JSON.stringify(payload(31, originalAt, 'reading-1')), { now });
  assert.equal(first.accepted, true);
  assert.equal(first.reading.measuredAt, originalAt);
  assert.equal(effectiveSoc({ automatic: first.reading, now }).soc, 31);
  assert.equal(acceptSocReading(first.reading, payload(31, originalAt, 'reading-1'), { now: now + HOUR }).reason, 'duplicate-reading');
  assert.equal(acceptSocReading(first.reading, payload(90, originalAt - 1, 'reading-older'), { now }).reason, 'older-reading');
  assert.equal(acceptSocReading(first.reading, { ...payload(90, now, 'reading-2'), vehicleId: 'other-vehicle' }, { now }).reason, 'identity-mismatch');
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

test('manual override survives restart, stores fixed expiry and keeps MQTT updates underneath', () => {
  const manual = createManualSoc(40, { now, readyBy: '06:00', timezone: 'Europe/Helsinki' });
  assert.equal(manual.expiresAt, now + 4 * HOUR);
  const saved = JSON.parse(JSON.stringify(manual));
  const automatic = acceptSocReading(null, payload(65, now + HOUR, 'reading-1'), { now: now + HOUR }).reading;
  assert.equal(effectiveSoc({ manual: saved, automatic, now: now + 3 * HOUR }).soc, 40);
  chargingSettings({ chargers: { charger1: { readyBy: '08:00' } } });
  assert.equal(saved.expiresAt, now + 4 * HOUR);
  const expired = effectiveSoc({ manual: saved, automatic, now: manual.expiresAt });
  assert.equal(expired.source, 'mqtt');
  assert.equal(expired.soc, 65);
  assert.equal(effectiveSoc({ manual: saved, now: manual.expiresAt }).assumed, true);
});
