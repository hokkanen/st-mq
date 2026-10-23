import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, validateCurrentDatabase } from '../src/storage/store.js';
import { learningCheckpointDisplay, MAX_LEARNING_CHECKPOINT_REFERENCES } from '../src/storage/learning-checkpoint-storage.js';

const key = 'adaptive:providers';
const fields = ['algorithmVersion', 'model', 'health', 'baselineC', 'comfortReference',
  'journalCursor', 'learningConfiguration', 'cursor', 'measurementEpochAt'];
const sample = index => ({ timestamp: index * 900000, indoorC: 21, quality: [],
  inputSegments: [{ start: (index - 1) * 900000, end: index * 900000, thermalAuxKw: 0 }] });
const checkpoint = (samples = [sample(1)]) => ({
  algorithmVersion: 'synthetic-display-algorithm', model: { version: 4, parameters: { lossPerHour: .031 } },
  health: { usableSamples: samples.length, acceptedFits: 0 }, baselineC: 0,
  comfortReference: { targetC: 21.4, provisional: false }, journalCursor: 123,
  learningConfiguration: { indoorSensorWeights: { bedroom_temperature: 1 } },
  cursor: '2026-10-23T12:00:00Z', measurementEpochAt: null, samples,
  estimatedState: { reserveC: 20 }, checkpointDigest: 'a'.repeat(64),
  episodeArchive: [{ id: 'synthetic-episode', samples: [samples[0], samples[0]] }],
});
const expected = value => Object.fromEntries(fields.map(field => [field, value[field]]));
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
const manifest = store => JSON.parse(store.db.prepare('SELECT value FROM state WHERE key=?').get(key).value);

test('display matches the complete reader projection, with detached values and no history fields', t => {
  const store = fixture(t), value = checkpoint();
  store.setState(key, value);
  const before = store.checkpoint(), display = store.getLearningCheckpointDisplay(key);
  assert.deepEqual(display, expected(store.getState(key)));
  assert.deepEqual(Object.keys(display), fields);
  display.model.parameters.lossPerHour = 999;
  display.comfortReference.targetC = -999;
  display.learningConfiguration.indoorSensorWeights.bedroom_temperature = 0;
  assert.deepEqual(store.getLearningCheckpointDisplay(key), expected(value));
  assert.deepEqual(store.checkpoint(), before);
});

test('display equals complete-reader projection across varied current metadata and episode membership', t => {
  const store = fixture(t);
  for (let index = 0; index < 64; index++) {
    const samples = Array.from({ length: index % 8 }, (_, i) => sample(i + 1));
    const value = { ...checkpoint(samples), episodeArchive: samples.length
      ? [{ id: 'varied', samples: samples.toReversed() }, { id: 'repeated', samples: [samples[0], samples[0]] }] : [],
    baselineC: index % 3 === 0 ? null : index % 3 === 1 ? 0 : 21.4,
    health: index % 4 === 0 ? undefined : { usableSamples: index, acceptedFits: 0 },
    comfortReference: index % 5 === 0 ? null : { targetC: 21 + index / 100, provisional: index % 2 === 0 },
    learningConfiguration: index % 3 === 0 ? {} : { indoorSensorWeights: { bedroom_temperature: .5, indoor_temperature: .5 } },
    measurementEpochAt: index % 2 ? index * 1000 : null,
    };
    store.setState(key, value);
    assert.deepEqual(store.getLearningCheckpointDisplay(key), expected(store.getState(key)));
  }
});

test('absent, null and genuinely absent optional current fields retain their meanings', t => {
  const store = fixture(t);
  assert.equal(store.getLearningCheckpointDisplay(key), null);
  for (const value of [null, {}, { samples: [] }, { model: { version: 4 }, baselineC: 0 }]) {
    store.setState(key, value);
    assert.deepEqual(store.getLearningCheckpointDisplay(key), value === null ? null : expected(value));
  }
  for (const bad of ['settings:providers', '', null, 1])
    assert.throws(() => store.getLearningCheckpointDisplay(bad));
});

