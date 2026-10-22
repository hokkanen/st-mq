import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { applyLearningRecord, replayLearningJournal} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const start = Date.UTC(2026, 0, 1), HOUR = 3_600_000;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-learning-lock-'));
  const dbPath = join(directory, 'synthetic.sqlite'), store = new Store(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store };
}

async function historyFixture(t) {
  const result = fixture(t), file = join(result.directory, 'synthetic.csv');
  writeFileSync(file, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n'
    + Array.from({ length: 24 }, (_, i) => `${(start + i * HOUR) / 1000},10,15,21,10,0\n`).join(''));
  await importCsv(result.store, file, { kind: 'stmq' });
  return result;
}

// Probe when model replay reads a sample, not after an arbitrary timer. A
// second real SQLite connection must be able to write at that exact point.
const workerHarness = `
const { workerData, parentPort } = require('node:worker_threads');
(async () => {
  const { Store } = await import(workerData.storeModule);
  if (workerData.observeTrainingRows) {
    const trainingRows = Store.prototype.trainingRows;
    Store.prototype.trainingRows = function(options) {
      parentPort.postMessage({ trainingRead: options });
      return trainingRows.call(this, options);
    };
  }
  const probe = workerData.probe ? new Store(workerData.dbPath) : null;
  if (probe) {
    probe.db.exec('PRAGMA busy_timeout=0');
    let checked = false;
    const journal = Store.prototype.learningJournal;
    Store.prototype.learningJournal = function(...args) {
      return journal.apply(this, args).map(entry => {
        const value = entry.payload.value;
        entry.payload = { ...entry.payload, get value() {
          if (!checked) {
            probe.event('synthetic-replay-write', { ok: true });
            checked = true;
          }
          return value;
        } };
        return entry;
      });
    };
  }
  if (workerData.failCheckpoint) {
    const setState = Store.prototype.setState;
    Store.prototype.setState = function(key, value) {
      if (key === 'adaptive:history') throw new Error('synthetic-checkpoint-failure');
      return setState.call(this, key, value);
    };
  }
  try { await import(workerData.learningModule); }
  finally { probe?.close(); }
})().catch(error => { parentPort.postMessage({ error: error.message }); parentPort.close(); });
`;

function runHistory(dbPath, options = {}) {
  return new Promise((resolve, reject) => {
    let failure = null; const trainingReads = [];
    const worker = new Worker(workerHarness, { eval: true, workerData: { dbPath,
      storeModule: new URL('../src/storage/store.js', import.meta.url).href,
      learningModule: new URL('../src/app/learning-worker.js', import.meta.url).href, ...options } });
    worker.on('message', result => { if (result.error) failure = new Error(result.error); if (result.trainingRead) trainingReads.push(result.trainingRead); });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => failure ? reject(failure) : code ? reject(new Error(`Worker exit ${code}`)) : resolve(trainingReads));
  });
}

test('journal replay permits a concurrent writer during model computation', t => {
  const { dbPath, store } = fixture(t), writer = new Store(dbPath);
  t.after(() => writer.close());
  writer.db.exec('PRAGMA busy_timeout=0');
  appendLearningRecord(store, 'mqtt', 'sample', { timestamp: start, indoorC: 21, outdoorC: 0,
    phase: 'normal', regime: 'occupied', quality: [] });
  let checked = false;
  const facade = {
    db: store.db,
    transaction: store.transaction.bind(store), setState: store.setState.bind(store),
    learningJournal(...args) {
      return store.learningJournal(...args).map(entry => {
        const value = entry.payload.value;
        entry.payload = { ...entry.payload, get value() {
          if (!checked) { writer.event('synthetic-replay-write', { ok: true }); checked = true; }
          return value;
        } };
        return entry;
      });
    },
  };
  const checkpoint = replayLearningJournal(facade, 'mqtt');
  assert.equal(checked, true);
  assert.equal(store.events().length, 1);
  assert.deepEqual(store.getState('adaptive:mqtt'), checkpoint, 'The model and journal cursor commit together');
});

test('history worker releases the writer lock before applying its committed journal page', async t => {
  const { dbPath, store } = await historyFixture(t);
  await runHistory(dbPath, { probe: true });
  assert.equal(store.events().filter(row => row.type === 'synthetic-replay-write').length, 1);
  assert.equal(store.learningJournal({ input: 'history' }).length, 93);
  assert.equal(store.getState('adaptive:history').samples.length, 93);
  assert.equal(store.getState('learning:health').status, 'history-current');
});

