import { acceptSocReading, socMeasurementTime } from './soc.js';

const facts = ['pluggedIn', 'charging', 'atHome'];
const MINUTE = 60_000;
const time = Number.isSafeInteger;

// A charger connection is dated when polling first sees it. Source events and
// MQTT delivery can precede that poll; a known disconnect bounds the tolerance.
export function connectionEvidenceStart(connectedAt, lastDisconnectedAt) {
  return time(connectedAt) ? Math.max(0, connectedAt - 90_000,
    time(lastDisconnectedAt) ? lastDisconnectedAt + 1 : 0) : null;
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
        receivedAt: prior.receivedAt, retained: prior.retained, event: prior.event ?? null,
        positiveEvent: prior.positiveEvent ?? prior.event ?? null, negativeEvent: prior.negativeEvent ?? null }
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
    const event = value[key] === true ? positiveEvent : null;
    reading.fields[key] = { ...observed, event, positiveEvent, negativeEvent,
      ...(value[key] === null && lastKnown ? { lastKnown } : {}) };
    changed = true;
  }
  return changed ? { accepted: true, reading, reason: null } : reject(battery.reason ?? 'duplicate-reading');
}

const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
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
function bmwSessionEvidence(reading, { connectedAt, lastDisconnectedAt, chargingAt, stoppedAt, now = Date.now(), consumedPlugId } = {}) {
  const field = key => reading?.fields?.[key];
  const plug = field('pluggedIn')?.positiveEvent;
  const start = field('charging')?.positiveEvent;
  const stop = field('charging')?.negativeEvent;
  const evidenceStart = connectionEvidenceStart(connectedAt, lastDisconnectedAt);
  const event = observed => observed?.retained === false
    && time(observed.measuredAt) && time(observed.receivedAt)
    && observed.measuredAt >= evidenceStart && observed.measuredAt <= connectedAt + 10 * MINUTE
    && observed.receivedAt >= evidenceStart && observed.receivedAt <= now
    && observed.measuredAt <= now && now - observed.measuredAt <= 15 * MINUTE;
  const chargingTimes = Array.isArray(chargingAt) ? chargingAt : [chargingAt];
  const stoppedTimes = Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt];
  if (!time(connectedAt) || reading?.provider !== 'bmw-cardata' || typeof reading.charging !== 'boolean') return null;
  const home = field('atHome');
  if (reading.atHome !== true || reading.pluggedIn !== true || !time(home?.measuredAt) || home.measuredAt > now
    || now - home.measuredAt > 24 * 60 * MINUTE || !event(plug) || !event(start)
    || plug.readingId === consumedPlugId) return null;
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
    && evidence.now < evidence.connectedAt + 10 * MINUTE && !matchingBmwStop(evidence));
}
