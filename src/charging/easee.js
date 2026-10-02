import { createHash } from 'node:crypto';
import moment from 'moment-timezone';

// Public Easee /schedules OpenAPI checked 2026-09-15. Delayed startTime is
// a LOCAL TIME, not a date-time. The controller retains the absolute occurrence.
const TYPES = ['delayed', 'daily', 'weekly', 'offPeak', 'tariff'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const CHARGING_OBSERVATION_IDS = [22, 23, 24, 31, 47, 48, 96, 100, 104, 109, 110, 111, 112, 113, 120, 183, 184, 185, 230, 231, 232, 250];
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
const amps = value => { const n = numeric(value); return n !== null && n >= 0 && n <= 1000 ? n : null; };
const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.0+)?)?$/.test(value)
  ? `${value.slice(0, 5)}:${value.length >= 8 ? value.slice(6, 8) : '00'}` : null;
const zone = value => typeof value === 'string' && moment.tz.zone(value) ? value : null;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

export function normalizeScheduleState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !['none', ...TYPES].includes(payload.enabled)) throw new Error('Easee scheduling state is not understood');
  const state = { enabled: payload.enabled };
  for (const kind of TYPES) {
    const row = payload[kind];
    if (row == null) { state[kind] = null; continue; }
    if (!row || typeof row !== 'object' || !zone(row.timezone)) throw new Error('Easee schedule timezone is not understood');
    if (kind === 'delayed') {
      if (!time(row.startTime) || amps(row.maximumAmps) === null) throw new Error('Easee delayed schedule is not understood');
      state[kind] = { timezone: row.timezone, startTime: time(row.startTime), maximumAmps: amps(row.maximumAmps) };
    } else if (kind === 'daily' || kind === 'weekly') {
      if (!Array.isArray(row.periods) || row.periods.length > 18) throw new Error('Easee schedule periods are not understood');
      const periods = row.periods.map(period => {
        if (!time(period?.startTime) || !time(period?.stopTime) || amps(period?.maximumAmps) === null
          || kind === 'weekly' && (!DAYS.includes(period.startDay) || !DAYS.includes(period.stopDay)))
          throw new Error('Easee schedule period is not understood');
        return { startTime: time(period.startTime), stopTime: time(period.stopTime), maximumAmps: amps(period.maximumAmps),
          ...(kind === 'weekly' ? { startDay: period.startDay, stopDay: period.stopDay } : {}) };
      });
      state[kind] = { timezone: row.timezone, periods: ordered(periods) };
    } else {
      // These types have richer semantics. Fingerprint the complete representation
      // but never consume or rewrite them as a guessed temporary manual window.
      if (JSON.stringify(row).length > 16_384) throw new Error('Easee schedule is too large');
      state[kind] = { timezone: row.timezone, detailsFingerprint:
        typeof row.detailsFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.detailsFingerprint)
          ? row.detailsFingerprint : hash(ordered(row)) };
    }
  }
  if (state.enabled !== 'none' && !state[state.enabled]) throw new Error('Easee enabled schedule is missing');
  return state;
}

export function scheduleFingerprint(state) { return hash(normalizeScheduleState(state)); }
export const easeeScheduleTakeoverSupported = schedule => ['none', 'delayed', 'daily', 'weekly'].includes(schedule?.enabled);

/** Bind an explicit handover to the instruction actually shown to its user. */
export function easeeTakeoverFingerprint(snapshot) {
  if (!snapshot?.schedule) return null;
  return hash([snapshot.fingerprint ?? scheduleFingerprint(snapshot.schedule), snapshot.enabled,
    snapshot.observations?.[31]?.at ?? null, snapshot.stopped, snapshot.reason, snapshot.reasonAt,
    snapshot.mode, snapshot.modeAt, snapshot.limits?.dynamicChargerA, snapshot.observations?.[48]?.at ?? null, snapshot.limits?.chargerA,
    snapshot.pluggedIn, snapshot.faulted, snapshot.authorizationBlocked]);
}

/** Only the active instruction can override the current charging session. */
export function effectiveScheduleFingerprint(state) {
  const normalized = normalizeScheduleState(state);
  return scheduleFingerprint({ enabled: normalized.enabled,
    ...(normalized.enabled !== 'none' ? { [normalized.enabled]: normalized[normalized.enabled] } : {}) });
}

const failure = (code, message) => Object.assign(new Error(message), { code });

