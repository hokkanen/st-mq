/** Owner policy and versioned engineering choices. The air-driven pipe model
 * is an operational approximation, not a certified first-ice prediction. */
export const GARAGE_POLICY_VERSION = 'garage-thermal-reserve-v1';
export const GARAGE_HEAT_TRANSFER_SAFETY_FACTOR = 2;
export const GARAGE_PREFERENCE_VERSION = 'garage-protection-limited-opportunities-v2';
export const DEFAULT_GARAGE_SETTINGS = Object.freeze({
  enabled: false, aggressiveness: 50, baselineC: 10, frontRequired: false, assumeISave10C: false,
  minSavingsEur: .5, maxPausesPerDay: 1,
  maxSensorAgeMs: 120_000, minOnMs: 3 * 3_600_000, minOffMs: 3_600_000,
  stepMinutes: 15,
  protection: Object.freeze({ approved: false, version: GARAGE_POLICY_VERSION,
    marginC: 1, pipeOutsideDiameterMm: 21, pipeWallMm: 1, heatTransferWPerM2K: 20 }),
});
const finite = Number.isFinite;
const legacyPolicyKeys = ['floorC', 'hardMinimumC', 'budgetDegreeMinutes',
  'recoveryAboveC', 'recoveryDegreeMinutesPerMinute', 'recoveryDwellMinutes'];
function number(input, key, min, max) {
  if (!finite(input[key]) || input[key] < min || input[key] > max) throw new Error(`Garage ${key} must be between ${min} and ${max}`);
}
export function garageSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Garage settings must be an object');
  // Read saved owner settings without retaining retired pause/horizon ceilings.
  const { maxPauseHours: _retiredPause, maxHorizonHours: _retiredHorizon, ...current } = input;
  input = current;
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_GARAGE_SETTINGS, key)) throw new Error(`Unknown garage setting: ${key}`);
  if (input.protection != null && (typeof input.protection !== 'object' || Array.isArray(input.protection))) throw new Error('Garage protection must be an object');
  const supplied = input.protection ?? {};
  const legacy = ['garage-exposure-v1', 'garage-exposure-v2'].includes(supplied.version)
    || supplied.version == null && legacyPolicyKeys.some(key => Object.hasOwn(supplied, key));
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(DEFAULT_GARAGE_SETTINGS.protection, key)
    && !(legacy && legacyPolicyKeys.includes(key))) throw new Error(`Unknown garage protection setting: ${key}`);
  // Old configuration remains readable by the unchanged Garage learner. Its
  // degree-minute approval never authorizes the new thermal reserve policy.
  const protection = { ...DEFAULT_GARAGE_SETTINGS.protection };
  for (const key of Object.keys(protection)) if (Object.hasOwn(supplied, key)) protection[key] = supplied[key];
  if (legacy) { protection.version = GARAGE_POLICY_VERSION; protection.approved = false; }
  const output = { ...DEFAULT_GARAGE_SETTINGS, ...input, protection };
  for (const key of ['enabled', 'frontRequired', 'assumeISave10C']) if (typeof output[key] !== 'boolean') throw new Error(`Garage ${key} must be boolean`);
  number(output, 'aggressiveness', 0, 100); number(output, 'baselineC', 8, 16);
  number(output, 'minSavingsEur', 0, 100);
  number(output, 'maxPausesPerDay', 1, 4);
  if (!Number.isInteger(output.maxPausesPerDay)) throw new Error('Garage maxPausesPerDay must be a whole number');
  number(output, 'maxSensorAgeMs', 30_000, 4 * 3_600_000);
  number(output, 'minOnMs', 0, 24 * 3_600_000); number(output, 'minOffMs', 0, 3 * 3_600_000);
  number(output, 'stepMinutes', 5, 30);
  const policy = output.protection;
  if (typeof policy.approved !== 'boolean') throw new Error('Garage protection approval must be boolean');
  if (policy.version !== GARAGE_POLICY_VERSION) throw new Error('Unsupported garage protection policy version');
  number(policy, 'marginC', 0.1, 5); number(policy, 'pipeOutsideDiameterMm', 6, 100);
  number(policy, 'pipeWallMm', 0.3, 10); number(policy, 'heatTransferWPerM2K', 1, 100);
  if (policy.pipeWallMm * 2 >= policy.pipeOutsideDiameterMm)
    throw new Error('Garage pipe wall must leave a positive water diameter');
  return output;
}
