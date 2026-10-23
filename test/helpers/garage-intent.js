import { recordGarageIntent } from '../../src/garage/intent-history.js';

export function garageIntent(store, at, { input = 'providers', mode = 'normal', identity = 'a', route = 'b',
  enabled = true, selectedAt = at, normalTargetC = 10, awayTargetC = 5, basis = 'dashboard-selection' } = {}) {
  const adapterKey = route.repeat(64), targetIdentity = identity.repeat(64);
  return recordGarageIntent({ store, now: at, input, enabled, adapterKey, targetIdentity,
    selection: mode === null ? null : { adapterKey, targetIdentity, mode, normalTargetC, awayTargetC, changedAt: selectedAt }, basis });
}