function wallTime(date, localTime, timezone) {
  const result = moment.tz(`${date} ${localTime}`, 'YYYY-MM-DD HH:mm:ss', true, timezone);
  // Nonexistent spring-forward times must not silently shift on the charger.
  return result.isValid() && result.format('HH:mm:ss') === localTime ? result.valueOf() : null;
}
function ambiguousWallTime(at, timezone) {
  const key = moment.tz(at, timezone).format('YYYY-MM-DD HH:mm:ss');
  const localZone = moment.tz.zone(timezone);
  const change = Math.abs(localZone.utcOffset(at - 86400_000) - localZone.utcOffset(at + 86400_000)) * 60_000;
  return change > 0 && [-change, change].some(offset => moment.tz(at + offset, timezone).format('YYYY-MM-DD HH:mm:ss') === key);
}

export function nextLocalOccurrence(localTime, timezone, now) {
  if (!time(localTime) || !zone(timezone)) return null;
  const day = moment.tz(now, timezone).startOf('day');
  for (let offset = 0; offset <= 2; offset++) {
    const candidate = wallTime(day.clone().add(offset, 'days').format('YYYY-MM-DD'), time(localTime), timezone);
    if (candidate !== null && candidate > now) return candidate;
  }
  return null;
}

export function delayedScheduleFor({ startAt, timezone, maximumAmps }, now) {
  const invalid = (detailCode, message) => Object.assign(failure('invalid-plan', message), { detailCode, publicReason: message });
  if (!Number.isSafeInteger(startAt) || !zone(timezone))
    throw invalid('invalid-start', 'The plan has an invalid start time or timezone. A new plan is needed.');
  if (!Number.isInteger(maximumAmps) || maximumAmps < 6 || maximumAmps > 80)
    throw invalid('missing-current-limit', Number.isFinite(maximumAmps)
      ? `The reported charging limit is ${maximumAmps} A; a native delayed start requires 6–80 whole amperes.`
      : 'The charger has not supplied a usable charging-current limit for the native schedule.');
  if (startAt <= now) throw Object.assign(failure('state-changed', 'The planned start has arrived while checking the charger.'), { detailCode: 'start-passed' });
  if (startAt % 1000 !== 0)
    throw invalid('sub-second-start', 'The plan contains a sub-second start, but the native schedule uses whole seconds.');
  const startTime = moment.tz(startAt, timezone).format('HH:mm:ss');
  const next = nextLocalOccurrence(startTime, timezone, now);
  if (next === null || next !== startAt)
    throw invalid('start-out-of-range', `The proposed start is ${moment.tz(startAt, timezone).format('D MMM HH:mm:ss')}, but Easee would use the next occurrence of ${startTime}.`);
  if (ambiguousWallTime(startAt, timezone))
    throw invalid('ambiguous-start', `The proposed local start ${startTime} occurs twice during the daylight-saving change; the charger cannot confirm which occurrence it will use.`);
  return { timezone, startTime, maximumAmps };
}

/** One simple repeating window grants control through its concrete end.
 * Multiple periods or ambiguous endpoints require explicit resumption. */
export function manualScheduleWindow(state, now) {
  const kind = state.enabled, schedule = state[kind];
  if (!['daily', 'weekly'].includes(kind) || schedule?.periods?.length !== 1) return null;
  const local = moment.tz(now, schedule.timezone).startOf('day'), candidates = [];
  for (const period of schedule.periods) for (let offset = -7; offset <= 7; offset++) {
    const day = local.clone().add(offset, 'days');
    if (kind === 'weekly' && DAYS[day.day()] !== period.startDay) continue;
    const start = wallTime(day.format('YYYY-MM-DD'), period.startTime, schedule.timezone);
    let days = kind === 'weekly' ? (DAYS.indexOf(period.stopDay) - DAYS.indexOf(period.startDay) + 7) % 7 : 0;
    if (days === 0 && period.stopTime <= period.startTime) days = kind === 'weekly' ? 7 : 1;
    const end = wallTime(day.clone().add(days, 'days').format('YYYY-MM-DD'), period.stopTime, schedule.timezone);
    if (start !== null && end !== null && end > now && end > start) candidates.push({ startsAt: start, windowEndAt: end,
      ambiguous: ambiguousWallTime(start, schedule.timezone) || ambiguousWallTime(end, schedule.timezone) });
  }
  candidates.sort((a, b) => a.startsAt - b.startsAt);
  const selected = candidates.slice(0, 1);
  if (!selected.length || selected.some(row => row.ambiguous)) return null;
  const windowEndAt = Math.max(...selected.map(row => row.windowEndAt));
  return { kind: 'window', repeating: true, startsAt: selected[0].startsAt, windowEndAt, resumeAt: windowEndAt };
}

