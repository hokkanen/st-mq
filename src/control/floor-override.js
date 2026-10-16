import { createHash, randomBytes } from 'node:crypto';
import { createControlAttempt } from '../storage/control-attempt.js';
import { FLOOR_PREHEAT_DEVICE, FLOOR_PREHEAT_CIRCUITS } from '../domain/floor-circuits.js';

const KEY = 'floor-override:v1';
export const FLOOR_MQTT_TOPICS = Object.freeze({ command: 'cmnd/sonoff4chpro/LEASE', state: 'stat/sonoff4chpro/LEASE', availability: 'tele/sonoff4chpro/LWT' });
const MAC = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const NONCE = /^[a-f0-9]{32}$/;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const UINT = 4294967295;
const MAX_AGE = 90_000;
const POLL_MS = 30_000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw failure(code, message); };

export function floorOverrideConfiguration(options = {}) {
  if (!plain(options)) throw new Error('Floor override configuration must be an object.');
  const fields = new Set(['enabled', 'commissioned', 'device_mac', 'renew_seconds', 'lease_seconds']);
  if (Object.keys(options).some(key => !fields.has(key))) throw new Error('Unsupported floor override configuration field.');
  for (const key of ['enabled', 'commissioned'])
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Floor override flags must be booleans.');
  const deviceMac = options.device_mac === undefined ? '' : options.device_mac;
  if (typeof deviceMac !== 'string' || deviceMac !== '' && !matches(MAC, deviceMac)) throw new Error('Floor device_mac must be an uppercase colon-separated MAC address.');
  if ((options.enabled || options.commissioned) && !deviceMac) throw new Error('Floor control requires the exact device_mac.');
  if (options.enabled && !options.commissioned) throw new Error('Floor automatic control requires commissioned wiring.');
  const renewSeconds = options.renew_seconds === undefined ? 300 : options.renew_seconds;
  const leaseSeconds = options.lease_seconds === undefined ? 900 : options.lease_seconds;
  if (!integer(renewSeconds, 30, 450) || !integer(leaseSeconds, renewSeconds * 2, 900))
    throw new Error('Floor renewal must be at least 30 seconds and allow two renewals within a lease of at most 900 seconds.');
  return { enabled: options.enabled === true, commissioned: options.commissioned === true, integrationSupported: true,
    deviceMac: deviceMac || null, renewSeconds, leaseSeconds,
    devices: [{ ...FLOOR_PREHEAT_DEVICE, channels: FLOOR_PREHEAT_CIRCUITS.map(({ id }) => id) }] };
}

const OUT_FIELDS = ['device', 'brokerDigest', 'generation', 'owner', 'treatment', 'seq', 'token', 'mask', 'until', 'deviceEnd', 'kind', 'key', 'phase'];
function validOutstanding(value) {
  return exact(value, OUT_FIELDS) && matches(MAC, value.device) && matches(HASH, value.brokerDigest) && matches(NONCE, value.generation)
    && matches(NAME, value.owner) && integer(value.treatment, 1, UINT) && integer(value.seq, 1, UINT)
    && (value.token === null || matches(NONCE, value.token)) && integer(value.mask, 1, 15) && integer(value.until, 1)
    && integer(value.deviceEnd, 1) && ['manual', 'automatic'].includes(value.kind)
    && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 256
    && ['acquiring', 'active', 'releasing'].includes(value.phase) && (value.phase !== 'active' || matches(NONCE, value.token));
}
function validSaved(value) {
  return exact(value, ['version', 'sequence', 'outstanding', 'retired', 'lastRequest', 'receipts']) && value.version === 2
    && integer(value.sequence, 0, UINT) && (value.outstanding === null || validOutstanding(value.outstanding) && value.sequence >= value.outstanding.treatment)
    && Array.isArray(value.retired) && value.retired.length <= 256 && value.retired.every(row => exact(row, ['key', 'until'])
      && typeof row.key === 'string' && row.key.length > 0 && row.key.length <= 256 && integer(row.until, 1))
    && Array.isArray(value.receipts) && value.receipts.length === 4 && value.receipts.every(receipt => receipt === null
      || exact(receipt, ['enabled', 'at', 'status', 'confirmed']) && typeof receipt.enabled === 'boolean' && integer(receipt.at, 1)
        && ['pending', 'confirmed', 'failed'].includes(receipt.status) && typeof receipt.confirmed === 'boolean' && receipt.confirmed === (receipt.status === 'confirmed'))
    && (value.lastRequest === null || exact(value.lastRequest, ['id', 'digest', 'channel', 'enabled', 'at', 'status', 'confirmed']) && typeof value.lastRequest.id === 'string'
      && /^[A-Za-z0-9_-]{1,80}$/.test(value.lastRequest.id) && matches(HASH, value.lastRequest.digest) && integer(value.lastRequest.channel, 1, 4)
      && typeof value.lastRequest.enabled === 'boolean' && integer(value.lastRequest.at, 1)
      && ['pending', 'confirmed', 'failed'].includes(value.lastRequest.status) && typeof value.lastRequest.confirmed === 'boolean' && value.lastRequest.confirmed === (value.lastRequest.status === 'confirmed'));
}
function readState(store) {
  try {
    const saved = store.getState(KEY);
    if (saved == null) return { state: { version: 2, sequence: 0, outstanding: null, retired: [], lastRequest: null, receipts: [null, null, null, null] }, stateUnknown: false };
    return validSaved(saved) ? { state: structuredClone(saved), stateUnknown: false } : { state: null, stateUnknown: true };
  } catch { return { state: null, stateUnknown: true }; }
}
export function floorOverrideObligation(store) {
  const { state, stateUnknown } = readState(store);
  return { restorationPending: stateUnknown || state.outstanding !== null, stateUnknown };
}
export function floorOverrideStatus(settings = floorOverrideConfiguration(), { restorationPending = false, stateUnknown = false } = {}) {
  return { enabled: settings.enabled, commissioned: settings.commissioned, integrationSupported: true, configured: Boolean(settings.deviceMac),
    connected: false, available: false, manualAvailable: false, commandScope: null, active: false, mode: null, owner: null,
    leaseUntil: null, manualUntil: null, renewSeconds: settings.renewSeconds, leaseSeconds: settings.leaseSeconds,
    restorationPending, stateUnknown, reason: stateUnknown ? 'state-invalid' : !settings.deviceMac ? 'not-configured' : 'mqtt-disconnected',
    manualReason: stateUnknown ? 'state-invalid' : !settings.deviceMac ? 'not-configured' : 'mqtt-disconnected',
    devices: [{ ...FLOOR_PREHEAT_DEVICE, deviceMac: settings.deviceMac, available: false, at: null, firmwareBuild: null, sketchMd5: null,
      stateEvidence: 'gpio_output_readback', channels: FLOOR_PREHEAT_CIRCUITS.map(circuit => ({ ...circuit, output: null,
        outputEvidence: 'gpio_output_readback', at: null, quality: ['floor-feedback-unavailable'], manualSelected: false })) }],
    lastResult: restorationPending ? { status: 'release-pending', reason: stateUnknown ? 'state-invalid' : 'mqtt-disconnected' } : null,
    manualResult: null, topics: settings.deviceMac ? [
      { role: 'Lease commands and fresh status requests', topic: FLOOR_MQTT_TOPICS.command, direction: 'publish' },
      { role: 'GPIO feedback and lease replies', topic: FLOOR_MQTT_TOPICS.state, direction: 'subscribe' },
      { role: 'Native availability', topic: FLOOR_MQTT_TOPICS.availability, direction: 'subscribe' },
    ] : [], mqttStatus: { connected: false, subscriptionStatus: 'unavailable', lastLiveAt: null }, lastLeaseEnd: null };
}

