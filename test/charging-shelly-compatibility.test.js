import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityScope, compatibilityStart, compatibilityPermission, compatibilityRecovery,
  compatibilityDebit, validShellyCompatibility } from '../src/charging/shelly-compatibility.js';

const T = 1_800_000_000_000;
const scope = () => compatibilityScope(null, { connected: true, sessionId: 'synthetic-session', connectedAt: T });
function start(state, at = T, origin = 'scheduled', requestAt = null) {
  compatibilityStart(state, { at, acceptedAt: at + 25, origin, requestAt, currentA: 14 });
}
function off(state, at) {
  compatibilityPermission(state, { value: false, commandSource: 'sys', eventAt: at, receivedAt: at }, at,
    { model: 'synthetic-model', firmware: 'synthetic-firmware' });
}
function evaluate(state, now, extra = {}) {
  return compatibilityRecovery(state, { now, origin: 'scheduled', requestAt: null, eligible: true,
    permitted: false, charging: false, physicalAt: null, held: true,
    hold: { eventAt: now }, currentA: 14, pending: null, ...extra });
}

test('retries follow 10/30/60 seconds, never renew on false refresh and stop after three', () => {
  const state = scope(); start(state); off(state, T + 9000);
  assert.equal(evaluate(state, T + 18_999).retry, false);
  off(state, T + 12_000);
  assert.equal(state.incident.nextAt, T + 19_000);
  let now = T + 19_000;
  for (const [index, wait] of [30_000, 60_000, null].entries()) {
    assert.equal(evaluate(state, now).retry, true);
    assert.equal(compatibilityDebit(state, now, 14), true);
    start(state, now); now += 9000; off(state, now);
    assert.equal(state.scheduledRetries, index + 1);
    if (wait !== null) { assert.equal(state.incident.nextAt, now + wait); now += wait; }
  }
  assert.equal(state.incident.status, 'exhausted');
  assert.equal(evaluate(state, now + 100_000).retry, false);
  assert.equal(validShellyCompatibility(state), true);
});

test('Charge now budget is per explicit request and never consumes or resets scheduled retries', () => {
  const state = scope(); state.scheduledRetries = 5;
  evaluate(state, T, { origin: 'charge-now', requestAt: T });
  start(state, T, 'charge-now', T); off(state, T + 1000);
  assert.equal(compatibilityDebit(state, T + 11_000, 14), true);
  assert.equal(state.scheduledRetries, 5); assert.equal(state.chargeNowRetries, 1);
  evaluate(state, T + 20_000, { origin: 'charge-now', requestAt: T + 20_000 });
  assert.equal(state.scheduledRetries, 5); assert.equal(state.chargeNowRetries, 0);
  assert.equal(state.incident.status, 'cancelled');
});

test('restart retains deadlines and counters; another physical connection inherits none', () => {
  const state = scope(); start(state); off(state, T + 1000);
  const restarted = structuredClone(state);
  assert.equal(validShellyCompatibility(restarted), true);
  assert.equal(evaluate(restarted, T + 10_999).retry, false);
  assert.equal(evaluate(restarted, T + 11_000).retry, true);
  const replacement = compatibilityScope(restarted, { connected: true, sessionId: 'new-session', connectedAt: T + 12_000 });
  assert.equal(replacement.incident, null); assert.equal(replacement.scheduledRetries, 0);
  assert.equal(compatibilityScope(state, { connected: false }), null);
});

test('late, unacknowledged and non-SYS Stops cannot arm recovery', () => {
  for (const kind of ['no-ack', 'late', 'external']) {
    const state = scope();
    if (kind !== 'no-ack') start(state);
    compatibilityPermission(state, { value: false, commandSource: kind === 'external' ? 'rpc' : 'sys',
      eventAt: T + 61_000, receivedAt: T + 61_000 }, T + 61_000);
    assert.equal(state.incident, null);
  }
});

test('six scheduled retries is a connection-wide cap even across recovered incidents', () => {
  const state = scope(); state.scheduledRetries = 6; start(state); off(state, T + 1000);
  assert.equal(state.incident.status, 'exhausted');
  assert.equal(compatibilityDebit(state, T + 100_000, 14), false);
});

