import { storageOperationHealth } from './operation-health.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { backupDirectory, backupLocation } from './backup-directory.js';
import { scanResetBackups } from '../pairing/reset-storage.js';
import { validateSnapshot } from '../pairing/snapshots.js';
import { DIGEST_ALGORITHM } from '../replication/publication.js';

export const DATABASE_EXPORT_NAME = /^stmq-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.sqlite$/;
const PIN_NAME = /^export-([a-f0-9-]{36})\.pin$/;
const SIDECARS = ['-wal', '-shm', '-journal'];
export const backupFingerprint = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].map(String).join(':');
const unavailable = () => Object.assign(new Error('The saved copy is unavailable or changed. Refresh the backup list and retry.'),
  { code: 'backup_copy_unavailable', statusCode: 409 });
const idFor = path => createHash('sha256').update(resolve(path)).digest('hex');

async function present(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function standalone(path) {
  const info = await present(path);
  if (!info?.isFile() || info.isSymbolicLink()) throw unavailable();
  for (const suffix of SIDECARS) if (await present(`${path}${suffix}`)) throw unavailable();
  return info;
}
async function names(directory, maxEntries, reasons, configuredBoundary = false) {
  let info;
  try { info = await present(directory); } catch { reasons.add('folder-unavailable'); return []; }
  if (!info) return [];
  if ((!info.isDirectory() && !configuredBoundary) || info.isSymbolicLink() && !configuredBoundary) {
    reasons.add('folder-unavailable'); return [];
  }
  // A configured boundary may be an installation alias. Child links never
  // become catalog entries or redirect a selected saved copy.
  let handle;
  try { handle = await opendir(directory); } catch { reasons.add('folder-unavailable'); return []; }
  const found = [];
  let examined = 0;
  for await (const entry of handle) {
    if (++examined > maxEntries) { reasons.add('entry-limit'); break; }
    found.push(entry);
  }
  return found;
}
async function metadata(copies) {
  if (!copies.length) return [];
  return new Promise((accept, reject) => {
    const worker = new Worker(new URL('./backup-catalog-worker.js', import.meta.url),
      { workerData: copies.map(({ path, fingerprint }) => ({ path, fingerprint })),
        ...(process.execArgv.some(value => value.startsWith('--input-type')) ? { execArgv: [] } : {}) });
    let result, failure;
    const timer = setTimeout(() => { failure = new Error('Backup metadata discovery timed out'); void worker.terminate(); }, 5000);
    worker.once('message', value => { result = value; });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => { clearTimeout(timer); if (failure || code !== 0 || !Array.isArray(result)) reject(failure ?? Error()); else accept(result); });
  });
}

/** One bounded inventory for health, explicit backup actions and history recovery.
 * Metadata discovery is never a current integrity or household-identity check. */
async function performBackupCatalog(config, { clock = Date.now, maxEntries = 4096, maxCopies = 100 } = {}) {
  const directory = backupDirectory(config), reasons = new Set(), candidates = [], preservedArchives = [];
  for (const entry of await names(directory, maxEntries, reasons, true)) {
    if (!DATABASE_EXPORT_NAME.test(entry.name)) continue;
    if (!entry.isFile()) { reasons.add('unavailable-copies'); continue; }
    const path = join(directory, entry.name);
    try {
      const info = await standalone(path);
      candidates.push({ id: idFor(path), path, kind: 'backup', filename: entry.name, createdAt: null,
        fileModifiedAt: info.mtimeMs, bytes: info.size, fingerprint: backupFingerprint(info),
        verification: { state: 'not-checked', at: null } });
    } catch { reasons.add('unavailable-copies'); }
  }
  try {
    const reset = await scanResetBackups(config, { maxEntries, maxCopies });
    reset.reasons.forEach(reason => reasons.add(reason));
    preservedArchives.push(...reset.preservedArchives);
    for (const copy of reset.copies) {
      const info = await standalone(copy.path);
      candidates.push({ ...copy, id: idFor(copy.path), filename: basename(copy.path), fingerprint: backupFingerprint(info) });
    }
  } catch { reasons.add('reset-folder-unavailable'); }
  // A pin can retain the only exceptional donor after rejoin. Keep that protocol
  // repository and its immutable generation metadata intact; routine rolling
  // exports never masquerade as retained backups.
  {
    const pinDirectory = join(directory, 'pair-exports');
    for (const entry of await names(pinDirectory, maxEntries, reasons)) {
      const match = PIN_NAME.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile()) { reasons.add('unavailable-protected-copies'); continue; }
      try {
        const manifest = join(pinDirectory, `export-${match[1]}.json`), manifestInfo = await present(manifest);
        if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 16 * 1024 * 1024) throw unavailable();
        const value = JSON.parse(await readFile(manifest, 'utf8'));
        validateSnapshot(value);
        if (value.generation !== match[1]) throw unavailable();
        // A master's or slave's pinned peer seed is an operational transfer,
        // released by acknowledgement. Only protected donor history has the
        // retained-copy obligation shown in this inventory.
        if (value.claim.role !== 'protected') continue;
        const path = join(pinDirectory, `export-${match[1]}.sqlite`), info = await standalone(path);
        if (info.size !== value.bytes) throw unavailable();
        candidates.push({ id: idFor(path), path, kind: 'protected', filename: basename(path), createdAt: value.sourceAt,
          fileModifiedAt: info.mtimeMs, bytes: info.size, fingerprint: backupFingerprint(info),
          verification: { state: 'not-checked', at: null }, protected: true, checkpoint: value.checkpoint,
          ...(value.digestAlgorithm === DIGEST_ALGORITHM ? { digest: value.digest } : {}) });
      } catch { reasons.add('unavailable-protected-copies'); }
    }
  }
  candidates.sort((a, b) => (b.createdAt ?? b.fileModifiedAt) - (a.createdAt ?? a.fileModifiedAt));
  if (candidates.length > maxCopies) reasons.add('copy-limit');
  const copies = candidates.slice(0, maxCopies);
  for (const copy of copies) if (copy.createdAt > clock()) {
    copy.createdAt = null;
    copy.verification = { state: 'not-checked', at: null };
    reasons.add('invalid-copy-time');
  }
  try {
    const details = await metadata(copies);
    copies.forEach((copy, index) => {
      const value = details[index];
      if (value?.changed) { copy.unavailable = true; reasons.add('changed-copies'); return; }
      if (copy.kind === 'protected') return;
      if (value?.exportedAt > clock()) { reasons.add('invalid-copy-time'); return; }
      if (value?.exportedAt !== undefined && copy.kind !== 'protected') {
        copy.createdAt = value.exportedAt;
        copy.verification = { state: 'verified-when-created', at: null };
      }
    });
  } catch { reasons.add('metadata-unavailable'); }
  const available = copies.filter(copy => !copy.unavailable).map(copy => ({ ...copy,
    label: copy.kind === 'reset' ? copy.label
      : `${copy.kind === 'protected' ? 'Protected copy' : 'Saved backup'} · ${new Date(copy.createdAt ?? copy.fileModifiedAt).toISOString()}` }));
  available.sort((a, b) => (b.createdAt ?? b.fileModifiedAt) - (a.createdAt ?? a.fileModifiedAt));
  return { directory, location: backupLocation(config), checkedAt: clock(), complete: reasons.size === 0,
    limit: maxCopies, reasons: [...reasons], preservedArchives, copies: available };
}