/** Read-only schedule display. Complex recurrences remain under their owner's
 * control: displaying an occurrence does not authorize automatic handback. */
export function nextScheduleOccurrence(state, now) {
  const kind = state?.enabled, schedule = state?.[kind];
  const empty = { startAt: null, endAt: null, endKind: null, kind: kind ?? 'none' };
  if (!schedule || !zone(schedule.timezone)) return empty;
  if (kind === 'delayed') {
    const startAt = nextLocalOccurrence(schedule.startTime, schedule.timezone, now);
    return startAt === null || ambiguousWallTime(startAt, schedule.timezone) ? empty : { ...empty, startAt };
  }
  if (!['daily', 'weekly'].includes(kind)) return empty;
  const windows = [], local = moment.tz(now, schedule.timezone).startOf('day');
  const firstOffset = kind === 'daily' ? -1 : -7, lastOffset = kind === 'daily' ? 2 : 14;
  for (const period of schedule.periods ?? []) {
    for (let offset = firstOffset; offset <= lastOffset; offset++) {
      const day = local.clone().add(offset, 'days');
      if (kind === 'weekly' && DAYS[day.day()] !== period.startDay) continue;
      const startAt = wallTime(day.format('YYYY-MM-DD'), period.startTime, schedule.timezone);
      let days = kind === 'weekly' ? (DAYS.indexOf(period.stopDay) - DAYS.indexOf(period.startDay) + 7) % 7 : 0;
      if (days === 0 && period.stopTime <= period.startTime) days = kind === 'weekly' ? 7 : 1;
      const endAt = wallTime(day.clone().add(days, 'days').format('YYYY-MM-DD'), period.stopTime, schedule.timezone);
      if (startAt !== null && endAt !== null && endAt > now && endAt > startAt)
        windows.push({ startAt, endAt, ambiguous: ambiguousWallTime(startAt, schedule.timezone)
          || ambiguousWallTime(endAt, schedule.timezone) });
    }
  }
  windows.sort((a, b) => a.startAt - b.startAt);
  if (!windows.length) return empty;
  if (windows[0].ambiguous) return empty;
  let { startAt, endAt } = windows[0];
  // Adjacent or overlapping periods do not actually stop charging at the first
  // period's end. Report the end of the complete continuous native window.
  for (const window of windows.slice(1)) {
    if (window.startAt > endAt) break;
    if (window.ambiguous) return empty;
    endAt = Math.max(endAt, window.endAt);
  }
  // A recurrence continuously open for a whole repetition has no actual stop;
  // its period boundary must not masquerade as a charging end time.
  const repetitionEnd = moment.tz(startAt, schedule.timezone).add(kind === 'daily' ? 1 : 7, 'days').valueOf();
  if (endAt >= repetitionEnd) return { ...empty, continuous: true };
  return { startAt, endAt, endKind: 'scheduled-stop', kind };
}

