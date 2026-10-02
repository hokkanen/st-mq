import { resolveChargingDeadline } from './settings.js';
import { TIME_ZONE } from '../domain/prices.js';
import { delayedScheduleFor, easeeTakeoverFingerprint, effectiveScheduleFingerprint, manualScheduleWindow, nextLocalOccurrence, scheduleFingerprint } from './easee.js';
import { createHash } from 'node:crypto';

const copy = value => structuredClone(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const boundaryId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
// Inactive cached recurrences are not instructions to this charging session.
const activeFingerprint = effectiveScheduleFingerprint;
const ownedFingerprint = owned => owned?.activeFingerprint ?? (owned?.schedule ? activeFingerprint(owned.schedule) : null);
const STOP_REASON = 'The charger reports paused or disabled. Use automatic to let the charging planner take over.';
const RELEASE_REASON = 'Charging is released and may continue beyond the minimum and deadline.';
const MIN_PRICE_PAUSE_MS = 15 * 60_000;
const MAX_IDENTIFICATION_PAUSE_MS = 5 * 60_000;
const identificationFields = ['purpose', 'identificationId', 'identificationConnectedAt'];
const validTakeoverPending = value => value == null || typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['connectedAt', 'requestedAt', 'stage', 'beforeSchedule', 'afterSchedule', 'enabledAt', 'reasonAt'].includes(key))
  && [value.connectedAt, value.enabledAt, value.reasonAt].every(at => at === null || isTime(at)) && isTime(value.requestedAt)
  && ['schedule', 'schedule-disable', 'enable', 'resume'].includes(value.stage)
  && [value.beforeSchedule, value.afterSchedule].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
function validIdentificationOwnership(value) {
  if (!value || !identificationFields.some(key => Object.hasOwn(value, key))) return true;
  const requestedAt = value.scheduleRequestedAt ?? value.installRequestedAt ?? value.startedAt;
  return value.purpose === 'identification' && boundaryId(value.identificationId)
    && isTime(value.identificationConnectedAt) && isTime(requestedAt)
    && value.identificationConnectedAt <= requestedAt && isTime(value.startAt)
    && value.startAt > requestedAt && value.startAt - requestedAt <= MAX_IDENTIFICATION_PAUSE_MS;
}
const DIAGNOSTICS = {
  'read-failed': 'Easee could not be read. Automatic control will retry when the connection recovers.',
  'command-failed': 'Easee did not confirm the charging instruction. Its current state will be checked again.',
  'readback-failed': 'Easee charging confirmation could not be read. Its current state will be checked again.',
  'readback-mismatch': 'Easee has not confirmed the requested charging instruction. Its current state will be checked again.',
  'access-denied': 'Easee rejected access. Check the Easee connection credentials.',
  'control-revoked': 'Charger control authority changed before the command completed.',
  'state-changed': 'Easee changed during the check. The current instruction will be read again before making changes.',
  'unsupported-schedule': 'This Easee schedule type cannot be released through the available API. Disable it in Easee to resume automatic charging.',
  'resume-current-limit': 'The charger has a separate current limit that cannot safely be preserved while clearing its pause. Release that restriction at the charger before using automatic.',
  'takeover-stale': 'The charger instruction changed. Review its current status before using automatic again.',
  'takeover-unconfirmed': 'The previous automatic handover is unconfirmed. Review the charger status and choose Use automatic again.',
  'invalid-plan': 'The proposed start or charging limit is invalid. A new plan will be requested.',
  'missing-current-limit': 'Easee has not supplied a usable charger current limit. Another reading will be requested before scheduling.',
  'start-passed': 'The proposed start arrived while Easee was being checked. The current instruction will be read again to release charging.',
  'ambiguous-start': 'The proposed start falls in a repeated daylight-saving hour, which Easee cannot identify uniquely. A new unambiguous plan is needed.',
  'start-out-of-range': 'Easee accepts only the next occurrence of a local start time. This proposed date is farther ahead; planning will retry closer to the start.',
};

