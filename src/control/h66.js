import { H66_DOCUMENTATION, H66_REGISTERS } from '../domain/telemetry.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { H66_SETTING_LIMITS, validateH66ControlState } from '../domain/heating-control-state.js';
import { createWriteScope } from '../storage/write-scope.js';
import { createControlAttempt } from '../storage/control-attempt.js';

const HOUR = 3_600_000;
const MAX_PAUSE_MS = 366 * 24 * HOUR;
const MAX_TIMER_MS = 2_147_483_647;
const SETTINGS = ['0203', '0212', '0208', '2201'];
const LIMITS = H66_SETTING_LIMITS;
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
  store, clock = Date.now, monotonicClock = () => performance.now(), config = {}, closeWriteTimeoutMs = 5000,
  canAttributeStorageBlock = () => true, tariffFeedback = () => null, canControl = () => true } = {}) {
  if (typeof deviceId !== 'string' || !deviceId || /[\/# +\u0000]/.test(deviceId)) throw new TypeError('Exact MQTT device identifier required');
  if (typeof publish !== 'function' || !store?.getState || !store?.setState) throw new TypeError('H66 requires transport and persistent state storage');
  const configuredAge = config.maxAgeMs ?? H66_MAX_AGE_MS;
  const maxAgeMs = Math.min(configuredAge, H66_MAX_AGE_MS);
  const timeoutMs = config.readbackTimeoutMs ?? 10_000;
  const confirmationMs = config.confirmationTimeoutMs ?? 30_000;
  const preparationMs = config.preheatPreparationMs ?? 90_000;
  const maxOverrideMs = config.maxOverrideMs ?? 24 * HOUR;
  if ([configuredAge, timeoutMs, confirmationMs, preparationMs, maxOverrideMs].some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('H66 time limits must be positive');
  const key = `h66:control:${deviceId}`;
  // A failed read may hide an outstanding physical restoration obligation.
  // Only a genuinely absent record permits initialization of empty state.
  const saved = store.getState(key);
  validateH66ControlState(saved);
  let state = saved != null ? copy(saved) : { version: 1, phase: 'normal', baseline: {}, obligations: {}, requested: {}, expiresAt: null, lastResult: null };
  if (state.lastManual?.status === 'pending') state.lastManual = { ...state.lastManual,
    status: 'unconfirmed', confirmed: false, code: 'H66_MANUAL_INTERRUPTED' };
  // A paused Reduced selection is durable device-bound intent. Preserve its
  // existing native settings across restart without replaying any saved writes;
  // the executor validates the current pause before maintaining tariff control.
  const pausedReduction = state.manualMode === 'reduction' && typeof state.pauseId === 'string' && state.pauseId
    && (state.expiresAt === null || timestamp(state.expiresAt) > clock());
  let restoreRequired = !pausedReduction && (Object.keys(state.obligations).length > 0 || Boolean(state.manualMode));
  for (const obligation of Object.values(state.obligations)) {
    obligation.requestedRevision = -1;
    if (Object.hasOwn(obligation, 'dispatchedRevision')) obligation.dispatchedRevision = -1;
  }
  let connected = false, closed = false, closing = false, active = false, expiryTimer = null, reconcileQueued = false;
  let reconcileAfterActive = false, activeGeneration = null;
  let revision = 0, connectionGeneration = 0, elapsedExpiry = null;
  let lastPublicationAt = null;
  let normalBoundary = null, preparation = null, wakePreparation = null;
  const committedRevisions = new Map();
  let compressorState = null;
  const readings = new Map(), pending = new Map();
  const writes = createWriteScope({ closeTimeoutMs: closeWriteTimeoutMs,
    runWrite: (operation, options) => store.runWrite ? store.runWrite(operation, options) : Promise.resolve().then(operation) });
  const persist = () => { validateH66ControlState(state); store.setState(key, copy(state)); };
  const event = (type, detail = {}) => store.event?.(type, detail, clock());
  // Admission waits asynchronously; the callback and durable state change stay
  // synchronous. Never keep a SQLite transaction open across MQTT/readback.
  const writeState = (operation = () => {}, options = {}) => {
    const commit = () => {
      const before = { ...state, baseline: { ...state.baseline }, obligations: { ...state.obligations }, requested: { ...state.requested } };
      const restoringBefore = restoreRequired;
      const boundaryBefore = normalBoundary;
      store.afterRollback?.(() => { state = before; restoreRequired = restoringBefore; normalBoundary = boundaryBefore; });
      try { const result = operation(); persist(); return result; }
      catch (error) { state = before; restoreRequired = restoringBefore; normalBoundary = boundaryBefore; throw error; }
    };
    return writes.run(commit, { priority: 'control', ...options });
  };
  const saveResult = result => writeState(() => { state.lastResult = { ...result, at: clock() }; });
  const current = (index, now = clock()) => {
    const reading = readings.get(index);
    const age = now - (reading?.observedAt ?? reading?.receivedAt);
    return reading?.usableForControl === true && reading.connectionGeneration === connectionGeneration
      && Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? reading : null;
  };
  const available = (now = clock()) => connected && !closed && config.enabled !== false
    && Number.isFinite(lastPublicationAt) && now >= lastPublicationAt && now - lastPublicationAt <= maxAgeMs;
  const baselineRestorationConfirmed = (index, reading, obligation) => equal(reading.value, obligation.baseline)
    && reading.revision <= (committedRevisions.get(index) ?? -1)
    && (obligation.confirmed || obligation.restoring && Number.isFinite(obligation.dispatchedAt)
      && reading.revision > obligation.dispatchedRevision && reading.receivedAt >= obligation.dispatchedAt);
  function liveTariff() {
    let value;
    try { value = tariffFeedback(); } catch { return null; }
    return value?.verified === true && !value.stale && ['normal', 'reduction'].includes(value.mode)
      && /^[a-f0-9]{64}$/.test(value.identity ?? '') ? value : null;
  }
  function tariffIdentity() {
    try { return tariffFeedback()?.identity; } catch { return null; }
  }
  // This reference describes a physical tariff period, not a configured default
  // or permission to write ROOM. Absence starts unknown; no history is backfilled.
  function observeTariff() {
    const feedback = liveTariff();
    if (!feedback) { normalBoundary = null; return null; }
    let context = state.tariffRoom;
    if (!context || context.identity !== feedback.identity) {
      context = { identity: feedback.identity, mode: 'unknown', normalC: null, reducedC: null, normalAfter: null, awaitingNormal: false };
      state.tariffRoom = context;
    }
    if (context.mode !== feedback.mode || feedback.mode === 'normal' && (!normalBoundary || clock() < normalBoundary.at)) {
      state.tariffRoom = context = { ...context, mode: feedback.mode,
        awaitingNormal: context.awaitingNormal || feedback.mode === 'reduction',
        normalAfter: feedback.mode === 'normal' ? clock() : null };
      normalBoundary = feedback.mode === 'normal' ? { at: clock(), revision, generation: connectionGeneration } : null;
    }
    return context;
  }
  function normalRoomReady() {
    const feedback = liveTariff(), context = state.tariffRoom, reading = current('0203');
    return Boolean(feedback?.mode === 'normal' && context?.identity === feedback.identity
      && context.mode === 'normal' && normalBoundary?.generation === connectionGeneration
      && reading && reading.receivedAt >= normalBoundary.at && reading.revision > normalBoundary.revision
      && reading.observedAt >= normalBoundary.at
      && reading.revision <= (committedRevisions.get('0203') ?? -1) && !context.awaitingNormal
      && Number.isFinite(context.normalC) && equal(reading.value, context.normalC));
  }
  function observeRoom(reading) {
    const context = state.tariffRoom;
    if (!context || reading.register !== '0203' || !reading.usableForControl || state.obligations['0203']) return;
    if (context.mode === 'reduction' && !equal(context.reducedC, reading.value)) state.tariffRoom = { ...context, reducedC: reading.value };
    else if (context.mode === 'normal' && normalBoundary?.generation === connectionGeneration
      && reading.receivedAt >= normalBoundary.at && reading.observedAt >= normalBoundary.at
      && reading.revision > normalBoundary.revision) {
      if (context.awaitingNormal || context.reducedC !== null) {
        // An unchanged pre-reduction value may have been published before the
        // reduction took effect. It can confirm that same normal reference,
        // never authorize a subsequently arriving lower transient baseline.
        const accepted = Number.isFinite(context.normalC) && Number.isFinite(context.reducedC)
          && (equal(context.normalC, context.reducedC) ? equal(reading.value, context.normalC)
            : !equal(reading.value, context.reducedC));
        if (!accepted) {
          if (!context.awaitingNormal) state.tariffRoom = { ...context, awaitingNormal: true };
          return;
        }
      }
      if (!equal(context.normalC, reading.value) || context.awaitingNormal)
        state.tariffRoom = { ...context, normalC: reading.value, awaitingNormal: false };
    }
  }
  async function captureTariffReduction({ identity = liveTariff()?.identity } = {}) {
    return writeState(() => {
      observeTariff();
      if (!/^[a-f0-9]{64}$/.test(identity ?? '')) return;
      const context = state.tariffRoom?.identity === identity ? state.tariffRoom
        : { identity, mode: 'unknown', normalC: null, reducedC: null, normalAfter: null, awaitingNormal: false };
      if (context.mode === 'reduction') return; // Refreshing the same period retains its reduced observation.
      const room = current('0203');
      const normalC = context.mode === 'normal' && room && !state.obligations['0203'] && normalRoomReady()
        ? room.value : context.normalC;
      // A requested period remains ambiguous even when Normal feedback was
      // unavailable before dispatch or no H66 report arrives during reduction.
      state.tariffRoom = { ...context, normalC, reducedC: null, awaitingNormal: true };
    });
  }
  async function preparePreheat({ releaseTariff, expiresAt, validate = () => {} }) {
    if (preparation || active) throw failure('H66_BUSY', 'An H66 transition is already in progress.');
    if (!Number.isFinite(expiresAt) || expiresAt <= clock() || typeof releaseTariff !== 'function')
      throw failure('H66_EXPIRY_INVALID', 'Preheat preparation needs a future deadline and tariff release.');
    const generation = connectionGeneration, startedAt = clock(), identity = liveTariff()?.identity;
    const end = Math.min(startedAt + preparationMs, expiresAt);
    const elapsedEnd = monotonicClock() + Math.max(0, end - startedAt);
    let waitingForNormal = true;
    const check = () => {
      requireConnection(clock()); validate();
      if (closing || !canControl()) throw failure('H66_CLOSED', 'Heating control is no longer available.');
      if (generation !== connectionGeneration) throw failure('H66_DISCONNECTED', 'H66 reconnected during Preheat preparation.');
      if (!identity || tariffIdentity() !== identity) throw failure('H66_TARIFF_UNCONFIRMED', 'The tariff relay identity changed.');
      if (clock() >= end || monotonicClock() >= elapsedEnd)
        throw failure(waitingForNormal ? 'H66_TARIFF_UNCONFIRMED' : 'H66_NORMAL_ROOM_TIMEOUT',
          waitingForNormal ? 'Normal tariff relay readback timed out. Preheat was cancelled.'
            : 'Waiting for normal ROOM setting timed out. Preheat was cancelled.');
    };
    const wait = () => new Promise(resolve => {
      const finish = () => { clearTimeout(timer); wakePreparation = null; resolve(); };
      const timer = setTimeout(finish, Math.min(50, Math.max(1, end - clock())));
      wakePreparation = finish;
    });
    preparation = { startedAt, expiresAt: end, reason: 'Waiting for Normal tariff relay confirmation.' };
    try {
      check();
      await releaseTariff();
      // A broker acknowledgement precedes physical relay feedback. Retain the
      // original identity and preparation deadline while awaiting our Normal
      // request; no ROOM increase or floor lease is authorized in this stage.
      while (true) {
        check();
        if (liveTariff()?.mode === 'normal') break;
        await wait();
      }
      check();
      await writeState(() => {
        const context = observeTariff();
        if (!context || context.mode !== 'normal') throw failure('H66_TARIFF_UNCONFIRMED', 'Normal tariff relay readback is not confirmed.');
        // Reset the boundary once, after actual relay confirmation. Writer
        // admission time cannot turn an earlier queued publication into evidence.
        normalBoundary = { at: clock(), revision, generation };
        state.tariffRoom = { ...context, normalAfter: normalBoundary.at };
      });
      waitingForNormal = false;
      preparation.reason = 'Waiting for normal ROOM setting.';
      void Promise.resolve().then(requestSnapshot).catch(() => {});
      while (true) {
        check();
        if (liveTariff()?.mode !== 'normal') throw failure('H66_TARIFF_UNCONFIRMED', 'Normal tariff relay readback was lost.');
        if (normalRoomReady()) return { roomSettingC: current('0203').value };
        await wait();
      }
    } finally { preparation = null; }
  }
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
    expiryTimer = null;
    // Expiry starts restoration once. The original deadline must not become a
    // retry timer while readback is missing or a restoration write is uncertain.
    // Keep the obligation and retry on telemetry, reconnect or reconciliation.
    if (closed || restoreRequired) return;
    const wallEnd = timestamp(state.expiresAt);
    if (!Number.isFinite(wallEnd)) elapsedExpiry = null;
    else if (elapsedExpiry?.wallEnd !== wallEnd)
      elapsedExpiry = { wallEnd, end: monotonicClock() + Math.max(0, wallEnd - clock()) };
    const remaining = Math.min(wallEnd - clock(), elapsedExpiry ? elapsedExpiry.end - monotonicClock() : Infinity);
    if ((Object.keys(state.obligations).length || Boolean(state.manualMode)) && Number.isFinite(remaining)) {
      expiryTimer = setTimeout(() => {
        if (timestamp(state.expiresAt) > clock() && elapsedExpiry?.end > monotonicClock()) { armExpiry(); return; }
        restoreRequired = true; queueReconciliation();
      }, Math.min(MAX_TIMER_MS, Math.max(1, remaining)));
      expiryTimer.unref?.();
    }
  }
  function queueReconciliation() {
    if (closed || !connected || !restoreRequired) return;
    // A missing register can report while another restoration is awaiting its
    // readback. Revisit that new evidence once the active operation releases.
    if (active) { reconcileAfterActive = true; return; }
    if (reconcileQueued) return;
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
    activeGeneration = connectionGeneration;
    try { return await operation(); }
    catch (error) {
      // A write timeout does not cancel the user's selection: its delivery is
      // uncertain, and the persisted baseline is still restored at its deadline.
      if (Object.keys(state.obligations).length
        && !(Boolean(state.manualMode) && connected
          && (state.expiresAt === null || timestamp(state.expiresAt) > clock()))) restoreRequired = true;
      await saveResult({ status: 'failed', code: error.code ?? 'H66_WRITE_FAILED', restorationPending: restoreRequired });
      throw error;
    } finally {
      active = false;
      activeGeneration = null;
      const queuedDuringOperation = reconcileAfterActive;
      reconcileAfterActive = false;
      if (reconcileAfter || queuedDuringOperation) queueReconciliation();
    }
  }
  function requireConnection(now) {
    if (!available(now)) throw failure('H66_UNAVAILABLE', 'H66 has no recent live publications.');
    if (active && activeGeneration !== connectionGeneration)
      throw failure('H66_DISCONNECTED', 'The H66 connection changed during the setting transition.');
    if (config.writeEnabled !== true) throw failure('H66_WRITES_DISABLED', 'H66 setting writes are disabled.');
  }
  function deadline(now, expiresAt, manualPause = false) {
    if (manualPause && expiresAt === null) return null;
    const end = expiresAt == null ? now + 15 * 60_000 : timestamp(expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(end) || end <= now || end - now > (manualPause ? MAX_PAUSE_MS : maxOverrideMs))
      throw failure('H66_EXPIRY_INVALID', 'An H66 override requires a future bounded expiry.');
    return end;
  }
  function captureBaselines(indices, now) {
    const next = { ...state.baseline };
    for (const index of indices) {
      if (state.obligations[index] && Object.hasOwn(next, index)) continue;
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
  function publishAndReadback(index, value, validate, recordingAttempt, activationEnd = Infinity) {
    return new Promise((resolve, reject) => {
      let settled = false, recordingDeadlineExpired = false, dispatchedAt = null, timer;
      let readbackEnd = Infinity, readbackElapsedEnd = Infinity;
      const cancellation = new AbortController();
      const dispatchEnd = Math.min(clock() + timeoutMs, activationEnd);
      const dispatchElapsedEnd = monotonicClock() + Math.max(0, dispatchEnd - clock());
      const finish = (error, reading) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(index); cancellation.abort();
        if (error) { error.dispatchedAt = dispatchedAt; error.dispatchedRevision = waiter.revision; reject(error); }
        else resolve({ ...reading, dispatchedAt });
      };
      const expire = (activationExpired = false) => {
        recordingDeadlineExpired = dispatchedAt === null;
        finish(failure(activationExpired ? 'H66_EXPIRED' : 'H66_READBACK_TIMEOUT', dispatchedAt === null
          ? 'H66 setting dispatch was not established before its deadline.'
          : 'H66 did not publish matching setting readback before its deadline.'));
      };
      timer = setTimeout(() => expire(activationEnd <= dispatchEnd), Math.max(1, dispatchEnd - clock()));
      const waiter = { value, after: Infinity, revision: Infinity, finish: (error, reading) => {
        if (!error && (clock() >= readbackEnd || monotonicClock() >= readbackElapsedEnd))
          expire(activationEnd <= readbackEnd);
        else finish(error, reading);
      } };
      pending.set(index, waiter);
      const beforePublish = () => {
        if (settled || clock() >= dispatchEnd || monotonicClock() >= dispatchElapsedEnd)
          throw failure('H66_READBACK_TIMEOUT', 'The H66 dispatch deadline has passed.');
        validate();
      };
      const onFirstWrite = () => {
        if (settled || dispatchedAt !== null) return;
        dispatchedAt = clock();
        waiter.after = dispatchedAt; waiter.revision = revision;
        readbackEnd = Math.min(dispatchedAt + confirmationMs, activationEnd);
        readbackElapsedEnd = monotonicClock() + Math.max(0, readbackEnd - dispatchedAt);
        clearTimeout(timer);
        timer = setTimeout(() => expire(activationEnd - dispatchedAt <= confirmationMs), Math.max(1, Math.min(confirmationMs, activationEnd - clock())));
      };
      try {
        Promise.resolve(publish(`${deviceId}/HP/SET/${index}`, wireValue(index, value),
          { qos: 0, retain: false, noReplay: true, beforePublish, beforeWrite: () => { beforePublish(); return true; }, onFirstWrite, signal: cancellation.signal,
            recordingContext: 'heat-pump-command', recordingAttempt, recordingDeadlineExpired: () => recordingDeadlineExpired }))
          .then(() => { if (!settled) return requestSnapshot(); })
          .catch(() => finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')));
      } catch { finish(failure('H66_WRITE_FAILED', 'The H66 write could not be confirmed.')); }
    });
  }
  async function apply(values, { now, reason, expiresAt, activationExpiresAt = expiresAt, restoring = false, restoreTokens = null, manualPause = false, validateActivation = () => {} }) {
    validateValues(values);
    const checkedAt=clock();
    const generation = connectionGeneration;
    requireConnection(checkedAt);
    if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'Previous H66 overrides are being restored.');
    const tokens = restoring ? restoreTokens ?? { ...state.obligations } : null;
    const end = restoring ? null : deadline(checkedAt, expiresAt, manualPause);
    const activationDeadline = Math.min(end ?? Infinity, activationExpiresAt ?? Infinity);
    const activationElapsedEnd = Number.isFinite(activationDeadline)
      ? monotonicClock() + Math.max(0, activationDeadline - checkedAt) : Infinity;
    const expectedReadings = Object.fromEntries(Object.keys(values).map(index => [index, current(index, checkedAt)]));
    const check = (index, allowExpired = false) => {
      requireConnection(clock());
      if (!restoring) validateActivation();
      if (!restoring && closing) throw failure('H66_CLOSED', 'H66 is closing; no new setting changes are accepted.');
      if (connectionGeneration !== generation) throw failure('H66_DISCONNECTED', 'The H66 connection changed while saving the setting.');
      if (!restoring && restoreRequired) throw failure('H66_RESTORATION_PENDING', 'The H66 transition was interrupted.');
      if (!allowExpired && !restoring && (clock() >= Math.min(end ?? Infinity, activationExpiresAt ?? Infinity)
        || monotonicClock() >= activationElapsedEnd)) throw failure('H66_EXPIRED', 'The H66 override expired before activation.');
      const reading = current(index, clock());
      if (!reading) throw failure('H66_BASELINE_UNAVAILABLE', 'A native-setting readback became stale during the transition.');
      if (!expectedReadings[index] || !equal(reading.value, expectedReadings[index].value))
        throw failure('H66_SETTING_CHANGED', 'The native setting changed while its command was waiting.');
      return reading;
    };
    const changes = [];
    for (const index of SETTINGS.filter(index => Object.hasOwn(values, index))) {
      const value = values[index];
      // Baseline and restoration obligation must reach durable storage before MQTT.
      let attempt, writtenObligation;
      try { writtenObligation = await writeState(() => {
        if (restoring && (!tokens[index] || state.obligations[index] !== tokens[index])) return null;
        const reading = check(index);
        if (restoring && !equal(reading.value, tokens[index].baseline)
          && !equal(reading.value, tokens[index].expected) && !equal(reading.value, tokens[index].previousValue)) {
          delete state.obligations[index]; delete state.requested[index];
          event('h66-external-setting-preserved', { register: index });
          return null;
        }
        if (!restoring) {
          // The first actual edit takes its baseline from current native state.
          if (!state.obligations[index]) state.baseline[index] = reading.value;
          state.expiresAt = end;
        }
        if (equal(reading.value, value) && (!restoring || baselineRestorationConfirmed(index, reading, tokens[index]))) {
          if (restoring) delete state.obligations[index];
          if (restoring && index === '0203') state.manualPreheat = null;
          state.requested[index] = value;
          return null;
        }
        const obligation = state.obligations[index] ?? { baseline: state.baseline[index], originalAt: now };
        // Baseline reports received while dispatch was still queued cannot
        // discharge an uncertain write. Reassert the baseline and retain the
        // preceding owned value through retries and delayed gateway reports.
        const previousValue = restoring && equal(reading.value, value)
          ? equal(obligation.expected, value) ? obligation.previousValue : obligation.expected : reading.value;
        const written = { ...obligation, expected: value, previousValue,
          requestedAt: clock(), requestedRevision: reading.revision, confirmed: false, restoring };
        delete written.dispatchedAt; delete written.dispatchedRevision; delete written.confirmedAt;
        state.obligations[index] = written;
        state.requested[index] = value;
        attempt = createControlAttempt({ store, context: 'heat-pump-command' });
        attempt.storageWaiting(true);
        return written;
      }); } catch (error) { attempt?.fail(error); attempt?.finish(); throw error; }
      if (attempt) {
        // The original activation lease can expire while its required intent
        // save commits. Diagnose that existing deadline only when every other
        // connection, native-reading and ownership check still holds.
        if (!restoring && (clock() >= activationDeadline || monotonicClock() >= activationElapsedEnd)) {
          try {
            check(index, true);
            if (state.obligations[index] === writtenObligation && canAttributeStorageBlock() === true) attempt.expire();
          } catch { /* A different invalidation does not establish storage expiry. */ }
        }
        attempt.storageWaiting(false);
      }
      armExpiry();
      if (!writtenObligation) continue;
      try {
      // Admission can outlive evidence or permission. Committed intent alone
      // does not authorize a command on a replaced connection or changed value.
      const beforePublish = () => {
        check(index);
        if (state.obligations[index] !== writtenObligation)
          throw failure('H66_SETTING_CHANGED', 'The saved native-setting obligation was superseded.');
      };
      beforePublish();
      const readback = await publishAndReadback(index, value, beforePublish, attempt, restoring ? Infinity : activationDeadline);
      await writeState(() => {
        if (state.obligations[index] === writtenObligation) {
          if (restoring) delete state.obligations[index];
          else state.obligations[index] = { ...writtenObligation, confirmed: true, confirmedAt: readback.receivedAt };
        }
        if (restoring && index === '0203' && !state.obligations[index]) state.manualPreheat = null;
      });
      changes.push(index);
      if (!restoring && (clock() >= Math.min(state.expiresAt ?? Infinity, activationExpiresAt ?? Infinity) || monotonicClock() >= activationElapsedEnd)) throw failure('H66_EXPIRED', 'The H66 override expired during activation.');
      } catch (error) {
        attempt?.fail(error);
        // A timed-out write can still receive its matching readback later.
        // Persist its actual dispatch boundary before releasing the transition;
        // intent queued before the bytes were sent supplies no such proof.
        if (Number.isFinite(error.dispatchedAt) && Number.isSafeInteger(error.dispatchedRevision))
          await writeState(() => {
            if (state.obligations[index] === writtenObligation)
              state.obligations[index] = { ...writtenObligation,
                dispatchedAt: error.dispatchedAt, dispatchedRevision: error.dispatchedRevision };
          });
        throw error;
      }
      finally { attempt?.finish(); }
    }
    await writeState(() => event('h66-settings-confirmed', { registers: changes, reason, phase: state.phase }));
    armExpiry();
    return changes;
  }
  async function restoreInternal({ now = clock(), reason = 'restore-normal', phase = 'normal' } = {}) {
    const values = {}, restoreTokens = {};
    await writeState(() => {
      const remaining = Object.keys(state.obligations);
      if (remaining.length) requireConnection(clock());
      for (const index of SETTINGS.filter(index => remaining.includes(index))) {
        const observed = current(index, clock()), obligation = state.obligations[index];
        if (!observed) continue; // Restore independently available fields; retain the other obligations.
        if (!obligation.confirmed && observed.revision <= obligation.requestedRevision) continue;
        if (baselineRestorationConfirmed(index, observed, obligation)) { delete state.obligations[index]; continue; }
        if (!equal(observed.value, obligation.baseline)
          && !equal(observed.value, obligation.expected) && !equal(observed.value, obligation.previousValue)) {
          // An external/manual setting supersedes our ownership. Never overwrite it.
          delete state.obligations[index];
          event('h66-external-setting-preserved', { register: index });
          continue;
        }
        values[index] = obligation.baseline; restoreTokens[index] = obligation;
      }
      if (!state.obligations['0203']) state.manualPreheat = null;
    });
    const changed = Object.keys(values).length ? await apply(values, { now, reason, restoring: true, restoreTokens }) : [];
    const result = await writeState(() => {
      restoreRequired = Object.keys(state.obligations).length > 0;
      state.phase = restoreRequired ? 'restoration-pending' : phase;
      if (!restoreRequired) { state.baseline = {}; state.requested = {}; state.expiresAt = null; state.pauseId = null; state.manualPreheat = null; state.manualMode = null; }
      const result = { status: restoreRequired ? 'pending' : 'confirmed', phase: state.phase, changed, restorationPending: restoreRequired };
      state.lastResult = { ...result, at: clock() };
      return result;
    });
    armExpiry();
    return result;
  }
  async function restore(options = {}) {
    restoreRequired = true;
    return exclusive(() => restoreInternal(options), false);
  }
  async function reconcile({ now = clock() } = {}) {
    if (state.expiresAt != null && (timestamp(state.expiresAt) <= now
      || elapsedExpiry && elapsedExpiry.end <= monotonicClock())) restoreRequired = true;
    if (!restoreRequired) return { status: 'unchanged', phase: state.phase };
    return restore({ now, reason: 'expiry-or-reconnect' });
  }
  async function writeSettings(values, { now = clock(), reason = 'explicit-test', expiresAt } = {}) {
    return exclusive(async () => {
      if (Boolean(state.manualMode)) throw failure('H66_MANUAL_CONFLICT', 'Restore the current manual settings before testing a native override.');
      state.phase = 'test';
      const changed = await apply(values, { now, reason, expiresAt });
      const result = { status: 'confirmed', phase: state.phase, changed, expiresAt: state.expiresAt };
      await saveResult(result); return result;
    });
  }
  function manualConflict(pauseId, now = clock()) {
    if (state.manualMode && state.pauseId === (pauseId ?? null)
      && (state.expiresAt === null || timestamp(state.expiresAt) > now)) return restoreRequired;
    return restoreRequired || Object.keys(state.obligations).length > 0 || !['normal', 'recovery'].includes(state.phase);
  }
  function settleNative(request, readback, dispatchedAt = request.dispatchedAt) {
    if (state.lastManual?.at !== request.at || state.lastManual?.register !== request.register
      || state.lastManual?.value !== request.value) return;
    const register = request.register, obligation = state.obligations[register];
    // A later temporary owner cannot be released by an older native receipt.
    if (!obligation || obligation.originalAt <= request.at) {
      delete state.obligations[register]; delete state.baseline[register]; delete state.requested[register];
      if (register === '0203') state.manualPreheat = null;
      if (!Object.keys(state.obligations).length) {
        state.phase = 'normal'; state.baseline = {}; state.requested = {};
        state.expiresAt = null; state.pauseId = null; state.manualMode = null; restoreRequired = false;
      }
    }
    const { code, error, ...receipt } = request;
    state.lastManual = { ...receipt, status: 'confirmed', confirmed: true,
      sent: Number.isFinite(dispatchedAt) ? true : request.sent,
      ...(Number.isFinite(dispatchedAt) ? { dispatchedAt } : {}),
      readback: readback.value, confirmedAt: readback.receivedAt };
    state.lastResult = { status: 'confirmed', reason: 'native-setting', register, value: request.value,
      confirmed: true, sent: state.lastManual.sent, at: clock() };
    const context = observeTariff();
    if (register === '0203' && context?.mode === 'normal' && !state.obligations['0203'])
      state.tariffRoom = { ...context, normalC: readback.value, reducedC: null, awaitingNormal: false };
    event('h66-native-setting-confirmed', { register, value: request.value,
      previousValue: request.previousValue, sent: state.lastManual.sent,
      ...(Number.isFinite(dispatchedAt) ? { dispatchedAt, receivedAt: readback.receivedAt } : {}) });
  }
  /** Ordinary device edits establish the pump's native settings. They have no
   * restoration deadline and are never replayed from saved intent. Later thermal
   * overrides capture their own baseline from fresh pump readback. */
  async function setSetting(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['register', 'value', 'now'].includes(key)))
      throw failure('H66_SETTINGS_INVALID', 'Choose an H66 register and value.');
    const { register, value, now = clock() } = options;
    validateValues({ [register]: value });
    if (preparation) throw failure('H66_BUSY', 'Wait for Preheat preparation to finish.');
    if (manualConflict(state.pauseId ?? undefined))
      throw failure('H66_MANUAL_CONFLICT', 'Wait for the current controller override or restoration before changing a native setting.');
    return exclusive(async () => {
      requireConnection(clock());
      const previous = current(register, clock());
      if (!previous) throw failure('H66_BASELINE_UNAVAILABLE', 'A fresh native-setting reading is required.');
      const changed = !equal(previous.value, value);
      const check = () => {
        requireConnection(clock());
        if (closing) throw failure('H66_CLOSED', 'H66 is closing; no new setting changes are accepted.');
        const latest = current(register, clock());
        if (!latest) throw failure('H66_BASELINE_UNAVAILABLE', 'A fresh native-setting reading is required.');
        if (!equal(latest.value, previous.value)) throw failure('H66_SETTING_CHANGED', 'The native setting changed while its command was waiting.');
        if (manualConflict(state.pauseId ?? undefined)) throw failure('H66_MANUAL_CONFLICT', 'A native-setting restoration became necessary while saving the command.');
      };
      const supersede = () => {
        delete state.obligations[register]; delete state.baseline[register]; delete state.requested[register];
        if (register === '0203') state.manualPreheat = null;
        if (!Object.keys(state.obligations).length) {
          state.phase = 'normal'; state.baseline = {}; state.requested = {};
          state.expiresAt = null; state.pauseId = null; state.manualMode = null; restoreRequired = false;
        }
      };
      // An existing temporary boost keeps its restoration duty until the new
      // native value is confirmed. Failed delivery must not strand that boost.
      // Reasserting the current value deliberately promotes it immediately.
      const requested = { register, value, previousValue: previous.value, at: now, scope: 'native-setting',
        status: 'pending', confirmed: false, sent: changed ? null : false };
      let attempt;
      try { await writeState(() => {
        check();
        if (!changed) supersede();
        state.lastManual = requested;
        if (changed) attempt = createControlAttempt({ store, context: 'heat-pump-command' });
      }); } catch (error) { attempt?.fail(error); attempt?.finish(); throw error; }
      armExpiry();
      try {
        check();
        const readback = changed ? await publishAndReadback(register, value, check, attempt) : previous;
        await writeState(() => {
          settleNative({ ...requested, sent: changed }, readback, readback.dispatchedAt);
        });
        return copy(state.lastManual);
      } catch (error) {
        attempt?.fail(error);
        const code = ['H66_READBACK_TIMEOUT', 'H66_WRITE_FAILED', 'H66_DISCONNECTED', 'H66_CLOSED'].includes(error?.code)
          ? error.code : 'H66_WRITE_FAILED';
        await writeState(() => { state.lastManual = { ...state.lastManual,
          status: Number.isFinite(error.dispatchedAt) ? 'unconfirmed' : 'failed', confirmed: false, code,
          sent: Number.isFinite(error.dispatchedAt),
          ...(Number.isFinite(error.dispatchedAt) ? { dispatchedAt: error.dispatchedAt } : {}) };
          const reading = current(register);
          if (Number.isFinite(error.dispatchedAt) && reading && reading.revision > error.dispatchedRevision
            && reading.revision <= (committedRevisions.get(register) ?? -1)
            && reading.receivedAt >= (error.dispatchedAt ?? requested.at) && equal(reading.value, value))
            settleNative(state.lastManual, reading);
        });
        if (state.lastManual.confirmed) return copy(state.lastManual);
        throw failure(code, 'The native setting change was not confirmed. Check its live value before trying again.');
      } finally { attempt?.finish(); }
    });
  }
  async function setPhase({ phase, roomBoostC = 5, normalRoomC, validateActivation, compressorOnly = false, holdDhwReduced = false, now = clock(), expiresAt, activationExpiresAt = expiresAt, manual = false, pauseId = null } = {}) {
    if (!['normal', 'recovery', 'preheat', 'reduction'].includes(phase)) throw failure('H66_PHASE_INVALID', 'Unknown H66 control phase.');
    if (pauseId !== null && (!manual || typeof pauseId !== 'string' || !pauseId))
      throw failure('H66_MANUAL_CONFLICT', 'A held heating selection requires its active pause.');
    if (phase === 'normal' || phase === 'recovery' && !compressorOnly && !holdDhwReduced) return restore({ now, reason: phase, phase });
    return exclusive(async () => {
      if (state.manualMode && (!manual || state.pauseId !== pauseId))
        throw failure('H66_MANUAL_CONFLICT', 'Restore the current manual settings before changing control ownership.');
      requireConnection(now);
      if (restoreRequired) throw failure('H66_RESTORATION_PENDING', 'Previous H66 overrides are being restored.');
      if (phase === 'preheat' && !state.obligations['0203'] && (!normalRoomReady()
        || normalRoomC !== undefined && !equal(current('0203', clock())?.value, normalRoomC)))
        throw failure('H66_NORMAL_ROOM_UNCONFIRMED', 'Waiting for normal ROOM setting.');
      // A cycle starts from current normal settings, never from a reduced ROOM value.
      if (!SETTINGS.every(index => Object.hasOwn(state.baseline, index))) {
        captureBaselines(SETTINGS, now);
        if (![config.normalMode ?? 1, config.compressorOnlyMode ?? 2].includes(state.baseline['2201'])) {
          state.baseline = {};
          throw failure('H66_NATIVE_MODE', 'The pump is in a manually selected operating mode.');
        }
        // The first command persists these baselines with its restoration
        // obligation after write admission; a baseline alone grants no control.
      }
      let changed = [];
      if (phase === 'recovery') {
        // Space heating resumes immediately. DHW demand and AUX have separate
        // ownership so a cold-room fallback can permit AUX without ending the hold.
        for (const index of ['0203', ...(!holdDhwReduced ? ['0212', '0208'] : []), ...(!compressorOnly ? ['2201'] : [])]) if (state.obligations[index])
          changed.push(...await apply({ [index]: state.baseline[index] }, { now, reason: 'recovery', restoring: true }));
        const values = { ...(holdDhwReduced ? { '0212': Math.min(40, state.baseline['0212']), '0208': 50 } : {}),
          ...(compressorOnly ? { '2201': config.compressorOnlyMode ?? 2 } : {}) };
        if (Object.keys(values).length) changed.push(...await apply(values, { now, reason: 'recovery-hold', expiresAt, activationExpiresAt }));
      } else if (phase === 'preheat') {
        if (state.phase === 'reduction') throw failure('H66_PHASE_CONFLICT', 'Restore normal operation before starting preheat.');
        if (!Number.isFinite(roomBoostC) || roomBoostC < 0 || roomBoostC > 5) throw failure('H66_BOOST_INVALID', 'Preheat ROOM increase must be 0–5°C after device limits.');
        // Starting Preheat always returns DHW and AUX to their captured native
        // settings, including when the preceding phase was a recovery hold.
        for (const index of ['0212', '0208', '2201']) if (state.obligations[index])
          changed.push(...await apply({ [index]: state.baseline[index] }, { now, reason: 'preheat-normal-service', restoring: true }));
        if (!state.obligations['0203'] && (!normalRoomReady() || !equal(current('0203')?.value, state.baseline['0203'])))
          throw failure('H66_NORMAL_ROOM_UNCONFIRMED', 'The normal ROOM setting changed before Preheat.');
        const validatePreheat = () => {
          validateActivation?.();
          const tariff = liveTariff();
          if (tariff?.mode !== 'normal' || tariff.identity !== state.tariffRoom?.identity)
            throw failure('H66_TARIFF_UNCONFIRMED', 'Normal tariff relay readback was lost before Preheat dispatch.');
        };
        changed.push(...await apply({ '0203': Math.min(LIMITS['0203'][1], state.baseline['0203'] + roomBoostC) },
          { now, reason: 'preheat', expiresAt, activationExpiresAt, validateActivation: validatePreheat }));
      } else {
        // ROOM restoration completes before reduction settings are sent. The executor owns DHWR.
        if (state.obligations['0203']) changed.push(...await apply({ '0203': state.baseline['0203'] }, { now, reason: 'preheat-complete', restoring: true }));
        changed.push(...await apply({ '0212': Math.min(40, state.baseline['0212']),
          '0208': 50, '2201': config.compressorOnlyMode ?? 2 }, { now, reason: 'reduction', expiresAt, activationExpiresAt, manualPause: manual && pauseId !== null }));
      }
      return writeState(() => {
        state.phase = phase;
        state.manualMode = manual ? phase : null;
        state.pauseId = manual ? pauseId : null;
        if (manual && phase === 'preheat') state.manualPreheat = { enabled: true, confirmed: true,
          baseValue: state.baseline['0203'], roomSettingC: Math.min(LIMITS['0203'][1], state.baseline['0203'] + roomBoostC),
          roomBoostC, expiresAt: state.expiresAt, pauseId, at: now };
        const result = { status: 'confirmed', phase, changed, expiresAt: state.expiresAt,
          ...(phase === 'preheat' ? { roomSettingC: Math.min(LIMITS['0203'][1], state.baseline['0203'] + roomBoostC),
            roomBoostC: Math.min(LIMITS['0203'][1] - state.baseline['0203'], roomBoostC) } : {}),
          limitation: phase === 'reduction' || holdDhwReduced ? 'DHW stop setting may apply only to auxiliary operation; compressor DHW cutoff is not established.' : undefined };
        state.lastResult = { ...result, at: clock() };
        return result;
      });
    });
  }
  async function updatePause({ id, expiresAt, now = clock() }) {
    const end = deadline(now, expiresAt, true);
    await writeState(() => {
      if (state.pauseId !== id || !state.manualMode || state.manualMode === 'preheat') return;
      state.expiresAt = end;
    });
    armExpiry();
  }
  function ingestionCheckpoint() {
    // Preserve obligation object identity: an in-flight restoration holds these
    // exact tokens to avoid clearing a later owner's replacement obligation.
    return { state: { ...state, baseline: { ...state.baseline }, obligations: { ...state.obligations }, requested: { ...state.requested } },
      readings: new Map(readings), revision, lastPublicationAt, compressorState, restoreRequired, normalBoundary,
      committedRevisions: new Map(committedRevisions) };
  }
  function restoreIngestionCheckpoint(checkpoint) {
    ({ state, revision, lastPublicationAt, compressorState, restoreRequired, normalBoundary } = checkpoint);
    committedRevisions.clear(); for (const [index, value] of checkpoint.committedRevisions) committedRevisions.set(index, value);
    readings.clear(); for (const [index, reading] of checkpoint.readings) readings.set(index, reading);
  }
  function ingest(reading, { afterCommit = effect => effect() } = {}) {
    if (closed || !reading || reading.deviceId !== deviceId || !H66_REGISTERS[reading.register] || reading.duplicate) return;
    const previous = readings.get(reading.register);
    if (reading.usableForControl && previous?.usableForControl && previous.receivedAt <= clock() && reading.receivedAt < previous.receivedAt) return;
    const beforeContext = state.tariffRoom;
    observeTariff();
    if (reading.register === '1A01') trackCompressor(reading);
    reading = { ...reading, revision: ++revision, connectionGeneration };
    const prior = readings.get(reading.register);
    if (reading.usableForControl || !prior?.usableForControl) readings.set(reading.register, copy(reading));
    if (reading.usableForControl) lastPublicationAt = reading.receivedAt;
    observeRoom(reading);
    if (state.tariffRoom !== beforeContext) persist();
    if (reading.usableForControl)
      afterCommit(() => { committedRevisions.set(reading.register, Math.max(committedRevisions.get(reading.register) ?? -1, reading.revision)); });
    afterCommit(() => wakePreparation?.());
    if (reading.usableForControl && state.lastManual?.status === 'unconfirmed'
      && state.lastManual.sent !== false
      && state.lastManual.register === reading.register
      && reading.receivedAt >= (state.lastManual.dispatchedAt ?? state.lastManual.at)
      && equal(reading.value, state.lastManual.value)) {
      settleNative(state.lastManual, reading);
      persist();
    }
    const waiter = pending.get(reading.register);
    if (waiter && reading.usableForControl && reading.revision > waiter.revision
      && reading.receivedAt >= waiter.after && equal(reading.value, waiter.value)) {
      afterCommit(() => waiter.finish(null, reading));
      return;
    }
    const obligation = state.obligations[reading.register];
    const watched = !obligation && !Boolean(state.manualMode)
      && ['preheat', 'reduction', 'recovery'].includes(state.phase)
      && Object.hasOwn(state.requested, reading.register);
    if (!waiter && reading.usableForControl && (obligation?.confirmed && !equal(reading.value, obligation.expected)
      || watched && !equal(reading.value, state.requested[reading.register]))) {
      delete state.obligations[reading.register];
      state.baseline[reading.register] = reading.value;
      state.externalChangeRevision=(state.externalChangeRevision??0)+1;
      state.externalChangeAt=clock();
      if (!state.manualMode) { state.phase = 'external-change'; restoreRequired = true; }
      else {
        delete state.requested[reading.register]; delete state.baseline[reading.register];
        if (reading.register === '0203') state.manualPreheat = null;
      }
      noteResult({ status: 'external-change', register: reading.register, restorationPending: restoreRequired });
      event('h66-external-setting-preserved', { register: reading.register });
    }
    afterCommit(queueReconciliation);
  }
  function setConnected(value) {
    const next = Boolean(value);
    if (next && !connected) connectionGeneration++;
    connected = next;
    wakePreparation?.();
    if (!connected) {
      normalBoundary = null;
      lastPublicationAt = null;
      compressorState = null;
      if (state.manualMode === 'preheat') restoreRequired = true;
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
      preheatPreparation: copy(preparation), normalRoomReady: normalRoomReady(),
      manualPreheat: copy(state.manualPreheat ?? null),
      compressorState: compressorState ? { value: compressorState.value, since: compressorState.since,
        transitionObserved: compressorState.transitionObserved } : null,
      controlsReady: live && !closing && !preparation && SETTINGS.every(index => current(index, now)) && !restoreRequired,
      readings: Object.fromEntries([...readings].map(([index, reading]) => [index, { ...copy(reading),
        stale: !current(index, now), available: live && Boolean(current(index, now)),
        unavailableReasons: reading.connectionGeneration !== connectionGeneration ? ['awaiting-live-report'] : [],
        requested: state.requested[index] ?? null, baseline: state.baseline[index] ?? null }])),
      controls: Object.fromEntries(SETTINGS.map(index => [index, { register: index, signal: H66_REGISTERS[index].signal,
        available: live && !closing && !preparation && config.writeEnabled === true && Boolean(current(index, now)) && !manualConflict(state.pauseId, now) && !active,
        reason: closing ? 'H66 is closing.' : !live ? 'No recent live H66 publications.' : config.writeEnabled !== true ? 'Native setting writes are disabled.'
          : !current(index, now) ? 'A fresh setting baseline is not available.' : restoreRequired ? 'Restoration is pending.'
            : manualConflict(state.pauseId, now) ? 'A controller override is active.'
            : preparation ? preparation.reason : active ? 'A setting transition is in progress.' : null,
        unit: H66_REGISTERS[index].unit, min: LIMITS[index][0], max: LIMITS[index][1] }])),
      documentation: H66_DOCUMENTATION,
      limitation: 'Setting readback confirms a published register value, not compressor operation. Heat-pump parameter edits remain as native settings. Manual heating overrides restore their captured native settings when they end; restoration requires the application and MQTT connection.' };
  }
  async function test({ register, value, durationSeconds = 60, now = clock(), expiresAt } = {}) {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 900)
      throw failure('H66_TEST_DURATION', 'H66 tests must last 1–900 seconds.');
    validateValues({ [register]: value });
    const end = deadline(now, expiresAt ?? now + durationSeconds * 1000);
    if (end - now > 900_000) throw failure('H66_TEST_DURATION', 'H66 tests must last 1–900 seconds.');
    await writeState(() => { state.lastTest = { register, value, durationSeconds, at: now, expiresAt: end, status: 'pending' }; });
    try {
      const result = await writeSettings({ [register]: value }, { now, reason: 'explicit-test', expiresAt: end });
      await writeState(() => { state.lastTest = { ...state.lastTest, status: result.status, readback: current(register)?.value ?? null }; });
      return { ...result, register, value, at: now };
    } catch (error) {
      await writeState(() => { state.lastTest = { ...state.lastTest, status: 'failed', code: error.code ?? 'H66_WRITE_FAILED' }; });
      throw error;
    }
  }
  function beginShutdown({ restore = true } = {}) { closing = true; writes.beginShutdown({ restore }); }
  async function close() {
    beginShutdown({ restore: false });
    closed = true; connected = false; clearTimeout(expiryTimer);
    for (const waiter of [...pending.values()]) waiter.finish(failure('H66_CLOSED', 'H66 closed before setting readback.'));
    // Every physical command already had a committed obligation. Closing a
    // connection requires no new save and must not wait for another writer.
  }
  armExpiry();
  return { ingest, ingestionCheckpoint, restoreIngestionCheckpoint, setConnected, status, setPhase, preparePreheat, captureTariffReduction, updatePause, writeSettings, setSetting, restore, reconcile, test, beginShutdown, close };
}
