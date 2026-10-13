import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { caravanPowerTimingKey, validateCaravanPowerTiming, caravanPowerRestartAt,
  observeCaravanPower } from '../src/domain/caravan-power-timing.js';

const identity = 'a'.repeat(64), signature = 'b'.repeat(64), at = 1_000_000;
const valid = () => ({ identity, signature, power: 'off', sourceAt: at, receivedAt: at, admittedAt: at, offConfirmation: null });
const key = caravanPowerTimingKey('fixture_appliance', identity, signature);

test('current native power timing is strict and repeated Off retains original clocks', () => {
  const original = valid(); assert.equal(validateCaravanPowerTiming(original, { identity, signature }), original);
  assert.equal(observeCaravanPower(original, { ...original, sourceAt: at + 10_000, receivedAt: at + 10_000, admittedAt: at + 10_000 }), original);
  assert.equal(caravanPowerRestartAt(original), at + 300_000);
  const on = observeCaravanPower(original, { ...original, power: 'on', sourceAt: at + 1, receivedAt: at + 1, admittedAt: at + 1 });
  assert.equal(caravanPowerRestartAt(on), null);
  assert.equal(observeCaravanPower(original, { ...original, power: 'on' }), original, 'old contradictory source cannot replace the actual transition');
});

test('unsupported timing rows are rejected at writable preflight without mutating saved bytes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'caravan-timing-preflight-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [false, 0, '', null, [], { ...valid(), inferredAt: at }, { ...valid(), identity: 'c'.repeat(64) },
    Object.fromEntries(Object.entries(valid()).filter(([field]) => field !== 'offConfirmation')),
    { ...valid(), admittedAt: at - 1 }, { ...valid(), offConfirmation: { sourceAt: at - 1, receivedAt: at, admittedAt: at } },
    { ...valid(), power: 'on', offConfirmation: { sourceAt: at, receivedAt: at, admittedAt: at } },
    { ...valid(), offConfirmation: { sourceAt: at, receivedAt: at, admittedAt: at, renewed: true } }];
  for (const [index, value] of cases.entries()) {
    const path = join(directory, `${index}.sqlite`), store = new Store(path);
    store.setState(key, value); store.close();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.throws(() => new Store(path), error => error.code === 'database_state_incompatible');
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
  }
  for (const unsupported of [key.replace(':v1:', ':v0:'), key.replace(identity, 'invalid'), key + ':extra']) {
    const path = join(directory, createHash('sha256').update(unsupported).digest('hex') + '.sqlite');
    const store = new Store(path); store.setState(unsupported, valid()); store.close();
    const bytes = readFileSync(path); assert.throws(() => new Store(path), /native power timing/); assert.deepEqual(readFileSync(path), bytes);
  }
  const malformed = join(directory, 'malformed-json.sqlite'), store = new Store(malformed);
  store.setState(key, valid());
  store.transaction(() => store.db.prepare('UPDATE state SET value=? WHERE key=?').run('{', key)); store.close();
  const before = readFileSync(malformed); assert.throws(() => new Store(malformed), /native power timing/);
  assert.deepEqual(readFileSync(malformed), before);
});

test('current same-schema backup retains original timing and confirmation clocks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'caravan-timing-backup-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'source.sqlite')), value = { ...valid(),
    offConfirmation: { sourceAt: at + 10_000, receivedAt: at + 10_001, admittedAt: at + 10_002 } };
  store.setState(key, value); await store.backup(join(directory, 'copy.sqlite')); store.close();
  const restored = new Store(join(directory, 'copy.sqlite')); assert.deepEqual(restored.getState(key), value); restored.close();
});