export function chargingSnapshot(observations, scheduling, now, allocationA = null, { externalLoadBalancing = true, supply = null } = {}) {
  const list = Array.isArray(observations) ? observations : observations?.observations;
  if (!Array.isArray(list) || list.length > 1000) throw new Error('Easee charger state is not understood');
  const pick = id => {
    const entries = list.filter(row => Number(row?.id) === id).map(row => ({ value: row.value, at: instant(row.timestamp) }))
      .filter(row => row.at !== null && row.at <= now).sort((a, b) => b.at - a.at);
    const row = entries[0];
    return !row || entries.some(other => other.at === row.at && String(other.value) !== String(row.value)) ? { value: null, at: null } : row;
  };
  const bool = id => { const value = pick(id).value; return [true, 1, 'true', '1'].includes(value) ? true : [false, 0, 'false', '0'].includes(value) ? false : null; };
  const scheduleState = scheduling === null ? null : normalizeScheduleState(scheduling), mode = numeric(pick(109).value), reason = numeric(pick(96).value);
  const pilot = pick(100).value, online = bool(250), enabled = bool(31);
  const indications = [{ value: mode === 1 ? false : [2, 3, 4, 6, 7, 8].includes(mode) ? true : null, at: pick(109).at },
    { value: pilot === 'A' ? false : ['B', 'C', 'D'].includes(pilot) ? true : null, at: pick(100).at }]
    .filter(item => item.value !== null && Number.isFinite(item.at)).sort((a, b) => b.at - a.at);
  const pluggedIn = indications.length && !indications.some(item => item.at === indications[0].at && item.value !== indications[0].value) ? indications[0].value : null;
  // These are change-reported source events. Re-reading an old disconnected
  // state cannot move its physical boundary to the HTTP receipt time.
  const disconnectTimes = [mode === 1 ? pick(109).at : null, pilot === 'A' ? pick(100).at : null]
    .filter(at => Number.isSafeInteger(at) && at >= 0 && at <= now);
  const result = { ...(scheduleState ? { schedule: scheduleState, fingerprint: scheduleFingerprint(scheduleState) } : {}), readAt: now,
    online, enabled, pluggedIn, mode, reason, powerKw: numeric(pick(120).value),
    disconnectedAt: pluggedIn === false && disconnectTimes.length ? Math.max(...disconnectTimes) : null,
    externalLoadBalancing, supply, outputPhase: numeric(pick(110).value),
    observations: Object.fromEntries(CHARGING_OBSERVATION_IDS.map(id => [id, pick(id)])),
    modeAt: pick(109).at, reasonAt: pick(96).at, powerAt: pick(120).at,
    limits: { circuitA: [22, 23, 24].map(id => amps(pick(id).value)), chargerA: amps(pick(47).value),
      cableA: amps(pick(104).value) > 0 ? amps(pick(104).value) : null, dynamicChargerA: amps(pick(48).value),
      dynamicCircuitA: [111, 112, 113].map(id => amps(pick(id).value)),
      equalizerAvailableA: [230, 231, 232].map(id => amps(pick(id).value)),
      allocationA, equalizerAvailableAt: [230, 231, 232].map(id => pick(id).at) } };
  // A zero dynamic charger limit is the restriction used by the Easee app's
  // pause. Keep it separate from circuit/Equalizer limiting and from who set it.
  result.dynamicChargerPaused = reason === 52 && result.limits.dynamicChargerA === 0;
  result.stopped = enabled === false || reason === 53 || result.dynamicChargerPaused;
  result.authorizationBlocked = [7, 8].includes(mode) || reason === 55;
  result.faulted = mode === 5 || reason === 56;
  result.manualStop = result.stopped;
  // Mode, current allowance and no-current reason may change automatically.
  // Compare command-relevant availability without mistaking load balancing for
  // a user instruction. Charging that begins during a write gets a fresh read.
  result.controlFingerprint = hash([enabled, pluggedIn, result.stopped, result.authorizationBlocked, result.faulted]);
  result.controlKnown = online === true && enabled !== null && mode !== null && reason !== null && pluggedIn !== null
    && (reason !== 52 || result.limits.dynamicChargerA !== null);
  return result;
}

/** Adapt charger observations to the same vehicle/charger signals used by
 * TeslaMate. Unsupported vehicle values remain absent; AC charging energy and
 * cable ratings cannot establish a vehicle's usable capacity or charge target. */
