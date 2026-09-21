import { acceptSocReading, socMeasurementTime } from './soc.js';

const facts = ['pluggedIn', 'charging', 'atHome'];
const MINUTE = 60_000;
const time = Number.isSafeInteger;

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
    if (prior && (meta.readingId === prior.readingId
      || retained && prior.retained === false && at === null
      || time(at) && time(prior.measuredAt) && (at < prior.measuredAt
        || at === prior.measuredAt && value[key] !== false && value[key] !== null))) continue;
    // Unavailability clears the current value, not its source watermark. A
    // replay after an unknown gap must keep the original event provenance.
    if (value[key] !== null && lastKnown && time(at) && time(lastKnown.measuredAt)
      && (at < lastKnown.measuredAt || at === lastKnown.measuredAt
        && value[key] !== false && (value[key] !== lastKnown.value || meta.readingId !== lastKnown.readingId))) continue;
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

/** Correlate both a charging start and a later actual pause to one connection.
 * Two cars charging at home at similar times is insufficient on its own. No
 * extra pause is commanded here; unavailable natural stop evidence stays manual. */
export function matchBmwSession(reading, { connectedAt, chargingAt, stoppedAt, now = Date.now(), consumedPlugId } = {}) {
  const field = key => reading?.fields?.[key];
  const plug = field('pluggedIn')?.positiveEvent;
  const start = field('charging')?.positiveEvent;
  const stop = field('charging')?.negativeEvent;
  const event = observed => observed?.retained === false
    && time(observed.measuredAt) && time(observed.receivedAt)
    && observed.measuredAt >= connectedAt - 90_000 && observed.measuredAt <= connectedAt + 10 * MINUTE
    && observed.receivedAt >= connectedAt && observed.receivedAt <= now
    && observed.measuredAt <= now && now - observed.measuredAt <= 15 * MINUTE;
  const chargingTimes = Array.isArray(chargingAt) ? chargingAt : [chargingAt];
  const stoppedTimes = Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt];
  if (!time(connectedAt) || !chargingTimes.some(time) || !stoppedTimes.some(time)
    || reading?.provider !== 'bmw-cardata' || typeof reading.charging !== 'boolean') return false;
  const home = field('atHome');
  return reading.atHome === true && reading.pluggedIn === true && time(home?.measuredAt) && home.measuredAt <= now
    && now - home.measuredAt <= 24 * 60 * MINUTE
    && event(plug) && event(start) && event(stop) && stop.measuredAt > start.measuredAt
    && plug.readingId !== consumedPlugId
    && chargingTimes.some(at => time(at) && at <= now && Math.abs(start.measuredAt - at) <= 2 * MINUTE
      && stoppedTimes.some(end => time(end) && end <= now && end > at && Math.abs(stop.measuredAt - end) <= 2 * MINUTE));
}
