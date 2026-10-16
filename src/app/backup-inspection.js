import { storageOperationHealth } from '../storage/operation-health.js';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { publicBackupCatalog } from '../storage/backup-catalog.js';
import { verifyDatabase } from '../storage/full-verifier.js';

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const permittedErrors = new Set(['database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch',
  'database_state_incompatible', 'database_integrity_failed', 'database_journal_invalid',
  'full_verification_transport_mismatch', 'full_verification_checkpoint_mismatch', 'full_verification_content_mismatch',
  'full_verification_busy', 'backup_copy_unavailable']);

/** Inspect existing immutable copies without importing their settings or acquiring
 * control. Verification shares the application's bounded full-check worker queue. */
export function createBackupInspection({ catalog, verify = verifyDatabase, clock = Date.now,
  onDownloadEvent = () => {} } = {}) {
  storageOperationHealth.register('backup-inspection');
  storageOperationHealth.register('backup-download');
  let running, cancellation, latest = null, closed = false;
  const results = new Map();
  const status = () => { const { fingerprint, ...value } = latest ?? {}; return latest ? value : null; };
  const remember = value => {
    latest = value;
    results.delete(value.sourceId); results.set(value.sourceId, value);
    while (results.size > 100) results.delete(results.keys().next().value);
  };
  const checkedCopy = (copy, result) => !result ? null : !result.fingerprint || result.fingerprint === copy.fingerprint
    ? result : { ...result, state: 'changed', error: 'backup_copy_unavailable' };
  async function list(options) {
    const privateCatalog = await catalog.list(options);
    const view = publicBackupCatalog(privateCatalog);
    view.copies = view.copies.map((copy, index) => {
      const result = results.get(copy.id);
      if (!result) return copy;
      const { fingerprint, ...recheck } = checkedCopy(privateCatalog.copies[index], result);
      return { ...copy, recheck };
    });
    const { fingerprint, ...recheck } = latest ?? {};
    return { ...view, recheck: latest ? recheck : null };
  }
  function start(sourceId) {
    if (closed) throw fail('backup_inspection_unavailable', 'Backup inspection is unavailable.');
    if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId))
      throw fail('backup_copy_unavailable', 'Refresh the backup list and select a saved copy.', 400);
    if (running) {
      if (latest.sourceId === sourceId) return status();
      storageOperationHealth.refuse('backup-inspection');
      throw fail('backup_verification_busy', 'A saved-copy check is already running. Wait for it to finish.');
    }
    cancellation = new AbortController();
    const signal = cancellation.signal;
    remember({ sourceId, scope: 'current-run', state: 'queued', startedAt: clock(), finishedAt: null, error: null, progress: null });
    const operation = storageOperationHealth.begin('backup-inspection', { scope: 'history' });
    let outcome = 'completed';
    running = (async () => {
      const source = await catalog.open(sourceId);
      try {
        signal.throwIfAborted();
        await source.assertCurrent();
        remember({ ...latest, fingerprint: source.row.fingerprint });
        const result = await verify({ dbPath: source.row.path,
          ...(source.row.checkpoint ? { checkpoint: source.row.checkpoint } : {}),
          ...(source.row.digest ? { snapshot: { digest: source.row.digest, bytes: source.row.bytes } } : {}),
          signal, origin: 'backup', onProgress: progress => {
            remember({ ...latest, state: progress.phase === 'queued' ? 'queued' : 'running',
              progress: { phase: progress.phase, processed: progress.processed ?? 0, total: progress.total ?? null } });
          } });
        await source.assertCurrent();
        remember({ ...latest, state: 'complete', finishedAt: clock(), error: null, progress: null,
          checkedAt: result.verifiedAt ?? clock() });
      } finally { await source.release(); }
    })().catch(error => {
      outcome = signal.aborted ? 'cancelled' : 'failed';
      remember({ ...latest, state: error?.code === 'backup_copy_unavailable' ? 'changed' : 'error',
        finishedAt: clock(), progress: null,
        error: signal.aborted ? 'backup_verification_interrupted'
          : permittedErrors.has(error?.code) ? error.code : 'backup_verification_failed' });
    }).finally(() => { operation.finish(outcome, { reason: outcome === 'completed' ? null : outcome === 'cancelled' ? 'cancelled' : 'operation-failed' }); running = null; cancellation = null; });
    return status();
  }
  async function download({ sourceId, response, authorized }) {
    if (closed || !authorized()) throw fail('backup_access_revoked', 'Backup access is unavailable.', 403);
    const operation = storageOperationHealth.begin('backup-download', { scope: 'history' });
    let source, outcome = 'completed';
    const operationId = randomUUID();
    const notify = (phase, extra = {}) => { try { onDownloadEvent({ operationId, phase, kind: 'download', at: clock(), ...extra }); } catch {} };
    try {
      source = await catalog.open(sourceId);
      notify('start');
      await source.assertCurrent();
      if (!authorized()) throw fail('backup_access_revoked', 'Backup access is unavailable.', 403);
      response.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'cache-control': 'no-store',
        'content-length': source.row.bytes, 'content-disposition': `attachment; filename="${source.row.filename}"` });
      // Keep one bounded final chunk until the identity check finishes. With a
      // Content-Length response, delivering every byte already completes the
      // browser transfer even if the server has not called end() yet.
      let tail;
      const guard = new Transform({ transform(chunk, encoding, callback) {
        if (!authorized()) return callback(fail('backup_access_revoked', 'Backup access is unavailable.', 403));
        if (tail) this.push(tail);
        tail = chunk; callback();
      }, flush(callback) {
        source.assertCurrent().then(() => {
          if (!authorized()) throw fail('backup_access_revoked', 'Backup access is unavailable.', 403);
          if (tail) this.push(tail);
          callback();
        }).catch(callback);
      } });
      await pipeline(source.handle.createReadStream({ autoClose: false, start: 0 }), guard, response);
      notify('complete', { bytes: source.row.bytes });
    } catch (error) {
      outcome = ['backup_access_revoked', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error?.code) ? 'cancelled' : 'failed';
      if (source) notify(['backup_access_revoked', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error?.code) ? 'cancelled' : 'failed',
        { errorCode: 'backup_failed' });
      if (response.headersSent) { response.destroy(); return; }
      throw error;
    } finally {
      try { await source?.release(); } catch (error) { outcome = 'failed'; throw error; }
      finally { operation.finish(outcome, { reason: outcome === 'completed' ? null : outcome === 'cancelled' ? 'cancelled' : 'operation-failed' }); }
    }
  }
  return { list, start, status, download,
    health(copies) {
      const checks = copies.map(copy => checkedCopy(copy, results.get(copy.id))).filter(Boolean);
      return { scope: 'current-run', failedChecks: checks.filter(check => check.state === 'error').length,
        changedChecks: checks.filter(check => check.state === 'changed').length };
    },
    async settled() { await running; },
    async close() { closed = true; cancellation?.abort(); await running; },
  };
}
