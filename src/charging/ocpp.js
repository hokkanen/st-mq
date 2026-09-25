import { createHash, randomInt } from 'node:crypto';
import { IDENTIFYING_REASON } from './identity-evidence.js';

const KIND = 'ocpp-tx-pause', MAX_PAUSE_MS = 48 * 3600_000, MIN_PAUSE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3, MAX_AGE_MS = 60_000;
const STATUSES = ['Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Reserved', 'Unavailable', 'Faulted'];
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = value => Number.isSafeInteger(value) && value >= 0;
const id = value => Number.isSafeInteger(value) && value > 0 && value < 2147483647;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => names.includes(key));
const fail = code => Object.assign(new Error(code), { code });
const iso = value => new Date(value).toISOString();
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const fresh = (at, now) => time(at) && at <= now && now - at <= MAX_AGE_MS;
const scopeValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** A restriction expires on the charger. No guessed positive current is written. */
export function ocppPauseInstruction({ profileId, transactionId, startAt, now }) {
  if (!id(profileId) || !id(transactionId) || !time(startAt) || !time(now)
    || startAt % 1000 || now % 1000 || startAt <= now || startAt - now > MAX_PAUSE_MS) throw fail('invalid-plan');
  const payload = { connectorId: 1, csChargingProfiles: { chargingProfileId: profileId, transactionId,
    stackLevel: 0, chargingProfilePurpose: 'TxProfile', chargingProfileKind: 'Absolute',
    validFrom: iso(now), validTo: iso(startAt), chargingSchedule: { startSchedule: iso(now),
      duration: (startAt - now) / 1000, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }] } } };
  return { profileId, transactionId, startAt, validFrom: now, payload, fingerprint: hash(payload) };
}

/** Composite output verifies the effective envelope, never individual ownership. */
export function normalizeOcppComposite(response, { now, duration }) {
  const schedule = response?.chargingSchedule, startAt = instant(response?.scheduleStart);
  if (response?.status !== 'Accepted' || response.connectorId !== 1 || !time(startAt)
    || Math.abs(startAt - now) > 10_000 || schedule?.chargingRateUnit !== 'A'
    || !Number.isSafeInteger(schedule.duration) || schedule.duration <= 0 || schedule.duration < duration
    || !Array.isArray(schedule.chargingSchedulePeriod) || !schedule.chargingSchedulePeriod.length
    || schedule.chargingSchedulePeriod.length > 24) throw fail('composite-unavailable');
  const periods = schedule.chargingSchedulePeriod.map((row, index, rows) => {
    if (!Number.isSafeInteger(row.startPeriod) || row.startPeriod < 0 || row.startPeriod >= schedule.duration
      || index === 0 && row.startPeriod !== 0 || index > 0 && row.startPeriod <= rows[index - 1].startPeriod
      || !Number.isFinite(row.limit) || row.limit < 0 || row.limit > 1000
      || row.numberPhases !== undefined && ![1, 2, 3].includes(row.numberPhases)) throw fail('composite-unavailable');
    return { startAt: startAt + row.startPeriod * 1000, limit: row.limit };
  });
  return { startAt, endAt: startAt + schedule.duration * 1000, periods };
}
const coversZero = (composite, from, until) => composite.startAt <= from && composite.endAt >= until
  && composite.periods.every((row, index) => row.startAt >= until
    || (composite.periods[index + 1]?.startAt ?? composite.endAt) <= from || row.limit === 0);

