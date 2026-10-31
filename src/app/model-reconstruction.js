import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync, readdirSync,
  openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { ModelVerificationWork, verificationWorkPath } from '../storage/model-verification-work.js';
import { reconstructionSource } from './model-reconstruction-source.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';
import { sensorLearningContext } from './sensor-inputs.js';
import { learningVersion } from './committed-learning.js';
import { checkpointAt, matchingCheckpoint } from '../storage/journal.js';
import { attachStorageAdmission, terminateStorageWorker } from '../storage/worker-admission.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const actions = ['verify', 'pause', 'resume', 'cancel', 'discard'];
const codes = new Set(['model_reconstruction_invalid', 'model_reconstruction_unavailable', 'model_reconstruction_source_changed',
  'model_reconstruction_source_changing', 'model_reconstruction_no_saved_model', 'model_reconstruction_invalid_saved_model', 'model_reconstruction_failed']);
const error = code => Object.assign(new Error(code), { code,
  statusCode: code === 'model_reconstruction_busy' ? 409 : code === 'model_reconstruction_invalid_action' ? 400 : 503 });
const defaults = () => ({ version: 1, paused: false, job: null, receipts: [] });
const bodyKey = body => JSON.stringify({ action: body.action, requestId: body.requestId });
const validJob = job => job === null || Boolean(job && typeof job === 'object' && !Array.isArray(job)
  && UUID.test(job.id ?? '') && UUID.test(job.requestId ?? '') && job.kind === 'verify' && Number.isFinite(job.startedAt)
  && Object.keys(job).every(key => ['id', 'requestId', 'kind', 'startedAt', 'error'].includes(key))
  && (!Object.hasOwn(job, 'error') || codes.has(job.error)));
function validSettings(value) {
  return value && value.version === 1 && typeof value.paused === 'boolean' && validJob(value.job)
    && Object.keys(value).sort().join(',') === 'job,paused,receipts,version' && Array.isArray(value.receipts)
    && value.receipts.every(item => item && UUID.test(item.requestId ?? '') && actions.includes(item.action)
      && Number.isFinite(item.completedAt) && item.body === bodyKey(item)
      && Object.keys(item).sort().join(',') === 'action,body,completedAt,requestId');
}

/** Node-local read-only model verification. This service never publishes model,
 * chart, recording, replication or device state to the source database. */
