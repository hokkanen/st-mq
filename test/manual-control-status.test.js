import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_RECEIPT_MS, actionReceiptRecent, createReceiptTracker } from '../chart/action-receipts.js';
import { heatingRequestResult, heatingModeSelection, h66RequestResult, circulationStopPending } from '../chart/manual-control-status.js';
import { homeHeatingWarning } from '../chart/heating-warning.js';

const at = Date.parse('2026-09-16T10:48:00Z');
function heating(command = 'reduction', until = null) {
  return { now: at + 1000, heatingTests: { lastResult: { command, at, requestedAt: at - 100, status: 'mqtt', sent: true,
    expiresAt: until, holdUntil: until } },
    override: { id: 'pause-one', createdAt: at - 1000, expiresAt: until },
    decision: { manualHold: { phase: command, until } },
    h66: { manualPreheat: command === 'preheat' ? { at } : null },
    observations: { actual: { requestedPhase: command } } };
}

test('the common receipt lifetime is 24 hours, bounded by its original timestamp', () => {
  assert.equal(ACTION_RECEIPT_MS, 86400_000);
  assert.equal(actionReceiptRecent(at, at + ACTION_RECEIPT_MS - 1), true);
  assert.equal(actionReceiptRecent(at, at + ACTION_RECEIPT_MS), false);
  for (const invalid of [undefined, null, NaN, Infinity, at + 1]) assert.equal(actionReceiptRecent(invalid, at), false);
});

test('paused manual Reduced remains active indefinitely but its receipt expires after one day', () => {
  const status = heating(), original = structuredClone(status.heatingTests.lastResult);
  assert.equal(heatingRequestResult(status).active, true);
  assert.equal(heatingRequestResult(status).indefinite, true);
  status.now = at + ACTION_RECEIPT_MS;
  assert.equal(heatingRequestResult(status), null);
  assert.deepEqual(status.heatingTests.lastResult, original);
  assert.equal(status.decision.manualHold.until, null);
  assert.match(homeHeatingWarning({ ...status, now: at + 1 }, String), /until you choose another mode or Automatic/);
});

test('a finished scheduled override keeps a completed receipt without claiming an active hold', () => {
  const status = heating('preheat', at + 900_000);
  assert.equal(heatingRequestResult(status).active, true);
  status.now = at + 900_000;
  assert.equal(heatingRequestResult(status).active, false);
  assert.equal(heatingRequestResult(status).lifecycle, 'completed');
  assert.equal(heatingRequestResult(status).indefinite, false);
  status.now = at + ACTION_RECEIPT_MS;
  assert.equal(heatingRequestResult(status), null);
});

test('late tariff readback updates a request including reports received before dispatch completes', () => {
  const status = heating();
  Object.assign(status.observations.actual, { phase: 'reduction', verified: true, stale: false, observedAt: at - 50 });
  assert.deepEqual(heatingModeSelection(status), { phase: 'reduction', confirmed: true });
  assert.equal(heatingRequestResult(status).confirmed, true);
  status.heatingTests.lastResult.status = 'unconfirmed'; status.heatingTests.lastResult.error = 'Request timed out';
  assert.equal(heatingRequestResult(status).observedPhase, 'reduction');
  assert.equal(heatingRequestResult(status).confirmed, true);
  status.observations.actual.observedAt = at - 101;
  assert.equal(heatingRequestResult(status).confirmed, false, 'An older report cannot confirm this request');
});

test('new manual choices and fresh conflicting feedback supersede historical requests', () => {
  const status = heating();
  status.decision.manualHold.phase = 'normal';
  assert.equal(heatingRequestResult(status).lifecycle, 'superseded');
  assert.equal(heatingRequestResult(status).active, false);
  Object.assign(status.observations.actual, { phase: 'normal', verified: true, stale: false, observedAt: at + 500 });
  assert.equal(heatingRequestResult(status).observedPhase, 'normal');
});

test('restoration is separate from receipt retention and keeps an old request inactive', () => {
  const status = heating(); status.execution = { restorationPending: true };
  assert.equal(heatingRequestResult(status).restorationPending, true);
  assert.equal(heatingRequestResult(status).active, false);
  status.now = at + ACTION_RECEIPT_MS;
  assert.equal(heatingRequestResult(status), null);
  assert.equal(status.execution.restorationPending, true);
});

test('native pump receipts resolve from fresh readings and stay historical after settings change', () => {
  const status = { now: at + 2000, h66: { lastManual: { register: '0203', value: 25, scope: 'native-setting',
    at, status: 'unconfirmed', confirmed: false }, readings: { '0203': { value: 25, available: true, stale: false, observedAt: at + 1000 } } } };
  assert.equal(h66RequestResult(status).confirmed, true);
  status.h66.readings['0203'].value = 20;
  assert.equal(h66RequestResult(status).superseded, true);
  assert.equal(h66RequestResult(status).observedValue, 20);
  status.h66.readings['0203'].observedAt = at - 1;
  assert.equal(h66RequestResult(status).superseded, false);
  status.now = at + ACTION_RECEIPT_MS;
  assert.equal(h66RequestResult(status), null);
});

