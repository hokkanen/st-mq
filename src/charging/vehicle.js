import { acceptSocReading, socMeasurementTime } from './soc.js';

const facts = ['pluggedIn', 'charging', 'atHome'];
const MINUTE = 60_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const BMW_CHARGING_HISTORY_LIMIT = 4096;

const currentContext = (field, now, maxAge) => time(field?.measuredAt) && field.measuredAt <= now
  && now - field.measuredAt <= maxAge
  && (field.receivedAt == null || time(field.receivedAt) && field.receivedAt <= now);

/** The last valid location remains context until another valid location replaces
 * it. GPS loss and reconnecting in a garage do not imply a departure. Preserve
 * its source clock: remembered home is not a fresh GPS fix or charger identity. */
export function bmwHomeContext(reading, now) {
  if (!time(now) || reading?.provider !== 'bmw-cardata') return null;
  const field = reading.fields?.atHome;
  const remembered = reading.atHome === null;
  const home = remembered ? field?.lastKnown : field;
  if (remembered ? home?.value !== true : reading.atHome !== true) return null;
  if (!currentContext(home, now, Infinity) || !time(home.receivedAt)
    || !eventId(home.readingId) || typeof home.retained !== 'boolean') return null;
  const departure = field?.negativeEvent;
  // A live home-zone correction can supersede away at the same original GPS
  // time. Unknown location keeps this revision and its original receipt order.
  const correctedHome = departure?.measuredAt === home.measuredAt && home.retained === false
    && time(departure.receivedAt) && departure.receivedAt < home.receivedAt;
  if (time(departure?.measuredAt) && departure.measuredAt >= home.measuredAt && !correctedHome) return null;
  return { source: remembered ? 'last-known' : 'observed', measuredAt: home.measuredAt,
    receivedAt: home.receivedAt, readingId: home.readingId };
}

export function bmwIdentityContextValid(reading, now) {
  return Boolean(bmwHomeContext(reading, now) && reading.pluggedIn === true
    && currentContext(reading.fields?.pluggedIn, now, Infinity));
}

// A charger connection is dated when polling first sees it. Source events and
// MQTT delivery can precede that poll; a known disconnect bounds the tolerance.
export function connectionEvidenceStart(connectedAt, lastDisconnectedAt) {
  return time(connectedAt) ? Math.max(0, connectedAt - 90_000,
    time(lastDisconnectedAt) ? lastDisconnectedAt + 1 : 0) : null;
}

/** TeslaMate publishes power only when it changes. Match the independent live
 * charging start as well as the ramp, so polling delay and a stable final power
 * do not permanently lose identification. The original paired receipts remain
 * evidence throughout this connection; current logger health and physical power
 * still govern use. Retained starts never supply an edge. */
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
    .filter(at => time(at) && at >= evidenceStart && at <= now);
  const freshPower = now - power.receivedAt <= 30_000;
  const sameRamp = time(physicalAt) && physicalAt <= now && freshPower && Math.abs(physicalAt - power.receivedAt) <= 10_000
    && starts.some(at => Math.abs(at - power.receivedAt) <= 15_000);
  const samePlug = plug?.retained === false && time(plug.receivedAt) && plug.receivedAt >= evidenceStart
    && plug.receivedAt <= now && Math.abs(plug.receivedAt - connectedAt) <= 30_000;
  if (freshPower && (sameRamp || samePlug)) return true;
  const liveStart = ['charging_state', 'state'].map(key => tesla.fields?.[key])
    .filter(field => field?.retained === false && ['Charging', 'charging'].includes(field.value)
      && time(field.receivedAt) && field.receivedAt >= evidenceStart && field.receivedAt <= now);
  return time(physicalAt) && physicalAt <= now && now - physicalAt <= 2 * MINUTE
    && liveStart.some(start => power.receivedAt >= start.receivedAt - 30_000
      && starts.some(at => Math.abs(at - start.receivedAt) <= 30_000));
}

/** Identity uses measured energized phases, never the pilot/current ceiling or
 * a three-phase average that would divide a single-phase car's draw by three. */
