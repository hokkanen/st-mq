const unknown = () => ({ from: null, to: null, durationMs: 0, estimated: false });
const validPosition = position => typeof position === 'number'
  ? Number.isFinite(position) && position >= 0 && position <= 1
  : ['open', 'closed'].includes(position);

export function garageDoorReceiptAt(operation, now) {
  if (operation?.acknowledgement !== 'mqtt-write') return operation?.acknowledgedAt;
  const receipt = operation.deviceReceipt;
  return receipt?.executed === true && receipt.action === operation.action
    && Number.isFinite(receipt.sourceTime) && Number.isFinite(receipt.receivedAt) && Number.isFinite(receipt.admittedAt)
    && receipt.receivedAt >= operation.dispatchedAt && receipt.admittedAt >= Math.max(receipt.sourceTime, receipt.receivedAt)
    && receipt.admittedAt <= now ? receipt.receivedAt : undefined;
}

export function garageDoorMotionAt(operation, now) {
  if (operation?.acknowledgement !== 'mqtt-write' || operation.action !== 'open') return garageDoorReceiptAt(operation, now);
  return Number.isFinite(operation.observedAt) && Number.isFinite(operation.observedReceivedAt)
    && Number.isFinite(operation.observedAdmittedAt) && operation.observedReceivedAt >= operation.dispatchedAt
    && operation.observedAt >= Math.floor(operation.dispatchedAt / 1000) * 1000
    && operation.observedAdmittedAt >= Math.max(operation.observedAt, operation.observedReceivedAt)
    && operation.observedAdmittedAt <= now ? operation.observedAdmittedAt : undefined;
}

/** One visual slot's estimate; acquisition/the caller own report freshness.
 * `now` is monotonic browser time. `statusNow`, report and operation timestamps
 * share the server clock. Native opening starts at the first admitted not-closed
 * report; native closing starts at the accepted command receipt.
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
    update({ deviceId, state, position, moving, durationSeconds, now, reportedAt, reportReceivedAt, coverState, operation, statusNow } = {}) {
      if (deviceId !== device) {
        device = deviceId; previous = undefined; trajectory = undefined; command = undefined; lastNow = -Infinity;
      }
      if (Number.isFinite(now)) lastNow = Math.max(lastNow, now);
      const requestKey = operation && Number.isFinite(operation.requestedAt)
        ? `${operation.requestedAt}:${operation.action}` : null;
      const native = operation?.acknowledgement === 'mqtt-write';
      const startingContact = native && [0, 1].includes(operation.startingContact) ? operation.startingContact : null;
      if (requestKey !== command?.key) command = requestKey
        ? { key: requestKey, cancelled: !previous && startingContact === null,
          initialState: previous?.state ?? (startingContact === 0 ? 'Closed' : startingContact === 1 ? 'Open' : undefined) } : undefined;
      if (!deviceId || !Number.isFinite(now) || !Number.isFinite(reportedAt)
        || !['Open', 'Closed', 'Opening', 'Closing'].includes(state) || !validPosition(position)) {
        previous = undefined; trajectory = undefined;
        if (command) command.cancelled = true;
        return unknown();
      }
      // An observed native Close already reached its closed contact. Its retained
      // receipt is history, not a closing clock for a later external opening.
      // If this view missed that closed edge, also retire its old closing estimate.
      // Observed Open still owns a live estimate: it only confirms not-closed.
      if (command && native && operation.action === 'close' && operation.status === 'observed') {
        if (!command.cancelled && state === 'Open' && position === 'open' && trajectory?.estimated && trajectory.to === 0) setPosition(1);
        command.cancelled = true;
      }
      if (command && ['failed', 'unconfirmed'].includes(operation.status)) command.cancelled = true;
      const motion = moving === true && ['Opening', 'Closing'].includes(state) ? state : null;
      const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : 0;
      const next = { state, position, motion, coverState, duration };
      const sameEvidence = previous && ['state', 'position', 'motion', 'coverState'].every(key => previous[key] === next[key]);
      const before = sample();
      const clockAt = garageDoorMotionAt(operation, statusNow);

      // Cache the first contact/receipt clock once. Later polls, dialog
      // navigation and transport completion must not restart it.
      const acknowledged = command && ['open', 'close', 'stop'].includes(operation.action)
        && (['published', 'observed'].includes(operation.status) || native && operation.action === 'open' && operation.status === 'publishing')
        && Number.isFinite(statusNow) && Number.isFinite(clockAt)
        && clockAt >= operation.requestedAt && clockAt <= statusNow;
      if (acknowledged && !command.cancelled && command.startedAt === undefined) {
        command.startedAt = lastNow - (statusNow - clockAt);
        command.from = sample(command.startedAt).from ?? startingContact;
      }
      const freshResponse = acknowledged && !command.cancelled && !command.responded
        && (native ? Number.isFinite(reportReceivedAt) && reportReceivedAt >= operation.dispatchedAt
          && reportedAt >= Math.floor(operation.dispatchedAt / 1000) * 1000
          : reportedAt >= operation.requestedAt)
        && (native || reportedAt > operation.requestedAt || !sameEvidence);
      const responding = freshResponse && (operation.action === 'open' ? state === 'Opening'
        || state === 'Open' && (command.initialState !== 'Open' || previous?.state !== 'Open')
        : operation.action === 'close' ? ['Closing', 'Closed'].includes(state)
          : !moving && ['Open', 'Closed'].includes(state));
      const acceptedClosing = native && acknowledged && !command.cancelled && !command.responded
        && operation.action === 'close' && state !== 'Closed';

      if (typeof position === 'number') {
        if (responding) command.responded = true;
        if (sameEvidence) {
          if (previous.duration !== duration && trajectory?.durationMs > 0) travel(before.from, trajectory.to, duration);
        } else if (motion) travel(position, motion === 'Opening' ? 1 : 0, duration);
        else setPosition(position);
      } else if (responding || acceptedClosing) {
        command.responded = true;
        if (state === 'Closed') setPosition(0);
        else if (operation.action === 'stop') setPosition(before.from, before.estimated);
        else if (command.from !== null) {
          // A new view can arrive after the original contact/receipt. Resume
          // only its remaining travel, without restarting the stroke.
          const startedAt = Math.min(command.startedAt, lastNow - (statusNow - clockAt));
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
