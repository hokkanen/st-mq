export const ADAPTIVE_BUDGET_KEY = 'recorder:adaptive-budget:v1';
export const initialAdaptiveBudget = now => ({ version: 1, startedAt: now, measuredAt: now,
  estimatedBytes: 0, measuredBytes: 0, tolerance: 0.02, bytesPerDay: 0, bytesPerDay7d: 0, measuredHours: 0 });
const keys = Object.keys(initialAdaptiveBudget(0));
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const unsupported = () => Object.assign(new Error('Unsupported adaptive recording budget; use an intact current-version backup or a fresh development database. The existing database was not changed.'),
  { code: 'ADAPTIVE_RECORDING_BUDGET_UNSUPPORTED' });

/** One current state contract, shared by preflight and runtime readers. */
export function validateAdaptiveBudget(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1
    || Object.keys(saved).length !== keys.length || keys.some(key => !Object.hasOwn(saved, key))
    || keys.some(key => !Number.isFinite(saved[key]) || saved[key] < 0)
    || !timestamp(saved.startedAt) || !timestamp(saved.measuredAt) || saved.measuredAt < saved.startedAt
    || !Number.isSafeInteger(saved.estimatedBytes) || !Number.isSafeInteger(saved.measuredBytes)
    || saved.measuredBytes > saved.estimatedBytes || saved.tolerance < 1e-6 || saved.tolerance > 10)
    throw unsupported();
  return saved;
}

export function readAdaptiveBudget(db) {
  const row = db.prepare('SELECT value FROM state WHERE key=?').get(ADAPTIVE_BUDGET_KEY);
  if (!row) return null;
  let saved;
  try { saved = JSON.parse(row.value); }
  catch { throw unsupported(); }
  return validateAdaptiveBudget(saved);
}