function snapshotFor(value, scope, now) {
  if (!fields(value, ['transport', 'scope', 'connectionId', 'readAt', 'online', 'connectorStatus', 'statusAt',
    'transactionId', 'transactionStartedAt', 'transactionConfirmed', 'pluggedIn', 'powerKw', 'powerAt', 'manualEvent', 'limits', 'supply'])
    || value.transport !== 'ocpp' || value.scope !== scope || typeof value.online !== 'boolean'
    || !time(value.readAt) || value.readAt > now || ![true, false, null].includes(value.pluggedIn)
    || value.online && (!text(value.connectionId) || !STATUSES.includes(value.connectorStatus)
      || !time(value.statusAt) || value.statusAt > now || !fresh(value.readAt, now))
    || value.transactionId !== null && !id(value.transactionId)
    || value.transactionId !== null && (!time(value.transactionStartedAt) || value.transactionStartedAt > now)
    || typeof value.transactionConfirmed !== 'boolean'
    || value.transactionConfirmed && value.transactionId === null
    || value.powerKw !== null && (!Number.isFinite(value.powerKw) || value.powerKw < 0)
    || value.powerAt !== null && (!time(value.powerAt) || value.powerAt > now)) throw fail('read-failed');
  const event = value.manualEvent;
  if (event != null && (!fields(event, ['id', 'kind', 'at', 'transactionId']) || !text(event.id)
    || !['stop', 'release'].includes(event.kind) || !time(event.at) || event.at > now
    || event.transactionId !== null && !id(event.transactionId))) throw fail('read-failed');
  return clone(value);
}

export function createOcppScheduleAdapter({ request, readSnapshot, isCurrent = () => false,
  scope, clock = Date.now, canControl = () => false } = {}) {
  if (!scopeValid(scope) || typeof request !== 'function' || typeof readSnapshot !== 'function') throw fail('invalid-ocpp-adapter');
  const adapter = {
    scope, ownershipNamespace: 'ocpp', capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: true },
    async read({ signal } = {}) { return snapshotFor(await readSnapshot({ signal }), scope, clock()); },
    async composite(snapshot, until, { signal, guard = () => true } = {}) {
      const now = clock(), duration = Math.max(60, Math.ceil((until - now) / 1000));
      if (duration > MAX_PAUSE_MS / 1000 + 60) throw fail('invalid-plan');
      const reply = await request('GetCompositeSchedule', { connectorId: 1, duration, chargingRateUnit: 'A' },
        { signal, guard: () => canControl() && guard() && isCurrent(snapshot) });
      if (!isCurrent(snapshot) || !guard()) throw fail('control-revoked');
      return normalizeOcppComposite(reply, { now, duration });
    },
    async install(instruction, snapshot, { signal, guard = () => true, beforeWrite = () => {} } = {}) {
      const allowed = () => canControl() && guard() && isCurrent(snapshot) && snapshot.transactionConfirmed
        && snapshot.transactionId === instruction.transactionId && instruction.startAt - clock() >= MIN_PAUSE_MS;
      if (!allowed()) throw fail('control-revoked');
      const before = await adapter.read({ signal });
      if (!allowed() || !before.online || !fresh(before.readAt, clock())
        || before.connectionId !== snapshot.connectionId || !before.transactionConfirmed
        || before.transactionId !== instruction.transactionId || before.pluggedIn !== true
        || ['Unavailable', 'Faulted', 'Reserved'].includes(before.connectorStatus)
        || before.manualEvent?.id !== snapshot.manualEvent?.id) throw fail('control-revoked');
      await beforeWrite(before);
      const beforeSend = () => allowed() && isCurrent(before, { unchangedStatus: true });
      if (!beforeSend()) throw fail('control-revoked');
      // A natural stop while queued cannot become our identity response. This
      // extra guard runs only before send: a successful command is expected to
      // change Charging to SuspendedEVSE before its acknowledgement can arrive.
      const reply = await request('SetChargingProfile', clone(instruction.payload), { signal, guard: allowed, beforeSend });
      if (reply?.status !== 'Accepted') throw fail('profile-rejected');
    },
    async clear(instruction, snapshot, { signal, guard = () => true } = {}) {
      if (!id(instruction?.profileId)) throw fail('invalid-plan');
      const allowed = () => canControl() && guard() && isCurrent(snapshot, { requireTransaction: false });
      if (!allowed()) throw fail('control-revoked');
      const reply = await request('ClearChargingProfile', { id: instruction.profileId }, { signal, guard: allowed });
      if (!['Accepted', 'Unknown'].includes(reply?.status)) throw fail('profile-rejected');
    },
    normalize(snapshot = {}, { now = clock() } = {}) {
      const available = snapshot.online === true && fresh(snapshot.readAt, now) && time(snapshot.statusAt) && snapshot.statusAt <= now;
      const signal = (value, at = snapshot.statusAt, source = 'easee-ocpp') => ({
        value: available && value != null ? value : null, available: available && value != null,
        source, measuredAt: at ?? null, receivedAt: snapshot.readAt ?? null });
      const limits = snapshot.limits ?? {}, supply = snapshot.supply ?? {};
      const ceilings = [limits.chargerA, limits.cableA, ...(limits.circuitA ?? [])].filter(value => Number.isFinite(value) && value > 0);
      const allowance = limits.equalizerAvailableA;
      const complete = values => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite);
      return { ...snapshot, provider: 'easee', providerConnected: available, capabilities: adapter.capabilities,
        connected: signal(snapshot.pluggedIn), charging: signal(STATUSES.includes(snapshot.connectorStatus) ? snapshot.connectorStatus === 'Charging' : null),
        powerKw: signal(fresh(snapshot.powerAt, now) ? snapshot.powerKw : null, snapshot.powerAt),
        currentA: signal(complete(allowance) && ceilings.length ? Math.min(...allowance, ...ceilings) : null),
        availableCurrentA: signal(complete(allowance) ? Math.min(...allowance) : null),
        maxCurrentA: signal(ceilings.length ? Math.min(...ceilings) : null),
        actualCurrentA: signal(complete(supply.chargerCurrentA) ? supply.chargerCurrentA.reduce((sum, value) => sum + value, 0) / 3 : null),
        voltageV: signal(complete(supply.voltageV) ? supply.voltageV.reduce((sum, value) => sum + value, 0) / 3 : null),
        phases: { value: 3, available: true, source: 'installation-assumption', assumed: true },
        scheduledStartAt: signal(snapshot.nativeInstruction?.startAt ?? null, snapshot.nativeInstruction?.confirmedAt),
        scheduledEndAt: signal(null), scheduledEndKind: null, scheduleKind: 'ocpp-tx-pause' };
    },
    createController: options => createOcppChargingController({ ...options, adapter }),
  };
  return adapter;
}

