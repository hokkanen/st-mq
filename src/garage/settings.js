/** Owner policy and versioned engineering choices. Defaults are illustrative,
 * unapproved air-sensor limits, not a certification of pipe protection. */
export const GARAGE_POLICY_VERSION = 'garage-exposure-v2';
export const GARAGE_PREFERENCE_VERSION = 'garage-warmth-cost-v1';
export const DEFAULT_GARAGE_SETTINGS = Object.freeze({
  enabled: false, aggressiveness: 50, baselineC: 10, frontRequired: false,
  maxSensorAgeMs: 120_000, minOnMs: 30 * 60_000, minOffMs: 10 * 60_000,
  maxHorizonHours: 48, stepMinutes: 15,
  protection: Object.freeze({ approved: false, version: GARAGE_POLICY_VERSION,
    floorC: 2, hardMinimumC: -1, budgetDegreeMinutes: 90,
    recoveryAboveC: 4, recoveryDegreeMinutesPerMinute: 1, recoveryDwellMinutes: 20 }),
});
const finite = Number.isFinite;
function number(input, key, min, max) {
  if (!finite(input[key]) || input[key] < min || input[key] > max) throw new Error(`Garage ${key} must be between ${min} and ${max}`);
}
export function garageSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Garage settings must be an object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_GARAGE_SETTINGS, key)) throw new Error(`Unknown garage setting: ${key}`);
  if (input.protection != null && (typeof input.protection !== 'object' || Array.isArray(input.protection))) throw new Error('Garage protection must be an object');
  for (const key of Object.keys(input.protection ?? {})) if (!Object.hasOwn(DEFAULT_GARAGE_SETTINGS.protection, key)) throw new Error(`Unknown garage protection setting: ${key}`);
  const output = { ...DEFAULT_GARAGE_SETTINGS, ...input, protection: { ...DEFAULT_GARAGE_SETTINGS.protection, ...input.protection } };
  for (const key of ['enabled', 'frontRequired']) if (typeof output[key] !== 'boolean') throw new Error(`Garage ${key} must be boolean`);
  number(output, 'aggressiveness', 0, 100); number(output, 'baselineC', 8, 16);
  number(output, 'maxSensorAgeMs', 30_000, 4 * 3_600_000);
  number(output, 'minOnMs', 0, 6 * 3_600_000); number(output, 'minOffMs', 0, 3_600_000);
  number(output, 'maxHorizonHours', 2, 48); number(output, 'stepMinutes', 5, 30);
  const policy = output.protection;
  if (typeof policy.approved !== 'boolean') throw new Error('Garage protection approval must be boolean');
  // Accept the previous configuration spelling without reinterpreting saved
  // exposure: upgradeGarageExposure separately carries its uncertain debt.
  if (policy.version === 'garage-exposure-v1') policy.version = GARAGE_POLICY_VERSION;
  if (policy.version !== GARAGE_POLICY_VERSION) throw new Error('Unsupported garage protection policy version');
  number(policy, 'floorC', 0, 12); number(policy, 'hardMinimumC', -2, 10);
  number(policy, 'budgetDegreeMinutes', 1, 10_000); number(policy, 'recoveryAboveC', 1, 16);
  number(policy, 'recoveryDegreeMinutesPerMinute', 0.001, 5); number(policy, 'recoveryDwellMinutes', 1, 240);
  if (policy.hardMinimumC >= policy.floorC || policy.recoveryAboveC <= policy.floorC)
    throw new Error('Garage protection requires hardMinimumC < floorC < recoveryAboveC');
  return output;
}
/** Stable mapping: higher aggressiveness lowers warmth cost. Never price-normalized. */
export function garageWarmthPrice(aggressiveness) {
  if (!finite(aggressiveness) || aggressiveness < 0 || aggressiveness > 100) throw new Error('Invalid garage aggressiveness');
  return aggressiveness === 0 ? Infinity : 0.012 * ((100 - aggressiveness) / 50) ** 2;
}
