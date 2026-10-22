import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION, validateCurrentDatabase } from '../src/storage/store.js';
import { encodeLearningCheckpoint, decodeLearningCheckpoint, learningCheckpointSampleReferences,
  validateLearningCheckpointStorage, validateLearningCheckpointSample,
  MAX_LEARNING_CHECKPOINT_REFERENCES } from '../src/storage/learning-checkpoint-storage.js';

function fixture(t, file = false) {
  const directory = file ? mkdtempSync(join(tmpdir(), 'stmq-compact-checkpoint-')) : null;
  const store = new Store(file ? join(directory, 'fixture.sqlite') : ':memory:');
  t.after(() => { try { store.close(); } catch {} if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const jsonValue = value => JSON.parse(JSON.stringify(value));
const stored = (store, key = 'adaptive:test') => JSON.parse(store.db.prepare('SELECT value FROM state WHERE key=?').get(key).value);
const count = store => store.db.prepare('SELECT COUNT(*) n FROM learning_checkpoint_samples').get().n;
const sample = at => ({ timestamp: new Date(at).toISOString(), indoorC: 21, outdoorC: -2,
  quality: ['observed'], indoorSensors: { indoor_temperature: { value: 21, observedAt: at - 60_000, weight: 1 } },
  inputSegments: [{ start: at - 900_000, end: at, compressorDuty: 0.3, priceContext: { source: 'fixture', prices: [3, 7, null] } }] });
const checkpoint = samples => ({ version: 1, cursor: samples.at(-1)?.timestamp ?? null, samples,
  model: { version: 4, parameters: { reserveTimeHours: 48, lossKwPerC: 0.11 } },
  state: { indoorC: 21, reserveC: 20, slabC: null }, comfortReference: { targetC: 20.9 }, sinceFit: 3 });

test('compact checkpoints restore exact normalized values, duplicate order and episode sample membership', t => {
  const { store } = fixture(t);
  const first = sample(1_800_000), invalid = { timestamp: new Date(2_700_000).toISOString(), valid: false,
    quality: ['invalid-observation'], indoorC: null, sensorEpoch: 12, inputSegments: [{ start: 1_800_000, end: 2_700_000, outdoorC: null }] };
  const value = { ...checkpoint([first, invalid, first]), transient: undefined,
    episodeArchive: [{ id: 'early', warmupFrom: 0, observationTailUntil: 3_600_000, samples: [invalid, first] },
      { id: 'recent', samples: [first, invalid, first] }] };
  store.setState('adaptive:test', value);
  const compact = stored(store);
  assert.equal(compact.checkpointStorageVersion, 1);
  assert.equal(Object.hasOwn(compact, 'samples'), false);
  assert.equal(Object.hasOwn(compact.episodeArchive[0], 'samples'), false);
  assert.deepEqual(compact.sampleRefs, [compact.sampleRefs[0], compact.sampleRefs[1], compact.sampleRefs[0]]);
  assert.equal(count(store), 2);
  assert.deepEqual(store.getState('adaptive:test'), jsonValue(value));
  assert.equal(learningCheckpointSampleReferences(compact).length, 2);
  const restored = store.getState('adaptive:test');
  restored.samples[0].inputSegments[0].priceContext.prices[0] = 99;
  assert.equal(restored.samples[2].inputSegments[0].priceContext.prices[0], 3);
  assert.equal(restored.episodeArchive[0].samples[1].inputSegments[0].priceContext.prices[0], 3);
});

test('prepared interpretations remain distinct while source-identical corrected values share one row', t => {
  const { store } = fixture(t), original = sample(900_000);
  const corrected = { ...original, indoorC: null, quality: ['sensor-change-settling'], measurementEpochAt: 840_000 };
  store.setState('adaptive:original', checkpoint([original]));
  store.setState('adaptive:corrected', checkpoint([corrected]));
  store.setState('adaptive:restored', checkpoint([original]));
  assert.equal(count(store), 2);
  assert.deepEqual(store.getState('adaptive:original').samples[0], original);
  assert.deepEqual(store.getState('adaptive:corrected').samples[0], corrected);
  assert.deepEqual(stored(store, 'adaptive:restored').sampleRefs, stored(store, 'adaptive:original').sampleRefs);
});

test('hydration detaches metadata and samples without serializing the restored fitting archive', t => {
  const { store } = fixture(t), value = { ...checkpoint([sample(900_000)]),
    episodeArchive: [{ id: 'earlier', metadata: { selection: ['original'] }, samples: [sample(900_000)] }] };
  store.setState('adaptive:test', value);
  const compact = stored(store), stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', function (value, ...args) {
    assert.equal(value !== null && typeof value === 'object' && Object.hasOwn(value, 'model')
      && Object.hasOwn(value, 'samples'), false, 'hydrated archives never take a second JSON round trip');
    return stringify.call(this, value, ...args);
  });
  const restored = decodeLearningCheckpoint(store.db, compact);
  assert.deepEqual(restored, value);
  restored.model.parameters.lossKwPerC = 7;
  restored.episodeArchive[0].metadata.selection[0] = 'changed';
  restored.samples[0].inputSegments[0].priceContext.prices[0] = 77;
  assert.equal(compact.model.parameters.lossKwPerC, 0.11);
  assert.equal(compact.episodeArchive[0].metadata.selection[0], 'original');
  assert.equal(restored.episodeArchive[0].samples[0].inputSegments[0].priceContext.prices[0], 3);
});

test('current null, absent optional sample arrays and pre-journal/history metadata retain their meaning', t => {
  const { store } = fixture(t);
  for (const value of [null, { model: { version: 4 }, baselineC: 21 }, { samples: [], episodeArchive: [] },
    { historyCursor: 42, historyResampling: { previous: null }, learningConfiguration: { targetC: 21 } }]) {
    store.setState('adaptive:history', value);
    assert.deepEqual(store.getState('adaptive:history'), value);
    if (value !== null) assert.equal(stored(store, 'adaptive:history').checkpointStorageVersion, 1);
  }
  assert.equal(count(store), 0);
  store.setState('ordinary', { samples: [{ value: 2 }], checkpointStorageVersion: 'ordinary-field' });
  assert.deepEqual(store.getState('ordinary'), { samples: [{ value: 2 }], checkpointStorageVersion: 'ordinary-field' });
});

test('repeated saves insert no old sample bodies or new journal effects', t => {
  const { store } = fixture(t), value = checkpoint([sample(900_000), sample(1_800_000)]);
  store.setState('adaptive:test', value);
  const head = store.checkpoint(), changes = store.databaseChanges();
  const prepare = store.db.prepare.bind(store.db);
  const mock = t.mock.method(store.db, 'prepare', sql => {
    assert.equal(sql.startsWith('INSERT INTO learning_checkpoint_samples'), false, 'old payloads are never rebound for INSERT');
    return prepare(sql);
  });
  assert.equal(store.setState('adaptive:test', value).changes, 0);
  assert.equal(store.databaseChanges(), changes);
  assert.deepEqual(store.checkpoint(), head);
  store.setState('adaptive:test', { ...value, sinceFit: 4 });
  mock.mock.restore();
  const effects = store.exportChanges({ after: head }).commits.flatMap(commit => commit.changes);
  assert.deepEqual(effects.map(effect => effect.table), ['state']);
  assert.equal(count(store), 2);
});

test('sample lookup uses indexed bounded batches rather than reading unrelated history', t => {
  const { store } = fixture(t);
  store.setState('adaptive:unrelated', checkpoint(Array.from({ length: 700 }, (_, index) => sample(900_000 * (index + 1000)))));
  const value = checkpoint(Array.from({ length: 270 }, (_, index) => sample(900_000 * (index + 1))));
  store.setState('adaptive:test', value);
  const queries = [], prepare = store.db.prepare.bind(store.db);
  t.mock.method(store.db, 'prepare', sql => {
    if (sql.startsWith('SELECT digest,payload FROM learning_checkpoint_samples')) queries.push(sql);
    return prepare(sql);
  });
  assert.deepEqual(store.getState('adaptive:test'), value);
  assert.equal(queries.length, 3);
  assert.ok(queries.every(sql => sql.includes('WHERE digest IN (') && (sql.match(/\?/g) ?? []).length <= 128));
});

test('standalone saves and nested transactions roll back sample rows and manifest together', t => {
  const { store } = fixture(t), original = checkpoint([sample(900_000)]);
  store.setState('adaptive:test', original);
  const before = store.checkpoint(), prepare = store.db.prepare.bind(store.db);
  const mock = t.mock.method(store.db, 'prepare', sql => sql.startsWith('INSERT INTO state')
    ? { run() { throw new Error('injected final state failure'); } } : prepare(sql));
  assert.throws(() => store.setState('adaptive:test', checkpoint([sample(1_800_000)])), /injected final state failure/);
  mock.mock.restore();
  assert.equal(count(store), 1);
  assert.deepEqual(store.getState('adaptive:test'), original);
  assert.deepEqual(store.checkpoint(), before);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => {
      store.setState('adaptive:test', checkpoint([sample(2_700_000)]));
      throw new Error('nested rollback');
    }), /nested rollback/);
    assert.deepEqual(store.getState('adaptive:test'), original);
    assert.equal(count(store), 1);
  });
  assert.deepEqual(store.checkpoint(), before);
});

