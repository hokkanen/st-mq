import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { caravanQualificationKey, validateCaravanQualification, createCaravanQualification,
  advanceCaravanQualification, loseCaravanQualification, caravanQualificationCurrentKey } from '../src/domain/caravan-qualification.js';

const START = 1_000_000, identity = 'a'.repeat(64), signature = 'b'.repeat(64), meterSignature = 'c'.repeat(64);
const proof = { startedAt: START - 20_000, completedAt: START - 1000,
  powerRiseW: 6, powerFallW: 6, minimumChangeW: 3,
  phases: { baseline: { commandAt: null, firstPowerObservedAt: START - 25_000, lastPowerObservedAt: START - 15_000 },
    on: { commandAt: START - 15_000, firstPowerObservedAt: START - 14_000, lastPowerObservedAt: START - 9000 },
    off: { commandAt: START - 9000, firstPowerObservedAt: START - 6000, lastPowerObservedAt: START - 1000 } } };
const record = overrides => ({ identity, signature, meterSignature, proof: structuredClone(proof), failed: null,
  revision: 1, recheckAt: null,
  invalidatedAt: null, outageAt: START, lastHealthyAt: START - 1, powerAt: START - 1, meterAt: START - 1, ...overrides });
const step = (watch, offset, extra = {}) => advanceCaravanQualification(watch, { now: START + offset,
  healthy: true, powerAt: START + offset, meterAt: START + offset, ...extra });

test('a genuine return at 59,999 ms keeps the original pass through exact stable recovery', () => {
  const w = createCaravanQualification(record());
  assert.equal(step(w, 59_999).ready, false);
  assert.equal(w.record.invalidatedAt, null);
  assert.equal(step(w, 89_998).ready, false);
  assert.equal(step(w, 89_999).ready, true);
  assert.deepEqual(w.record.proof, proof);
});

test('return at exactly 60,000 ms cannot resurrect expired association and needs a new check', () => {
  const w = createCaravanQualification(record());
  assert.equal(step(w, 60_000).ready, false);
  assert.equal(w.record.invalidatedAt, START + 60_000);
  const result = step(w, 90_000);
  assert.equal(result.ready, false); assert.equal(result.testReady, true);
  assert.deepEqual(w.record.proof, proof, 'Historical proof is retained without granting current qualification');
});

test('nonadvancing source clocks cannot end loss or complete a recovery', () => {
  const w = createCaravanQualification(record());
  assert.equal(step(w, 59_999, { powerAt: START - 1, meterAt: START - 1 }).ready, false);
  assert.equal(w.outageAt, START);
  step(w, 60_000);
  assert.equal(step(w, 90_000, { powerAt: START + 60_000, meterAt: START + 60_000 }).testReady, false);
  assert.equal(step(w, 90_000, { powerAt: START + 90_000, meterAt: START + 60_000 }).testReady, false,
    'Independent appliance advancement cannot substitute for a meter report');
});

test('flapping resets stable recovery while each genuine healthy return ends continuous loss', () => {
  const w = createCaravanQualification(record()); step(w, 20_000);
  loseCaravanQualification(w, START + 25_000);
  step(w, 40_000);
  assert.equal(step(w, 69_999).ready, false);
  assert.equal(step(w, 70_000).ready, true, 'The two brief outages are not accumulated into one 60-second outage');
  assert.equal(w.record.invalidatedAt, null);
});

test('a failed check remains latched across brief reconnection and restart', () => {
  const failed = record({ failed: { at: START - 500, reason: 'no-power-rise' }, invalidatedAt: START - 500 });
  const w = createCaravanQualification(failed); step(w, 20_000);
  assert.equal(step(w, 50_000).testReady, false);
  const restart = createCaravanQualification(w.record);
  step(restart, 50_001); assert.equal(step(restart, 80_001).testReady, false);
  loseCaravanQualification(restart, START + 80_002);
  step(restart, 140_002);
  assert.equal(step(restart, 170_002).testReady, true, 'A sustained new outage may rearm only after stable feeds');
});

