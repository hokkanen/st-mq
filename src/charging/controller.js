import { delayedScheduleFor, effectiveScheduleFingerprint, manualScheduleWindow, nextLocalOccurrence, scheduleFingerprint } from './easee.js';

const copy = value => structuredClone(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
// Inactive cached recurrences are not instructions to this charging session.
const activeFingerprint = effectiveScheduleFingerprint;
const ownedFingerprint = owned => owned?.activeFingerprint ?? (owned?.schedule ? activeFingerprint(owned.schedule) : null);
const STOP_REASON = 'A manual stop made after plug-in has priority. Resume charging in Easee before returning control to ST-MQ.';
const RELEASE_REASON = 'Charging is released and may continue beyond the minimum and deadline.';
const DIAGNOSTICS = {
  'read-failed': 'Easee could not be read. Automatic control will retry when the connection recovers.',
  'command-failed': 'Easee did not confirm the schedule command. Its current instruction will be checked before retrying.',
  'readback-failed': 'Easee schedule confirmation could not be read. Its current instruction will be checked before retrying.',
  'readback-mismatch': 'Easee returned a different schedule after the command. Its current instruction will be checked before retrying.',
  'access-denied': 'Easee rejected access. Check the Easee connection credentials.',
  'control-revoked': 'Charger control authority changed before the command completed.',
  'state-changed': 'Easee changed during the check. The current instruction will be read again before making changes.',
  'unsupported-schedule': 'Release this schedule in the Easee app before returning control to ST-MQ.',
  'invalid-plan': 'The proposed start cannot be represented by an Easee delayed schedule.',
};

/** Persisted ownership and observed plug-in session; no local start/stop timer. */
export function createChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan, getMaximumAmps } = {}) {
  // Older ownership records remain useful for safely relinquishing a confirmed
  // native write. Old manual flags have no evidence of a post-plug-in action.
  const previous = [1, 2].includes(initialState?.version) ? copy(initialState) : {};
  let state = { phase: 'off', owned: null, pending: null, manual: null, released: false,
    disconnected: false, handoverConfirmed: true, reason: 'ST-MQ charging control is off.',
    ...previous, version: 2, session: previous.version === 2 ? previous.session ?? null : null,
    manual: previous.version === 2 ? previous.manual ?? null : null, errorCode: null };
  let desired = { enabled: false, plan: null }, snapshot = null, closed = false, generation = 0, queue = Promise.resolve();
  const permitted = () => !closed && canControl() === true;
  const status = () => ({ ...copy(state), enabled: desired.enabled === true, snapshot: snapshot ? copy(snapshot) : null });
  const currentFingerprint = () => activeFingerprint(snapshot.schedule);
  const ownsCurrent = () => state.owned && ownedFingerprint(state.owned) === currentFingerprint();
  async function persist() { await saveState(copy(state)); }
  async function phase(value, reason, errorCode = null) { state.phase = value; state.reason = reason; state.errorCode = errorCode; await persist(); }
  function manual(kind, now, reason, extra = {}) {
    state.manual = { kind, detectedAt: now, reason, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), ...extra };
  }
  function yieldSchedule(now) {
    const window = manualScheduleWindow(snapshot.schedule, now);
    manual(window ? 'window' : 'schedule', now, 'A manual Easee schedule changed after plug-in has priority.', window ?? {});
  }
  function confirmedOwned(now, pending) {
    return { planId: pending.planId, startAt: pending.startAt, fingerprint: snapshot.fingerprint,
      activeFingerprint: currentFingerprint(), schedule: copy(snapshot.schedule), confirmedAt: now };
  }
  function normalExpiry(now) {
    return state.owned && now >= state.owned.startAt && snapshot.schedule.enabled === 'none';
  }
  const stopped = value => typeof value.stopped === 'boolean' ? value.stopped
    : value.enabled === false || value.reason === 53;
  function remember(now, first = false) {
    state.session = { connected: snapshot.pluggedIn, connectedAt: first && snapshot.pluggedIn === true ? now : state.session?.connectedAt ?? null,
      observedAt: now, instruction: currentFingerprint(), enabled: snapshot.enabled,
      stopped: stopped(snapshot), mode: snapshot.mode,
      delayedReleaseAt: snapshot.schedule.enabled === 'delayed' ? state.session?.instruction === currentFingerprint()
        ? state.session.delayedReleaseAt : nextLocalOccurrence(snapshot.schedule.delayed.startTime, snapshot.schedule.delayed.timezone, now) : null };
  }
  function rememberOwnInstruction(now) {
    if (state.session) { state.session.instruction = currentFingerprint(); state.session.delayedReleaseAt = state.owned?.startAt ?? null; }
    observeSession(now);
  }
  function observeSession(now) {
    // An outage cannot invent a disconnect, a stop or a new session.
    if (snapshot.online !== true || !snapshot.controlKnown || snapshot.faulted || snapshot.authorizationBlocked
      || [5, 7, 8].includes(snapshot.mode) || [55, 56].includes(snapshot.reason)) return;
    const prior = state.session;
    if (snapshot.pluggedIn === false) {
      state.disconnected = true; state.released = false; state.manual = null;
      if (state.owned && now >= state.owned.startAt) state.owned = null;
      remember(now, true); return;
    }
    if (snapshot.pluggedIn !== true) return;
    if (prior?.connected !== true) {
      state.disconnected = false; state.manual = null;
      if (prior?.connected === false) state.released = false;
      if (state.owned && now >= state.owned.startAt && prior?.connected === false) state.owned = null;
      // At startup/arrival the current instruction is a baseline, not proof of
      // a new app action. Observe the same baseline even with ST-MQ switched off.
      remember(now, true); return;
    }
    const scheduleChanged = prior.instruction !== currentFingerprint();
    const nativeExpiry = snapshot.schedule.enabled === 'none' && isTime(prior.delayedReleaseAt) && now >= prior.delayedReleaseAt;
    if (scheduleChanged && !ownsCurrent() && !normalExpiry(now) && !nativeExpiry) {
      state.owned = null;
      if (snapshot.schedule.enabled === 'none') {
        state.released = true;
        manual('charge-now', now, 'The Easee schedule was released after plug-in; immediate charging has priority for this session.');
      } else yieldSchedule(now);
    }
    // A disabled charger and a deliberate stop are user actions; a fault,
    // waiting authorization, target completion or Equalizer pause is not.
    if ((prior.enabled !== snapshot.enabled || prior.stopped !== stopped(snapshot)) && stopped(snapshot)) {
      manual('stop', now, STOP_REASON);
    } else if ((prior.enabled === false && snapshot.enabled === true || prior.stopped && !stopped(snapshot))
      && !snapshot.authorizationBlocked && !snapshot.faulted) {
      if (desired.resume !== true) {
        state.released = true;
        if (!scheduleChanged || !['window', 'schedule'].includes(state.manual?.kind))
          manual('enable', now, 'Charging was enabled after plug-in; the Easee app has control for this session.');
      }
    }
    remember(now);
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
    const now = clock(); let operation = 'read-failed';
    if (closed || expectedGeneration !== generation) return status();
    if (!adapter?.read) {
      await phase(desired.enabled ? 'unavailable' : 'off', desired.enabled ? 'The Easee connection is not configured.' : 'ST-MQ charging control is off.');
      return status();
    }
    try {
      snapshot = await adapter.read(); state.lastReadAt = snapshot.readAt;
      if (expectedGeneration !== generation || closed) return status();
      // A timeout can follow a successful cloud write. Recover durable intent
      // before interpreting the newly observed instruction as an app edit.
      if (state.pending?.action === 'install') {
        const expected = state.pending.expectedActiveFingerprint;
        if (expected ? currentFingerprint() === expected : snapshot.fingerprint === state.pending.expectedFingerprint) {
          state.owned = confirmedOwned(now, state.pending); state.pending = null;
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
      observeSession(now);
      if (state.owned && !ownsCurrent()) {
        if (normalExpiry(now)) state.released = snapshot.pluggedIn === true;
        state.owned = null;
      }
      if (desired.enabled !== true) {
        state.handoverConfirmed = false;
        if (ownsCurrent()) {
          if (!permitted()) { await phase('off', 'Control is off; charger handover is unconfirmed.', 'control-revoked'); return status(); }
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration, true);
        }
        state.pending = null; state.handoverConfirmed = true;
        await phase('off', snapshot.schedule.enabled === 'none' ? 'ST-MQ charging control is off.'
          : 'ST-MQ charging control is off; the current Easee schedule is preserved.');
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
          : 'Enable or resume the charger in Easee before ST-MQ can schedule charging.', state.manual?.kind === 'stop' ? null : 'charger-stopped');
        return status();
      }
      // Zero power, target completion and passed deadlines never reset release.
      if (snapshot.mode === 3 || state.owned && now >= state.owned.startAt) state.released = true;
      const resume = desired.resume === true; desired.resume = false;
      if (state.manual) {
        const prior = state.manual;
        // A user's enable must not remain blocked by our earlier delayed start.
        // Relinquish only the exact active instruction we still own.
        if (prior.kind === 'enable' && ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent('delayed', expectedGeneration);
        }
        const ended = prior.kind === 'window' && isTime(prior.resumeAt) && now >= prior.resumeAt;
        if (ended && snapshot.mode === 3 && !resume) {
          await phase('yielded', 'Waiting for Easee to confirm the manual charging window has ended.'); return status();
        }
        if (resume || ended) {
          state.manual = null;
          if (ended && snapshot.mode !== 3) state.released = false;
        } else { await phase('yielded', prior.reason); return status(); }
      }
      if (state.released) {
        // Take over a pre-existing stopping schedule without interrupting a
        // charge already underway. Only its restriction is removed.
        if (snapshot.schedule.enabled !== 'none' && !ownsCurrent()) {
          operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
        }
        await phase('released', RELEASE_REASON); return status();
      }
      const plan = typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : desired.plan;
      if (!plan || !isTime(plan.startAt)) { await phase('unavailable', 'Waiting for a charging plan.'); return status(); }
      if (plan.startAt <= now) {
        if (snapshot.schedule.enabled !== 'none') { operation = 'command-failed'; await clearCurrent(snapshot.schedule.enabled, expectedGeneration); }
        state.released = true; state.manual = null;
        await phase('released', RELEASE_REASON); return status();
      }
      const maximumAmps = typeof getMaximumAmps === 'function' ? getMaximumAmps(copy(snapshot)) : desired.maximumAmps;
      operation = 'invalid-plan';
      const delayed = delayedScheduleFor({ startAt: plan.startAt, timezone: desired.timezone, maximumAmps }, now);
      const expectedState = { ...copy(snapshot.schedule), enabled: 'delayed', delayed };
      const expectedFingerprint = scheduleFingerprint(expectedState), expectedActiveFingerprint = activeFingerprint(expectedState);
      if (state.owned && currentFingerprint() === expectedActiveFingerprint) {
        state.owned.planId = plan.id ?? plan.planId ?? null;
        await phase('waiting', 'The delayed start is confirmed in Easee; charging remains enabled after release.'); return status();
      }
      state.pending = { action: 'install', planId: plan.id ?? plan.planId ?? null, startAt: plan.startAt,
        expectedFingerprint, expectedActiveFingerprint, previousFingerprint: snapshot.fingerprint,
        previousActiveFingerprint: currentFingerprint(), startedAt: now };
      const pending = copy(state.pending);
      await phase('unconfirmed', 'The delayed start is being confirmed with Easee.');
      operation = 'command-failed';
      snapshot = await adapter.installDelayed({ startAt: plan.startAt, timezone: desired.timezone, maximumAmps,
        expectedFingerprint: snapshot.fingerprint, expectedControlFingerprint: snapshot.controlFingerprint,
        canMutate: () => permitted() && expectedGeneration === generation && desired.enabled === true });
      state.lastReadAt = snapshot.readAt;
      if (currentFingerprint() !== expectedActiveFingerprint) throw Object.assign(new Error('Schedule readback mismatch'), { code: 'readback-mismatch' });
      state.owned = confirmedOwned(clock(), pending); state.pending = null;
      rememberOwnInstruction(clock());
      // OFF during POST still records the actual result for queued cleanup.
      if (expectedGeneration !== generation || desired.enabled !== true) { await persist(); return status(); }
      if (state.manual) await phase('yielded', state.manual.reason);
      else if (snapshot.mode === 3) { state.released = true; await phase('released', RELEASE_REASON); }
      else await phase('waiting', 'The delayed start is confirmed in Easee; charging remains enabled after release.');
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
      } else await phase(state.pending ? 'unconfirmed' : 'unavailable', DIAGNOSTICS[errorCode], errorCode);
    }
    return status();
  }
  return {
    status,
    update(input = {}) {
      desired = { ...desired, ...input, enabled: input.enabled ?? desired.enabled };
      if (desired.enabled !== true) desired.resume = false;
      const expectedGeneration = ++generation;
      queue = queue.catch(() => {}).then(() => reconcile(expectedGeneration));
      return queue.then(result => expectedGeneration === generation || closed ? result : queue);
    },
    close() { closed = true; generation++; return queue.catch(() => {}); },
  };
}