export function createModelReconstruction({ directory, acquire, clock = Date.now, progressIntervalMs = 5 * 60_000,
  pollMs = 5000, stopTimeoutMs = 5000, available = () => true,
  protectedPaths = [],
  workerFactory = options => new Worker(new URL('./model-reconstruction-worker.js', import.meta.url), options) } = {}) {
  if (!directory || typeof acquire !== 'function') throw TypeError('A temporary verification directory and source provider are required');
  const workPath = verificationWorkPath(directory), settingsPath = join(directory, 'settings.json');
  const disposablePaths = [workPath, workPath + '-journal', settingsPath, join(directory, 'README.txt')].map(path => resolve(path));
  const sourcePaths = new Set(protectedPaths.filter(path => typeof path === 'string' && path !== ':memory:')
    .map(path => resolve(path))), acquireSource = acquire;
  acquire = async () => {
    const source = await acquireSource();
    // Only the four names this service can delete need protection. Replica
    // generations must not create an indefinitely growing path registry.
    if (source?.dbPath && disposablePaths.includes(resolve(source.dbPath))) sourcePaths.add(resolve(source.dbPath));
    return source;
  };
  let settings = defaults(), settingsError = null;
  try { if (existsSync(settingsPath)) { const value = JSON.parse(readFileSync(settingsPath)); if (!validSettings(value)) throw Error(); settings = value; } }
  catch { settingsError = 'model_reconstruction_invalid'; }
  let active = null, running = null, closed = false, started = false, timer = null, queue = Promise.resolve();
  let lastError = settingsError, directoryLock = null;
  let latest = { state: settings.paused ? 'paused' : 'idle', job: settings.job, source: {}, storage: { bytes: 0, disposable: true },
    lastVerification: null, lastAction: settings.receipts.at(-1) ?? null, error: lastError };
  function persist() {
    if (disposablePaths.some(path => sourcePaths.has(path))) throw error('model_reconstruction_invalid');
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const temporary = settingsPath + '.tmp-' + randomUUID();
    writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600 });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, settingsPath);
    const folder = openSync(directory, 'r'); try { fsyncSync(folder); } finally { closeSync(folder); }
  }
  async function lockDirectory() {
    if (directoryLock) return;
    const socket = createServer();
    await new Promise((resolve, reject) => {
      socket.once('error', () => { socket.close(); reject(error('model_reconstruction_busy')); });
      socket.listen('\0model-verification-' + createHash('sha256').update(directory).digest('hex'), () => {
        directoryLock = socket; socket.unref(); resolve();
      });
    });
  }
  function receipt(body) {
    const item = { requestId: body.requestId, action: body.action, body: bodyKey(body), completedAt: clock() };
    settings.receipts = [...settings.receipts.filter(item => clock() - item.completedAt <= 24 * 3600_000), item];
    latest.lastAction = item; persist();
  }
  async function status() {
    let source, work;
    try {
      if (settingsError) throw error(settingsError);
      source = await acquire();
      if (!source?.store || !source.dbPath || source.dbPath === ':memory:') throw error('model_reconstruction_unavailable');
      const info = reconstructionSource(source.store, source.input, { through: source.snapshotAt ?? Infinity, includeModel: false });
      let result = null, bytes = 0;
      if (existsSync(workPath)) {
        work = new ModelVerificationWork({ path: workPath, readOnly: true }); result = work.get('lastVerification'); bytes = work.bytes();
      }
      if (result) {
        const applicability = result.streams.map(stream => {
          const current = reconstructionSource(source.store, stream.input, { through: source.snapshotAt ?? Infinity, includeModel: false });
          const context = { ...fireplaceLearningContext(source.store, stream.input, current.fireplaceRevision),
            ...sensorLearningContext(source.store, stream.input, current.sensorRevision, { epoch: current.epoch }) };
          if (current.pending || current.key !== stream.sourceKey || current.head < stream.journalId
            || current.database.sequence < stream.database.sequence || learningVersion(context) !== stream.contextHash) return false;
          const ancestor = checkpointAt(source.store.db, stream.database.sequence);
          // Retention can remove a proof without changing the selected learning
          // interpretation. Missing ancestry is unknown, never known divergence.
          return ancestor ? matchingCheckpoint(ancestor, stream.database) : null;
        });
        result.current = applicability.includes(false) ? false : applicability.every(value => value === true) ? true : null;
      }
      latest = { ...latest, state: running ? 'running' : settings.paused && settings.job ? 'paused'
        : lastError === 'model_reconstruction_source_changed' ? 'superseded' : lastError ? 'error' : 'idle',
        job: active?.public ?? settings.job, source: { role: source.role ?? 'master', snapshotAt: source.snapshotAt ?? clock(), pending: info.pending },
        storage: { bytes, disposable: true }, lastVerification: result, error: lastError };
    } catch (caught) {
      const code = codes.has(caught.code) ? caught.code : 'model_reconstruction_unavailable';
      latest = { ...latest, state: running ? 'running' : code === 'model_reconstruction_invalid' ? 'error' : 'unavailable', error: code };
    } finally { work?.close(); await source?.release?.(); }
    return structuredClone(closed ? { ...latest, state: 'unavailable' } : latest);
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!started || closed || running || settings.paused || settingsError || !settings.job || settings.job.error) return;
    timer = setTimeout(() => { timer = null; void enqueue(async () => {
      if (closed || running || settings.paused || !settings.job || settings.job.error) return;
      if (available()) await launch(settings.job); else schedule();
    }).catch(() => { schedule(); }); }, pollMs);
    timer.unref();
  }
  async function halt() {
    const owner = active, completion = running;
    if (!owner) return;
    Atomics.store(owner.cancellation, 0, 1);
    let stopTimer;
    try {
      await Promise.race([completion, new Promise(resolve => {
        stopTimer = setTimeout(async () => {
          // Only a read-only source worker is terminated. Its last complete
          // local SQLite checkpoint remains usable after interrupted writes.
          owner.forcedStop = true;
          await terminateStorageWorker(owner.worker); resolve();
        }, stopTimeoutMs);
      })]);
      await completion;
    } finally { clearTimeout(stopTimer); }
  }
  async function launch(job) {
    if (closed || !available()) throw error('model_reconstruction_unavailable');
    if (running) throw error('model_reconstruction_busy');
    if (settingsError) throw error(settingsError);
    await lockDirectory();
    const initial = await acquire();
    try {
      if (!initial?.store || !initial.dbPath || initial.dbPath === ':memory:') throw error('model_reconstruction_unavailable');
      settings.job = job; settings.paused = false; persist(); lastError = null;
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      const storageSignal = new Int32Array(new SharedArrayBuffer(4));
      const worker = workerFactory({
        workerData: { workPath, input: initial.input, job, cancellation: cancellation.buffer,
          storageSignal: storageSignal.buffer, progressIntervalMs }, execArgv: [],
      });
      const owner = active = { worker, cancellation, source: null, public: { ...job, phase: 'preparing', processed: 0, total: null } };
      attachStorageAdmission(worker, storageSignal, operation => {
        const store = owner.source?.store;
        return store?.runStorageTask ? store.runStorageTask(operation, { kind: 'history', maintenance: true }) : operation();
      });
      running = new Promise(resolve => {
        let result, failure;
        worker.on('message', message => {
          if (message.type === 'need-source') void (async () => {
            let lease;
            try {
              lease = await acquire();
              if (active !== owner) { await lease?.release?.(); return; }
              owner.source = lease;
              worker.postMessage({ type: 'source', id: message.id, source: { dbPath: lease.dbPath,
                snapshotAt: lease.snapshotAt, checkpoint: lease.checkpoint } });
            } catch {
              await lease?.release?.();
              if (active === owner) worker.postMessage({ type: 'source', id: message.id, error: true });
            }
          })();
          else if (message.type === 'source-read') { const lease = owner.source; owner.source = null; void lease?.release?.(); }
          else if (message.type === 'progress') owner.public = { ...owner.public, ...message, type: undefined };
          else if (message.type === 'failure') failure = message.code;
          else if (message.type === 'result') result = message.result;
        });
        worker.on('error', () => { failure = 'model_reconstruction_failed'; });
        worker.once('exit', async code => {
          await owner.source?.release?.(); owner.source = null;
          if (active === owner) {
            active = null; running = null;
            if (owner.forcedStop && !result) { /* Resume the last complete independent checkpoint. */ }
            else if (failure || code !== 0 || !result) {
              lastError = codes.has(failure) ? failure : 'model_reconstruction_failed';
              settings.job = { ...job, error: lastError };
            } else if (!result.paused) { settings.job = null; lastError = null; }
            try { persist(); } catch { lastError = 'model_reconstruction_failed'; }
            schedule();
          }
          resolve();
        });
      });
    } finally { await initial?.release?.(); }
  }
  async function mutate(body) {
    if (closed) throw error('model_reconstruction_unavailable');
    await lockDirectory();
    if (settingsError && body.action !== 'discard') throw error(settingsError);
    const seen = settings.receipts.find(item => item.requestId === body.requestId);
    if (seen) { if (seen.body !== bodyKey(body)) throw error('model_reconstruction_invalid_action'); return status(); }
    if (body.action === 'pause') {
      if (!settings.job) throw error('model_reconstruction_invalid_action');
      settings.paused = true; persist(); await halt();
    } else if (body.action === 'resume') {
      if (!settings.job || settings.job.error || !settings.paused) throw error('model_reconstruction_invalid_action');
      await launch(settings.job);
    } else if (body.action === 'cancel') {
      await halt(); settings.job = null; settings.paused = false; lastError = null;
    } else if (body.action === 'discard') {
      if (running) throw error('model_reconstruction_busy');
      let source;
      try { source = await acquire(); }
      catch { /* Disposal also works while a slave has no usable snapshot. */ }
      finally { await source?.release?.(); }
      // Delete only this service's exact disposable filenames. A misconfigured
      // directory can never turn Discard into recursive main-history deletion.
      const names = (existsSync(directory) ? readdirSync(directory) : []).filter(name =>
        ['temporary-verification.sqlite', 'temporary-verification.sqlite-journal', 'README.txt', 'settings.json'].includes(name)
          || /^settings\.json\.tmp-[a-f0-9-]{36}$/.test(name));
      if (names.some(name => sourcePaths.has(resolve(directory, name)))) throw error('model_reconstruction_invalid');
      for (const name of names) unlinkSync(join(directory, name));
      settings = defaults(); settingsError = null; lastError = null;
      latest = { ...latest, lastVerification: null, job: null, storage: { bytes: 0, disposable: true } };
    } else {
      if (running || settings.job && settings.paused) throw error('model_reconstruction_busy');
      await launch({ id: randomUUID(), requestId: body.requestId, kind: 'verify', startedAt: clock() });
    }
    receipt(body); return status();
  }
  function enqueue(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
  return { workPath, status,
    action(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || !UUID.test(body.requestId ?? '')
        || !actions.includes(body.action) || Object.keys(body).sort().join(',') !== 'action,requestId')
        return Promise.reject(error('model_reconstruction_invalid_action'));
      return enqueue(() => mutate(body));
    },
    enable() { started = true; schedule(); },
    async settled() { await queue; while (running) await running; },
    async close() {
      closed = true; clearTimeout(timer); await queue; await halt();
      if (directoryLock) { const socket = directoryLock; directoryLock = null; await new Promise(resolve => socket.close(resolve)); }
    },
  };
}
