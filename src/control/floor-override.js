import { createHash, randomUUID } from 'node:crypto';

const KEY = 'floor-override:v1';
const PROTOCOL = 'stmq-floor-v1';
const fail = code => Object.assign(new Error({
  FLOOR_DISABLED: 'Floor override is disabled or has not been commissioned.',
  FLOOR_UNAVAILABLE: 'Both floor devices need fresh, safe local-script readback.',
  FLOOR_TIMEOUT: 'Floor relay readback timed out; release remains pending.',
  FLOOR_CANCELLED: 'Floor override was cancelled or superseded.',
  FLOOR_PENDING: 'Previous floor override release is still pending.',
  FLOOR_READBACK: 'Floor override readback did not confirm every output.',
  FLOOR_CLOSED: 'Floor override transport is closed.',
}[code] || 'Floor override command failed; release remains pending.'), { code });
const clone = value => structuredClone(value);
const topic = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && value.trim() === value && !/[+#\u0000\s%?]/.test(value) && !value.startsWith('/') && !value.endsWith('/');

export function floorOverrideConfiguration(options = {}) {
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain(options)) throw new Error('Floor override configuration must be an object.');
  for (const key of ['enabled', 'commissioned'])
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Floor override flags must be booleans.');
  for (const key of ['storage', 'living'])
    if (options[key] !== undefined && !plain(options[key])) throw new Error('Floor device mappings must be objects.');
  const enabled = options.enabled === true;
  const commissioned = options.commissioned === true;
  const renewSeconds = options.renew_seconds === undefined ? 300 : options.renew_seconds;
  const leaseSeconds = options.lease_seconds === undefined ? 900 : options.lease_seconds;
  if (!Number.isInteger(renewSeconds) || renewSeconds < 30 || !Number.isInteger(leaseSeconds)
      || leaseSeconds > 900 || leaseSeconds < renewSeconds * 2)
    throw new Error('Floor renewal must be at least 30 seconds and allow two renewals within a lease of at most 900 seconds.');
  const devices = ['storage', 'living'].flatMap(group => {
    const prefix = options[group]?.topic_prefix;
    if (prefix == null || prefix === '') {
      if (enabled) throw new Error('Both floor device topic prefixes are required when enabled.');
      return [];
    }
    if (!topic(prefix)) throw new Error('Floor devices require exact MQTT topic prefixes.');
    return [{ group, topicPrefix: prefix, channels: [0, 1] }];
  });
  if (devices.length === 2 && (devices[0].topicPrefix === devices[1].topicPrefix
      || devices[0].topicPrefix.startsWith(`${devices[1].topicPrefix}/`)
      || devices[1].topicPrefix.startsWith(`${devices[0].topicPrefix}/`)))
    throw new Error('Floor devices must have distinct, non-overlapping topic prefixes.');
  return { enabled, commissioned, renewSeconds, leaseSeconds, devices };
}