test('cold display resolves unique indexed references in bounded batches without reading any body', t => {
  const store = fixture(t), samples = Array.from({ length: 300 }, (_, index) => sample(index + 1));
  store.setState(key, checkpoint([...samples, samples[0]]));
  const prepare = store.db.prepare.bind(store.db), batches = [];
  t.mock.method(store.db, 'prepare', sql => {
    if (sql.includes('learning_checkpoint_samples')) {
      assert.match(sql, /^SELECT digest FROM learning_checkpoint_samples WHERE digest IN \(/);
      const statement = prepare(sql);
      return { all(...args) { batches.push(args.length); return statement.all(...args); } };
    }
    return prepare(sql);
  });
  assert.deepEqual(store.getLearningCheckpointDisplay(key), expected(checkpoint([...samples, samples[0]])));
  assert.deepEqual(batches, [128, 128, 44]);
  const plan = prepare('EXPLAIN QUERY PLAN SELECT digest FROM learning_checkpoint_samples WHERE digest IN (?)')
    .all(manifest(store).sampleRefs[0]).map(row => row.detail).join('; ');
  assert.match(plan, /SEARCH learning_checkpoint_samples USING COVERING INDEX/);
  assert.doesNotMatch(plan, /SCAN learning_checkpoint_samples/);
});

test('lookup failures release only an owned read transaction and respect caller-owned transactions', t => {
  const store = fixture(t);
  store.setState(key, checkpoint());
  const prepare = store.db.prepare.bind(store.db), failure = new Error('Synthetic indexed-read failure');
  const mock = t.mock.method(store.db, 'prepare', sql => {
    if (sql.startsWith('SELECT digest FROM learning_checkpoint_samples')) throw failure;
    return prepare(sql);
  });
  assert.throws(() => store.getLearningCheckpointDisplay(key), error => error === failure);
  assert.equal(store.db.isTransaction, false);
  store.db.exec('BEGIN');
  assert.throws(() => store.getLearningCheckpointDisplay(key), error => error === failure);
  assert.equal(store.db.isTransaction, true);
  store.db.exec('ROLLBACK');
  mock.mock.restore();
  assert.equal(store.getLearningCheckpointDisplay(key).baselineC, 0);
});

test('missing fitting or archived references reject a partial display without repairing storage', t => {
  for (const archiveOnly of [false, true]) {
    const store = fixture(t), value = checkpoint();
    if (archiveOnly) value.episodeArchive[0].samples = [sample(2)];
    store.setState(key, value);
    const compact = manifest(store), ref = archiveOnly ? compact.episodeArchive[0].sampleRefs[0] : compact.sampleRefs[0];
    store.transaction(() => store.db.prepare('DELETE FROM learning_checkpoint_samples WHERE digest=?').run(ref));
    const before = store.checkpoint();
    assert.throws(() => store.getLearningCheckpointDisplay(key), { code: 'database_integrity_failed' });
    assert.deepEqual(store.checkpoint(), before);
    assert.equal(store.db.prepare('SELECT digest FROM learning_checkpoint_samples WHERE digest=?').get(ref), undefined);
  }
});

test('unsupported and malformed current manifests fail closed before body lookup', t => {
  const store = fixture(t);
  store.setState(key, checkpoint());
  const valid = manifest(store);
  const invalid = [
    [], 1, {}, { ...valid, checkpointStorageVersion: 0 }, { ...valid, checkpointStorageVersion: 2 },
    { ...valid, samples: [] }, { ...valid, sampleRefs: null }, { ...valid, sampleRefs: [null] },
    { ...valid, sampleRefs: ['not-a-digest'] }, { ...valid, sampleRefs: ['A'.repeat(64)] },
    { ...valid, episodeArchive: {} }, { ...valid, episodeArchive: [null] },
    { ...valid, episodeArchive: [{ samples: [] }] },
    { ...valid, episodeArchive: [{ checkpointStorageVersion: 1 }] },
    { ...valid, episodeArchive: [{ sampleRefs: [123] }] },
    { ...valid, sampleRefs: Array(MAX_LEARNING_CHECKPOINT_REFERENCES + 1).fill('a'.repeat(64)) },
    { ...valid, sampleRefs: Array(MAX_LEARNING_CHECKPOINT_REFERENCES).fill('a'.repeat(64)),
      episodeArchive: [{ sampleRefs: ['b'.repeat(64)] }] },
  ];
  for (const value of invalid)
    assert.throws(() => learningCheckpointDisplay(store.db, value), { code: 'database_state_incompatible' });
  store.transaction(() => store.db.prepare('UPDATE state SET value=? WHERE key=?').run('"malformed"', key));
  assert.throws(() => store.getLearningCheckpointDisplay(key), { code: 'database_state_incompatible' });
});

test('recorded metadata is not a hydration or body-integrity proof; complete readers remain strict', t => {
  const store = fixture(t), value = checkpoint();
  store.setState(key, value);
  const ref = manifest(store).sampleRefs[0];
  store.transaction(() => store.db.prepare('UPDATE learning_checkpoint_samples SET payload=? WHERE digest=?')
    .run('{"damaged":true}', ref));
  assert.deepEqual(store.getLearningCheckpointDisplay(key), expected(value),
    'The display reads saved metadata independently of unused fitting bodies');
  assert.throws(() => store.getState(key), { code: 'database_integrity_failed' });
  assert.throws(() => validateCurrentDatabase(store.db, { full: true }), { code: 'database_integrity_failed' });
});

test('read-only display selects metadata and references from one SQLite snapshot during concurrent replacement', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-home-display-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.sqlite'), writer = new Store(path);
  t.after(() => writer.close());
  const before = checkpoint(), after = { ...checkpoint([sample(2)]), baselineC: 22 };
  writer.setState(key, before);
  const reader = new Store(path, { readOnly: true });
  t.after(() => reader.close());
  const prepare = reader.db.prepare.bind(reader.db);
  let replaced = false;
  t.mock.method(reader.db, 'prepare', sql => {
    if (!replaced && sql.startsWith('SELECT digest FROM learning_checkpoint_samples')) {
      replaced = true;
      writer.transaction(() => {
        writer.setState(key, after);
        writer.db.prepare('DELETE FROM learning_checkpoint_samples WHERE digest=?').run(manifest(reader).sampleRefs[0]);
      });
    }
    return prepare(sql);
  });
  assert.deepEqual(reader.getLearningCheckpointDisplay(key), expected(before));
  assert.equal(reader.db.isTransaction, false);
  assert.deepEqual(reader.getLearningCheckpointDisplay(key), expected(after));
  assert.equal(replaced, true);
  const bytes = readFileSync(path);
  reader.getLearningCheckpointDisplay(key);
  assert.deepEqual(readFileSync(path), bytes);
});
