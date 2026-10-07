const failure = (code, message) => Object.assign(new Error(message), { code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const H66_SETTING_LIMITS = Object.freeze({
  '0203': Object.freeze([5, 35]), '0212': Object.freeze([30, 55]),
  '0208': Object.freeze([50, 65]), '2201': Object.freeze([0, 4]),
});
const h66Value = (index, value) => Object.hasOwn(H66_SETTING_LIMITS, index) && Number.isFinite(value)
  && value >= H66_SETTING_LIMITS[index][0] && value <= H66_SETTING_LIMITS[index][1]
  && (index !== '2201' || Number.isInteger(value));
const h66Map = value => record(value) && Object.entries(value).every(([index, setting]) => h66Value(index, setting));
const h66Obligation = (index, value, saved) => record(value)
  && Object.keys(value).every(key => ['baseline', 'expected', 'previousValue', 'originalAt', 'requestedAt',
    'requestedRevision', 'confirmed', 'restoring', 'confirmedAt'].includes(key))
  && ['baseline', 'expected', 'previousValue'].every(key => h66Value(index, value[key]))
  && saved.baseline[index] === value.baseline && saved.requested[index] === value.expected
  && Number.isFinite(value.originalAt) && Number.isFinite(value.requestedAt)
  && Number.isSafeInteger(value.requestedRevision) && value.requestedRevision >= -1
  && typeof value.confirmed === 'boolean' && typeof value.restoring === 'boolean'
  && (!Object.hasOwn(value, 'confirmedAt') || Number.isFinite(value.confirmedAt))
  && (!value.confirmed || Number.isFinite(value.confirmedAt));

/** Current durable physical obligations only. Validation never translates,
 * clears or grants authority from unsupported saved control state. */
const executorFields = (value, fields) => record(value) && Object.keys(value).every(key => fields.includes(key));
const executorDeadline = value => value === null || Number.isFinite(value);
const executorBinding = value => executorFields(value, ['identity', 'generation'])
  && typeof value.identity === 'string' && /^[a-f0-9]{64}$/.test(value.identity)
  && typeof value.generation === 'string' && value.generation.length > 0;
const executorBaseline = value => executorFields(value, ['phase', 'expiresAt', 'legacyOutstanding', 'at'])
  && value.phase === 'normal' && value.expiresAt === null && value.legacyOutstanding === false && Number.isFinite(value.at);
const executorPause = value => executorFields(value, ['id', 'expiresAt'])
  && typeof value.id === 'string' && value.id.length > 0 && executorDeadline(value.expiresAt);
const executorTemporary = value => executorFields(value, ['expiresAt']) && Number.isFinite(value.expiresAt);
const executorChoice = value => executorFields(value, ['phase', 'at', 'expiresAt', 'confirmed', 'floorOwner', 'roomBoostC'])
  && ['normal', 'reduction', 'preheat'].includes(value.phase) && Number.isFinite(value.at)
  && typeof value.confirmed === 'boolean' && executorDeadline(value.expiresAt)
  && Number.isFinite(value.roomBoostC) && value.roomBoostC >= 0
  && (value.floorOwner == null || typeof value.floorOwner === 'string' && value.floorOwner.length > 0)
  && (value.phase !== 'preheat' || Number.isFinite(value.expiresAt) && typeof value.floorOwner === 'string')
  && (value.phase === 'preheat' || value.roomBoostC === 0);

export function validateExecutorState(saved) {
  if (saved != null && (!record(saved) || saved.version !== 2 || !record(saved.targetBindings)
    || Object.entries(saved.targetBindings).some(([kind, binding]) => !['tariff', 'dhwr'].includes(kind) || !executorBinding(binding))
    || typeof saved.legacyOutstanding !== 'boolean'
    || Object.hasOwn(saved, 'dhwrOutstanding') && typeof saved.dhwrOutstanding !== 'boolean'
    || !Number.isFinite(saved.pulseUntil) || saved.pulseUntil < 0 || !executorDeadline(saved.expiresAt)
    || !['normal', 'recovery', 'preheat', 'reduction', 'restoration-pending'].includes(saved.phase)
    || saved.dhwrOutstanding && !saved.targetBindings.dhwr
    || saved.legacyOutstanding && !saved.targetBindings.tariff
    || saved.manualBaseline != null && !executorBaseline(saved.manualBaseline)
    || saved.manualPause != null && !executorPause(saved.manualPause)
    || saved.manualTemporary != null && !executorTemporary(saved.manualTemporary)
    || saved.manualRequested != null && !executorChoice(saved.manualRequested)
    || (saved.manualPause != null || saved.manualTemporary != null || saved.manualRequested != null) && !saved.manualBaseline
    || saved.manualBaseline && Boolean(saved.manualPause) === Boolean(saved.manualTemporary)
    || saved.manualRequested?.phase === 'reduction' && saved.manualRequested.confirmed
      && (!saved.legacyOutstanding || !saved.targetBindings.tariff)))
    throw failure('EXECUTOR_STATE_UNSUPPORTED', 'Unsupported heating state. Safely stop existing equipment, then start with a fresh development database.');
}

export function validateH66ControlState(saved) {
  if (saved != null && (!record(saved) || saved.version !== 1 || !h66Map(saved.baseline) || !h66Map(saved.requested)
    || !record(saved.obligations) || Object.entries(saved.obligations).some(([index, value]) => !h66Obligation(index, value, saved))
    || Object.keys(saved.obligations).length > 0 && !(saved.expiresAt === null || Number.isFinite(saved.expiresAt))
    || ['manual-pause', 'manual-temporary'].includes(saved.phase)))
    throw failure('H66_STATE_UNSUPPORTED', 'Unsupported native-setting state. Start with a fresh development database after safely restoring equipment.');
}