const REQUIRED = ['v', 'build', 'sketch_md5', 'kind', 'id', 'op', 'accepted', 'duplicate', 'code', 'device', 'generation', 'connected',
  'active', 'mask', 'gpio_mask', 'gpio_match', 'state_evidence', 'board_ok', 'now_ms', 'lease_until_ms', 'end_ms', 'owner', 'treatment', 'seq', 'highwater', 'reason', 'max_lease_ms'];
const CODES = new Set(['ok', 'duplicate', 'invalid-request', 'not-connected', 'wrong-generation', 'duplicate-mismatch', 'missing-challenge',
  'stale-challenge', 'invalid-token', 'wrong-owner', 'wrong-treatment', 'retired-treatment', 'stale-sequence', 'busy', 'deadline-expired',
  'end-changed', 'clock-fault', 'nonce-failure', 'retained-forbidden', 'wrong-device', 'hardware-fault', 'challenge-unavailable']);
const REASONS = new Set(['boot', 'connected', 'acquired', 'renewed', 'released', 'expired', 'disconnected', 'native-off', 'restart', 'clock-fault', 'nonce-failure']);
// The native protocol is flat, ASCII and escape-free. Validate lexical keys too:
// JSON.parse alone silently discards duplicate keys and cannot fence that input.
function decode(payload) {
  const text = String(payload);
  if (Buffer.byteLength(text) > 4096 || /[^\x20-\x7e\r\n\t]/.test(text) || text.includes('\\')) return null;
  let frame;
  try { frame = JSON.parse(text); } catch { return null; }
  if (!plain(frame)) return null;
  const keys = [...text.matchAll(/"([^"\\]*)"\s*:/g)].map(match => match[1]);
  if (new Set(keys).size !== keys.length || keys.length !== Object.keys(frame).length || REQUIRED.some(key => !Object.hasOwn(frame, key))
    || keys.some(key => !REQUIRED.includes(key) && !['token', 'challenge', 'issued_ms', 'lifetime_ms'].includes(key))) return null;
  if (frame.v !== 1 || frame.build !== 'sonoff4chpro-lease-v1' || !matches(NONCE, frame.sketch_md5) || !matches(MAC, frame.device)
    || !['reply', 'state'].includes(frame.kind) || !['get', 'challenge', 'acquire', 'renew', 'release', 'invalid', 'state'].includes(frame.op)
    || !(frame.id === '' || matches(NAME, frame.id)) || !(frame.generation === '' || matches(NONCE, frame.generation))
    || !(frame.owner === '' || matches(NAME, frame.owner)) || !CODES.has(frame.code) || !REASONS.has(frame.reason)
    || ['accepted', 'duplicate', 'connected', 'active', 'gpio_match', 'board_ok'].some(key => typeof frame[key] !== 'boolean')
    || !integer(frame.mask, 0, 15) || !integer(frame.gpio_mask, 0, 15) || frame.state_evidence !== 'gpio_output_readback'
    || ['now_ms', 'lease_until_ms', 'end_ms'].some(key => !integer(frame[key]))
    || ['treatment', 'seq', 'highwater'].some(key => !integer(frame[key], 0, UINT)) || frame.max_lease_ms !== 900000) return null;
  if (frame.active && (!frame.mask || !frame.treatment || !frame.seq || !matches(NAME, frame.owner) || !matches(NONCE, frame.generation)
      || frame.lease_until_ms <= frame.now_ms || frame.lease_until_ms > frame.end_ms)
    || !frame.active && (frame.mask !== 0 || frame.lease_until_ms !== 0)
    || frame.gpio_match !== (frame.gpio_mask === frame.mask)) return null;
  if (frame.kind === 'state' && (frame.id !== '' || frame.op !== 'state' || frame.token !== undefined || frame.challenge !== undefined)) return null;
  if (frame.token !== undefined && (!matches(NONCE, frame.token) || frame.kind !== 'reply' || frame.op !== 'acquire' || !frame.accepted || !frame.active)) return null;
  if (['challenge', 'issued_ms', 'lifetime_ms'].some(key => Object.hasOwn(frame, key))
    && (!matches(NONCE, frame.challenge) || !integer(frame.issued_ms) || frame.lifetime_ms !== 2000 || frame.kind !== 'reply'
      || frame.op !== 'challenge' || !frame.accepted || frame.issued_ms > frame.now_ms)) return null;
  return frame;
}

