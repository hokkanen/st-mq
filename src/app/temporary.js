import moment from 'moment-timezone';

const ZONE = 'Europe/Helsinki';
const DAY = 86_400_000;

/** Resolve a house-local picker value without silently shifting a DST gap or overlap. */
export function finnishLocalInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Use a Finnish date and time (YYYY-MM-DDTHH:mm)');
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== value) throw new Error('Invalid Finnish date and time');
  const zone = moment.tz.zone(ZONE);
  const offsets = new Set([-2, 0, 2].map(days => zone.utcOffset(wall + days * DAY)));
  const candidates = [...offsets].map(offset => wall + offset * 60_000)
    .filter(at => moment.tz(at, ZONE).format('YYYY-MM-DDTHH:mm') === value);
  if (!candidates.length) throw new Error('This Finnish time does not exist because the clocks move forward. Choose another time.');
  if (candidates.length !== 1) throw new Error('This Finnish time occurs twice when the clocks move back. Choose a time outside the repeated hour, or use an explicit UTC offset through the API.');
  return candidates[0];
}

function deadline(value, local, now) {
  if (value === null) return null;
  let at;
  if (local) at = finnishLocalInstant(value);
  else {
    if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Deadline must include a UTC offset');
    const parsed = moment.parseZone(value, moment.ISO_8601, true);
    if (!parsed.isValid()) throw new Error('Invalid deadline');
    at = parsed.valueOf();
  }
  if (at <= now || at > now + 366 * DAY) throw new Error('Choose a future time within the next 366 days');
  return at;
}

/** Validate the entire edit before either control is persisted. A null pause
 * deadline keeps Pause selected without a scheduled Automatic restart. */
export function temporaryUpdate(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Temporary controls require a JSON object');
  const allowed = ['awayUntil', 'pauseUntil', 'awayUntilLocal', 'pauseUntilLocal'];
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !allowed.includes(key))) throw new Error('Choose Away until or Pause until');
  const result = {};
  for (const name of ['awayUntil', 'pauseUntil']) {
    const local = `${name}Local`;
    if (Object.hasOwn(input, name) && Object.hasOwn(input, local)) throw new Error(`Supply only one form of ${name}`);
    if (Object.hasOwn(input, local)) result[name] = deadline(input[local], true, now);
    else if (Object.hasOwn(input, name)) result[name] = deadline(input[name], false, now);
  }
  return result;
}
