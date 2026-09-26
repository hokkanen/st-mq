import { acceptSocReading, socMeasurementTime } from './soc.js';

const facts = ['pluggedIn', 'charging', 'atHome'];
const MINUTE = 60_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const CONTEXT_MAX_AGE_MS = 24 * 60 * MINUTE;
export const BMW_LAST_HOME_MAX_AGE_MS = 2 * 60 * MINUTE;

const currentContext = (field, now, maxAge) => time(field?.measuredAt) && field.measuredAt <= now
  && now - field.measuredAt <= maxAge
  && (field.receivedAt == null || time(field.receivedAt) && field.receivedAt <= now);

/** Location context is distinct from the current reported fact. A GPS gap may
 * use the last confirmed home position briefly, without making null true or
 * renewing its clocks. Only live charging/charger correlation proves identity.
 * BMW departure events fence this fallback; a charger reconnect alone does not
 * mean the vehicle left home, and has its own charging-evidence boundary. */
export function bmwHomeContext(reading, now) {
  if (!time(now) || reading?.provider !== 'bmw-cardata') return null;
  const field = reading.fields?.atHome;
  const remembered = reading.atHome === null;
  const home = remembered ? field?.lastKnown : field;
  if (remembered ? home?.value !== true : reading.atHome !== true) return null;
  if (!currentContext(home, now, remembered ? BMW_LAST_HOME_MAX_AGE_MS : CONTEXT_MAX_AGE_MS)) return null;
  if (remembered && (!time(home.receivedAt) || !eventId(home.readingId)
    || typeof home.retained !== 'boolean'
    || ['atHome', 'pluggedIn'].some(key => {
      const departure = reading.fields?.[key]?.negativeEvent;
      // A live home-zone correction can supersede an away calculation at the
      // same GPS time. Its original receipt order proves which revision won;
      // this exception never applies to a vehicle unplug event.
      const correctedHome = key === 'atHome' && departure?.measuredAt === home.measuredAt
        && home.retained === false && time(departure.receivedAt) && departure.receivedAt < home.receivedAt;
      return time(departure?.measuredAt) && departure.measuredAt >= home.measuredAt && !correctedHome;
    }))) return null;
  return { source: remembered ? 'last-known' : 'observed', measuredAt: home.measuredAt,
    receivedAt: home.receivedAt ?? null, readingId: home.readingId ?? null };
}

export function bmwIdentityContextValid(reading, now) {
  return Boolean(bmwHomeContext(reading, now) && reading.pluggedIn === true
    && currentContext(reading.fields?.pluggedIn, now, CONTEXT_MAX_AGE_MS));
}

// A charger connection is dated when polling first sees it. Source events and
// MQTT delivery can precede that poll; a known disconnect bounds the tolerance.
export function connectionEvidenceStart(connectedAt, lastDisconnectedAt) {
  return time(connectedAt) ? Math.max(0, connectedAt - 90_000,
    time(lastDisconnectedAt) ? lastDisconnectedAt + 1 : 0) : null;
}

/** TeslaMate publishes power only when it changes. Match the independent live
 * charging start as well as the ramp, so polling delay and a stable final power
 * do not permanently lose identification. Retained starts never supply an edge. */
