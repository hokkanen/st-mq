import { H66_DOCUMENTATION, H66_REGISTERS } from '../domain/telemetry.js';

const HOUR = 3_600_000;
const SETTINGS = ['0203', '0212', '0208', '2201'];
const LIMITS = { '0203': [5, 35], '0212': [30, 55], '0208': [50, 65], '2201': [0, 4] };
export const H66_WRITABLE_REGISTERS = Object.freeze([...SETTINGS]);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const copy = value => structuredClone(value);
const equal = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
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
  const maxAgeMs = config.maxAgeMs ?? 300_000;
  const timeoutMs = config.readbackTimeoutMs ?? 10_000;
  const maxOverrideMs = config.maxOverrideMs ?? 24 * HOUR;
  if ([maxAgeMs, timeoutMs, maxOverrideMs].some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('H66 time limits must be positive');
  const key = `h66:control:${deviceId}`;
  let saved;
  try { saved = store.getState(key); } catch { saved = null; }
  let state = saved?.version === 1 && saved.baseline && saved.obligations
    ? copy(saved) : { version: 1, phase: 'normal', baseline: {}, obligations: {}, requested: {}, expiresAt: null, lastResult: null };
  // Do not trust persisted telemetry as fresh, and never resume a preheat after a restart.
  let restoreRequired = Object.keys(state.obligations).length > 0;
  for (const obligation of Object.values(state.obligations)) obligation.requestedRevision = -1;
  let connected = false, closed = false, active = false, expiryTimer = null, reconcileQueued = false;
  let revision = 0, connectionGeneration = 0;
  let lastPublicationAt = null;
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
  function noteResult(result) { state.lastResult = { ...result, at: clock() }; persist(); }
  function armExpiry() {
    clearTimeout(expiryTimer);
    const remaining = timestamp(state.expiresAt) - clock();
    if (Object.keys(state.obligations).length && Number.isFinite(remaining)) {
      expiryTimer = setTimeout(() => { restoreRequired = true; queueReconciliation(); }, Math.max(1, remaining));
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
      if (Object.keys(state.obligations).length) restoreRequired = true;
      noteResult({ status: 'failed', code: error.code ?? 'H66_WRITE_FAILED', restorationPending: Object.keys(state.obligations).length > 0 });
      throw error;
    } finally { active = false; if (reconcileAfter) queueReconciliation(); }
  }
  function requireConnection(now) {
    if (!available(now)) throw failure('H66_UNAVAILABLE', 'H66 has no recent live publications.');
    if (config.writeEnabled !== true) throw failure('H66_WRITES_DISABLED', 'H66 setting writes are disabled.');
  }
  function deadline(now, expiresAt) {
    const end = expiresAt == null ? now + 15 * 60_000 : timestamp(expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(end) || end <= now || end - now > maxOverrideMs)
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
      const timer = setTimeout(() => finish(failure('H66_READBACK_TIMEOUT', 'H66 did not publish matching setting readback; restoration remains pending.')), timeoutMs);
      pending.set(index, { value, after: now, finish });
      try {
        Promise.resolve(publish(`${deviceId}/HP/SET/${index}`, wireValue(index, value), { qos: 0, retain: false }))
          .then(() => requestSnapshot()).catch(() => finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')));
      } catch { finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')); }
    });
  }
  async function apply(values, { now, reason, expiresAt, restoring = false }) {
    validateValues(values);
    const checkedAt=clock();
    requireConnection(checkedAt);
    if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'Previous H66 overrides are being restored.');
    // Preflight all values before the first mutation or publish.
    captureBaselines(Object.keys(values), checkedAt);
    if (!restoring) state.expiresAt = deadline(checkedAt, expiresAt);
    const changes = [];
    for (const index of SETTINGS.filter(index => Object.hasOwn(values, index))) {
      const value = values[index];
      if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'The H66 transition was interrupted.');
      if (!restoring && clock() >= state.expiresAt) throw failure('H66_EXPIRED', 'The H66 override expired before activation.');
      const reading = current(index, clock());
      if (!reading) throw failure('H66_BASELINE_UNAVAILABLE', 'A native-setting readback became stale during the transition.');
      if (equal(reading.value, value)) {
        if (restoring) delete state.obligations[index];
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
      restoreRequired = false; state.phase = phase; state.expiresAt = null; state.baseline = {}; state.requested = {};
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
    const changed = Object.keys(values).length ? await apply(values, { now, reason, restoring: true }) : [];
    restoreRequired = Object.keys(state.obligations).length > 0;
    state.phase = restoreRequired ? 'restoration-pending' : phase;
    if (!restoreRequired) { state.baseline = {}; state.requested = {}; state.expiresAt = null; }
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
      state.phase = 'test';
      const changed = await apply(values, { now, reason, expiresAt });
      const result = { status: 'confirmed', phase: state.phase, changed, expiresAt: state.expiresAt };
      noteResult(result); return result;
    });
  }
  async function setPhase({ phase, roomBoostC = 1, compressorOnly = false, now = clock(), expiresAt } = {}) {
    if (!['normal', 'recovery', 'preheat', 'reduction'].includes(phase)) throw failure('H66_PHASE_INVALID', 'Unknown H66 control phase.');
    if (phase === 'normal' || phase === 'recovery' && !compressorOnly) return restore({ now, reason: phase, phase });
    return exclusive(async () => {
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
        if (!Number.isFinite(roomBoostC) || roomBoostC < 1 || roomBoostC > 5) throw failure('H66_BOOST_INVALID', 'ROOM preheat boost must be 1–5°C.');
        changed = await apply({ '0203': state.baseline['0203'] + roomBoostC }, { now, reason: 'preheat', expiresAt });
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
      state.phase = 'external-change'; restoreRequired = true;
      noteResult({ status: 'external-change', register: reading.register, restorationPending: true });
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
      for (const waiter of [...pending.values()]) waiter.finish(failure('H66_DISCONNECTED', 'H66 disconnected before setting readback.'));
    } else queueReconciliation();
  }
  function status(now = clock()) {
    const live = available(now);
    return { enabled: config.enabled !== false, available: live, connected: live, brokerConnected: connected,
      writesEnabled: config.writeEnabled === true, phase: state.phase,
      externalChangeRevision:state.externalChangeRevision??0,externalChangeAt:state.externalChangeAt??null,
      lastPublicationAt, maxAgeMs, timeBasis: 'mqtt-received-unless-source-time-provided',
      sensorMeasurementTimeKnown: false, baseline: copy(state.baseline), requested: copy(state.requested),
      expiresAt: state.expiresAt, restorationPending: restoreRequired || state.phase === 'restoration-pending',
      obligations: copy(state.obligations), lastResult: copy(state.lastResult), lastTest: copy(state.lastTest ?? null),
      controlsReady: live && SETTINGS.every(index => current(index, now)) && !restoreRequired,
      readings: Object.fromEntries([...readings].map(([index, reading]) => [index, { ...copy(reading),
        stale: !current(index, now), available: live && Boolean(current(index, now)),
        requested: state.requested[index] ?? null, baseline: state.baseline[index] ?? null }])),
      controls: Object.fromEntries(SETTINGS.map(index => [index, { register: index, signal: H66_REGISTERS[index].signal,
        available: live && config.writeEnabled === true && Boolean(current(index, now)) && !restoreRequired && !active,
        reason: !live ? 'No recent live H66 publications.' : config.writeEnabled !== true ? 'Native setting writes are disabled.'
          : !current(index, now) ? 'A fresh setting baseline is not available.' : restoreRequired ? 'Restoration is pending.'
            : active ? 'A setting transition is in progress.' : null,
        unit: H66_REGISTERS[index].unit, min: LIMITS[index][0], max: LIMITS[index][1] }])),
      documentation: H66_DOCUMENTATION,
      limitation: 'Setting readback confirms a published register value, not compressor operation. Restoration requires the application and MQTT connection; no device-side expiry is claimed.' };
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
  return { ingest, setConnected, status, setPhase, writeSettings, restore, reconcile, test, close };
}