// Local-script acknowledgements are actual relay readback, never proof of valve
// movement or hydronic flow. The caller owns the decision to renew preheating.
export function createFloorOverride({ store, publish, settings = floorOverrideConfiguration(),
  clock = Date.now, canControl = () => true, readbackTimeoutMs = 10_000, brokerIdentity = null }) {
  if (!store?.getState || !store?.setState || typeof publish !== 'function')
    throw new Error('Floor override requires durable state and MQTT transport.');
  if (!Number.isFinite(readbackTimeoutMs) || readbackTimeoutMs <= 0) throw new Error('Invalid floor readback timeout.');
  if (brokerIdentity !== null && (typeof brokerIdentity?.address !== 'string' || !brokerIdentity.address.trim()
      || brokerIdentity.username != null && typeof brokerIdentity.username !== 'string'))
    throw new Error('Floor override requires a valid broker identity.');
  // Persist only a digest. Password rotation does not change device ownership;
  // a different endpoint or account does. A missing old scope is never guessed.
  const brokerDigest = brokerIdentity === null ? null : createHash('sha256')
    .update('stmq-floor-broker-v1\0').update(JSON.stringify({ address: brokerIdentity.address, username: brokerIdentity.username ?? '' })).digest('hex');
  const saved = store.getState(KEY);
  const state = saved?.version === 1 ? clone(saved) : { version: 1, sequence: 0, outstanding: null, lastResult: null };
  let connected = false, closed = false, epoch = 0, queue = Promise.resolve(), active = null;
  let lastProbe = -Infinity, restartPending = Boolean(state.outstanding);
  const readings = new Map(), requests = new Map();
  const brokerMatches = () => !state.outstanding || Object.hasOwn(state.outstanding, 'brokerDigest') && state.outstanding.brokerDigest === brokerDigest;
  const allDevices = () => [...new Map([...settings.devices, ...(brokerMatches() ? state.outstanding?.devices || [] : [])]
    .map(device => [device.topicPrefix, device])).values()];
  const persist = () => store.setState(KEY, clone(state));
  const nextSequence = () => { state.sequence = Math.max(state.sequence || 0, ...[...readings.values()].map(row => row.sequence || 0)) + 1; persist(); return state.sequence; };
  const enqueue = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const configured = () => settings.enabled && settings.commissioned && settings.devices.length === 2;
  const fresh = (device, now) => {
    const row = readings.get(device.topicPrefix);
    return connected && row && now >= row.receivedAt && now - row.receivedAt <= 90_000 && row.ready && row.clockOk
      && Number.isSafeInteger(row.boot) && row.boot > 0 && row.channels?.length === 2
      && row.channels.every((channel, id) => channel.id === id && typeof channel.output === 'boolean' && !channel.error);
  };
  function cancelRequests() {
    for (const request of [...requests.values()]) request.finish(fail('FLOOR_CANCELLED'));
  }
  function request(device, command, wanted = null) {
    if (!brokerMatches()) return Promise.reject(fail('FLOOR_PENDING'));
    if (!connected) return Promise.reject(fail('FLOOR_UNAVAILABLE'));
    const requestId = randomUUID();
    const message = { protocol: PROTOCOL, requestId, ...command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(fail('FLOOR_TIMEOUT')), readbackTimeoutMs);
      function finish(error, response) {
        if (!requests.has(requestId)) return;
        requests.delete(requestId); clearTimeout(timer);
        if (error) reject(error); else resolve(response);
      }
      requests.set(requestId, { device, message, wanted, finish });
      Promise.resolve().then(() => { if (requests.has(requestId)) return publish(`${device.topicPrefix}/stmq/floor/command`, JSON.stringify(message), { qos: 1, retain: false }); })
        .catch(() => finish(fail('FLOOR_UNAVAILABLE')));
    });
  }
  async function probe(now = clock()) {
    if (!connected || closed || !brokerMatches()) return;
    lastProbe = now;
    await Promise.allSettled(allDevices().map(device => request(device, { action: 'probe' })));
  }
  async function releaseInternal(reason, now = clock()) {
    active = null;
    if (closed) return { status: 'closed', released: !state.outstanding, restorationPending: Boolean(state.outstanding) };
    if (!state.outstanding) return { status: 'released', released: true, restorationPending: false };
    if (!brokerMatches()) {
      state.lastResult = { status: 'release-pending', reason: 'broker-identity-mismatch', at: now };
      persist();
      return { ...state.lastResult, released: false, restorationPending: true };
    }
    state.outstanding.reason = reason;
    const sequence = nextSequence();
    const results = await Promise.allSettled(state.outstanding.devices.map(device => request(device,
      { action: 'release', sequence, issuedAt: Math.floor(now / 1000) }, false)));
    const released = results.every(result => result.status === 'fulfilled');
    if (released) { state.outstanding = null; restartPending = false; }
    state.lastResult = { status: released ? 'released' : 'release-pending', reason, at: now };
    persist();
    return { ...state.lastResult, released, restorationPending: !released };
  }
  async function leaseInternal({ owner, until, now = clock() }, leaseEpoch) {
    if (closed) throw fail('FLOOR_CLOSED');
    if (!configured()) throw fail('FLOOR_DISABLED');
    if (!canControl() || leaseEpoch !== epoch) throw fail('FLOOR_CANCELLED');
    if (!brokerMatches()) throw fail('FLOOR_PENDING');
    if (typeof owner !== 'string' || !owner || owner.length > 160 || !Number.isFinite(until) || until <= now)
      throw fail('FLOOR_CANCELLED');
    if (restartPending || (state.outstanding && state.outstanding.owner !== owner)) {
      const released = await releaseInternal('restart-or-owner-changed', now);
      if (!released.released) throw fail('FLOOR_PENDING');
    }
    if (!settings.devices.every(device => fresh(device, now))) {
      await releaseInternal('lost-readback', now); throw fail('FLOOR_UNAVAILABLE');
    }
    if (active && active.owner === owner && until === active.until && now < active.renewAt
        && now < active.leaseUntil && settings.devices.every(device => readings.get(device.topicPrefix).channels.every(channel => channel.output)))
      return { status: 'leased', confirmed: true, ...active };
    if (leaseEpoch !== epoch || !canControl()) throw fail('FLOOR_CANCELLED');
    const leaseUntil = Math.min(until, now + settings.leaseSeconds * 1000);
    state.outstanding = { owner, until, leaseUntil, brokerDigest, devices: clone(settings.devices), reason: 'leased' };
    // This synchronous durable write precedes even the first possibly delivered ON.
    const sequence = nextSequence();
    try {
      const results = await Promise.allSettled(settings.devices.map(device => request(device, {
        action: 'lease', sequence, owner, boot: readings.get(device.topicPrefix).boot,
        issuedAt: Math.floor(now / 1000), expiresAt: Math.floor(leaseUntil / 1000), until: Math.floor(until / 1000),
      }, true)));
      if (results.some(result => result.status === 'rejected')) throw fail('FLOOR_READBACK');
      if (leaseEpoch !== epoch || !canControl()) throw fail('FLOOR_CANCELLED');
      active = { owner, until, leaseUntil, renewAt: now + settings.renewSeconds * 1000 };
      state.lastResult = { status: 'leased', at: clock(), confirmed: true }; persist();
      return { ...state.lastResult, ...active };
    } catch (error) {
      await releaseInternal('partial-or-failed-activation', clock());
      throw error;
    }
  }
  const api = {
    get topics() { return allDevices().flatMap(device => [`${device.topicPrefix}/stmq/floor/status`, `${device.topicPrefix}/online`]); },
    setConnected(value) {
      connected = value === true; readings.clear();
      if (!connected) { epoch++; cancelRequests(); active = null; }
      else if (!closed) { void probe(); if (state.outstanding) { restartPending = true; void enqueue(() => releaseInternal('broker-reconnected')); } }
    },
    ingest(topicName, payload, packet = {}, now = clock()) {
      if (packet.retain || packet.dup || closed) return false;
      const device = allDevices().find(row => topicName === `${row.topicPrefix}/stmq/floor/status` || topicName === `${row.topicPrefix}/online`);
      if (!device) return false;
      if (topicName.endsWith('/online')) {
        if (String(payload) === 'false') { readings.delete(device.topicPrefix); epoch++; cancelRequests(); active = null;
          if (state.outstanding) void enqueue(() => releaseInternal('device-offline', now)); }
        return true;
      }
      let row; try { row = JSON.parse(String(payload)); } catch { return false; }
      const pending = requests.get(row.requestId);
      if (!pending || pending.device.topicPrefix !== device.topicPrefix || row.protocol !== PROTOCOL) return false;
      if ((pending.wanted !== false && (typeof row.at !== 'number' || Math.abs(now / 1000 - row.at) > 30)) || !Number.isSafeInteger(row.boot)) {
        pending.finish(fail('FLOOR_READBACK')); return false;
      }
      const previous = readings.get(device.topicPrefix);
      readings.set(device.topicPrefix, { ...row, receivedAt: now });
      if (previous?.boot !== undefined && previous.boot !== row.boot && state.outstanding) {
        epoch++; active = null; restartPending = true;
      }
      let error = null;
      if (pending.wanted !== null && (row.sequence !== pending.message.sequence || row.channels?.length !== 2
          || row.channels.some((channel, id) => channel.id !== id || channel.output !== pending.wanted || channel.error)
          || (pending.wanted && (!row.ready || !row.clockOk || row.owner !== pending.message.owner
            || row.expiresAt !== pending.message.expiresAt)))) error = fail('FLOOR_READBACK');
      pending.finish(error, row);
      if (active && (!row.ready || !row.clockOk || row.channels?.length !== 2 || row.channels.some(channel => !channel.output || channel.error))) {
        epoch++; active = null; void enqueue(() => releaseInternal('lost-output-readback', now));
      }
      return true;
    },
    status(now = clock()) {
      const devices = settings.devices.map(device => {
        const row = readings.get(device.topicPrefix);
        return { group: device.group, model: 'Shelly Pro 2 v0', available: Boolean(fresh(device, now)),
          boot: row?.boot ?? null, at: row?.receivedAt ?? null,
          channels: [0, 1].map(id => ({ id, output: fresh(device, now) ? row.channels[id].output : null })) };
      });
      const confirmedActive = Boolean(active) && now < active.leaseUntil && now < active.until
        && devices.every(device => device.available && device.channels.every(channel => channel.output));
      return { enabled: settings.enabled, commissioned: settings.commissioned, connected,
        available: configured() && brokerMatches() && devices.every(device => device.available),
        brokerMismatch: !brokerMatches(),
        active: confirmedActive,
        owner: active?.owner ?? null, leaseUntil: active?.leaseUntil ?? null,
        renewSeconds: settings.renewSeconds, leaseSeconds: settings.leaseSeconds,
        restorationPending: Boolean(state.outstanding && !confirmedActive), devices, lastResult: clone(state.lastResult) };
    },
    lease(options) { const leaseEpoch = epoch; return enqueue(() => leaseInternal(options, leaseEpoch)); },
    release({ reason = 'preheat-ended', now = clock() } = {}) {
      epoch++; cancelRequests(); active = null;
      return enqueue(() => releaseInternal(reason, now));
    },
    async tick(now = clock()) {
      if (closed) return api.status(now);
      if (state.outstanding && (!active || !canControl() || now >= active.leaseUntil || now >= active.until
          || !settings.devices.every(device => fresh(device, now))))
        await api.release({ reason: 'expired-or-unavailable', now });
      if (connected && now - lastProbe >= 30_000) await probe(now);
      return api.status(now);
    },
    async close({ restore = true } = {}) {
      if (closed) return;
      if (restore) await api.release({ reason: 'shutdown' });
      else { epoch++; active = null; }
      closed = true; cancelRequests();
    },
  };
  return api;
}