export function matchTeslaSession(tesla, { physical, connectedAt, lastDisconnectedAt, chargingAt = [], consumedPowerAt, now = Date.now() } = {}) {
  const physicalPower = physical?.powerKw, power = tesla?.fields?.charger_power, plug = tesla?.fields?.plugged_in;
  const departure = (tesla?.boundaries ?? []).filter(edge => edge.association === tesla.association
    && (edge.field === 'plugged_in' && edge.value === false
      || edge.field === 'geofence' && edge.value !== tesla.fields?.geofence?.value)
    && time(edge.at) && edge.at <= now).reduce((at, edge) => Math.max(at, edge.at), lastDisconnectedAt ?? -1);
  const evidenceStart = connectionEvidenceStart(connectedAt, departure);
  const physicalAt = physicalPower?.measuredAt;
  if (!time(connectedAt) || connectedAt > now || tesla?.healthy !== true || tesla.pluggedIn !== true
    || tesla.atHome !== true || tesla.charging !== true || physical?.charging?.value !== true
    || physicalPower?.available !== true || !(physicalPower.value > .5)
    || !time(physicalAt) || physicalAt < evidenceStart || physicalAt > now || now - physicalAt > MINUTE
    || !Number.isFinite(tesla.actualPowerKw) || tesla.actualPowerKw <= 0 || Math.abs(physicalPower.value - tesla.actualPowerKw) > .75
    || power?.retained !== false || !time(power.receivedAt) || power.receivedAt < evidenceStart || power.receivedAt > now
    || time(consumedPowerAt) && power.receivedAt <= consumedPowerAt) return false;
  const starts = (Array.isArray(chargingAt) ? chargingAt : [chargingAt])
    .filter(at => time(at) && at >= evidenceStart && at <= now && now - at < 15 * MINUTE);
  const freshPower = now - power.receivedAt <= 30_000;
  const sameRamp = time(physicalAt) && physicalAt <= now && freshPower && Math.abs(physicalAt - power.receivedAt) <= 10_000
    && starts.some(at => Math.abs(at - power.receivedAt) <= 15_000);
  const samePlug = plug?.retained === false && time(plug.receivedAt) && plug.receivedAt >= evidenceStart
    && plug.receivedAt <= now && Math.abs(plug.receivedAt - connectedAt) <= 30_000;
  if (freshPower && (sameRamp || samePlug)) return true;
  const liveStart = ['charging_state', 'state'].map(key => tesla.fields?.[key])
    .filter(field => field?.retained === false && ['Charging', 'charging'].includes(field.value)
      && time(field.receivedAt) && field.receivedAt >= evidenceStart && field.receivedAt <= now
      && now - field.receivedAt < 15 * MINUTE);
  return time(physicalAt) && physicalAt <= now && now - physicalAt <= 2 * MINUTE
    && liveStart.some(start => power.receivedAt >= start.receivedAt - 30_000
      && starts.some(at => Math.abs(at - start.receivedAt) <= 30_000));
}

/** Independent vehicle facts keep their source clocks and original MQTT delivery
 * provenance. Repeating a retained sample live cannot create a connection event. */
