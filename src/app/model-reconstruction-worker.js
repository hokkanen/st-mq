import { parentPort, workerData } from 'node:worker_threads';
import { Store, learningJournalRows } from '../storage/store.js';
import { ModelVerificationWork } from '../storage/model-verification-work.js';
import { readCoefficientEvents, readCoefficientCoverage } from '../storage/coefficient-history.js';
import { reconstructionSource, decodeReconstructionEntry } from './model-reconstruction-source.js';
import { createCoefficientReplayState, applyCoefficientReplayEntry } from './model-reconstruction-replay.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';
import { sensorLearningContext } from './sensor-inputs.js';
import { validLearningCheckpoint, learningCheckpointDigest, learningVersion } from './committed-learning.js';
import { storageStep, setStorageMaintenance, releaseStorageLease, admittedReader } from '../storage/worker-admission.js';
import { readCheckpoint, matchingCheckpoint, checkpointAt } from '../storage/journal.js';
import { modelVerificationDifferences } from './model-verification-differences.js';

const cancellation = new Int32Array(workerData.cancellation);
const waiters = new Map();
let request = 0, work;
const stopped = () => Atomics.load(cancellation, 0) !== 0;
const failure = code => Object.assign(new Error(code), { code });
const emptyHash = learningVersion([]);
const appendHash = (previous, event) => learningVersion({ previous, event });
const entryHash = (previous, entry) => learningVersion({ previous, entry: learningVersion(entry) });
const runtime = { node: process.versions.node, v8: process.versions.v8, arch: process.arch, platform: process.platform };
const contextOf = (store, source) => ({ ...fireplaceLearningContext(store, source.input, source.fireplaceRevision),
  ...sensorLearningContext(store, source.input, source.sensorRevision, { epoch: source.epoch }) });
const publicSource = source => { const { compact, ...rest } = source; return rest; };
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
parentPort.on('message', message => {
  if (message.type !== 'source') return;
  const pending = waiters.get(message.id);
  if (!pending) return;
  waiters.delete(message.id);
  message.error ? pending.reject(failure('model_reconstruction_unavailable')) : pending.resolve(message.source);
});
const acquire = () => new Promise((resolve, reject) => {
  const id = ++request; waiters.set(id, { resolve, reject }); parentPort.postMessage({ type: 'need-source', id });
});

