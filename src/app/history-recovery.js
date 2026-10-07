import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { markRecoveryFailed } from '../recovery/state.js';
import { createRecoveryHistoryReader } from './history-recovery-reader.js';
import { validBackupMetadata } from '../storage/backup-metadata.js';
import { RECOVERABLE_TABLES } from '../storage/schema.js';
import { RECOVERY_ERROR_CODES, recoveryFailure } from '../recovery/errors.js';
import { validRecoveryCoverageReport } from '../recovery/coverage-report.js';
import { listSavedBackups } from '../storage/backup-catalog.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIONS = new Set(['check', 'recover', 'review-revert', 'revert', 'review-restore', 'restore']);
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const publicSource = ({ id, kind, label, createdAt, bytes, available = true }) => ({ id, kind, label, createdAt, bytes, available });
const sourceId = path => createHash('sha256').update(path).digest('hex');
const fields = (value, allowed) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(field => allowed.includes(field));
const count = value => Number.isSafeInteger(value) && value >= 0;
const progressPhases = new Set(['preparing', 'validating', 'snapshotting', 'importing', 'projecting', 'rebuilding', 'catching-up', 'publishing', 'checking']);
const validProgress = value => fields(value, ['phase', 'processed', 'total', 'unit', 'updatedAt'])
  && progressPhases.has(value.phase) && count(value.processed)
  && (value.total === undefined || count(value.total) && value.total >= value.processed)
  && (value.unit === undefined || ['records', 'entries', 'pages', 'bytes'].includes(value.unit))
  && (value.updatedAt === undefined || Number.isFinite(value.updatedAt));
const token = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const labels = { upload: /^Uploaded database$/, peer: /^Paired computer$/,
  backup: /^Saved backup · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  reset: /^Reset archive · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z · [a-zA-Z0-9_-]+\.sqlite$/ };
