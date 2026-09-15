import { createHash } from 'node:crypto';
import moment from 'moment-timezone';

// Public Easee /schedules OpenAPI checked 2026-09-15. Delayed startTime is
// a LOCAL TIME, not a date-time. The controller retains the absolute occurrence.
const TYPES = ['delayed', 'daily', 'weekly', 'offPeak', 'tariff'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const CHARGING_OBSERVATION_IDS = [22, 23, 24, 31, 47, 48, 96, 100, 104, 109, 110, 111, 112, 113, 120, 230, 231, 232, 250];
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
  if (!Number.isSafeInteger(startAt) || !zone(timezone) || !Number.isInteger(maximumAmps) || maximumAmps < 6 || maximumAmps > 80)
    throw new Error('A valid start, timezone and charger current limit are required');
  const startTime = moment.tz(startAt, timezone).format('HH:mm:ss');
  const next = nextLocalOccurrence(startTime, timezone, now);
  if (next === null || next !== startAt) throw new Error('Easee delayed start cannot represent this absolute start time');
  // Easee does not specify which occurrence of an autumn repeated clock time
  // it chooses. Do not install a plan whose release could differ by an hour.
  if (ambiguousWallTime(startAt, timezone))
    throw new Error('Easee delayed start is ambiguous during the daylight-saving transition');
  return { timezone, startTime, maximumAmps };
}