export function measuredChargingCurrent(physical, now) {
  const field = physical?.phaseCurrentA, values = field?.value;
  const clocks = field?.inputs?.map(input => input.measuredAt) ?? [field?.measuredAt];
  if (physical?.providerConnected === false || field?.available !== true || field.retained === true || field.assumed === true
    || !Array.isArray(values) || values.length !== 3 || values.some(value => !Number.isFinite(value) || value < 0 || value > 100)
    || !clocks.length || clocks.some(at => !time(at) || at > now || now - at > MINUTE)
    || Math.max(...clocks) - Math.min(...clocks) > 15_000) return null;
  const energized = values.filter(value => value > .5);
  if (!energized.length || Math.max(...energized) - Math.min(...energized) > 1) return null;
  return { value: energized.reduce((sum, value) => sum + value, 0) / energized.length,
    phases: energized.length, measuredAt: Math.min(...clocks) };
}

/** A minimum-current test on Charger 2 distinguishes simultaneous loads only
 * after actual draw and independent live Tesla current agree uniquely. Missing
 * peer evidence and equal currents remain ambiguous, never BMW by elimination.
 * Tesla's reported phase count is not a reliable count of energized phases;
 * measured current and corroborating power supply the electrical comparison. */
export function matchTeslaMinimumCurrent(tesla, { physical, peers = [], minimumPhysical, currentTest,
  connectedAt, lastDisconnectedAt, consumedCurrentAt, now = Date.now() } = {}) {
  const field = tesla?.fields?.charger_actual_current, power = tesla?.fields?.charger_power;
  const departure = (tesla?.boundaries ?? []).filter(edge => edge.association === tesla.association
    && (edge.field === 'plugged_in' && edge.value === false
      || edge.field === 'geofence' && edge.value !== tesla.fields?.geofence?.value)
    && time(edge.at) && edge.at <= now).reduce((at, edge) => Math.max(at, edge.at), lastDisconnectedAt ?? -1);
  const since = connectionEvidenceStart(connectedAt, departure);
  const freshPower = view => view?.powerKw?.available === true && view.powerKw.retained !== true
    && view.powerKw.value > .5 && time(view.powerKw.measuredAt) && view.powerKw.measuredAt <= now
    && now - view.powerKw.measuredAt <= MINUTE && view.charging?.available === true && view.charging.value === true;
  if (!time(connectedAt) || connectedAt > now || tesla?.healthy !== true || tesla.pluggedIn !== true
    || tesla.atHome !== true || tesla.charging !== true || currentTest?.phase !== 'active'
    || !time(currentTest.confirmedAt) || currentTest.confirmedAt < currentTest.startedAt
    || !time(currentTest.expiresAt) || now >= currentTest.expiresAt || now < currentTest.confirmedAt + 5000
    || field?.retained !== false || !time(field.receivedAt) || field.receivedAt < Math.max(since, currentTest.confirmedAt)
    || field.receivedAt > now || now - field.receivedAt > MINUTE
    || time(consumedCurrentAt) && field.receivedAt <= consumedCurrentAt
    || !Number.isFinite(tesla.actualCurrentA) || tesla.actualCurrentA <= .5
    || power?.retained !== false || !time(power.receivedAt) || power.receivedAt < since || power.receivedAt > now
    || !Number.isFinite(tesla.actualPowerKw) || tesla.actualPowerKw <= .5 || !freshPower(physical)
    || Math.abs(physical.powerKw.value - tesla.actualPowerKw) > .75) return null;
  const current = measuredChargingCurrent(physical, now), minimum = measuredChargingCurrent(minimumPhysical, now);
  if (!current || !minimum || !freshPower(minimumPhysical) || minimum.measuredAt < currentTest.confirmedAt
    || current.measuredAt < currentTest.confirmedAt || Math.abs(minimum.value - currentTest.appliedCurrentA) > .5
    || Math.abs(current.value - tesla.actualCurrentA) > .5) return null;
  for (const peer of peers) {
    if (peer.connected?.available === true && peer.connected.value === false) continue;
    const zero = peer.powerKw;
    if (peer.providerConnected !== false && peer.charging?.available === true && peer.charging.value === false
      && zero?.available === true && zero.retained !== true && zero.assumed !== true && zero.value === 0
      && time(zero.measuredAt) && zero.measuredAt >= currentTest.confirmedAt && zero.measuredAt <= now
      && now - zero.measuredAt <= MINUTE && field.receivedAt >= (peer.charging.measuredAt ?? now)) continue;
    const other = measuredChargingCurrent(peer, now);
    if (!other || !freshPower(peer) || other.measuredAt < currentTest.confirmedAt
      || Math.abs(other.value - tesla.actualCurrentA) <= 1) return null;
  }
  return { receivedAt: field.receivedAt, physicalAt: current.measuredAt,
    minimumPhysicalAt: minimum.measuredAt, testId: currentTest.id };
}