test('checkpoint advances only on new evidence from both feeds and never from reads', () => {
  const w = createCaravanQualification(record({ outageAt: null, lastHealthyAt: START, powerAt: START, meterAt: START }));
  step(w, 1); const first = w.record.lastHealthyAt;
  step(w, 30_000, { powerAt: START + 1, meterAt: START + 1 });
  assert.equal(w.record.lastHealthyAt, first);
  step(w, 30_001, { meterAt: START + 1 }); assert.equal(w.record.lastHealthyAt, first);
  step(w, 30_001); assert.equal(w.record.lastHealthyAt, START + 30_001);
  step(w, 80_000, { powerAt: START + 30_001, meterAt: START + 30_001 });
  assert.equal(w.record.lastHealthyAt, START + 30_001);
  assert.deepEqual(w.record.proof, proof);
});

test('clock rollback and future saved evidence cannot shorten recovery or acquire qualification', () => {
  const w = createCaravanQualification(record({ lastHealthyAt: START + 10_000, powerAt: START + 10_000, meterAt: START + 10_000 }));
  assert.equal(step(w, 0).ready, false); assert.equal(w.record.lastHealthyAt, START + 10_000);
  assert.equal(step(w, 10_001).ready, false);
  assert.equal(step(w, 40_000).ready, false); assert.equal(step(w, 40_001).ready, true);
  assert.deepEqual(w.record.proof, proof);
});

test('strict current association rejects malformed rows before writable setup and preserves original bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'caravan-association-current-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const key = caravanQualificationKey('caravan_dehumidifier', identity, signature);
  for (const [n, value] of [null, false, 0, '', [], { ...record(), retired: true },
    { ...record(), identity: 'd'.repeat(64) }, { ...record(), proof: { ...proof, minimumChangeW: 0 } },
    { ...record(), revision: -1 }, { ...record(), recheckAt: 'retired' },
    { ...record(), proof: { ...proof, completedAt: START + 86_400_000 } }].entries()) {
    const path = join(directory, `${n}.sqlite`), writer = new Store(path);
    writer.setState(key, value); writer.db.exec('PRAGMA journal_mode=DELETE'); writer.close();
    const before = await readFile(path), names = await readdir(directory);
    assert.throws(() => new Store(path), { code: 'database_state_incompatible' });
    assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(directory), names);
  }
  for (const [n, value] of [null, false, {}, { identity, signature, retired: true }].entries()) {
    const path = join(directory, `selection-${n}.sqlite`), writer = new Store(path);
    writer.setState(caravanQualificationCurrentKey('caravan_dehumidifier'), value);
    writer.db.exec('PRAGMA journal_mode=DELETE'); writer.close();
    const before = await readFile(path);
    assert.throws(() => new Store(path), { code: 'database_state_incompatible' });
    assert.deepEqual(await readFile(path), before);
  }
  const path = join(directory, 'current.sqlite'), current = new Store(path);
  current.setState(key, record()); current.close();
  const reopened = new Store(path); assert.deepEqual(reopened.getState(key), record()); reopened.close();
  assert.equal(validateCaravanQualification(null), null, 'Only a genuinely absent new runtime record uses the default');
});


test('a clock rollback cannot restart the stable interval at an earlier wall time', () => {
  const w = createCaravanQualification(record()); step(w, 20_000); step(w, 40_000);
  assert.equal(step(w, 10_000).ready, false);
  assert.equal(step(w, 39_999).ready, false);
  step(w, 40_001); assert.equal(step(w, 70_000).ready, false);
  assert.equal(step(w, 70_001).ready, true);
});

test('current declared meter provenance must match the actual selected meter scope', () => {
  assert.throws(() => validateCaravanQualification(record(), { identity, signature, meterSignature: 'd'.repeat(64) }));
  assert.deepEqual(validateCaravanQualification(record(), { identity, signature, meterSignature }), record());
});
