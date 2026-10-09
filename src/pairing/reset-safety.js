import { DatabaseSync } from 'node:sqlite';
import { validateCurrentDatabaseFormat } from '../storage/store.js';
import { floorOverrideObligation } from '../control/floor-override.js';
import { validateExecutorState, validateH66ControlState } from '../domain/heating-control-state.js';
import { validateEquipmentTestState } from '../domain/equipment-test-state.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inspect only the current contract. An obsolete database is never decoded. */
export function resetRestorationStatus(path) {
  if (!path) return 'clear';
  let db;
  let unknown = false;
  try {
    // Runtime startup rejects any unsupported control state. Restoration
    // inventory instead inspects each current record independently so a broken
    // record cannot hide a readable physical duty elsewhere. This handle is
    // read-only and never constructs an engine or grants command authority.
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
    validateCurrentDatabaseFormat(db);
    const stateQuery = db.prepare('SELECT value FROM state WHERE key=?');
    const store = { getState(key) {
      const row = stateQuery.get(key);
      return row ? JSON.parse(row.value) : null;
    } };
    // A malformed record does not erase independent, readable obligations.
    const readState = key => {
      try { return store.getState(key); }
      catch { unknown = true; return null; }
    };
    const executor = readState('executor:home');
    if (executor != null) {
      try {
        validateExecutorState(executor);
        if (['legacyOutstanding', 'dhwrOutstanding', 'manualPause', 'manualTemporary', 'manualBaseline', 'manualRequested']
          .some(key => Boolean(executor[key]))) return 'pending';
      } catch { unknown = true; }
    }
    for (const { value } of db.prepare("SELECT value FROM state WHERE key GLOB 'h66:control:*'").iterate()) {
      let native;
      try { native = JSON.parse(value); validateH66ControlState(native); } catch { unknown = true; continue; }
      if (native != null && (Object.keys(native.obligations).length || native.manualMode)) return 'pending';
    }
    const tests = readState('equipment-tests:v1');
    try {
      validateEquipmentTestState(tests);
      if (tests?.active) return 'pending';
    } catch { unknown = true; }
    // Identification temporarily changes charging and may require resuming the
    // previous instruction. Ordinary charger ownership is not such a lease.
    for (const { key, value } of db.prepare("SELECT key,value FROM state WHERE key GLOB 'charging:*:ownership*'").iterate()) {
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
  finally { db?.close(); }
}