/** Durable native instruction ownership and observed manual priority. */
export function createChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan, getMaximumAmps, getIdentification } = {}) {
  if (initialState && (initialState.version !== 5 || !validIdentificationOwnership(initialState.owned)
    || !validIdentificationOwnership(initialState.pending) || !validTakeoverPending(initialState.takeoverPending))) throw new Error('Unsupported charging ownership; start a fresh development database');
  const previous = initialState ? copy(initialState) : {};
  let state = { phase: 'off', owned: null, pending: null, manual: null, released: false,
    disconnected: false, execution: null, handoverConfirmed: true, reason: 'Automatic charging is off.',
    ...previous, version: 5, session: previous.session ?? null, errorCode: null };
  let desired = { enabled: false, plan: null, readyBy: '06:00', timezone: TIME_ZONE }, snapshot = null, closed = false, generation = 0, queue = Promise.resolve();
  let planningRevision = null, identification = null;
  let takeoverState = null, takeoverAttempt = null;
  const permitted = () => !closed && canControl() === true;
  const chargeNowActive = () => desired.chargeNow?.connectedAt === state.session?.connectedAt
    && Number.isSafeInteger(desired.chargeNow?.connectedAt) && snapshot?.pluggedIn === true
    && !state.vehicleDisconnect?.awaitingConnection;
  const controlRequested = () => desired.enabled === true || chargeNowActive() || identification !== null;
  const takeoverToken = () => snapshot ? createHash('sha256').update(JSON.stringify([
    easeeTakeoverFingerprint(snapshot), state.session?.connectedAt ?? null, state.session?.lastDisconnectedAt ?? null])).digest('hex') : null;
  const takeoverStatus = () => {
    const available = !closed && snapshot?.online === true && snapshot.controlKnown
      && !snapshot.faulted && !snapshot.authorizationBlocked && snapshot.readAt <= clock()
      && clock() - snapshot.readAt <= 60_000 && typeof adapter.takeover === 'function';
    return { available, token: available ? takeoverToken() : null, reason: takeoverState === 'blocked' ? state.reason : available ? null
      : 'Fresh charger state and control access are required to use automatic.',
      ...(takeoverState ? { state: takeoverState, attemptToken: takeoverAttempt } : {}) };
  };
  const status = () => ({ ...copy(state), enabled: desired.enabled === true, planningRevision, takeover: takeoverStatus(),
    identification: identification ? copy(identification) : null, snapshot: snapshot ? copy(snapshot) : null });
  const currentFingerprint = () => activeFingerprint(snapshot.schedule);
  const ownsCurrent = () => state.owned && ownedFingerprint(state.owned) === currentFingerprint();
  async function persist() { await saveState(copy(state)); }
  async function phase(value, reason, errorCode = null) { state.phase = value; state.reason = reason; state.errorCode = errorCode; await persist(); }
  const cycleEnd = now => resolveChargingDeadline(now, desired.readyBy, desired.timezone);
  function manual(kind, now, reason, extra = {}) {
    state.execution = null;
    const cycleEndsAt = cycleEnd(now), windowEndAt = extra.windowEndAt ?? extra.resumeAt ?? null;
    const resumeAt = kind === 'window' && isTime(windowEndAt) ? windowEndAt : null;
    state.manual = { kind, detectedAt: now, reason, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), ...extra, windowEndAt, cycleEndsAt, resumeAt,
      resumeReason: resumeAt !== null ? 'window-end' : null };
  }
  function yieldSchedule(now) {
    const window = manualScheduleWindow(snapshot.schedule, now);
    manual(window ? 'window' : 'schedule', now, 'An observed change to the Easee schedule has temporary priority.', window ?? {});
  }
  function confirmedOwned(now, pending) {
    return { planId: pending.planId, startAt: pending.startAt, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), schedule: copy(snapshot.schedule), confirmedAt: now,
      ...(isTime(pending.pauseRequestedAt) && pending.pauseRequestedAt <= now ? { requestedAt: pending.pauseRequestedAt } : {}),
      scheduleRequestedAt: pending.installRequestedAt,
      ...(pending.purpose === 'identification' ? { purpose: pending.purpose, identificationId: pending.identificationId,
        identificationConnectedAt: pending.identificationConnectedAt } : {}),
      ...(pending.periods ? { periods: copy(pending.periods), finalStartAt: pending.finalStartAt } : {}) };
  }
  function normalExpiry(now) {
    return state.owned && now >= state.owned.startAt && snapshot.schedule.enabled === 'none';
  }
  const stopped = value => typeof value.stopped === 'boolean' ? value.stopped
    : value.enabled === false || value.reason === 53;
  async function observeVehicleDisconnect(now) {
    const event = desired.vehicleDisconnect;
    if (!['bmw-cardata', 'easee-stream'].includes(event?.source) || !boundaryId(event.readingId)
      || !isTime(event.measuredAt) || !isTime(event.receivedAt) || !isTime(event.endedConnectedAt)
      || event.measuredAt > now || event.receivedAt > now) return;
    const prior = copy(state);
    const known = state.vehicleDisconnect;
    if (known?.source !== event.source || known?.readingId !== event.readingId) {
      // Several live stream edges may arrive before a fresh controller read.
      // A later disconnect supersedes the pending reconnect for that same old
      // connection, even though its durable session is already closed.
      const pendingStreamBoundary = event.source === 'easee-stream' && known?.awaitingConnection
        && known.endedConnectedAt === event.endedConnectedAt && state.session?.connectedAt === null
        && event.measuredAt > known.measuredAt;
      if (state.session?.connectedAt !== event.endedConnectedAt && !pendingStreamBoundary
        || event.measuredAt <= (state.session?.lastDisconnectedAt ?? -1)) return;
      state.vehicleDisconnect = { source: event.source, readingId: event.readingId,
        measuredAt: event.measuredAt, receivedAt: event.receivedAt, endedConnectedAt: event.endedConnectedAt,
        cleanupPending: true, awaitingConnection: true };
      state.session = { ...state.session, connected: false, connectedAt: null,
        lastDisconnectedAt: event.measuredAt, waitingForScheduleAt: null, delayedReleaseAt: null };
      state.disconnected = true; state.released = false; state.provisional = false; state.execution = null;
      delete state.lastMissedTransition;
      if (state.manual && !['window', 'schedule', 'stop'].includes(state.manual.kind)) state.manual = null;
    } else if (known.endedConnectedAt !== event.endedConnectedAt || known.measuredAt !== event.measuredAt
      || known.receivedAt !== event.receivedAt) return;
    const reconnected = event.reconnected, boundary = state.vehicleDisconnect;
    if (boundary.awaitingConnection && reconnected?.retained === false
      && boundaryId(reconnected.readingId) && reconnected.readingId !== boundary.readingId
      && isTime(reconnected.measuredAt) && isTime(reconnected.receivedAt)
      && reconnected.measuredAt > boundary.measuredAt
      // Stream source events may arrive together or out of order. Their source
      // clocks establish the edge order; BMW delivery keeps its stricter rule.
      && (boundary.source === 'easee-stream' || reconnected.receivedAt > boundary.receivedAt)
      && reconnected.measuredAt <= now && reconnected.receivedAt <= now
      && (!boundary.reconnected || reconnected.measuredAt > boundary.reconnected.measuredAt))
      boundary.reconnected = { readingId: reconnected.readingId, measuredAt: reconnected.measuredAt,
        receivedAt: reconnected.receivedAt, retained: false };
    if (JSON.stringify(prior.vehicleDisconnect) === JSON.stringify(state.vehicleDisconnect)) return;
    try { await persist(); } catch (error) { state = prior; throw error; }
  }
  function observedConnection(now) {
    const boundary = state.vehicleDisconnect;
    if (!boundary?.awaitingConnection || snapshot.pluggedIn !== true) return snapshot.pluggedIn;
    // A change-reported connected value can survive a quick unplug/replug.
    // Keep that raw Easee reading intact, but do not reuse it as a new session.
    if (snapshot.online !== true || !snapshot.controlKnown || !isTime(snapshot.readAt)
      || snapshot.readAt < boundary.receivedAt || snapshot.readAt > now) return null;
    const pilot = snapshot.observations?.[100];
    const positiveTimes = [[2, 3, 4, 6, 7, 8].includes(snapshot.mode) ? snapshot.modeAt : null,
      ['B', 'C', 'D'].includes(pilot?.value) ? pilot.at : null];
    const disconnectedAt = Math.max(boundary.measuredAt, state.session?.lastDisconnectedAt ?? 0);
    const freshEasee = positiveTimes.some(at => isTime(at) && at > disconnectedAt && at <= now);
    const freshVehicle = boundary.reconnected && boundary.reconnected.measuredAt > disconnectedAt
      && snapshot.readAt >= boundary.reconnected.receivedAt;
    return freshEasee || freshVehicle ? true : null;
  }
  function remember(now, connection = observedConnection(now)) {
    const prior = state.session;
    const previousDisconnect = prior?.lastDisconnectedAt ?? (prior?.connected === false ? prior.observedAt ?? null : null);
    const disconnectedAt = isTime(snapshot.disconnectedAt) && snapshot.disconnectedAt <= now ? snapshot.disconnectedAt : now;
    state.session = { connected: typeof connection === 'boolean' ? connection : prior?.connected ?? null,
      connectedAt: connection === true ? prior?.connected === true ? prior.connectedAt : now
        : connection === false ? null : prior?.connectedAt ?? null,
      // Identification may arrive before the first connected poll, but never
      // borrow events from before the last source-reported disconnect. Missing
      // source clocks fall back conservatively to receipt time; older cached
      // events cannot rewind the boundary, including across restart.
      lastDisconnectedAt: connection === false ? Math.max(previousDisconnect ?? 0, disconnectedAt) : previousDisconnect,
      observedAt: now, instruction: currentFingerprint(), enabled: snapshot.enabled,
      stopped: stopped(snapshot), mode: snapshot.mode,
      modeAt: snapshot.modeAt ?? null,
      waitingForScheduleAt: snapshot.schedule.enabled !== 'none' && connection === true
        && snapshot.reason === 54 && snapshot.mode !== 3 ? now
        : prior?.instruction === currentFingerprint() ? prior.waitingForScheduleAt ?? null : null,
      delayedReleaseAt: snapshot.schedule.enabled === 'delayed' ? prior?.instruction === currentFingerprint()
        ? prior.delayedReleaseAt : nextLocalOccurrence(snapshot.schedule.delayed.startTime, snapshot.schedule.delayed.timezone, now) : null };
    if (connection === true && state.vehicleDisconnect?.awaitingConnection) state.vehicleDisconnect.awaitingConnection = false;
  }
  function rememberOwnInstruction(now) {
    if (state.session) {
      state.session.instruction = currentFingerprint(); state.session.delayedReleaseAt = state.owned?.startAt ?? null;
      state.session.waitingForScheduleAt = null;
    }
    observeSession(now);
  }
  function observeSession(now) {
    // Readable scheduling state is useful even without a connected vehicle.
    // Offline cached data cannot establish a manual change or a disconnect.
    if (snapshot.online !== true) return;
    const prior = state.session, connection = observedConnection(now);
    if (prior) {
      const scheduleChanged = prior.instruction !== currentFingerprint();
      const nativeExpiry = snapshot.schedule.enabled === 'none' && isTime(prior.delayedReleaseAt) && now >= prior.delayedReleaseAt;
      if (scheduleChanged && !ownsCurrent() && !normalExpiry(now) && !nativeExpiry) {
        state.owned = null;
        if (snapshot.schedule.enabled === 'none') {
          state.released = snapshot.pluggedIn === true;
          manual('charge-now', now, 'The Easee schedule was removed. Immediate charging has temporary priority.');
        } else yieldSchedule(now);
      }
      // Easee's Charge now command can bypass the native delayed start without
      // changing /schedules. A fresh charging observation after a verified wait,
      // before our release time, establishes that override. Initial plug-in
      // charging and an unconfirmed pause do not meet this evidence threshold.
      if (!scheduleChanged && !state.manual && ownsCurrent() && now < state.owned.startAt
        && snapshot.pluggedIn === true && isTime(prior.waitingForScheduleAt)
        && snapshot.mode === 3 && snapshot.reason !== 54
        && isTime(snapshot.modeAt) && snapshot.modeAt >= (prior.modeAt ?? prior.waitingForScheduleAt)) {
        state.released = true;
        manual('charge-now', now, 'Charging started in Easee before the scheduled release. Manual charging has priority until the vehicle is unplugged.');
      }
      if (snapshot.controlKnown && !snapshot.faulted && !snapshot.authorizationBlocked
        && ![5, 7, 8].includes(snapshot.mode) && ![55, 56].includes(snapshot.reason)) {
        if ((prior.enabled !== snapshot.enabled || prior.stopped !== stopped(snapshot)) && stopped(snapshot)) {
          manual('stop', now, STOP_REASON);
        } else if (prior.enabled === false && snapshot.enabled === true || prior.stopped && !stopped(snapshot)) {
          state.released = snapshot.pluggedIn === true;
          if (!scheduleChanged || !['window', 'schedule'].includes(state.manual?.kind))
            manual('enable', now, 'Charging was enabled outside automatic control. That instruction has temporary priority.');
        }
      }
    } else if (snapshot.schedule.enabled !== 'none' && !ownsCurrent()) {
      yieldSchedule(now);
    }
    if (snapshot.controlKnown && connection === false) {
      state.disconnected = true; state.released = false; state.provisional = false; state.execution = null;
      delete state.lastMissedTransition;
      if (state.manual && !['window', 'schedule'].includes(state.manual.kind)
        && !(state.vehicleDisconnect?.awaitingConnection && state.manual.kind === 'stop' && stopped(snapshot))) state.manual = null;
      if (state.owned && now >= state.owned.startAt && !state.vehicleDisconnect?.cleanupPending) state.owned = null;
    } else if (connection === true) {
      state.disconnected = false;
      if (prior?.connected === false) state.released = false;
    }
    // An unrestricted first observation is a baseline. A pre-existing foreign
    // restriction retains its owner's priority until a known end or resumption.
    remember(now, connection);
  }
  function executionFor(plan) {
    if (!Array.isArray(plan?.periods) || !plan.periods.length) return null;
    const periods = plan.periods.map(period => ({ startAt: period.startAt, endAt: period.endAt }));
    if (periods.some((period, index) => !isTime(period.startAt)
      || index < periods.length - 1 && (!isTime(period.endAt) || period.endAt <= period.startAt)
      || index === periods.length - 1 && period.endAt !== null && (!isTime(period.endAt) || period.endAt <= period.startAt)
      || index > 0 && period.startAt < periods[index - 1].endAt)) return null;
    return { planId: plan.id ?? plan.planId ?? null, periods,
      finalStartAt: periods.at(-1).startAt, deadlineAt: plan.deadlineAt ?? null };
  }
  function priceRevisionExecution(plan, now) {
    const prior = state.execution, revision = plan?.priceRevision, revised = executionFor(plan);
    if (!prior || !revision || !revised || !revised.planId || revised.planId === prior.planId
      || revision.previousPlanId !== prior.planId || !isTime(revision.at) || revision.at > now
      || revision.at < prior.periods[0].startAt || plan.feasible !== true || plan.provisional === true
      || !Number.isFinite(plan.requiredGridKwh) || plan.requiredGridKwh <= 0
      || !isTime(plan.deadlineAt) || plan.deadlineAt <= now || plan.deadlineAt !== prior.deadlineAt
      || revised.periods[0].startAt < revision.at) return null;
    // Retain elapsed automatic history, including the part of a running period
    // before this proposal. A continuous revision must not invent a pause.
    const elapsed = prior.periods.filter(period => period.startAt < revision.at).map(period => ({
      startAt: period.startAt, endAt: Math.min(period.endAt ?? revision.at, revision.at),
    }));
    const periods = [];
    for (const period of [...elapsed, ...revised.periods]) {
      const previous = periods.at(-1);
      if (previous?.endAt === period.startAt) previous.endAt = period.endAt;
      else periods.push({ ...period });
    }
    return { ...revised, periods,
      finalStartAt: periods.at(-1).startAt,
      pauseConfirmedThrough: prior.pauseConfirmedThrough <= revision.at ? prior.pauseConfirmedThrough ?? null : null };
  }
  function recordMissedTransition(now) {
    const execution = state.execution;
    if (!execution) return;
    for (let index = 0; index < execution.periods.length - 1; index++) {
      const pauseAt = execution.periods[index].endAt, resumeAt = execution.periods[index + 1].startAt;
      if (isTime(pauseAt) && resumeAt > pauseAt && resumeAt <= now
        && resumeAt > (execution.pauseConfirmedThrough ?? 0)
        && resumeAt > (state.lastMissedTransition?.resumeAt ?? 0)) {
        state.lastMissedTransition = { pauseAt, resumeAt, noticedAt: now };
      }
    }
  }
  async function waitingPhase(plannedPause, pauseRequested = false) {
    if ((plannedPause || pauseRequested) && snapshot.mode === 3) {
      await phase('pause-unconfirmed', 'Easee accepted the next start, but still reports charging. The planned pause is awaiting a fresh charger reading; charging may continue until it is confirmed.', 'pause-unconfirmed');
    } else if (!plannedPause) {
      await phase('waiting', state.execution?.periods.length > 1 ? 'The first charging start is confirmed in Easee. Later pauses require the connection to remain available.'
        : 'The delayed start is confirmed in Easee. Charging stays enabled after release.');
    } else if (snapshot.reason === 54 && isTime(state.owned?.scheduleRequestedAt)
      && snapshot.reasonAt >= state.owned.scheduleRequestedAt && snapshot.reasonAt <= clock()
      && snapshot.modeAt >= state.owned.scheduleRequestedAt && snapshot.modeAt <= clock()) {
      if (state.execution && state.owned) state.execution.pauseConfirmedThrough = Math.max(
        state.execution.pauseConfirmedThrough ?? 0, state.owned.startAt);
      await phase('paused', 'The next start is confirmed in Easee and charging is paused between planned periods.');
    } else {
      await phase('pause-unconfirmed', 'The next start is confirmed in Easee, but the charger has not yet reported waiting for that schedule. The next reading will check whether the planned pause took effect.', 'pause-unconfirmed');
    }
  }
  async function clearCurrent(kind, expectedGeneration, cleanup = false) {
    if (!['delayed', 'daily', 'weekly'].includes(kind)) throw Object.assign(new Error('Unsupported schedule'), { code: 'unsupported-schedule' });
    const expectedFingerprint = snapshot.fingerprint, expectedControlFingerprint = snapshot.controlFingerprint;
    state.pending = { action: 'clear', kind, previousFingerprint: expectedFingerprint,
      previousActiveFingerprint: currentFingerprint(), startedAt: clock() };
    await persist();
    snapshot = await adapter.clear({ kind, expectedFingerprint, expectedControlFingerprint,
      canMutate: () => permitted() && generation === expectedGeneration && (cleanup || controlRequested()) });
    state.lastReadAt = snapshot.readAt;
    if (snapshot.schedule.enabled !== 'none') throw Object.assign(new Error('Schedule handover mismatch'), { code: 'readback-mismatch' });
    state.pending = null; state.owned = null;
    if (state.vehicleDisconnect?.cleanupPending) state.vehicleDisconnect.cleanupPending = false;
    rememberOwnInstruction(clock());
  }
  async function takeOver(expectedGeneration, token) {
    takeoverState = 'blocked'; takeoverAttempt = token;
    if (!token || token !== takeoverToken()) throw Object.assign(new Error('Stale automatic handover'), { code: 'takeover-stale' });
    if (!permitted() || !takeoverStatus().available || !desired.enabled) throw Object.assign(new Error('Control unavailable'), { code: 'control-revoked' });
    const plan = snapshot.pluggedIn === true
      ? typeof getPlan === 'function' ? await getPlan(copy(snapshot), { takeover: true }) : desired.plan : null;
    if (snapshot.pluggedIn === true && (!plan || !isTime(plan.startAt)))
      throw Object.assign(new Error('Automatic handover needs a charging plan'), { code: 'invalid-plan' });
    const now = clock(), execution = executionFor(plan);
    const active = execution?.periods.some(period => period.startAt <= now && (period.endAt === null || period.endAt > now));
    const startAt = execution && !active ? execution.periods.find(period => period.startAt > now)?.startAt ?? plan.startAt : plan?.startAt;
    const pause = startAt > now ? { startAt, timezone: desired.timezone,
      maximumAmps: typeof getMaximumAmps === 'function' ? getMaximumAmps(copy(snapshot)) : desired.maximumAmps } : null;
    const priorManual = state.manual;
    takeoverState = 'pending';
    snapshot = await adapter.takeover({ expectedSnapshot: copy(snapshot), pause,
      canMutate: () => permitted() && expectedGeneration === generation && desired.enabled === true,
      beforeWrite: async ({ stage, before }) => {
        if (stage === 'schedule') {
          const expectedSchedule = pause ? { ...before.schedule, enabled: 'delayed', delayed: delayedScheduleFor(pause, clock()) } : null;
          state.pending = pause ? { action: 'install', planId: plan.id ?? plan.planId ?? null, startAt,
            expectedFingerprint: scheduleFingerprint(expectedSchedule), expectedActiveFingerprint: activeFingerprint(expectedSchedule),
            previousFingerprint: before.fingerprint, previousActiveFingerprint: activeFingerprint(before.schedule),
            startedAt: clock(), installRequestedAt: clock(), ...(execution ? { execution: copy(execution) } : {}) }
            : { action: 'clear', kind: before.schedule.enabled, previousFingerprint: before.fingerprint,
              previousActiveFingerprint: activeFingerprint(before.schedule), startedAt: clock() };
        }
        state.takeoverPending = { connectedAt: state.session?.connectedAt ?? null, requestedAt: clock(), stage,
          beforeSchedule: activeFingerprint(before.schedule),
          afterSchedule: stage === 'schedule' ? pause ? state.pending.expectedActiveFingerprint : activeFingerprint({ enabled: 'none' })
            : activeFingerprint(before.schedule), enabledAt: before.observations?.[31]?.at ?? null,
          reasonAt: before.reasonAt ?? null };
        await persist();
      },
      afterWrite: async ({ stage, snapshot: observed }) => {
        snapshot = observed;
        if (stage === 'schedule') {
          state.owned = pause ? confirmedOwned(clock(), state.pending) : null;
          state.pending = null;
        }
        // Record only positively confirmed own changes as the new baseline.
        remember(clock()); await persist();
      } });
    if (expectedGeneration !== generation || !permitted()) throw Object.assign(new Error('Control changed'), { code: 'control-revoked' });
    const unresolved = state.takeoverPending;
    state.manual = null; state.released = false; state.execution = execution; state.provisional = false;
    if (priorManual) state.lastManualResume = { at: clock(), deadlineAt: priorManual.cycleEndsAt, reason: 'explicit' };
    remember(clock()); state.takeoverPending = null;
    try { await persist(); } catch (error) { state.takeoverPending = unresolved; throw error; }
    takeoverState = 'confirmed';
  }
  async function refreshIdentification(now) {
    const next = typeof getIdentification === 'function' ? await getIdentification(copy(snapshot)) : null;
    if (next != null && (typeof next !== 'object' || Array.isArray(next)
      || Object.keys(next).some(key => !['id', 'connectedAt', 'phase', 'pauseUntil'].includes(key))
      || !boundaryId(next.id) || !isTime(next.connectedAt) || next.connectedAt > now
      || !['waiting', 'charging', 'pausing'].includes(next.phase)
      || next.phase === 'pausing' && (!isTime(next.pauseUntil) || next.pauseUntil - now > MAX_IDENTIFICATION_PAUSE_MS)
      || next.phase !== 'pausing' && next.pauseUntil !== undefined)) throw Object.assign(new Error('Invalid identification request'), { code: 'invalid-plan' });
    identification = next && next.connectedAt === state.session?.connectedAt && snapshot.pluggedIn === true
      && !state.vehicleDisconnect?.awaitingConnection && (next.phase !== 'pausing' || next.pauseUntil > now)
      ? copy(next) : null;
  }
  async function identify(expectedGeneration) {
    const request = identification, now = clock();
    state.execution = null; state.released = false; state.provisional = false;
    if (request.phase !== 'pausing') {
      if (ownsCurrent()) await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
      await phase('identifying', request.phase === 'waiting' ? 'Vehicle identification is pending until charging starts.'
        : 'Charging briefly to identify the connected vehicle.');
      return;
    }
    const startAt = request.pauseUntil;
    const maximumAmps = typeof getMaximumAmps === 'function' ? getMaximumAmps(copy(snapshot)) : desired.maximumAmps;
    const delayed = delayedScheduleFor({ startAt, timezone: desired.timezone, maximumAmps }, now);
    const expectedState = { ...copy(snapshot.schedule), enabled: 'delayed', delayed };
    const expectedActiveFingerprint = activeFingerprint(expectedState);
    if (ownsCurrent() && state.owned.purpose === 'identification' && state.owned.identificationId === request.id
      && currentFingerprint() === expectedActiveFingerprint) {
      await phase('identifying', 'Waiting for the charger and vehicle to confirm the identification pause.');
      return;
    }
    const pending = { action: 'install', planId: request.id, startAt, purpose: 'identification',
      identificationId: request.id, identificationConnectedAt: request.connectedAt,
      expectedFingerprint: scheduleFingerprint(expectedState), expectedActiveFingerprint,
      previousFingerprint: snapshot.fingerprint, previousActiveFingerprint: currentFingerprint(), startedAt: now };
    state.pending = pending;
    await phase('identifying', 'Requesting a brief charging pause to identify the connected vehicle.');
    snapshot = await adapter.installDelayed({ startAt, timezone: desired.timezone, maximumAmps,
      identification: { id: request.id, connectedAt: request.connectedAt }, allowChargingPause: true,
      expectedFingerprint: snapshot.fingerprint, expectedControlFingerprint: snapshot.controlFingerprint,
      canMutate: () => permitted() && expectedGeneration === generation && identification?.id === request.id
        && identification.connectedAt === state.session?.connectedAt && clock() < startAt,
      beforeWrite: async before => {
        const previous = state.pending, witnessed = { ...pending, installRequestedAt: clock(),
          ...(before.mode === 3 ? { pauseRequestedAt: clock() } : {}) };
        state.pending = witnessed;
        try { await persist(); } catch (error) { state.pending = previous; throw error; }
        Object.assign(pending, witnessed);
      } });
    state.lastReadAt = snapshot.readAt;
    if (currentFingerprint() !== expectedActiveFingerprint) throw Object.assign(new Error('Schedule readback mismatch'), { code: 'readback-mismatch' });
    state.owned = confirmedOwned(clock(), pending); state.pending = null;
    rememberOwnInstruction(clock());
    if (state.manual) await phase('yielded', state.manual.reason);
    else await phase('identifying', 'Waiting for the charger and vehicle to confirm the identification pause.');
  }
  async function reconcile(expectedGeneration, refreshed = false) {
    let now = clock(), operation = 'read-failed';
    const previousIdentification = identification !== null || state.owned?.purpose === 'identification';
    if (closed || expectedGeneration !== generation) return status();
    if (!adapter?.read) {
      await phase(desired.enabled ? 'unavailable' : 'off', desired.enabled ? 'The Easee connection is not configured.' : 'Automatic charging is off.');
      return status();
    }
    try {
      if (desired.replan === true) {
        state.released = false; state.execution = null; state.provisional = false; state.phase = 'unavailable';
        await persist(); planningRevision = desired.controlsRevision ?? null; desired.replan = false;
      }
      await observeVehicleDisconnect(now);
      if (expectedGeneration !== generation || closed) return status();
      snapshot = await adapter.read(); now = clock(); state.lastReadAt = snapshot.readAt;
      if (expectedGeneration !== generation || closed) return status();
      // A timeout can follow a successful cloud write. Recover durable intent
      // before interpreting the newly observed instruction as an app edit.
      if (state.pending?.action === 'install') {
        const expected = state.pending.expectedActiveFingerprint;
        if (expected ? currentFingerprint() === expected : snapshot.fingerprint === state.pending.expectedFingerprint) {
          state.owned = confirmedOwned(now, state.pending);
          if (state.pending.execution) {
            state.execution = copy(state.pending.execution);
            state.released = now >= state.execution.finalStartAt;
          }
          state.pending = null;
          // Own writes are never external session actions, including recovery.
          if (state.session) state.session.instruction = currentFingerprint();
        } else {
          const unchanged = state.pending.previousActiveFingerprint
            ? currentFingerprint() === state.pending.previousActiveFingerprint : snapshot.fingerprint === state.pending.previousFingerprint;
          state.pending = null; if (!unchanged) state.owned = null;
        }
      } else if (state.pending?.action === 'clear') {
        if (snapshot.schedule.enabled === 'none') {
          state.owned = null;
          if (state.session) state.session.instruction = currentFingerprint();
        }
        state.pending = null;
      }
      if (state.manual && !isTime(state.manual.cycleEndsAt)) {
        const { reason: _reason, ...prior } = state.manual;
        const knownWindow = prior.kind === 'window' ? manualScheduleWindow(snapshot.schedule,
          isTime(prior.detectedAt) ? prior.detectedAt : now) : null;
        manual(prior.kind === 'window' && !knownWindow ? 'schedule' : prior.kind,
          isTime(prior.detectedAt) ? prior.detectedAt : now, prior.kind === 'stop' ? STOP_REASON
            : 'An observed manual Easee instruction has temporary priority.', { ...prior,
              kind: prior.kind === 'window' && !knownWindow ? 'schedule' : prior.kind,
              windowEndAt: knownWindow?.windowEndAt ?? null, resumeAt: null });
      }
      if (state.takeoverPending && !desired.takeover) {
        const unresolved = state.takeoverPending;
        const newerStop = snapshot.stopped && (snapshot.enabled === false && snapshot.observations?.[31]?.at > Math.max(unresolved.enabledAt ?? 0, unresolved.requestedAt)
          || snapshot.reason === 53 && snapshot.reasonAt > Math.max(unresolved.reasonAt ?? 0, unresolved.requestedAt));
        const differentSchedule = snapshot.online === true && ![unresolved.beforeSchedule, unresolved.afterSchedule].includes(currentFingerprint())
          && !(ownsCurrent() || normalExpiry(now));
        const differentConnection = snapshot.pluggedIn === false || unresolved.connectedAt !== (state.session?.connectedAt ?? null)
          || state.session?.connected === false && snapshot.pluggedIn === true;
        if (newerStop || differentSchedule || differentConnection) state.takeoverPending = null;
        else if (desired.enabled === true) {
          await phase('unconfirmed', DIAGNOSTICS['takeover-unconfirmed'], 'takeover-unconfirmed'); return status();
        }
      }
      observeSession(now);
      if (desired.takeover) {
        const token = desired.takeover; desired.takeover = null;
        await takeOver(expectedGeneration, token);
        now = clock();
      }
      if (state.owned && !ownsCurrent()) {
        if (normalExpiry(now) && (!state.execution || now >= state.execution.finalStartAt)) state.released = snapshot.pluggedIn === true;
        state.owned = null;
      }
      await refreshIdentification(now);
      if (closed || expectedGeneration !== generation) return status();
      if (previousIdentification && !identification) {
        state.execution = null; state.released = false; state.provisional = false;
      }
      // Only a temporary identification restriction is released on completion.
      // Reset automatic execution even if charging had been released earlier.
      if (state.owned?.purpose === 'identification' && (!identification
        || state.owned.identificationId !== identification.id)) {
        // A future economic plan can replace the delay in one write. Releasing
        // first would briefly restart charging between the two restrictions.
        if (ownsCurrent() && (!desired.enabled || chargeNowActive() || identification || now >= state.owned.startAt)) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration, true);
        }
        state.execution = null; state.released = false; state.provisional = false;
      }
      if (!controlRequested()) {
        if (snapshot.online === true && isTime(state.manual?.resumeAt) && now >= state.manual.resumeAt) {
          state.lastManualResume = { at: now, deadlineAt: state.manual.cycleEndsAt, reason: state.manual.resumeReason };
          state.manual = null; state.released = false;
        }
        state.handoverConfirmed = false;
        if (ownsCurrent()) {
          if (!permitted()) { await phase('off', 'Control is off; charger handover is unconfirmed.', 'control-revoked'); return status(); }
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration, true);
        }
        state.pending = null; state.execution = null; state.handoverConfirmed = true;
        await phase('off', snapshot.schedule.enabled === 'none' ? 'Automatic charging is off.'
          : 'Automatic charging is off; the current Easee schedule is preserved.');
        return status();
      }
      state.handoverConfirmed = null;
      if (!permitted()) { await phase('unavailable', 'This instance has no charger control authority.', 'control-revoked'); return status(); }
      if (snapshot.online !== true) { await phase('unavailable', 'Easee is offline. Automatic control will retry when it reconnects.', 'offline'); return status(); }
      if (snapshot.faulted || snapshot.mode === 5 || snapshot.reason === 56) { await phase('unavailable', 'Easee reports a charger fault. Check the charger before charging.', 'charger-fault'); return status(); }
      if (snapshot.authorizationBlocked || [7, 8].includes(snapshot.mode) || snapshot.reason === 55) {
        await phase('unavailable', 'Easee is waiting for charging authorization.', 'charging-authorization'); return status();
      }
      if (!snapshot.controlKnown) { await phase('unavailable', 'Easee has not supplied enough charger state to confirm control.', 'incomplete-state'); return status(); }
      if (stopped(snapshot)) {
        await phase(state.manual?.kind === 'stop' ? 'yielded' : 'unavailable', state.manual?.kind === 'stop' ? STOP_REASON
          : STOP_REASON, state.manual?.kind === 'stop' ? null : 'charger-stopped');
        return status();
      }
      if (state.vehicleDisconnect?.cleanupPending) {
        state.execution = null; state.released = false; state.provisional = false;
        if (state.manual?.kind === 'stop') state.manual = null;
      }
      recordMissedTransition(now);
      // Zero power, target completion and passed deadlines never reset release.
      if (state.execution && now >= state.execution.finalStartAt
        || !state.execution && state.owned && now >= state.owned.startAt) {
        state.released = true;
      }
      if (state.manual) {
        const prior = state.manual;
        // A user's enable must not remain blocked by our earlier delayed start.
        // Relinquish only the exact active instruction we still own.
        if (['enable', 'charge-now'].includes(prior.kind) && ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        }
        const ended = isTime(prior.resumeAt) && now >= prior.resumeAt;
        if (ended) {
          state.lastManualResume = { at: now, deadlineAt: prior.cycleEndsAt, reason: prior.resumeReason };
          state.manual = null; state.execution = null;
          state.released = false;
        } else { await phase('yielded', prior.reason); return status(); }
      }
      if (identification) { operation = 'command-failed'; await identify(expectedGeneration); return status(); }
      if (chargeNowActive() && !state.manual) {
        // A session override releases only our own restriction. External native
        // instructions and all device protections continue to take precedence.
        if (ownsCurrent()) { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
        state.execution = null; state.released = true; state.provisional = false;
        await phase('released', 'Charge Now is active for this connection. Charger and vehicle limits still apply.');
        return status();
      }
      if (!desired.enabled) { await phase('off', 'Automatic charging is off.'); return status(); }
      if (state.vehicleDisconnect?.cleanupPending) {
        if (ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        } else state.vehicleDisconnect.cleanupPending = false;
        state.execution = null; state.released = false; state.provisional = false;
      }
      if (snapshot.pluggedIn !== true || state.vehicleDisconnect?.awaitingConnection) {
        if (snapshot.pluggedIn === false && ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        }
        await phase('disconnected', state.vehicleDisconnect?.awaitingConnection
          ? 'The previous vehicle disconnected. Waiting for fresh connection evidence before starting a new charging session.'
          : snapshot.pluggedIn === false ? 'Connect a vehicle to plan automatic charging.'
            : 'Waiting for Easee to confirm whether a vehicle is connected.'); return status();
      }
      let plan = typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : desired.plan;
      now = clock();
      const priceExecution = priceRevisionExecution(plan, now);
      if (plan?.priceRevision && !priceExecution) plan = null;
      if (state.released && !state.provisional && !priceExecution) {
        // Take over a pre-existing stopping schedule without interrupting a
        // charge already underway. Only its restriction is removed.
        if (snapshot.schedule.enabled !== 'none' && !ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
        }
        await phase('released', RELEASE_REASON); return status();
      }
      let execution = priceExecution ?? (state.execution && now >= state.execution.periods[0].startAt
        ? state.execution : executionFor(plan));
      if (!priceExecution && execution && now >= execution.periods[0].startAt && now < execution.finalStartAt
        && !execution.periods.some(period => period.startAt <= now && now < period.endAt)
        && (plan?.id ?? plan?.planId) !== execution.planId) {
        const revised = executionFor(plan);
        const remaining = revised?.periods.filter(period => period.endAt === null || period.endAt > now);
        if (remaining?.length) {
          const elapsed = execution.periods.filter(period => isTime(period.endAt) && period.endAt <= now);
          const previousEnd = elapsed.at(-1)?.endAt ?? 0;
          remaining[0] = { ...remaining[0], startAt: Math.max(previousEnd, remaining[0].startAt) };
          execution = { ...revised, periods: [...elapsed, ...remaining],
            pauseConfirmedThrough: execution.pauseConfirmedThrough ?? null };
        }
      }
      let plannedPause = false;
      if (execution && !plan?.provisional && now >= execution.periods[0].startAt) {
        if (now >= execution.finalStartAt) {
          if (snapshot.schedule.enabled !== 'none') { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
          state.execution = copy(execution); state.provisional = false;
          state.released = true; await phase('released', RELEASE_REASON); return status();
        }
        const current = execution.periods.find(period => period.startAt <= now && now < period.endAt);
        if (current) {
          // Equalizer or vehicle zero power does not shorten this interval. A
          // verified price revision may move its end before the next period.
          if (snapshot.schedule.enabled !== 'none' && (!ownsCurrent() || state.owned.startAt > now)) { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
          state.execution = copy(execution); state.provisional = false; state.released = false;
          await phase('active', 'This charging period is open. A planned pause follows before the next cheaper period.'); return status();
        }
        const next = execution.periods.find(period => period.startAt > now);
        if (next) {
          plannedPause = true;
          plan = { ...plan, id: execution.planId, startAt: next.startAt };
        }
      }
      if (!plan || !isTime(plan.startAt)) { await phase('unavailable', 'Waiting for a charging plan.'); return status(); }
      if (plan.startAt <= now) {
        if (snapshot.schedule.enabled !== 'none') { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
        state.provisional = plan.provisional === true || plan.feasible === false;
        state.released = !state.provisional; state.manual = null; state.execution = null;
        await phase(state.provisional ? 'provisional' : 'released', state.provisional
          ? 'Charging is allowed while planning inputs are incomplete or insufficient. The schedule will be reconsidered when the forecast improves.' : RELEASE_REASON); return status();
      }
      state.provisional = false;
      const pauseRequested = plannedPause || snapshot.mode === 3;
      const maximumAmps = typeof getMaximumAmps === 'function' ? getMaximumAmps(copy(snapshot)) : desired.maximumAmps;
      operation = 'invalid-plan';
      const delayed = delayedScheduleFor({ startAt: plan.startAt, timezone: desired.timezone, maximumAmps }, now);
      const expectedState = { ...copy(snapshot.schedule), enabled: 'delayed', delayed };
      const expectedFingerprint = scheduleFingerprint(expectedState), expectedActiveFingerprint = activeFingerprint(expectedState);
      if (state.owned && currentFingerprint() === expectedActiveFingerprint) {
        delete state.owned.purpose; delete state.owned.identificationId; delete state.owned.identificationConnectedAt;
        state.owned.planId = plan.id ?? plan.planId ?? null;
        state.execution = execution ? copy(execution) : null; state.released = false;
        await waitingPhase(plannedPause, pauseRequested); return status();
      }
      state.pending = { action: 'install', planId: plan.id ?? plan.planId ?? null, startAt: plan.startAt,
        expectedFingerprint, expectedActiveFingerprint, previousFingerprint: snapshot.fingerprint,
        previousActiveFingerprint: currentFingerprint(), startedAt: now,
        ...(execution ? { execution: copy(execution), periods: copy(execution.periods), finalStartAt: execution.finalStartAt } : {}) };
      const pending = copy(state.pending);
      await phase('unconfirmed', 'The delayed start is being confirmed with Easee.');
      operation = 'command-failed';
      snapshot = await adapter.installDelayed({ startAt: plan.startAt, timezone: desired.timezone, maximumAmps,
        allowChargingPause: pauseRequested,
        expectedFingerprint: snapshot.fingerprint, expectedControlFingerprint: snapshot.controlFingerprint,
        canMutate: () => permitted() && expectedGeneration === generation && desired.enabled === true,
        beforeWrite: async before => {
          // API preflight may consume the minimum gap after runtime planning.
          // Refresh before writing, including while Equalizer limits output.
          if (priceExecution && plan.startAt - clock() < MIN_PRICE_PAUSE_MS)
            throw Object.assign(new Error('The proposed price pause is now too short'), { code: 'state-changed' });
          // Persist the schedule boundary for causal confirmation. Only an
          // actually charging guarded read supplies a vehicle pause witness.
          const prior = state.pending, witnessed = { ...pending, installRequestedAt: clock(),
            ...(before.mode === 3 ? { pauseRequestedAt: clock() } : {}) };
          state.pending = witnessed;
          try { await persist(); } catch (error) { state.pending = prior; throw error; }
          pending.installRequestedAt = witnessed.installRequestedAt;
          if (witnessed.pauseRequestedAt !== undefined) pending.pauseRequestedAt = witnessed.pauseRequestedAt;
        } });
      state.lastReadAt = snapshot.readAt;
      if (currentFingerprint() !== expectedActiveFingerprint) throw Object.assign(new Error('Schedule readback mismatch'), { code: 'readback-mismatch' });
      state.owned = confirmedOwned(clock(), pending); state.execution = execution ? copy(execution) : null;
      state.released = false; state.pending = null;
      rememberOwnInstruction(clock());
      // OFF during POST still records the actual result for queued cleanup.
      if (expectedGeneration !== generation || desired.enabled !== true) { await persist(); return status(); }
      if (state.manual) await phase('yielded', state.manual.reason);
      else await waitingPhase(plannedPause, pauseRequested);
    } catch (error) {
      if (takeoverState === 'pending') takeoverState = 'blocked';
      const errorCode = Object.hasOwn(DIAGNOSTICS, error?.code) ? error.code : operation;
      if (errorCode === 'state-changed') {
        // The pre-write guard guarantees no command was sent. A fresh read
        // distinguishes harmless telemetry movement from an actual app edit.
        state.pending = null;
        if (!refreshed && !closed && expectedGeneration === generation) return reconcile(expectedGeneration, true);
      }
      if (!controlRequested()) {
        state.handoverConfirmed = false;
        await phase('off', 'Control is off; charger handover is unconfirmed.', errorCode);
      } else {
        const cause = errorCode === 'invalid-plan' && typeof error?.publicReason === 'string'
          ? `${error.publicReason} Planning will retry after refreshing its inputs.` : DIAGNOSTICS[errorCode];
        const consequence = state.owned ? ' The previously confirmed Easee instruction remains recorded and will be checked before any change.'
          : state.pending ? ' The latest command is unconfirmed; the charger may already have accepted it.' : ' No new charging restriction was installed.';
        await phase(state.pending ? 'unconfirmed' : 'unavailable', `${cause}${consequence}`, errorCode);
      }
    }
    return status();
  }
  return {
    supportsIdentification: true,
    status,
    update(input = {}) {
      if (Object.hasOwn(input, 'resume')) throw new Error('Unsupported charging control field: resume');
      if (typeof input.takeover !== 'string' && takeoverState !== 'pending') { takeoverState = null; takeoverAttempt = null; }
      desired = { ...desired, ...input, enabled: input.enabled ?? desired.enabled,
        takeover: typeof input.takeover === 'string' ? input.takeover : null };
      const expectedGeneration = ++generation;
      queue = queue.catch(() => {}).then(() => reconcile(expectedGeneration));
      return queue.then(result => expectedGeneration === generation || closed ? result : queue);
    },
    invalidate() { generation++; },
    close() { closed = true; generation++; return queue.catch(() => {}); },
  };
}
