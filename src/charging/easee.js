import { createHash } from 'node:crypto';
import moment from 'moment-timezone';

// Public Easee /schedules OpenAPI checked 2026-09-15. Delayed startTime is
// a LOCAL TIME, not a date-time. The controller retains the absolute occurrence.
const TYPES = ['delayed', 'daily', 'weekly', 'offPeak', 'tariff'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const CHARGING_OBSERVATION_IDS = [22, 23, 24, 31, 47, 48, 96, 100, 104, 109, 111, 112, 113, 120, 230, 231, 232, 250];
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

export function chargingSnapshot(observations, scheduling, now, allocationA = null) {
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

/** Inject existing authenticated/rate-limited transport; raw account data stays local. */
export function createEaseeScheduleAdapter({ request, chargerId, equalizerId, clock = Date.now, canControl = () => false }) {
  const base = `https://api.easee.com/api/chargers/${encodeURIComponent(chargerId)}/schedules`;
  let allocationA = null, allocationReadAt = -Infinity;
  const adapter = {
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
      return chargingSnapshot(observations, scheduling, now, allocationA);
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
