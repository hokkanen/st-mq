export const GARAGE_ROOM_MIN_C = 0;
export const GARAGE_ROOM_MAX_C = 31;
export const validGarageTarget = value => Number.isFinite(value) && value >= GARAGE_ROOM_MIN_C
  && value <= GARAGE_ROOM_MAX_C && Number.isInteger(value * 2);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const GARAGE_WARMING_WARNING = 'Surfaces and stored items may remain cold after the air warms. Avoid bringing in wet or snowy vehicles or adding substantial moisture for roughly the next 24 hours, and longer if contents remain cold.';
export function validateGarageModeState(value) {
  if (value == null) return value;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'adapterKey,awayTargetC,changedAt,mode,normalTargetC,targetIdentity,version,warmingWarning'
    || value.version !== 1 || !digest(value.adapterKey) || !digest(value.targetIdentity)
    || !['normal', 'away'].includes(value.mode) || !validGarageTarget(value.normalTargetC) || !validGarageTarget(value.awayTargetC)
    || !Number.isSafeInteger(value.changedAt) || value.changedAt < 0
    || value.warmingWarning !== null && (!object(value.warmingWarning)
      || Object.keys(value.warmingWarning).sort().join(',') !== 'fromC,message,since,toC,until'
      || value.warmingWarning.message !== GARAGE_WARMING_WARNING
      || !validGarageTarget(value.warmingWarning.fromC) || !validGarageTarget(value.warmingWarning.toC)
      || value.warmingWarning.toC <= value.warmingWarning.fromC
      || !Number.isSafeInteger(value.warmingWarning.since) || value.warmingWarning.since < 0
      || value.warmingWarning.until !== value.warmingWarning.since + 86_400_000))
    throw new Error('Unsupported saved Garage mode; start a fresh development database.');
  return value;
}
