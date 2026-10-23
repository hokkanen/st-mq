import { createHash } from 'node:crypto';

// This is one current storage representation, independently of the numerical
// learning algorithm. In-memory checkpoints continue to contain full samples.
export const LEARNING_CHECKPOINT_STORAGE_VERSION = 1;
export const MAX_LEARNING_CHECKPOINT_REFERENCES = 65_536;
const LOOKUP_BATCH = 128;
const DISPLAY_FIELDS = ['algorithmVersion', 'model', 'health', 'baselineC', 'comfortReference',
  'journalCursor', 'learningConfiguration', 'cursor', 'measurementEpochAt'];
const DIGEST = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const fail = (integrity = false) => {
  throw Object.assign(new Error(integrity
    ? 'The learning checkpoint has missing or damaged prepared samples. Restore an intact current-version backup or rebuild from the retained learning journal.'
    : 'Unsupported or malformed learning checkpoint storage. Preserve this database and use an intact current-version backup or a new empty database. The existing database was not changed.'),
  { code: integrity ? 'database_integrity_failed' : 'database_state_incompatible' });
};
const hash = payload => createHash('sha256').update(payload).digest('hex');
const normalize = value => {
  let payload;
  try { payload = JSON.stringify(value); return JSON.parse(payload); }
  catch { fail(); }
};

/** Keep the manifest and its immutable bodies at one SQLite boundary, including
 * replica rewind. Existing caller transactions/savepoints own their boundary. */
export function withLearningCheckpointRead(db, operation) {
  if (db.isTransaction) return operation();
  db.exec('BEGIN');
  try { return operation(); }
  finally { db.exec('ROLLBACK'); }
}

/** Validate one immutable, exact JSON-normalized prepared sample. Full audits
 * also use this for shared rows not currently referenced by an active cache. */
export function validateLearningCheckpointSample(row) {
  if (!object(row) || typeof row.payload !== 'string' || !DIGEST.test(row.digest ?? '')
    || hash(row.payload) !== row.digest) fail(true);
  let sample;
  try { sample = JSON.parse(row.payload); } catch { fail(true); }
  if (!object(sample) || JSON.stringify(sample) !== row.payload) fail(true);
  return sample;
}

function compactReferences(checkpoint) {
  if (checkpoint === null) return [];
  if (!object(checkpoint) || checkpoint.checkpointStorageVersion !== LEARNING_CHECKPOINT_STORAGE_VERSION
    || own(checkpoint, 'samples')) fail();
  const references = [];
  const append = owner => {
    if (!own(owner, 'sampleRefs')) return;
    if (!Array.isArray(owner.sampleRefs)
      || owner.sampleRefs.length > MAX_LEARNING_CHECKPOINT_REFERENCES - references.length) fail();
    for (const digest of owner.sampleRefs) {
      if (typeof digest !== 'string' || !DIGEST.test(digest)) fail();
      references.push(digest);
    }
  };
  append(checkpoint);
  if (own(checkpoint, 'episodeArchive')) {
    if (!Array.isArray(checkpoint.episodeArchive)
      || checkpoint.episodeArchive.length > MAX_LEARNING_CHECKPOINT_REFERENCES) fail();
    for (const episode of checkpoint.episodeArchive) {
      if (!object(episode) || own(episode, 'samples') || own(episode, 'checkpointStorageVersion')) fail();
      append(episode);
    }
  }
  return references;
}

export function learningCheckpointSampleReferences(checkpoint) {
  return [...new Set(compactReferences(checkpoint))];
}

function batches(values, operation) {
  for (let start = 0; start < values.length; start += LOOKUP_BATCH) {
    const batch = values.slice(start, start + LOOKUP_BATCH);
    operation(batch, batch.map(() => '?').join(','));
  }
}

/** Persist each distinct prepared value once inside the caller's transaction.
 * Existing keys are sought before insertion: repeated saves never bind or run
 * json_valid against all old bodies. Reads/full audits verify body integrity.
 * No garbage collection may remove bodies retained by old sparse checkpoints,
 * peer baselines or protected branches. */