/** A simple app recurrence is yielded for its current/next concrete occurrence. */
export function manualScheduleWindow(state, now) {
  const kind = state.enabled, schedule = state[kind];
  if (!['daily', 'weekly'].includes(kind) || schedule?.periods?.length !== 1) return null;
  const period = schedule.periods[0], local = moment.tz(now, schedule.timezone).startOf('day');
  const candidates = [];
  for (let offset = -7; offset <= 7; offset++) {
    const day = local.clone().add(offset, 'days');
    if (kind === 'weekly' && DAYS[day.day()] !== period.startDay) continue;
    const start = wallTime(day.format('YYYY-MM-DD'), period.startTime, schedule.timezone);
    let days = kind === 'weekly' ? (DAYS.indexOf(period.stopDay) - DAYS.indexOf(period.startDay) + 7) % 7 : 0;
    if (days === 0 && period.stopTime <= period.startTime) days = kind === 'weekly' ? 7 : 1;
    const end = wallTime(day.clone().add(days, 'days').format('YYYY-MM-DD'), period.stopTime, schedule.timezone);
    if (start !== null && end !== null && end > now && end > start) candidates.push({ startsAt: start, resumeAt: end,
      ambiguous: ambiguousWallTime(start, schedule.timezone) || ambiguousWallTime(end, schedule.timezone) });
  }
  candidates.sort((a, b) => a.startsAt - b.startsAt);
  if (!candidates.length || candidates[0].ambiguous) return null;
  const { startsAt, resumeAt } = candidates[0];
  return { kind: 'window', repeating: true, startsAt, resumeAt };
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

export function chargingSnapshot(observations, scheduling, now, allocationA = null, { externalLoadBalancing = true } = {}) {
  const list = Array.isArray(observations) ? observations : observations?.observations;
  if (!Array.isArray(list) || list.length > 1000) throw new Error('Easee charger state is not understood');
  const pick = id => {
    const entries = list.filter(row => Number(row?.id) === id).map(row => ({ value: row.value, at: instant(row.timestamp) }))
      .filter(row => row.at !== null && row.at <= now).sort((a, b) => b.at - a.at);
    const row = entries[0];
    return !row || entries.some(other => other.at === row.at && String(other.value) !== String(row.value)) ? { value: null, at: null } : row;
  };
  const bool = id => { const value = pick(id).value; return [true, 1, 'true', '1'].includes(value) ? true : [false, 0, 'false', '0'].includes(value) ? false : null; };
  const scheduleState = normalizeScheduleState(scheduling), mode = numeric(pick(109).value), reason = numeric(pick(96).value);
  const pilot = pick(100).value, online = bool(250), enabled = bool(31);
  const pluggedIn = mode === 1 || pilot === 'A' ? false : [2, 3, 4, 6, 7, 8].includes(mode) || ['B', 'C', 'D'].includes(pilot) ? true : null;
  const result = { schedule: scheduleState, fingerprint: scheduleFingerprint(scheduleState), readAt: now,
    online, enabled, pluggedIn, mode, reason, powerKw: numeric(pick(120).value),
    externalLoadBalancing, outputPhase: numeric(pick(110).value),
    observations: Object.fromEntries(CHARGING_OBSERVATION_IDS.map(id => [id, pick(id)])),
    modeAt: pick(109).at, reasonAt: pick(96).at, powerAt: pick(120).at,
    limits: { circuitA: [22, 23, 24].map(id => amps(pick(id).value)), chargerA: amps(pick(47).value),
      cableA: amps(pick(104).value), dynamicChargerA: amps(pick(48).value),
      dynamicCircuitA: [111, 112, 113].map(id => amps(pick(id).value)),
      equalizerAvailableA: [230, 231, 232].map(id => amps(pick(id).value)),
      mainFuseA: null, allocationA, equalizerAvailableAt: [230, 231, 232].map(id => pick(id).at) } };
  result.controlFingerprint = hash([enabled, mode, reason, pluggedIn, result.limits.dynamicChargerA]);
  result.manualStop = enabled === false || [53, 55].includes(reason) || [7, 8].includes(mode)
    || result.limits.dynamicChargerA === 0 && reason === 52;
  result.controlKnown = online === true && enabled !== null && mode !== null && reason !== null && pluggedIn !== null;
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
    return { value: available && value !== undefined ? value : null, source,
      available: available && value !== undefined && value !== null,
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
  const fixedCeilings = [limits.chargerA, limits.cableA].filter(value => amps(value) !== null);
  const maxCurrentA = fixedCeilings.length ? Math.min(...fixedCeilings) : null;
  const currentIds = [22, 23, 24, 47, 48, 104, 111, 112, 113, ...(externalLoadBalancing ? [230, 231, 232] : [])];
  const phases = [10, 11, 12, 13, 14, 15].includes(snapshot.outputPhase) ? 1
    : [20, 21, 22].includes(snapshot.outputPhase) ? 2 : snapshot.outputPhase === 30 ? 3 : null;
  const schedule = nextScheduleOccurrence(snapshot.schedule, now);
  return { ...snapshot, provider: 'easee', providerConnected: available,
    capabilities: { scheduling: true, currentControl: false, externalLoadBalancing,
      automatic: { capacityKwh: false, soc: false, minimumSoc: false, connected: true, currentA: true, schedule: true } },
    capacityKwh: signal(null), soc: signal(null), minimumSoc: signal(null),
    connected: signal(snapshot.pluggedIn, [100, 109]),
    currentA: signal(currentA, currentIds, externalLoadBalancing ? 'easee-equalizer' : 'easee'),
    maxCurrentA: signal(maxCurrentA, [47, 104]),
    actualCurrentA: signal(null), phases: signal(phases, [110]), voltageV: signal(null),
    charging: signal(snapshot.mode === null || snapshot.mode === undefined ? null : snapshot.mode === 3, [109]),
    powerKw: signal(snapshot.powerKw, [120]),
    scheduledStartAt: signal(schedule.startAt, [], 'easee-schedule'),
    scheduledEndAt: signal(schedule.endAt, [], 'easee-schedule'), scheduledEndKind: schedule.endKind,
    scheduleKind: schedule.kind };
}

/** Inject existing authenticated/rate-limited transport; raw account data stays local. */
export function createEaseeScheduleAdapter({ request, chargerId, equalizerId, clock = Date.now, canControl = () => false }) {
  const base = `https://api.easee.com/api/chargers/${encodeURIComponent(chargerId)}/schedules`;
  let allocationA = null, allocationReadAt = -Infinity;
  const adapter = {
    normalize(snapshot, options = {}) { return easeeChargerTelemetry(snapshot, { now: clock(), ...options }); },
    async read({ signal } = {}) {
      if (!chargerId) throw new Error('Charger 1 Easee connection is not configured');
      const now = clock();
      const [scheduling, observations] = await Promise.all([
        request(base, { method: 'GET', signal }),
        request(`https://api.easee.com/state/${encodeURIComponent(chargerId)}/observations?ids=${CHARGING_OBSERVATION_IDS.join(',')}`, { method: 'GET', signal }),
      ]);
      if (equalizerId && now - allocationReadAt >= 3600_000) {
        allocationReadAt = now;
        try { allocationA = amps((await request(`https://api.easee.com/api/equalizers/${encodeURIComponent(equalizerId)}/config`, { method: 'GET', signal }))?.maxAllocatedCurrent); }
        catch { allocationA = null; }
      }
      return chargingSnapshot(observations, scheduling, now, allocationA, { externalLoadBalancing: Boolean(equalizerId) });
    },
    async installDelayed({ startAt, timezone, maximumAmps, expectedFingerprint, expectedControlFingerprint, signal, canMutate = () => true } = {}) {
      const before = await adapter.read({ signal });
      if (before.fingerprint !== expectedFingerprint || expectedControlFingerprint && before.controlFingerprint !== expectedControlFingerprint)
        throw new Error('Easee state changed before the schedule write');
      if (!before.controlKnown || before.manualStop || before.mode === 3 || !canControl() || !canMutate())
        throw new Error('Easee schedule write is no longer authorized');
      const delayed = delayedScheduleFor({ startAt, timezone, maximumAmps }, clock());
      await request(`${base}/delayed`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, ...delayed }), signal, controlGuard: canMutate }, true);
      return adapter.read({ signal });
    },
    async clear({ kind = 'delayed', expectedFingerprint, expectedControlFingerprint, signal, canMutate = () => true } = {}) {
      if (!['delayed', 'daily', 'weekly'].includes(kind)) throw new Error('This Easee schedule requires manual release in the Easee app');
      const before = await adapter.read({ signal });
      if (before.fingerprint !== expectedFingerprint || before.schedule.enabled !== kind
        || expectedControlFingerprint && before.controlFingerprint !== expectedControlFingerprint)
        throw new Error('Easee state changed before the schedule handover');
      if (!canControl() || !canMutate()) throw new Error('Easee schedule handover is no longer authorized');
      await request(`${base}/${kind}/disable`, { method: 'POST', signal, controlGuard: canMutate }, true);
      return adapter.read({ signal });
    },
  };
  return adapter;
}
