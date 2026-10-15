import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplicaCheckpointMismatchError, REPLICA_CHECKPOINT_MISMATCH,
  captureReplicaReadRefusalPhase, replicaReadRefusalPhase,
  createReplicaReadRefusalReporter } from '../src/app/replica-errors.js';

const phase = () => ({ attempt: 1, rollbackConfirmed: true, closed: false, latestManifestState: 'same' });
const failure = input => captureReplicaReadRefusalPhase(new ReplicaCheckpointMismatchError(), input ?? phase());

test('an authored refusal retains its original Error and first immutable phase snapshot', () => {
  const error = new ReplicaCheckpointMismatchError(), message = error.message, stack = error.stack, input = phase();
  assert.equal(captureReplicaReadRefusalPhase(error, input), error);
  const detail = replicaReadRefusalPhase(error);
  assert.deepEqual(detail, phase()); assert.equal(Object.isFrozen(detail), true);
  input.closed = true;
  captureReplicaReadRefusalPhase(error, { ...phase(), attempt: 2 });
  assert.equal(replicaReadRefusalPhase(error), detail);
  assert.equal(detail.closed, false); assert.equal(detail.attempt, 1);
  assert.equal(error.message, message); assert.equal(error.stack, stack);
  assert.equal(error.statusCode, 503); assert.equal(error.code, REPLICA_CHECKPOINT_MISMATCH.code);
  assert.throws(() => { detail.closed = true; }, TypeError);
});

test('spoofed native errors, class prototypes, properties and getters cannot acquire phase provenance', () => {
  let reads = 0;
  const native = Object.assign(new Error('synthetic private native payload'), { code: REPLICA_CHECKPOINT_MISMATCH.code });
  Object.defineProperty(native, 'phase', { get() { reads++; throw Error('synthetic private credential'); } });
  for (const error of [native, Object.create(ReplicaCheckpointMismatchError.prototype), null, {}, 'synthetic private credential']) {
    assert.equal(captureReplicaReadRefusalPhase(error, phase()), error);
    assert.equal(replicaReadRefusalPhase(error), null);
  }
  const records = [], report = createReplicaReadRefusalReporter({ report: value => records.push(value) });
  report(native, 'status');
  assert.deepEqual(records, []); assert.equal(reads, 0);
});

test('unknown fields, inaccessible input and malformed scalar states cannot replace the refusal', () => {
  const getter = phase(); let reads = 0;
  Object.defineProperty(getter, 'closed', { enumerable: true, get() { reads++; throw Error('synthetic private getter'); } });
  const hidden = phase(); Object.defineProperty(hidden, 'privatePath', { value: '/synthetic/private' });
  const symbol = phase(); symbol[Symbol('synthetic private')] = true;
  const inaccessible = new Proxy({}, { getPrototypeOf() { throw Error('synthetic private proxy'); } });
  for (const input of [null, [], {}, getter, hidden, symbol, inaccessible,
    { ...phase(), device: 'synthetic private device' }, { ...phase(), attempt: 3 },
    { ...phase(), attempt: Infinity }, { ...phase(), rollbackConfirmed: 1 },
    { ...phase(), closed: 'false' }, { ...phase(), latestManifestState: 'synthetic private manifest' }]) {
    const error = new ReplicaCheckpointMismatchError();
    assert.equal(captureReplicaReadRefusalPhase(error, input), error);
    assert.equal(replicaReadRefusalPhase(error), null);
  }
  assert.equal(reads, 0);
});

test('the monotonic cap bounds attempted logs without waiting or replaying earlier phase details', t => {
  t.mock.method(Date, 'now', () => 1792000000000);
  let now = 0; const records = [], error = failure();
  const report = createReplicaReadRefusalReporter({ monotonic: () => now, report: value => records.push(value) });
  assert.equal(report(error, 'status'), undefined);
  now = 29999;
  for (let i = 0; i < 65536; i++) report(error, 'recording-health');
  assert.equal(records.length, 1);
  now = 30000;
  report(failure({ ...phase(), attempt: 2, latestManifestState: 'not-checked' }), 'recording-health');
  assert.equal(records.length, 2);
  assert.deepEqual(records[1], { event: 'replica-read-refused', route: 'recording-health',
    attempt: 2, rollbackConfirmed: true, closed: false, latestManifestState: 'not-checked',
    reportedAt: 1792000000000, monotonicMs: 30000, suppressed: 65535, suppressedClipped: true });
  assert.equal(Object.isFrozen(records[1]), true);
  assert(Buffer.byteLength(JSON.stringify(records[1])) <= 384);
  now = 60000; report(error, 'status');
  assert.equal(records[2].suppressed, 0); assert.equal(records[2].suppressedClipped, false);
});

test('refusal clocks belong to the attempted emission and reuse the existing monotonic sample', t => {
  let now = 0.25, wall = 1792000000000, monotonicReads = 0, wallReads = 0;
  t.mock.method(Date, 'now', () => { wallReads++; return wall; });
  const records = [], error = failure(), report = createReplicaReadRefusalReporter({
    monotonic: () => { monotonicReads++; return now; }, report: value => records.push(value),
  });
  report(new Error('synthetic private native error'), 'status');
  report(error, '/api/status?synthetic-private-value');
  assert.equal(monotonicReads, 0); assert.equal(wallReads, 0);
  report(error, 'status');
  assert.equal(records[0].reportedAt, wall); assert.equal(records[0].monotonicMs, now);
  now = 29999.25; wall += 29999;
  report(error, 'recording-health');
  assert.equal(records.length, 1); assert.equal(monotonicReads, 2); assert.equal(wallReads, 1);
  now = 30000.25; wall -= 60000;
  report(error, 'recording-health');
  assert.equal(records[1].reportedAt, wall, 'An observed wall rollback does not renew the monotonic cap');
  assert.equal(records[1].monotonicMs, now); assert.equal(records[1].suppressed, 1);
  assert.equal(monotonicReads, 3); assert.equal(wallReads, 2);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.equal(error.code, REPLICA_CHECKPOINT_MISMATCH.code);
});