/** Independent vehicle facts keep their source clocks and original MQTT delivery
 * provenance. Repeating a retained sample live cannot create a connection event. */
export function acceptVehicleReading(previous, payload, { now = Date.now(), association = 'vehicle-mqtt', retained = false, provider, evidenceSince = null } = {}) {
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
    // Historical charging facts use their source clock. A late transition may
    // complete an older episode while the current value already describes a
    // later one. Never roll that current value or its arrival clock backward.
    let history = prior?.history, historyOverflowAt = prior?.historyOverflowAt ?? null;
    if (key === 'charging') {
      history = [...(history ?? [])];
      if (time(evidenceSince)) {
        const before = history.filter(entry => entry.measuredAt < evidenceSince).at(-1);
        history = history.filter(entry => entry.measuredAt >= evidenceSince);
        if (before) history.unshift(before); // preserves pre-connection baseline provenance
        if (time(historyOverflowAt) && historyOverflowAt < evidenceSince) historyOverflowAt = null;
      }
      if (typeof value[key] === 'boolean') {
        const duplicate = history.find(entry => entry.readingId === meta.readingId);
        if (duplicate && (duplicate.value !== value[key] || duplicate.measuredAt !== at)) return reject('conflicting-field-reading');
        if (!duplicate && !(value[key] === true && lastKnown?.value === false && at === lastKnown.measuredAt)
          && !history.some(entry => entry.measuredAt === at && entry.value === value[key])) {
          if (history.length < BMW_CHARGING_HISTORY_LIMIT) {
            history.push({ value: value[key], measuredAt: at, readingId: meta.readingId, receivedAt: now, retained });
            history.sort((a, b) => a.measuredAt - b.measuredAt || a.receivedAt - b.receivedAt);
          } else historyOverflowAt = Math.max(historyOverflowAt ?? 0, at);
        }
      }
      if (JSON.stringify(history) !== JSON.stringify(prior?.history ?? [])
        || historyOverflowAt !== (prior?.historyOverflowAt ?? null)) {
        reading.fields[key] = { ...prior, history, historyOverflowAt };
        changed = true;
      }
    }
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
      ...(key === 'charging' ? { history: history ?? [], historyOverflowAt } : {}),
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

/** Present history uses one current persisted shape. An absent history is
 * absent evidence; it is never rebuilt from a summary or older representation. */
export function validateBmwChargingHistory(reading) {
  const field = reading?.fields?.charging;
  if (!field || field.history === undefined && field.historyOverflowAt === undefined) return;
  const history = field.history;
  let previous = null;
  const ids = new Set();
  if (!Array.isArray(history) || history.length > BMW_CHARGING_HISTORY_LIMIT
    || field.historyOverflowAt != null && !time(field.historyOverflowAt))
    throw new Error('Unsupported saved BMW charging history; start a fresh development database');
  for (const entry of history) {
    if (!entry || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'measuredAt,readingId,receivedAt,retained,value'
      || typeof entry.value !== 'boolean' || !time(entry.measuredAt) || !time(entry.receivedAt)
      || !eventId(entry.readingId) || typeof entry.retained !== 'boolean' || ids.has(entry.readingId)
      || previous && entry.measuredAt < previous.measuredAt)
      throw new Error('Unsupported saved BMW charging history; start a fresh development database');
    ids.add(entry.readingId); previous = entry;
  }
}

/** Source-ordered charging transitions, with original live/retained provenance.
 * Missing history grants no historical evidence. Conflicting equal-clock states
 * and capacity overflow fail closed instead of inventing a transition sequence. */
export function bmwChargingEvents(reading) {
  const field = reading?.fields?.charging, history = field?.history;
  try { validateBmwChargingHistory(reading); } catch { return []; }
  if (!Array.isArray(history) || history.length > BMW_CHARGING_HISTORY_LIMIT
    || field.historyOverflowAt != null) return [];
  const events = [];
  let previous = null;
  for (const entry of history) {
    if (!entry || typeof entry.value !== 'boolean' || !time(entry.measuredAt)
      || !time(entry.receivedAt) || !eventId(entry.readingId) || typeof entry.retained !== 'boolean'
      || previous && (entry.measuredAt < previous.measuredAt
        || entry.measuredAt === previous.measuredAt && entry.value !== previous.value)) return [];
    if (entry.value !== previous?.value && (entry.value || previous)) events.push(entry);
    previous = entry;
  }
  return events;
}

// Consuming a newer source episode also fences older episodes. Otherwise a
// later legitimate match could revive an earlier ambiguous start/stop pair.
// Use raw history: ongoing baselines need not be distinct transition edges.
export function bmwConsumedChargingAt(reading, consumedChargingId) {
  if (!eventId(consumedChargingId)) return null;
  try { validateBmwChargingHistory(reading); } catch { return null; }
  return reading?.fields?.charging?.history?.find(row => row.value === true
    && row.readingId === consumedChargingId)?.measuredAt ?? null;
}

// Vehicle departures fence all historical charging episodes, including when
// charger polling did not observe the intervening unplug.
function bmwEvidenceStart(reading, connectedAt, lastDisconnectedAt) {
  const departure = ['pluggedIn', 'atHome'].map(key => reading?.fields?.[key]?.negativeEvent?.measuredAt)
    .filter(time).reduce((at, value) => Math.max(at, value), lastDisconnectedAt ?? -1);
  return connectionEvidenceStart(connectedAt, departure);
}

const BMW_EDGE_TOLERANCE = 30_000;

function bmwSessionEvidence(reading, { connectedAt, lastDisconnectedAt, chargingAt, stoppedAt,
  now = Date.now(), consumedChargingId, matchingSince = null } = {}) {
  if (matchingSince !== null && !time(matchingSince)) return null;
  if (!time(now) || !time(connectedAt) || connectedAt > now || reading?.provider !== 'bmw-cardata'
    || !bmwHomeContext(reading, now) || reading.pluggedIn !== true
    || !currentContext(reading.fields?.pluggedIn, now, Infinity)) return null;
  const evidenceStart = bmwEvidenceStart(reading, connectedAt, lastDisconnectedAt);
  const sourceTime = at => time(at) && at >= evidenceStart && at <= now;
  const event = observed => observed?.retained === false && eventId(observed.readingId)
    && sourceTime(observed.measuredAt) && time(observed.receivedAt)
    && observed.receivedAt >= evidenceStart && observed.receivedAt <= now;
  const chargingTimes = (Array.isArray(chargingAt) ? chargingAt : [chargingAt])
    .filter(at => sourceTime(at) && (matchingSince === null || at >= matchingSince)).sort((a, b) => a - b);
  const stoppedTimes = (Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt]).filter(sourceTime).sort((a, b) => a - b);
  const edges = bmwChargingEvents(reading);
  const consumedAt = bmwConsumedChargingAt(reading, consumedChargingId);
  const episodes = [];
  for (let index = 0; index < edges.length; index++) {
    const start = edges[index], stop = edges[index + 1]?.value === false ? edges[index + 1] : null;
    if (start.value !== true || !event(start) || start.readingId === consumedChargingId
      || consumedAt !== null && start.measuredAt <= consumedAt
      || matchingSince !== null && start.measuredAt < matchingSince) continue;
    // Pair the first physical stop following the matched physical start. A
    // later unrelated stop must not close an earlier charging episode.
    const starts = chargingTimes.filter(at => Math.abs(start.measuredAt - at) <= BMW_EDGE_TOLERANCE);
    if (starts.length) episodes.push({ start, stop: event(stop) ? stop : null, starts });
  }
  return { connectedAt, now, evidenceStart, sourceTime, event, episodes, chargingTimes, stoppedTimes };
}

