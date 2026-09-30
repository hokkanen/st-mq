const unknown = () => ({ from: null, to: null, durationMs: 0, estimated: false });
const validPosition = position => typeof position === 'number'
  ? Number.isFinite(position) && position >= 0 && position <= 1
  : ['open', 'closed'].includes(position);

/**
 * One visual slot's observed door history. This owns no controls or reported state.
 * `now` is a monotonic animation clock; `reportedAt` is the independent source clock.
 * Acquisition and the caller own report ordering/freshness; accepted current state
 * must always agree with the shutter, including changes sharing a source timestamp.
 * Numeric positions are actual normalized position evidence, not binary contacts.
 * Binary contacts must use "open" / "closed", since open cannot locate the shutter.
 */
export function createGarageDoorMotion() {
  let device, previous, trajectory, lastNow = -Infinity;

  const setPosition = (position, estimated = false) => {
    trajectory = { from: position, to: position, startedAt: lastNow, durationMs: 0, estimated };
  };
  const current = () => {
    if (!trajectory || trajectory.from === null) return unknown();
    const elapsed = Math.max(0, lastNow - trajectory.startedAt);
    const fraction = trajectory.durationMs > 0 ? Math.min(1, elapsed / trajectory.durationMs) : 1;
    return {
      from: trajectory.from + (trajectory.to - trajectory.from) * fraction,
      to: trajectory.to,
      durationMs: Math.max(0, trajectory.durationMs - elapsed),
      estimated: trajectory.estimated,
    };
  };
  const travel = (from, to, fullDurationMs) => {
    if (from === null || !(fullDurationMs > 0)) { setPosition(null); return; }
    trajectory = { from, to, startedAt: lastNow, durationMs: Math.abs(to - from) * fullDurationMs, estimated: true };
  };

  return {
    update({ deviceId, state, position, moving, durationSeconds, now, reportedAt, coverState } = {}) {
      if (deviceId !== device) {
        device = deviceId; previous = undefined; trajectory = undefined;
        lastNow = -Infinity;
      }
      if (Number.isFinite(now)) lastNow = Math.max(lastNow, now);
      if (!deviceId || !Number.isFinite(now) || !Number.isFinite(reportedAt)
        || !['Open', 'Closed', 'Opening', 'Closing'].includes(state) || !validPosition(position)) {
        previous = undefined; trajectory = undefined;
        return unknown();
      }
      const motion = moving === true && ['Opening', 'Closing'].includes(state) ? state : null;
      const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : 0;
      const next = { state, position, motion, coverState, duration };
      const sameEvidence = previous && ['state', 'position', 'motion', 'coverState'].every(key => previous[key] === next[key]);
      if (sameEvidence) {
        if (previous.duration !== duration && trajectory?.durationMs > 0) {
          travel(current().from, trajectory.to, duration);
        }
        previous = next;
        return current();
      }

      const before = current();
      const exact = typeof position === 'number' ? position : null;
      if (state === 'Closed' || coverState === 'closed') {
        setPosition(0);
      } else if (coverState === 'open') {
        setPosition(1);
      } else if (motion) {
        // Hydration during movement has no known start point or elapsed travel.
        travel(exact ?? before.from, motion === 'Opening' ? 1 : 0, duration);
      } else if (exact !== null) {
        setPosition(exact);
      } else if (previous?.state === 'Closed' && state === 'Open' && duration > 0) {
        // A newly released closed contact supports opening, but its travel is estimated.
        travel(0, 1, duration);
      } else if (previous?.motion && before.from !== null) {
        // A new report ending motion without a terminal position freezes the estimate.
        setPosition(before.from, before.estimated);
      } else {
        setPosition(position === 'closed' ? 0 : 1);
      }
      previous = next;
      return current();
    },
  };
}
