// Owner-approved Top AC startup exception. This classifies one ambiguous device
// transition; it neither proves its cause nor grants permission to send Start.
export const SHELLY_STARTUP_MS = 10_000;
export const SHELLY_FRESH_CONNECTION_MS = 60_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const keys = ['sessionId', 'connectedAt', 'testId', 'generation', 'dispatchedAt', 'acceptedAt',
  'confirmedAt', 'expiresAt', 'currentAt', 'currentSource', 'boundaryRevision', 'scheduleFingerprint', 'scheduleRevision', 'sequence', 'phase'];

export function validShellyStartup(value) {
  return value == null || typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
    && token(value.sessionId) && token(value.testId)
    && ['connectedAt', 'generation', 'dispatchedAt', 'acceptedAt', 'confirmedAt', 'expiresAt', 'currentAt', 'boundaryRevision', 'sequence'].every(key => time(value[key]))
    && value.dispatchedAt >= value.connectedAt && value.dispatchedAt - value.connectedAt <= SHELLY_FRESH_CONNECTION_MS
    && value.acceptedAt >= value.dispatchedAt && value.confirmedAt >= value.acceptedAt
    && value.expiresAt > value.confirmedAt && value.expiresAt <= value.acceptedAt + SHELLY_STARTUP_MS
    && value.currentAt <= value.confirmedAt
    && token(value.currentSource)
    && (value.scheduleFingerprint === null || /^[a-f0-9]{64}$/.test(value.scheduleFingerprint))
    && (value.scheduleRevision === null || time(value.scheduleRevision))
    && ['armed', 'completed', 'cancelled'].includes(value.phase);
}

/** Preview queued permission events without consuming them. A false edge stays
 * in the adapter's durable queue until a complete pair is confirmed or normal
 * native-instruction handling takes over. Reading status never arms an exception. */
export function shellyStartupDisposition({ startup, snapshot, currentTest, manual, owned, pending,
  lastCommand, live, enabled, authorized, now, maxAgeMs }) {
  if (!startup || startup.phase !== 'armed') return 'inactive';
  const fresh = field => field && field.retained !== true && field.invalidatedAt === undefined
    && time(field.measuredAt) && field.measuredAt <= now && time(field.receivedAt)
    && field.receivedAt <= now && now - field.receivedAt <= maxAgeMs;
  const current = snapshot.fields?.current_limit, permission = snapshot.fields?.start_charging;
  const caps = snapshot.commissioning?.nativeCaps;
  if (!live || !enabled || !authorized || manual || owned || pending || now >= startup.expiresAt
    || snapshot.generation !== startup.generation || snapshot.startupRevision !== startup.boundaryRevision
    || !snapshot.online || !snapshot.identificationReady || !snapshot.identificationCurrentReady
    || snapshot.permissionOverflow || snapshot.faulted || snapshot.authorizationBlocked
    || caps?.autoCharge !== false || caps.restricted !== false || caps.state !== 'running'
    || snapshot.session?.connected !== true || snapshot.session.sessionId !== startup.sessionId
    || snapshot.session.connectedAt !== startup.connectedAt || snapshot.nativeScheduleActive !== false
    || snapshot.nativeScheduleFingerprint !== startup.scheduleFingerprint
    || snapshot.nativeScheduleRevision !== startup.scheduleRevision
    || snapshot.notificationPending?.includes('current_limit')
    || !fresh(current) || current.value !== 6 || current.measuredAt !== startup.currentAt || current.commandSource !== startup.currentSource
    || !fresh(permission) || !fresh(snapshot.fields.work_state)
    || !['charger_insert', 'charger_wait', 'charger_charging'].includes(snapshot.fields.work_state.value)
    || currentTest?.id !== startup.testId || currentTest.sessionId !== startup.sessionId
    || currentTest.connectedAt !== startup.connectedAt || currentTest.phase !== 'active'
    || currentTest.pending || currentTest.appliedCurrentA !== 6 || currentTest.permissionAt !== startup.currentAt
    || now >= currentTest.expiresAt || currentTest.probeDeadlineAt !== undefined && now >= currentTest.probeDeadlineAt
    || lastCommand?.value !== true || lastCommand.sessionId !== startup.sessionId
    || lastCommand.dispatchedAt !== startup.dispatchedAt || lastCommand.acceptedAt !== startup.acceptedAt) return 'cancel';
  let off = null, on = null;
  for (const event of snapshot.permissionEvents ?? []) {
    if (event.sequence <= startup.sequence) continue;
    if (event.sessionId !== startup.sessionId || event.connectedAt !== startup.connectedAt
      || !time(event.eventAt) || event.eventAt < startup.dispatchedAt || event.eventAt > now
      || !time(event.receivedAt) || event.receivedAt > now || event.receivedAt >= startup.expiresAt) return 'cancel';
    // A delayed notification of the already confirmed command is still its
    // original acknowledgement window, never a later external selection.
    if (!off && event.value === true && event.eventAt <= startup.acceptedAt) continue;
    if (event.commandSource !== 'sys' || typeof event.value !== 'boolean'
      || event.eventAt <= startup.acceptedAt || event.eventAt >= startup.expiresAt) return 'cancel';
    if (event.value === false) {
      if (on) return 'cancel';
      off ??= event;
    } else if (off) on = event;
  }
  if (!off) return 'armed';
  const finalEdge = on ?? off;
  if (snapshot.notificationPending?.includes('start_charging')
    && (!time(permission.readback?.requestedAt) || permission.readback.requestedAt < finalEdge.receivedAt)) return 'waiting';
  if (!on) return permission.value === false && permission.commandSource === 'sys' ? 'waiting' : 'cancel';
  if (on.eventAt <= off.eventAt || permission.value !== true || permission.commandSource !== 'sys') return 'cancel';
  // Neither the delta nor a cached matching value completes the exception.
  // Require a correlated native query started after receiving the final edge.
  return snapshot.controlReady && time(permission.readback?.requestedAt)
    && permission.readback.requestedAt >= on.receivedAt
    && permission.measuredAt >= Math.floor(on.eventAt / 1000) * 1000
    && permission.readback.receivedAt <= now ? 'complete' : 'waiting';
}