export function publicBackupCatalog(catalog) {
  return { ...catalog, copies: catalog.copies.map(({ path, digest, fingerprint, checkpoint, ...copy }) => copy) };
}

/** A selection never supplies a filesystem path; resolve afresh from trusted
 * configuration, then fence replacements and nonportable SQLite companions. */
export function createBackupCatalog({ getConfig, clock = Date.now, cacheMs = 300_000 } = {}) {
  storageOperationHealth.register('backup-catalog');
  let cached = null, task = null, forcedFollowup = null, generation = 0, dirty = false;
  const list = async ({ force = false } = {}) => {
    if (task) {
      if (!force) return task;
      if (forcedFollowup) return forcedFollowup;
      const pending = task;
      // Several explicit checks waiting on one scan share one fresh follow-up,
      // keeping metadata discovery to one worker even under concurrent requests.
      forcedFollowup = (async () => { await pending; return list({ force: true }); })();
      try { return await forcedFollowup; } finally { forcedFollowup = null; }
    }
    const config = getConfig();
    const key = JSON.stringify([backupDirectory(config), config.pair?.directory ?? null, backupLocation(config)]);
    if (!force && !dirty && cached && cached.key === key
      && clock() - (cached.value.lastAttemptAt ?? cached.value.checkedAt) < cacheMs) return cached.value;
    const current = generation;
    task = listBackupCatalog(config, { clock }).then(value => {
      if (cached?.key === key && cached.value.copies.length && !value.copies.length
        && value.reasons.some(reason => reason.includes('unavailable'))) {
        value = { ...cached.value, complete: false, stale: true, lastAttemptAt: value.checkedAt, reasons: value.reasons };
      }
      if (current === generation) { cached = { key, value }; dirty = false; }
      return value;
    });
    try { return await task; } finally { task = null; }
  };
  return {
    list,
    invalidate() { generation++; dirty = true; },
    async resolve(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw unavailable();
      const catalog = await list({ force: true });
      if (catalog.stale) throw unavailable();
      const row = catalog.copies.find(copy => copy.id === id);
      if (!row) throw unavailable();
      const info = await standalone(row.path);
      if (backupFingerprint(info) !== row.fingerprint) throw unavailable();
      return row;
    },
    async open(id) {
      const row = await this.resolve(id);
      const handle = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(100), { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0'
          || header[18] !== 1 || header[19] !== 1) throw unavailable();
        const assertCurrent = async () => {
          if (backupFingerprint(await handle.stat()) !== row.fingerprint
            || backupFingerprint(await standalone(row.path)) !== row.fingerprint) throw unavailable();
        };
        await assertCurrent();
        return { handle, row, assertCurrent, release: () => handle.close() };
      } catch (error) { await handle.close(); throw error; }
    },
  };
}

export async function listBackupCatalog(...args) {
  const operation = storageOperationHealth.begin('backup-catalog', { scope: 'shared' });
  try {
    const result = await performBackupCatalog(...args);
    operation.finish(result.complete ? 'completed' : 'unconfirmed', { reason: result.complete ? null : 'operation-failed' });
    return result;
  } catch (error) { operation.finish('failed', { reason: 'operation-failed' }); throw error; }
}