export function easeeChargerTelemetry(snapshot = {}, { now = Date.now() } = {}) {
  const available = snapshot.online === true && Number.isFinite(snapshot.readAt)
    && snapshot.readAt <= now && now - snapshot.readAt <= 5 * 60_000;
  const signal = (value, ids = [], source = 'easee') => {
    const inputs = ids.map(id => ({ id, measuredAt: snapshot.observations?.[id]?.at ?? null }));
    return { value: available && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value)) ? value : null, source,
      available: available && value !== undefined && value !== null && !(typeof value === 'number' && !Number.isFinite(value)),
      measuredAt: inputs.length === 1 ? inputs[0].measuredAt : null,
      receivedAt: snapshot.readAt ?? null, timeBasis: inputs.length > 1 ? 'derived-observations' : 'observation',
      ...(inputs.length > 1 ? { inputs } : {}) };
  };
  const limits = snapshot.limits ?? {}, externalLoadBalancing = snapshot.externalLoadBalancing !== false;
  const limitValues = [limits.chargerA, limits.cableA, limits.dynamicChargerA,
    ...(limits.circuitA ?? []), ...(limits.dynamicCircuitA ?? [])].filter(value => amps(value) !== null);
  const equalizerKnown = Array.isArray(limits.equalizerAvailableA) && limits.equalizerAvailableA.length === 3
    && limits.equalizerAvailableA.every(value => amps(value) !== null);
  if (externalLoadBalancing && equalizerKnown) limitValues.push(...limits.equalizerAvailableA);
  const currentA = limitValues.length && (!externalLoadBalancing || equalizerKnown) ? Math.min(...limitValues) : null;
  const fixedCeilings = [limits.chargerA, limits.cableA, ...(limits.circuitA ?? [])].filter(value => amps(value) !== null);
  const maxCurrentA = fixedCeilings.length ? Math.min(...fixedCeilings) : null;
  const currentIds = [22, 23, 24, 47, 48, 104, 111, 112, 113, ...(externalLoadBalancing ? [230, 231, 232] : [])];
  const voltage = snapshot.supply?.voltageV;
  const voltageV = Array.isArray(voltage) && voltage.length === 3 && voltage.every(value => Number.isFinite(value) && value >= 200 && value <= 250)
    ? voltage.reduce((sum, value) => sum + value, 0) / 3 : null;
  const schedule = nextScheduleOccurrence(snapshot.schedule, now);
  return { ...snapshot, provider: 'easee', providerConnected: available,
    capabilities: { scheduling: true, currentControl: false, externalLoadBalancing,
      automatic: { capacityKwh: false, soc: false, minimumSoc: false, connected: true, currentA: true, schedule: true } },
    capacityKwh: signal(null), soc: signal(null), minimumSoc: signal(null),
    connected: signal(snapshot.pluggedIn, [100, 109]),
    currentA: signal(currentA, currentIds, externalLoadBalancing ? 'easee-equalizer' : 'easee'),
    maxCurrentA: signal(maxCurrentA, [22, 23, 24, 47, 104]),
    availableCurrentA: signal(equalizerKnown ? Math.min(...limits.equalizerAvailableA) : null, [230, 231, 232], 'easee-equalizer'),
    actualCurrentA: signal(snapshot.supply?.chargerCurrentA?.reduce((sum, value) => sum + value, 0) / 3, [183, 184, 185]),
    phases: { value: 3, available: true, source: 'installation-assumption', assumed: true },
    voltageV: { ...signal(voltageV, [], 'easee-equalizer'), timeBasis: 'derived-observations',
      inputs: [34, 35, 36].map((id, index) => ({ id, measuredAt: snapshot.supply?.observationTimes?.voltage?.[index] ?? null })) },
    charging: signal(snapshot.mode === null || snapshot.mode === undefined ? null : snapshot.mode === 3, [109]),
    powerKw: signal(snapshot.powerKw, [120]),
    scheduledStartAt: signal(schedule.startAt, [], 'easee-schedule'),
    scheduledEndAt: signal(schedule.endAt, [], 'easee-schedule'), scheduledEndKind: schedule.endKind,
    scheduleKind: schedule.kind };
}

