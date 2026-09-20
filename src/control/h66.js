import { H66_DOCUMENTATION, H66_REGISTERS } from '../domain/telemetry.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';

const HOUR = 3_600_000;
const MAX_PAUSE_MS = 366 * 24 * HOUR;
const MAX_MANUAL_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const SETTINGS = ['0203', '0212', '0208', '2201'];
const LIMITS = { '0203': [5, 35], '0212': [30, 55], '0208': [50, 65], '2201': [0, 4] };
export const H66_WRITABLE_REGISTERS = Object.freeze([...SETTINGS]);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const copy = value => structuredClone(value);
const equal = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
const manualPhase = phase => ['manual-pause', 'manual-temporary'].includes(phase);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validateValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length)
    throw failure('H66_SETTINGS_INVALID', 'Choose at least one supported H66 setting.');
  for (const [index, value] of Object.entries(values)) {
    const range = LIMITS[index];
    if (!range || !Number.isFinite(value) || value < range[0] || value > range[1]
      || index === '2201' && !Number.isInteger(value))
      throw failure('H66_SETTINGS_INVALID', 'An H66 setting is unsupported or outside its permitted range.');
  }
}

/** One owner of native-setting overrides. Broker acknowledgements are never device readback.
 * publish uses QoS 0, retain=false and no offline queue: expired writes must not replay.
 * Persisted obligations are restored on expiry/restart/reconnect; this is not a device-side lease.
 */
