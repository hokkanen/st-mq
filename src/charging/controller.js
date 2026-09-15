import { delayedScheduleFor, manualScheduleWindow, scheduleFingerprint } from './easee.js';

const copy = value => structuredClone(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;

/** Persisted ownership of the ONE native Easee schedule. No local start/stop timer. */
export function createChargingController({ adapter, initialState = null, saveState = () => {}, clock = Date.now,
  canControl = () => false, getPlan } = {}) {
  let state = { version: 1, phase: 'off', owned: null, pending: null, manual: null, released: false,
    disconnected: false, handoverConfirmed: true, reason: 'ST-MQ charging control is off.',
    ...(initialState?.version === 1 ? copy(initialState) : {}) };
  let desired = { enabled: false, plan: null }, snapshot = null, closed = false, generation = 0, queue = Promise.resolve();
  const permitted = () => !closed && canControl() === true;
  const status = () => ({ ...copy(state), enabled: desired.enabled === true, snapshot: snapshot ? copy(snapshot) : null });
  async function persist() { await saveState(copy(state)); }
  async function phase(value, reason) { state.phase = value; state.reason = reason; await persist(); }
  function manual(kind, now, reason, extra = {}) {
    state.manual = { kind, detectedAt: now, reason, fingerprint: snapshot.fingerprint, ...extra };
  }
  async function yieldSchedule(now, reason = 'A manual Easee schedule has priority.') {
    const window = manualScheduleWindow(snapshot.schedule, now);
    manual(window ? 'window' : 'schedule', now, reason, window ?? {});
    await phase('yielded', window ? 'Manual Easee window; automatic planning resumes after its current or next occurrence.' : reason);
  }
  function confirmedOwned(now, pending) {
    return { planId: pending.planId, startAt: pending.startAt, fingerprint: snapshot.fingerprint,
      schedule: copy(snapshot.schedule), confirmedAt: now };
  }
  function normalExpiry(owned, now) {
    if (!owned || now < owned.startAt || snapshot.schedule.enabled !== 'none') return false;
    const previous = copy(owned.schedule); previous.enabled = 'none';
    // The service may keep or remove the elapsed one-off schedule.
    if (!snapshot.schedule.delayed) previous.delayed = null;
    return scheduleFingerprint(previous) === snapshot.fingerprint;
  }
  async function clearCurrent(kind, expectedGeneration, cleanup = false) {
    const expectedFingerprint = snapshot.fingerprint, expectedControlFingerprint = snapshot.controlFingerprint;
    state.pending = { action: 'clear', kind, previousFingerprint: expectedFingerprint, startedAt: clock() };
    await persist();
    snapshot = await adapter.clear({ kind, expectedFingerprint, expectedControlFingerprint,
      canMutate: () => permitted() && generation === expectedGeneration && (cleanup || desired.enabled === true) });
    state.lastReadAt = snapshot.readAt;
    if (snapshot.schedule.enabled !== 'none') throw new Error('Easee schedule handover is not confirmed');
    state.pending = null; state.owned = null;
  }
  async function reconcile(expectedGeneration) {
    const now = clock();
    if (closed || expectedGeneration !== generation) return status();
    if (!adapter?.read) {
      await phase(desired.enabled ? 'unavailable' : 'off', desired.enabled ? 'Charger 1 Easee connection is not configured.' : 'ST-MQ charging control is off.');
      return status();
    }
    try {
      snapshot = await adapter.read(); state.lastReadAt = snapshot.readAt;
      if (expectedGeneration !== generation || closed) return status();

      // A crash/timeout can happen after the cloud accepted a write. Reconcile
      // its durable intent before considering any further automatic action.
      if (state.pending?.action === 'install') {
        if (snapshot.fingerprint === state.pending.expectedFingerprint) {
          state.owned = confirmedOwned(now, state.pending); state.pending = null;
        } else if (snapshot.fingerprint === state.pending.previousFingerprint) state.pending = null;
        else {
          state.pending = null; state.owned = null;
          manual('unknown', now, 'Easee changed while a schedule write was unconfirmed.');
        }
      } else if (state.pending?.action === 'clear') {
        if (snapshot.schedule.enabled === 'none') { state.pending = null; state.owned = null; }
        else if (snapshot.fingerprint === state.pending.previousFingerprint) state.pending = null;
        else { state.pending = null; state.owned = null; manual('unknown', now, 'Easee changed while handover was unconfirmed.'); }
      }

      if (desired.enabled !== true) {
        state.handoverConfirmed = false;
        // Master OFF revokes automatic intent immediately. Only a restriction
        // that still exactly matches our confirmed write may be relinquished.
        if (state.owned && snapshot.fingerprint === state.owned.fingerprint) {
          if (!permitted()) { await phase('off', 'Control is off; charger handover is unconfirmed.'); return status(); }
          await clearCurrent('delayed', expectedGeneration, true);
        } else if (state.owned) state.owned = null;
        state.pending = null; state.handoverConfirmed = true;
        await phase('off', snapshot.schedule.enabled === 'none' ? 'ST-MQ charging control is off.'
          : 'ST-MQ charging control is off; the current Easee schedule is preserved.');
        return status();
      }
      state.handoverConfirmed = null;
      if (!permitted()) { await phase('unavailable', 'This instance has no charger control authority.'); return status(); }
      if (!snapshot.controlKnown) { await phase('uncertain', 'Charger state is incomplete or offline; automatic control is yielded.'); return status(); }

      let replaceManual = false;
      if (snapshot.pluggedIn === false) {
        state.disconnected = true; state.released = false;
        // Disconnect ends a session override, but a user's bounded app window
        // retains its absolute hand-back even if the vehicle leaves and returns.
        if (state.manual?.kind === 'charge-now') state.manual = null;
        if (state.owned && now >= state.owned.startAt
          && (snapshot.fingerprint === state.owned.fingerprint || normalExpiry(state.owned, now))) {
          replaceManual = snapshot.schedule.enabled !== 'none'; state.owned = null;
        }
      }
      if (snapshot.pluggedIn === true && state.disconnected) {
        state.disconnected = false; state.released = false;
        if (state.owned && now >= state.owned.startAt
          && (snapshot.fingerprint === state.owned.fingerprint || normalExpiry(state.owned, now))) {
          // A completed one-off from the previous connected session is not a
          // manual instruction and must not release every subsequent session.
          replaceManual = snapshot.schedule.enabled !== 'none'; state.owned = null;
        }
      }

      if (snapshot.manualStop) {
        manual('stop', now, desired.resume ? 'Resume or enable the charger in Easee first; ST-MQ does not override charger authorization.'
          : 'The charger is stopped, disabled or waiting for manual authorization.');
        desired.resume = false;
        await phase('yielded', state.manual.reason); return status();
      }
      // Zero power, target completion and a passed deadline NEVER end this latch.
      if (snapshot.mode === 3 && !state.released) {
        state.released = true;
        if (state.owned && now < state.owned.startAt) manual('charge-now', now, 'Immediate charging has priority for this connected session.');
      }
      if (state.owned && snapshot.fingerprint !== state.owned.fingerprint) {
        if (normalExpiry(state.owned, now)) { state.owned = null; state.released = true; }
        else {
          state.owned = null;
          if (snapshot.schedule.enabled === 'none') {
            state.released = true; manual('charge-now', now, 'The Easee schedule was released manually for this session.');
          } else await yieldSchedule(now);
        }
      }
      if (state.owned && now >= state.owned.startAt) state.released = true;
      if (state.owned && !state.released && ![54, 76].includes(snapshot.reason)) {
        manual('unknown', now, 'The pending schedule is no longer the reported restriction; manual override state is uncertain.');
      }

      const resume = desired.resume === true;
      desired.resume = false;
      if (state.manual) {
        const prior = state.manual;
        // An edit replaces the stored hand-back occurrence. Polls use the saved
        // absolute end; they must never move an elapsed daily window to tomorrow.
        if (prior.fingerprint !== snapshot.fingerprint && snapshot.schedule.enabled !== 'none') {
          await yieldSchedule(now, 'The manual Easee schedule changed.'); return status();
        }
        if (prior.fingerprint !== snapshot.fingerprint && snapshot.schedule.enabled === 'none' && prior.kind !== 'stop') {
          state.released = true; manual('charge-now', now, 'The manual Easee schedule was released for this session.');
          if (!resume) { await phase('yielded', state.manual.reason); return status(); }
        }
        const ended = prior.kind === 'window' && isTime(prior.resumeAt) && now >= prior.resumeAt;
        if (ended && snapshot.mode === 3 && !resume) {
          await phase('yielded', 'Waiting for Easee to confirm the manual charging window has ended.'); return status();
        }
        const clearRelease = prior.kind === 'stop' && !snapshot.manualStop && (snapshot.mode === 3 || resume);
        if (resume || ended || clearRelease) {
          if (snapshot.schedule.enabled !== 'none' && !['delayed', 'daily', 'weekly'].includes(snapshot.schedule.enabled)) {
            await phase('yielded', 'Release this schedule in the Easee app before resuming automatic control.'); return status();
          }
          replaceManual = true; state.manual = null;
          if (ended && snapshot.mode !== 3) state.released = false;
        } else { await phase('yielded', prior.reason); return status(); }
      }
      if (!state.owned && snapshot.schedule.enabled !== 'none' && !replaceManual) {
        await yieldSchedule(now); return status();
      }
      if (state.released) {
        if (replaceManual && snapshot.schedule.enabled !== 'none') await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
        await phase(state.manual ? 'yielded' : 'released', 'Charging is released and may continue beyond the minimum and deadline.');
        return status();
      }
      // The runtime can refresh from this newly read connection/ownership state
      // before a command. This also replans the remaining energy at hand-back.
      const plan = typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : desired.plan;
      if (!plan || !isTime(plan.startAt)) { await phase('unavailable', 'Waiting for a charging plan.'); return status(); }
      if (plan.startAt <= now) {
        if (snapshot.schedule.enabled !== 'none') await clearCurrent(snapshot.schedule.enabled, expectedGeneration);
        state.released = true; state.manual = null;
        await phase('released', 'Charging is released and may continue beyond the minimum and deadline.'); return status();
      }
      const delayed = delayedScheduleFor({ startAt: plan.startAt, timezone: desired.timezone,
        maximumAmps: desired.maximumAmps }, now);
      const expectedState = { ...copy(snapshot.schedule), enabled: 'delayed', delayed };
      const expectedFingerprint = scheduleFingerprint(expectedState);
      if (state.owned && snapshot.fingerprint === expectedFingerprint) {
        state.owned.planId = plan.id ?? plan.planId ?? null;
        await phase('waiting', 'The delayed start is confirmed in Easee; charging remains enabled after release.'); return status();
      }
      state.pending = { action: 'install', planId: plan.id ?? plan.planId ?? null, startAt: plan.startAt,
        expectedFingerprint, previousFingerprint: snapshot.fingerprint, startedAt: now };
      const pending = copy(state.pending);
      await phase('unconfirmed', 'The delayed start is being confirmed with Easee.');
      snapshot = await adapter.installDelayed({ startAt: plan.startAt, timezone: desired.timezone, maximumAmps: desired.maximumAmps,
        expectedFingerprint: snapshot.fingerprint, expectedControlFingerprint: snapshot.controlFingerprint,
        canMutate: () => permitted() && expectedGeneration === generation && desired.enabled === true });
      state.lastReadAt = snapshot.readAt;
      if (snapshot.fingerprint !== expectedFingerprint) throw new Error('Easee delayed-start readback does not match the requested schedule');
      state.owned = confirmedOwned(clock(), pending); state.pending = null;
      // OFF arriving during POST still records its actual result. The queued OFF
      // reconciliation will read again and relinquish only this confirmed write.
      if (expectedGeneration !== generation || desired.enabled !== true) { await persist(); return status(); }
      await phase('waiting', 'The delayed start is confirmed in Easee; charging remains enabled after release.');
    } catch (error) {
      if (desired.enabled !== true) {
        state.handoverConfirmed = false;
        await phase('off', 'Control is off; charger handover is unconfirmed.');
      } else await phase(state.pending ? 'unconfirmed' : 'uncertain', 'Easee control could not be confirmed; automatic control is yielded.');
    }
    return status();
  }
  return {
    status,
    update(input = {}) {
      desired = { ...desired, ...input, enabled: input.enabled ?? desired.enabled };
      const expectedGeneration = ++generation;
      queue = queue.catch(() => {}).then(() => reconcile(expectedGeneration));
      // A simultaneous tick may supersede this request before its first read.
      // Await the replacement too, so callers never mistake that skipped pass
      // for a completed reconciliation of the currently requested settings.
      return queue.then(result => expectedGeneration === generation || closed ? result : queue);
    },
    close() { closed = true; generation++; return queue.catch(() => {}); },
  };
}
