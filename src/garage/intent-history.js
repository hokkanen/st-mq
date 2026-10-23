import { isDeepStrictEqual } from 'node:util';
import { validGarageTarget } from './room-temperature.js';

export const GARAGE_INTENT_EVENT = 'garage-intent';
export const garageIntentKey = input => `garage:intent-history:${input}`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
export function validateGarageIntent(value) {
  if (value == null) return value;
  if (!keys(value, 'adapterKey,enabled,input,selection,targetIdentity,version') || value.version !== 1
    || !['mqtt', 'providers', 'simulated', 'offline'].includes(value.input) || typeof value.enabled !== 'boolean'
    || !digest(value.adapterKey) || value.targetIdentity !== null && !digest(value.targetIdentity)
    || value.selection !== null && (!value.enabled || value.targetIdentity === null
      || !keys(value.selection, 'awayTargetC,basis,mode,normalTargetC,selectedAt')
      || !['normal', 'away'].includes(value.selection.mode)
      || !['dashboard-selection', 'adopted-readback', 'retained-intent'].includes(value.selection.basis)
      || !validGarageTarget(value.selection.normalTargetC) || !validGarageTarget(value.selection.awayTargetC)
      || !time(value.selection.selectedAt)))
    throw new TypeError('Unsupported Garage intent history. Preserve the database and start a fresh development database.');
  return value;
}

/** Immutable application intent, separate from acquisition and command readiness.
 * An absent history head begins at now; the saved choice's original clock stays
 * evidence, never authority to populate an earlier unrecorded scope. */
export function recordGarageIntent({ store, input, enabled, adapterKey, targetIdentity, selection, basis, now }) {
  if (!time(now)) throw new TypeError('Garage intent requires a UTC timestamp.');
  const key = garageIntentKey(input), previous = validateGarageIntent(store.getState(key));
  if (!previous && !enabled) return false;
  const sameRoute = previous?.adapterKey === adapterKey;
  targetIdentity ??= sameRoute ? previous.targetIdentity : selection?.targetIdentity ?? null;
  let chosen = enabled && selection?.adapterKey === adapterKey && selection.targetIdentity === targetIdentity
    && selection.changedAt <= now ? { mode: selection.mode, normalTargetC: selection.normalTargetC,
      awayTargetC: selection.awayTargetC, selectedAt: selection.changedAt } : null;
  if (chosen) {
    const { basis: savedBasis, ...saved } = previous?.selection ?? {};
    chosen.basis = basis ?? (sameRoute && previous.targetIdentity === targetIdentity && isDeepStrictEqual(saved, chosen)
      ? savedBasis : 'retained-intent');
  }
  const next = validateGarageIntent({ version: 1, input, enabled, adapterKey, targetIdentity, selection: chosen });
  if (isDeepStrictEqual(previous, next)) return false;
  store.transaction(() => {
    store.event(GARAGE_INTENT_EVENT, next, now);
    store.setState(key, next);
  });
  return true;
}