test('success needs sixty seconds of fresh native charging and physical draw, not an ACK or status alone', () => {
  const state = scope(); start(state); off(state, T + 1000);
  for (const offset of [2000, 22_000, 42_000]) evaluate(state, T + offset,
    { permitted: true, held: false, charging: true, physicalAt: T + offset });
  assert.notEqual(state.incident.status, 'recovered');
  evaluate(state, T + 62_000, { permitted: true, held: false, charging: true, physicalAt: T + 62_000 });
  assert.equal(state.incident.status, 'recovered');
  assert(state.events.some(event => event.code === 'shelly-recovery-restored'));
});

test('a physical evidence gap resets sustained proof and expired incidents never retry', () => {
  const state = scope(); start(state); off(state, T + 1000);
  evaluate(state, T + 2000, { permitted: true, held: false, charging: true, physicalAt: T + 2000 });
  evaluate(state, T + 65_000, { permitted: true, held: false, charging: true, physicalAt: T + 65_000 });
  assert.notEqual(state.incident.status, 'recovered');
  assert.equal(evaluate(state, T + 301_000).retry, false);
  assert.equal(state.incident.status, 'exhausted');
});

test('Pause, closed window or later external instruction cancels rather than retries', () => {
  const state = scope(); start(state); off(state, T + 1000);
  assert.equal(evaluate(state, T + 11_000, { eligible: false }).retry, false);
  assert.equal(state.incident.status, 'cancelled');
});

test('uncertain commands and insufficient current cannot dispatch or turn Charge now OFF', () => {
  const state = scope(); evaluate(state, T, { origin: 'charge-now', requestAt: T });
  start(state, T, 'charge-now', T); off(state, T + 1000);
  assert.equal(evaluate(state, T + 11_000, { origin: 'charge-now', requestAt: T,
    pending: { stage: 'dispatched' } }).retry, false);
  const limited = evaluate(state, T + 301_000, { origin: 'charge-now', requestAt: T, blocked: true });
  assert.equal(limited.retry, false); assert.equal(limited.failed, false);
  assert.equal(state.incident.status, 'waiting');
  const expired = evaluate(state, T + 302_000, { origin: 'charge-now', requestAt: T });
  assert.equal(expired.retry, false); assert.equal(expired.failed, true);
});

test('self-recovery skips retries and repeated cached power cannot qualify sustained draw', () => {
  const state = scope(); start(state); off(state, T + 1000);
  for (const now of [T + 2000, T + 40_000, T + 70_000]) {
    assert.equal(evaluate(state, now, { permitted: true, held: false, charging: true, physicalAt: T + 2000 }).retry, false);
  }
  assert.notEqual(state.incident.status, 'recovered'); assert.equal(state.scheduledRetries, 0);
});

test('a new explicit ON has an independent budget even when the action clock has not advanced', () => {
  const state = scope(); state.scheduledRetries = 4;
  evaluate(state, T, { origin: 'charge-now', requestAt: T });
  start(state, T, 'charge-now', T); state.chargeNowRetries = 3; off(state, T + 1000);
  assert.equal(state.incident.status, 'exhausted');
  const result = evaluate(state, T + 1000, { origin: 'charge-now', requestAt: T, newRequest: true });
  assert.equal(result.failed, false); assert.equal(state.incident, null);
  assert.equal(state.chargeNowRetries, 0); assert.equal(state.scheduledRetries, 4);
});

test('malformed recovery records and private metadata fail closed', () => {
  const state = scope(); start(state); off(state, T + 1000);
  for (const edit of [s => { s.scheduledRetries = 7; }, s => { s.incident.attempts = -1; },
    s => { s.incident.deadlineAt++; }, s => { s.events[0].firmware = 'secret=https://invalid/?token'; },
    s => { s.extra = true; }]) {
    const invalid = structuredClone(state); edit(invalid); assert.equal(validShellyCompatibility(invalid), false);
  }
});