export function createFloorOverride({ store, settings = floorOverrideConfiguration(), publish, canControl = () => true,
  clock = () => Date.now(), monotonicClock = () => performance.now(), brokerIdentity = null, onObservation = () => {}, onLearningMode = () => {} } = {}) {
  if (!store?.getState || !store?.setState) throw new Error('Floor override requires durable state.');
  const loaded = readState(store), stateUnknown = loaded.stateUnknown;
  let saved = loaded.state, connected = false, closed = false, epoch = 0, snapshot = null, busy = false, freshnessTimer = null;
  let chain = Promise.resolve(), runtime = null, recoveryToken = null, lastPoll = -Infinity, lastResult = null, lastLeaseEnd = null, unavailableRecorded = false;
  let dispatchedAcquire = null;
  const pending = new Map(), instance = randomBytes(16).toString('hex'), controllerOwner = `stmq_${randomBytes(12).toString('hex')}`;
  const brokerDigest = hash(brokerIdentity);
  const afterCommit = effect => { if (store.afterCommit) store.afterCommit(effect); else effect(); };
  const withRequest = (state, record) => record ? { ...state, lastRequest: record, receipts: state.receipts.map((receipt, index) =>
    index === record.channel - 1 ? { enabled: record.enabled, at: record.at, status: record.status, confirmed: record.confirmed } : receipt) } : state;
  const currentIdentity = out => out?.device === settings.deviceMac && out?.brokerDigest === brokerDigest;
  const fresh = () => connected && snapshot && snapshot.epoch === epoch && monotonicClock() - snapshot.mono >= 0
    && monotonicClock() - snapshot.mono <= MAX_AGE
    && (!snapshot.frame.active || monotonicClock() < snapshot.expiryMono);
  const healthy = () => fresh() && snapshot.frame.connected && snapshot.frame.board_ok && snapshot.frame.gpio_match;
  const matchesLease = (frame, out) => out && frame?.active && frame.generation === out.generation
    && frame.owner === out.owner && frame.treatment === out.treatment && frame.mask === out.mask
    && frame.seq === out.seq && frame.end_ms === out.deviceEnd;
  const owns = frame => matchesLease(frame, saved?.outstanding) || runtime?.renewing
    && saved?.outstanding?.phase === 'acquiring' && saved.outstanding.mask === runtime.renewing.mask
    && matchesLease(frame, runtime.renewing);
  const scope = () => healthy() ? hash([instance, epoch, settings.deviceMac, snapshot.frame.generation, saved?.sequence, saved?.outstanding?.phase,
      saved?.outstanding?.mask, saved?.lastRequest?.id]) : null;
  const obligation = () => Boolean(stateUnknown || saved?.outstanding && (!runtime || saved.outstanding.phase !== 'active' && !runtime.renewing || !healthy() || !owns(snapshot.frame)));
  const serialize = operation => {
    const result = chain.then(async () => { busy = true; try { return await operation(); } finally { busy = false; } });
    chain = result.catch(() => {}); return result;
  };
  const persist = async next => {
    if (stateUnknown) fail('FLOOR_PENDING', 'Floor restoration state is unreadable or unsupported.');
    if (!validSaved(next)) fail('FLOOR_STATE', 'Floor restoration state is invalid.');
    const write = () => { if (!canControl()) fail('FLOOR_AUTHORITY', 'This instance does not own floor control.'); store.setState(KEY, next);
      if (next.outstanding?.phase === 'acquiring' && (!runtime?.renewing || !healthy()
        || !matchesLease(snapshot.frame, runtime.renewing) || runtime.renewing.mask !== next.outstanding.mask))
        onLearningMode({ mode: 'unknown', at: clock() });
    };
    if (store.runWrite) await store.runWrite(write, { isCurrent: () => !closed && canControl() }); else await write();
    saved = structuredClone(next);
  };
  const sameAcquire = (out, sent) => out && out.token === null && ['acquiring', 'releasing'].includes(out.phase)
    && ['device', 'brokerDigest', 'generation', 'owner', 'treatment', 'seq', 'mask', 'until', 'deviceEnd', 'kind', 'key']
      .every(key => out[key] === sent[key]);
  const retainReleaseCapability = frame => {
    const sent = dispatchedAcquire;
    if (!sent || closed || !connected || epoch !== sent.epoch || !canControl()
      || !sameAcquire(saved?.outstanding, sent.out) || frame.kind !== 'reply' || frame.op !== 'acquire' || frame.id !== sent.id
      || !frame.accepted || frame.duplicate || frame.code !== 'ok' || !frame.active || !frame.connected || !matches(NONCE, frame.token)
      || frame.generation !== sent.out.generation || frame.owner !== sent.out.owner || frame.treatment !== sent.out.treatment
      || frame.seq !== sent.out.seq || frame.mask !== sent.out.mask || frame.end_ms !== sent.out.deviceEnd) return;
    // A late capability is useful only to release this exact committed duty.
    // It never confirms an activation or supplies a fresh observation.
    afterCommit(() => {
      const current = readState(store);
      if (sent !== dispatchedAcquire || closed || !connected || epoch !== sent.epoch || !canControl()
        || current.stateUnknown || !currentIdentity(saved?.outstanding)
        || !sameAcquire(saved?.outstanding, sent.out) || !sameAcquire(current.state?.outstanding, sent.out)
        || snapshot && snapshot.frame.generation !== sent.out.generation) return;
      recoveryToken = { generation: sent.out.generation, treatment: sent.out.treatment, token: frame.token };
    });
  };
  const emit = (frame, at, quality = [], lifetimeMs = MAX_AGE) => {
    const mode = !frame || !frame.board_ok || !frame.gpio_match ? 'unknown' : frame.gpio_mask === 0 ? 'off'
      : saved?.outstanding?.kind === 'automatic' && owns(frame) && frame.gpio_mask === 15 ? 'on' : 'partial';
    onLearningMode({ mode, at });
    for (const channel of FLOOR_PREHEAT_CIRCUITS) onObservation({ source: 'sonoff-floor', device: settings.deviceMac,
      signal: `floor_groundfloor_${channel.id}_active`, value: frame ? Number(Boolean(frame.gpio_mask & (1 << (channel.id - 1)))) : null,
      unit: 'state', sourceTime: frame ? at : null, receivedAt: at, quality,
      raw: { usableForControl: Boolean(frame?.board_ok && frame?.gpio_match), evidence: 'gpio_output_readback', timeBasis: 'mqtt-received',
        maxAgeMs: lifetimeMs, reportIntervalMs: lifetimeMs, reportGraceMs: 0,
        ...(frame ? { generation: frame.generation, deviceMonotonicMs: frame.now_ms } : {}) } });
  };
  const withdraw = (reason, at = clock()) => {
    snapshot = null; clearTimeout(freshnessTimer); freshnessTimer = null;
    for (const request of pending.values()) request.reject(failure('FLOOR_UNCONFIRMED', 'Floor feedback is unavailable.'));
    if (runtime) runtime.releaseRequired = true;
    if (unavailableRecorded || !settings.deviceMac) return;
    unavailableRecorded = true;
    const withdrawalEpoch = epoch, current = () => canControl() && epoch === withdrawalEpoch;
    const record = () => { if (current()) emit(null, at, [reason]); };
    if (store.runWrite && !store.transactionDepth) void store.runWrite(record, { isCurrent: current }).catch(() => {}); else record();
  };
  const status = (now = clock()) => {
    const result = floorOverrideStatus(settings, { restorationPending: obligation(), stateUnknown });
    const out = saved?.outstanding, valid = fresh(), frame = valid ? snapshot.frame : null;
    const commonReason = stateUnknown ? 'state-invalid' : !settings.deviceMac ? 'not-configured'
      : !connected ? 'mqtt-disconnected' : !snapshot ? 'awaiting-readback' : !valid ? 'feedback-stale'
        : !frame.board_ok || !frame.gpio_match ? 'hardware-fault' : !canControl() ? 'authority-unavailable'
          : obligation() ? 'restoration-pending' : !settings.commissioned ? 'uncommissioned'
            : frame.active && !owns(frame) ? 'external-treatment-active' : null;
    const mode = out?.kind ?? null, manualReason = commonReason ?? (mode === 'automatic' ? 'automatic-treatment-active' : null);
    const reason = commonReason ?? (mode === 'manual' ? 'manual-treatment-active' : !settings.enabled ? 'disabled' : null);
    Object.assign(result, { mqttStatus: { connected, subscriptionStatus: connected ? 'subscribed' : 'unavailable', lastLiveAt: snapshot?.at ?? null },
      connected, available: reason === null, manualAvailable: manualReason === null, commandScope: scope(),
      active: Boolean(healthy() && runtime && mode === 'automatic' && owns(frame) && frame.mask === 15 && !obligation()), mode,
      owner: out?.key ?? null, leaseUntil: out?.until ?? null, manualUntil: mode === 'manual' ? out.until : null,
      manualResult: saved?.lastRequest ? { channel: saved.lastRequest.channel, enabled: saved.lastRequest.enabled,
        at: saved.lastRequest.at, status: saved.lastRequest.status, confirmed: saved.lastRequest.confirmed } : null,
      busy, reason: reason ?? 'ready', manualReason: manualReason ?? 'ready', lastResult: lastResult ?? result.lastResult, lastLeaseEnd });
    Object.assign(result.devices[0], { available: Boolean(healthy()), at: snapshot?.at ?? null,
      firmwareBuild: snapshot?.frame.build ?? null, sketchMd5: snapshot?.frame.sketch_md5 ?? null,
      channels: FLOOR_PREHEAT_CIRCUITS.map(channel => ({ ...channel,
        output: frame ? Boolean(frame.gpio_mask & (1 << (channel.id - 1))) : null, outputEvidence: 'gpio_output_readback', at: snapshot?.at ?? null,
        quality: frame ? frame.board_ok && frame.gpio_match ? [] : ['floor-hardware-fault'] : [snapshot ? 'floor-feedback-stale' : 'floor-feedback-unavailable'],
        lastResult: saved?.receipts[channel.id - 1] ?? null,
        manualSelected: mode === 'manual' && Boolean(out.mask & (1 << (channel.id - 1))) })) });
    return result;
  };
  const request = (op, fields = {}, { timeout = 5000, guard = () => {}, generation = null, recordingAttempt } = {}) => new Promise((resolve, reject) => {
    if (!connected || closed || !settings.deviceMac || !publish || !canControl()) { reject(failure('FLOOR_UNAVAILABLE', 'Floor MQTT control is unavailable.')); return; }
    const id = randomBytes(16).toString('hex'), connectionEpoch = epoch, cancellation = new AbortController(), deadline = monotonicClock() + timeout;
    const body = { v: 1, op, id, device: settings.deviceMac, ...fields };
    const evidence = recordingAttempt ?? createControlAttempt({ store, context: 'floor-control', kind: ['get', 'challenge'].includes(op) ? 'query' : 'mutation' });
    let dispatched = false, sentMono = null, done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); pending.delete(id); cancellation.abort(); evidence.finish();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(failure('FLOOR_UNCONFIRMED', 'Floor command or GPIO readback was not confirmed.')), timeout);
    const beforePublish = () => {
      if (done || !connected || closed || epoch !== connectionEpoch || !canControl() || monotonicClock() >= deadline)
        fail('FLOOR_AUTHORITY', 'Floor command authority changed before publication.');
      guard(); if (!dispatched) sentMono = monotonicClock(); dispatched = true;
    };
    const onFirstWrite = () => {
      evidence.dispatched();
      if (!closed && connected && epoch === connectionEpoch && canControl()
        && op === 'acquire' && dispatchedAcquire?.id !== id) {
        const out = saved?.outstanding;
        if (out?.phase === 'acquiring' && out.token === null && currentIdentity(out)
          && out.generation === fields.generation && out.owner === fields.owner && out.treatment === fields.treatment
          && out.seq === fields.seq && out.mask === fields.mask && out.deviceEnd === fields.end_ms)
          dispatchedAcquire = { id, epoch: connectionEpoch, out: structuredClone(out) };
      }
    };
    pending.set(id, { op, epoch: connectionEpoch, generation, deadline, dispatched: () => dispatched, sentMono: () => sentMono,
      resolve: value => finish(null, value), reject: error => finish(error) });
    if (Buffer.byteLength(JSON.stringify(body)) > 640) { finish(failure('FLOOR_COMMAND', 'Floor command exceeds the supported protocol.')); return; }
    Promise.resolve().then(() => publish(FLOOR_MQTT_TOPICS.command, JSON.stringify(body), { qos: 1, retain: false, noReplay: true,
      beforePublish, beforeWrite: beforePublish, onFirstWrite, signal: cancellation.signal, recordingContext: 'floor-control', recordingKind: ['get', 'challenge'].includes(op) ? 'query' : 'mutation', recordingAttempt: evidence, recordingDeadlineExpired: () => monotonicClock() >= deadline }))
      .catch(() => finish(failure('FLOOR_UNCONFIRMED', 'Floor command publication was not confirmed.')));
  });
  const refresh = async ({ allowFault = false } = {}) => {
    lastPoll = monotonicClock();
    const result = await request('get');
    if (!result.frame.accepted || !(allowFault ? fresh() && snapshot.frame.connected : healthy())) fail('FLOOR_UNAVAILABLE', 'Floor device readiness is unavailable.');
    return result;
  };
  const retire = async reason => {
    const out = saved?.outstanding;
    if (!out) return;
    const retired = saved.retired.filter(row => row.until > clock());
    if (!retired.some(row => row.key === out.key)) retired.push({ key: out.key, until: out.until });
    // A full fence is kept until its deadlines pass; never evict a live fence.
    if (retired.length > 256) fail('FLOOR_PENDING', 'Too many unfinished floor treatment fences.');
    await persist({ ...saved, outstanding: null, retired });
    runtime = null; recoveryToken = null; dispatchedAcquire = null; lastLeaseEnd = { owner: out.key, until: out.until, at: clock(), reason };
    lastResult = { status: 'released', reason, at: clock() };
  };
  const releaseInternal = async ({ reason = 'released', scope: releaseScope = 'all' } = {}) => {
    if (releaseScope === 'heating' && saved?.outstanding?.kind === 'manual') return { released: true, restorationPending: false, preservedManual: true };
    if (stateUnknown) return { status: 'release-pending', released: false, restorationPending: true, reason: 'state-invalid' };
    if (!saved.outstanding) return { status: 'released', released: true, restorationPending: false };
    if (!canControl() || !currentIdentity(saved.outstanding) || !connected || closed) return { status: 'release-pending', released: false, restorationPending: true, reason: 'identity-or-authority-unavailable' };
    runtime = null;
    try {
      await persist({ ...saved, outstanding: { ...saved.outstanding, phase: 'releasing' } }).catch(() => {});
      await refresh({ allowFault: true });
      let frame = snapshot.frame;
      if (!frame.active && frame.gpio_mask === 0 && healthy()) {
        const outcome = frame.reason === 'expired' && clock() >= saved.outstanding.until ? 'device-local' : 'unverified';
        await retire(reason); lastLeaseEnd.outcome = outcome;
        return { status: 'released', released: true, restorationPending: false, outcome };
      }
      const out = { ...saved.outstanding };
      if (!out.token && recoveryToken?.treatment === out.treatment && recoveryToken.generation === out.generation) out.token = recoveryToken.token;
      if (frame.generation !== out.generation || frame.owner !== out.owner || frame.treatment !== out.treatment || !out.token || out.seq >= UINT)
        fail('FLOOR_PENDING', 'The owned floor release needs fresh OFF readback.');
      const seq = Math.max(out.seq, frame.seq) + 1;
      if (seq > UINT) fail('FLOOR_PENDING', 'Floor sequence exhausted; waiting for local release.');
      await persist({ ...saved, outstanding: { ...out, seq } }).catch(() => {});
      const reply = await request('release', { generation: out.generation, owner: out.owner, treatment: out.treatment, seq, token: out.token },
        { generation: out.generation, guard: () => { if (!currentIdentity(saved.outstanding)) fail('FLOOR_PENDING', 'Floor equipment identity changed.'); } });
      frame = reply.frame;
      if (!healthy() || frame.active || frame.gpio_mask !== 0) fail('FLOOR_PENDING', 'Floor release has no confirmed GPIO OFF readback.');
      await retire(reason);
      const outcome = reason === 'lease-ended' ? 'fallback' : 'unverified'; lastLeaseEnd.outcome = outcome;
      return { status: 'released', released: true, restorationPending: false, outcome };
    } catch {
      lastResult = { status: 'release-pending', reason, at: clock() };
      return { status: 'release-pending', released: false, restorationPending: true, reason };
    }
  };
  const activate = async ({ kind, key, mask, until, requestRecord = null, renew = true }) => {
    if (closed) fail('FLOOR_CLOSED', 'Floor control is closed.');
    if (stateUnknown || obligation()) fail('FLOOR_PENDING', 'A previous floor release remains unconfirmed.');
    if (!healthy() || !canControl() || !settings.commissioned || kind === 'automatic' && !settings.enabled)
      fail('FLOOR_UNAVAILABLE', 'Floor control needs commissioned equipment and fresh GPIO readback.');
    const existing = saved.outstanding;
    if (existing && (existing.kind !== kind || existing.key !== key)) fail('FLOOR_BUSY', 'Another floor treatment owns the device.');
    if (existing && existing.until !== until) fail('FLOOR_EXPIRED', 'A floor treatment cannot extend its original deadline.');
    if (!integer(until, Math.floor(clock()) + 1) || typeof key !== 'string' || !key || key.length > 256)
      fail('FLOOR_EXPIRED', 'Floor control requires a future fixed deadline and treatment identity.');
    if (!existing && saved.retired.some(row => row.key === key && row.until > clock())) fail('FLOOR_EXPIRED', 'This floor treatment has already ended.');
    if (!existing && snapshot.frame.active) fail('FLOOR_BUSY', 'The floor device has another active treatment.');
    if (existing && runtime && existing.mask === mask && monotonicClock() < runtime.renewAt) return { status: 'active', active: true, confirmed: true, leaseUntil: existing.until };
    const endMono = runtime?.endMono ?? monotonicClock() + (until - clock());
    const beforeChallenge = monotonicClock();
    const challengeReply = await request('challenge', {}, { timeout: 1800 });
    const frame = challengeReply.frame, receivedMono = challengeReply.mono;
    if (!frame.accepted || !frame.challenge || !healthy() || receivedMono - beforeChallenge >= 1800 || frame.now_ms - frame.issued_ms >= 2000)
      fail('FLOOR_UNCONFIRMED', 'Floor activation challenge is unavailable or stale.');
    if (existing && (frame.generation !== existing.generation || !owns(frame))) fail('FLOOR_PENDING', 'The floor treatment lost device ownership.');
    if (!existing && frame.active) fail('FLOOR_BUSY', 'The floor device has another active treatment.');
    const remaining = Math.floor(endMono - receivedMono), deviceEnd = existing?.deviceEnd ?? frame.issued_ms + remaining;
    if (remaining <= 0 || !integer(deviceEnd, frame.now_ms + 1)) fail('FLOOR_EXPIRED', 'The floor treatment has ended.');
    const treatment = existing?.treatment ?? Math.max(saved.sequence, frame.highwater) + 1;
    const seq = existing ? existing.seq + 1 : 1;
    if (!integer(treatment, 1, UINT) || !integer(seq, 1, UINT)) fail('FLOOR_EXPIRED', 'Floor treatment sequence exhausted.');
    const out = { device: settings.deviceMac, brokerDigest, generation: frame.generation, owner: existing?.owner ?? controllerOwner,
      treatment, seq, token: existing?.token ?? null, mask, until, deviceEnd, kind, key, phase: 'acquiring' };
    // A healthy unchanged renewal keeps the current admitted grant until the
    // replacement reply commits. A changed mask remains an uncertain transition.
    if (existing && runtime && existing.mask === mask && matchesLease(snapshot.frame, existing)) runtime.renewing = { ...existing };
    const evidence = createControlAttempt({ store, context: 'floor-control' });
    evidence.storageWaiting(true);
    try {
      await persist(withRequest({ ...saved, sequence: Math.max(saved.sequence, treatment), outstanding: out,
        retired: saved.retired.filter(row => row.until > clock()) }, requestRecord));
      if (healthy() && canControl() && !closed && epoch === challengeReply.epoch && currentIdentity(saved.outstanding)
        && monotonicClock() >= Math.min(endMono, beforeChallenge + 1800)) evidence.expire();
    } catch (error) { evidence.fail(error); evidence.finish(); throw error; }
    finally { evidence.storageWaiting(false); }
    const guard = () => {
      if (!healthy() || !canControl() || !settings.commissioned || epoch !== challengeReply.epoch || snapshot.frame.generation !== out.generation
        || monotonicClock() >= endMono || monotonicClock() - beforeChallenge >= 1800 || !currentIdentity(saved.outstanding))
        fail('FLOOR_EXPIRED', 'Floor activation evidence or deadline changed.');
    };
    try {
      const reply = await request(existing ? 'renew' : 'acquire', { generation: out.generation, owner: out.owner, treatment, seq,
        challenge: frame.challenge, mask, ttl_ms: settings.leaseSeconds * 1000, end_ms: deviceEnd, ...(existing ? { token: out.token } : {}) },
        { timeout: Math.max(1, Math.floor(1800 - (monotonicClock() - beforeChallenge))), generation: out.generation, guard, recordingAttempt: evidence });
      const accepted = reply.frame;
      // A correlated capability can release partial activation even when GPIO
      // confirmation fails. It never grants a replacement activation.
      if (accepted.accepted && accepted.owner === out.owner && accepted.treatment === treatment
        && accepted.generation === out.generation && matches(NONCE, accepted.token ?? out.token ?? ''))
        recoveryToken = { generation: out.generation, treatment, token: accepted.token ?? out.token };
      if (!accepted.accepted || accepted.duplicate || !accepted.active || !accepted.board_ok || !accepted.gpio_match
        || accepted.owner !== out.owner || accepted.treatment !== treatment || accepted.seq !== seq || accepted.mask !== mask
        || accepted.gpio_mask !== mask || accepted.end_ms !== deviceEnd || accepted.lease_until_ms <= accepted.now_ms
        || accepted.lease_until_ms > Math.min(frame.issued_ms + settings.leaseSeconds * 1000, deviceEnd)
        || !existing && !matches(NONCE, accepted.token ?? '')) fail('FLOOR_UNCONFIRMED', 'Floor activation was not confirmed by current GPIO readback.');
      recoveryToken = { generation: out.generation, treatment, token: existing ? out.token : accepted.token };
      await persist({ ...saved, outstanding: { ...out, token: recoveryToken.token, phase: 'active' } });
      if (!healthy() || !canControl() || epoch !== challengeReply.epoch || !owns(snapshot.frame)
        || monotonicClock() >= endMono || clock() >= until)
        fail('FLOOR_UNCONFIRMED', 'Floor evidence changed while activation confirmation was being saved.');
      runtime = { endMono, renewAt: reply.mono + settings.renewSeconds * 1000, releaseRequired: false, allowRenew: renew };
      lastResult = { status: 'active', at: clock() };
      return { status: 'active', active: true, confirmed: true, leaseUntil: until };
    } catch (error) {
      await releaseInternal({ reason: 'activation-unconfirmed' });
      throw error;
    }
  };
  const api = {
    get topics() { return settings.deviceMac ? [FLOOR_MQTT_TOPICS.state, FLOOR_MQTT_TOPICS.availability] : []; },
    status,
    setConnected(value) {
      if (Boolean(value) === connected) return;
      connected = Boolean(value); epoch++; dispatchedAcquire = null; lastPoll = -Infinity;
      withdraw('floor-mqtt-disconnected');
    },
    ingest(topic, payload, packet = {}, receivedAt = clock(), receivedMono = monotonicClock()) {
      if (!api.topics.includes(topic)) return false;
      if (!connected || closed) return true;
      if (!Number.isFinite(receivedAt) || !Number.isFinite(receivedMono)) { withdraw('floor-feedback-invalid'); return true; }
      if (topic === FLOOR_MQTT_TOPICS.availability) {
        if (!packet.retain && String(payload) === 'Offline') { epoch++; withdraw('floor-device-offline', receivedAt); }
        return true;
      }
      if (packet.retain || packet.dup) return true;
      const frame = decode(payload);
      if (!frame || frame.device !== settings.deviceMac) { withdraw('floor-feedback-invalid', receivedAt); return true; }
      retainReleaseCapability(frame);
      const waiting = frame.kind === 'reply' ? pending.get(frame.id) : null;
      if (frame.kind === 'reply' && (!waiting || waiting.op !== frame.op || !waiting.dispatched() || waiting.epoch !== epoch
        || receivedMono >= waiting.deadline || waiting.generation && frame.generation !== waiting.generation)) return true;
      if (frame.kind === 'state' && (!snapshot || frame.generation !== snapshot.frame.generation || frame.now_ms <= snapshot.frame.now_ms)) {
        if (snapshot && frame.generation !== snapshot.frame.generation) withdraw('floor-connection-changed', receivedAt);
        return true;
      }
      if (snapshot && frame.generation === snapshot.frame.generation && frame.now_ms < snapshot.frame.now_ms) return true;
      if (!frame.connected || !matches(NONCE, frame.generation)) { withdraw('floor-device-offline', receivedAt); return true; }
      const ingressEpoch = epoch, remaining = frame.lease_until_ms - frame.now_ms;
      const expiryMono = frame.active ? Math.min(receivedMono + remaining, waiting ? waiting.sentMono() + remaining
        : snapshot?.frame.generation === frame.generation ? snapshot.expiryMono : receivedMono) : Infinity;
      const freshUntil = Math.min(receivedMono + MAX_AGE, expiryMono);
      const lifetimeMs = Math.floor(freshUntil - receivedMono), admitted = lifetimeMs > 0 && monotonicClock() < freshUntil;
      emit(admitted ? frame : null, receivedAt, !admitted ? ['floor-feedback-stale']
        : frame.board_ok && frame.gpio_match ? [] : ['floor-hardware-fault'], Math.max(1, lifetimeMs));
      afterCommit(() => {
        if (closed || !connected || ingressEpoch !== epoch || !canControl()) return;
        if (snapshot && frame.generation !== snapshot.frame.generation && runtime) runtime.releaseRequired = true;
        snapshot = { expiryMono, frame: Object.fromEntries(Object.entries(frame).filter(([key]) => !['token', 'challenge', 'issued_ms', 'lifetime_ms'].includes(key))),
          at: receivedAt, mono: receivedMono, epoch };
        unavailableRecorded = false;
        clearTimeout(freshnessTimer);
        const witnessed = snapshot;
        freshnessTimer = setTimeout(() => {
          if (snapshot === witnessed && !fresh()) withdraw('floor-feedback-stale');
        }, Math.max(1, Math.ceil(freshUntil - monotonicClock()) + 1));
        freshnessTimer.unref?.();
        if (runtime && (!frame.board_ok || !frame.gpio_match || !owns(frame))) runtime.releaseRequired = true;
        waiting?.resolve({ frame, mono: receivedMono, epoch });
      });
      store.afterRollback?.(() => withdraw('floor-feedback-uncommitted', receivedAt));
      return true;
    },
    lease({ owner, until, now = clock(), renew = true } = {}) {
      return serialize(() => activate({ kind: 'automatic', key: owner, mask: 15, until, now, renew }));
    },
    manual({ channel, enabled, durationSeconds = 900, requestId, scope: expectedScope } = {}) {
      return serialize(async () => {
        if (!integer(channel, 1, 4) || typeof enabled !== 'boolean' || !integer(durationSeconds, 60, 900)
          || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) fail('FLOOR_COMMAND', 'Invalid floor channel command.');
        const commandDigest = hash([channel, enabled, durationSeconds, expectedScope]);
        if (saved?.lastRequest?.id === requestId) {
          if (saved.lastRequest.digest !== commandDigest) fail('FLOOR_COMMAND', 'A repeated floor request cannot change its meaning.');
          return status();
        }
        if (!expectedScope || expectedScope !== scope()) fail('FLOOR_STALE', 'Floor equipment or connection changed. Refresh before controlling it.');
        if (!status().manualAvailable) fail(obligation() ? 'FLOOR_PENDING' : 'FLOOR_UNAVAILABLE', 'Manual floor control is unavailable.');
        const existing = saved.outstanding, bit = 1 << (channel - 1), mask = enabled ? (existing?.mask ?? 0) | bit : (existing?.mask ?? 0) & ~bit;
        const record = { id: requestId, digest: commandDigest, channel, enabled, at: Math.floor(clock()), status: 'pending', confirmed: false };
        try {
        if (!mask) {
          await persist(withRequest(saved, record));
          const result = await releaseInternal({ reason: 'manual-release' });
          if (!result.released) fail('FLOOR_PENDING', 'Floor release remains unconfirmed.');
          await persist(withRequest(saved, { ...record, status: 'confirmed', confirmed: true }));
        } else {
          await activate({ kind: 'manual', key: existing?.key ?? `manual_${requestId}`, mask,
            until: existing?.until ?? Math.floor(clock() + durationSeconds * 1000), requestRecord: record });
          await persist(withRequest(saved, { ...record, status: 'confirmed', confirmed: true }));
        }
        return status();
        } catch (error) {
          if (saved?.lastRequest?.id === requestId) await persist(withRequest(saved, { ...record, status: 'failed', confirmed: false })).catch(() => {});
          throw error;
        }
      });
    },
    release(options = {}) { return serialize(() => releaseInternal(options)); },
    finishLease({ owner, ...options } = {}) {
      return serialize(() => saved?.outstanding?.kind === 'manual' || owner && saved?.outstanding?.key !== owner
        ? { released: true, restorationPending: false, outcome: lastLeaseEnd?.owner === owner ? lastLeaseEnd.outcome ?? 'unverified' : 'unverified' } : releaseInternal({ ...options, scope: 'heating', reason: 'lease-ended' }));
    },
    tick() {
      if (busy || closed || !settings.deviceMac || !connected || !canControl()) return Promise.resolve(status());
      return serialize(async () => {
        if (snapshot && !fresh()) withdraw('floor-feedback-stale');
        if (saved?.outstanding && (!runtime || runtime.releaseRequired || monotonicClock() >= runtime.endMono || clock() >= saved.outstanding.until)) {
          await releaseInternal({ reason: 'lease-ended-or-feedback-lost' }); return status();
        }
        if (monotonicClock() - lastPoll >= POLL_MS) {
          try { await refresh(); } catch { withdraw('floor-feedback-unavailable'); }
        }
        if (saved?.outstanding && (obligation() || runtime?.releaseRequired)) await releaseInternal({ reason: 'feedback-lost' });
        else if (runtime?.allowRenew && monotonicClock() >= runtime.renewAt) {
          const out = saved.outstanding;
          try { await activate({ kind: out.kind, key: out.key, mask: out.mask, until: out.until }); }
          catch { await releaseInternal({ reason: 'renewal-failed' }); }
        }
        return status();
      });
    },
    async close({ restore = true } = {}) {
      if (restore && canControl()) await api.release({ reason: 'application-shutdown' });
      closed = true; connected = false; epoch++; dispatchedAcquire = null; withdraw('floor-mqtt-disconnected');
    },
  };
  return api;
}