export function acceptVehicleReading(previous, payload, { now = Date.now(), association = 'vehicle-mqtt', retained = false, provider } = {}) {
  if (previous?.association !== association) previous = null;
  const reject = reason => ({ accepted: false, reading: previous ?? null, reason });
  let value;
  try { value = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload; }
  catch { return reject('malformed-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid-payload');
  if (value.provider !== undefined && value.provider !== 'bmw-cardata') return reject('invalid-provider');
  if (provider && value.provider !== provider) return reject('provider-mismatch');
  const hasFacts = facts.some(key => Object.hasOwn(value, key));
  if (hasFacts && value.provider !== 'bmw-cardata') return reject('invalid-provider');
  let battery;
  if (value.soc === undefined && (hasFacts || value.provider === 'bmw-cardata')) {
    const hasBatteryFields = ['usableCapacityKwh', 'chargeLimitSoc'].some(key => Object.hasOwn(value, key));
    if (!hasBatteryFields) battery = { accepted: false, reading: previous, reason: 'duplicate-reading' };
    else {
      if (['usableCapacityKwh', 'chargeLimitSoc'].some(key => Object.hasOwn(value, key) && !value.fields?.[key])) return reject('invalid-field-metadata');
      // Target and capacity remain independently useful when battery percentage
      // is unavailable. Reuse its old anchor only inside the existing validator.
      const knownSoc = Number.isFinite(previous?.soc);
      const anchor = knownSoc ? previous : { soc: 0, measuredAt: null, readingId: 'vehicle-fields-only', sequence: null };
      battery = acceptSocReading(previous, { ...value, soc: anchor.soc, measuredAt: anchor.measuredAt,
        readingId: anchor.readingId, sequence: anchor.sequence }, { now, association });
      if (battery.accepted && !knownSoc) {
        const reading = { ...battery.reading };
        for (const key of ['soc', 'measuredAt', 'receivedAt', 'readingId', 'sequence']) delete reading[key];
        const changed = ['usableCapacityKwh', 'chargeLimitSoc'].some(key => reading[key] !== previous?.[key]
          || reading.fields?.[key]?.readingId !== previous?.fields?.[key]?.readingId);
        battery = { accepted: changed, reading, reason: changed ? null : 'duplicate-reading' };
      }
    }
  } else battery = acceptSocReading(previous, value, { now, association });
  if (!battery.accepted && !['duplicate-reading', 'older-reading', 'unordered-reading'].includes(battery.reason)) return battery;
  const same = previous?.association === association;
  const reading = { ...(battery.reading ?? {}), association,
    ...(value.provider === 'bmw-cardata' ? { provider: 'bmw-cardata' } : {}),
    fields: { ...(battery.reading?.fields ?? {}) } };
  let changed = battery.accepted;
  for (const key of facts) {
    const prior = same ? previous?.fields?.[key] : null;
    const lastKnown = prior && (typeof previous[key] === 'boolean'
      ? { value: previous[key], measuredAt: prior.measuredAt, readingId: prior.readingId,
        receivedAt: prior.receivedAt, retained: prior.retained,
        positiveEvent: prior.positiveEvent ?? null, negativeEvent: prior.negativeEvent ?? null }
      : prior.lastKnown ?? null);
    if (same && previous[key] !== undefined) { reading[key] = previous[key]; if (prior) reading.fields[key] = prior; }
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] !== null && typeof value[key] !== 'boolean') return reject('invalid-vehicle-fact');
    const meta = value.fields?.[key], at = socMeasurementTime(meta?.measuredAt);
    if (!meta || (value[key] === null ? at !== null && !time(at) : !time(at)) || at > now + 5 * MINUTE || typeof meta.readingId !== 'string'
      || !meta.readingId.length || meta.readingId.length > 128) return reject('invalid-field-metadata');
    // Correcting the home zone can change its derived fact without a new GPS
    // sample. Accept that live revision with its original measurement age;
    // unordered retained data cannot roll it back or renew connection events.
    const rederivedHome = key === 'atHome' && !retained && lastKnown && time(at)
      && at === lastKnown.measuredAt && typeof value[key] === 'boolean'
      && value[key] !== lastKnown.value && meta.readingId !== lastKnown.readingId;
    if (key === 'atHome' && retained && lastKnown && time(at) && at === lastKnown.measuredAt) continue;
    if (prior && (meta.readingId === prior.readingId
      || retained && prior.retained === false && at === null
      || time(at) && time(prior.measuredAt) && (at < prior.measuredAt
        || at === prior.measuredAt && value[key] !== false && value[key] !== null && !rederivedHome))) continue;
    // Unavailability clears the current value, not its source watermark. A
    // replay after an unknown gap must keep the original event provenance.
    if (value[key] !== null && lastKnown && time(at) && time(lastKnown.measuredAt)
      && (at < lastKnown.measuredAt || at === lastKnown.measuredAt
        && value[key] !== false && !rederivedHome && (value[key] !== lastKnown.value || meta.readingId !== lastKnown.readingId))) continue;
    reading[key] = value[key];
    const observed = { measuredAt: at, readingId: meta.readingId, receivedAt: now, retained };
    const positiveEvent = value[key] === true && lastKnown?.value !== true ? observed : lastKnown?.positiveEvent ?? null;
    const negativeEvent = value[key] === false && lastKnown?.value === true ? observed : lastKnown?.negativeEvent ?? null;
    reading.fields[key] = { ...observed, positiveEvent, negativeEvent,
      ...(value[key] === null && lastKnown ? { lastKnown } : {}) };
    changed = true;
  }
  return changed ? { accepted: true, reading, reason: null } : reject(battery.reason ?? 'duplicate-reading');
}

function freshBoundaryEvent(event, now) {
  return time(now) && eventId(event?.readingId) && time(event.measuredAt) && event.measuredAt >= 0
    && time(event.receivedAt) && event.receivedAt >= 0 && event.measuredAt <= now && event.receivedAt <= now
    && now - event.measuredAt <= 15 * MINUTE && now - event.receivedAt <= 15 * MINUTE;
}

/** A known BMW leaving can close its old connection even when charger polling
 * misses the unplug. It cannot identify the vehicle on a subsequent connection. */
export function bmwDisconnectEvent(previousReading, reading, { match, connectedAt, now = Date.now() } = {}) {
  const previous = previousReading?.fields?.pluggedIn, current = reading?.fields?.pluggedIn;
  const event = current?.negativeEvent;
  if (match?.id !== 'bmw' || !time(connectedAt) || match.connectedAt !== connectedAt
    || !time(match.matchedAt) || match.matchedAt > now
    || previousReading?.provider !== 'bmw-cardata' || reading?.provider !== 'bmw-cardata'
    || previousReading.association !== reading.association
    || previousReading.pluggedIn !== true || reading.pluggedIn !== false
    || event?.retained !== false || current.retained !== false || !freshBoundaryEvent(event, now)
    || event.readingId !== current.readingId || event.measuredAt !== current.measuredAt || event.receivedAt !== current.receivedAt
    || event.readingId === previous?.readingId || event.readingId === previous?.negativeEvent?.readingId
    || !time(previous?.measuredAt) || event.measuredAt <= previous.measuredAt
    || !time(previous?.receivedAt) || event.receivedAt < previous.receivedAt || event.receivedAt < match.matchedAt) return null;
  return { source: 'bmw-cardata', readingId: event.readingId, measuredAt: event.measuredAt,
    receivedAt: event.receivedAt, endedConnectedAt: connectedAt };
}