function matchingEpisodeStop(evidence, episode, pause = null) {
  const { start, stop, starts } = episode;
  if (!stop || stop.measuredAt <= start.measuredAt) return false;
  return starts.some(at => {
    const end = evidence.stoppedTimes.find(value => value > at);
    if (!time(end) || Math.abs(stop.measuredAt - end) > BMW_EDGE_TOLERANCE) return false;
    return !pause || at < pause.requestedAt && end > pause.requestedAt
      && Math.abs(pause.stoppedAt - end) <= BMW_EDGE_TOLERANCE;
  });
}

function freshPlugEvidence(reading, evidence) {
  const plug = reading?.fields?.pluggedIn?.positiveEvent;
  return evidence && evidence.event(plug) && plug.measuredAt <= evidence.connectedAt + 10 * MINUTE ? plug : null;
}

function bmwSessionEpisodes(reading, options) {
  const evidence = bmwSessionEvidence(reading, options);
  if (!evidence) return null;
  const plug = freshPlugEvidence(reading, evidence);
  if (plug) return plug.readingId === options.consumedPlugId ? null : { evidence, plug, episodes: evidence.episodes };
  // BMW may keep CONNECTED throughout a garage stay. Its inlet observation is
  // context, not a new plug edge. In that case both independent charging starts
  // must follow the actual charger connection; pre-poll tolerance cannot revive
  // an earlier episode without a corresponding new vehicle plug transition.
  const context = reading.fields?.pluggedIn;
  if (!eventId(context?.readingId) || !time(context.receivedAt) || context.receivedAt > evidence.now
    || typeof context.retained !== 'boolean') return null;
  const episodes = evidence.episodes.filter(episode => episode.start.measuredAt >= evidence.connectedAt)
    .map(episode => ({ ...episode, starts: episode.starts.filter(at => at >= evidence.connectedAt) }))
    .filter(episode => episode.starts.length);
  return { evidence, plug: null, episodes };
}

