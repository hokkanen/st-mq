import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlAttempt } from '../src/storage/control-attempt.js';
import { createWriteHealth } from '../src/storage/write-health.js';

const fault = () => Object.assign(new Error('Synthetic private failure'), { errcode: 10 });
function fixture(kind = 'mutation') {
  const health = createWriteHealth();
  return { health, attempt: createControlAttempt({ store: { writeHealth: health }, context: 'charger1-command', kind }),
    count: () => health.status().history.windows.day.commandsNotSent };
}

test('one unsent attempt counts once across adapter, rollback and controller propagation', () => {
  const f = fixture();
  f.attempt.fail(fault()); f.attempt.notSent('recording-failed');
  f.attempt.storageWaiting(true); f.attempt.expire(); f.attempt.finish();
  assert.equal(f.count(), 1);
});

test('queries, sent writes, committed follow-ups and unrelated errors cannot become known unsent', () => {
  for (const scenario of ['query', 'sent', 'committed', 'unrelated', 'finished']) {
    const f = fixture(scenario === 'query' ? 'query' : 'mutation');
    if (scenario === 'sent') f.attempt.dispatched();
    if (scenario === 'finished') f.attempt.finish();
    f.attempt.fail(scenario === 'committed' ? Object.assign(fault(), { committed: true })
      : scenario === 'unrelated' ? new Error('Native reading unavailable') : fault());
    assert.equal(f.count(), 0, scenario);
  }
});

test('expiry needs current explicit storage waiting; source-clock waiting is not storage', () => {
  const f = fixture(); f.attempt.expire();
  f.attempt.storageWaiting(true); f.attempt.storageWaiting(false); f.attempt.expire();
  assert.equal(f.count(), 0);
  f.attempt.storageWaiting(true); f.attempt.expire();
  assert.equal(f.count(), 1);
});

test('safe rollback classification counts without retaining the underlying private error', () => {
  const f = fixture();
  f.attempt.fail(Object.assign(new Error('The preceding save was rolled back.'),
    { code: 'STORAGE_WRITE_ROLLED_BACK', recordingFailureCode: 'disk-full' }));
  assert.equal(f.count(), 1);
  assert.equal(f.health.status().history.windows.day.incidents.at(-1).reason, 'recording-failed');
});

test('diagnostic sink failure never escapes command accounting', () => {
  const attempt = createControlAttempt({ store: { writeHealth: { commandNotSent() { throw new Error('Diagnostic failure'); } } },
    context: 'charger2-command' });
  assert.doesNotThrow(() => { attempt.fail(fault()); attempt.storageWaiting(true); attempt.expire(); attempt.dispatched(); attempt.finish(); });
});