function validSource(value) {
  return fields(value, ['id', 'kind', 'label', 'createdAt', 'bytes', 'available'])
    && Object.hasOwn(labels, value.kind) && labels[value.kind].test(value.label)
    && (value.id === undefined || token(value.id)) && (value.createdAt === undefined || Number.isFinite(value.createdAt))
    && (value.bytes === undefined || count(value.bytes)) && (value.available === undefined || typeof value.available === 'boolean');
}
function validReport(value) {
  const root = ['policy', 'counts', 'period', 'tables', 'model', 'donorDigest', 'input', 'sourceSelection', 'previewId',
    'sourceAssessment', 'status', 'imported', 'recoveryId', 'active', 'source', 'sourceEpoch', 'sourceHead',
    'sourceFireplace', 'sourceSensor', 'decisionHead', 'contributionHead', 'conflictVersion', 'unsupported', 'coverage', 'sourceSoftware'];
  if (!fields(value, root)) return false;
  if (value.sourceSoftware !== undefined && !validBackupMetadata(value.sourceSoftware)) return false;
  if (value.coverage !== undefined && !validRecoveryCoverageReport(value.coverage)) return false;
  if (value.conflictVersion !== undefined && value.conflictVersion !== null
    && !/^[a-f0-9]{64}$/.test(value.conflictVersion)) return false;
  for (const key of ['policy', 'donorDigest', 'input', 'sourceSelection', 'previewId', 'status', 'recoveryId', 'sourceEpoch'])
    if (value[key] !== undefined && !token(value[key])) return false;
  for (const key of ['imported', 'sourceHead', 'sourceFireplace', 'sourceSensor', 'decisionHead', 'contributionHead'])
    if (value[key] !== undefined && !count(value[key])) return false;
  if (value.active !== undefined && typeof value.active !== 'boolean' || value.source && !validSource(value.source)) return false;
  if (value.counts && (!fields(value.counts, ['missing', 'conflicts', 'duplicates', 'alreadyPresent', 'skipped', 'affected'])
    || !Object.values(value.counts).every(count))) return false;
  if (value.period && (!fields(value.period, ['from', 'to']) || !Object.values(value.period).every(at => at === null || Number.isFinite(at)))) return false;
  const tables = [...RECOVERABLE_TABLES, 'learning_journal', 'recorder_pending_energy', 'charging_session_keys', 'other_learning_inputs', 'cycle_assessments'];
  if (value.tables && (!Array.isArray(value.tables) || value.tables.length > tables.length
    || !value.tables.every(row => fields(row, ['name', 'missing', 'conflicts', 'duplicates', 'skipped', 'count'])
      && tables.includes(row.name) && Object.entries(row).every(([field, number]) => field === 'name' || count(number))))) return false;
  if (value.model && (!fields(value.model, ['status', 'acceptedSamples', 'unsupported'])
    || !['not-assessed', 'unchanged', 'rebuild-required', 'rebuilt'].includes(value.model.status)
    || Object.entries(value.model).some(([field, number]) => field !== 'status' && !count(number)))) return false;
  const source = value.sourceAssessment;
  if (source && (!fields(source, ['scope', 'selectedInput', 'learningInputs', 'skippedLearning', 'skippedLearningRecords', 'installationIdentity'])
    || !['unknown', 'mixed', 'live', 'simulated'].includes(source.scope)
    || !['mqtt', 'providers', 'simulated', 'history'].includes(source.selectedInput)
    || !Array.isArray(source.learningInputs) || source.learningInputs.some(input => !['mqtt', 'providers', 'simulated', 'history'].includes(input))
    || !fields(source.skippedLearning, ['mqtt', 'providers', 'simulated', 'history', 'unknown']) || !Object.values(source.skippedLearning).every(count)
    || !count(source.skippedLearningRecords) || source.installationIdentity !== 'not-proven-by-format')) return false;
  if (value.unsupported && (!Array.isArray(value.unsupported) || value.unsupported.length > 2 || !value.unsupported.every(row =>
    fields(row, ['name', 'count', 'reason']) && ['charging_reports', 'charging_report_events'].includes(row.name) && count(row.count)
      && row.reason === 'Saved charging reports are not included in history recovery.'))) return false;
  return true;
}
function validState(state) {
  if (!fields(state, ['version', 'sources', 'receipts', 'job', 'review']) || state.version !== 1
    || !Array.isArray(state.sources) || state.sources.length > 16 || !Array.isArray(state.receipts) || state.receipts.length > 64
    || !state.sources.every(source => validSource(source) && source.kind === 'upload' && UUID.test(source.id))
    || !state.receipts.every(row => fields(row, ['id', 'signature']) && UUID.test(row.id) && typeof row.signature === 'string' && row.signature.length < 8192)) return false;
  const job = state.job;
  if (job && (!fields(job, ['id', 'requestId', 'kind', 'status', 'startedAt', 'source', 'operationId', 'progress', 'finishedAt', 'error', 'errorCode', 'result'])
    || !UUID.test(job.id) || job.requestId !== job.id || !ACTIONS.has(job.kind)
    || !['running', 'complete', 'error', 'interrupted'].includes(job.status) || !Number.isFinite(job.startedAt)
    || job.source && !validSource(job.source) || job.result && !validReport(job.result)
    || job.operationId !== undefined && !token(job.operationId)
    || job.finishedAt !== undefined && !Number.isFinite(job.finishedAt)
    || job.error !== undefined && (typeof job.error !== 'string' || job.error.length > 300 || /[\r\n/\\]/.test(job.error))
    || job.errorCode !== undefined && !RECOVERY_ERROR_CODES.includes(job.errorCode)
    || job.progress && !validProgress(job.progress))) return false;
  const review = state.review;
  return !review || fields(review, ['kind', 'source', 'preview']) && ['recover', 'revert', 'restore'].includes(review.kind)
    && (!review.source || validSource(review.source)) && validReport(review.preview);
}
const safeError = error => recoveryFailure({ code: error?.code, errcode: error?.errcode }).error;

/** One application-owned coordinator serves local backups and paired snapshots.
 * Paths remain private; browser requests identify sources issued by this owner.
 * Durable receipts distinguish an interrupted job from permission to resume it. */
