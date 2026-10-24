import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';

const now = Date.parse('2026-10-24T10:00:00Z');
const scope = 'a'.repeat(64);
const adapter = createOcppScheduleAdapter({ scope, request: async () => ({}), readSnapshot: () => ({}), clock: () => now });
const ceilingInputs = [22, 23, 24, 47, 104].map(id => ({ id, measuredAt: now - 900_000 }));
const snapshot = (times, values = [8, 10, 0]) => ({ online: true, readAt: now, statusAt: now,
  connectorStatus: 'Charging', pluggedIn: true,
  limits: { chargerA: 16, cableA: 32, circuitA: [25, 25, 25], equalizerAvailableA: values, equalizerAvailableAt: times },
  allowanceTelemetry: {
    availableCurrentA: { value: Math.min(...values), available: true, source: 'easee-equalizer', measuredAt: null,
      inputs: [230, 231, 232].map((id, phase) => ({ id, measuredAt: times?.[phase] ?? null })) },
    maxCurrentA: { value: 16, available: true, source: 'easee', measuredAt: null, inputs: ceilingInputs },
  } });

for (const [name, times] of [
  ['old', [now - 600_000, now - 600_000, now - 600_000]],
  ['mixed', [now - 600_000, now - 300_000, now - 100_000]],
  ['one missing', [now - 600_000, null, now - 100_000]],
  ['all missing', undefined],
]) test(`OCPP derived current retains ${name} Equalizer evidence without borrowing connector clocks`, () => {
  const input = snapshot(times), first = adapter.normalize(input, { now });
  assert.equal(first.currentA.value, 0, 'A valid zero allowance remains zero, including when its time is unknown');
  assert.equal(first.currentA.available, true, 'Timestamp projection does not change held-value availability policy');
  assert.equal(first.currentA.measuredAt, null, 'A combined estimate has no invented single measurement time');
  assert.equal(first.currentA.receivedAt, null, 'Snapshot publication is not an Equalizer transport receipt');
  assert.equal(first.currentA.source, 'easee-equalizer');
  assert.equal(first.currentA.timeBasis, 'derived-observations');
  assert.deepEqual(first.currentA.inputs, [...ceilingInputs,
    ...[230, 231, 232].map((id, phase) => ({ id, measuredAt: times?.[phase] ?? null }))]);
  assert.deepEqual(first.availableCurrentA, input.allowanceTelemetry.availableCurrentA);
  assert.deepEqual(adapter.normalize(input, { now }).currentA, first.currentA, 'Polling cannot renew source evidence');
  const later = adapter.normalize({ ...input, readAt: now + 1000, statusAt: now + 1000 }, { now: now + 1000 });
  assert.deepEqual(later.currentA, first.currentA, 'A newer connector status cannot renew Equalizer evidence');
  assert.deepEqual(later.availableCurrentA, first.availableCurrentA, 'Existing allowance provenance stays intact');
});

test('only new contributing observations advance the derived current inputs, retaining equipment ceilings', () => {
  const before = adapter.normalize(snapshot([now - 3000, now - 2000, now - 1000]), { now }).currentA;
  const input = snapshot([now - 3000, now - 2000, now], [20, 21, 22]);
  const after = adapter.normalize(input, { now }).currentA;
  assert.equal(after.value, 16, 'The existing fixed ceiling still clamps the allowance');
  assert.deepEqual(after.inputs.slice(0, 7), before.inputs.slice(0, 7));
  assert.deepEqual(after.inputs.at(-1), { id: 232, measuredAt: now });
  assert.equal(after.measuredAt, null);
});

test('unavailable and incomplete current evidence remains unavailable without fabricated source times', () => {
  const input = snapshot(undefined);
  delete input.allowanceTelemetry;
  for (const changed of [{ online: false }, { readAt: now - 60_001 },
    { limits: { ...input.limits, equalizerAvailableA: [8, null, 0] } }]) {
    const value = adapter.normalize({ ...input, ...changed }, { now }).currentA;
    assert.equal(value.available, false); assert.equal(value.value, null); assert.equal(value.measuredAt, null);
    assert.ok(value.inputs.every(row => row.measuredAt === null));
  }
});

test('derived current uses the frozen snapshot ceiling evidence rather than a newer telemetry callback', () => {
  const input = snapshot([now - 3000, now - 2000, now - 1000]);
  const newer = structuredClone(input.allowanceTelemetry);
  newer.maxCurrentA.inputs = ceilingInputs.map(row => ({ ...row, measuredAt: now }));
  const current = createOcppScheduleAdapter({ scope, request: async () => ({}), readSnapshot: () => ({}),
    readAllowanceTelemetry: () => newer, clock: () => now }).normalize(input, { now });
  assert.deepEqual(current.currentA.inputs.slice(0, 5), ceilingInputs);
  assert.deepEqual(current.availableCurrentA, newer.availableCurrentA, 'The independent live allowance projection retains its contract');
});