/** Reconnection only dates the next charger connection after a known departure;
 * independent charging evidence must still identify the vehicle using it. */
export function bmwReconnectEvent(boundary, reading, { now = Date.now() } = {}) {
  const event = reading?.fields?.pluggedIn?.positiveEvent;
  if (boundary?.source !== 'bmw-cardata' || !time(boundary.endedConnectedAt) || !freshBoundaryEvent(boundary, now)
    || reading?.provider !== 'bmw-cardata' || reading.pluggedIn !== true
    || event?.retained !== false || !freshBoundaryEvent(event, now)
    || event.readingId === boundary.readingId || event.measuredAt <= boundary.measuredAt
    || event.receivedAt <= boundary.receivedAt) return null;
  return { readingId: event.readingId, measuredAt: event.measuredAt, receivedAt: event.receivedAt, retained: false };
}

// A possible BMW session and a confirmed one share the same live connection,
// home and charging-start evidence. Only confirmation requires a matching stop.
function bmwEvidenceStart(reading, connectedAt, lastDisconnectedAt) {
  const departure = ['pluggedIn', 'atHome'].map(key => reading?.fields?.[key]?.negativeEvent?.measuredAt)
    .filter(time).reduce((at, value) => Math.max(at, value), lastDisconnectedAt ?? -1);
  return connectionEvidenceStart(connectedAt, departure);
}

function bmwSessionEvidence(reading, { connectedAt, lastDisconnectedAt, chargingAt, stoppedAt, now = Date.now(), consumedPlugId, consumedChargingId } = {}) {
  const field = key => reading?.fields?.[key];
  const plug = field('pluggedIn')?.positiveEvent;
  const start = field('charging')?.positiveEvent;
  const stop = field('charging')?.negativeEvent;
  const evidenceStart = bmwEvidenceStart(reading, connectedAt, lastDisconnectedAt);
  const event = observed => observed?.retained === false
    && time(observed.measuredAt) && time(observed.receivedAt)
    && observed.measuredAt >= evidenceStart
    && observed.receivedAt >= evidenceStart && observed.receivedAt <= now
    && observed.measuredAt <= now && now - observed.measuredAt <= 15 * MINUTE;
  const chargingTimes = Array.isArray(chargingAt) ? chargingAt : [chargingAt];
  const stoppedTimes = Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt];
  if (!time(now) || !time(connectedAt) || connectedAt > now || reading?.provider !== 'bmw-cardata' || typeof reading.charging !== 'boolean') return null;
  if (!bmwHomeContext(reading, now) || reading.pluggedIn !== true
    || plug?.retained !== false || !time(plug.measuredAt) || !time(plug.receivedAt)
    || plug.measuredAt < evidenceStart || plug.measuredAt > connectedAt + 10 * MINUTE
    || plug.measuredAt > now || plug.receivedAt < evidenceStart || plug.receivedAt > now || !event(start)
    || plug.readingId === consumedPlugId || start.readingId === consumedChargingId) return null;
  const starts = chargingTimes.filter(at => time(at) && at >= evidenceStart && at <= now
    && Math.abs(start.measuredAt - at) <= 2 * MINUTE);
  return starts.length ? { connectedAt, now, start, stop: event(stop) ? stop : null, starts, stoppedTimes } : null;
}

function matchingBmwStop(evidence) {
  if (!evidence?.stop || evidence.stop.measuredAt <= evidence.start.measuredAt) return false;
  return evidence.starts.some(at => evidence.stoppedTimes.some(end => time(end) && end <= evidence.now
    && end > at && Math.abs(evidence.stop.measuredAt - end) <= 2 * MINUTE));
}

/** Correlate both a charging start and a later actual pause to one connection.
 * Two cars charging at home at similar times is insufficient on its own. No
 * extra pause is commanded here; unavailable natural stop evidence stays manual. */
