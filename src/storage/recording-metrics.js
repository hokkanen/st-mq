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