test('missing, corrupt and non-normalized prepared rows fail closed and are never silently repaired', t => {
  const { store } = fixture(t);
  const value = checkpoint([sample(900_000)]);
  store.setState('adaptive:test', value);
  const compact = stored(store), digest = compact.sampleRefs[0];
  const original = store.db.prepare('SELECT digest,payload FROM learning_checkpoint_samples WHERE digest=?').get(digest);
  store.transaction(() => store.db.prepare('DELETE FROM learning_checkpoint_samples WHERE digest=?').run(digest));
  assert.throws(() => store.getState('adaptive:test'), { code: 'database_integrity_failed' });
  assert.throws(() => validateCurrentDatabase(store.db, { full: true }), { code: 'database_integrity_failed' });
  store.transaction(() => store.db.prepare('INSERT INTO learning_checkpoint_samples(digest,payload) VALUES(?,?)').run(digest, original.payload));
  store.transaction(() => store.db.prepare('UPDATE learning_checkpoint_samples SET payload=? WHERE digest=?').run('{"corrupt":true}', digest));
  assert.throws(() => decodeLearningCheckpoint(store.db, compact), { code: 'database_integrity_failed' });
  store.setState('adaptive:test', value);
  assert.throws(() => store.getState('adaptive:test'), { code: 'database_integrity_failed' }, 'saving again cannot silently rewrite immutable data');
  assert.throws(() => validateLearningCheckpointSample({ digest, payload: ` ${original.payload}` }), { code: 'database_integrity_failed' });
});

