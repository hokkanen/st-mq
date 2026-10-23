// Synthetic codec benchmark only. No installation configuration, provider,
// live database, writable application runtime or household data is opened.
// Run: node --expose-gc scripts/benchmarks/learning-checkpoint-display.js
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { encodeLearningCheckpoint, decodeLearningCheckpoint, learningCheckpointDisplay } from '../../src/storage/learning-checkpoint-storage.js';

const fields = ['algorithmVersion', 'model', 'health', 'baselineC', 'comfortReference',
  'journalCursor', 'learningConfiguration', 'cursor', 'measurementEpochAt'];
const round = value => Math.round(value * 100) / 100;
const cases = [
  { samples: 64, segments: 8 },
  { samples: 970, segments: 128 },
  { samples: 1536, segments: 128 },
  { samples: 1536, segments: 512 },
  { samples: 1536, segments: 8, episodes: 24 },
];
for (const scope of cases) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE learning_checkpoint_samples(digest TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
  let value = {
    algorithmVersion: 'synthetic-display', model: { version: 4, parameters: { lossPerHour: .031 } },
    health: { usableSamples: scope.samples }, baselineC: 21.4, comfortReference: { targetC: 21.4 },
    journalCursor: scope.samples, learningConfiguration: {}, cursor: '2026-10-23T12:00:00Z', measurementEpochAt: null,
    samples: Array.from({ length: scope.samples }, (_, index) => ({ timestamp: index * 900000,
      inputSegments: Array.from({ length: scope.segments }, (_, segment) => ({ start: index * 900000 + segment,
        end: index * 900000 + segment + 1, outdoorC: 7, thermalCompressorDuty: .5, thermalAuxKw: 0, quality: [] })) })),
  };
  if (scope.episodes) value.episodeArchive = Array.from({ length: scope.episodes }, (_, index) => ({
    id: 'synthetic-episode-' + index, samples: value.samples }));
  db.exec('BEGIN');
  const compact = encodeLearningCheckpoint(db, value);
  value = null;
  const text = JSON.stringify(compact);
  db.prepare('INSERT INTO state VALUES(?,?)').run('adaptive:synthetic', text);
  db.exec('COMMIT');
  const bodyBytes = db.prepare('SELECT SUM(length(payload)) bytes FROM learning_checkpoint_samples').get().bytes;
  const measure = operation => {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed, start = performance.now();
    const result = operation();
    return { result, ms: round(performance.now() - start), allocatedHeapBytes: Math.max(0, process.memoryUsage().heapUsed - before) };
  };
  // Both paths include reading/parsing the compact root on their first call.
  const root = () => JSON.parse(db.prepare('SELECT value FROM state WHERE key=?').get('adaptive:synthetic').value);
  const display = measure(() => learningCheckpointDisplay(db, root()));
  let full = measure(() => decodeLearningCheckpoint(db, root()));
  assert.deepEqual(display.result, Object.fromEntries(fields.map(field => [field, full.result[field]])));
  full.result = null;
  const warm = measure(() => learningCheckpointDisplay(db, root()));
  assert.deepEqual(warm.result, display.result);
  console.log(JSON.stringify({ ...scope, preparedBodyBytes: bodyBytes, manifestBytes: Buffer.byteLength(text),
    fullDecodeMs: full.ms, coldDisplayMs: display.ms, warmDisplayMs: warm.ms,
    fullAllocatedHeapBytes: full.allocatedHeapBytes, displayAllocatedHeapBytes: display.allocatedHeapBytes,
    equal: true, gc: typeof globalThis.gc === 'function' }));
  db.close();
}