// Every callback is synchronous SQL/detachment. Fitting, hashing and compression
// happen after the verified source lease and its SQLite read transaction close.
async function read(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const lease = await acquire(); let store;
    try {
      store = storageStep(() => new Store(lease.dbPath, { readOnly: true }));
      store.db = admittedReader(store.db);
      store.db.exec('BEGIN');
      try {
        if (lease.checkpoint && !matchingCheckpoint(readCheckpoint(store.db), lease.checkpoint)) continue;
        return fn(store, lease);
      } finally { store.db.exec('ROLLBACK'); }
    } finally {
      if (store) storageStep(() => store.close());
      releaseStorageLease(); parentPort.postMessage({ type: 'source-read' });
    }
  }
  throw failure('model_reconstruction_source_changed');
}
function checkedSource(store, lease, target) {
  const source = reconstructionSource(store, target.source.input, { through: lease.snapshotAt ?? Infinity,
    includeModel: false, revisions: target.source });
  const context = contextOf(store, source);
  const ancestor = checkpointAt(store.db, target.source.database.sequence);
  if (source.pending || source.key !== target.source.key || source.head < target.cursor
    || source.database.sequence < target.source.database.sequence
    || ancestor && !matchingCheckpoint(ancestor, target.source.database)
    || learningVersion(context) !== target.contextHash) throw failure('model_reconstruction_source_changed');
  return { source, context, ancestryProven: Boolean(ancestor) };
}
async function fingerprint(target, { includeChart = true, progressCursor = 0, phase = 'checking-source' } = {}) {
  let cursor = 0, hash = null, records = 0, progressHash = null, progressRecords = 0, notifiedAt = -Infinity, ancestryProven = true;
  let scanStart, database, scanAncestryProven = true;
  const checked = (store, lease) => {
    const value = checkedSource(store, lease, target);
    database = value.source.database;
    if (scanStart) {
      const ancestor = checkpointAt(store.db, scanStart.sequence);
      if (database.sequence < scanStart.sequence || ancestor && !matchingCheckpoint(ancestor, scanStart))
        throw failure('model_reconstruction_source_changed');
      scanAncestryProven &&= Boolean(ancestor);
    } else scanStart = database;
    return value;
  };
  const notify = (processed, total) => {
    if (performance.now() - notifiedAt < 250) return;
    notifiedAt = performance.now();
    parentPort.postMessage({ type: 'progress', phase, processed, total,
      targetAt: target.checkedAt, journalId: target.cursor, processedJournalId: cursor, input: target.source.input });
  };
  while (cursor < target.cursor) {
    if (stopped()) throw failure('model_reconstruction_cancelled');
    const page = await read((store, lease) => {
      const { ancestryProven } = checked(store, lease);
      const rows = learningJournalRows(store.db, { input: target.source.input,
        epoch: target.source.epoch, after: cursor, through: target.cursor, limit: 128 }).map(decodeReconstructionEntry);
      return { rows, ancestryProven };
    });
    const { rows } = page; ancestryProven &&= page.ancestryProven;
    if (!rows.length) throw failure('model_reconstruction_source_changed');
    for (const entry of rows) {
      hash = entryHash(hash, entry); cursor = entry.id; records++;
      if (cursor === progressCursor) { progressHash = hash; progressRecords = records; }
    }
    notify(records, target.fingerprint?.records ?? null);
    await pause();
  }
  let historyHash = emptyHash, historyCount = 0, coverage;
  if (includeChart) {
    cursor = 0;
    for (;;) {
      const page = await read((store, lease) => {
        checked(store, lease);
        const coverage = readCoefficientCoverage(store, { input: target.source.input, epoch: target.source.epoch });
        const rows = readCoefficientEvents(store, { input: target.source.input, epoch: target.source.epoch,
          afterCursor: cursor, throughCursor: target.cursor, limit: 128 });
        return { rows, coverage };
      });
      coverage = page.coverage;
      if (!page.rows.length) break;
      for (const event of page.rows) { historyHash = appendHash(historyHash, event); historyCount++; cursor = event.cursor; }
      notify(historyCount, target.fingerprint?.historyCount ?? null);
      if (stopped()) throw failure('model_reconstruction_cancelled');
      await pause();
    }
  }
  // The final checkpoint covers every detached page only while the fresh scan
  // anchor remains an ancestor. If retention removed it mid-scan, keep that
  // anchor: status will report unconfirmed rather than trust an unrelated head.
  return { hash, records, historyHash, historyCount, progressHash, progressRecords, ancestryProven,
    database: scanAncestryProven ? database : scanStart,
    historyCovered: Boolean(coverage && coverage.cursor >= target.cursor) };
}
async function captureTargets() {
  return read((store, lease) => {
    const input = workerData.input === 'offline' ? 'history' : workerData.input;
    const inputs = [input];
    if (input !== 'history' && store.db.prepare("SELECT 1 FROM state WHERE key='adaptive:history' AND value!='null'").get()) inputs.push('history');
    const references = [];
    const targets = inputs.map(input => {
      const source = reconstructionSource(store, input, { through: lease.snapshotAt ?? Infinity });
      if (source.pending) throw failure('model_reconstruction_source_changing');
      if (!source.savedCursor) throw failure('model_reconstruction_no_saved_model');
      if (source.savedCursor > source.head) throw failure('model_reconstruction_source_changed');
      const checkpoint = store.getState(`adaptive:${input}`);
      const last = store.db.prepare('SELECT * FROM learning_journal WHERE input=? AND id=?').get(input, source.savedCursor);
      if (!last || !validLearningCheckpoint(checkpoint, decodeReconstructionEntry(last))) throw failure('model_reconstruction_invalid_saved_model');
      references.push({ input, checkpoint });
      return { source: publicSource(source), cursor: source.savedCursor, checkedAt: source.savedAt,
        expectedDigest: learningCheckpointDigest(checkpoint), expectedJournalHash: checkpoint.journalHash,
        contextHash: learningVersion(contextOf(store, source)) };
    });
    return { targets, references };
  });
}
async function run() {
  let saved = work.get('job');
  if (saved?.id !== workerData.job.id) {
    const { targets, references } = await captureTargets();
    saved = { ...workerData.job, targets, runtime };
    // The target must survive power loss even during the first source scan.
    work.start(saved, references);
  }
  let progress = work.progress();
  if (learningVersion(saved.runtime ?? null) !== learningVersion(runtime)
    || !Array.isArray(saved.targets) || !saved.targets.length || saved.targets.length > 2
    || saved.targets.some(target => !target?.source?.key || !Number.isSafeInteger(target.cursor) || target.cursor <= 0
      || typeof target.expectedDigest !== 'string' || typeof target.contextHash !== 'string')) throw failure('model_reconstruction_invalid');
  if (progress && (progress.jobId !== saved.id || !Number.isSafeInteger(progress.streamIndex)
    || progress.streamIndex < 0 || progress.streamIndex > saved.targets.length || !Array.isArray(progress.results)
    || progress.results.length !== progress.streamIndex || !/^[a-f0-9]{64}$/.test(progress.historyHash)
    || !Number.isSafeInteger(progress.historyCount) || progress.historyCount < 0)) throw failure('model_reconstruction_invalid');
  // Matching IDs or an end-entry alone cannot establish an unchanged prefix.
  for (const [index, target] of saved.targets.entries()) {
    const reference = work.reference(target.source.input);
    if (!reference || reference.journalCursor !== target.cursor || learningCheckpointDigest(reference) !== target.expectedDigest)
      throw failure('model_reconstruction_invalid');
    parentPort.postMessage({ type: 'progress', phase: 'checking-source', processed: 0, total: null,
      targetAt: target.checkedAt, journalId: target.cursor, processedJournalId: 0, input: target.source.input });
    const state = progress?.streamIndex === index ? progress.state : null;
    const actual = await fingerprint(target, { progressCursor: state?.cursor ?? 0 });
    if (!target.fingerprint) {
      if (!actual.ancestryProven && actual.hash !== target.expectedJournalHash)
        throw failure('model_reconstruction_source_changed');
      target.fingerprint = actual;
      work.transaction(() => work.set('job', saved));
    } else if (actual.hash !== target.fingerprint.hash || actual.historyHash !== target.fingerprint.historyHash
      || actual.historyCovered !== target.fingerprint.historyCovered) throw failure('model_reconstruction_source_changed');
    if (state?.cursor) {
      if (state.cursor > target.cursor || state.records !== actual.progressRecords
        || state.checkpoint && (state.checkpoint.journalCursor !== state.cursor
          || state.checkpoint.journalHash !== actual.progressHash
          || learningCheckpointDigest(state.checkpoint) !== state.checkpoint.checkpointDigest)
        || !state.checkpoint && !(state.blocked && state.invalidRecords > 0)) throw failure('model_reconstruction_invalid');
    }
  }
  progress ??= { jobId: saved.id, streamIndex: 0, results: [], state: createCoefficientReplayState(),
    historyHash: emptyHash, historyCount: 0 };
  let lastSave = performance.now();
  const save = () => { work.save(progress); lastSave = performance.now(); };
  for (; progress.streamIndex < saved.targets.length; progress.streamIndex++) {
    const target = saved.targets[progress.streamIndex], resumedFrom = progress.state.cursor;
    while (progress.state.cursor < target.cursor) {
      if (stopped()) { save(); return { paused: true }; }
      const { rows, context } = await read((store, lease) => {
        const { context } = checkedSource(store, lease, target);
        const rows = learningJournalRows(store.db, { input: target.source.input,
          epoch: target.source.epoch, after: progress.state.cursor, through: target.cursor, limit: 16 }).map(decodeReconstructionEntry);
        return { rows, context };
      });
      if (!rows.length) throw failure('model_reconstruction_source_changed');
      for (const entry of rows) {
        if (stopped()) { save(); return { paused: true }; }
        applyCoefficientReplayEntry(progress.state, entry, context);
        // Compare canonical chart rows, excluding private projection bookkeeping.
        for (const { cursor, at, coefficients } of progress.state.pendingEvents) {
          progress.historyHash = appendHash(progress.historyHash, { cursor, at, coefficients }); progress.historyCount++;
        }
        progress.state.pendingEvents = [];
        parentPort.postMessage({ type: 'progress', phase: 'replaying', processed: progress.state.records,
          total: target.fingerprint.records, throughAt: progress.state.at, targetAt: target.checkedAt,
          journalId: target.cursor, processedJournalId: progress.state.cursor, input: target.source.input });
        if (performance.now() - lastSave >= workerData.progressIntervalMs) save();
        await pause();
      }
    }
    if (stopped()) { save(); return { paused: true }; }
    const actual = await fingerprint(target, { phase: 'checking-result' });
    if (actual.hash !== target.fingerprint.hash || actual.historyHash !== target.fingerprint.historyHash
      || actual.historyCovered !== target.fingerprint.historyCovered) throw failure('model_reconstruction_source_changed');
    const modelMatched = !progress.state.invalidRecords && progress.state.checkpoint !== null
      && learningCheckpointDigest(progress.state.checkpoint) === target.expectedDigest
      && actual.hash === target.expectedJournalHash && progress.state.cursor === target.cursor;
    const historyMatched = actual.historyCovered && progress.historyHash === actual.historyHash
      && progress.historyCount === actual.historyCount;
    const differences = modelMatched ? null
      : modelVerificationDifferences(work.reference(target.source.input), progress.state.checkpoint);
    if (differences && (progress.state.invalidRecords || actual.hash !== target.expectedJournalHash
      || progress.state.cursor !== target.cursor)) differences.roundingConsistent = false;
    progress.results.push({ input: target.source.input, sourceKey: target.source.key, contextHash: target.contextHash,
      database: target.source.database, modelMatched, historyMatched, journalId: target.cursor, checkedAt: target.checkedAt,
      historyPoints: actual.historyCount, reconstructedPoints: progress.historyCount, resumedFrom,
      ...(differences ? { differences } : {}) });
    progress.state = createCoefficientReplayState(); progress.historyHash = emptyHash; progress.historyCount = 0;
    // Save the transition to the next stream, too; never repeat an unbounded
    // completed stream after a power loss between two independent model inputs.
    const next = progress.streamIndex + 1;
    const stored = { ...progress, streamIndex: next };
    work.save(stored); lastSave = performance.now();
  }
  // Recheck all fixed sources at completion, including an earlier finished
  // imported stream. Normal appends beyond the fixed boundaries are allowed.
  for (const [index, target] of saved.targets.entries()) {
    const actual = await fingerprint(target, { phase: 'checking-result' });
    if (actual.hash !== target.fingerprint.hash || actual.historyHash !== target.fingerprint.historyHash
      || actual.historyCovered !== target.fingerprint.historyCovered) throw failure('model_reconstruction_source_changed');
    progress.results[index].database = actual.database;
  }
  const modelMatched = progress.results.every(result => result.modelMatched);
  const historyMatched = progress.results.every(result => result.historyMatched);
  const result = { state: modelMatched && historyMatched ? 'matched' : 'mismatch', modelMatched, historyMatched,
    completedAt: Date.now(), checkedAt: saved.targets[0].checkedAt, journalId: saved.targets[0].cursor,
    sourceKey: saved.targets[0].source.key, streams: progress.results, runtime: saved.runtime };
  work.transaction(() => { work.set('lastVerification', result); work.set('job', null); });
  return result;
}

setStorageMaintenance(true);
try {
  work = new ModelVerificationWork({ path: workerData.workPath });
  parentPort.postMessage({ type: 'result', result: await run() });
} catch (error) {
  if (stopped()) parentPort.postMessage({ type: 'result', result: { paused: true } });
  else parentPort.postMessage({ type: 'failure', code: error?.code?.startsWith('model_reconstruction_') ? error.code : 'model_reconstruction_failed' });
} finally { work?.close(); parentPort.close(); }