test('retired inline bodies, unknown versions, malformed references and unbounded arrays are rejected', t => {
  const { store } = fixture(t);
  for (const compact of [{ samples: [] }, { checkpointStorageVersion: 0, sampleRefs: [] },
    { checkpointStorageVersion: 1, samples: [] }, { checkpointStorageVersion: 1, sampleRefs: ['not-a-digest'] },
    { checkpointStorageVersion: 1, sampleRefs: null }, { checkpointStorageVersion: 1, episodeArchive: [{ samples: [] }] },
    { checkpointStorageVersion: 1, sampleRefs: Array(MAX_LEARNING_CHECKPOINT_REFERENCES + 1).fill('a'.repeat(64)) }]) {
    assert.throws(() => validateLearningCheckpointStorage(store.db, compact), { code: 'database_state_incompatible' });
  }
  assert.throws(() => store.setState('adaptive:test', { samples: [null] }), { code: 'database_state_incompatible' });
  assert.throws(() => store.setState('adaptive:test', { checkpointStorageVersion: 1, sampleRefs: [] }), { code: 'database_state_incompatible' });
  assert.equal(count(store), 0);
});

test('unsupported persisted adaptive state rejects before writable setup and preserves main/WAL evidence', t => {
  assert.equal(SCHEMA_VERSION, 34);
  for (const keepOpen of [false, true]) {
    const { store, directory } = fixture(t, true);
    store.transaction(() => store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)')
      .run('adaptive:test', JSON.stringify(checkpoint([sample(900_000)])), 1));
    if (!keepOpen) store.close();
    const fingerprints = () => Object.fromEntries(readdirSync(directory).filter(name => !name.endsWith('-shm')).map(name => {
      const bytes = readFileSync(join(directory, name));
      return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
    }));
    const before = fingerprints();
    assert.throws(() => new Store(store.path), { code: 'database_state_incompatible' });
    const after = fingerprints();
    for (const [name, fingerprint] of Object.entries(before)) assert.deepEqual(after[name], fingerprint, name);
    // A read-only SQLite WAL connection can create empty coordination files on
    // an otherwise closed database. SHM is transient locking metadata; no
    // pre-existing main bytes or WAL evidence may change during rejection.
    for (const name of Object.keys(after).filter(name => !Object.hasOwn(before, name))) {
      assert.ok(name.endsWith('-wal'));
      assert.equal(after[name].bytes, 0);
    }
  }
});