test('a crash after journal commit resumes original entries even when model settings changed', async t => {
  const { dbPath, store } = await historyFixture(t);
  await assert.rejects(runHistory(dbPath, { failCheckpoint: true, config: { heatPumpCompressorKw: 3 } }), /synthetic-checkpoint-failure/);
  const entries = store.learningJournal({ input: 'history' });
  assert.equal(entries.length, 93, 'The immutable journal survives failure of the separate checkpoint transaction');
  assert.equal(store.getState('learning:history'), null);
  assert.equal(store.getState('adaptive:history'), null);
  await runHistory(dbPath, { config: { heatPumpCompressorKw: 3.4 } });
  assert.deepEqual(store.learningJournal({ input: 'history' }), entries, 'Restart reuses the committed records');
  const saved = store.getState('adaptive:history');
  const { historyCursor, historyResampling, reconstruction, ...checkpoint } = saved;
  assert.deepEqual(checkpoint, entries.reduce((previous, entry) => applyLearningRecord(previous, entry), null));
  assert.equal(historyCursor, store.getState('learning:health').adaptiveCursor);
  assert.ok(historyResampling.previous);
  assert.equal(reconstruction.source, 'imported-requested-modes-and-temperatures');
  await runHistory(dbPath, { config: { heatPumpCompressorKw: 3.4 } });
  assert.deepEqual(store.getState('adaptive:history'), saved);
  assert.equal(store.getState('learning:health').processed, 0);
});

test('history worker retains an empty native tail across restart without skipping later imports or a lost model cache', async t => {
  const { dbPath, store, directory } = await historyFixture(t);
  await runHistory(dbPath);
  const initial = store.getState('adaptive:history'), entries = store.learningJournal({ input: 'history' });
  store.transaction(() => {
    for (let day = 0; day < 1095; day++) store.observation({ source: 'mqtt-temperature', device: 'synthetic-room',
      signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start + day * 24 * HOUR,
      receivedAt: start + day * 24 * HOUR, quality: [] });
  });
  const through = store.db.prepare('SELECT MAX(id) id FROM observations').get().id;
  await runHistory(dbPath);
  const reads = await runHistory(dbPath, { observeTrainingRows: true });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].afterId, through, 'A fresh worker seeks beyond the already checked native suffix');
  assert.deepEqual(store.getState('adaptive:history'), initial);
  assert.deepEqual(store.learningJournal({ input: 'history' }), entries);
  const scan = store.getState('learning:history-scan');
  store.setState('learning:history-scan', { ...scan, cursor: 'malformed' });
  const invalidated = await runHistory(dbPath, { observeTrainingRows: true });
  assert.equal(invalidated[0].afterId, initial.historyCursor, 'A malformed disposable watermark supplies no source authority');
  store.db.prepare("UPDATE history_selection SET generation='synthetic-reselection' WHERE id=1").run();
  const reselected = await runHistory(dbPath, { observeTrainingRows: true });
  assert.equal(reselected[0].afterId, initial.historyCursor, 'A changed historical selection invalidates the skipped suffix');
  assert.deepEqual(store.getState('adaptive:history'), initial);

  const file = join(directory, 'later.csv');
  writeFileSync(file, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n'
    + `${(start + 25 * HOUR) / 1000},10,15,21,10,0\n${(start + 26 * HOUR) / 1000},10,15,21,10,0\n`);
  await importCsv(store, file, { kind: 'stmq' });
  await runHistory(dbPath);
  const expected = store.getState('adaptive:history'), allEntries = store.learningJournal({ input: 'history' });
  assert(allEntries.length > entries.length, 'Later publication remains visible beyond the saved empty suffix');
  store.setState('adaptive:history', null);
  await runHistory(dbPath);
  const rebuilt = store.getState('adaptive:history');
  rebuilt.reconstruction.recordedAt = expected.reconstruction.recordedAt;
  assert.deepEqual(rebuilt, expected, 'The source optimization cannot seed a missing model; only the reconstruction receipt time changes');
  assert.deepEqual(store.learningJournal({ input: 'history' }), allEntries);
});
