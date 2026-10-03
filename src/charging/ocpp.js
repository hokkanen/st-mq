import { createHash, randomInt } from 'node:crypto';
import { resolveChargingDeadline } from './settings.js';
import { TIME_ZONE } from '../domain/prices.js';
import { easeeScheduleTakeoverSupported, effectiveScheduleFingerprint, manualScheduleWindow, nextLocalOccurrence, normalizeScheduleState } from './easee.js';

const KIND = 'ocpp-tx-pause', MAX_PAUSE_MS = 48 * 3600_000, MIN_PAUSE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3, MAX_AGE_MS = 60_000;
const MAX_IDENTIFICATION_PAUSE_MS = 5 * 60_000;
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
function validIdentificationOwnership(value) {
  if (!['purpose', 'identificationId', 'identificationConnectedAt', 'mode'].some(key => Object.hasOwn(value, key))) return true;
  return value.purpose === 'identification' && text(value.identificationId) && value.identificationId.length <= 128
    && time(value.identificationConnectedAt) && time(value.requestedAt)
    && value.requestedAt >= value.validFrom && value.requestedAt - value.validFrom < 1000
    && value.identificationConnectedAt <= value.requestedAt && value.startAt > value.requestedAt
    && (value.mode === 'probe' ? value.startAt - value.requestedAt <= MAX_PAUSE_MS
      : value.mode === undefined && value.startAt - value.requestedAt <= MAX_IDENTIFICATION_PAUSE_MS);
}

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
  if (!fields(value, ['transport', 'scope', 'connectionId', 'readAt', 'online', 'connectorStatus', 'statusAt', 'statusReceivedAt',
    'transactionId', 'transactionStartedAt', 'transactionConfirmedAt', 'transactionProvenance', 'transactionConfirmed', 'pluggedIn', 'powerKw', 'powerAt', 'powerReceivedAt', 'appControl', 'limits', 'supply'])
    || value.transport !== 'ocpp' || value.scope !== scope || typeof value.online !== 'boolean'
    || !time(value.readAt) || value.readAt > now || ![true, false, null].includes(value.pluggedIn)
    || value.online && (!text(value.connectionId) || !STATUSES.includes(value.connectorStatus)
      || !time(value.statusAt) || value.statusAt > now || !fresh(value.readAt, now))
    || value.transactionId !== null && !id(value.transactionId)
    || value.transactionId !== null && (value.transactionProvenance === 'meter-values'
      ? value.transactionStartedAt !== null || !time(value.transactionConfirmedAt) || value.transactionConfirmedAt > now
      : !time(value.transactionStartedAt) || value.transactionStartedAt > now)
    || value.transactionProvenance !== undefined && value.transactionProvenance !== null
      && !['start-transaction', 'meter-values'].includes(value.transactionProvenance)
    || typeof value.transactionConfirmed !== 'boolean'
    || value.transactionConfirmed && value.transactionId === null
    || value.powerKw !== null && (!Number.isFinite(value.powerKw) || value.powerKw < 0)
    || value.powerAt !== null && (!time(value.powerAt) || value.powerAt > now)
    || ['statusReceivedAt', 'powerReceivedAt'].some(key => value[key] != null && (!time(value[key]) || value[key] > now))) throw fail('read-failed');
  if (value.appControl != null && (!validAppControl(value.appControl) || value.appControl.readAt > now
    || [value.appControl.enabledAt, value.appControl.stopAt].some(at => at !== null && at > now))) throw fail('read-failed');
  return clone(value);
}

function validAppControl(value) {
  if (!fields(value, ['readAt', 'enabled', 'enabledAt', 'stopped', 'stopAt', 'controlKnown', 'faulted', 'authorizationBlocked', 'schedule'])
    || !time(value.readAt) || ![true, false, null].includes(value.enabled)
    || ![value.stopped, value.controlKnown, value.faulted, value.authorizationBlocked].every(item => typeof item === 'boolean')
    || ![value.enabledAt, value.stopAt].every(at => at === null || time(at))) return false;
  try { return value.schedule === null || JSON.stringify(normalizeScheduleState(value.schedule)) === JSON.stringify(value.schedule); }
  catch { return false; }
}
export const appFingerprint = value => value ? hash([value.controlKnown, value.enabled, value.enabledAt, value.stopped, value.stopAt, value.faulted,
  value.authorizationBlocked, value.schedule ? effectiveScheduleFingerprint(value.schedule) : null]) : null;
const appInstructionFingerprint = value => value ? hash([value.enabled, value.enabledAt, value.stopped, value.stopped ? value.stopAt : null,
  value.schedule ? effectiveScheduleFingerprint(value.schedule) : null]) : null;
const appStopped = value => value?.controlKnown && !value.faulted && !value.authorizationBlocked && value.stopped;
const HANDOVER_STEPS = {
  'takeover-pause-prepare': 'Automatic handover could not prepare the planned charging pause.',
  'takeover-pause-install': 'Automatic handover could not install the planned charging pause.',
  'takeover-pause-confirm': 'Automatic handover could not confirm the planned charging pause.',
  'takeover-native-check': 'Automatic handover could not verify the current charger instructions.',
  'takeover-native-handover': 'Automatic handover could not replace the previous charger instructions.',
  'takeover-native-confirm': 'Automatic handover could not confirm that the previous charger instructions were cleared.',
  'takeover-state-save': 'Automatic handover could not save its confirmed ownership.',
};
function handoverFailure(step, error) {
  // Preserve only the operation and code; upstream messages may contain private data.
  return Object.assign(new Error('Native automatic handover failed'), { code: error?.code, handoverStep: step });
}
async function handoverOperation(step, operation) {
  try { return await operation(); }
  catch (error) { throw handoverFailure(step, error); }
}