test('read-only evidence survives an unavailable adaptive cache without accepting its model or changing the source', t => {
  for (const payload of ['{invalid', JSON.stringify(checkpoint([sample(900_000)])),
    JSON.stringify({ checkpointStorageVersion: 0, sampleRefs: [] })]) {
    const { store } = fixture(t, true);
    store.observation({ source: 'fixture', device: 'fixture-sensor', signal: 'indoor_temperature',
      value: 21, unit: 'degC', sourceTime: 900_000, receivedAt: 900_000 });
    store.transaction(() => store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)')
      .run('adaptive:test', payload, 1));
    store.close();
    const raw = new DatabaseSync(store.path);
    raw.exec('PRAGMA journal_mode=DELETE');
    raw.close();
    const fingerprint = () => createHash('sha256').update(readFileSync(store.path)).digest('hex');
    const before = fingerprint(), reader = new Store(store.path, { readOnly: true });
    try {
      assert.equal(reader.observations({ signal: 'indoor_temperature' })[0].value, 21);
      assert.throws(() => reader.getState('adaptive:test'), payload === '{invalid'
        ? SyntaxError : { code: 'database_state_incompatible' });
      assert.equal(reader.db.isTransaction, false, 'unavailable model releases its pinned read');
      assert.throws(() => validateCurrentDatabase(reader.db, { full: true, readOnly: true }),
        { code: 'database_state_incompatible' });
      assert.throws(() => reader.db.exec('DELETE FROM observations'), /readonly/i);
    } finally { reader.close(); }
    assert.equal(fingerprint(), before, 'viewing and rejecting the model preserve source bytes');
    assert.throws(() => new Store(store.path), { code: 'database_state_incompatible' });
    assert.equal(fingerprint(), before, 'writable startup rejection preserves source bytes');
  }
});

test('manifest and prepared rows stay coherent when another connection replaces and removes them during hydration', t => {
  const { store } = fixture(t, true), old = checkpoint([sample(900_000)]), next = checkpoint([sample(1_800_000)]);
  store.setState('adaptive:test', old);
  const digest = stored(store).sampleRefs[0], writer = new Store(store.path);
  t.after(() => writer.close());
  const prepare = store.db.prepare.bind(store.db);
  let replaced = false;
  t.mock.method(store.db, 'prepare', sql => {
    if (!replaced && sql.startsWith('SELECT digest,payload FROM learning_checkpoint_samples')) {
      replaced = true;
      assert.equal(store.db.isTransaction, true);
      writer.transaction(() => {
        writer.setState('adaptive:test', next);
        writer.db.prepare('DELETE FROM learning_checkpoint_samples WHERE digest=?').run(digest);
      });
    }
    return prepare(sql);
  });
  assert.deepEqual(store.getState('adaptive:test'), old);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(store.getState('adaptive:test'), next);
});

test('direct codec callers must own an atomic writable boundary and onInsert reports only new bodies', t => {
  const { store } = fixture(t), value = checkpoint([sample(900_000), sample(900_000)]), inserted = [];
  assert.throws(() => encodeLearningCheckpoint(store.db, value), { code: 'database_state_incompatible' });
  const compact = store.transaction(() => encodeLearningCheckpoint(store.db, value, { onInsert: row => inserted.push(row) }));
  store.transaction(() => encodeLearningCheckpoint(store.db, value, { onInsert: row => inserted.push(row) }));
  assert.equal(inserted.length, 1);
  assert.deepEqual(decodeLearningCheckpoint(store.db, compact), value);
});