export function createHistoryRecovery({ store, getEngine, canControl = () => true, ready = () => true,
  getExportDirectory, getResetBackups = async () => [], pairContext, clock = Date.now,
  recoveryModule = () => import('../recovery/service.js'), directory = join(dirname(store.path), 'history-recovery'),
  maxUploadBytes = 8 * 1024 ** 3, timeoutMs, uploadTimeoutMs = 3_600_000 } = {}) {
  const key = 'history-recovery:coordinator';
  let state = store.getState(key) ?? { version: 1, sources: [], receipts: [], job: null, review: null };
  if (!validState(state))
    throw fail('Saved recovery state is invalid. Preserve this database and use a fresh current database.');
  let running = null, abort = null, operationSignal = null, closed = false, uploadRunning = false, uploadRequest = null, uploadSettled = null, uploadAbort = null, initialized = false;
  const lifetime = new AbortController();
  let known = new Map(), sourceTask = null, sourceGeneration = 0;
  let sourceCache = { rows: null, at: 0, error: null };
  const history = createRecoveryHistoryReader(store);
  const persist = (options = {}) => {
    const snapshot = structuredClone(state);
    if (snapshot.job) delete snapshot.job.progress;
    return store.runWrite(() => store.setState(key, snapshot), { signal: operationSignal ?? lifetime.signal, ...options });
  };
  const localBusy = () => Boolean(running || uploadRunning);
  const pairedBusy = () => Boolean(pairContext?.status()?.busy || pairContext?.status()?.uiOperation?.state === 'running');
  const busy = () => localBusy() || pairedBusy();
  const available = () => !closed && canControl() && ready() && store.path !== ':memory:' && !store.readOnly;
  const assertReady = () => { if (!available()) throw fail('History recovery requires the active writable instance.'); };
  const assertIdle = (peer = false) => { assertReady(); if (localBusy() || !peer && pairedBusy()) throw fail('A history recovery operation is already running.'); };
  const input = () => getEngine().config.input;
  async function initialize() {
    if (initialized) return;
    initialized = true;
    await store.runWrite(() => {
      const recovery = store.getState(`recovery:active:${input()}`);
      if (['importing', 'rebuilding', 'catching-up'].includes(recovery?.status)) markRecoveryFailed(store, input());
      if (state.job?.status === 'running') {
        state.job = { ...state.job, status: 'interrupted', finishedAt: clock(),
          error: 'Recovery was interrupted. Review the source again to continue; accepted history is preserved.' };
        state.review = null; store.setState(key, state);
      }
    }, { signal: lifetime.signal });
  }
  async function scanSources() {
    const found = new Map();
    for (const source of state.sources) {
      if (!UUID.test(source.id) || source.kind !== 'upload') continue;
      const path = join(directory, 'uploads', `${source.id}.sqlite`);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) found.set(source.id, { ...source, path });
    }
    if (getExportDirectory) {
      let copies;
      try { copies = await listSavedBackups(getExportDirectory()); }
      catch { throw fail('Saved backups could not be listed.'); }
      for (const { path, createdAt, bytes } of copies) {
        const id = sourceId(path);
        found.set(id, { id, path, kind: 'backup', label: `Saved backup · ${new Date(createdAt).toISOString()}`,
          createdAt, bytes });
      }
    }
    for (const source of await getResetBackups()) found.set(source.id, source);
    return found;
  }
  async function refreshSources(force = false) {
    if (sourceTask) {
      if (!force) return sourceTask;
      await sourceTask.catch(() => {});
      if (sourceTask) return sourceTask;
    }
    if (closed) throw fail('Recovery storage is unavailable.');
    const generation = sourceGeneration;
    const task = scanSources().then(found => {
      if (generation === sourceGeneration && !closed) {
        known = found;
        sourceCache = { rows: [...found.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(publicSource), at: clock(), error: null };
      }
    }, error => {
      if (generation === sourceGeneration && !closed) sourceCache = { ...sourceCache, at: clock(), error: 'Backup sources are unavailable. Refresh to retry.' };
      throw error;
    });
    sourceTask = task;
    try { await task; } finally { if (sourceTask === task) sourceTask = null; }
  }
  function sources() {
    // Repeated progress requests use the same bounded source list. An action
    // always scans afresh before resolving a source to its private path.
    if (!sourceTask && !closed && (sourceCache.rows === null && !sourceCache.error
      || !busy() && clock() - sourceCache.at >= 5000)) void refreshSources().catch(() => {});
    const rows = [...(sourceCache.rows ?? [])];
    if (pairContext) rows.unshift({ id: 'peer', kind: 'peer', label: 'Paired computer', available: Boolean(pairContext.status()?.actions?.['check-recovery']) });
    return rows;
  }
  async function view({ before } = {}) {
    const engine = getEngine();
    const options = { before, limit: 50 };
    // This applies to terminal receipts too: a slow history count must not
    // conceal completion or prevent the next status heartbeat from returning.
    const page = engine ? history.snapshot(engine.config.input, options, { refresh: !busy() })
      : { rows: [], loading: false, error: null };
    const operations = page.rows;
    const last = operations.at(-1);
    const listedSources = sources();
    return { available: available(), readOnly: !canControl() || store.readOnly, busy: busy(),
      sources: listedSources, sourcesLoading: sourceCache.rows === null && !sourceCache.error, sourcesError: sourceCache.error,
      job: state.job, preview: state.review?.preview ?? null,
      operations, operationsLoading: page.loading, operationsError: page.error, nextBefore: operations.length === 50 ? `${last.startedAt}:${last.id}` : null,
      peer: pairContext?.status() ?? null };
  }
  function begin(kind, requestId, source, operation) {
    assertIdle(source?.kind === 'peer');
    const engine = getEngine();
    abort = new AbortController();
    const signal = timeoutMs === undefined ? abort.signal : AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
    operationSignal = signal;
    const job = { id: requestId, requestId, kind, status: 'running', startedAt: clock(), source,
      progress: { phase: 'preparing', processed: 0, updatedAt: clock() } };
    state.job = job; state.review = null; history.invalidate();
    const committed = persist();
    const isCurrent = () => !closed && !signal.aborted && canControl() && getEngine() === engine;
    const onProgress = progress => {
      const value = { ...progress, updatedAt: clock() };
      // Only transitions are durable. Progress must never compete for SQLite
      // admission or confer permission to resume an interrupted operation.
      if (validProgress(value) && isCurrent()) job.progress = value;
    };
    running = committed.then(() => {
      if (!isCurrent()) throw fail('Recovery authority changed.');
      return operation({ engine, signal, isCurrent, onProgress,
        onPublish(result) {
          engine.checkpoint = result.checkpoint; engine.pendingPlan = null;
          engine.fireplaceRebuild = null; engine.fireplaceReserveOverride = null;
          engine.lastSample = null; engine.latestStatus = null;
        } });
    }).then(async result => {
      job.status = 'complete'; job.finishedAt = clock();
      job.result = result?.report ?? result; history.invalidate();
      await persist(); return result;
    }, async error => {
      job.status = signal.aborted ? 'interrupted' : 'error'; job.finishedAt = clock(); job.error = safeError(error); job.errorCode = recoveryFailure(error).code; history.invalidate();
      // A cancelled worker leaves the last committed job and source projection
      // for startup reconciliation. Diagnostic writes cannot hold revocation
      // open indefinitely while another connection owns SQLite.
      if (!signal.aborted && !closed && canControl()) {
        try { await persist({ signal, isCurrent }); } catch { /* Keep the original operation failure. */ }
      }
      throw error;
    }).finally(() => { running = null; abort = null; operationSignal = null; });
    // The HTTP acceptance and dialog lifetime do not own an accepted operation.
    void running.catch(() => {});
    return running;
  }
  async function prepareMutation(engine, signal) {
    // Stop the competing source-correction worker. Full runtime cleanup also
    // closes unrelated helpers and must remain owned by shutdown/reload.
    await engine.fireplaceRebuild?.close(); engine.fireplaceRebuild = null;
    if (signal.aborted || !canControl() || getEngine() !== engine) throw fail('Recovery authority changed.');
  }
  function checkPath({ donorPath, source, requestId = randomUUID() }) {
    return begin('check', requestId, source, async ({ signal, onProgress, isCurrent }) => {
      const module = await recoveryModule();
      const preview = await module.recoveryPreview({ masterPath: store.path, donorPath, input: input(),
        signal, onProgress });
      if (!isCurrent()) throw fail('Recovery authority changed.');
      state.review = { kind: 'recover', source, preview }; await persist();
      return preview;
    });
  }
  function applyPath({ donorPath, preview, source, requestId = randomUUID(), isCurrent: sourceCurrent = () => true }) {
    return begin('recover', requestId, source, async context => {
      await prepareMutation(context.engine, context.signal);
      const module = await recoveryModule();
      return module.recoverHistory({ store, input: input(), donorPath, preview, ...context,
        isCurrent: () => context.isCurrent() && sourceCurrent(), source: { kind: source.kind, label: source.label }, operationId: requestId });
    });
  }
  function validateAction(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !ACTIONS.has(value.action)
      || !UUID.test(value.requestId ?? '') || Object.keys(value).some(field => !['action', 'requestId', 'sourceId',
        'operationId', 'previewId', 'confirmed', 'installationConfirmed'].includes(field))) throw fail('Choose a recovery action with a unique request ID.', 400);
    const expected = ['action', 'requestId', ...({ check: ['sourceId', 'installationConfirmed'], recover: ['previewId', 'confirmed', 'sourceId'],
      'review-revert': ['operationId'], 'review-restore': ['operationId'], revert: ['previewId', 'confirmed'], restore: ['previewId', 'confirmed'] }[value.action])];
    if (Object.keys(value).some(field => !expected.includes(field))) throw fail('Unsupported recovery action fields.', 400);
  }
  async function action(value) {
    validateAction(value); assertReady();
    const signature = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
    const prior = state.receipts.find(receipt => receipt.id === value.requestId);
    if (prior) {
      if (prior.signature !== signature) throw fail('This request ID belongs to a different recovery action.');
      return view();
    }
    assertIdle();
    if (value.sourceId === 'peer') {
      if (!pairContext || !['check', 'recover'].includes(value.action)) throw fail('Paired recovery is unavailable.');
      pairContext.requestAction({ action: value.action === 'check' ? 'check-recovery' : 'recover', requestId: value.requestId,
        ...(value.action === 'recover' ? { confirmed: value.confirmed, previewId: value.previewId } : {}) });
    } else if (value.action === 'check') {
      if (value.installationConfirmed !== true) throw fail('Confirm that this backup contains history from this household before checking it.');
      await refreshSources(true); assertIdle();
      const source = known.get(value.sourceId);
      if (!source) throw fail('Choose an available saved or uploaded backup.');
      checkPath({ donorPath: source.path, source: publicSource(source), requestId: value.requestId });
    } else if (value.action === 'recover') {
      const review = state.review;
      if (value.confirmed !== true || review?.kind !== 'recover' || review.preview.previewId !== value.previewId)
        throw fail('Review this backup and confirm recovery first.');
      if (review.source?.kind === 'peer') throw fail('Use the paired source to retain its protection checks.');
      await refreshSources(true); assertIdle();
      const source = known.get(review.source?.id);
      if (!source) throw fail('The checked backup is unavailable. Select an available source and check again.');
      if (state.review !== review) throw fail('The checked recovery changed. Review it again.');
      applyPath({ ...review, donorPath: source.path, requestId: value.requestId });
    } else if (value.action.startsWith('review-')) {
      if (typeof value.operationId !== 'string' || !value.operationId || value.operationId.length > 128)
        throw fail('Select an existing recovery operation.', 400);
      const active = value.action === 'review-restore';
      state.review = null;
      begin(value.action, value.requestId, null, async ({ signal, onProgress, isCurrent }) => {
        const module = await recoveryModule();
        const preview = await module.previewRecoveryRevision({ store, input: input(), recoveryId: value.operationId, active, signal, onProgress });
        if (!isCurrent()) throw fail('Recovery authority changed.');
        state.review = { kind: active ? 'restore' : 'revert', preview }; await persist();
        return preview;
      });
      state.job.operationId = value.operationId;
    } else {
      const review = state.review;
      if (value.confirmed !== true || review?.kind !== value.action || review.preview.previewId !== value.previewId)
        throw fail('Review the recovery impact and confirm this change first.');
      state.review = null;
      begin(value.action, value.requestId, null, async context => {
        await prepareMutation(context.engine, context.signal);
        const module = await recoveryModule();
        return module.reviseRecovery({ store, input: input(), recoveryId: review.preview.recoveryId,
          active: value.action === 'restore', preview: review.preview, ...context });
      });
    }
    state.receipts.push({ id: value.requestId, signature });
    state.receipts = state.receipts.slice(-64); await persist();
    return view();
  }
  async function upload(request, authorized = () => true) {
    assertIdle();
    if (!['application/vnd.sqlite3', 'application/octet-stream'].includes(request.headers['content-type']?.split(';')[0]))
      throw fail('Upload a self-contained SQLite backup file.', 400);
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > maxUploadBytes) throw fail('This backup exceeds the 8 GiB upload limit.', 413);
    uploadRunning = true;
    uploadRequest = request;
    uploadAbort = new AbortController();
    const signal = AbortSignal.any([uploadAbort.signal, lifetime.signal, AbortSignal.timeout(uploadTimeoutMs)]);
    let finishUpload;
    uploadSettled = new Promise(resolve => { finishUpload = resolve; });
    const id = randomUUID(), path = join(directory, 'uploads', `${id}.partial`);
    const finalPath = join(directory, 'uploads', `${id}.sqlite`);
    let file, completed = false, published = false, previousSources;
    try {
      await mkdir(join(directory, 'uploads'), { recursive: true, mode: 0o700 });
      for (const folder of [directory, join(directory, 'uploads')]) {
        if (!(await lstat(folder)).isDirectory()) throw fail('Recovery storage is unavailable.');
      }
      await chmod(directory, 0o700); await chmod(join(directory, 'uploads'), 0o700);
      // Only application-generated staging copies are disposable. Keep all
      // registered donors; originals and reset archives are outside this folder.
      // Sweeping before opening the new upload bounds hard-crash leftovers too.
      const retained = new Set(state.sources.map(source => `${source.id}.sqlite`));
      let examined = 0;
      for await (const entry of await opendir(join(directory, 'uploads'))) {
        if (++examined > 512) break;
        const [stem, extension] = entry.name.split('.');
        if (entry.isFile() && UUID.test(stem) && ['partial', 'sqlite'].includes(extension)
          && entry.name === `${stem}.${extension}` && !retained.has(entry.name))
          await rm(join(directory, 'uploads', entry.name), { force: true });
      }
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let bytes = 0, header = Buffer.alloc(0);
      for await (const chunk of request) {
        if (signal.aborted || !authorized() || !available()) throw fail('Upload authorization changed.');
        bytes += chunk.length;
        if (bytes > maxUploadBytes) throw fail('This backup exceeds the 8 GiB upload limit.', 413);
        if (header.length < 100) header = Buffer.concat([header, chunk.subarray(0, 100 - header.length)]);
        for (let offset = 0; offset < chunk.length;) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw fail('The backup upload could not be stored.');
          offset += bytesWritten;
        }
      }
      if (!authorized() || !available()) throw fail('Upload authorization changed.');
      if (header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw fail('This file is not a SQLite database.', 400);
      if (header.length < 100 || header[18] !== 1 || header[19] !== 1)
        throw fail('Use a self-contained SQLite backup created by Export database or a reset archive.', 400);
      await file.sync(); await file.close(); file = null;
      if (!authorized() || !available()) throw fail('Upload authorization changed.');
      await rename(path, finalPath); published = true;
      if (!authorized() || !available()) throw fail('Upload authorization changed.');
      const source = { id, kind: 'upload', label: 'Uploaded database', createdAt: clock(), bytes };
      // At most sixteen upload copies remain. Already imported source evidence
      // and reversal provenance live in SQLite and do not depend on these files.
      previousSources = state.sources;
      const nextSources = [...previousSources, source];
      const expired = nextSources.splice(0, Math.max(0, nextSources.length - 16));
      state.sources = nextSources;
      await persist({ signal, isCurrent: () => !closed && authorized() && available() }); completed = true;
      sourceGeneration++; sourceCache = { rows: null, at: 0, error: null };
      for (const row of expired) if (UUID.test(row.id)) await rm(join(directory, 'uploads', `${row.id}.sqlite`), { force: true }).catch(() => {});
      return { sourceId: id, source: publicSource(source) };
    } finally {
      if (!completed && previousSources) state.sources = previousSources;
      await file?.close().catch(() => {});
      if (!completed) await rm(path, { force: true }).catch(() => {});
      if (published && !completed) await rm(finalPath, { force: true }).catch(() => {});
      uploadRunning = false;
      uploadRequest = null; uploadAbort = null; finishUpload(); uploadSettled = null;
    }
  }
  function cancel() { abort?.abort(); uploadAbort?.abort(); uploadRequest?.destroy?.(); }
  async function close() { closed = true; lifetime.abort(); cancel(); await running?.catch(() => {}); await uploadSettled; await history.close(); await sourceTask?.catch(() => {}); }
  return { view, action, upload, initialize, busy, cancel, close, checkPath, applyPath,
    working: localBusy, currentJob: () => state.job, settled: async () => { await running?.catch(() => {}); await uploadSettled; } };
}
