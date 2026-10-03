import { Store } from '../storage/store.js';
import { floorOverrideObligation } from '../control/floor-override.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inspect only the current contract. An obsolete database is never decoded. */
export function resetRestorationStatus(path) {
  if (!path) return 'clear';
  let store;
  let unknown = false;
  try {
    store = new Store(path, { readOnly: true });
    // A malformed record does not erase independent, readable obligations.
    const readState = key => {
      try { return store.getState(key); }
      catch { unknown = true; return null; }
    };
    const executor = readState('executor:home');
    if (executor != null) {
      if (!record(executor) || executor.version !== 2) unknown = true;
      else if (['legacyOutstanding', 'dhwrOutstanding', 'manualPause', 'manualTemporary', 'manualBaseline', 'manualRequested']
        .some(key => Boolean(executor[key]))) return 'pending';
    }
    for (const { value } of store.db.prepare("SELECT value FROM state WHERE key GLOB 'h66:control:*'").iterate()) {
      let native;
      try { native = JSON.parse(value); } catch { unknown = true; continue; }
      if (!record(native) || native.version !== 1 || !record(native.obligations)) unknown = true;
      else if (Object.keys(native.obligations).length || native.manualMode) return 'pending';
    }
    const tests = readState('equipment-tests:v1');
    if (tests != null && (!record(tests) || tests.version !== 1)) unknown = true;
    else if (tests?.active) return 'pending';
    // Identification temporarily changes charging and may require resuming the
    // previous instruction. Ordinary charger ownership is not such a lease.
    for (const { key, value } of store.db.prepare("SELECT key,value FROM state WHERE key GLOB 'charging:*:ownership*'").iterate()) {
      let owner;
      try { owner = JSON.parse(value); } catch { unknown = true; continue; }
      const scope = /^charging:(?:mqtt|providers|simulated|offline):charger([12]):[a-f0-9]{64}:ownership(:ocpp)?$/.exec(key);
      const version = scope?.[2] ? 2 : scope?.[1] === '1' ? 5 : 1;
      if (!scope || !record(owner) || owner.version !== version) unknown = true;
      else if ([owner.owned, owner.pending?.owned, owner.pending].some(item => item?.purpose === 'identification')) return 'pending';
    }
    const floor = floorOverrideObligation(store);
    if (floor.stateUnknown) unknown = true;
    else if (floor.restorationPending) return 'pending';
    return unknown ? 'unknown' : 'clear';
  } catch { return 'unknown'; }
  finally { store?.close(); }
}
