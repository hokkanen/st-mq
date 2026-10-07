import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { markRecoveryFailed } from '../recovery/state.js';
import { RECOVERABLE_TABLES } from '../storage/schema.js';
import { recoveryFailure } from '../recovery/errors.js';
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
    'sourceFireplace', 'sourceSensor', 'decisionHead', 'contributionHead', 'conflictVersion', 'unsupported', 'coverage'];
  if (!fields(value, root)) return false;
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
  if (job && (!fields(job, ['id', 'requestId', 'kind', 'status', 'startedAt', 'source', 'operationId', 'progress', 'finishedAt', 'error', 'result'])
    || !UUID.test(job.id) || job.requestId !== job.id || !ACTIONS.has(job.kind)
    || !['running', 'complete', 'error', 'interrupted'].includes(job.status) || !Number.isFinite(job.startedAt)
    || job.source && !validSource(job.source) || job.result && !validReport(job.result)
    || job.operationId !== undefined && !token(job.operationId)
    || job.finishedAt !== undefined && !Number.isFinite(job.finishedAt)
    || job.error !== undefined && (typeof job.error !== 'string' || job.error.length > 300 || /[\r\n/\\]/.test(job.error))
    || job.progress && (!fields(job.progress, ['phase', 'processed'])
      || !['importing', 'rebuilding', 'catching-up', 'checking'].includes(job.progress.phase) || !count(job.progress.processed)))) return false;
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
  maxUploadBytes = 8 * 1024 ** 3, timeoutMs = 3_600_000 } = {}) {
  const key = 'history-recovery:coordinator';
  let state = store.getState(key) ?? { version: 1, sources: [], receipts: [], job: null, review: null };
  if (!validState(state))
    throw fail('Saved recovery state is invalid. Preserve this database and use a fresh current database.');
  let running = null, abort = null, closed = false, uploadRunning = false, uploadRequest = null, uploadSettled = null, initialized = false;
  const known = new Map();
  const persist = () => store.setState(key, state);
  const localBusy = () => Boolean(running || uploadRunning);
  const pairedBusy = () => Boolean(pairContext?.status()?.busy || pairContext?.status()?.uiOperation?.state === 'running');
  const busy = () => localBusy() || pairedBusy();
  const available = () => !closed && canControl() && ready() && store.path !== ':memory:' && !store.readOnly;
  const assertReady = () => { if (!available()) throw fail('History recovery requires the active writable instance.'); };
  const assertIdle = (peer = false) => { assertReady(); if (localBusy() || !peer && pairedBusy()) throw fail('A history recovery operation is already running.'); };
  const input = () => getEngine().config.input;
  function initialize() {
    if (initialized) return;
    initialized = true;
    const recovery = store.getState(`recovery:active:${input()}`);
    if (['importing', 'rebuilding', 'catching-up'].includes(recovery?.status)) markRecoveryFailed(store, input());
    if (state.job?.status === 'running') {
      state.job = { ...state.job, status: 'interrupted', finishedAt: clock(),
        error: 'Recovery was interrupted. Review the source again to continue; accepted history is preserved.' };
      state.review = null; persist();
    }
  }
  async function sources() {
    known.clear();
    for (const source of state.sources) {
      if (!UUID.test(source.id) || source.kind !== 'upload') continue;
      const path = join(directory, 'uploads', `${source.id}.sqlite`);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) known.set(source.id, { ...source, path });
    }
    if (getExportDirectory) {
      let copies;
      try { copies = await listSavedBackups(getExportDirectory()); }
      catch { throw fail('Saved backups could not be listed.'); }
      for (const { path, createdAt, bytes } of copies) {
        const id = sourceId(path);
        known.set(id, { id, path, kind: 'backup', label: `Saved backup · ${new Date(createdAt).toISOString()}`,
          createdAt, bytes });
      }
    }
    for (const source of await getResetBackups()) known.set(source.id, source);
    const rows = [...known.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(publicSource);
    if (pairContext) rows.unshift({ id: 'peer', kind: 'peer', label: 'Paired computer', available: Boolean(pairContext.status()?.actions?.['check-recovery']) });
    return rows;
  }
  async function view({ before } = {}) {
    const module = await recoveryModule();
    const engine = getEngine();
    const operations = engine && module.listRecoveries ? module.listRecoveries(store, engine.config.input, { before, limit: 50 }) : [];
    const last = operations.at(-1);
    return { available: available(), readOnly: !canControl() || store.readOnly, busy: busy(),
      sources: await sources(), job: state.job, preview: state.review?.preview ?? null,
      operations, nextBefore: operations.length === 50 ? `${last.startedAt}:${last.id}` : null,
      peer: pairContext?.status() ?? null };
  }
  function begin(kind, requestId, source, operation) {
    assertIdle(source?.kind === 'peer');
    const engine = getEngine();
    abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
    const job = { id: requestId, requestId, kind, status: 'running', startedAt: clock(), source };
    state.job = job; state.review = null; persist();
    const isCurrent = () => !closed && !signal.aborted && canControl() && getEngine() === engine;
    let lastProgress = 0;
    const onProgress = progress => {
      job.progress = progress;
      if (clock() - lastProgress >= 1000) { lastProgress = clock(); persist(); }
    };
    running = Promise.resolve().then(() => operation({ engine, signal, isCurrent, onProgress,
      onPublish(result) {
        engine.checkpoint = result.checkpoint; engine.pendingPlan = null;
        engine.fireplaceRebuild = null; engine.fireplaceReserveOverride = null;
        engine.lastSample = null; engine.latestStatus = null;
      } })).then(result => {
      job.status = 'complete'; job.finishedAt = clock();
      job.result = result?.report ?? result;
      persist(); return result;
    }, error => {
      job.status = signal.aborted ? 'interrupted' : 'error'; job.finishedAt = clock(); job.error = safeError(error);
      persist(); throw error;
    }).finally(() => { running = null; abort = null; });
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
      state.review = { kind: 'recover', source, preview }; persist();
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
      await sources(); assertIdle();
      const source = known.get(value.sourceId);
      if (!source) throw fail('Choose an available saved or uploaded backup.');
      checkPath({ donorPath: source.path, source: publicSource(source), requestId: value.requestId });
    } else if (value.action === 'recover') {
      const review = state.review;
      if (value.confirmed !== true || review?.kind !== 'recover' || review.preview.previewId !== value.previewId)
        throw fail('Review this backup and confirm recovery first.');
      if (review.source?.kind === 'peer') throw fail('Use the paired source to retain its protection checks.');
      await sources(); assertIdle();
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
        state.review = { kind: active ? 'restore' : 'revert', preview }; persist();
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
    state.receipts = state.receipts.slice(-64); persist();
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
    let finishUpload;
    uploadSettled = new Promise(resolve => { finishUpload = resolve; });
    const id = randomUUID(), path = join(directory, 'uploads', `${id}.partial`);
    const finalPath = join(directory, 'uploads', `${id}.sqlite`);
    let file, completed = false, published = false;
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
        if (!authorized() || !available()) throw fail('Upload authorization changed.');
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
      state.sources.push(source);
      const expired = state.sources.splice(0, Math.max(0, state.sources.length - 16));
      persist(); completed = true;
      for (const row of expired) if (UUID.test(row.id)) await rm(join(directory, 'uploads', `${row.id}.sqlite`), { force: true }).catch(() => {});
      return { sourceId: id, source: publicSource(source) };
    } finally {
      await file?.close().catch(() => {});
      if (!completed) await rm(path, { force: true }).catch(() => {});
      if (published && !completed) await rm(finalPath, { force: true }).catch(() => {});
      uploadRunning = false;
      uploadRequest = null; finishUpload(); uploadSettled = null;
    }
  }
  function cancel() { abort?.abort(); uploadRequest?.destroy?.(); }
  async function close() { closed = true; cancel(); await running?.catch(() => {}); await uploadSettled; }
  return { view, action, upload, initialize, busy, cancel, close, checkPath, applyPath,
    working: localBusy, currentJob: () => state.job, settled: async () => { await running?.catch(() => {}); await uploadSettled; } };
}