export function createOcppScheduleAdapter({ request, readSnapshot, isCurrent = () => false,
  scope, clock = Date.now, canControl = () => false, takeoverNative, setStartPermission = () => {} } = {}) {
  if (!scopeValid(scope) || typeof request !== 'function' || typeof readSnapshot !== 'function') throw fail('invalid-ocpp-adapter');
  const adapter = {
    scope, ownershipNamespace: 'ocpp', supportsTakeover: typeof takeoverNative === 'function',
    capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: true },
    setStartPermission,
    async read({ signal, forceAppRefresh = false } = {}) { return snapshotFor(await readSnapshot({ signal, forceAppRefresh }), scope, clock()); },
    async composite(snapshot, until, { signal, guard = () => true } = {}) {
      const now = clock(), duration = Math.max(60, Math.ceil((until - now) / 1000));
      if (duration > MAX_PAUSE_MS / 1000 + 60) throw fail('invalid-plan');
      const reply = await request('GetCompositeSchedule', { connectorId: 1, duration, chargingRateUnit: 'A' },
        { signal, guard: () => canControl() && guard() && isCurrent(snapshot) });
      if (!isCurrent(snapshot) || !guard()) throw fail('control-revoked');
      return normalizeOcppComposite(reply, { now, duration });
    },
    async install(instruction, snapshot, { signal, guard = () => true, beforeWrite = () => {}, takeover = false } = {}) {
      if (!validInstruction(instruction)) throw fail('invalid-plan');
      const allowed = () => canControl() && guard() && isCurrent(snapshot) && snapshot.transactionConfirmed
        && snapshot.transactionId === instruction.transactionId
        && instruction.startAt - clock() >= (instruction.purpose === 'identification' ? 1000 : MIN_PAUSE_MS);
      if (!allowed()) throw fail('control-revoked');
      const before = await adapter.read({ signal, forceAppRefresh: true });
      if (!allowed() || !before.online || !fresh(before.readAt, clock())
        || before.connectionId !== snapshot.connectionId || !before.transactionConfirmed
        || before.transactionId !== instruction.transactionId || before.pluggedIn !== true
        || ['Unavailable', 'Faulted', 'Reserved'].includes(before.connectorStatus)
        || appStopped(before.appControl) && !takeover || before.appControl?.faulted || before.appControl?.authorizationBlocked
        || appFingerprint(before.appControl) !== appFingerprint(snapshot.appControl)) throw fail('control-revoked');
      await beforeWrite(before);
      const beforeSend = () => allowed() && isCurrent(before, { unchangedStatus: true });
      if (!beforeSend()) throw fail('control-revoked');
      // A natural stop while queued cannot become our identity response. This
      // extra guard runs only before send: a successful command is expected to
      // change Charging to SuspendedEVSE before its acknowledgement can arrive.
      const reply = await request('SetChargingProfile', clone(instruction.payload), { signal, guard: allowed, beforeSend });
      if (reply?.status !== 'Accepted') throw fail('profile-rejected');
    },
    async takeover(snapshot, { signal, guard = () => false, beforeWrite = () => {} } = {}) {
      if (typeof takeoverNative !== 'function') throw fail('takeover-unavailable');
      const allowed = () => canControl() && guard() && isCurrent(snapshot, { requireTransaction: false });
      const before = await handoverOperation('takeover-native-check', async () => {
        const value = await adapter.read({ signal, forceAppRefresh: true });
        if (!allowed() || appFingerprint(value.appControl) !== appFingerprint(snapshot.appControl)) throw fail('takeover-stale');
        return value;
      });
      const app = await handoverOperation('takeover-native-handover', async () => {
        const value = await takeoverNative({ expectedAppControl: clone(before.appControl), signal, canMutate: allowed, beforeWrite });
        if (!allowed()) throw fail('control-revoked');
        return value;
      });
      return handoverOperation('takeover-native-confirm', async () => {
        const after = await adapter.read({ signal, forceAppRefresh: true });
        if (!allowed() || !after.online || after.connectionId !== snapshot.connectionId
          || appFingerprint(after.appControl) !== appFingerprint(app) || !fresh(app?.readAt, clock())
          || !app.controlKnown || app.stopped || app.enabled !== true || app.faulted || app.authorizationBlocked
          || app.schedule?.enabled !== 'none') throw fail('readback-mismatch');
        return after;
      });
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
      const signal = (value, at = snapshot.statusAt, source = 'easee-ocpp', receivedAt = null) => ({
        value: available && value != null ? value : null, available: available && value != null,
        source, measuredAt: at ?? null, receivedAt });
      const limits = snapshot.limits ?? {}, supply = snapshot.supply ?? {};
      const ceilings = [limits.chargerA, limits.cableA, ...(limits.circuitA ?? [])].filter(value => Number.isFinite(value) && value > 0);
      const allowance = limits.equalizerAvailableA;
      const complete = values => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite);
      const voltageTimes = supply.observationTimes?.voltage;
      const voltageAvailable = complete(supply.voltageV) && complete(voltageTimes)
        && voltageTimes.every(at => time(at) && at <= now && now - at <= 5 * 60_000);
      return { ...snapshot, provider: 'easee', providerConnected: available, capabilities: adapter.capabilities,
        connected: signal(snapshot.pluggedIn, snapshot.statusAt, 'easee-ocpp', snapshot.statusReceivedAt ?? null),
        charging: signal(STATUSES.includes(snapshot.connectorStatus) ? snapshot.connectorStatus === 'Charging' : null,
          snapshot.statusAt, 'easee-ocpp', snapshot.statusReceivedAt ?? null),
        powerKw: signal(fresh(snapshot.powerAt, now) ? snapshot.powerKw : null, snapshot.powerAt, 'easee-ocpp', snapshot.powerReceivedAt ?? null),
        currentA: signal(complete(allowance) && ceilings.length ? Math.min(...allowance, ...ceilings) : null),
        availableCurrentA: signal(complete(allowance) ? Math.min(...allowance) : null),
        maxCurrentA: signal(ceilings.length ? Math.min(...ceilings) : null),
        actualCurrentA: signal(complete(supply.chargerCurrentA) ? supply.chargerCurrentA.reduce((sum, value) => sum + value, 0) / 3 : null),
        voltageV: { ...signal(voltageAvailable ? supply.voltageV.reduce((sum, value) => sum + value, 0) / 3 : null,
          voltageAvailable ? Math.min(...voltageTimes) : null), timeBasis: 'derived-observations',
          inputs: [0, 1, 2].map(phase => ({ measuredAt: voltageTimes?.[phase] ?? null })) },
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
  return { version: 2, kind: KIND, scope, nextProfileId: randomInt(1, 1_000_000_000), owned: null, pending: null,
    manual: null, appControl: null, delayedReleaseAt: null, lastManualResume: null, pauseWitness: null, execution: null, session: null, released: false, provisional: false, vehicleDisconnect: null, takeoverPending: null, automaticTakeover: null };
}
function validInstruction(value) {
  if (!fields(value, ['profileId', 'transactionId', 'startAt', 'validFrom', 'payload', 'fingerprint', 'confirmedAt', 'requestedAt', 'pauseRequestedAt',
    'purpose', 'identificationId', 'identificationConnectedAt', 'mode']) || !validIdentificationOwnership(value)) return false;
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
function selectExecution(plan, previous, now) {
  const priceRevision = revisedExecution(plan, previous, now);
  if (plan?.priceRevision && !priceRevision) plan = null;
  const candidate = executionFor(plan);
  let execution = priceRevision ?? (previous && now >= previous.periods[0].startAt ? previous : candidate);
  if (!priceRevision && execution && now >= execution.periods[0].startAt && now < execution.finalStartAt
    && !execution.periods.some(row => row.startAt <= now && now < row.endAt)
    && candidate && candidate.planId !== execution.planId) {
    const remaining = candidate.periods.filter(row => row.endAt === null || row.endAt > now);
    if (remaining.length) {
      const elapsed = execution.periods.filter(row => time(row.endAt) && row.endAt <= now);
      remaining[0] = { ...remaining[0], startAt: Math.max(elapsed.at(-1)?.endAt ?? 0, remaining[0].startAt) };
      execution = { ...candidate, periods: [...elapsed, ...remaining] };
      if (execution.periods.length > 24) throw fail('invalid-plan');
    }
  }
  return { plan, execution, priceRevision };
}
function validState(state, scope) {
  const keys = Object.keys(initialOcppControllerState(scope));
  return fields(state, keys) && keys.filter(key => !['takeoverPending', 'automaticTakeover'].includes(key)).every(key => Object.hasOwn(state, key)) && state.version === 2 && state.kind === KIND && state.scope === scope
    && id(state.nextProfileId) && typeof state.released === 'boolean' && typeof state.provisional === 'boolean'
    && (state.owned === null || validInstruction(state.owned) && state.owned.profileId < state.nextProfileId)
    && (state.pending === null || fields(state.pending, ['action', 'instruction', 'attempts', 'nextAttemptAt', 'accepted', 'execution'])
      && ['install', 'clear'].includes(state.pending.action) && validInstruction(state.pending.instruction) && state.pending.instruction.profileId < state.nextProfileId
      && Number.isInteger(state.pending.attempts) && state.pending.attempts >= 0 && state.pending.attempts <= MAX_ATTEMPTS
      && time(state.pending.nextAttemptAt) && typeof state.pending.accepted === 'boolean' && validExecution(state.pending.execution))
    && (state.manual === null || fields(state.manual, ['id', 'kind', 'at', 'transactionId', 'resumeAt', 'cycleEndsAt']) && text(state.manual.id)
      && ['stop', 'release', 'window', 'schedule'].includes(state.manual.kind) && time(state.manual.at)
      && (state.manual.transactionId === null || id(state.manual.transactionId))
      && (state.manual.resumeAt === null || time(state.manual.resumeAt)) && time(state.manual.cycleEndsAt))
    && (state.appControl === null || validAppControl(state.appControl))
    && (state.automaticTakeover == null || fields(state.automaticTakeover, ['connectedAt', 'fingerprint'])
      && time(state.automaticTakeover.connectedAt)
      && (state.automaticTakeover.fingerprint === null || scopeValid(state.automaticTakeover.fingerprint)))
    && (state.takeoverPending == null || fields(state.takeoverPending, ['connectedAt', 'requestedAt', 'beforeSchedule', 'afterSchedule', 'enabledAt', 'stopAt'])
      && (state.takeoverPending.connectedAt === null || time(state.takeoverPending.connectedAt)) && time(state.takeoverPending.requestedAt)
      && scopeValid(state.takeoverPending.beforeSchedule) && scopeValid(state.takeoverPending.afterSchedule)
      && [state.takeoverPending.enabledAt, state.takeoverPending.stopAt].every(at => at === null || time(at)))
    && (state.delayedReleaseAt === null || time(state.delayedReleaseAt))
    && (state.lastManualResume === null || fields(state.lastManualResume, ['at', 'deadlineAt', 'reason'])
      && time(state.lastManualResume.at) && time(state.lastManualResume.deadlineAt) && ['explicit', 'window-end'].includes(state.lastManualResume.reason))
    && (state.pauseWitness === null || fields(state.pauseWitness, ['profileId', 'transactionId', 'connectionId', 'at'])
      && id(state.pauseWitness.profileId) && id(state.pauseWitness.transactionId) && text(state.pauseWitness.connectionId) && time(state.pauseWitness.at)
      && state.pauseWitness.profileId === state.owned?.profileId && state.pauseWitness.transactionId === state.owned.transactionId)
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
  'readback-failed': 'The charger confirmation could not be read.',
  'readback-mismatch': 'The charger readback did not match the requested instruction.',
  'ocpp-request-timeout': 'The local charger did not reply before the command timeout; its outcome is unknown.',
  'ocpp-request-aborted': 'The local charger command was cancelled; an already sent command may still take effect.',
  'ocpp-request-failed': 'The local charger returned a protocol error for the command.',
  'ocpp-request-revoked': 'The local charger command lost its control permission or current connection.',
  'ocpp-disconnected': 'The local charger connection closed before confirmation.',
  'ocpp-reconfigured': 'The local charger connection was reconfigured before confirmation.',
  'ocpp-unavailable': 'The local charger connection is unavailable for commands.',
  'ocpp-queue-full': 'The local charger command queue is full.',
  'takeover-stale': 'The charger instruction changed. Review its current status before using automatic again.',
  'takeover-unavailable': 'The charger connection cannot currently confirm automatic handover.',
  'takeover-unconfirmed': 'Automatic control is unconfirmed. Review the charger status before retrying with the “Use automatic” button in Charging controls.',
  'resume-current-limit': 'The charger has a separate current limit that cannot safely be preserved while clearing its pause.',
  'unsupported-schedule': 'This charger schedule cannot yet be disabled through the supported API.',
  'transaction-unconfirmed': 'Automatic handover is waiting for a confirmed charger transaction so its planned pause can be preserved.',
  'status-stale': 'Waiting for charger connection status newer than the saved session evidence.',
};

/** Current transaction only; no cloud schedule is presented as native readback. */
export function createOcppChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan, getIdentification } = {}) {
  if (!adapter || !scopeValid(adapter.scope)) throw fail('invalid-ocpp-adapter');
  if (initialState !== null && !validState(initialState, adapter.scope)) throw Error('Unsupported native charging ownership; start a fresh development database');
  let state = initialState ? clone(initialState) : initialOcppControllerState(adapter.scope);
  let snapshot = null, desired = { enabled: false, plan: null, readyBy: '06:00', timezone: TIME_ZONE }, closed = false, generation = 0, queue = Promise.resolve(), abort = null;
  let phase = 'off', reason = 'Automatic charging is off.', errorCode = null, reasonCode = null, ownsInstruction = false, pauseConfirmed = false, handoverConfirmed = true;
  let planningRevision = null, identification = null;
  let takeoverState = null, takeoverAttempt = null;
  const takeoverToken = () => snapshot ? hash([adapter.scope, snapshot.connectionId, snapshot.transactionId,
    snapshot.connectorStatus, snapshot.statusAt, state.session?.connectedAt, appFingerprint(snapshot.appControl)]) : null;
  const takeoverStatus = () => {
    const app = snapshot?.appControl;
    const supported = easeeScheduleTakeoverSupported(app?.schedule);
    const available = !closed && adapter.supportsTakeover && snapshot?.online
      && fresh(snapshot.readAt, clock()) && fresh(app?.readAt, clock()) && app.controlKnown
      && typeof snapshot.pluggedIn === 'boolean' && !['Unavailable', 'Faulted', 'Reserved'].includes(snapshot.connectorStatus)
      && app.schedule !== null && !app.faulted && !app.authorizationBlocked && supported;
    return { available: Boolean(available), token: available ? takeoverToken() : null,
      reason: takeoverState === 'blocked' ? reason : available ? null : app?.schedule && !supported
        ? REASONS['unsupported-schedule'] : 'Fresh charger state and control access are required to use automatic.',
      ...(takeoverState ? { state: takeoverState, attemptToken: takeoverAttempt } : {}) };
  };
  const chargeNowActive = () => Number.isSafeInteger(desired.chargeNow?.connectedAt)
    && desired.chargeNow.connectedAt === state.session?.connectedAt && snapshot?.pluggedIn === true
    && !state.vehicleDisconnect?.awaitingConnection;
  const controlRequested = () => desired.enabled === true || chargeNowActive() || identification !== null;
  const status = () => ({ ...clone(state), phase, reason, errorCode, reasonCode, enabled: desired.enabled === true,
    ownsInstruction, pauseConfirmed, handoverConfirmed, planningRevision, takeover: takeoverStatus(), identification: identification ? clone(identification) : null,
    snapshot: snapshot ? { ...clone(snapshot), nativeInstruction: ownsInstruction ? clone(state.owned) : null } : null });
  const display = (next, message, code = null, step = null) => { phase = next; reason = message; errorCode = code; reasonCode = step; return status(); };
  async function commit(changes) {
    if (closed) throw fail('control-revoked');
    const next = { ...state, ...changes };
    try { await saveState(clone(next)); } catch { throw fail('storage-failed'); }
    state = next;
  }
  const canWrite = current => !closed && current === generation && canControl();
  function permitStart(plan, current) {
    const now = clock(), app = snapshot?.appControl;
    if (!canWrite(current) || !snapshot?.online || snapshot.pluggedIn !== true
      || !fresh(app?.readAt, now) || !app.controlKnown || app.stopped || app.faulted || app.authorizationBlocked
      || app.schedule?.enabled !== 'none' || nativeStopped() || staleAppControl() || state.takeoverPending || state.automaticTakeover
      || state.manual && state.manual.kind !== 'release') return;
    const selected = selectExecution(plan, state.execution, now);
    const periods = selected.execution?.periods ?? [];
    const active = periods.find(period => period.startAt <= now && (period.endAt === null || period.endAt > now));
    const identifying = identification && identification.phase !== 'pausing'
      && (identification.mode !== 'probe' || now < identification.probeUntil);
    if (identification && !identifying) return;
    const openRelease = state.released && !state.provisional && !selected.priceRevision
      || selected.plan?.provisional === true || selected.plan?.feasible === false
      || !selected.execution && time(selected.plan?.startAt) && selected.plan.startAt <= now;
    if (desired.enabled && !state.manual && !chargeNowActive() && !identifying && !active && !openRelease) return;
    const until = Math.min(now + MAX_AGE_MS,
      desired.enabled && !state.manual && !chargeNowActive() && !identifying ? active?.endAt ?? Infinity : Infinity,
      identifying && identification.mode === 'probe' ? identification.probeUntil : Infinity);
    adapter.setStartPermission?.(snapshot, { until, guard: () => canWrite(current) });
  }
  function observePause() {
    ownsInstruction = ownsInstruction && snapshot.online && snapshot.transactionConfirmed
      && snapshot.transactionId === state.owned?.transactionId && clock() < state.owned.startAt;
    pauseConfirmed = ownsInstruction && snapshot.connectorStatus === 'SuspendedEVSE'
      && fresh(snapshot.powerAt, clock()) && snapshot.powerAt >= state.owned.requestedAt && snapshot.powerKw === 0;
  }
  function missingPauseEvidence() {
    const missing = [];
    if (snapshot.connectorStatus !== 'SuspendedEVSE') missing.push('charger status confirming that charging is withheld');
    if (!fresh(snapshot.powerAt, clock()) || snapshot.powerAt < state.owned?.requestedAt)
      missing.push('a new power reading after the pause');
    else if (snapshot.powerKw !== 0) missing.push('a zero-power reading');
    return `Charging pause scheduled; physical stop not yet confirmed. Waiting for ${missing.join(' and ') || 'charger confirmation'}.`;
  }
  const staleAppControl = () => snapshot.appControl?.controlKnown && state.appControl?.controlKnown
    && ((snapshot.appControl.enabledAt ?? -1) < (state.appControl.enabledAt ?? -1)
      || (snapshot.appControl.stopAt ?? -1) < (state.appControl.stopAt ?? -1));
  const nativeStopped = () => appStopped(snapshot.appControl)
    || appStopped(state.appControl) && (!snapshot.appControl?.controlKnown || staleAppControl());
  async function observeAppControl() {
    const now = clock(), app = snapshot.appControl, prior = state.appControl;
    const changes = {};
    const manual = (kind, evidence, resumeAt = null) => {
      changes.manual = { id: hash([kind, evidence, now, state.session?.connectedAt]), kind, at: now,
        transactionId: snapshot.transactionId, resumeAt, cycleEndsAt: resolveChargingDeadline(now, desired.readyBy, desired.timezone) };
      changes.execution = null; changes.released = kind === 'release'; changes.provisional = false;
    };
    if (app && fresh(app.readAt, now)) {
      const scheduleChanged = app.schedule && (!prior || app.readAt >= prior.readAt) && (!prior?.schedule
        || effectiveScheduleFingerprint(app.schedule) !== effectiveScheduleFingerprint(prior.schedule));
      if (scheduleChanged && app.schedule.enabled !== 'none') {
        const window = manualScheduleWindow(app.schedule, now);
        manual(window ? 'window' : 'schedule', effectiveScheduleFingerprint(app.schedule), window?.resumeAt ?? null);
      } else if (scheduleChanged && prior?.schedule && prior.schedule.enabled !== 'none'
        && !(time(state.delayedReleaseAt) && now >= state.delayedReleaseAt)) {
        manual('release', effectiveScheduleFingerprint(app.schedule));
      }
      if (scheduleChanged) changes.delayedReleaseAt = app.schedule.enabled === 'delayed'
        ? nextLocalOccurrence(app.schedule.delayed.startTime, app.schedule.delayed.timezone, now) : null;
      if (app.controlKnown && !app.faulted && !app.authorizationBlocked && !staleAppControl()) {
        const enabledChanged = prior?.controlKnown && app.enabled !== prior.enabled && app.enabledAt > prior.enabledAt;
        const stopChanged = prior?.controlKnown && app.stopped !== prior.stopped && app.stopAt > prior.stopAt;
        if (app.stopped && (enabledChanged || stopChanged)) manual('stop', [app.enabledAt, app.stopAt]);
        else if (!app.stopped && (enabledChanged && app.enabled === true || stopChanged && prior.stopped)) {
          if (!['window', 'schedule'].includes(changes.manual?.kind)) manual('release', [app.enabledAt, app.stopAt]);
        }
      }
      // Schedule reads and source-timed control observations can fail separately.
      // Keep each comparison baseline without turning an older/absent control
      // observation into a fresh live restriction or a repeated schedule change.
      const controlAdvanced = !prior || (app.enabledAt ?? -1) >= (prior.enabledAt ?? -1)
        && (app.stopAt ?? -1) >= (prior.stopAt ?? -1);
      changes.appControl = { ...(controlAdvanced ? app : prior), readAt: app.readAt,
        schedule: app.schedule && (!prior || app.readAt >= prior.readAt) ? app.schedule : prior?.schedule ?? null };
    }
    const witness = state.pauseWitness;
    if (!changes.manual && !state.manual && witness && state.owned?.profileId === witness.profileId
      && snapshot.transactionConfirmed && snapshot.transactionId === witness.transactionId
      && snapshot.connectionId === witness.connectionId && now < state.owned.startAt
      && snapshot.connectorStatus === 'Charging' && snapshot.statusAt > witness.at && fresh(snapshot.statusAt, now)) {
      manual('release', ['native-charging', snapshot.statusAt, witness.profileId]);
    }
    if (Object.keys(changes).length) await commit(changes);
  }
  async function refreshIdentification() {
    const next = typeof getIdentification === 'function' ? await getIdentification(clone(snapshot)) : null, now = clock();
    if (next != null && (!fields(next, ['id', 'connectedAt', 'phase', 'pauseUntil', 'mode', 'probeUntil', 'returnStartAt'])
      || !text(next.id) || next.id.length > 128 || !time(next.connectedAt) || next.connectedAt > now
      || !['waiting', 'charging', 'pausing'].includes(next.phase)
      || next.phase === 'pausing' && (!time(next.pauseUntil) || next.pauseUntil - now > MAX_IDENTIFICATION_PAUSE_MS)
      || next.phase !== 'pausing' && next.pauseUntil !== undefined
      || next.mode !== undefined && !['normal', 'probe'].includes(next.mode)
      || next.mode === 'probe' && (!time(next.probeUntil) || !time(next.returnStartAt) || next.probeUntil >= next.returnStartAt
        || next.probeUntil - now > 5 * 60_000 || next.returnStartAt - now > MAX_PAUSE_MS)
      || next.mode !== 'probe' && ['probeUntil', 'returnStartAt'].some(key => next[key] !== undefined))) throw fail('invalid-plan');
    identification = next && next.connectedAt === state.session?.connectedAt && snapshot.pluggedIn === true
      && !state.vehicleDisconnect?.awaitingConnection && (next.phase !== 'pausing' || next.pauseUntil > now)
      ? clone(next) : null;
  }
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
      const options = { signal, guard: () => canWrite(current)
        && (pending.action !== 'clear' || identification?.mode !== 'probe' || state.manual || snapshot.pluggedIn !== true
          || identification.phase === 'pausing' || clock() < identification.probeUntil) };
      const install = () => adapter.install(pending.instruction, snapshot, { ...options,
        takeover: takeoverState === 'pending',
        beforeWrite: async before => {
          if (!canWrite(current)) throw fail('control-revoked');
          const { pauseRequestedAt: _priorWitness, ...instruction } = state.pending.instruction;
          // Installation intent exists even when already stopped. Only a fresh
          // guarded Charging observation may witness a causal identity pause.
          // Retry from a stopped state drops the earlier uncertain witness.
          await commit({ pending: { ...state.pending, instruction: { ...instruction,
            ...(before.connectorStatus === 'Charging' ? { pauseRequestedAt: clock() } : {}) } } });
        } });
      if (pending.action === 'install') await (takeoverState === 'pending'
        ? handoverOperation('takeover-pause-install', install) : install());
      else await adapter.clear(pending.instruction, snapshot, options);
      if (!canWrite(current)) throw fail('control-revoked');
      await commit({ pending: { ...state.pending, accepted: true, nextAttemptAt: 0 } });
      pending = state.pending;
    }
    if (pending.action === 'clear') {
      // Accepted/Unknown addresses this exact ID. Another zero profile may still
      // restrict charging; clearing ours does not assert an unrestricted car.
      await commit({ owned: null, pending: null, pauseWitness: null }); ownsInstruction = pauseConfirmed = false; return true;
    }
    if (clock() >= pending.instruction.startAt) { await commit({ owned: null, pending: null, pauseWitness: null }); return true; }
    try {
      const composite = await adapter.composite(snapshot, pending.instruction.startAt + 60_000, { signal, guard: () => canWrite(current) });
      if (!coversZero(composite, Math.max(clock(), composite.startAt), pending.instruction.startAt)) throw fail('readback-mismatch');
    } catch (error) {
      throw takeoverState === 'pending' ? handoverFailure('takeover-pause-confirm', error) : error;
    }
    await commit({ owned: { ...pending.instruction, confirmedAt: clock() }, execution: pending.execution, released: false, provisional: false, pending: null, pauseWitness: null }); ownsInstruction = true;
    return true;
  }
  async function takeOver(current, token, signal) {
    takeoverState = 'blocked'; takeoverAttempt = token;
    if (!token || token !== takeoverToken()) throw fail('takeover-stale');
    if (!canWrite(current) || !takeoverStatus().available || !desired.enabled) throw fail('takeover-unavailable');
    const plan = snapshot.pluggedIn === true
      ? typeof getPlan === 'function' ? await getPlan(clone(snapshot), { takeover: true }) : desired.plan : null;
    if (snapshot.pluggedIn === true && (!plan || !time(plan.startAt))) throw fail('invalid-plan');
    const now = clock(), periods = plan?.periods;
    const active = periods?.some(period => period.startAt <= now && (period.endAt === null || period.endAt > now));
    const startAt = periods && !active ? periods.find(period => period.startAt > now)?.startAt ?? plan.startAt : plan?.startAt;
    takeoverState = 'pending';
    if (startAt > now) {
      if (!snapshot.transactionConfirmed || snapshot.transactionId === null || snapshot.pluggedIn !== true)
        throw fail('transaction-unconfirmed');
      if (startAt - now < MIN_PAUSE_MS) throw fail('invalid-plan');
      const profileId = state.pending?.instruction.profileId ?? state.owned?.profileId ?? state.nextProfileId;
      const instruction = { ...ocppPauseInstruction({ profileId, transactionId: snapshot.transactionId,
        startAt: Math.ceil(startAt / 1000) * 1000, now: Math.floor(now / 1000) * 1000 }), requestedAt: now };
      await handoverOperation('takeover-pause-prepare', () => commit({ nextProfileId: state.owned || state.pending ? state.nextProfileId : profileId + 1,
        pending: { action: 'install', instruction, execution: null, attempts: 0, nextAttemptAt: 0, accepted: false } }));
      if (!await dispatch(current, signal)) throw fail('command-failed');
    }
    const priorManual = state.manual;
    snapshot = await adapter.takeover(snapshot, { signal, guard: () => canWrite(current) && desired.enabled === true,
      beforeWrite: ({ before } = {}) => commit({ takeoverPending: { connectedAt: state.session?.connectedAt ?? null,
        requestedAt: clock(), beforeSchedule: effectiveScheduleFingerprint(before?.schedule ?? snapshot.appControl.schedule),
        afterSchedule: effectiveScheduleFingerprint({ enabled: 'none' }),
        enabledAt: before?.observations?.[31]?.at ?? snapshot.appControl.enabledAt,
        stopAt: before ? Math.max(before.observations?.[31]?.at ?? 0, before.observations?.[48]?.at ?? 0, before.reasonAt ?? 0) : snapshot.appControl.stopAt } }) });
    await handoverOperation('takeover-state-save', () => commit({ appControl: clone(snapshot.appControl), manual: null, execution: null, released: false, provisional: false,
      delayedReleaseAt: null, takeoverPending: null, automaticTakeover: null,
      ...(priorManual ? { lastManualResume: { at: clock(), deadlineAt: priorManual.cycleEndsAt, reason: 'explicit' } } : {}) }));
    takeoverState = 'confirmed';
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
      const knownPhysicalAt = Math.max(prior?.connectedAt ?? -1,
        state.pauseWitness?.at ?? -1, snapshot.transactionStartedAt ?? -1, snapshot.transactionConfirmedAt ?? -1);
      const manualAt = state.manual && ['stop', 'release'].includes(state.manual.kind) && state.appControl?.controlKnown
        ? Math.max(state.appControl.enabledAt ?? -1, state.appControl.stopAt ?? -1) : state.manual?.at ?? -1;
      const knownConnectionAt = Math.max(knownPhysicalAt, manualAt);
      const explicitDisconnect = state.vehicleDisconnect?.awaitingConnection
        && state.vehicleDisconnect.measuredAt > knownPhysicalAt;
      // A reconnect may replay an old Available status. Its new receipt time
      // cannot end a newer physical session or erase a later manual instruction.
      // A separately observed, newer physical disconnect retains its authority.
      if (snapshot.pluggedIn === false && snapshot.statusAt <= knownConnectionAt && !explicitDisconnect)
        return display('unavailable', REASONS['status-stale'], 'status-stale');
      const disconnected = snapshot.pluggedIn === false;
      const lastDisconnectedAt = Math.max(prior?.lastDisconnectedAt ?? -1, state.vehicleDisconnect?.measuredAt ?? -1,
        disconnected ? snapshot.statusAt : -1);
      const transactionBoundary = snapshot.transactionProvenance === 'meter-values'
        ? snapshot.transactionConfirmedAt : snapshot.transactionStartedAt;
      const confirmedTransaction = snapshot.transactionConfirmed && transactionBoundary > lastDisconnectedAt;
      const changedTransaction = prior?.transactionId !== null && prior?.transactionId !== undefined
        && confirmedTransaction && snapshot.transactionId !== prior.transactionId;
      const awaiting = state.vehicleDisconnect?.awaitingConnection && !confirmedTransaction;
      // Physical connection evidence does not require transaction authority. A
      // newer source-timed status can reopen the card while native control waits
      // for a confirmed transaction. Never reuse the disconnected session's ID.
      const physicallyConnected = snapshot.pluggedIn === true && snapshot.statusAt > lastDisconnectedAt;
      const newConnection = physicallyConnected && (prior?.connectedAt == null || prior.connectedAt <= lastDisconnectedAt);
      const session = { transactionId: confirmedTransaction ? snapshot.transactionId : newConnection ? null : prior?.transactionId ?? null,
        connected: disconnected ? false : awaiting && !physicallyConnected ? null : snapshot.pluggedIn,
        connectedAt: disconnected ? null : newConnection
          ? confirmedTransaction && time(snapshot.transactionStartedAt) ? Math.min(snapshot.transactionStartedAt, snapshot.statusAt) : snapshot.statusAt
          : prior?.connectedAt == null ? snapshot.transactionStartedAt ?? snapshot.statusAt : prior.connectedAt,
        lastDisconnectedAt: lastDisconnectedAt >= 0 ? lastDisconnectedAt : null };
      await commit({ session, ...(state.vehicleDisconnect && !awaiting ? { vehicleDisconnect: { ...state.vehicleDisconnect, awaitingConnection: false } } : {}),
        ...(newConnection || changedTransaction || disconnected ? { execution: null, released: false, provisional: false,
          pauseWitness: null, manual: changedTransaction && !newConnection && !disconnected ? state.manual : null } : {}),
        ...(newConnection ? { automaticTakeover: desired.enabled && adapter.supportsTakeover ? { connectedAt: session.connectedAt,
          fingerprint: snapshot.appControl?.controlKnown && snapshot.appControl.schedule !== null ? appInstructionFingerprint(snapshot.appControl) : null } : null }
          : disconnected || !desired.enabled ? { automaticTakeover: null } : {}) });
      if (state.takeoverPending && !desired.takeover) {
        const unresolved = state.takeoverPending, app = snapshot.appControl;
        const newerStop = app?.stopped && app.stopAt > Math.max(unresolved.stopAt ?? 0, unresolved.requestedAt);
        const differentSchedule = app?.schedule && ![unresolved.beforeSchedule, unresolved.afterSchedule].includes(effectiveScheduleFingerprint(app.schedule));
        if (newerStop || differentSchedule || disconnected || unresolved.connectedAt !== session.connectedAt) await commit({ takeoverPending: null });
        else if (desired.enabled === true) return display('unconfirmed', REASONS['takeover-unconfirmed'], 'takeover-unconfirmed');
      }
      await observeAppControl();
      if (desired.takeover) {
        const token = desired.takeover; desired.takeover = null;
        await takeOver(current, token, signal);
      } else if (state.automaticTakeover) {
        const claim = state.automaticTakeover, app = snapshot.appControl;
        if (claim.connectedAt !== session.connectedAt) await commit({ automaticTakeover: null });
        else if (app?.schedule && !easeeScheduleTakeoverSupported(app.schedule))
          return display('unavailable', REASONS['unsupported-schedule'], 'unsupported-schedule');
        else if (!takeoverStatus().available) return display('unavailable',
          'Automatic control is waiting for fresh charger instructions.', 'takeover-unavailable');
        else {
          const fingerprint = appInstructionFingerprint(app);
          if (claim.fingerprint !== null && claim.fingerprint !== fingerprint) await commit({ automaticTakeover: null });
          else {
            if (claim.fingerprint === null) await commit({ automaticTakeover: { ...claim, fingerprint } });
            if (app.stopped || app.schedule.enabled !== 'none' || state.manual) await takeOver(current, takeoverToken(), signal);
            else await commit({ automaticTakeover: null });
          }
        }
      }
      if (disconnected && state.manual)
        await commit({ manual: null, released: false });
      const handbackKnown = !['window', 'schedule', 'stop'].includes(state.manual?.kind)
        || fresh(snapshot.appControl?.readAt, clock()) && (state.manual.kind === 'stop'
          ? snapshot.appControl.controlKnown : snapshot.appControl.schedule !== null);
      if (handbackKnown && !staleAppControl() && !nativeStopped() && time(state.manual?.resumeAt) && clock() >= state.manual.resumeAt) {
        await commit({ lastManualResume: { at: clock(), deadlineAt: state.manual.cycleEndsAt,
          reason: 'window-end' }, manual: null, released: false, execution: null });
      }
      // Supply fresh physical pause evidence to identification before it chooses
      // whether this temporary instruction is still needed.
      if (typeof getIdentification === 'function' && state.owned?.purpose === 'identification'
        && state.owned.startAt > clock() && !state.manual && canWrite(current)
        && snapshot.transactionConfirmed && snapshot.transactionId === state.owned.transactionId) {
        const composite = await adapter.composite(snapshot, state.owned.startAt + 60_000, { signal, guard: () => canWrite(current) });
        ownsInstruction = coversZero(composite, Math.max(clock(), composite.startAt), state.owned.startAt);
        observePause();
      }
      await refreshIdentification();
      if (closed || current !== generation) return status();
      const startPlan = typeof getPlan === 'function' ? await getPlan(clone(snapshot)) : desired.plan;
      permitStart(startPlan, current);
      const instruction = state.pending?.instruction ?? state.owned;
      const wrongSession = instruction && snapshot.transactionConfirmed && instruction.transactionId !== snapshot.transactionId;
      const identificationEnded = instruction?.purpose === 'identification'
        && (!identification || identification.id !== instruction.identificationId || clock() >= instruction.startAt);
      if (identificationEnded) await commit({ execution: null, released: false, provisional: false });
      const release = !controlRequested() || state.manual || nativeStopped() || disconnected || awaiting || wrongSession
        || identificationEnded && (!desired.enabled || chargeNowActive() || identification || clock() >= instruction.startAt);
      if (release && instruction) {
        handoverConfirmed = false;
        if (!await clearInstruction(instruction, current, signal)) return display('unconfirmed', 'Native profile release is waiting for its bounded retry.');
        handoverConfirmed = true;
      }
      if (!controlRequested()) { await commit({ execution: null }); handoverConfirmed = !state.pending && !state.owned; return display('off', 'Automatic charging is off; external charger restrictions are preserved.'); }
      if (nativeStopped()) return display(state.manual?.kind === 'stop' ? 'yielded' : 'unavailable',
        'The charger reports paused or disabled. A stop instruction is preventing automatic scheduling.', state.manual ? null : 'charger-stopped');
      if (state.manual) return display('yielded', state.manual.kind === 'stop'
        ? 'The charger reports paused or disabled. A stop instruction is preventing automatic scheduling.'
        : ['window', 'schedule'].includes(state.manual.kind) ? 'The charger schedule has temporary priority.'
          : 'Another charger instruction has priority over automatic scheduling.');
      if (staleAppControl()) return display('unavailable', 'Waiting for charger readings newer than the last confirmed change.', 'app-control-stale');
      if (snapshot.appControl?.faulted || snapshot.appControl?.authorizationBlocked)
        return display('unavailable', 'Easee reports a charger fault or charging authorization restriction.');
      if (disconnected) return display('disconnected', 'Waiting for a vehicle connection.');
      if (!canWrite(current)) throw fail('control-revoked');
      if (['Unavailable', 'Faulted', 'Reserved'].includes(snapshot.connectorStatus)) return display('unavailable', 'The charger is unavailable for automatic native scheduling.');
      if (awaiting || !confirmedTransaction || snapshot.transactionId === null || snapshot.pluggedIn !== true)
        return display('unavailable', 'Waiting for a current transaction confirmed on this connection.', 'transaction-unconfirmed');
      if (identification) {
        await commit({ execution: null, released: false, provisional: false });
        if (identification.phase !== 'pausing' && (identification.mode !== 'probe' || clock() < identification.probeUntil)) {
          const restriction = state.pending?.instruction ?? state.owned;
          if (restriction && !await clearInstruction(restriction, current, signal)) return display('unconfirmed', 'Vehicle identification is waiting for the native profile release.');
          return display('identifying', identification.phase === 'waiting' ? 'Vehicle identification is pending until charging starts.'
            : 'Charging briefly to identify the connected vehicle.');
        }
      }
      if (chargeNowActive() && !identification) {
        const restriction = state.pending?.instruction ?? state.owned;
        if (restriction && !await clearInstruction(restriction, current, signal)) return display('unconfirmed', 'Charge Now is waiting for the native profile release.');
        await commit({ execution: null, released: true, provisional: false });
        return display('released', 'Charge Now is active for this connection. Charger and vehicle limits still apply.');
      }
      const previousInstruction = state.pending?.instruction ?? state.owned;
      if (previousInstruction && clock() >= previousInstruction.startAt) {
        // Explicitly clear our exact ID even after expiry; composite output can
        // remain restricted by somebody else's profile and is not ownership.
        if (!await clearInstruction(previousInstruction, current, signal)) return display('unconfirmed', 'Native expiry cleanup is waiting for its bounded retry.');
      }
      let { plan, execution, priceRevision } = selectExecution(identification
        ? { id: identification.id, startAt: identification.mode === 'probe' ? identification.returnStartAt : identification.pauseUntil }
        : startPlan, state.execution, clock());
      if (!canWrite(current)) throw fail('control-revoked');
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
      const expiredProbeClear = identification?.mode === 'probe' && clock() >= identification.probeUntil && state.pending?.action === 'clear';
      if (state.pending && !expiredProbeClear && (state.pending.action === 'clear' || state.pending.instruction.startAt === startAt))
        if (!await dispatch(current, signal)) return display('unconfirmed', 'The native command is waiting for its bounded retry.');
      if (state.pending || state.owned?.startAt !== startAt
        || identification && (state.owned?.purpose !== 'identification' || state.owned.identificationId !== identification.id)) {
        const now = Math.floor(clock() / 1000) * 1000;
        if (startAt - clock() < (identification ? 1000 : MIN_PAUSE_MS)
          || startAt - clock() > (identification && identification.mode !== 'probe' ? MAX_IDENTIFICATION_PAUSE_MS : MAX_PAUSE_MS)) throw fail('invalid-plan');
        const profileId = state.pending?.instruction.profileId ?? state.owned?.profileId ?? state.nextProfileId;
        if (profileId >= 2147483646) throw fail('invalid-plan');
        const next = { ...ocppPauseInstruction({ profileId, transactionId: snapshot.transactionId, startAt, now }),
          requestedAt: clock(), ...(identification ? { purpose: 'identification', identificationId: identification.id,
            identificationConnectedAt: identification.connectedAt, ...(identification.mode === 'probe' ? { mode: 'probe' } : {}) } : {}) };
        await commit({ nextProfileId: state.owned || state.pending ? state.nextProfileId : profileId + 1,
          pending: { action: 'install', instruction: next, execution, attempts: 0, nextAttemptAt: 0, accepted: false } });
        if (!await dispatch(current, signal)) return display('unconfirmed', 'Native pause installation is pending.');
      } else {
        const composite = await adapter.composite(snapshot, startAt + 60_000, { signal, guard: () => canWrite(current) });
        if (!coversZero(composite, Math.max(clock(), composite.startAt), startAt)) return display('unconfirmed', 'The native pause no longer matches the effective schedule.', 'readback-mismatch');
        if (JSON.stringify(execution) !== JSON.stringify(state.execution)) await commit({ execution });
        if (!identification && state.owned?.purpose === 'identification') {
          const { purpose: _purpose, identificationId: _id, identificationConnectedAt: _connection, mode: _mode, ...owned } = state.owned;
          await commit({ owned });
        }
        ownsInstruction = true;
      }
      const verifiedConnectionId = snapshot.connectionId, verifiedTransactionId = snapshot.transactionId;
      snapshot = await adapter.read({ signal });
      if (!canWrite(current) || !snapshot.online || snapshot.connectionId !== verifiedConnectionId || !snapshot.transactionConfirmed
        || snapshot.transactionId !== verifiedTransactionId) {
        ownsInstruction = pauseConfirmed = false;
        throw fail('control-revoked');
      }
      await observeAppControl();
      if (staleAppControl()) throw fail('control-revoked');
      if (state.manual || nativeStopped()) {
        if (!await clearInstruction(state.owned, current, signal)) return display('unconfirmed', 'Native profile release is waiting for its bounded retry.');
        return display(state.manual ? 'yielded' : 'unavailable', nativeStopped()
          ? 'The charger reports paused or disabled. A stop instruction is preventing automatic scheduling.'
          : 'The newer charger instruction has temporary priority.');
      }
      ownsInstruction = ownsInstruction && snapshot.online && snapshot.connectionId === verifiedConnectionId && snapshot.transactionConfirmed
        && snapshot.transactionId === state.owned?.transactionId && clock() < state.owned.startAt;
      observePause();
      if (pauseConfirmed) await commit({ pauseWitness: { profileId: state.owned.profileId,
        transactionId: snapshot.transactionId, connectionId: snapshot.connectionId,
        at: Math.max(snapshot.statusAt, snapshot.powerAt) } });
      if (identification) return display('identifying', pauseConfirmed
        ? 'Charging is briefly paused while waiting for the vehicle identification response.'
        : 'The identification pause is awaiting fresh confirmation from the charger.');
      return display(pauseConfirmed ? 'paused' : 'pause-unconfirmed', pauseConfirmed
        ? 'The native pause is confirmed and expires at the planned start.'
        : missingPauseEvidence());
    } catch (error) {
      adapter.setStartPermission?.(null);
      if (takeoverState === 'pending') takeoverState = 'blocked';
      if (closed || current !== generation) return status();
      handoverConfirmed = !controlRequested() ? false : null;
      const code = typeof error?.code === 'string' && Object.hasOwn(REASONS, error.code) ? error.code : 'command-failed';
      const step = typeof error?.handoverStep === 'string' && Object.hasOwn(HANDOVER_STEPS, error.handoverStep) ? error.handoverStep : null;
      return display(state.pending ? 'unconfirmed' : controlRequested() ? 'unavailable' : 'off',
        `${step ? `${HANDOVER_STEPS[step]} ` : ''}${REASONS[code]}`, code, step);
    }
  }
  return { status, supportsIdentification: true,
    update(input = {}) {
      adapter.setStartPermission?.(null);
      if (Object.hasOwn(input, 'resume')) throw new Error('Unsupported charging control field: resume');
      if (typeof input.takeover !== 'string' && takeoverState !== 'pending') { takeoverState = null; takeoverAttempt = null; }
      desired = { ...desired, ...input, takeover: typeof input.takeover === 'string' ? input.takeover : null };
      const current = ++generation;
      abort?.abort(); abort = new AbortController();
      queue = queue.catch(() => {}).then(() => reconcile(current));
      return queue.then(() => status());
    },
    invalidate() { adapter.setStartPermission?.(null); generation++; abort?.abort(); },
    close() { adapter.setStartPermission?.(null); closed = true; generation++; abort?.abort(); return queue.catch(() => {}); },
  };
}