/** Match two independent physical transitions in the same plug connection.
 * Delivery delay and elapsed charging time do not invalidate those timestamps.
 * A fresh vehicle plug edge permits the bounded pre-poll start window; an
 * unchanged inlet instead requires both charging starts inside the connection. */
export function bmwSessionMatchDetails(reading, options = {}) {
  const session = bmwSessionEpisodes(reading, options);
  if (!session) return null;
  const episode = session.episodes.find(value => matchingEpisodeStop(session.evidence, value));
  return episode ? { chargingReadingId: episode.start.readingId, stopReadingId: episode.stop.readingId,
    plugReadingId: session.plug?.readingId ?? null } : null;
}

export function matchBmwSession(reading, options = {}) {
  return Boolean(bmwSessionMatchDetails(reading, options));
}

/** A plausible unmatched start stays pending for its physical connection. */
export function pendingBmwSession(reading, options = {}) {
  const session = bmwSessionEpisodes(reading, options);
  return Boolean(session?.episodes.length
    && !session.episodes.some(value => matchingEpisodeStop(session.evidence, value)));
}

function controlledPauseMatch(evidence, pause) {
  if (!evidence || pause?.connectedAt !== evidence.connectedAt
    || !time(pause.confirmedAt) || pause.confirmedAt < evidence.connectedAt || pause.confirmedAt > evidence.now
    || !time(pause.startAt) || !evidence.sourceTime(pause.stoppedAt)
    || !time(pause.requestedAt) || pause.requestedAt < evidence.connectedAt
    || pause.requestedAt > pause.confirmedAt || pause.stoppedAt <= pause.requestedAt
    || pause.startAt <= pause.stoppedAt) return null;
  const episode = evidence.episodes.find(value => value.start.measuredAt < pause.requestedAt
    && value.stop?.measuredAt > pause.requestedAt && matchingEpisodeStop(evidence, value, pause));
  return episode ? { chargingReadingId: episode.start.readingId, stopReadingId: episode.stop.readingId,
    confirmedAt: pause.confirmedAt } : null;
}

/** Saved confirmed pause evidence remains applicable after resuming, including
 * a historical BMW stop delivered after a newer report that charging resumed. */
export function matchBmwControlledPause(reading, options = {}) {
  return controlledPauseMatch(bmwSessionEvidence(reading, options), options.pause);
}

export function pendingBmwControlledPause(reading, options = {}) {
  const evidence = bmwSessionEvidence(reading, options);
  return Boolean(evidence?.episodes.length && !controlledPauseMatch(evidence, options.pause));
}
