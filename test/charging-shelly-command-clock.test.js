import test from 'node:test';
import assert from 'node:assert/strict';
import { shellyCommandWindow, shellyCommandEventTime, shellyCommandSettingTime } from '../src/charging/shelly-command-clock.js';
import { shellyCurrentCommandReadback, validateShellyOwnershipState } from '../src/charging/shelly-evse.js';

const at = 1_800_000_000_000, epoch = '11111111-1111-4111-8111-111111111111';
const command = () => ({ value: 6, dispatchedAt: at + 1343, acceptedAt: at + 1470,
  nativeClock: { epoch, sample: { uptime: 100, unixtime: at / 1000,
    requestedAt: at + 494, receivedAt: at + 567 } } });

test('observed clock precision and round-trip bounds correlate a notification in the preceding second', () => {
  const pending = command(), original = structuredClone(pending);
  assert.deepEqual(shellyCommandWindow(pending), { lower: at + 776, upper: at + 1976 });
  assert.equal(shellyCommandEventTime(at + 780, pending), true);
  assert.equal(shellyCommandEventTime(at + 775, pending), false);
  assert.equal(shellyCommandEventTime(at + 1976, pending), false);
  assert.equal(shellyCommandSettingTime(at, pending), true, 'a whole-second update overlaps the observed command interval');
  assert.equal(shellyCommandSettingTime(at - 1000, pending), false);
  assert.deepEqual(pending, original, 'source and receipt timestamps remain original');
});

test('clock-correlated current confirmation retains ACK, epoch, post-ACK readback and external-instruction fences', () => {
  const pending = command(), field = { value: 6, commandSource: 'rpc', measuredAt: at,
    readback: { measuredAt: at, requestedAt: at + 1700, receivedAt: at + 1800 } };
  assert.equal(shellyCurrentCommandReadback(field, pending, epoch), true);
  for (const [sample, request, activeEpoch] of [
    [field, pending, undefined],
    [field, pending, '22222222-2222-4222-8222-222222222222'],
    [field, { ...pending, acceptedAt: null }, epoch],
    [{ ...field, readback: { ...field.readback, requestedAt: at + 1400 } }, pending, epoch],
    [{ ...field, value: 8 }, pending, epoch],
    [{ ...field, measuredAt: at - 1000, readback: { ...field.readback, measuredAt: at - 1000 } }, pending, epoch],
    [{ ...field, instructionAt: at + 1976 }, pending, epoch],
  ]) assert.equal(shellyCurrentCommandReadback(sample, request, activeEpoch), false);
});

test('malformed saved command clock evidence rejects before use', () => {
  const state = { version: 1, association: 'synthetic-clock-charger', phase: 'released', manual: null,
    ownedPause: false, pending: null, permissionCommand: { ...command(), value: true, sessionId: 'synthetic-session' } };
  validateShellyOwnershipState(state);
  for (const mutate of [
    proof => { proof.nativeClock.epoch = 'invalid'; },
    proof => { proof.nativeClock.sample.receivedAt = proof.dispatchedAt + 1; },
    proof => { proof.nativeClock.sample.admittedAt = proof.dispatchedAt + 1; },
    proof => { proof.nativeClock.sample.extra = true; },
    proof => { proof.nativeClock.extra = true; },
    proof => { proof.bootEpoch = '22222222-2222-4222-8222-222222222222'; },
  ]) {
    const malformed = structuredClone(state); mutate(malformed.permissionCommand);
    assert.throws(() => validateShellyOwnershipState(malformed), /unsupported-shelly-ownership/);
  }
});