export function matchBmwSession(reading, options = {}) {
  return matchingBmwStop(bmwSessionEvidence(reading, options));
}

/** Keep plausible live evidence visible while the matching pause is delayed.
 * This is only a bounded status hint, never a vehicle identity or control grant. */
export function pendingBmwSession(reading, options = {}) {
  const evidence = bmwSessionEvidence(reading, options);
  return Boolean(evidence && evidence.now >= evidence.connectedAt
    && evidence.now < evidence.start.measuredAt + 10 * MINUTE && !matchingBmwStop(evidence));
}

const CONTROLLED_EDGE_TOLERANCE = 30_000;

// Inlet and home values supply context; the live charging edge supplies the
// current-session evidence for both a pending hint and a controlled-pause match.
function controlledBmwStart(reading, { connectedAt, lastDisconnectedAt, chargingAt, stoppedAt,
  now = Date.now(), consumedChargingId } = {}) {
  const evidenceStart = bmwEvidenceStart(reading, connectedAt, lastDisconnectedAt);
  const sourceTime = at => time(at) && at >= evidenceStart && at <= now
    && now - at <= 15 * MINUTE;
  const event = observed => observed?.retained === false && eventId(observed.readingId)
    && sourceTime(observed.measuredAt) && time(observed.receivedAt)
    && observed.receivedAt >= evidenceStart && observed.receivedAt <= now
    && now - observed.receivedAt <= 15 * MINUTE;
  if (!time(now) || !time(connectedAt) || connectedAt < 0 || connectedAt > now
    || reading?.provider !== 'bmw-cardata' || typeof reading.charging !== 'boolean'
    || !bmwIdentityContextValid(reading, now)) return null;
  const start = reading.fields?.charging?.positiveEvent, stop = reading.fields?.charging?.negativeEvent;
  if (!event(start) || start.readingId === consumedChargingId) return null;
  const chargingTimes = Array.isArray(chargingAt) ? chargingAt : [chargingAt];
  const stoppedTimes = Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt];
  const starts = chargingTimes.filter(at => sourceTime(at)
    && Math.abs(start.measuredAt - at) <= CONTROLLED_EDGE_TOLERANCE);
  return starts.length ? { connectedAt, now, start, stop, starts, stoppedTimes, sourceTime, event } : null;
}

function controlledPauseMatch(reading, evidence, pause) {
  if (!evidence || reading.charging !== false) return null;
  const { connectedAt, now, start, stop, starts, stoppedTimes, sourceTime, event } = evidence;
  if (pause?.connectedAt !== connectedAt
    || !time(pause.confirmedAt) || pause.confirmedAt < connectedAt || pause.confirmedAt > now
    || !time(pause.startAt) || pause.startAt <= now || !sourceTime(pause.stoppedAt)) return null;
  // Both transports provide the same verified current-session pause. Its saved
  // request time must bracket both independently observed charging transitions.
  const boundary = pause.requestedAt;
  if (!time(boundary) || boundary < connectedAt || boundary > pause.confirmedAt || pause.stoppedAt <= boundary
    || !event(stop) || start.measuredAt >= boundary || stop.measuredAt <= boundary
    || stop.receivedAt < start.receivedAt) return null;
  const matched = starts.some(at => at < boundary
    && stoppedTimes.some(end => sourceTime(end) && end > boundary
      && Math.abs(stop.measuredAt - end) <= CONTROLLED_EDGE_TOLERANCE
      && Math.abs(pause.stoppedAt - end) <= CONTROLLED_EDGE_TOLERANCE));
  return matched ? { chargingReadingId: start.readingId, stopReadingId: stop.readingId,
    confirmedAt: pause.confirmedAt } : null;
}

/** A confirmed native pause can correlate charging even when the vehicle's
 * inlet state did not change. Transport-specific ownership and physical pause
 * checks run at the charger boundary; vehicle correlation has no backend branch. */
export function matchBmwControlledPause(reading, options = {}) {
  return controlledPauseMatch(reading, controlledBmwStart(reading, options), options.pause);
}

/** A tightly matched live start remains a candidate while pause evidence is
 * pending. The ten-minute display bound grants no identity or control rights. */
export function pendingBmwControlledPause(reading, options = {}) {
  const evidence = controlledBmwStart(reading, options);
  return Boolean(evidence && evidence.now < evidence.start.measuredAt + 10 * MINUTE
    && !controlledPauseMatch(reading, evidence, options.pause));
}
