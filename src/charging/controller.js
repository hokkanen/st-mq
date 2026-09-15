import { resolveChargingDeadline } from './settings.js';
import { TIME_ZONE } from '../domain/prices.js';
import { delayedScheduleFor, effectiveScheduleFingerprint, manualScheduleWindow, nextLocalOccurrence, scheduleFingerprint } from './easee.js';

const copy = value => structuredClone(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
// Inactive cached recurrences are not instructions to this charging session.
const activeFingerprint = effectiveScheduleFingerprint;
const ownedFingerprint = owned => owned?.activeFingerprint ?? (owned?.schedule ? activeFingerprint(owned.schedule) : null);
const STOP_REASON = 'The charger was paused or disabled in Easee. Resume it there before returning to automatic charging.';
const RELEASE_REASON = 'Charging is released and may continue beyond the minimum and deadline.';
const DIAGNOSTICS = {
  'read-failed': 'Easee could not be read. Automatic control will retry when the connection recovers.',
  'command-failed': 'Easee did not confirm the schedule command. Its current instruction will be checked before retrying.',
  'readback-failed': 'Easee schedule confirmation could not be read. Its current instruction will be checked before retrying.',
  'readback-mismatch': 'Easee returned a different schedule after the command. Its current instruction will be checked before retrying.',
  'access-denied': 'Easee rejected access. Check the Easee connection credentials.',
  'control-revoked': 'Charger control authority changed before the command completed.',
  'state-changed': 'Easee changed during the check. The current instruction will be read again before making changes.',
  'unsupported-schedule': 'This Easee schedule type cannot be released through the available API. Disable it in Easee to resume automatic charging.',
  'invalid-plan': 'The proposed start or charging limit is invalid. A new plan will be requested.',
  'missing-current-limit': 'Easee has not supplied a usable charger current limit. Another reading will be requested before scheduling.',
  'start-passed': 'The proposed start arrived while Easee was being checked. The current instruction will be read again to release charging.',
  'ambiguous-start': 'The proposed start falls in a repeated daylight-saving hour, which Easee cannot identify uniquely. A new unambiguous plan is needed.',
  'start-out-of-range': 'Easee accepts only the next occurrence of a local start time. This proposed date is farther ahead; planning will retry closer to the start.',
};

/** Durable native instruction ownership and observed manual priority. */
export function createChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan, getMaximumAmps } = {}) {
  // Retain confirmed ownership across upgrades so an installed restriction can
  // still be relinquished. Version 1 manual flags lack an observed baseline.
  const previous = [1, 2, 3].includes(initialState?.version) ? copy(initialState) : {};
  let state = { phase: 'off', owned: null, pending: null, manual: null, released: false,
    disconnected: false, execution: null, handoverConfirmed: true, reason: 'Automatic charging is off.',
    ...previous, version: 3, session: previous.version >= 2 ? previous.session ?? null : null,
    manual: previous.version >= 2 ? previous.manual ?? null : null, errorCode: null };
  let desired = { enabled: false, plan: null, readyBy: '06:00', timezone: TIME_ZONE }, snapshot = null, closed = false, generation = 0, queue = Promise.resolve();
  const permitted = () => !closed && canControl() === true;
  const status = () => ({ ...copy(state), enabled: desired.enabled === true, snapshot: snapshot ? copy(snapshot) : null });
  const currentFingerprint = () => activeFingerprint(snapshot.schedule);
  const ownsCurrent = () => state.owned && ownedFingerprint(state.owned) === currentFingerprint();
  async function persist() { await saveState(copy(state)); }
  async function phase(value, reason, errorCode = null) { state.phase = value; state.reason = reason; state.errorCode = errorCode; await persist(); }
  const cycleEnd = now => resolveChargingDeadline(now, desired.readyBy, desired.timezone);
  const manualToken = value => value ? `${value.detectedAt}:${value.activeFingerprint}:${value.kind}` : null;
  function manual(kind, now, reason, extra = {}) {
    state.execution = null;
    const cycleEndsAt = cycleEnd(now), windowEndAt = extra.windowEndAt ?? extra.resumeAt ?? null;
    const resumeAt = isTime(windowEndAt) ? Math.min(windowEndAt, cycleEndsAt) : cycleEndsAt;
    state.manual = { kind, detectedAt: now, reason, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), ...extra, windowEndAt, cycleEndsAt, resumeAt,
      resumeReason: isTime(windowEndAt) && windowEndAt <= cycleEndsAt ? 'window-end' : 'ready-by' };
  }
  function yieldSchedule(now) {
    const window = manualScheduleWindow(snapshot.schedule, now, cycleEnd(now));
    manual(window ? 'window' : 'schedule', now, 'An observed change to the Easee schedule has temporary priority.', window ?? {});
  }
  function confirmedOwned(now, pending) {
    return { planId: pending.planId, startAt: pending.startAt, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), schedule: copy(snapshot.schedule), confirmedAt: now,
      ...(pending.periods ? { periods: copy(pending.periods), finalStartAt: pending.finalStartAt } : {}) };
  }
  function normalExpiry(now) {
    return state.owned && now >= state.owned.startAt && snapshot.schedule.enabled === 'none';
  }
  const stopped = value => typeof value.stopped === 'boolean' ? value.stopped
    : value.enabled === false || value.reason === 53;
  function remember(now) {
    const prior = state.session;
    state.session = { connected: snapshot.pluggedIn,
      connectedAt: snapshot.pluggedIn === true ? prior?.connected === true ? prior.connectedAt : now : null,
      observedAt: now, instruction: currentFingerprint(), enabled: snapshot.enabled,
      stopped: stopped(snapshot), mode: snapshot.mode,
      delayedReleaseAt: snapshot.schedule.enabled === 'delayed' ? prior?.instruction === currentFingerprint()
        ? prior.delayedReleaseAt : nextLocalOccurrence(snapshot.schedule.delayed.startTime, snapshot.schedule.delayed.timezone, now) : null };
  }
  function rememberOwnInstruction(now) {
    if (state.session) { state.session.instruction = currentFingerprint(); state.session.delayedReleaseAt = state.owned?.startAt ?? null; }
    observeSession(now);
  }
  function observeSession(now) {
    // Readable scheduling state is useful even without a connected vehicle.
    // Offline cached data cannot establish a manual change or a disconnect.
    if (snapshot.online !== true) return;
    const prior = state.session;
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
      if (snapshot.controlKnown && !snapshot.faulted && !snapshot.authorizationBlocked
        && ![5, 7, 8].includes(snapshot.mode) && ![55, 56].includes(snapshot.reason)) {
        if ((prior.enabled !== snapshot.enabled || prior.stopped !== stopped(snapshot)) && stopped(snapshot)) {
          manual('stop', now, STOP_REASON);
        } else if (prior.enabled === false && snapshot.enabled === true || prior.stopped && !stopped(snapshot)) {
          // A resume click acknowledges only changes already displayed. A newer
          // external schedule still wins even if it arrives during that read.
          const acknowledged = desired.resume === true && desired.resumeToken === manualToken(state.manual);
          if (!acknowledged) {
            state.released = snapshot.pluggedIn === true;
            if (!scheduleChanged || !['window', 'schedule'].includes(state.manual?.kind))
              manual('enable', now, 'Charging was enabled in Easee. The Easee app has temporary control.');
          }
        }
      }
    }
    if (snapshot.controlKnown && snapshot.pluggedIn === false) {
      state.disconnected = true; state.released = false; state.provisional = false; state.execution = null;
      delete state.lastMissedTransition;
      if (state.manual && !['window', 'schedule'].includes(state.manual.kind)) state.manual = null;
      if (state.owned && now >= state.owned.startAt) state.owned = null;
    } else if (snapshot.pluggedIn === true) {
      state.disconnected = false;
      if (prior?.connected === false) state.released = false;
    }
    // The first observation is a baseline, not evidence of an external action.
    remember(now);
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
    } else if (snapshot.reason === 54) {
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
      canMutate: () => permitted() && generation === expectedGeneration && (cleanup || desired.enabled === true) });
    state.lastReadAt = snapshot.readAt;
    if (snapshot.schedule.enabled !== 'none') throw Object.assign(new Error('Schedule handover mismatch'), { code: 'readback-mismatch' });
    state.pending = null; state.owned = null;
    rememberOwnInstruction(clock());
  }
  async function reconcile(expectedGeneration, refreshed = false) {
    let now = clock(), operation = 'read-failed';
    if (closed || expectedGeneration !== generation) return status();
    if (!adapter?.read) {
      await phase(desired.enabled ? 'unavailable' : 'off', desired.enabled ? 'The Easee connection is not configured.' : 'Automatic charging is off.');
      return status();
    }
    try {
      snapshot = await adapter.read(); now = clock(); state.lastReadAt = snapshot.readAt;
      if (expectedGeneration !== generation || closed) return status();
      // A timeout can follow a successful cloud write. Recover durable intent
      // before interpreting the newly observed instruction as an app edit.
      if (state.pending?.action === 'install') {
        const expected = state.pending.expectedActiveFingerprint;
        if (expected ? currentFingerprint() === expected : snapshot.fingerprint === state.pending.expectedFingerprint) {
          state.owned = confirmedOwned(now, state.pending);
          if (state.pending.execution) state.execution = copy(state.pending.execution);
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
        manual(prior.kind, isTime(prior.detectedAt) ? prior.detectedAt : now, prior.kind === 'stop' ? STOP_REASON
          : 'An observed manual Easee instruction has temporary priority.', prior);
      }
      observeSession(now);
      if (state.owned && !ownsCurrent()) {
        if (normalExpiry(now) && (!state.execution || now >= state.execution.finalStartAt)) state.released = snapshot.pluggedIn === true;
        state.owned = null;
      }
      if (desired.enabled !== true) {
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
        desired.resume = false;
        await phase(state.manual?.kind === 'stop' ? 'yielded' : 'unavailable', state.manual?.kind === 'stop' ? STOP_REASON
          : 'Enable or resume the charger in Easee before automatic charging can schedule it.', state.manual?.kind === 'stop' ? null : 'charger-stopped');
        return status();
      }
      recordMissedTransition(now);
      // Zero power, target completion and passed deadlines never reset release.
      if (state.execution && now >= state.execution.finalStartAt
        || !state.execution && state.owned && now >= state.owned.startAt) {
        state.released = true;
      }
      const resume = desired.resume === true && desired.resumeToken === manualToken(state.manual); desired.resume = false;
      if (state.manual) {
        const prior = state.manual;
        // A user's enable must not remain blocked by our earlier delayed start.
        // Relinquish only the exact active instruction we still own.
        if (prior.kind === 'enable' && ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        }
        const ended = isTime(prior.resumeAt) && now >= prior.resumeAt;
        if (resume || ended) {
          state.lastManualResume = { at: now, deadlineAt: prior.cycleEndsAt, reason: resume ? 'explicit' : prior.resumeReason };
          state.manual = null; state.execution = null;
          state.released = false;
        } else { await phase('yielded', prior.reason); return status(); }
      }
      if (snapshot.pluggedIn !== true) {
        if (snapshot.pluggedIn === false && ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        }
        await phase('disconnected', snapshot.pluggedIn === false ? 'Connect a vehicle to plan automatic charging.'
          : 'Waiting for Easee to confirm whether a vehicle is connected.'); return status();
      }
      if (state.released && !state.provisional) {
        // Take over a pre-existing stopping schedule without interrupting a
        // charge already underway. Only its restriction is removed.
        if (snapshot.schedule.enabled !== 'none' && !ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
        }
        await phase('released', RELEASE_REASON); return status();
      }
      let plan = typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : desired.plan;
      now = clock();
      let execution = state.execution && now >= state.execution.periods[0].startAt
        ? state.execution : executionFor(plan);
      if (execution && now >= execution.periods[0].startAt && now < execution.finalStartAt
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
        state.execution = copy(execution); state.provisional = false;
        if (now >= execution.finalStartAt) {
          if (snapshot.schedule.enabled !== 'none') { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
          state.released = true; await phase('released', RELEASE_REASON); return status();
        }
        const current = execution.periods.find(period => period.startAt <= now && now < period.endAt);
        if (current) {
          // The current interval is allowed, even if Equalizer or the vehicle
          // is temporarily drawing no power. Only its planned end may pause it.
          if (snapshot.schedule.enabled !== 'none' && (!ownsCurrent() || state.owned.startAt > now)) { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
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
        state.owned.planId = plan.id ?? plan.planId ?? null;
        state.execution = execution ? copy(execution) : null;
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
        canMutate: () => permitted() && expectedGeneration === generation && desired.enabled === true });
      state.lastReadAt = snapshot.readAt;
      if (currentFingerprint() !== expectedActiveFingerprint) throw Object.assign(new Error('Schedule readback mismatch'), { code: 'readback-mismatch' });
      state.owned = confirmedOwned(clock(), pending); state.execution = execution ? copy(execution) : null; state.pending = null;
      rememberOwnInstruction(clock());
      // OFF during POST still records the actual result for queued cleanup.
      if (expectedGeneration !== generation || desired.enabled !== true) { await persist(); return status(); }
      if (state.manual) await phase('yielded', state.manual.reason);
      else await waitingPhase(plannedPause, pauseRequested);
    } catch (error) {
      const errorCode = Object.hasOwn(DIAGNOSTICS, error?.code) ? error.code : operation;
      if (errorCode === 'state-changed') {
        // The pre-write guard guarantees no command was sent. A fresh read
        // distinguishes harmless telemetry movement from an actual app edit.
        state.pending = null;
        if (!refreshed && !closed && expectedGeneration === generation) return reconcile(expectedGeneration, true);
      }
      if (desired.enabled !== true) {
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
    status,
    update(input = {}) {
      desired = { ...desired, ...input, enabled: input.enabled ?? desired.enabled,
        ...(input.resume === true ? { resumeToken: manualToken(state.manual) } : {}) };
      if (desired.enabled !== true) desired.resume = false;
      const expectedGeneration = ++generation;
      queue = queue.catch(() => {}).then(() => reconcile(expectedGeneration));
      return queue.then(result => expectedGeneration === generation || closed ? result : queue);
    },
    close() { closed = true; generation++; return queue.catch(() => {}); },
  };
}
