import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { listSavedBackups } from '../storage/backup-catalog.js';
import { storageFailureCode } from '../storage/write-health.js';

const MINUTE = 60_000, DAY = 86_400_000, GIB = 1024 ** 3;
const RECEIPT_KEY = 'storage:backup-health';
const instant = value => Number.isSafeInteger(value) && value >= 0;
const backupKinds = ['saved-copy', 'download'];
const failureCodes = new Set(['disk-full', 'database-busy', 'database-read-only', 'database-io',
  'database-corrupt', 'database-unavailable', 'backup-failed', 'backup_failed', 'export_failed',
  'publication_failed', 'database_publication_unconfirmed', 'backup_cleanup_failed']);
const usableFreshness = new Set(['fresh', 'last-reported', 'held', 'held-attention', 'recorded-interval']);
const freshnessStates = new Set([...usableFreshness, 'waiting', 'unavailable', 'stale', 'failed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceTime = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;
const receiptTime = value => Number.isSafeInteger(value) && sourceTime(value);

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

function validReceipt(value) {
  return value && value.version === 1 && Object.keys(value).every(key => ['version', 'complete', 'failure'].includes(key))
    && [value.complete, value.failure].every(row => row === null || row && instant(row.at) && backupKinds.includes(row.kind)
      && Object.keys(row).every(key => ['at', 'kind', 'errorCode'].includes(key))
      && (row.errorCode === undefined || failureCodes.has(row.errorCode)));
}

/** Local runtime/storage evidence, independent of controller status and DB writes.
 * Filesystem discovery is bounded, cached and asynchronous; no history scans,
 * new backups, integrity rewrites or automatic cleanup are performed here. */
export function createRecordingHealth({ getConfig = () => ({}), clock = Date.now,
  filesystem = statfs, savedBackups = listSavedBackups, resetBackups = async () => [],
  refreshMs = MINUTE, catalogRefreshMs = 5 * MINUTE } = {}) {
  const startedAt = clock();
  let disk = { state: 'unknown', totalBytes: null, freeBytes: null, checkedAt: null,
    detail: 'Disk space has not been checked yet.' };
  let diskKey, diskAttemptAt = null, diskPending;
  let catalog = { copies: [], error: false, checkedAt: null }, catalogKey, catalogPending;
  let receipt = { version: 1, complete: null, failure: null }, receiptStore, receiptInvalid = false;
  let pendingBackup = null, backupRevision = 0;
  let recordingRun = null, recordingScopeSeen = false;

  function loadReceipt(store) {
    if (!store || store.readOnly || receiptStore === store) return;
    receiptStore = store;
    receipt = { version: 1, complete: null, failure: null }; receiptInvalid = false;
    try {
      const saved = store.getState(RECEIPT_KEY);
      if (saved === null) return;
      if (!validReceipt(saved)) { receiptInvalid = true; return; }
      receipt = saved;
    } catch { receiptInvalid = true; }
  }

  function backupEvent(event, store) {
    loadReceipt(store);
    if (!backupKinds.includes(event.kind) || !instant(event.at)) return;
    if (event.phase === 'start') { pendingBackup = { kind: event.kind, at: event.at }; return; }
    pendingBackup = null;
    if (event.phase === 'cancelled') return;
    if (event.phase === 'complete') receipt.complete = { kind: event.kind, at: event.at };
    else if (event.phase === 'failed') receipt.failure = { kind: event.kind, at: event.at,
      errorCode: storageFailureCode({ code: event.errorCode }) ?? (failureCodes.has(event.errorCode) ? event.errorCode : 'backup-failed') };
    else return;
    backupRevision++;
    catalog.checkedAt = null;
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

  function refreshCatalog(config, now) {
    const key = JSON.stringify([config.recording?.exportDirectory ?? null, config.dataDir ?? null]);
    if (catalogKey !== key) { catalogKey = key; catalog = { copies: [], error: false, checkedAt: null }; }
    if (catalogPending || catalog.checkedAt !== null && now - catalog.checkedAt >= 0 && now - catalog.checkedAt < catalogRefreshMs) return catalogPending;
    const revision = backupRevision;
    catalogPending = Promise.allSettled([
      config.recording?.exportDirectory ? savedBackups(config.recording.exportDirectory) : [], resetBackups(config),
    ]).then(results => {
      if (key !== catalogKey || revision !== backupRevision) return;
      const copies = results.flatMap((result, i) => result.status === 'fulfilled'
        ? result.value.filter(row => instant(Math.floor(row.createdAt)) && row.createdAt <= clock())
          .map(row => ({ at: row.createdAt, kind: i ? 'reset-archive' : 'saved-copy' })) : []);
      catalog = { copies: copies.sort((a, b) => b.at - a.at), error: results.some(result => result.status === 'rejected'), checkedAt: clock() };
    }).finally(() => { catalogPending = null; });
    return catalogPending;
  }

  function recordingStatus({ store, engine, current, readOnly, now }) {
    const writes = store?.writeHealth?.status();
    const base = { pendingWrites: writes?.queue?.pending ?? 0, waitingSince: writes?.queue?.waitingSince ?? null, lastSourceCheckAt: null, lastFailureAt: writes?.lastFailureAt ?? null, errorCode: writes?.errorCode ?? null };
    if (readOnly || store?.readOnly || current?.input === 'offline' || engine?.config?.input === 'offline') {
      recordingRun = null; recordingScopeSeen = true;
      return { ...base, state: 'read-only', detail: 'This computer is showing recorded history. Live recording health must be checked on the active master.' };
    }
    if (!recordingRun || recordingRun.engine !== engine || recordingRun.store !== store) {
      recordingRun = { engine, store, startedAt: recordingScopeSeen ? now : startedAt, usableSourceSeen: false };
      recordingScopeSeen = true;
    }
    const tickAt = engine?.latestStatus?.now;
    const parameters = recordingParameters(current?.recording, now);
    base.lastSourceCheckAt = parameters?.reduce((latest, row) => receiptTime(row.lastPollAt) && row.lastPollAt <= now
      ? Math.max(latest ?? 0, row.lastPollAt) : latest, null) ?? null;
    const healthy = parameters?.some(row => {
      const freshness = row.freshness;
      if (!freshness) return false;
      if (['last-reported', 'held', 'held-attention'].includes(freshness.status)) return true;
      if (freshness.status === 'recorded-interval') return Number.isFinite(row.lastPollAt) && now - row.lastPollAt <= 5 * MINUTE;
      return freshness.status === 'fresh' && (freshness.maxAgeMs === null
        || Number.isFinite(freshness.sourceObservedAt) && now - freshness.sourceObservedAt < freshness.maxAgeMs);
    });
    if (healthy) recordingRun.usableSourceSeen = true;
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
    const complete = receipt.complete?.at <= now ? receipt.complete : null;
    const latest = [catalog.copies[0], complete?.kind === 'download' ? complete : null].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    const failure = receipt.failure?.at <= now ? receipt.failure : null;
    const failed = failure && (!complete || failure.at >= complete.at);
    const state = pendingBackup ? 'running' : failed ? 'failed' : receiptInvalid || catalog.error ? 'unknown' : latest ? 'available' : 'none-known';
    const detail = pendingBackup ? 'A requested database copy is being prepared. It is not complete yet.'
      : failed ? 'The last requested database copy failed. Retry after checking storage space and access.'
        : receiptInvalid || catalog.error ? 'Some backup information could not be read. Available copies are not proof that the latest backup succeeded.'
          : latest?.kind === 'download' ? 'The last download was sent to the browser. Its saved file and continued availability cannot be verified here.'
            : latest ? 'A saved copy was found. Its contents have not been rechecked; a copy on the same disk does not protect against disk failure.'
              : 'No saved copy is known in the configured export folder or reset archives. Backups are taken by explicit actions, with no schedule.';
    return { state, detail, latestAt: latest?.at ?? null, latestKind: latest?.kind ?? null,
      // Listing metadata and a past action receipt cannot validate today's bytes.
      latestVerifiedAt: null,
      startedAt: pendingBackup?.at ?? null, lastFailureAt: failure?.at ?? null };
  }

  return {
    backupEvent,
    async status({ store, engine, current, readOnly = false } = {}) {
      const config = getConfig(), now = clock();
      loadReceipt(store);
      const operations = [refreshDisk(store?.path ?? config.dbPath, now), refreshCatalog(config, now)].filter(Boolean);
      // A slow/unavailable mount must not hold the dashboard request indefinitely.
      if (operations.length) {
        let timeout;
        await Promise.race([Promise.allSettled(operations), new Promise(resolve => { timeout = setTimeout(resolve, 150); })]);
        clearTimeout(timeout);
      }
      const recording = recordingStatus({ store, engine, current, readOnly, now }), backup = backupStatus(now);
      const diskStale = disk.checkedAt !== null && now - disk.checkedAt > 2 * refreshMs;
      const diskView = diskStale ? { ...disk, state: 'unknown', freeBytes: null, totalBytes: null,
        detail: 'The disk space check has not refreshed. Current available space is unknown; check local storage.' } : { ...disk };
      const attention = [];
      if (diskStale) attention.push({ id: 'disk-check', severity: disk.state === 'critical' ? 'critical' : 'warning',
        title: ['low', 'critical'].includes(disk.state) ? 'The earlier disk space warning is not cleared' : 'Disk space cannot be confirmed', detail: diskView.detail });
      else if (['low', 'critical'].includes(disk.state)) attention.push({ id: 'disk-space', severity: disk.state === 'critical' ? 'critical' : 'warning',
        title: disk.state === 'critical' ? 'Disk space is critically low' : 'Disk space is running low', detail: disk.detail });
      else if (disk.state === 'unknown' && disk.checkedAt !== null)
        attention.push({ id: 'disk-check', severity: 'warning', title: 'Disk space could not be checked', detail: disk.detail });
      if (['write-failed', 'write-waiting', 'stalled', 'source-unavailable'].includes(recording.state)) attention.push({ id: 'recording',
        severity: recording.state === 'write-failed' ? 'critical' : 'warning', title: recording.state === 'write-failed'
          ? 'Database writes are failing' : recording.state === 'write-waiting' ? 'Waiting for storage' : recording.state === 'stalled' ? 'Recording needs attention' : 'Recording sources are unavailable', detail: recording.detail });
      else if (recording.state !== 'read-only' && recording.lastFailureAt !== null && now - recording.lastFailureAt < DAY)
        attention.push({ id: 'recording-resumed', severity: 'warning', title: 'A database write failed earlier', detail: recording.detail });
      if (backup.state === 'failed') attention.push({ id: 'backup', severity: 'warning', title: 'The last backup failed', detail: backup.detail });
      return { version: 2, checkedAt: now, scope: readOnly || store?.readOnly ? 'snapshot'
        : (current?.input ?? engine?.config?.input) === 'offline' ? 'history' : 'live',
        disk: diskView, recording, backup, attention };
    },
  };
}
