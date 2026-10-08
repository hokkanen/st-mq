import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceTime, sourceTimeAdmission, observationTimeAdmitted,
  observationAvailableAt, validateAdmittedSourceTime } from '../src/domain/time-evidence.js';

const T = 1800000000000;
test('bounded source leads wait for their actual source time and preserve original receipt', () => {
  for (const lead of [1, 4, 400, 1000]) {
    const input = { sourceTime: T + lead, receivedAt: T };
    assert.equal(classifySourceTime({ ...input, now: T }).status, 'pending');
    assert.equal(sourceTimeAdmission({ ...input, now: T }), undefined);
    const proof = sourceTimeAdmission({ ...input, now: T + lead });
    const observation = { ...input, raw: { timeAdmission: proof } };
    assert.deepEqual(proof, { ...input, admittedAt: T + lead });
    assert.equal(observationTimeAdmitted(observation, T + lead - 1), false);
    assert.equal(observationTimeAdmitted(observation, T + lead), true);
    assert.equal(observationAvailableAt(observation), T + lead);
    assert.equal(observationTimeAdmitted(input, T + 5000), false, 'Waiting alone cannot supply admission proof');
  }
});
test('large skew, malformed proof, borrowed proof and host rollback remain unavailable', () => {
  assert.equal(classifySourceTime({ sourceTime: T + 1001, receivedAt: T, now: T }).status, 'invalid');
  for (const value of [NaN, Infinity, -1, T + .5, '1800000000000'])
    assert.equal(classifySourceTime({ sourceTime: value, receivedAt: T, now: T }).status, 'invalid');
  const source = { sourceTime: T + 400, receivedAt: T };
  const proof = sourceTimeAdmission({ ...source, now: T + 400 });
  for (const timeAdmission of [null, { ...proof, extra: true }, { ...proof, sourceTime: T },
    { ...proof, admittedAt: T }, { ...proof, receivedAt: T + 1 }])
    assert.equal(observationTimeAdmitted({ ...source, raw: { timeAdmission } }, T + 1000), false);
  assert.equal(observationTimeAdmitted({ sourceTime: T, receivedAt: T }, T - 1), false);
  assert.equal(classifySourceTime({ sourceTime: T, receivedAt: T, now: T - 1 }).status, 'invalid');
});
test('ordinary observations need no admission metadata and deferred time cannot renew lifetime', () => {
  assert.equal(observationTimeAdmitted({ sourceTime: T - 10, receivedAt: T }, T), true);
  assert.equal(validateAdmittedSourceTime({ sourceTime: T, receivedAt: T, admittedAt: null }), false);
  assert.equal(classifySourceTime({ sourceTime: T + 400, receivedAt: T, now: T + 500, maxAgeMs: 450 }).status, 'stale');
});