/** Inject existing authenticated/rate-limited transport; raw account data stays local. */
export function createEaseeScheduleAdapter({ request, readObservations, chargerId, equalizerId, clock = Date.now, canControl = () => false }) {
  const base = `https://api.easee.com/api/chargers/${encodeURIComponent(chargerId)}/schedules`;
  readObservations ??= (deviceId, ids, { signal } = {}) => request(
    `https://api.easee.com/state/${encodeURIComponent(deviceId)}/observations?ids=${ids.join(',')}`, { method: 'GET', signal });
  let allocationA = null, allocationReadAt = -Infinity, allocationConfirmedAt = -Infinity;
  const adapter = {
    normalize(snapshot, options = {}) { return easeeChargerTelemetry(snapshot, { now: clock(), ...options }); },
    async read({ signal, forceRest = false, telemetryOnly = false } = {}) {
      if (!chargerId) throw new Error('Charger 1 Easee connection is not configured');
      let now = clock();
      let scheduling, observations, property;
      try {
        [scheduling, observations, property] = await Promise.all([
          telemetryOnly ? null : request(base, { method: 'GET', signal }),
          readObservations(chargerId, CHARGING_OBSERVATION_IDS, { signal, forceRest }),
          equalizerId ? readObservations(equalizerId, [31, 32, 33, 34, 35, 36], { signal, forceRest }).catch(() => null) : null,
        ]);
      } catch { throw failure('read-failed', 'Easee state could not be read.'); }
      if (equalizerId && now - allocationReadAt >= 3600_000) {
        allocationReadAt = now;
        try {
          allocationA = amps((await request(`https://api.easee.com/api/equalizers/${encodeURIComponent(equalizerId)}/config`, { method: 'GET', signal }))?.maxAllocatedCurrent);
          allocationConfirmedAt = clock();
        } catch {
          // An occasional config failure must not erase a still-supported
          // ceiling while current observations remain available.
          if (now - allocationConfirmedAt > 24 * 3600_000) allocationA = null;
        }
      }
      now = clock();
      try {
        const snapshot = chargingSnapshot(observations, scheduling, now, allocationA, { externalLoadBalancing: Boolean(equalizerId) });
        const rows = Array.isArray(property) ? property : property?.observations ?? [];
        const pick = id => {
          const entries = rows.filter(row => Number(row?.id) === id && instant(row.timestamp) !== null && instant(row.timestamp) <= now)
            .sort((a, b) => instant(b.timestamp) - instant(a.timestamp));
          const first = entries[0];
          return first && !entries.some(row => row.timestamp === first.timestamp && String(row.value) !== String(first.value)) ? first : null;
        };
        const vector = (ids, min = 0, max = 1000) => {
          const values = ids.map(id => numeric(pick(id)?.value));
          return values.every(value => value !== null && value >= min && value <= max) ? values : null;
        };
        const currents = [183, 184, 185].map(id => amps(snapshot.observations[id]?.value));
        // Charger currents are change events; an unchanged zero remains valid.
        // Preserve the meter's original event state for the bounded forecast
        // estimator. Its timestamp policy differs from live current adjustment.
        const recentProperty = [31, 32, 33].every(id => pick(id) && now - instant(pick(id).timestamp) <= 5 * 60_000);
        snapshot.supply = { availableCurrentA: snapshot.limits.equalizerAvailableA,
          propertyCurrentA: recentProperty ? vector([31, 32, 33]) : null,
          reportedPropertyCurrentA: vector([31, 32, 33]),
          chargerCurrentA: currents.every(value => value !== null) ? currents : null,
          voltageV: vector([34, 35, 36], 200, 250), allocationA, observedAt: now,
          observationTimes: { allowance: snapshot.limits.equalizerAvailableAt,
            property: [31, 32, 33].map(id => instant(pick(id)?.timestamp)),
            charger: [183, 184, 185].map(id => snapshot.observations[id]?.at ?? null),
            voltage: [34, 35, 36].map(id => instant(pick(id)?.timestamp)) } };
        return snapshot;
      } catch { throw failure('read-failed', 'Easee returned an unsupported charger or schedule state.'); }
    },
    readTelemetry(options = {}) { return adapter.read({ ...options, telemetryOnly: true }); },
    async takeover({ expectedSnapshot, pause = null, signal, canMutate = () => false,
      beforeWrite = () => {}, afterWrite = () => {} } = {}) {
      let current = await adapter.read({ signal, forceRest: true });
      const allowed = () => canControl() && canMutate();
      const usable = value => value.online === true && value.controlKnown && !value.faulted && !value.authorizationBlocked;
      const same = value => easeeTakeoverFingerprint(value) === easeeTakeoverFingerprint(current);
      if (!expectedSnapshot || easeeTakeoverFingerprint(current) !== easeeTakeoverFingerprint(expectedSnapshot))
        throw failure('state-changed', 'The charger instruction changed before automatic handover.');
      if (!allowed()) throw failure('control-revoked', 'Charging control authority changed.');
      if (!usable(current)) throw failure('access-denied', 'The charger is not available for automatic handover.');
      if (!easeeScheduleTakeoverSupported(current.schedule))
        throw failure('unsupported-schedule', 'This schedule cannot yet be disabled through the supported charger API.');
      // Resume resets the dynamic charger ceiling. Never erase a separate
      // current restriction whose purpose cannot be established from telemetry.
      const canResume = value => amps(value.limits?.dynamicChargerA) !== null
        && amps(value.limits?.chargerA) > 0 && (value.limits.dynamicChargerA >= value.limits.chargerA
          || value.limits.dynamicChargerA === 0 && [52, 53].includes(value.reason)
            && value.limits.circuitA?.length === 3 && value.limits.circuitA.every(limit => amps(limit) > 0)
            && (value.pluggedIn === false || amps(value.limits.cableA) > 0));
      const resumeRequired = value => value.reason === 53 || value.dynamicChargerPaused === true;
      const samePause = (after, before) => !resumeRequired(before)
        || after.reason === before.reason && after.reasonAt === before.reasonAt
          && after.limits?.dynamicChargerA === before.limits?.dynamicChargerA
          && after.observations?.[48]?.at === before.observations?.[48]?.at;
      if (resumeRequired(current) && !canResume(current))
        throw failure('resume-current-limit', 'The charger pause cannot be cleared while preserving its current limit.');
      const write = async (stage, url, body, verify) => {
        const dispatchAllowed = () => allowed() && (stage !== 'schedule' || !pause || pause.startAt - clock() >= 15 * 60_000);
        const before = await adapter.read({ signal, forceRest: true });
        if (!same(before)) throw failure('state-changed', 'The charger instruction changed during automatic handover.');
        if (!allowed() || !usable(before)) throw failure('control-revoked', 'Charging control authority changed.');
        await beforeWrite({ stage, before: clone(before) });
        if (!dispatchAllowed()) throw failure('control-revoked', 'Charging control authority or the planned pause changed.');
        const requestedAt = clock();
        try {
          await request(url, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body) } : {}), signal, controlGuard: dispatchAllowed }, true);
        } catch (error) {
          if (!allowed()) throw failure('control-revoked', 'Charging control authority changed.');
          if ([401, 403].includes(error?.status ?? error?.response?.status)) throw failure('access-denied', 'Easee rejected charging authorization.');
          throw failure('command-failed', 'Easee did not confirm automatic handover.');
        }
        let after;
        try { after = await adapter.read({ signal, forceRest: true }); }
        catch { throw failure('readback-failed', 'Automatic handover could not be read back.'); }
        if (!usable(after) || !verify(after, before, requestedAt))
          throw failure('readback-mismatch', 'The charger has not confirmed automatic handover.');
        current = after;
        await afterWrite({ stage, snapshot: clone(current), requestedAt });
        if (!allowed()) throw failure('control-revoked', 'Charging control authority changed.');
      };
      if (pause) {
        const priorKind = current.schedule.enabled;
        const delayed = delayedScheduleFor(pause, clock());
        if (pause.startAt - clock() < 15 * 60_000) throw failure('start-passed', 'The planned pause is too short.');
        await write('schedule', `${base}/delayed`, { enabled: true, ...delayed }, (after, before) =>
          after.fingerprint === scheduleFingerprint({ ...before.schedule, enabled: 'delayed', delayed }) && after.enabled === before.enabled
          && after.observations?.[31]?.at === before.observations?.[31]?.at
          && after.pluggedIn === before.pluggedIn && after.stopped === before.stopped
          && samePause(after, before));
        // Replacing the active type alone does not prove that an older repeating
        // schedule was permanently disabled. Explicitly disable its named type
        // beneath the confirmed delay; never first remove the current pause.
        if (['daily', 'weekly'].includes(priorKind)) {
          await write('schedule-disable', `${base}/${priorKind}/disable`, null, (after, before) =>
            after.fingerprint === before.fingerprint && after.controlFingerprint === before.controlFingerprint
            && after.observations?.[31]?.at === before.observations?.[31]?.at
            && samePause(after, before));
        }
      } else if (current.schedule.enabled !== 'none') {
        await write('schedule', `${base}/${current.schedule.enabled}/disable`, null, (after, before) =>
          after.schedule.enabled === 'none' && after.controlFingerprint === before.controlFingerprint
          && after.observations?.[31]?.at === before.observations?.[31]?.at
          && samePause(after, before));
      }
      const chargerBase = base.slice(0, -'/schedules'.length);
      if (current.enabled === false) {
        await write('enable', `${chargerBase}/settings`, { enabled: true }, (after, before, requestedAt) =>
          after.enabled === true && after.observations?.[31]?.at >= requestedAt
          && after.fingerprint === before.fingerprint && after.pluggedIn === before.pluggedIn
          && (!resumeRequired(after) || samePause(after, before)));
      }
      if (resumeRequired(current)) {
        if (!canResume(current)) throw failure('resume-current-limit', 'The charger current limit prevents automatic handover.');
        await write('resume', `${chargerBase}/commands/resume_charging`, null, (after, before, requestedAt) =>
          after.enabled === true && !after.stopped && after.reasonAt >= requestedAt
          && after.limits?.dynamicChargerA > 0 && (before.limits.dynamicChargerA > 0
            && after.limits.dynamicChargerA === before.limits.dynamicChargerA || after.observations?.[48]?.at >= requestedAt)
          && after.fingerprint === before.fingerprint && after.pluggedIn === before.pluggedIn);
      }
      if (current.stopped) throw failure('readback-mismatch', 'The charger still reports stopped.');
      return current;
    },
    async installDelayed({ startAt, timezone, maximumAmps, expectedFingerprint, expectedControlFingerprint, signal,
      canMutate = () => true, allowChargingPause = false, beforeWrite = () => {}, identification = null } = {}) {
      if (identification !== null && (typeof identification !== 'object' || Array.isArray(identification)
        || Object.keys(identification).some(key => !['id', 'connectedAt'].includes(key))
        || typeof identification.id !== 'string' || !identification.id.length || identification.id.length > 128
        || !Number.isSafeInteger(identification.connectedAt) || identification.connectedAt < 0
        || identification.connectedAt > clock() || startAt - clock() > 5 * 60_000))
        throw failure('invalid-plan', 'The identification pause is invalid.');
      // A stream snapshot may precede a competing instruction. Keep the final
      // command guard and readback on freshly fetched device observations.
      const before = await adapter.read({ signal, forceRest: true });
      if (before.fingerprint !== expectedFingerprint || expectedControlFingerprint && before.controlFingerprint !== expectedControlFingerprint)
        throw failure('state-changed', 'Easee changed before the schedule write.');
      if (before.mode === 3 && !allowChargingPause) throw failure('state-changed', 'Charging began before the schedule write.');
      if (!canControl() || !canMutate()) throw failure('control-revoked', 'Charging control authority changed.');
      if (!before.controlKnown || before.manualStop || before.authorizationBlocked || before.faulted)
        throw failure('access-denied', 'The charger is not available for an automatic schedule.');
      const delayed = delayedScheduleFor({ startAt, timezone, maximumAmps }, clock());
      const temporalGuard = () => {
        if (!canMutate() || !canControl() || startAt - clock() < (identification ? 1000 : 15 * 60000)) return false;
        try { delayedScheduleFor({ startAt, timezone, maximumAmps }, clock()); return true; } catch { return false; }
      };
      // Let the controller durably record this guarded observation before the
      // request. A failed save must leave the native charger untouched.
      await beforeWrite(before);
      if (!temporalGuard()) throw failure('start-passed', 'The delayed start expired before dispatch.');
      if (!canControl() || !canMutate()) throw failure('control-revoked', 'Charging control authority changed.');
      try {
        await request(`${base}/delayed`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true, ...delayed }), signal, controlGuard: temporalGuard }, true);
      } catch (error) {
        if (!canControl() || !canMutate()) throw failure('control-revoked', 'Charging control authority changed.');
        if ([401, 403].includes(error?.status ?? error?.response?.status)) throw failure('access-denied', 'Easee rejected charging authorization.');
        throw failure('command-failed', 'Easee did not confirm accepting the schedule command.');
      }
      try { return await adapter.read({ signal, forceRest: true }); }
      catch { throw failure('readback-failed', 'The new Easee schedule could not be read back.'); }
    },
    async clear({ kind = 'delayed', expectedFingerprint, expectedControlFingerprint, signal, canMutate = () => true } = {}) {
      if (!['delayed', 'daily', 'weekly'].includes(kind)) throw new Error('This Easee schedule requires manual release in the Easee app');
      const before = await adapter.read({ signal, forceRest: true });
      if (before.fingerprint !== expectedFingerprint || before.schedule.enabled !== kind
        || expectedControlFingerprint && before.controlFingerprint !== expectedControlFingerprint)
        throw failure('state-changed', 'Easee changed before schedule handover.');
      if (!canControl() || !canMutate()) throw failure('control-revoked', 'Charging control authority changed.');
      try { await request(`${base}/${kind}/disable`, { method: 'POST', signal, controlGuard: canMutate }, true); }
      catch (error) {
        if (!canControl() || !canMutate()) throw failure('control-revoked', 'Charging control authority changed.');
        if ([401, 403].includes(error?.status ?? error?.response?.status)) throw failure('access-denied', 'Easee rejected charging authorization.');
        throw failure('command-failed', 'Easee did not confirm accepting schedule handover.');
      }
      try { return await adapter.read({ signal, forceRest: true }); }
      catch { throw failure('readback-failed', 'Easee schedule handover could not be read back.'); }
    },
  };
  return adapter;
}
