export const STORAGE_METRICS_KEY = 'recorder:storage-metrics:v1';
const HOUR = 3_600_000, WEEK = 7 * 24 * HOUR;
export const initialStorageMetrics = (now, bytes) => ({ version: 1, startedAt: now, measuredAt: now,
  measuredBytes: bytes, bytesPerDay: 0, bytesPerDay7d: 0, measuredHours: 0,
  metricsPrunedBefore: Math.floor(now / HOUR) * HOUR - WEEK, energyRevision: 0 });
const keys = Object.keys(initialStorageMetrics(0, 0));
const timestamp = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
const unsupported = () => Object.assign(new Error('Unsupported recording storage metrics; use an intact current-version backup or a fresh development database. The existing database was not changed.'),
  { code: 'RECORDING_STORAGE_METRICS_UNSUPPORTED' });

/** Current total-allocation diagnostics, independent of adaptive precision. */
export function validateStorageMetrics(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1
    || Object.keys(saved).length !== keys.length || keys.some(key => !Object.hasOwn(saved, key))
    || keys.some(key => !Number.isFinite(saved[key]))
    || ['measuredBytes','bytesPerDay','bytesPerDay7d','measuredHours','energyRevision'].some(key => saved[key] < 0)
    || !Number.isSafeInteger(saved.measuredBytes) || !Number.isSafeInteger(saved.energyRevision)
    || ![saved.startedAt,saved.measuredAt,saved.metricsPrunedBefore].every(timestamp)
    || saved.measuredAt < saved.startedAt) throw unsupported();
  return saved;
}

export function readStorageMetrics(db) {
  const row = db.prepare('SELECT value FROM state WHERE key=?').get(STORAGE_METRICS_KEY);
  if (!row) return null;
  let saved;
  try { saved = JSON.parse(row.value); }
  catch { throw unsupported(); }
  return validateStorageMetrics(saved);
}

const currentTables = new Set(['state', 'learning_epochs', 'history_selection', 'recovery_exclusions',
  'recorder_metrics', 'recovery_dependencies', 'learning_checkpoints']);

/** Explicit inventory only: dbstat visits allocated b-tree pages, so this must
 * stay in the cached read-only overview worker, never on recording/control ticks.
 * Categories partition allocation and include page slack; they are not payload
 * estimates and never feed the adaptive precision controller. */
export function inspectPhysicalAllocation(db, { allocatedBytes, reusableBytes }) {
  let objects;
  try {
    objects = db.prepare(`SELECT d.name,s.type,SUM(d.pgsize) bytes FROM dbstat d
      LEFT JOIN sqlite_schema s ON s.name=d.name GROUP BY d.name,s.type`).all();
  } catch (error) {
    if (/no such (?:table|module): dbstat/.test(error?.message ?? ''))
      return { available: false, reason: 'sqlite-page-statistics-unavailable' };
    throw error;
  }
  const sizes = { observationBytes: 0, historyBytes: 0, currentBytes: 0, journalBytes: 0, peerBacklogBytes: 0,
    branchBytes: 0, indexBytes: 0, internalBytes: 0, reusableBytes };
  for (const { name, type, bytes } of objects) {
    const category = type === 'index' ? 'indexBytes' : name.startsWith('sqlite_') ? 'internalBytes'
      : name === 'observations' ? 'observationBytes'
      : name === 'journal_peer_branches' || name.startsWith('journal_peer_branch_') ? 'branchBytes'
      : ['journal_peer', 'journal_peer_changes', 'journal_peer_before'].includes(name) ? 'peerBacklogBytes'
      : name.startsWith('journal_') ? 'journalBytes'
      : currentTables.has(name) ? 'currentBytes' : 'historyBytes';
    sizes[category] += bytes;
  }
  // Header, pointer-map and other non-b-tree allocation is neither historical
  // payload nor reusable pages. Keep it in SQLite's own overhead category.
  const accounted = Object.values(sizes).reduce((sum, value) => sum + value, 0);
  sizes.internalBytes += Math.max(0, allocatedBytes - accounted);
  return { available: true, ...sizes };
}
