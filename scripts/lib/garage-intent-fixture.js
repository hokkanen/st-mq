import { recordGarageIntent } from '../../src/garage/intent-history.js';

/** Synthetic application intent, never a native measurement. */
export function seedGarageIntent(store, at, mode, input = 'providers') {
  const adapterKey = 'b'.repeat(64), targetIdentity = 'a'.repeat(64);
  recordGarageIntent({ store, now: at, input, enabled: true, adapterKey, targetIdentity,
    selection: mode === null ? null : { adapterKey, targetIdentity, mode,
      normalTargetC: 12, awayTargetC: 5, changedAt: at }, basis: 'dashboard-selection' });
}