export function initialOcppControllerState(scope) {
  if (!scopeValid(scope)) throw fail('invalid-ocpp-adapter');
  return { version: 1, kind: KIND, scope, nextProfileId: randomInt(1, 1_000_000_000), owned: null, pending: null,
    manual: null, lastManualEvent: null, execution: null, session: null, released: false, provisional: false, vehicleDisconnect: null };
}
function validInstruction(value) {
  if (!fields(value, ['profileId', 'transactionId', 'startAt', 'validFrom', 'payload', 'fingerprint', 'confirmedAt', 'requestedAt', 'pauseRequestedAt'])) return false;
  try {
    const expected = ocppPauseInstruction({ ...value, now: value.validFrom });
    return value.fingerprint === expected.fingerprint && JSON.stringify(value.payload) === JSON.stringify(expected.payload)
      && (value.confirmedAt === undefined || time(value.confirmedAt)) && (value.requestedAt === undefined || time(value.requestedAt))
      && (value.pauseRequestedAt === undefined || time(value.pauseRequestedAt) && time(value.requestedAt)
        && value.pauseRequestedAt >= value.requestedAt
        && (value.confirmedAt === undefined || value.pauseRequestedAt <= value.confirmedAt));
  } catch { return false; }
}
function executionFor(plan) {
  if (!plan || !Array.isArray(plan.periods) || !plan.periods.length || plan.periods.length > 24) return null;
  const periods = plan.periods.map(row => ({ startAt: row.startAt, endAt: row.endAt }));
  if (periods.some((row, index) => !time(row.startAt)
    || row.endAt !== null && (!time(row.endAt) || row.endAt <= row.startAt)
    || index < periods.length - 1 && row.endAt === null || index > 0 && row.startAt < periods[index - 1].endAt)) return null;
  const planId = plan.id ?? plan.planId ?? null, deadlineAt = plan.deadlineAt ?? null;
  if (planId !== null && !text(planId) || deadlineAt !== null && !time(deadlineAt)) return null;
  return { planId, periods, finalStartAt: periods.at(-1).startAt, deadlineAt };
}
function revisedExecution(plan, prior, now) {
  const revision = plan?.priceRevision, next = executionFor(plan);
  if (!prior || !revision || !next || !next.planId || next.planId === prior.planId
    || revision.previousPlanId !== prior.planId || !time(revision.at) || revision.at > now
    || revision.at < prior.periods[0].startAt || plan.feasible !== true || plan.provisional === true
    || !Number.isFinite(plan.requiredGridKwh) || plan.requiredGridKwh <= 0
    || !time(next.deadlineAt) || next.deadlineAt <= now || next.deadlineAt !== prior.deadlineAt
    || next.periods[0].startAt < revision.at) return null;
  const elapsed = prior.periods.filter(row => row.startAt < revision.at).map(row => ({
    startAt: row.startAt, endAt: Math.min(row.endAt ?? revision.at, revision.at),
  }));
  const periods = [];
  for (const row of [...elapsed, ...next.periods]) {
    const previous = periods.at(-1);
    if (previous?.endAt === row.startAt) previous.endAt = row.endAt;
    else periods.push({ ...row });
  }
  return periods.length <= 24 ? { ...next, periods, finalStartAt: periods.at(-1).startAt } : null;
}
const validExecution = value => value === null || fields(value, ['planId', 'periods', 'finalStartAt', 'deadlineAt'])
  && JSON.stringify(executionFor(value)) === JSON.stringify(value);
