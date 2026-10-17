import { statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createBackupCatalog } from '../storage/backup-catalog.js';
import { storageFailureCode } from '../storage/write-health.js';
import { storageOperationHealth } from '../storage/operation-health.js';
import { recordedSignalInfo, RECORDING_POLICIES } from '../domain/recording-policy.js';
import { SIGNAL_INFO } from '../domain/history-series.js';
import { verificationFailureEvidence } from './database-verification.js';

const MINUTE = 60_000, DAY = 86_400_000, GIB = 1024 ** 3;
const RECEIPT_KEY = 'storage:backup-health';
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const backupKinds = ['saved-copy', 'download'];
const failureCodes = new Set(['disk-full', 'database-busy', 'database-read-only', 'database-io',
  'database-corrupt', 'database-unavailable', 'backup-failed', 'backup_failed', 'export_failed',
  'publication_failed', 'database_publication_unconfirmed', 'backup_cleanup_failed']);
const usableFreshness = new Set(['fresh', 'last-reported', 'held', 'held-attention', 'recorded-interval']);
const freshnessStates = new Set([...usableFreshness, 'waiting', 'unavailable', 'stale', 'failed']);
const publicUnits = new Set(['degC', 'K', '°F', 'degF', ...Object.values(SIGNAL_INFO).map(info => info.unit).filter(Boolean)]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceTime = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;
const receiptTime = value => Number.isSafeInteger(value) && sourceTime(value);

/** Availability is current Store evidence, independent of the saved-write
 * receipts and rolling diagnostics. A proven COMMIT cannot revive a dead worker. */
function writerStatus(store, writes) {
  const failed = store?.writerFailed === true || Boolean(store?.writer?.failed);
  if (store?.writePending === true && failed) return { state: 'confirming' };
  if (failed) return { state: 'unavailable' };
  if (store?.writeQueue?.closed === true) return { state: 'stopped' };
  const queue = writes?.queue;
  if (store?.writeQueue?.closed !== false || !object(queue)
    || !['pending', 'queued', 'activeJobs'].every(key => Number.isSafeInteger(queue[key]) && queue[key] >= 0)
    || queue.pending !== queue.queued + queue.activeJobs
    || store.writer && (store.writer.started !== true || store.writer.terminated !== false
      || store.writerFailed !== false || typeof store.writePending !== 'boolean')) return { state: 'unknown' };
  return { state: store.writePending === true ? 'saving' : 'ready' };
}

function runtimeTimingStatus(engine) {
  let value;
  try { value = engine?.runtimeTiming?.(); } catch { return null; }
  if (!object(value) || value.basis !== 'observed-event-loop-delay' || value.hardRealtime !== false
    || !Number.isSafeInteger(value.samples) || value.samples < 0
    || !Number.isFinite(value.warningThresholdMs) || value.warningThresholdMs <= 0
    || ['maxObservedDelayMs', 'p99ObservedDelayMs'].some(key => value.samples === 0 ? value[key] !== null
      : !Number.isFinite(value[key]) || value[key] < 0)) return null;
  return { basis: value.basis, hardRealtime: false, warningThresholdMs: value.warningThresholdMs,
    samples: value.samples, maxObservedDelayMs: value.maxObservedDelayMs, p99ObservedDelayMs: value.p99ObservedDelayMs };
}

/** Validate only the recorder evidence used by this presentation boundary. An
 * unavailable row may lack measurement clocks; a usable row must have them.
 * Bad source metadata must not prevent independent disk/write health reporting. */
function recordingParameters(recording, now) {
  if (recording === undefined) return [];
  if (!object(recording)) return null;
  const lists = [recording.parameters, recording.exactParameters];
  if (lists.some(list => list !== undefined && !Array.isArray(list))) return null;
  const rows = lists.flatMap(list => list ?? []);
  if (rows.some(row => !object(row) || typeof row.observedThisRun !== 'boolean')) return null;
  const active = rows.filter(row => row.observedThisRun);
  for (const row of active) {
    const freshness = row.freshness;
    if (row.lastPollAt != null && (!receiptTime(row.lastPollAt) || row.lastPollAt > now)) return null;
    if (freshness == null) continue;
    if (!object(freshness) || !freshnessStates.has(freshness.status)
      || freshness.sourceObservedAt != null && !sourceTime(freshness.sourceObservedAt)
      || freshness.maxAgeMs != null && (!Number.isSafeInteger(freshness.maxAgeMs) || freshness.maxAgeMs <= 0)) return null;
    if (usableFreshness.has(freshness.status) && (!receiptTime(row.lastPollAt)
      || !sourceTime(freshness.sourceObservedAt) || freshness.sourceObservedAt > now
      || freshness.status === 'fresh' && freshness.maxAgeMs === undefined)) return null;
  }
  return active;
}

function usableSource(row, now) {
  const freshness = row.freshness;
  if (!freshness) return false;
  if (['last-reported', 'held', 'held-attention'].includes(freshness.status)) return true;
  if (freshness.status === 'recorded-interval') return Number.isFinite(row.lastPollAt) && now - row.lastPollAt <= 5 * MINUTE;
  return freshness.status === 'fresh' && (freshness.maxAgeMs === null
    || Number.isFinite(freshness.sourceObservedAt) && now - freshness.sourceObservedAt < freshness.maxAgeMs);
}

/** Observed streams only. This is not a census of configured or never-seen sources.
 * Signal labels are from the public catalogue; arbitrary device identities and
 * provider strings never leave this independent health endpoint. */
function sourceSummary(parameters, now) {
  if (parameters === null) return null;
  const issues = parameters.filter(row => !usableSource(row, now) || row.freshness?.status === 'held-attention');
  return { observedStreams: parameters.length, usableStreams: parameters.filter(row => usableSource(row, now)).length,
    attentionStreams: issues.length, unknownStreams: parameters.filter(row => !row.freshness).length,
    complete: false, truncated: issues.length > 50,
    issues: issues.slice(0, 50).map((row, index) => {
      const info = typeof row.signal === 'string' ? recordedSignalInfo(row.signal) : null;
      const publicLabel = info && info.label !== row.signal.replaceAll('_', ' ');
      const status = ['fresh', 'recorded-interval'].includes(row.freshness?.status) && !usableSource(row, now)
        ? 'stale' : row.freshness?.status ?? 'unknown';
      const policy = Object.hasOwn(RECORDING_POLICIES, row.policy ?? '') ? row.policy : null;
      const caravanReason = row.signal === 'caravan_dehumidifier_state' && Array.isArray(row.freshness?.reasons)
        ? row.freshness.reasons.find(reason => ['location-unconfirmed', 'state-evidence-unavailable'].includes(reason)) : null;
      return {
        id: typeof row.streamId === 'string' && /^[a-f0-9]{12}$/.test(row.streamId) ? row.streamId : `observed-${index}`,
        label: publicLabel ? info.label : 'Recorded measurement',
        status, policy, unit: publicUnits.has(row.unit) ? row.unit : '',
        destination: policy && RECORDING_POLICIES[policy].adaptive ? 'adaptive' : 'inventory',
        reason: { 'location-unconfirmed': 'The Caravan power check and fresh appliance/meter reports have not confirmed recording readiness.',
          'state-evidence-unavailable': 'Fresh power reports, and a fresh fan report while On, are required to record the state.' }[caravanReason]
          ?? { unavailable: 'The observed source is unavailable.', stale: 'The observed source has not reported within its freshness limit.',
          failed: 'The last source check failed.', waiting: 'Waiting for another usable source report.',
          'held-attention': 'The last reported value is retained, with a source warning.' }[status]
          ?? 'Usable source evidence is not available.',
        lastCheckedAt: receiptTime(row.lastPollAt) ? row.lastPollAt : null,
        sourceObservedAt: sourceTime(row.freshness?.sourceObservedAt) ? row.freshness.sourceObservedAt : null,
      };
    }) };
}

export function diskSpaceStatus(stats, checkedAt) {
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  // bavail is the space available to this application, excluding reserved blocks.
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (![totalBytes, freeBytes].every(Number.isSafeInteger) || totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes)
    throw new Error('Invalid filesystem capacity');
  const lowBytes = Math.max(GIB, Math.min(totalBytes * .05, 5 * GIB));
  const criticalBytes = Math.max(GIB / 4, Math.min(totalBytes * .01, GIB));
  const state = freeBytes <= criticalBytes ? 'critical' : freeBytes <= lowBytes ? 'low' : 'ok';
  return { state, totalBytes, freeBytes, lowBytes, criticalBytes, checkedAt,
    detail: state === 'critical' ? 'Very little space is available. Database writes and backups may fail. Free space on this disk.'
      : state === 'low' ? 'Space is running low. Make room for continued recording and backup copies.'
        : 'Space available to this application on the database disk. Other files also use this disk.' };
}

const emptyReceipt = () => ({ version: 2, savedCopy: { complete: null, failure: null }, download: { complete: null, failure: null } });
function validReceipt(value) {
  return object(value) && value.version === 2 && Object.keys(value).every(key => ['version', 'savedCopy', 'download'].includes(key))
    && [value.savedCopy, value.download].every(outcome => object(outcome)
      && Object.keys(outcome).every(key => ['complete', 'failure'].includes(key))
      && [outcome.complete, outcome.failure].every(row => row === null || object(row) && instant(row.at)
        && Object.keys(row).every(key => ['at', 'errorCode'].includes(key))
        && (row.errorCode === undefined || failureCodes.has(row.errorCode))));
}

/** Local runtime/storage evidence, independent of controller status and DB writes.
 * Filesystem discovery is bounded, cached and asynchronous; no history scans,
 * new backups, integrity rewrites or automatic cleanup are performed here. */
export function createRecordingHealth({ getConfig = () => ({}), clock = Date.now,
  filesystem = statfs, backupCatalog = createBackupCatalog({ getConfig, clock }),
  getBackupChecks = () => null,
  refreshMs = MINUTE } = {}) {
  const startedAt = clock();
  const contexts = new WeakMap();
  let disk = { state: 'unknown', totalBytes: null, freeBytes: null, checkedAt: null,
    detail: 'Disk space has not been checked yet.' };
  let diskKey, diskAttemptAt = null, diskPending;
  let catalog = { copies: [], complete: false, error: false, checkedAt: null }, catalogPending;
  let checkedCopies = [];
  let receipt = emptyReceipt(), receiptStore, receiptInvalid = false;
  const pendingBackups = new Map();
  let backupRevision = 0;
  let recordingRun = null, recordingScopeSeen = false;

  function loadReceipt(store) {
    if (!store || store.readOnly || receiptStore === store) return;
    receiptStore = store;
    receipt = emptyReceipt(); receiptInvalid = false;
    try {
      const saved = store.getState(RECEIPT_KEY);
      if (saved === null) return;
      if (!validReceipt(saved)) { receiptInvalid = true; return; }
      receipt = saved;
    } catch { receiptInvalid = true; }
  }

  function backupEvent(event, store) {
    loadReceipt(store);
    if (!backupKinds.includes(event.kind) || !instant(event.at)
      || typeof event.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(event.operationId)) return;
    if (event.phase === 'start') {
      pendingBackups.set(event.operationId, { kind: event.kind, at: event.at });
      return;
    }
    if (!['cancelled', 'complete', 'failed'].includes(event.phase)) return;
    pendingBackups.delete(event.operationId);
    if (event.phase === 'cancelled') return;
    const outcome = receipt[event.kind === 'saved-copy' ? 'savedCopy' : 'download'];
    if (event.phase === 'complete') outcome.complete = { at: event.at };
    else if (event.phase === 'failed') outcome.failure = { at: event.at,
      errorCode: storageFailureCode({ code: event.errorCode }) ?? (failureCodes.has(event.errorCode) ? event.errorCode : 'backup-failed') };
    else return;
    backupRevision++;
    catalog.checkedAt = null;
    backupCatalog.invalidate?.();
    // The health receipt must not turn a completed backup into a failed backup.
    // A full/unavailable database still leaves the in-memory result visible.
    if (store && !store.readOnly && !receiptInvalid) {
      const snapshot = structuredClone(receipt);
      void store.runWrite(() => store.setState(RECEIPT_KEY, snapshot)).catch(() => { /* Runtime evidence remains available. */ });
    }
  }

  function refreshDisk(path, now) {
    const key = path && path !== ':memory:' ? dirname(path) : null;
    if (diskKey !== key) {
      diskKey = key; diskAttemptAt = null;
      disk = { state: 'unknown', totalBytes: null, freeBytes: null, checkedAt: null,
        detail: key ? 'Checking space on the local database disk.' : 'No on-disk database is available on this computer.' };
    }
    if (!key || diskPending || diskAttemptAt !== null && now - diskAttemptAt >= 0 && now - diskAttemptAt < refreshMs) return diskPending;
    diskAttemptAt = now;
    diskPending = Promise.resolve().then(() => filesystem(key)).then(stats => {
      if (key === diskKey) disk = diskSpaceStatus(stats, clock());
    }).catch(() => {
      if (key === diskKey) disk = { state: 'unknown', totalBytes: null, freeBytes: null, checkedAt: clock(),
        detail: 'Available disk space could not be checked. Check the database storage on this computer.' };
    }).finally(() => { diskPending = null; });
    return diskPending;
  }

  function refreshCatalog() {
    if (catalogPending) return catalogPending;
    const revision = backupRevision;
    catalogPending = backupCatalog.list().then(result => {
      if (revision !== backupRevision) return;
      const copies = result.copies.filter(row => {
        const at = row.createdAt ?? row.fileModifiedAt;
        return instant(Math.floor(at)) && at <= clock();
      }).map(row => ({ at: row.createdAt ?? row.fileModifiedAt, dateBasis: row.createdAt === null ? 'file-modified' : 'snapshot',
        kind: row.kind === 'reset' ? 'reset-archive' : row.kind === 'protected' ? 'protected-copy' : 'saved-copy',
        bytes: row.bytes, verifiedAt: row.verification?.at ?? null }));
      const failed = result.reasons?.some(reason => /unavailable|changed/.test(reason));
      if (failed && !copies.length && catalog.copies.length) {
        catalog = { ...catalog, error: true, complete: false };
      } else {
        checkedCopies = result.copies;
        catalog = { copies: copies.sort((a, b) => b.at - a.at), complete: result.complete,
          error: Boolean(failed), checkedAt: result.checkedAt };
      }
    }).catch(() => { catalog = { ...catalog, error: true, complete: false }; })
      .finally(() => { catalogPending = null; });
    return catalogPending;
  }

  function recordingStatus({ store, engine, current, readOnly, now }) {
    const writes = store?.writeHealth?.status();
    const storage = store?.storageStatus?.(writes?.queue) ?? null;
    if (storage) storage.writer = store?.readOnly ? { state: 'read-only' } : writerStatus(store, writes);
    const base = { pendingWrites: writes?.queue?.pending ?? 0, waitingSince: writes?.queue?.waitingSince ?? null,
      writer: null, runtimeTiming: null,
      storage,
      storageTimings: writes?.transactions ?? null,
      history: writes?.history ?? null,
      lastLoopCompletedAt: null, sources: null,
      lastSourceCheckAt: null, lastWriteAt: writes?.lastWriteAt ?? null,
      lastFailureAt: writes?.lastFailureAt ?? null, errorCode: writes?.errorCode ?? null };
    if (readOnly || store?.readOnly || current?.input === 'offline' || engine?.config?.input === 'offline') {
      recordingRun = null; recordingScopeSeen = true;
      return { ...base, history: null, state: 'read-only', detail: 'This computer is showing recorded history. Live recording health must be checked on the active master.' };
    }
    base.writer = storage?.writer ?? writerStatus(store, writes);
    base.runtimeTiming = runtimeTimingStatus(engine);
    if (!recordingRun || recordingRun.engine !== engine || recordingRun.store !== store) {
      recordingRun = { engine, store, startedAt: recordingScopeSeen ? now : startedAt, usableSourceSeen: false };
      recordingScopeSeen = true;
    }
    const tickAt = engine?.latestStatus?.now;
    let recording = current?.recording;
    try { if (engine?.recordingSourceStatus) recording = engine.recordingSourceStatus(now) ?? null; }
    catch { recording = null; }
    const parameters = recordingParameters(recording, now);
    base.lastLoopCompletedAt = receiptTime(tickAt) && tickAt <= now ? tickAt : null;
    base.sources = sourceSummary(parameters, now);
    base.lastSourceCheckAt = parameters?.reduce((latest, row) => receiptTime(row.lastPollAt) && row.lastPollAt <= now
      ? Math.max(latest ?? 0, row.lastPollAt) : latest, null) ?? null;
    const healthy = parameters?.some(row => usableSource(row, now));
    if (healthy) recordingRun.usableSourceSeen = true;
    if (base.writer.state === 'confirming') return { ...base, state: 'writer-confirming',
      detail: 'The storage writer stopped responding. The last save is being checked before its outcome is reported; control requests remain blocked.' };
    if (['unavailable', 'stopped'].includes(base.writer.state)) return { ...base, state: 'writer-unavailable',
      detail: base.writer.state === 'stopped'
        ? 'The storage writer has stopped accepting saves. New recording and storage-dependent control are unavailable.'
        : 'Confirmed saves remain recorded. New recording and storage-dependent control are unavailable. Check storage, then restart the application.' };
    if (writes?.failing) return { ...base, state: 'write-failed', detail: 'A database write failed. New history may be missing; check disk space and storage access.' };
    if (writes?.queue?.waitingSince != null) return { ...base, state: 'write-waiting',
      detail: 'Storage is busy. Received readings are waiting to be saved; control requests wait for durable intent before dispatch.' };
    if (engine && now - (Number.isFinite(tickAt) ? tickAt : recordingRun.startedAt) > 3 * MINUTE)
      return { ...base, state: 'stalled', detail: 'The recording and controller update loop has not completed for more than three minutes. History may have gaps.' };
    if (parameters === null) return { ...base, state: 'unknown', detail: 'Recording source status could not be read. Refresh to check again.' };
    // Initial unavailable diagnostic rows are still startup, not proof that a
    // working feed was lost. Once usable evidence arrives, a later loss is
    // visible immediately. This presentation grace grants no control authority.
    if (!healthy) {
      if (!recordingRun.usableSourceSeen && now - recordingRun.startedAt < 3 * MINUTE)
        return { ...base, state: 'starting', detail: 'Waiting for usable source readings.' };
      return { ...base, state: engine ? 'source-unavailable' : 'unknown',
        detail: engine ? 'No usable source readings. Check source connections.' : 'Recording health is not available.' };
    }
    return { ...base, state: 'ok', detail: writes?.lastFailureAt !== null && writes?.lastFailureAt !== undefined
      && now - writes.lastFailureAt < DAY
      ? `Writes have resumed after ${writes.failures} failed write${writes.failures === 1 ? '' : 's'} in this run. Earlier gaps may remain.`
      : 'The update loop is active and recorded source evidence is available. Unchanged readings and open energy intervals do not require new observation rows.' };
  }

  function backupStatus(now) {
    // Verification results can change between filesystem scans. Re-evaluate
    // their saved file identities without scanning or restarting verification.
    const checks = getBackupChecks(checkedCopies);
    const pendingBackup = [...pendingBackups.values()].find(row => row.kind === 'saved-copy')
      ?? pendingBackups.values().next().value;
    const outcomes = Object.fromEntries(['savedCopy', 'download'].map(kind => {
      const value = receipt[kind], complete = value.complete?.at <= now ? value.complete : null;
      const failure = value.failure?.at <= now ? value.failure : null;
      return [kind, { completedAt: complete?.at ?? null, failedAt: failure?.at ?? null,
        failed: Boolean(failure && (!complete || failure.at >= complete.at)) }];
    }));
    const latest = catalog.copies[0];
    const failed = outcomes.savedCopy.failed || outcomes.download.failed;
    const failureAt = Math.max(outcomes.savedCopy.failedAt ?? 0, outcomes.download.failedAt ?? 0) || null;
    const state = pendingBackup ? 'running' : failed ? 'failed' : receiptInvalid || catalog.error ? 'unknown' : latest ? 'available' : 'none-known';
    const detail = pendingBackup ? 'A requested database copy or download is still in progress.'
      : failed ? `${outcomes.savedCopy.failed ? 'The last server save failed.' : 'The last browser transfer failed.'} Retry after checking storage space and access.`
        : receiptInvalid || catalog.error ? 'Some backup information could not be read. Available copies are not proof that the latest backup succeeded.'
          : latest ? 'Saved database copies are listed from this server. Listing does not verify their current contents; expand Backups to view dated checks.'
            : 'No saved database copy is known on this server. There is no automatic backup schedule.';
    return { state, detail, latestAt: latest?.at ?? null, latestKind: latest?.kind ?? null,
      // Listing metadata and a past action receipt cannot validate today's bytes.
      latestVerifiedAt: latest?.verifiedAt ?? null, latestDateBasis: latest?.dateBasis ?? null,
      count: catalog.copies.length, totalBytes: catalog.copies.reduce((total, row) => total + (Number.isSafeInteger(row.bytes) && row.bytes >= 0 ? row.bytes : 0), 0),
      complete: catalog.complete, catalogCheckedAt: catalog.checkedAt,
      downloadAt: outcomes.download.completedAt, outcomes,
      failedChecks: checks?.failedChecks ?? 0, changedChecks: checks?.changedChecks ?? 0,
      checkScope: 'current-run', startedAt: pendingBackup?.at ?? null, lastFailureAt: failureAt };
  }

  return {
    backupEvent,
    async status({ store, engine, current, readOnly = false, verification = null } = {}) {
      const config = getConfig(), refreshAt = clock();
      if (store && !contexts.has(store)) contexts.set(store, randomUUID());
      loadReceipt(store);
      const operations = [refreshDisk(store?.path ?? config.dbPath, refreshAt), refreshCatalog()].filter(Boolean);
      // A slow/unavailable mount must not hold the dashboard request indefinitely.
      if (operations.length) {
        let timeout;
        await Promise.race([Promise.allSettled(operations), new Promise(resolve => { timeout = setTimeout(resolve, 150); })]);
        clearTimeout(timeout);
      }
      // Acquisition can commit while filesystem checks are awaited. Evaluate
      // that current source evidence against the clock after the wait.
      const now = clock();
      const recording = recordingStatus({ store, engine, current, readOnly, now }), backup = backupStatus(now);
      const diskStale = disk.checkedAt !== null && now - disk.checkedAt > 2 * refreshMs;
      const diskView = diskStale ? { ...disk, state: 'unknown', freeBytes: null, totalBytes: null,
        detail: 'The disk space check has not refreshed. Current available space is unknown; check local storage.' } : { ...disk };
      const attention = [];
      if (recording.storage?.checkpoint?.state === 'failed') attention.push({ id: 'storage-checkpoint', severity: 'warning',
        title: 'WAL checkpoint needs attention',
        detail: 'The last background checkpoint request failed. Confirmed saves remain recorded; outstanding WAL work may grow. Review Storage health.' });
      if (diskStale) attention.push({ id: 'disk-check', severity: disk.state === 'critical' ? 'critical' : 'warning',
        title: ['low', 'critical'].includes(disk.state) ? 'The earlier disk space warning is not cleared' : 'Disk space cannot be confirmed', detail: diskView.detail });
      else if (['low', 'critical'].includes(disk.state)) attention.push({ id: 'disk-space', severity: disk.state === 'critical' ? 'critical' : 'warning',
        title: disk.state === 'critical' ? 'Disk space is critically low' : 'Disk space is running low', detail: disk.detail });
      else if (disk.state === 'unknown' && disk.checkedAt !== null)
        attention.push({ id: 'disk-check', severity: 'warning', title: 'Disk space could not be checked', detail: disk.detail });
      if (['writer-unavailable', 'writer-confirming'].includes(recording.state)) attention.push({ id: 'storage-writer',
        severity: recording.state === 'writer-unavailable' ? 'critical' : 'warning',
        title: recording.state === 'writer-unavailable' ? 'Storage writer is unavailable' : 'Confirming the last save', detail: recording.detail });
      else if (['write-failed', 'write-waiting', 'stalled', 'source-unavailable'].includes(recording.state)) attention.push({ id: 'recording',
        severity: recording.state === 'write-failed' ? 'critical' : 'warning', title: recording.state === 'write-failed'
          ? 'Database writes are failing' : recording.state === 'write-waiting' ? 'Waiting for storage' : recording.state === 'stalled' ? 'Recording needs attention' : 'Recording sources are unavailable', detail: recording.detail });
      else if (recording.state !== 'read-only' && recording.lastFailureAt !== null && now - recording.lastFailureAt < DAY)
        attention.push({ id: 'recording-resumed', severity: 'warning', title: 'A database write failed earlier', detail: recording.detail });
      if (recording.state === 'ok' && recording.sources?.attentionStreams > 0) attention.push({ id: 'recording-sources',
        severity: 'warning', title: `${recording.sources.attentionStreams} observed source${recording.sources.attentionStreams === 1 ? ' needs' : 's need'} attention`,
        detail: 'Monitoring remains active, but some observed streams are unavailable or have a source warning. Review their individual evidence.' });
      if (backup.state === 'failed') attention.push({ id: 'backup', severity: 'warning', title: 'The last backup failed', detail: backup.detail });
      if (backup.failedChecks || backup.changedChecks) attention.push({ id: 'backup-check', severity: 'warning',
        title: 'Saved-copy checks need attention', detail: `${backup.failedChecks} failed check${backup.failedChecks === 1 ? '' : 's'} and ${backup.changedChecks} changed cop${backup.changedChecks === 1 ? 'y' : 'ies'} were observed in this application run. Review Backups for the dated results.` });
      const verificationFailure = verification?.lastFailure;
      if (instant(verificationFailure?.finishedAt) && verificationFailure.finishedAt <= now) attention.push({ id: 'database-verification',
        ...verificationFailureEvidence(verificationFailure.error) });
      return { version: 3, checkedAt: now, operations: storageOperationHealth.status(), contextId: store ? contexts.get(store) : null,
        scope: readOnly || store?.readOnly ? 'snapshot'
        : (current?.input ?? engine?.config?.input) === 'offline' ? 'history'
          : (current?.input ?? engine?.config?.input) === 'simulated' ? 'simulated' : 'live',
        disk: diskView, recording, backup, verification, attention };
    },
  };
}
