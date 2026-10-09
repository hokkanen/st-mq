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
const nonempty = value => typeof value === 'string' && value.length > 0;
const optional = (value, key, valid) => !Object.hasOwn(value, key) || valid(value[key]);
const nullable = valid => value => value === null || valid(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const executorRequest = value => executorFields(value, ['commands', 'at']) && Number.isFinite(value.at)
  && Array.isArray(value.commands) && value.commands.length > 0
  && value.commands.every(command => ['normal', 'reduction', 'circulation'].includes(command));
const executorDhwrRequest = value => executorFields(value, ['on', 'at']) && typeof value.on === 'boolean' && Number.isFinite(value.at);
const executorTariffRequest = value => executorFields(value, ['mode', 'at']) && ['normal', 'reduction'].includes(value.mode) && Number.isFinite(value.at);
const executorRecovery = value => executorFields(value, ['owner', 'compressorOnly', 'temperatureValidUntil', 'externalChangeRevision'])
  && (value.owner === undefined || nonempty(value.owner)) && typeof value.compressorOnly === 'boolean'
  && Number.isFinite(value.temperatureValidUntil) && revision(value.externalChangeRevision);
const executorKeys = ['version', 'targetBindings', 'phase', 'pulseUntil', 'expiresAt', 'legacyOutstanding',
  'requested', 'acknowledgedAt', 'lastResult', 'dhwrOutstanding', 'dhwrRequested', 'manualDhwrUntil',
  'tariffRequested', 'dhwrStoppedAt', 'manualBaseline', 'manualRequested', 'manualPause', 'manualTemporary',
  'manualPreheatReport', 'recoveryOwner', 'recoveryStartedAt', 'recoveryHoldUntil', 'recoveryAuxReleasedAt',
  'recoveryFallbackReason', 'recoveryOnExpiry'];
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
  if (saved != null && (!executorFields(saved, executorKeys) || saved.version !== 2 || !record(saved.targetBindings)
    || Object.entries(saved.targetBindings).some(([kind, binding]) => !['tariff', 'dhwr'].includes(kind) || !executorBinding(binding))
    || typeof saved.legacyOutstanding !== 'boolean'
    || Object.hasOwn(saved, 'dhwrOutstanding') && typeof saved.dhwrOutstanding !== 'boolean'
    || !Number.isFinite(saved.pulseUntil) || saved.pulseUntil < 0 || !executorDeadline(saved.expiresAt)
    || !['normal', 'recovery', 'preheat', 'reduction', 'restoration-pending'].includes(saved.phase)
    || saved.dhwrOutstanding && !saved.targetBindings.dhwr
    || saved.legacyOutstanding && !saved.targetBindings.tariff
    || !optional(saved, 'requested', nullable(executorRequest))
    || !optional(saved, 'dhwrRequested', nullable(executorDhwrRequest))
    || !optional(saved, 'tariffRequested', nullable(executorTariffRequest))
    || !optional(saved, 'recoveryOnExpiry', nullable(executorRecovery))
    || ['acknowledgedAt', 'manualDhwrUntil', 'dhwrStoppedAt', 'recoveryStartedAt', 'recoveryHoldUntil', 'recoveryAuxReleasedAt']
      .some(key => !optional(saved, key, executorDeadline))
    || !optional(saved, 'recoveryOwner', value => value === undefined || value === null || nonempty(value))
    || !optional(saved, 'recoveryFallbackReason', nullable(nonempty))
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

const h66Keys = ['version', 'phase', 'baseline', 'obligations', 'requested', 'expiresAt', 'lastResult',
  'lastManual', 'lastTest', 'manualMode', 'pauseId', 'manualPreheat', 'externalChangeRevision', 'externalChangeAt'];
const h66Preheat = value => executorFields(value, ['enabled', 'confirmed', 'baseValue', 'roomSettingC', 'roomBoostC', 'expiresAt', 'pauseId', 'at'])
  && value.enabled === true && value.confirmed === true && h66Value('0203', value.baseValue)
  && h66Value('0203', value.roomSettingC) && Number.isFinite(value.roomBoostC) && value.roomBoostC >= 0 && value.roomBoostC <= 5
  && value.roomSettingC === Math.min(H66_SETTING_LIMITS['0203'][1], value.baseValue + value.roomBoostC)
  && Number.isFinite(value.expiresAt) && nullable(nonempty)(value.pauseId) && Number.isFinite(value.at);

export function validateH66ControlState(saved) {
  if (saved != null && (!executorFields(saved, h66Keys) || saved.version !== 1 || !h66Map(saved.baseline) || !h66Map(saved.requested)
    || !record(saved.obligations) || Object.entries(saved.obligations).some(([index, value]) => !h66Obligation(index, value, saved))
    || !executorDeadline(saved.expiresAt)
    || !['normal', 'recovery', 'preheat', 'reduction', 'test', 'restoration-pending', 'external-change'].includes(saved.phase)
    || !optional(saved, 'manualMode', value => value === null || ['recovery', 'preheat', 'reduction'].includes(value))
    || !optional(saved, 'pauseId', nullable(nonempty))
    || !optional(saved, 'manualPreheat', nullable(h66Preheat))
    || !optional(saved, 'externalChangeRevision', revision)
    || !optional(saved, 'externalChangeAt', executorDeadline)))
    throw failure('H66_STATE_UNSUPPORTED', 'Unsupported native-setting state. Start with a fresh development database after safely restoring equipment.');
}
