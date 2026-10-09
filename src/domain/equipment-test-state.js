const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const activeKeys = ['deviceId', 'on', 'previousOn', 'signature', 'requestedAt', 'until', 'status', 'confirmedAt'];
const activeState = value => fields(value, activeKeys)
  && typeof value.deviceId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.deviceId)
  && typeof value.signature === 'string' && /^[a-f0-9]{64}$/i.test(value.signature)
  && typeof value.on === 'boolean' && typeof value.previousOn === 'boolean'
  && timestamp(value.requestedAt) && timestamp(value.until)
  && ['starting', 'active', 'restoration-pending'].includes(value.status)
  && (!Object.hasOwn(value, 'confirmedAt') || timestamp(value.confirmedAt))
  && (value.status !== 'active' || timestamp(value.confirmedAt));

/** Validate current physical duties without translating or clearing them. Only
 * an explicit null active duty is idle; false, missing and malformed duties
 * must never enable another command. Diagnostic results grant no authority. */
export function validateEquipmentTestState(saved) {
  if (saved != null && (!fields(saved, ['version', 'active', 'lastResult', 'lastManual']) || saved.version !== 1
    || !(saved.active === null || activeState(saved.active))
    || ['lastResult', 'lastManual'].some(key => Object.hasOwn(saved, key) && saved[key] !== null && !record(saved[key]))))
    throw Object.assign(new Error('Unsupported equipment test state. Safely restore equipment, then use an intact current-version backup or a fresh development database.'),
      { code: 'EQUIPMENT_TEST_STATE_UNSUPPORTED' });
}
