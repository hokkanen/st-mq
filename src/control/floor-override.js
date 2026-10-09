import { FLOOR_PREHEAT_DEVICE, FLOOR_PREHEAT_CIRCUITS } from '../domain/floor-circuits.js';

const KEY = 'floor-override:v1';
const UNSUPPORTED = 'A supported floor-control integration is not available. Keep floor preheating disabled and uncommissioned.';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function floorOverrideConfiguration(options = {}) {
  if (!plain(options)) throw new Error('Floor override configuration must be an object.');
  const fields = new Set(['enabled', 'commissioned', 'renew_seconds', 'lease_seconds']);
  if (Object.keys(options).some(key => !fields.has(key))) throw new Error('Unsupported floor override configuration field.');
  for (const key of ['enabled', 'commissioned'])
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Floor override flags must be booleans.');
  if (options.enabled === true || options.commissioned === true) throw new Error(UNSUPPORTED);
  const renewSeconds = options.renew_seconds === undefined ? 300 : options.renew_seconds;
  const leaseSeconds = options.lease_seconds === undefined ? 900 : options.lease_seconds;
  if (!Number.isInteger(renewSeconds) || renewSeconds < 30 || !Number.isInteger(leaseSeconds)
      || leaseSeconds > 900 || leaseSeconds < renewSeconds * 2)
    throw new Error('Floor renewal must be at least 30 seconds and allow two renewals within a lease of at most 900 seconds.');
  return { enabled: false, commissioned: false, integrationSupported: false,
    renewSeconds, leaseSeconds, devices: [{ ...FLOOR_PREHEAT_DEVICE, channels: FLOOR_PREHEAT_CIRCUITS.map(({ id }) => id) }] };
}

export function floorOverrideStatus(settings = floorOverrideConfiguration(), { restorationPending = false, stateUnknown = false } = {}) {
  return { enabled: false, commissioned: false, integrationSupported: false, configured: false,
    connected: false, available: false, active: false, owner: null, leaseUntil: null,
    renewSeconds: settings.renewSeconds, leaseSeconds: settings.leaseSeconds,
    restorationPending, stateUnknown, reason: 'integration-unavailable',
    devices: [{ ...FLOOR_PREHEAT_DEVICE, available: false, at: null,
      channels: FLOOR_PREHEAT_CIRCUITS.map(circuit => ({ ...circuit, output: null })) }],
    lastResult: restorationPending ? { status: 'release-pending', reason: 'integration-unavailable' } : null,
    lastLeaseEnd: null };
}

export function floorOverrideObligation(store) {
  let saved;
  try { saved = store.getState(KEY); }
  catch { return { restorationPending: true, stateUnknown: true }; }
  const stateUnknown = saved != null && (!plain(saved) || saved.version !== 1
    || !Object.hasOwn(saved, 'outstanding') || saved.outstanding !== null && !plain(saved.outstanding));
  return { restorationPending: stateUnknown || saved != null && saved.outstanding !== null, stateUnknown };
}

// The hardware plan does not specify SONOFF firmware or a control protocol.
// Expose that limitation without sending the retired device protocol or treating
// old readback as evidence for this device. A stored physical obligation remains
// untouched until its actual equipment can be checked and released explicitly.
export function createFloorOverride({ store, settings = floorOverrideConfiguration() }) {
  if (!store?.getState || !store?.setState) throw new Error('Floor override requires durable state.');
  let closed = false;
  const obligation = () => floorOverrideObligation(store);
  const release = async () => {
    const { restorationPending } = obligation();
    return { status: restorationPending ? 'release-pending' : 'released', released: !restorationPending,
      restorationPending, ...(restorationPending ? { reason: 'integration-unavailable' } : {}) };
  };
  return {
    get topics() { return []; },
    setConnected() {},
    ingest() { return false; },
    status() { return floorOverrideStatus(settings, obligation()); },
    async lease() {
      const code = closed ? 'FLOOR_CLOSED' : obligation().restorationPending ? 'FLOOR_PENDING' : 'FLOOR_UNSUPPORTED';
      throw Object.assign(new Error(code === 'FLOOR_PENDING' ? 'A previous floor override release remains unconfirmed.' : UNSUPPORTED), { code });
    },
    finishLease: release,
    release,
    async tick() { return floorOverrideStatus(settings, obligation()); },
    async close() { closed = true; },
  };
}
