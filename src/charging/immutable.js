// Only values owned and recursively frozen here may bypass a copy. A shallow
// Object.freeze(), including a frozen Map/Date, cannot establish that ownership.
const immutable = new WeakSet();
const native = Symbol('native structured clone required');
const plain = value => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
  || Object.getPrototypeOf(value) === null;

/** Detach mutable charging state while reusing owned immutable calculations.
 * Built-in structured values keep native clone semantics, including aliases
 * across the whole graph; they are never admitted as shared calculations. */
export function copyChargingValue(value) {
  const seen = new Map();
  const copy = value => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') throw native;
      return value;
    }
    if (immutable.has(value)) return value;
    if (seen.has(value)) return seen.get(value);
    if (!plain(value)) throw native;
    const result = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: copy(value[key]), enumerable: true, writable: true, configurable: true,
    });
    return result;
  };
  try { return copy(value); }
  catch (error) {
    if (error !== native) throw error;
    return structuredClone(value);
  }
}

/** Take an independent calculation snapshot once, then make its entire plain
 * record/array graph immutable. Existing owned subtrees retain their identity.
 * This is an in-memory ownership rule, never a persisted representation. */
export function immutableChargingValue(value) {
  if (value === null || typeof value !== 'object' || immutable.has(value)) return value;
  const owned = copyChargingValue(value), pending = [], seen = new Set();
  const check = value => {
    if (value === null || typeof value !== 'object' || immutable.has(value) || seen.has(value)) return;
    if (!plain(value)) throw new TypeError('Charging calculations require plain immutable data');
    seen.add(value); pending.push(value);
    for (const child of Object.values(value)) check(child);
  };
  check(owned);
  for (const item of pending) { Object.freeze(item); immutable.add(item); }
  return owned;
}

export const isImmutableChargingValue = value => value !== null && typeof value === 'object' && immutable.has(value);