function validState(state, scope) {
  const keys = Object.keys(initialOcppControllerState(scope));
  return fields(state, keys) && keys.every(key => Object.hasOwn(state, key)) && state.version === 1 && state.kind === KIND && state.scope === scope
    && id(state.nextProfileId) && typeof state.released === 'boolean' && typeof state.provisional === 'boolean'
    && (state.owned === null || validInstruction(state.owned) && state.owned.profileId < state.nextProfileId)
    && (state.pending === null || fields(state.pending, ['action', 'instruction', 'attempts', 'nextAttemptAt', 'accepted', 'execution'])
      && ['install', 'clear'].includes(state.pending.action) && validInstruction(state.pending.instruction) && state.pending.instruction.profileId < state.nextProfileId
      && Number.isInteger(state.pending.attempts) && state.pending.attempts >= 0 && state.pending.attempts <= MAX_ATTEMPTS
      && time(state.pending.nextAttemptAt) && typeof state.pending.accepted === 'boolean' && validExecution(state.pending.execution))
    && (state.manual === null || fields(state.manual, ['id', 'kind', 'at', 'transactionId']) && text(state.manual.id)
      && ['stop', 'release'].includes(state.manual.kind) && time(state.manual.at) && (state.manual.transactionId === null || id(state.manual.transactionId)))
    && (state.lastManualEvent === null || fields(state.lastManualEvent, ['id', 'at']) && text(state.lastManualEvent.id) && time(state.lastManualEvent.at))
    && (state.session === null || fields(state.session, ['transactionId', 'connected', 'connectedAt', 'lastDisconnectedAt'])
      && (state.session.transactionId === null || id(state.session.transactionId)) && [true, false, null].includes(state.session.connected)
      && (state.session.connectedAt === null || time(state.session.connectedAt)) && (state.session.lastDisconnectedAt === null || time(state.session.lastDisconnectedAt)))
    && validExecution(state.execution)
    && (state.vehicleDisconnect === null || fields(state.vehicleDisconnect, ['source', 'readingId', 'endedConnectedAt', 'measuredAt', 'receivedAt', 'awaitingConnection'])
      && ['easee-stream', 'bmw-cardata'].includes(state.vehicleDisconnect.source) && text(state.vehicleDisconnect.readingId)
      && [state.vehicleDisconnect.endedConnectedAt, state.vehicleDisconnect.measuredAt, state.vehicleDisconnect.receivedAt].every(time)
      && typeof state.vehicleDisconnect.awaitingConnection === 'boolean');
}

const REASONS = {
  'read-failed': 'The native charger state is unavailable.', 'composite-unavailable': 'The charger did not provide a usable native schedule envelope.',
  'profile-rejected': 'The charger rejected the native profile command.', 'control-revoked': 'Native charging authority or the connection changed.',
  'invalid-plan': 'The proposed native charging pause is not valid.', 'retry-limit': 'The native command remains unconfirmed after three attempts.',
  'command-failed': 'The native charger command is unconfirmed.', 'storage-failed': 'Charging intent could not be saved.',
};

