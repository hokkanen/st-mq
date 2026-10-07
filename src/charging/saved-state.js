import { validateChargingRuntimeState } from './runtime-state.js';
import { readChargingDiagnosticState } from './session-diagnostics.js';
import { validateChargingPhysicalTestState } from './physical-tests.js';
import { validateChargingOwnershipState } from './controller.js';
import { validateOcppChargingOwnershipState } from './ocpp.js';
import { validateShellyAcquisitionState, validateShellyOwnershipState } from './shelly-evse.js';

/** Read-only startup/preflight gate. These are the same validators used by the
 * corresponding runtime readers, including state for inactive associations.
 * Valid persisted state remains historical intent, never fresh control evidence. */
export function validateSavedChargingState(db) {
  const runtime = /^charging:(simulated|offline|mqtt|providers)$/;
  const diagnostic = /^charging:(?:(?:simulated|offline|mqtt|providers):)?session-diagnostics$/;
  const physical = /^charging:(?:(?:simulated|offline|mqtt|providers):)?physical-tests$/;
  const ownership = /^charging:(?:simulated|offline|mqtt|providers):(charger[12]):([^:]+):ownership(:ocpp)?$/;
  for (const row of db.prepare("SELECT key,value FROM state WHERE key GLOB 'charging:*'").iterate()) {
    const native = row.key.match(ownership);
    if (!runtime.test(row.key) && !diagnostic.test(row.key) && !physical.test(row.key)
      && !row.key.startsWith('charging:shelly:') && !native) continue;
    try {
      const saved = JSON.parse(row.value);
      if (runtime.test(row.key)) validateChargingRuntimeState(saved);
      else if (diagnostic.test(row.key)) readChargingDiagnosticState(db, row.key, saved);
      else if (physical.test(row.key)) { if (saved != null) validateChargingPhysicalTestState(saved); }
      else if (row.key.startsWith('charging:shelly:'))
        validateShellyAcquisitionState(saved, row.key.slice('charging:shelly:'.length));
      else if (native[3]) validateOcppChargingOwnershipState(saved);
      else if (native[1] === 'charger2') validateShellyOwnershipState(saved, native[2]);
      else validateChargingOwnershipState(saved);
    } catch {
      // Neither private keys nor raw JSON/parser errors belong in diagnostics.
      throw Object.assign(new Error('Unsupported or unreadable saved charging state. Preserve this database and resolve outstanding equipment restoration before using an intact current-version backup or a new empty database. The existing database was not changed.'),
        { code: 'database_state_incompatible' });
    }
  }
}
