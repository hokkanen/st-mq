const unknown = () => ({ from: null, to: null, durationMs: 0, estimated: false });
const validPosition = position => typeof position === 'number'
  ? Number.isFinite(position) && position >= 0 && position <= 1
  : ['open', 'closed'].includes(position);

/** One visual slot's estimate; acquisition/the caller own report freshness.
 * `now` is monotonic browser time. `statusNow`, report and operation timestamps
 * share the server clock. Successful delivery arms a clock, never motion.
 * A binary Open report confirms not-closed, not a measured fully-open position.
 */
export function createGarageDoorMotion() {
  let device, previous, trajectory, command, lastNow = -Infinity;
  const setPosition = (position, estimated = false) => {
    trajectory = { from: position, to: position, startedAt: lastNow, durationMs: 0, estimated };
  };
  const sample = (at = lastNow) => {
    if (!trajectory || trajectory.from === null) return unknown();
    const elapsed = Math.max(0, at - trajectory.startedAt);
    const fraction = trajectory.durationMs > 0 ? Math.min(1, elapsed / trajectory.durationMs) : 1;
    return { from: trajectory.from + (trajectory.to - trajectory.from) * fraction,
      to: trajectory.to, durationMs: Math.max(0, trajectory.durationMs - elapsed), estimated: trajectory.estimated };
  };
  const travel = (from, to, fullDurationMs, startedAt = lastNow) => {
    if (from === null || !(fullDurationMs > 0)) { setPosition(null); return; }
    trajectory = { from, to, startedAt, durationMs: Math.abs(to - from) * fullDurationMs, estimated: true };
  };

  return {
    update({ deviceId, state, position, moving, durationSeconds, now, reportedAt, coverState, operation, statusNow } = {}) {
      if (deviceId !== device) {
        device = deviceId; previous = undefined; trajectory = undefined; command = undefined; lastNow = -Infinity;
      }
      if (Number.isFinite(now)) lastNow = Math.max(lastNow, now);
      const requestKey = operation && Number.isFinite(operation.requestedAt)
        ? `${operation.requestedAt}:${operation.action}` : null;
      if (requestKey !== command?.key) command = requestKey
        ? { key: requestKey, cancelled: !previous, initialState: previous?.state } : undefined;
      if (!deviceId || !Number.isFinite(now) || !Number.isFinite(reportedAt)
        || !['Open', 'Closed', 'Opening', 'Closing'].includes(state) || !validPosition(position)) {
        previous = undefined; trajectory = undefined;
        if (command) command.cancelled = true;
        return unknown();
      }
      const motion = moving === true && ['Opening', 'Closing'].includes(state) ? state : null;
      const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : 0;
      const next = { state, position, motion, coverState, duration };
      const sameEvidence = previous && ['state', 'position', 'motion', 'coverState'].every(key => previous[key] === next[key]);
      const before = sample();

      // Cache the successful-send clock once. Later polls, dialog navigation and
      // receipt changes must not restart it. Failed/uncertain delivery has no clock.
      const acknowledged = command && ['open', 'close', 'stop'].includes(operation.action)
        && ['published', 'observed'].includes(operation.status)
        && Number.isFinite(statusNow) && Number.isFinite(operation.acknowledgedAt)
        && operation.acknowledgedAt >= operation.requestedAt && operation.acknowledgedAt <= statusNow;
      if (command && ['failed', 'unconfirmed'].includes(operation.status)) command.cancelled = true;
      if (acknowledged && !command.cancelled && command.startedAt === undefined) {
        command.startedAt = lastNow - (statusNow - operation.acknowledgedAt);
        command.from = sample(command.startedAt).from;
      }
      const freshResponse = acknowledged && !command.cancelled && !command.responded
        && reportedAt >= operation.requestedAt
        && (reportedAt > operation.requestedAt || !sameEvidence);
      const responding = freshResponse && (operation.action === 'open' ? state === 'Opening'
        || state === 'Open' && (command.initialState !== 'Open' || previous?.state !== 'Open')
        : operation.action === 'close' ? ['Closing', 'Closed'].includes(state)
          : !moving && ['Open', 'Closed'].includes(state));

      if (typeof position === 'number') {
        if (responding) command.responded = true;
        if (sameEvidence) {
          if (previous.duration !== duration && trajectory?.durationMs > 0) travel(before.from, trajectory.to, duration);
        } else if (motion) travel(position, motion === 'Opening' ? 1 : 0, duration);
        else setPosition(position);
      } else if (responding) {
        command.responded = true;
        if (state === 'Closed') setPosition(0);
        else if (operation.action === 'stop') setPosition(before.from, before.estimated);
        else if (command.from !== null) {
          // The first response may arrive seconds after delivery. Advance to the
          // estimated position now, then show only the remaining linear travel.
          const startedAt = Math.min(command.startedAt, lastNow - (statusNow - operation.acknowledgedAt));
          travel(command.from, operation.action === 'open' ? 1 : 0, duration, startedAt);
        } else if (!motion) setPosition(position === 'closed' ? 0 : 1);
      } else if (sameEvidence) {
        if (previous.duration !== duration && trajectory?.durationMs > 0) travel(before.from, trajectory.to, duration);
      } else if (state === 'Closed' || coverState === 'closed') {
        setPosition(0);
      } else if (motion) {
        // External movement can animate from known position, but a page opened
        // mid-motion has no reliable origin or elapsed travel to invent.
        travel(before.from, motion === 'Opening' ? 1 : 0, duration);
      } else if (previous?.state === 'Closed' && state === 'Open') {
        travel(0, 1, duration);
      } else if (state === 'Open' && before.estimated) {
        // A not-closed report cannot end the estimated stroke or locate a shutter.
        // Keep its existing trajectory until closed, measured position or new motion.
      } else {
        setPosition(position === 'closed' ? 0 : 1);
      }
      previous = next;
      return sample();
    },
  };
}
