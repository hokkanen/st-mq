import test from 'node:test';
import assert from 'node:assert/strict';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

const START = Date.parse('2026-09-14T12:00:00Z'), MINUTE = 60_000;
function setup(t, { store, start = START } = {}) {
  let now = start;
  const states = new Map();
  store ??= { getState: key => structuredClone(states.get(key) ?? null),
    setState: (key, value) => states.set(key, structuredClone(value)) };
  const deviceId = 'fixture-compressor-state', decoder = createH66Decoder({ deviceId });
  const controller = createH66Controller({ deviceId, store, clock: () => now, config: { maxAgeMs: MINUTE },
    publish: () => { throw new Error('Compressor observation must never publish commands'); } });
  controller.setConnected(true);
  t.after(() => controller.close());
  return { controller, store, states,
    at(value) { now = value; },
    feed(value, extra = {}) { controller.ingest(decoder.decode({ topic: `${deviceId}/HP/1A01`,
      payload: String(value), receivedAt: now, ...extra })); },
    status: () => controller.status().compressorState };
}

test('compressor state duration keeps its first observation and records witnessed transitions', t => {
  const f = setup(t);
  f.feed(0);
  assert.deepEqual(f.status(), { value: 0, since: START, transitionObserved: false });
  f.at(START + MINUTE); f.feed(0);
  assert.deepEqual(f.status(), { value: 0, since: START, transitionObserved: false });
  f.at(START + 2 * MINUTE); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 2 * MINUTE, transitionObserved: true });
  f.at(START + 3 * MINUTE); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 2 * MINUTE, transitionObserved: true });
  f.at(START + 4 * MINUTE); f.feed(0);
  assert.deepEqual(f.status(), { value: 0, since: START + 4 * MINUTE, transitionObserved: true });
  assert.equal(f.states.size, 0, 'read-only duration tracking must not persist control or learning state');
});

test('disconnect and restart discard compressor duration continuity', async t => {
  const f = setup(t); f.feed(1);
  f.at(START + 1000); f.controller.setConnected(false);
  assert.equal(f.status(), null);
  f.controller.setConnected(true); assert.equal(f.status(), null);
  f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 1000, transitionObserved: false });
  await f.controller.close();
  const restarted = setup(t, { store: f.store, start: START + 2000 });
  assert.equal(restarted.status(), null); restarted.feed(1);
  assert.deepEqual(restarted.status(), { value: 1, since: START + 2000, transitionObserved: false });
});

test('an older control-context read cannot erase a newer compressor observation', t => {
  const f = setup(t); f.feed(0);
  f.at(START + 1000); f.feed(1);
  assert.equal(f.controller.status(START).compressorState, null,
    'An earlier context cannot use a report received after that context');
  assert.deepEqual(f.status(), { value: 1, since: START + 1000, transitionObserved: true },
    'A current read retains the genuinely observed transition');
  f.at(START + 2000); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 1000, transitionObserved: true });
  f.at(START + 500);
  assert.equal(f.status(), null, 'An actual clock reversal still breaks continuity');
});

test('a future status projection cannot expire current compressor evidence', t => {
  const f = setup(t); f.feed(1);
  assert.equal(f.controller.status(START + 2 * MINUTE).compressorState, null);
  assert.deepEqual(f.status(), { value: 1, since: START, transitionObserved: false });
  f.at(START + 2 * MINUTE);
  assert.equal(f.status(), null, 'Actual expiry still ends continuity');
  f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 2 * MINUTE, transitionObserved: false });
});

test('stale gaps reset duration even when no status was requested during the gap', t => {
  const f = setup(t); f.feed(1);
  f.at(START + MINUTE); assert.notEqual(f.status(), null);
  f.at(START + MINUTE + 1); assert.equal(f.status(), null);
  f.at(START + 2 * MINUTE); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 2 * MINUTE, transitionObserved: false });
  f.at(START + 3 * MINUTE + 1); f.feed(0);
  assert.deepEqual(f.status(), { value: 0, since: START + 3 * MINUTE + 1, transitionObserved: false });
});

test('invalid, retained and out-of-order compressor reports break duration continuity', t => {
  const f = setup(t); f.feed(1);
  f.at(START + 1000); f.feed('invalid'); assert.equal(f.status(), null);
  f.at(START + 2000); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 2000, transitionObserved: false });
  f.at(START + 3000); f.feed(0, { retained: true }); assert.equal(f.status(), null);
  f.at(START + 4000); f.feed(1, { sourceAt: START + 4000 });
  f.at(START + 5000); f.feed(0, { sourceAt: START + 3000 }); assert.equal(f.status(), null);
  f.at(START + 6000); f.feed(1);
  assert.deepEqual(f.status(), { value: 1, since: START + 6000, transitionObserved: false });
});

test('source timestamps supply the observed lower bound and duplicate packets cannot renew it', t => {
  const f = setup(t);
  f.at(START + 10_000); f.feed(1, { sourceAt: START });
  assert.deepEqual(f.status(), { value: 1, since: START, transitionObserved: false });
  f.at(START + 20_000); f.feed(1, { sourceAt: START });
  assert.deepEqual(f.status(), { value: 1, since: START, transitionObserved: false });
  f.at(START + MINUTE + 1); f.feed(1, { sourceAt: START });
  assert.equal(f.status(), null);
});