test('throwing and unsafe wall clocks retain fixed unknown evidence without forwarding private values', t => {
  let wall = null, reads = 0, coercions = 0, now = 0;
  const privateObject = { valueOf() { coercions++; throw Error('synthetic private clock coercion'); } };
  t.mock.method(Date, 'now', () => { reads++; if (wall === 'throw') throw Error('synthetic private clock failure'); return wall; });
  const records = [], error = failure(), stack = error.stack;
  const report = createReplicaReadRefusalReporter({ monotonic: () => now, report: value => records.push(value) });
  for (const value of ['throw', NaN, Infinity, -1, 0.5, 8640000000000001,
    Number.MAX_SAFE_INTEGER + 1, 'synthetic private credential', privateObject]) {
    wall = value; report(error, 'status');
    assert.equal(records.at(-1).reportedAt, null);
    assert.equal(records.at(-1).monotonicMs, now);
    assert.equal(records.at(-1).latestManifestState, 'same');
    assert.equal(JSON.stringify(records.at(-1)).includes('synthetic private'), false);
    report(error, 'recording-health');
    assert.equal(records.length, now / 30000 + 1, 'A failed wall reading still consumes only the existing log attempt');
    now += 30000;
  }
  assert.equal(reads, 9); assert.equal(coercions, 0);
  assert.equal(error.stack, stack); assert.equal(error.message, REPLICA_CHECKPOINT_MISMATCH.error);
});

test('fixed scalar clock extremes stay bounded and do not change monotonic admission', t => {
  t.mock.method(Date, 'now', () => 8640000000000000);
  let now = Number.MAX_SAFE_INTEGER;
  const records = [], error = failure(), report = createReplicaReadRefusalReporter({
    monotonic: () => now, report: value => records.push(value),
  });
  report(error, 'recording-health');
  assert.equal(records[0].reportedAt, 8640000000000000);
  assert.equal(records[0].monotonicMs, Number.MAX_SAFE_INTEGER);
  assert(Buffer.byteLength(JSON.stringify(records[0])) <= 384);
  now += 30000; report(error, 'status');
  assert.equal(records[1].monotonicMs, null, 'An unsafe finite monotonic magnitude has explicit unknown diagnostic evidence');
  assert.equal(records[1].reportedAt, 8640000000000000);
  now += 1; report(error, 'status');
  assert.equal(records.length, 2, 'Diagnostic normalization preserves the original finite-clock suppression rule');
});

test('unknown routes and unusable clock evidence emit no private diagnostics', () => {
  let now = NaN; const records = [], error = failure();
  const report = createReplicaReadRefusalReporter({ monotonic: () => now, report: value => records.push(value) });
  report(error, 'status'); now = -1; report(error, 'recording-health');
  now = 0; report(error, '/api/status?synthetic-private-value');
  assert.deepEqual(records, []);
  report(error, 'status'); now = 30000; report(error, 'recording-health');
  assert.equal(records.length, 2);
});

test('throwing or rejecting sinks are capped and cannot change the original exception', async () => {
  for (const kind of ['throw', 'reject']) {
    let now = 0, attempts = 0; const error = failure();
    const report = createReplicaReadRefusalReporter({ monotonic: () => now, report: () => {
      attempts++;
      if (kind === 'throw') throw Error('synthetic private sink failure');
      return Promise.reject(Error('synthetic private sink rejection'));
    } });
    assert.doesNotThrow(() => report(error, 'status'));
    now = 1; report(error, 'status'); assert.equal(attempts, 1);
    now = 30000; assert.doesNotThrow(() => report(error, 'recording-health'));
    assert.equal(attempts, 2); assert.equal(error.statusCode, 503);
    assert.equal(error.message, REPLICA_CHECKPOINT_MISMATCH.error);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('diagnostic registry failures cannot prevent construction or replace an existing refusal', () => {
  const add = WeakSet.prototype.add, set = WeakMap.prototype.set, get = WeakMap.prototype.get;
  try {
    WeakSet.prototype.add = () => { throw Error('synthetic provenance failure'); };
    const unregistered = new ReplicaCheckpointMismatchError();
    assert.equal(unregistered.statusCode, 503);
    assert.equal(captureReplicaReadRefusalPhase(unregistered, phase()), unregistered);
    assert.equal(replicaReadRefusalPhase(unregistered), null);
    WeakSet.prototype.add = add;
    const error = new ReplicaCheckpointMismatchError();
    WeakMap.prototype.set = () => { throw Error('synthetic detail storage failure'); };
    assert.equal(captureReplicaReadRefusalPhase(error, phase()), error);
    assert.equal(replicaReadRefusalPhase(error), null);
    WeakMap.prototype.get = () => { throw Error('synthetic detail read failure'); };
    assert.equal(replicaReadRefusalPhase(error), null);
  } finally { WeakSet.prototype.add = add; WeakMap.prototype.set = set; WeakMap.prototype.get = get; }
});
