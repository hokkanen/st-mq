const MAX_AGE = 15 * 60_000;
const IDS = new Set([31, 96, 100, 109, 250]);
const CONNECTED_MODES = [2, 3, 4, 6, 7, 8];
const time = value => Number.isSafeInteger(value) && value >= 0;
const validValue = (id, value) => id === 31 || id === 250 ? typeof value === 'boolean' || value === 0 || value === 1
  : id === 96 ? Number.isFinite(value)
    : id === 100 ? ['A', 'B', 'C', 'D'].includes(value)
      : id === 109 && Number.isInteger(value) && value >= 0 && value <= 8;
const sameValue = (id, left, right) => left === right || (id === 31 || id === 250) && Number(left) === Number(right);
const eventId = (id, at) => `easee-stream:${id}:${at}`;
const reconnect = connection => ({ readingId: eventId('connected', connection.measuredAt),
  measuredAt: connection.measuredAt, receivedAt: connection.receivedAt, retained: false });

/** Preserve source-timed transitions independently of controller wakeups. The
 * caller supplies live changes only; subscription snapshots and REST reads are
 * not events. No provider identifiers or payloads belong in this compact state. */
export function acceptEaseeTransition(previous, event, { now = Date.now(), connectedAt, lastDisconnectedAt } = {}) {
  if (!time(now) || !event || !IDS.has(event.id) || !validValue(event.id, event.value)
    || !validValue(event.id, event.previousValue) || sameValue(event.id, event.value, event.previousValue)
    || !time(event.measuredAt) || !time(event.receivedAt) || !time(event.previousMeasuredAt)
    || event.previousMeasuredAt >= event.measuredAt || event.measuredAt > event.receivedAt
    || event.receivedAt > now || now - event.measuredAt > MAX_AGE || now - event.receivedAt > MAX_AGE
    || event.measuredAt <= (previous?.watermarks?.[event.id] ?? -1)) return null;

  const disconnectedAt = Math.max(time(previous?.disconnectedAt) ? previous.disconnectedAt : -1,
    time(lastDisconnectedAt) ? lastDisconnectedAt : -1);
  const negative = event.id === 100 && event.value === 'A' || event.id === 109 && event.value === 1;
  if (negative && event.measuredAt <= disconnectedAt) return null;
  const connection = previous?.connection;
  const evidence = {
    watermarks: Object.fromEntries([...IDS].filter(id => time(previous?.watermarks?.[id]))
      .map(id => [id, previous.watermarks[id]])),
    connection: connection && typeof connection.value === 'boolean' && time(connection.measuredAt) && time(connection.receivedAt)
      ? { value: connection.value, measuredAt: connection.measuredAt, receivedAt: connection.receivedAt } : null,
    disconnectedAt: disconnectedAt >= 0 ? disconnectedAt : null,
    chargingTimes: [...(previous?.chargingTimes ?? [])], stoppedTimes: [...(previous?.stoppedTimes ?? [])],
    ...(previous?.boundary ? { boundary: structuredClone(previous.boundary) } : {}),
  };
  evidence.watermarks[event.id] = event.measuredAt;
  const observed = { value: !negative, measuredAt: event.measuredAt, receivedAt: event.receivedAt };
  const positive = event.id === 100 && ['B', 'C', 'D'].includes(event.value)
    || event.id === 109 && CONNECTED_MODES.includes(event.value);

  if (negative) {
    evidence.disconnectedAt = event.measuredAt;
    const priorConnection = evidence.connection, priorBoundary = evidence.boundary;
    // A late negative can reveal the gap before an already observed reconnect.
    // Keep that newer positive and its actual, possibly earlier, receipt clock.
    if (!priorConnection || event.measuredAt >= priorConnection.measuredAt) evidence.connection = observed;
    const currentSession = time(connectedAt) && event.measuredAt > connectedAt ? connectedAt : null;
    const endedConnectedAt = currentSession ?? (connectedAt == null ? priorBoundary?.endedConnectedAt : null);
    const newSession = currentSession !== null && priorBoundary?.endedConnectedAt !== currentSession;
    const newCycle = priorBoundary?.reconnected && event.measuredAt > priorBoundary.reconnected.measuredAt;
    if (time(endedConnectedAt) && (!priorBoundary || newSession || newCycle)) {
      evidence.boundary = { source: 'easee-stream', readingId: eventId(event.id, event.measuredAt),
        measuredAt: event.measuredAt, receivedAt: event.receivedAt, endedConnectedAt };
    }
    if (evidence.boundary?.reconnected?.measuredAt <= event.measuredAt) delete evidence.boundary.reconnected;
  } else if (positive && event.measuredAt > disconnectedAt
    && (!evidence.connection || event.measuredAt > evidence.connection.measuredAt)) evidence.connection = observed;

  // Keep the first known reconnect for a pending boundary: later charging-mode
  // changes are still this connection, and must not hide the next unplug cycle.
  if (evidence.boundary && evidence.connection?.value === true
    && evidence.connection.measuredAt > (evidence.disconnectedAt ?? -1)
    && evidence.connection.measuredAt > evidence.boundary.measuredAt && !evidence.boundary.reconnected)
    evidence.boundary.reconnected = reconnect(evidence.connection);

  const afterDisconnect = event.measuredAt > (evidence.disconnectedAt ?? -1);
  if (event.id === 109 && afterDisconnect) {
    if (event.value === 3) evidence.chargingTimes.push(event.measuredAt);
    else if ([2, 4, 6, 7, 8].includes(event.value) && event.previousValue === 3
      && event.previousMeasuredAt > (evidence.disconnectedAt ?? -1)) evidence.stoppedTimes.push(event.measuredAt);
  }
  const prune = values => [...new Set(values.filter(at => time(at) && at <= now && now - at <= MAX_AGE
    && at > (evidence.disconnectedAt ?? -1)))].sort((a, b) => a - b).slice(-32);
  evidence.chargingTimes = prune(evidence.chargingTimes);
  evidence.stoppedTimes = prune(evidence.stoppedTimes);
  return { evidence, ...(evidence.boundary ? { boundary: evidence.boundary } : {}) };
}