export function createH66Controller({ deviceId, publish, requestSnapshot = async () => {},
  store, clock = Date.now, config = {} } = {}) {
  if (typeof deviceId !== 'string' || !deviceId || /[\/# +\u0000]/.test(deviceId)) throw new TypeError('Exact MQTT device identifier required');
  if (typeof publish !== 'function' || !store?.getState || !store?.setState) throw new TypeError('H66 requires transport and persistent state storage');
  const configuredAge = config.maxAgeMs ?? H66_MAX_AGE_MS;
  const maxAgeMs = Math.min(configuredAge, H66_MAX_AGE_MS);
  const timeoutMs = config.readbackTimeoutMs ?? 10_000;
  const maxOverrideMs = config.maxOverrideMs ?? 24 * HOUR;
  if ([configuredAge, timeoutMs, maxOverrideMs].some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('H66 time limits must be positive');
  const key = `h66:control:${deviceId}`;
  let saved;
  try { saved = store.getState(key); } catch { saved = null; }
  let state = saved?.version === 1 && saved.baseline && saved.obligations
    ? copy(saved) : { version: 1, phase: 'normal', baseline: {}, obligations: {}, requested: {}, expiresAt: null, lastResult: null };
  if (state.lastManual?.status === 'pending') state.lastManual = { ...state.lastManual,
    status: 'unconfirmed', confirmed: false, code: 'H66_MANUAL_INTERRUPTED' };
  // Do not trust persisted telemetry as fresh, and never resume an override after a restart.
  let restoreRequired = Object.keys(state.obligations).length > 0 || manualPhase(state.phase);
  for (const obligation of Object.values(state.obligations)) obligation.requestedRevision = -1;
  let connected = false, closed = false, active = false, expiryTimer = null, reconcileQueued = false;
  let revision = 0, connectionGeneration = 0;
  let lastPublicationAt = null;
  let compressorState = null;
  const readings = new Map(), pending = new Map();
  const persist = () => store.setState(key, copy(state));
  const event = (type, detail = {}) => store.event?.(type, detail, clock());
  const current = (index, now = clock()) => {
    const reading = readings.get(index);
    const age = now - (reading?.observedAt ?? reading?.receivedAt);
    return reading?.usableForControl === true && reading.connectionGeneration === connectionGeneration
      && Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? reading : null;
  };
  const available = (now = clock()) => connected && !closed && config.enabled !== false
    && Number.isFinite(lastPublicationAt) && now >= lastPublicationAt && now - lastPublicationAt <= maxAgeMs;
  function trackCompressor(reading) {
    const now = clock(), observedAt = reading.observedAt ?? reading.receivedAt, receivedAt = reading.receivedAt;
    if (!connected || reading.usableForControl !== true || ![0, 1].includes(reading.value)
      || !Number.isFinite(observedAt) || !Number.isFinite(receivedAt) || observedAt > receivedAt
      || receivedAt > now || now - observedAt > maxAgeMs
      || compressorState && (observedAt < compressorState.observedAt || receivedAt < compressorState.receivedAt)) {
      compressorState = null; return;
    }
    const previous = compressorState;
    const continuous = previous && now >= previous.receivedAt && now - previous.observedAt <= maxAgeMs
      && now - previous.receivedAt <= maxAgeMs;
    if (!continuous || previous.value !== reading.value) compressorState = {
      value: reading.value, since: observedAt,
      transitionObserved: Boolean(continuous && observedAt > previous.observedAt), observedAt, receivedAt,
    };
    else compressorState = { ...previous, observedAt, receivedAt };
  }
  function noteResult(result) { state.lastResult = { ...result, at: clock() }; persist(); }
  function armExpiry() {
    clearTimeout(expiryTimer);
    const remaining = timestamp(state.expiresAt) - clock();
    if ((Object.keys(state.obligations).length || manualPhase(state.phase)) && Number.isFinite(remaining)) {
      expiryTimer = setTimeout(() => {
        if (timestamp(state.expiresAt) > clock()) { armExpiry(); return; }
        restoreRequired = true; queueReconciliation();
      }, Math.min(MAX_TIMER_MS, Math.max(1, remaining)));
      expiryTimer.unref?.();
    }
  }
  function queueReconciliation() {
    if (reconcileQueued || closed || !connected || active || !restoreRequired) return;
    reconcileQueued = true;
    queueMicrotask(async () => {
      reconcileQueued = false;
      if (!closed && !active && connected && restoreRequired) {
        try { await reconcile({ now: clock() }); } catch { /* Remaining obligation is visible and retried on new telemetry. */ }
      }
    });
  }
  async function exclusive(operation, reconcileAfter = true) {
    if (active) throw failure('H66_BUSY', 'An H66 setting transition is already in progress.');
    if (closed) throw failure('H66_CLOSED', 'The H66 connection is closed.');
    active = true;
    try { return await operation(); }
    catch (error) {
      // A write timeout does not cancel the user's selection: its delivery is
      // uncertain, and the persisted baseline is still restored at its deadline.
      if (Object.keys(state.obligations).length
        && !(manualPhase(state.phase) && connected && timestamp(state.expiresAt) > clock())) restoreRequired = true;
      noteResult({ status: 'failed', code: error.code ?? 'H66_WRITE_FAILED', restorationPending: restoreRequired });
      throw error;
    } finally { active = false; if (reconcileAfter) queueReconciliation(); }
  }
  function requireConnection(now) {
    if (!available(now)) throw failure('H66_UNAVAILABLE', 'H66 has no recent live publications.');
    if (config.writeEnabled !== true) throw failure('H66_WRITES_DISABLED', 'H66 setting writes are disabled.');
  }
  function deadline(now, expiresAt, manualPause = false) {
    const end = expiresAt == null ? now + 15 * 60_000 : timestamp(expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(end) || end <= now || end - now > (manualPause ? MAX_PAUSE_MS : maxOverrideMs))
      throw failure('H66_EXPIRY_INVALID', 'An H66 override requires a future bounded expiry.');
    return end;
  }
  function captureBaselines(indices, now) {
    const next = { ...state.baseline };
    for (const index of indices) {
      if (Object.hasOwn(next, index)) continue;
      const reading = current(index, now);
      if (!reading) throw failure('H66_BASELINE_UNAVAILABLE', 'A fresh native-setting baseline is not available.');
      validateValues({ [index]: reading.value });
      next[index] = reading.value;
    }
    state.baseline = next;
  }
  function wireValue(index, value) {
    const verification = config.verification?.[index];
    const scale = verification?.scale ?? config.mqttScaleByRegister?.[index] ?? 1;
    const offset = verification?.offset ?? 0;
    if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) throw failure('H66_SCALE_INVALID', 'The H66 MQTT scale is invalid.');
    return String(Number(((value - offset) / scale).toFixed(6)));
  }
  function publishAndReadback(index, value, now) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, reading) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(index);
        if (error) reject(error); else resolve(reading);
      };
      const timer = setTimeout(() => finish(failure('H66_READBACK_TIMEOUT', 'H66 did not publish matching setting readback.')), timeoutMs);
      pending.set(index, { value, after: now, finish });
      try {
        Promise.resolve(publish(`${deviceId}/HP/SET/${index}`, wireValue(index, value), { qos: 0, retain: false }))
          .then(() => requestSnapshot()).catch(() => finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')));
      } catch { finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')); }
    });
  }
  async function apply(values, { now, reason, expiresAt, restoring = false, manualPause = false, manualSetting = false }) {
    validateValues(values);
    const checkedAt=clock();
    requireConnection(checkedAt);
    if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'Previous H66 overrides are being restored.');
    // Preflight all values before the first mutation or publish.
    if (manualSetting) {
      // An unchanged request owns nothing. Capture a fresh baseline only when
      // the first actual edit is made, including after an external panel edit.
      for (const index of Object.keys(values)) if (!state.obligations[index]) delete state.baseline[index];
    }
    captureBaselines(Object.keys(values).filter(index => !manualSetting || state.obligations[index]
      || !equal(current(index, checkedAt)?.value, values[index])), checkedAt);
    if (!restoring) state.expiresAt = deadline(checkedAt, expiresAt, manualPause);
    const changes = [];
    for (const index of SETTINGS.filter(index => Object.hasOwn(values, index))) {
      const value = values[index];
      if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'The H66 transition was interrupted.');
      if (!restoring && clock() >= state.expiresAt) throw failure('H66_EXPIRED', 'The H66 override expired before activation.');
      const reading = current(index, clock());
      if (!reading) throw failure('H66_BASELINE_UNAVAILABLE', 'A native-setting readback became stale during the transition.');
      if (equal(reading.value, value)) {
        if (restoring) delete state.obligations[index];
        if (restoring && index === '0203') state.manualPreheat = null;
        state.requested[index] = value;
        continue;
      }
      const obligation = state.obligations[index] ?? { baseline: state.baseline[index], originalAt: now };
      state.obligations[index] = { ...obligation, expected: value, previousValue: reading.value,
        requestedAt: clock(), requestedRevision: reading.revision, confirmed: false, restoring };
      state.requested[index] = value;
      // Baseline and restoration obligation must reach durable storage before MQTT.
      persist();
      armExpiry();
      const readback = await publishAndReadback(index, value, clock());
      if (restoring) delete state.obligations[index];
      else state.obligations[index] = { ...state.obligations[index], confirmed: true, confirmedAt: readback.receivedAt };
      if (restoring && index === '0203') state.manualPreheat = null;
      persist();
      changes.push(index);
      if (!restoring && clock() >= state.expiresAt) throw failure('H66_EXPIRED', 'The H66 override expired during activation.');
    }
    persist();
    armExpiry();
    event('h66-settings-confirmed', { registers: changes, reason, phase: state.phase });
    return changes;
  }
  async function restoreInternal({ now = clock(), reason = 'restore-normal', phase = 'normal' } = {}) {
    const remaining = Object.keys(state.obligations);
    if (!remaining.length) {
      restoreRequired = false; state.phase = phase; state.expiresAt = null; state.pauseId = null;
      state.manualPreheat = null; state.baseline = {}; state.requested = {};
      persist(); armExpiry(); return { status: 'confirmed', phase, changed: [] };
    }
    requireConnection(now);
    const values = {};
    for (const index of SETTINGS.filter(index => remaining.includes(index))) {
      const observed = current(index, now), obligation = state.obligations[index];
      if (!observed) continue; // Restore independently available fields; retain the other obligations.
      if (!obligation.confirmed && observed.revision <= obligation.requestedRevision) continue;
      if (equal(observed.value, obligation.baseline)) { delete state.obligations[index]; continue; }
      if (!equal(observed.value, obligation.expected) && !equal(observed.value, obligation.previousValue)) {
        // An external/manual setting supersedes our ownership. Never overwrite it.
        delete state.obligations[index];
        event('h66-external-setting-preserved', { register: index });
        continue;
      }
      values[index] = obligation.baseline;
    }
    if (!state.obligations['0203']) state.manualPreheat = null;
    const changed = Object.keys(values).length ? await apply(values, { now, reason, restoring: true }) : [];
    restoreRequired = Object.keys(state.obligations).length > 0;
    state.phase = restoreRequired ? 'restoration-pending' : phase;
    if (!restoreRequired) { state.baseline = {}; state.requested = {}; state.expiresAt = null; state.pauseId = null; state.manualPreheat = null; }
    const result = { status: restoreRequired ? 'pending' : 'confirmed', phase: state.phase, changed, restorationPending: restoreRequired };
    noteResult(result); armExpiry();
    return result;
  }
  async function restore(options = {}) {
    restoreRequired = true;
    return exclusive(() => restoreInternal(options), false);
  }
  async function reconcile({ now = clock() } = {}) {
    if (state.expiresAt != null && timestamp(state.expiresAt) <= now) restoreRequired = true;
    if (!restoreRequired) return { status: 'unchanged', phase: state.phase };
    return restore({ now, reason: 'expiry-or-reconnect' });
  }
  async function writeSettings(values, { now = clock(), reason = 'explicit-test', expiresAt } = {}) {
    return exclusive(async () => {
      if (manualPhase(state.phase)) throw failure('H66_MANUAL_CONFLICT', 'Restore the current manual settings before testing a native override.');
      state.phase = 'test';
      const changed = await apply(values, { now, reason, expiresAt });
      const result = { status: 'confirmed', phase: state.phase, changed, expiresAt: state.expiresAt };
      noteResult(result); return result;
    });
  }
  function manualConflict(pauseId, now = clock()) {
    if (state.phase === 'manual-pause' && state.pauseId === pauseId
      && timestamp(state.expiresAt) > now) return restoreRequired;
    if (state.phase === 'manual-temporary' && pauseId == null
      && timestamp(state.expiresAt) > now) return restoreRequired;
    return restoreRequired || Object.keys(state.obligations).length > 0 || !['normal', 'recovery'].includes(state.phase);
  }
  /** Manual native changes retain their original baseline until the next automatic
   * update, bounded by one minute. An active price-control pause instead holds
   * them until its deadline. Repeated edits share the original restoration owner. */
  async function setSetting(options = {}) {
    return setManualSetting(options);
  }
  async function setManualSetting({ register, value, now = clock(), expiresAt, pauseId } = {}, preheatChange) {
    validateValues({ [register]: value });
    const paused = pauseId != null;
    if (paused && (typeof pauseId !== 'string' || !pauseId))
      throw failure('H66_MANUAL_CONFLICT', 'A paused setting requires its active price-control pause.');
    const checkedAt = clock();
    let end = deadline(checkedAt, expiresAt ?? checkedAt + MAX_MANUAL_MS, paused);
    if (!paused && end - checkedAt > MAX_MANUAL_MS)
      throw failure('H66_EXPIRY_INVALID', 'An unpaused manual setting must expire within one minute.');
    if (!paused && state.phase === 'manual-temporary' && timestamp(state.expiresAt) > checkedAt)
      end = Math.min(end, timestamp(state.expiresAt));
    if (manualConflict(paused ? pauseId : undefined)) throw failure('H66_MANUAL_CONFLICT', 'Wait for the current controller override or restoration before changing a native setting.');
    return exclusive(async () => {
      requireConnection(clock());
      const previous = current(register, clock());
      if (!previous) throw failure('H66_BASELINE_UNAVAILABLE', 'A fresh native-setting reading is required.');
      if (!manualPhase(state.phase)) { state.baseline = {}; state.requested = {}; }
      state.phase = paused ? 'manual-pause' : 'manual-temporary';
      state.pauseId = paused ? pauseId : null; state.expiresAt = end;
      // The latest explicit ROOM edit supersedes a preheat boost. Other native
      // edits preserve it, and disabling the boost restores only its base ROOM.
      if (register === '0203') state.manualPreheat = preheatChange
        ? { ...preheatChange, pauseId: state.pauseId, expiresAt: end, confirmed: false } : null;
      const requested = { register, value, previousValue: previous.value, at: now,
        pauseId: state.pauseId, expiresAt: end,
        status: 'pending', confirmed: false, sent: false };
      state.lastManual = requested;
      persist();
      armExpiry();
      try {
        const changed = !equal(previous.value, value);
        state.lastManual = { ...requested, sent: changed ? null : false }; persist();
        await apply({ [register]: value }, { now, reason: paused ? 'manual-paused-setting' : 'manual-temporary-setting',
          expiresAt: end, manualPause: paused, manualSetting: true });
        if (register === '0203' && preheatChange) state.manualPreheat = preheatChange.enabled
          ? { ...state.manualPreheat, confirmed: true } : null;
        state.lastManual = { ...requested, status: 'confirmed', confirmed: true, sent: changed,
          readback: current(register)?.value ?? value, confirmedAt: clock() };
        noteResult({ status: 'confirmed', reason: paused ? 'manual-paused-setting' : 'manual-temporary-setting',
          register, value, confirmed: true, sent: changed, pauseId: state.pauseId, expiresAt: end });
        event('h66-manual-setting-confirmed', { register, value, previousValue: previous.value, sent: changed,
          pauseId: state.pauseId, expiresAt: end });
        return copy(state.lastManual);
      } catch (error) {
        const code = ['H66_READBACK_TIMEOUT', 'H66_WRITE_FAILED', 'H66_DISCONNECTED', 'H66_CLOSED'].includes(error?.code)
          ? error.code : 'H66_WRITE_FAILED';
        state.lastManual = { ...state.lastManual, status: 'unconfirmed', confirmed: false, code };
        persist();
        throw failure(code, 'The native setting change was not confirmed. Check its live value before trying again.');
      }
    });
  }
  async function setManualPreheat({ enabled, roomBoostC = 1, roomSettingC = 25, now = clock(), expiresAt, pauseId } = {}) {
    if (typeof enabled !== 'boolean') throw failure('H66_PHASE_INVALID', 'Choose whether manual preheating is enabled.');
    const overlay = state.manualPreheat;
    if (!enabled && !overlay) return { status: 'unchanged', phase: state.phase, changed: [] };
    if (enabled && (!Number.isInteger(roomSettingC) || roomSettingC < 20 || roomSettingC > 30))
      throw failure('H66_BOOST_INVALID', 'Preheat ROOM must be 20–30°C.');
    const reading = current('0203', clock());
    if (!reading) throw failure('H66_BASELINE_UNAVAILABLE', 'A fresh ROOM setting is required before changing preheat.');
    const baseValue = overlay?.baseValue ?? reading.value;
    return setManualSetting({ register: '0203', value: enabled ? Math.max(baseValue, roomSettingC) : baseValue,
      now, expiresAt, pauseId }, { enabled, roomSettingC, roomBoostC: enabled ? Math.max(0, roomSettingC - baseValue) : overlay.roomBoostC, baseValue, at: now });
  }
  async function setPhase({ phase, roomBoostC = 1, roomSettingC = 25, compressorOnly = false, now = clock(), expiresAt } = {}) {
    if (!['normal', 'recovery', 'preheat', 'reduction'].includes(phase)) throw failure('H66_PHASE_INVALID', 'Unknown H66 control phase.');
    if (phase === 'normal' || phase === 'recovery' && !compressorOnly) return restore({ now, reason: phase, phase });
    return exclusive(async () => {
      if (manualPhase(state.phase)) throw failure('H66_MANUAL_CONFLICT', 'Restore manual native settings before starting an automatic override.');
      requireConnection(now);
      if (restoreRequired) throw failure('H66_RESTORATION_PENDING', 'Previous H66 overrides are being restored.');
      // A cycle starts from current normal settings, never from a reduced ROOM value.
      if (!SETTINGS.every(index => Object.hasOwn(state.baseline, index))) {
        captureBaselines(SETTINGS, now);
        if (![config.normalMode ?? 1, config.compressorOnlyMode ?? 2].includes(state.baseline['2201'])) {
          state.baseline = {};
          throw failure('H66_NATIVE_MODE', 'The pump is in a manually selected operating mode.');
        }
        persist();
      }
      let changed = [];
      if (phase === 'recovery') {
        // End the tariff/DHW overrides while retaining ownership of mode2.
        // Avoid briefly enabling AUX between reduction and compressor recovery.
        for (const index of ['0203', '0212', '0208']) if (state.obligations[index])
          changed.push(...await apply({ [index]: state.baseline[index] }, { now, reason: 'recovery', restoring: true }));
        changed.push(...await apply({ '2201': config.compressorOnlyMode ?? 2 }, { now, reason: 'compressor-recovery', expiresAt }));
      } else if (phase === 'preheat') {
        if (state.phase === 'reduction') throw failure('H66_PHASE_CONFLICT', 'Restore normal operation before starting preheat.');
        if (!Number.isInteger(roomSettingC) || roomSettingC < 20 || roomSettingC > 30) throw failure('H66_BOOST_INVALID', 'Preheat ROOM must be 20–30°C.');
        changed = await apply({ '0203': Math.max(state.baseline['0203'], roomSettingC) }, { now, reason: 'preheat', expiresAt });
      } else {
        // ROOM restoration completes before reduction settings are sent. The executor owns DHWR.
        if (state.obligations['0203']) changed.push(...await apply({ '0203': state.baseline['0203'] }, { now, reason: 'preheat-complete', restoring: true }));
        changed.push(...await apply({ '0212': Math.min(40, state.baseline['0212']),
          '0208': 50, '2201': config.compressorOnlyMode ?? 2 }, { now, reason: 'reduction', expiresAt }));
      }
      state.phase = phase;
      const result = { status: 'confirmed', phase, changed, expiresAt: state.expiresAt,
        limitation: phase === 'reduction' ? 'DHW stop setting may apply only to auxiliary operation; compressor DHW cutoff is not established.' : undefined };
      noteResult(result); return result;
    });
  }
  function ingest(reading) {
    if (closed || !reading || reading.deviceId !== deviceId || !H66_REGISTERS[reading.register] || reading.duplicate) return;
    if (reading.register === '1A01') trackCompressor(reading);
    reading = { ...reading, revision: ++revision, connectionGeneration };
    const prior = readings.get(reading.register);
    if (reading.usableForControl || !prior?.usableForControl) readings.set(reading.register, copy(reading));
    if (reading.usableForControl) lastPublicationAt = reading.receivedAt;
    const waiter = pending.get(reading.register);
    if (waiter && reading.usableForControl && reading.receivedAt >= waiter.after && equal(reading.value, waiter.value)) {
      waiter.finish(null, reading);
      return;
    }
    const obligation = state.obligations[reading.register];
    if (!waiter && reading.usableForControl && obligation?.confirmed && !equal(reading.value, obligation.expected)) {
      delete state.obligations[reading.register];
      state.baseline[reading.register] = reading.value;
      state.externalChangeRevision=(state.externalChangeRevision??0)+1;
      state.externalChangeAt=clock();
      if (!manualPhase(state.phase)) { state.phase = 'external-change'; restoreRequired = true; }
      else {
        delete state.requested[reading.register]; delete state.baseline[reading.register];
        if (reading.register === '0203') state.manualPreheat = null;
      }
      noteResult({ status: 'external-change', register: reading.register, restorationPending: restoreRequired });
      event('h66-external-setting-preserved', { register: reading.register });
    }
    queueReconciliation();
  }
  function setConnected(value) {
    const next = Boolean(value);
    if (next && !connected) connectionGeneration++;
    connected = next;
    if (!connected) {
      lastPublicationAt = null;
      compressorState = null;
      if (manualPhase(state.phase)) restoreRequired = true;
      for (const waiter of [...pending.values()]) waiter.finish(failure('H66_DISCONNECTED', 'H66 disconnected before setting readback.'));
    } else queueReconciliation();
  }
  function status(now = clock()) {
    const live = available(now);
    if (compressorState && (!live || !current('1A01', now) || now < compressorState.receivedAt
      || now - compressorState.observedAt > maxAgeMs || now - compressorState.receivedAt > maxAgeMs)) compressorState = null;
    return { enabled: config.enabled !== false, available: live, connected: live, brokerConnected: connected,
      writesEnabled: config.writeEnabled === true, phase: state.phase,
      externalChangeRevision:state.externalChangeRevision??0,externalChangeAt:state.externalChangeAt??null,
      lastPublicationAt, maxAgeMs, timeBasis: 'mqtt-received-unless-source-time-provided',
      sensorMeasurementTimeKnown: false, baseline: copy(state.baseline), requested: copy(state.requested),
      expiresAt: state.expiresAt, pauseId: state.pauseId ?? null, restorationPending: restoreRequired || state.phase === 'restoration-pending',
      obligations: copy(state.obligations), lastResult: copy(state.lastResult), lastTest: copy(state.lastTest ?? null), lastManual: copy(state.lastManual ?? null),
      manualPreheat: copy(state.manualPreheat ?? null),
      compressorState: compressorState ? { value: compressorState.value, since: compressorState.since,
        transitionObserved: compressorState.transitionObserved } : null,
      controlsReady: live && SETTINGS.every(index => current(index, now)) && !restoreRequired,
      readings: Object.fromEntries([...readings].map(([index, reading]) => [index, { ...copy(reading),
        stale: !current(index, now), available: live && Boolean(current(index, now)),
        unavailableReasons: reading.connectionGeneration !== connectionGeneration ? ['awaiting-live-report'] : [],
        requested: state.requested[index] ?? null, baseline: state.baseline[index] ?? null }])),
      controls: Object.fromEntries(SETTINGS.map(index => [index, { register: index, signal: H66_REGISTERS[index].signal,
        available: live && config.writeEnabled === true && Boolean(current(index, now)) && !manualConflict(state.pauseId, now) && !active,
        reason: !live ? 'No recent live H66 publications.' : config.writeEnabled !== true ? 'Native setting writes are disabled.'
          : !current(index, now) ? 'A fresh setting baseline is not available.' : restoreRequired ? 'Restoration is pending.'
            : manualConflict(state.pauseId, now) ? 'A controller override is active.'
            : active ? 'A setting transition is in progress.' : null,
        unit: H66_REGISTERS[index].unit, min: LIMITS[index][0], max: LIMITS[index][1] }])),
      documentation: H66_DOCUMENTATION,
      limitation: 'Setting readback confirms a published register value, not compressor operation. Manual settings revert on the next automatic update, normally within one minute, if price control is not paused. During a pause they remain selected until it ends. Restoration requires the application and MQTT connection.' };
  }
  async function test({ register, value, durationSeconds = 60, now = clock(), expiresAt } = {}) {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 900)
      throw failure('H66_TEST_DURATION', 'H66 tests must last 1–900 seconds.');
    validateValues({ [register]: value });
    const end = deadline(now, expiresAt ?? now + durationSeconds * 1000);
    if (end - now > 900_000) throw failure('H66_TEST_DURATION', 'H66 tests must last 1–900 seconds.');
    state.lastTest = { register, value, durationSeconds, at: now, expiresAt: end, status: 'pending' }; persist();
    try {
      const result = await writeSettings({ [register]: value }, { now, reason: 'explicit-test', expiresAt: end });
      state.lastTest = { ...state.lastTest, status: result.status, readback: current(register)?.value ?? null }; persist();
      return { ...result, register, value, at: now };
    } catch (error) {
      state.lastTest = { ...state.lastTest, status: 'failed', code: error.code ?? 'H66_WRITE_FAILED' }; persist();
      throw error;
    }
  }
  async function close() {
    closed = true; connected = false; clearTimeout(expiryTimer);
    for (const waiter of [...pending.values()]) waiter.finish(failure('H66_CLOSED', 'H66 closed before setting readback.'));
    // Do not erase outstanding obligations or claim a disconnected device was restored.
    persist();
  }
  armExpiry();
  return { ingest, setConnected, status, setPhase, writeSettings, setSetting, setManualPreheat, restore, reconcile, test, close };
}