export function encodeLearningCheckpoint(db, checkpoint, { onInsert } = {}) {
  if (checkpoint === null) return null;
  if (!object(checkpoint) || own(checkpoint, 'checkpointStorageVersion') || own(checkpoint, 'sampleRefs')
    || onInsert !== undefined && typeof onInsert !== 'function' || !db.isTransaction) fail();
  const bodies = new Map();
  let references = 0;
  const replace = owner => {
    const result = { ...owner };
    if (own(owner, 'samples')) {
      if (!Array.isArray(owner.samples)
        || owner.samples.length > MAX_LEARNING_CHECKPOINT_REFERENCES - references) fail();
      references += owner.samples.length;
      result.sampleRefs = owner.samples.map(sample => {
        if (!object(sample)) fail();
        const payload = JSON.stringify(sample);
        // Objects with a toJSON method must still normalize to a sample object.
        if (!object(JSON.parse(payload))) fail();
        const digest = hash(payload);
        bodies.set(digest, payload);
        return digest;
      });
      delete result.samples;
    }
    return result;
  };
  const compact = replace(checkpoint);
  if (own(checkpoint, 'episodeArchive')) {
    if (!Array.isArray(checkpoint.episodeArchive)
      || checkpoint.episodeArchive.length > MAX_LEARNING_CHECKPOINT_REFERENCES) fail();
    compact.episodeArchive = checkpoint.episodeArchive.map(episode => {
      if (!object(episode) || own(episode, 'sampleRefs') || own(episode, 'checkpointStorageVersion')) fail();
      return replace(episode);
    });
  }
  compact.checkpointStorageVersion = LEARNING_CHECKPOINT_STORAGE_VERSION;
  const result = normalize(compact);
  compactReferences(result);
  const missing = new Set(bodies.keys());
  batches([...missing], (batch, placeholders) => {
    for (const row of db.prepare(`SELECT digest FROM learning_checkpoint_samples WHERE digest IN (${placeholders})`).all(...batch))
      missing.delete(row.digest);
  });
  if (missing.size) {
    const insert = db.prepare('INSERT INTO learning_checkpoint_samples(digest,payload) VALUES(?,?)');
    for (const digest of missing) {
      const row = { digest, payload: bodies.get(digest) };
      insert.run(row.digest, row.payload);
      onInsert?.(row);
    }
  }
  return result;
}

/** Structural startup checks do not scan historical bodies. Full verification
 * and consumers request reference validation at the same coherent boundary. */
export function validateLearningCheckpointStorage(db, checkpoint, { references = false } = {}) {
  compactReferences(checkpoint);
  if (references) decodeLearningCheckpoint(db, checkpoint);
  return checkpoint;
}

/** Read recorded model metadata without hydrating its fitting history. This is
 * not a working/replay checkpoint or a full body-integrity verification. Match
 * the current manifest and its dependency closure at the caller's read boundary;
 * complete hydration and explicit full verification retain body validation. */
export function learningCheckpointDisplay(db, checkpoint) {
  if (checkpoint === null) return null;
  const compact = normalize(checkpoint);
  const references = learningCheckpointSampleReferences(compact);
  return withLearningCheckpointRead(db, () => {
    batches(references, (batch, placeholders) => {
      if (db.prepare(`SELECT digest FROM learning_checkpoint_samples WHERE digest IN (${placeholders})`).all(...batch).length !== batch.length)
        fail(true);
    });
    return Object.fromEntries(DISPLAY_FIELDS.map(key => [key, compact[key]]));
  });
}

export function decodeLearningCheckpoint(db, checkpoint) {
  if (checkpoint === null) return null;
  // Normalize and detach only the compact metadata. The sample bodies are
  // already normalized by validation; serializing the hydrated archive again
  // would duplicate its largest startup/recovery allocation and CPU work.
  const compact = normalize(checkpoint);
  const references = compactReferences(compact);
  return withLearningCheckpointRead(db, () => {
    const samples = new Map();
    batches([...new Set(references)], (batch, placeholders) => {
      for (const row of db.prepare(`SELECT digest,payload FROM learning_checkpoint_samples WHERE digest IN (${placeholders})`).all(...batch))
        samples.set(row.digest, validateLearningCheckpointSample(row));
    });
    if (references.some(digest => !samples.has(digest))) fail(true);
    const restore = owner => {
      const result = { ...owner };
      if (own(owner, 'sampleRefs')) {
        // Duplicate references remain separate values, as after JSON parsing the
        // former complete checkpoint. A consumer cannot mutate another episode.
        result.samples = owner.sampleRefs.map(digest => structuredClone(samples.get(digest)));
        delete result.sampleRefs;
      }
      return result;
    };
    const restored = restore(compact);
    if (own(compact, 'episodeArchive')) restored.episodeArchive = compact.episodeArchive.map(restore);
    delete restored.checkpointStorageVersion;
    return restored;
  });
}
