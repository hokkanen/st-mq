const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function validShellyDeviceHold(value) {
  return value == null || typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'connectedAt,eventAt,receivedAt,sessionId'
    && token(value.sessionId) && time(value.connectedAt) && time(value.eventAt)
    && value.eventAt >= value.connectedAt && time(value.receivedAt) && value.receivedAt >= value.eventAt;
}

/** SYS describes native provenance, not an actor or permission for another
 * Start. Preview without consuming events so status cannot miss a transient
 * permission release or invent an application-owned identification pause. */
export function shellyDevicePermission({ hold, sessionId, ownedPause, pending, lastStart, cursor = 0,
  snapshot, now, maxAgeMs }) {
  const session = snapshot.session, field = snapshot.fields?.start_charging;
  const currentSession = session?.connected === true && token(session.sessionId) && time(session.connectedAt);
  const matches = value => value?.sessionId === session?.sessionId && value.connectedAt === session?.connectedAt;
  const fresh = value => value && value.invalidatedAt === undefined && value.retained !== true
    && time(value.measuredAt) && value.measuredAt <= now && time(value.receivedAt)
    && value.receivedAt <= now && now - value.receivedAt <= maxAgeMs;
  let next = hold ?? null;
  if (session?.connected === false || currentSession && next && !matches(next)) next = null;
  if (!currentSession) return { hold: next, held: false, pauseBroken: false };
  let paused = ownedPause === true && lastStart === false && sessionId === session.sessionId;
  let previous = sessionId === session.sessionId ? lastStart : undefined;
  let pauseBroken = false, lastOn = null, seen = false;
  const keepFalse = observation => {
    // An initial already-false setting is normal with native Auto charge OFF.
    // A later SYS Stop also fences a dispatched Start whose effect is unknown;
    // acknowledgement or a lost reply cannot authorize replacing that Stop.
    const afterStart = pending?.role === 'start_charging' && pending.value === true
      && time(pending.dispatchedAt) && observation.eventAt >= pending.dispatchedAt;
    if (!paused && (previous === true || next || pauseBroken || afterStart) && (!next || observation.eventAt >= next.eventAt))
      next = { sessionId: session.sessionId, connectedAt: session.connectedAt,
        eventAt: observation.eventAt, receivedAt: observation.receivedAt };
  };
  for (const event of snapshot.permissionEvents ?? []) {
    if (event.sequence <= cursor || !matches(event) || event.eventAt < session.connectedAt
      || event.eventAt > now || event.receivedAt > now) continue;
    // Admission already validated these durable source events. Age cannot
    // erase a recorded interruption after an outage. They revoke old proof or
    // retain a Stop; only a fresh native query below can release a held Stop.
    seen = true;
    if (event.commandSource !== 'sys' || typeof event.value !== 'boolean') {
      // Other instructions retain their independent controller authority.
      // A pending application Start is already awaiting its own readback and
      // cannot turn the old false scalar into an independent native Stop while
      // its value-only notification is still being resolved.
      const pendingStart = pending?.role === 'start_charging' && pending.value === true
        && event.value === true && event.commandSource === 'rpc' && time(pending.dispatchedAt)
        && event.receivedAt >= pending.dispatchedAt
        && Math.floor(event.eventAt / 1000) >= Math.floor(pending.dispatchedAt / 1000);
      if (event.value !== false && !pendingStart) { pauseBroken ||= paused; paused = false; }
      lastOn = null;
      previous = event.value;
      continue;
    }
    if (event.value) {
      pauseBroken ||= paused || pending?.owned && event.eventAt >= pending.dispatchedAt;
      paused = false;
      lastOn = event;
    } else {
      keepFalse(event);
      lastOn = null;
    }
    previous = event.value;
  }
  if (fresh(field) && field.commandSource === 'sys') {
    if (field.value === true) {
      pauseBroken ||= paused;
      // A cached matching true is insufficient, including after restart. The
      // query must follow the last observed transition/held Stop receipt.
      const after = Math.max(lastOn?.receivedAt ?? 0, next?.receivedAt ?? 0);
      const eventAt = Math.max(lastOn?.eventAt ?? 0, next?.eventAt ?? 0);
      if (snapshot.controlReady === true && field.readback?.requestedAt >= after && field.readback.receivedAt >= field.readback.requestedAt
        && field.readback.receivedAt <= now && field.measuredAt >= Math.floor(eventAt / 1000) * 1000) next = null;
    } else if (!seen && field.value === false && field.measuredAt >= session.connectedAt
      && (!next || field.measuredAt > next.eventAt)) {
      keepFalse({ eventAt: field.measuredAt, receivedAt: field.receivedAt });
    }
  }
  return { hold: next, held: next !== null && matches(next), pauseBroken };
}