test('receipt trackers retain resolved feedback through later stale and out-of-order polls', () => {
  const track = createReceiptTracker();
  assert.equal(track('one', { at, active: true, confirmed: false }, at).confirmed, false);
  track('one', { at, active: true, confirmed: true, observedPhase: 'reduction', evidenceAt: at + 100 }, at + 200);
  assert.equal(track('one', { at, active: true, confirmed: false, evidenceAt: null }, at + 300).confirmed, true);
  track('one', { at, active: false, superseded: true, lifecycle: 'superseded', observedPhase: 'normal', evidenceAt: at + 400 }, at + 500);
  const old = track('one', { at, active: true, confirmed: true, observedPhase: 'reduction', evidenceAt: at + 100 }, at + 600);
  assert.equal(old.lifecycle, 'superseded'); assert.equal(old.active, false); assert.equal(old.observedPhase, 'normal');
  assert.equal(track('one', { at, active: true }, at + ACTION_RECEIPT_MS), null);
  assert.equal(track('two', { at: at + ACTION_RECEIPT_MS, confirmed: false }, at + ACTION_RECEIPT_MS).confirmed, false);
});

test('circulation completion remains a receipt and stop waiting resolves on actual OFF feedback', () => {
  const status = heating('circulation'); status.dhwr = { active: true, requestedAt: at - 100, confirmed: false };
  assert.equal(heatingRequestResult(status).active, true);
  status.dhwr.confirmed = true;
  assert.equal(heatingRequestResult(status).confirmed, true);
  status.dhwr.active = false;
  assert.equal(heatingRequestResult(status).lifecycle, 'completed');
  assert.equal(circulationStopPending(status, at), false);
  status.dhwr.confirmed = false;
  assert.equal(circulationStopPending(status, at), true);
  status.now = at + ACTION_RECEIPT_MS;
  assert.equal(circulationStopPending(status, at), false);
  status.dhwr.restorationPending = true;
  assert.equal(circulationStopPending(status, at), true);
});

test('delayed Reduction remains pending through normal readback then follows the eventual device report', () => {
  const status = heating(), track = createReceiptTracker();
  status.heatingTests.lastResult.status = 'waiting'; status.heatingTests.lastResult.sent = false;
  Object.assign(status.observations.actual, { requestedPhase: 'normal', phase: 'normal', verified: true,
    stale: false, observedAt: at + 500 });
  let receipt = track('one', heatingRequestResult(status), status.now);
  assert.equal(receipt.active, true); assert.equal(receipt.confirmed, false); assert.equal(receipt.superseded, false);
  Object.assign(status.observations.actual, { requestedPhase: 'reduction', phase: 'reduction', observedAt: at + 700 });
  receipt = track('one', heatingRequestResult(status), status.now);
  assert.equal(receipt.active, true); assert.equal(receipt.confirmed, true); assert.equal(receipt.superseded, false);
});

test('newer authoritative feedback can resolve an uncertain receipt after an earlier mismatch', () => {
  const track = createReceiptTracker();
  track('request', { at, confirmed: false, superseded: true, active: false, lifecycle: 'superseded',
    evidenceAt: at + 1, observedValue: 0 }, at + 1);
  const confirmed = track('request', { at, confirmed: true, superseded: false, active: true, lifecycle: 'active',
    evidenceAt: at + 2, observedValue: 1 }, at + 2);
  assert.equal(confirmed.confirmed, true); assert.equal(confirmed.superseded, false); assert.equal(confirmed.active, true);
  const lost = track('request', { at, confirmed: false, active: true, evidenceAt: null }, at + 3);
  assert.equal(lost.confirmed, true); assert.equal(lost.observedValue, 1);
});

test('late confirmation resolves a failed manual attempt while its current hold remains in force', () => {
  const status = heating(), track = createReceiptTracker();
  status.heatingTests.lastResult.status = 'unconfirmed';
  let receipt = track('request', heatingRequestResult(status), status.now);
  assert.equal(receipt.lifecycle, 'failed'); assert.equal(receipt.active, false);
  Object.assign(status.observations.actual, { phase: 'reduction', verified: true, stale: false, observedAt: at + 1 });
  receipt = track('request', heatingRequestResult(status), status.now);
  assert.equal(receipt.confirmed, true); assert.equal(receipt.lifecycle, 'active'); assert.equal(receipt.active, true);
});