/** Current transaction only; no cloud schedule is presented as native readback. */
export function createOcppChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan } = {}) {
  if (!adapter || !scopeValid(adapter.scope)) throw fail('invalid-ocpp-adapter');
  if (initialState !== null && !validState(initialState, adapter.scope)) throw Error('Unsupported native charging ownership; start a fresh development database');
  let state = initialState ? clone(initialState) : initialOcppControllerState(adapter.scope);
  let snapshot = null, desired = { enabled: false, plan: null }, closed = false, generation = 0, queue = Promise.resolve(), abort = null;
  let phase = 'off', reason = 'Automatic charging is off.', errorCode = null, ownsInstruction = false, pauseConfirmed = false, handoverConfirmed = true;
  let planningRevision = null;
  const chargeNowActive = () => Number.isSafeInteger(desired.chargeNow?.connectedAt)
    && desired.chargeNow.connectedAt === state.session?.connectedAt && snapshot?.pluggedIn === true
    && snapshot.transactionConfirmed && !state.vehicleDisconnect?.awaitingConnection;
  const controlRequested = () => desired.enabled === true || chargeNowActive();
  const status = () => ({ ...clone(state), phase, reason, errorCode, enabled: desired.enabled === true,
    ownsInstruction, pauseConfirmed, handoverConfirmed, planningRevision,
    snapshot: snapshot ? { ...clone(snapshot), nativeInstruction: ownsInstruction ? clone(state.owned) : null } : null });
  const display = (next, message, code = null) => { phase = next; reason = message; errorCode = code; return status(); };
  async function commit(changes) {
    if (closed) throw fail('control-revoked');
    const next = { ...state, ...changes };
    try { await saveState(clone(next)); } catch { throw fail('storage-failed'); }
    state = next;
  }
  const canWrite = current => !closed && current === generation && canControl();
  async function clearInstruction(instruction, current, signal) {
    if (!state.pending || state.pending.action !== 'clear' || state.pending.instruction.fingerprint !== instruction.fingerprint)
      await commit({ pending: { action: 'clear', instruction, execution: null, attempts: 0, nextAttemptAt: 0, accepted: false } });
    return dispatch(current, signal);
  }
  async function dispatch(current, signal) {
    let pending = state.pending;
    if (!pending || !canWrite(current)) throw fail('control-revoked');
    if (pending.nextAttemptAt > clock()) return false;
    if (!pending.accepted) {
      if (pending.attempts >= MAX_ATTEMPTS) throw fail('retry-limit');
      const attempts = pending.attempts + 1;
      await commit({ pending: { ...pending, attempts, nextAttemptAt: clock() + (attempts === 1 ? 30_000 : 120_000) } });
      if (!canWrite(current)) throw fail('control-revoked');
      const options = { signal, guard: () => canWrite(current) };
      if (pending.action === 'install') await adapter.install(pending.instruction, snapshot, { ...options,
        beforeWrite: async before => {
          if (!canWrite(current)) throw fail('control-revoked');
          const { pauseRequestedAt: _priorWitness, ...instruction } = state.pending.instruction;
          // Installation intent exists even when already stopped. Only a fresh
          // guarded Charging observation may witness a causal identity pause.
          // Retry from a stopped state drops the earlier uncertain witness.
          await commit({ pending: { ...state.pending, instruction: { ...instruction,
            ...(before.connectorStatus === 'Charging' ? { pauseRequestedAt: clock() } : {}) } } });
        } });
      else await adapter.clear(pending.instruction, snapshot, options);
      if (!canWrite(current)) throw fail('control-revoked');
      await commit({ pending: { ...state.pending, accepted: true, nextAttemptAt: 0 } });
      pending = state.pending;
    }
    if (pending.action === 'clear') {
      // Accepted/Unknown addresses this exact ID. Another zero profile may still
      // restrict charging; clearing ours does not assert an unrestricted car.
      await commit({ owned: null, pending: null }); ownsInstruction = pauseConfirmed = false; return true;
    }
    if (clock() >= pending.instruction.startAt) { await commit({ owned: null, pending: null }); return true; }
    const composite = await adapter.composite(snapshot, pending.instruction.startAt + 60_000, { signal, guard: () => canWrite(current) });
    if (!coversZero(composite, Math.max(clock(), composite.startAt), pending.instruction.startAt)) throw fail('readback-mismatch');
    await commit({ owned: { ...pending.instruction, confirmedAt: clock() }, execution: pending.execution, released: false, provisional: false, pending: null }); ownsInstruction = true;
    return true;
  }
  async function reconcile(current) {
    if (closed || current !== generation) return status();
    const signal = abort.signal;
    ownsInstruction = pauseConfirmed = false;
    try {
      if (desired.replan === true) {
        await commit({ released: false, execution: null, provisional: false });
        planningRevision = desired.controlsRevision ?? null; desired.replan = false;
        phase = 'unavailable';
      }
      const boundary = desired.vehicleDisconnect;
      if (boundary && text(boundary.readingId) && ['easee-stream', 'bmw-cardata'].includes(boundary.source)
        && [boundary.endedConnectedAt, boundary.measuredAt, boundary.receivedAt].every(time)
        && boundary.measuredAt <= clock() && boundary.receivedAt <= clock()
        && boundary.readingId !== state.vehicleDisconnect?.readingId
        && (!state.vehicleDisconnect || boundary.measuredAt > state.vehicleDisconnect.measuredAt))
        await commit({ vehicleDisconnect: { source: boundary.source, readingId: boundary.readingId, endedConnectedAt: boundary.endedConnectedAt,
          measuredAt: boundary.measuredAt, receivedAt: boundary.receivedAt, awaitingConnection: true }, execution: null, released: false });
      snapshot = await adapter.read({ signal });
      if (closed || current !== generation) return status();
      if (!snapshot.online || !fresh(snapshot.readAt, clock())) return display('unavailable', 'The local charger connection is unavailable; existing bounded profiles may still apply.', 'offline');
      const prior = state.session;
      const changedTransaction = prior?.transactionId !== null && prior?.transactionId !== undefined
        && snapshot.transactionConfirmed && snapshot.transactionId !== prior.transactionId;
      const disconnected = snapshot.pluggedIn === false;
      const awaiting = state.vehicleDisconnect?.awaitingConnection && !(snapshot.transactionConfirmed
        && snapshot.transactionStartedAt > state.vehicleDisconnect.measuredAt);
      const lastDisconnectedAt = Math.max(prior?.lastDisconnectedAt ?? -1, state.vehicleDisconnect?.measuredAt ?? -1,
        disconnected ? snapshot.statusAt : -1);
      const session = { transactionId: snapshot.transactionConfirmed ? snapshot.transactionId : prior?.transactionId ?? null,
        connected: disconnected ? false : awaiting ? null : snapshot.pluggedIn,
        connectedAt: disconnected ? null : changedTransaction || prior?.connectedAt == null
          ? snapshot.transactionStartedAt ?? snapshot.statusAt : prior.connectedAt,
        lastDisconnectedAt: lastDisconnectedAt >= 0 ? lastDisconnectedAt : null };
      await commit({ session, ...(state.vehicleDisconnect && !awaiting ? { vehicleDisconnect: { ...state.vehicleDisconnect, awaitingConnection: false } } : {}),
        ...(changedTransaction || disconnected ? { execution: null, released: false, provisional: false,
          manual: state.manual?.kind === 'stop' && !changedTransaction ? state.manual : null } : {}) });
      const event = snapshot.manualEvent;
      if (event && event.id !== state.lastManualEvent?.id && event.at > (state.lastManualEvent?.at ?? -1)
        && (event.transactionId === null || event.transactionId === snapshot.transactionId))
        await commit({ manual: event, lastManualEvent: { id: event.id, at: event.at }, execution: null, released: event.kind === 'release' });
      if (desired.resume && desired.resume === state.manual?.id) {
        await commit({ manual: null, released: false, execution: null }); desired.resume = null;
      }
      const instruction = state.pending?.instruction ?? state.owned;
      const wrongSession = instruction && snapshot.transactionConfirmed && instruction.transactionId !== snapshot.transactionId;
      const release = !controlRequested() || state.manual || disconnected || awaiting || wrongSession;
      if (release && instruction) {
        handoverConfirmed = false;
        if (!await clearInstruction(instruction, current, signal)) return display('unconfirmed', 'Native profile release is waiting for its bounded retry.');
        handoverConfirmed = true;
      }
      if (!controlRequested()) { await commit({ execution: null }); handoverConfirmed = !state.pending && !state.owned; return display('off', 'Automatic charging is off; external charger restrictions are preserved.'); }
      if (state.manual) return display('yielded', state.manual.kind === 'stop' ? 'A confirmed native stop has priority. Explicitly resume automatic charging when ready.'
        : 'A confirmed native release has priority until unplug or explicit resumption.');
      if (disconnected || awaiting) return display('disconnected', 'Waiting for a confirmed new charger transaction.');
      if (!canWrite(current)) throw fail('control-revoked');
      if (['Unavailable', 'Faulted', 'Reserved'].includes(snapshot.connectorStatus)) return display('unavailable', 'The charger is unavailable for automatic native scheduling.');
      if (!snapshot.transactionConfirmed || snapshot.transactionId === null || snapshot.pluggedIn !== true)
        return display('unavailable', 'Waiting for a current transaction confirmed on this connection.', 'transaction-unconfirmed');
      if (chargeNowActive()) {
        const restriction = state.pending?.instruction ?? state.owned;
        if (restriction && !await clearInstruction(restriction, current, signal)) return display('unconfirmed', 'Charge Now is waiting for the native profile release.');
        await commit({ execution: null, released: true, provisional: false });
        return display('released', 'Charge Now is active for this connection. Charger and vehicle limits still apply.');
      }
      if (desired.resetPlan) {
        await commit({ released: false, execution: null, provisional: false }); desired.resetPlan = false;
        display('unavailable', 'Updating the automatic charging plan.');
      }
      const previousInstruction = state.pending?.instruction ?? state.owned;
      if (previousInstruction && clock() >= previousInstruction.startAt) {
        // Explicitly clear our exact ID even after expiry; composite output can
        // remain restricted by somebody else's profile and is not ownership.
        if (!await clearInstruction(previousInstruction, current, signal)) return display('unconfirmed', 'Native expiry cleanup is waiting for its bounded retry.');
      }
      let plan = typeof getPlan === 'function' ? await getPlan(clone(snapshot)) : desired.plan;
      if (!canWrite(current)) throw fail('control-revoked');
      if (plan?.state === 'identifying') return display('identifying', IDENTIFYING_REASON);
      const priceRevision = revisedExecution(plan, state.execution, clock());
      if (plan?.priceRevision && !priceRevision) plan = null;
      const candidate = executionFor(plan);
      let execution = priceRevision ?? (state.execution && clock() >= state.execution.periods[0].startAt ? state.execution : candidate);
      if (!priceRevision && execution && clock() >= execution.periods[0].startAt && clock() < execution.finalStartAt
        && !execution.periods.some(row => row.startAt <= clock() && clock() < row.endAt)
        && candidate && candidate.planId !== execution.planId) {
        const remaining = candidate.periods.filter(row => row.endAt === null || row.endAt > clock());
        if (remaining.length) {
          const elapsed = execution.periods.filter(row => time(row.endAt) && row.endAt <= clock());
          remaining[0] = { ...remaining[0], startAt: Math.max(elapsed.at(-1)?.endAt ?? 0, remaining[0].startAt) };
          execution = { ...candidate, periods: [...elapsed, ...remaining] };
          if (execution.periods.length > 24) throw fail('invalid-plan');
        }
      }
      if (state.released && !state.provisional && !priceRevision) {
        const restriction = state.pending?.instruction ?? state.owned;
        if (restriction && !await clearInstruction(restriction, current, signal)) return display('unconfirmed', 'Native profile release is pending.');
        return display('released', 'Charging remains released beyond the minimum and deadline.');
      }
      let startAt = plan?.startAt, active = false, final = false;
      if (execution) {
        final = clock() >= execution.finalStartAt;
        active = !final && execution.periods.some(row => row.startAt <= clock() && clock() < row.endAt);
        startAt = execution.periods.find(row => row.startAt > clock())?.startAt ?? execution.finalStartAt;
      }
      if (plan?.provisional === true || plan?.feasible === false) { execution = null; startAt = clock(); active = final = false; }
      if (final || active || time(startAt) && startAt <= clock()) {
        const restriction = state.pending?.instruction ?? state.owned;
        if (restriction && !await clearInstruction(restriction, current, signal)) return display('unconfirmed', 'Native profile release is pending.');
        await commit({ execution, released: !active && plan?.provisional !== true && plan?.feasible !== false,
          provisional: plan?.provisional === true || plan?.feasible === false });
        return display(active ? 'active' : state.provisional ? 'provisional' : 'released', active
          ? 'This charging period is open. Later pauses require the local controller to remain available.'
          : 'Charging is released; existing charger and Equalizer limits still apply.');
      }
      if (!time(startAt)) return display('unavailable', 'Waiting for a charging plan.');
      startAt = Math.ceil(startAt / 1000) * 1000;
      if (state.pending && (state.pending.action === 'clear' || state.pending.instruction.startAt === startAt))
        if (!await dispatch(current, signal)) return display('unconfirmed', 'The native command is waiting for its bounded retry.');
      if (state.pending || state.owned?.startAt !== startAt) {
        const now = Math.floor(clock() / 1000) * 1000;
        if (startAt - clock() < MIN_PAUSE_MS || startAt - now > MAX_PAUSE_MS) throw fail('invalid-plan');
        const profileId = state.pending?.instruction.profileId ?? state.owned?.profileId ?? state.nextProfileId;
        if (profileId >= 2147483646) throw fail('invalid-plan');
        const next = { ...ocppPauseInstruction({ profileId, transactionId: snapshot.transactionId, startAt, now }),
          requestedAt: clock() };
        await commit({ nextProfileId: state.owned || state.pending ? state.nextProfileId : profileId + 1,
          pending: { action: 'install', instruction: next, execution, attempts: 0, nextAttemptAt: 0, accepted: false } });
        if (!await dispatch(current, signal)) return display('unconfirmed', 'Native pause installation is pending.');
      } else {
        const composite = await adapter.composite(snapshot, startAt + 60_000, { signal, guard: () => canWrite(current) });
        if (!coversZero(composite, Math.max(clock(), composite.startAt), startAt)) return display('unconfirmed', 'The native pause no longer matches the effective schedule.', 'readback-mismatch');
        if (JSON.stringify(execution) !== JSON.stringify(state.execution)) await commit({ execution });
        ownsInstruction = true;
      }
      const verifiedConnectionId = snapshot.connectionId;
      snapshot = await adapter.read({ signal });
      if (!canWrite(current)) throw fail('control-revoked');
      ownsInstruction = ownsInstruction && snapshot.online && snapshot.connectionId === verifiedConnectionId && snapshot.transactionConfirmed
        && snapshot.transactionId === state.owned?.transactionId && clock() < state.owned.startAt;
      pauseConfirmed = ownsInstruction && snapshot.transactionConfirmed && snapshot.transactionId === state.owned?.transactionId
        && snapshot.connectorStatus === 'SuspendedEVSE'
        && fresh(snapshot.powerAt, clock()) && snapshot.powerAt >= state.owned.requestedAt && snapshot.powerKw === 0;
      return display(pauseConfirmed ? 'paused' : 'pause-unconfirmed', pauseConfirmed
        ? 'The native pause is confirmed and expires at the planned start.'
        : 'The native pause envelope is confirmed; fresh physical pause evidence is still pending.');
    } catch (error) {
      if (closed || current !== generation) return status();
      handoverConfirmed = !controlRequested() ? false : null;
      const code = REASONS[error?.code] ? error.code : error?.code === 'readback-mismatch' ? 'readback-mismatch' : 'command-failed';
      return display(state.pending ? 'unconfirmed' : controlRequested() ? 'unavailable' : 'off',
        REASONS[code] ?? 'The native effective schedule did not confirm the requested pause.', code);
    }
  }
  return { status,
    update(input = {}) {
      desired = { ...desired, ...input, resetPlan: input.resume === true, resume: input.resume === true ? state.manual?.id ?? null : null };
      const current = ++generation;
      abort?.abort(); abort = new AbortController();
      queue = queue.catch(() => {}).then(() => reconcile(current));
      return queue.then(() => status());
    },
    invalidate() { generation++; abort?.abort(); },
    close() { closed = true; generation++; abort?.abort(); return queue.catch(() => {}); },
  };
}
