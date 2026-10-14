import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMqttStartupDiagnostic, mqttStartupDiagnostic } from '../src/acquisition/startup-diagnostic.js';
import { startupFailureDiagnostic, peerFailureDiagnostic } from '../src/pairing/manager.js';

const evidence = () => ({ stage: 'primary-subscriptions', cause: 'timeout',
  connected: true, subscriptionsReady: false, readinessFailed: false, receptionFailed: false,
  observedConnections: 1, subscriptionRequests: 2, subscriptionCallbacks: 2,
  acceptedCallbacks: 2, rejectedCallbacks: 0, committedCallbacks: 0, admissionFailures: 0,
  replayAdmissionsPending: 0, recordingPending: 0, queuePending: 4, queueQueued: 4,
  queueActive: 0, queueWaiting: true, queueOldestPendingMs: 10000.5, countsClipped: false });

test('only trusted acquisition evidence reaches the existing startup diagnostic', () => {
  const error = new Error('synthetic credential and provider payload');
  const message = error.message, stack = error.stack;
  assert.equal(attachMqttStartupDiagnostic(error, evidence()), error);
  const detail = mqttStartupDiagnostic(error);
  assert.equal(detail.connected, true);
  assert.equal(detail.subscriptionCallbacks, 2);
  assert.equal(detail.queueOldestPendingMs, 10001);
  assert.equal(startupFailureDiagnostic(error, 'runtime_failed').acquisition, detail);
  assert.equal(Object.hasOwn(peerFailureDiagnostic(error, 'status'), 'acquisition'), false);
  assert.equal(error.message, message); assert.equal(error.stack, stack);
  assert.doesNotMatch(JSON.stringify(startupFailureDiagnostic(error, 'runtime_failed')), /credential|payload/);
});

test('spoofed Error detail and accessors do not acquire producer provenance', () => {
  let reads = 0;
  const spoof = new Error('synthetic private credentials');
  Object.defineProperty(spoof, 'acquisition', { get() { reads++; throw new Error('private getter'); } });
  spoof.startupDiagnostic = evidence();
  assert.equal(mqttStartupDiagnostic(spoof), null);
  assert.equal(Object.hasOwn(startupFailureDiagnostic(spoof, 'runtime_failed'), 'acquisition'), false);
  assert.equal(reads, 0);
  for (const value of [null, undefined, {}, 'synthetic private credentials', 3])
    assert.equal(mqttStartupDiagnostic(value), null);
});

test('unknown fields, accessors and malformed evidence retain the same exception without detail', () => {
  const accessor = evidence(); let reads = 0;
  Object.defineProperty(accessor, 'connected', { enumerable: true, get() { reads++; throw new Error('private value'); } });
  const nonenumerable = evidence(); Object.defineProperty(nonenumerable, 'credential', { value: 'private' });
  const symbol = evidence(); symbol[Symbol('private')] = 'private';
  for (const input of [null, [], { ...evidence(), credential: 'private' }, accessor, nonenumerable, symbol,
    { ...evidence(), stage: 'private-hostname' }, { ...evidence(), cause: 'private-provider-error' },
    { ...evidence(), connected: 'true' }, { ...evidence(), subscriptionCallbacks: -1 },
    { ...evidence(), observedConnections: Infinity }, { ...evidence(), queueOldestPendingMs: NaN },
    { ...evidence(), queueQueued: 3 }, { ...evidence(), queuePending: null }]) {
    const error = new Error('original startup failure');
    assert.equal(attachMqttStartupDiagnostic(error, input), error);
    assert.equal(mqttStartupDiagnostic(error), null);
  }
  assert.equal(reads, 0);
});

test('counter and monotonic-age limits remain explicit in a bounded immutable snapshot', () => {
  const input = { ...evidence(), observedConnections: 100000, subscriptionRequests: 100000,
    subscriptionCallbacks: 100000, acceptedCallbacks: 100000, committedCallbacks: 100000,
    replayAdmissionsPending: 100000, queuePending: 10000, queueQueued: 9999, queueActive: 1,
    queueOldestPendingMs: 100000 };
  const error = attachMqttStartupDiagnostic(new Error('original'), input), detail = mqttStartupDiagnostic(error);
  assert.equal(detail.observedConnections, 65535); assert.equal(detail.committedCallbacks, 65535);
  assert.equal(detail.queuePending, 2048); assert.equal(detail.queueQueued, 2048);
  assert.equal(detail.queueOldestPendingMs, 60000); assert.equal(detail.countsClipped, true);
  assert(Buffer.byteLength(JSON.stringify(detail)) <= 1024);
  assert.equal(Object.isFrozen(detail), true);
  input.connected = false; input.subscriptionCallbacks = 0;
  attachMqttStartupDiagnostic(error, evidence());
  assert.equal(mqttStartupDiagnostic(error), detail, 'Later attachment cannot replace the failure snapshot');
  assert.equal(detail.connected, true); assert.equal(detail.subscriptionCallbacks, 65535);
  assert.throws(() => { detail.connected = false; }, TypeError);
});

test('absent queue evidence is unknown rather than an invented empty queue', () => {
  const input = evidence();
  for (const key of ['queuePending', 'queueQueued', 'queueActive', 'queueWaiting', 'queueOldestPendingMs']) input[key] = null;
  const error = attachMqttStartupDiagnostic(new Error('original'), input), detail = mqttStartupDiagnostic(error);
  for (const key of ['queuePending', 'queueQueued', 'queueActive', 'queueWaiting', 'queueOldestPendingMs']) assert.equal(detail[key], null);
  assert.equal(detail.connected, true);
});

test('diagnostic storage and read failures cannot replace the original exception', () => {
  const set = WeakMap.prototype.set, get = WeakMap.prototype.get;
  const error = new Error('original startup failure');
  try {
    WeakMap.prototype.set = () => { throw new Error('synthetic diagnostic storage failure'); };
    assert.equal(attachMqttStartupDiagnostic(error, evidence()), error);
    assert.equal(mqttStartupDiagnostic(error), null);
    WeakMap.prototype.get = () => { throw new Error('synthetic diagnostic read failure'); };
    assert.equal(Object.hasOwn(startupFailureDiagnostic(error, 'runtime_failed'), 'acquisition'), false);
  } finally { WeakMap.prototype.set = set; WeakMap.prototype.get = get; }
  assert.equal(error.message, 'original startup failure');
});
