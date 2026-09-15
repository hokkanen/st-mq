import moment from 'moment-timezone';
import { DEFAULT_CHARGING_SETTINGS, resolveChargingDeadline } from './settings.js';

const validSoc = value => Number.isFinite(value) && value >= 0 && value <= 100;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

/** Require an explicit timezone for text timestamps. null means clock unknown,
 * never receipt time disguised as measurement time. */
export function socMeasurementTime(value) {
  if (value === null || value === undefined) return null;
  if (Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return NaN;
  const parsed = moment.parseZone(value, moment.ISO_8601, true);
  return parsed.isValid() ? parsed.valueOf() : NaN;
}

/** Pure duplicate-safe MQTT ingestion. Caller persists reading only if accepted. */
export function acceptSocReading(previous, payload, {
  now = Date.now(), vehicleId = DEFAULT_CHARGING_SETTINGS.vehicleId, sourceId = DEFAULT_CHARGING_SETTINGS.sourceId,
} = {}) {
  const reject = reason => ({ accepted: false, reading: previous ?? null, reason });
  let value;
  try { value = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload; }
  catch { return reject('malformed-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid-payload');
  if (!validSoc(value.soc)) return reject('invalid-soc');
  if (value.vehicleId !== vehicleId || value.sourceId !== sourceId) return reject('identity-mismatch');
  if (!identity(value.readingId)) return reject('missing-reading-id');
  const measuredAt = socMeasurementTime(value.measuredAt);
  if (Number.isNaN(measuredAt) || measuredAt > now + 5 * 60_000) return reject('invalid-measurement-time');
  const sequence = value.sequence == null ? null : value.sequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) return reject('invalid-sequence');
  const sameIdentity = previous?.vehicleId === vehicleId && previous?.sourceId === sourceId;
  if (sameIdentity) {
    if (previous.readingId === value.readingId) return reject('duplicate-reading');
    if (Number.isFinite(previous.measuredAt) && Number.isFinite(measuredAt)) {
      if (measuredAt < previous.measuredAt) return reject('older-reading');
      if (measuredAt === previous.measuredAt && !(sequence !== null && Number.isSafeInteger(previous.sequence) && sequence > previous.sequence)) return reject('unordered-reading');
    } else if (Number.isSafeInteger(previous.sequence) && sequence !== null) {
      if (sequence <= previous.sequence) return reject('older-reading');
    } else if (Number.isFinite(previous.measuredAt) && !Number.isFinite(measuredAt)) return reject('unordered-reading');
  }
  return { accepted: true, reason: null, reading: { vehicleId, sourceId, readingId: value.readingId,
    soc: value.soc, measuredAt, receivedAt: now, sequence } };
}

export function createManualSoc(soc, { now = Date.now(), readyBy, timezone } = {}) {
  if (!validSoc(soc)) throw new Error('Manual state of charge must be between 0 and 100%');
  return { soc, enteredAt: now, expiresAt: resolveChargingDeadline(now, readyBy, timezone) };
}

/** Source selection never alters a charger command or the stored observations. */
export function effectiveSoc({ automatic = null, manual = null, now = Date.now() } = {}) {
  if (validSoc(manual?.soc) && Number.isFinite(manual.enteredAt) && Number.isFinite(manual.expiresAt) && manual.enteredAt <= now && now < manual.expiresAt) {
    return { soc: manual.soc, source: 'manual', assumed: false, measuredAt: null,
      enteredAt: manual.enteredAt, expiresAt: manual.expiresAt };
  }
  if (validSoc(automatic?.soc)) return { soc: automatic.soc, source: 'mqtt', assumed: false,
    measuredAt: automatic.measuredAt ?? null, enteredAt: null, expiresAt: null,
    readingId: automatic.readingId, vehicleId: automatic.vehicleId, sourceId: automatic.sourceId };
  return { soc: 0, source: 'assumed', assumed: true, measuredAt: null, enteredAt: null, expiresAt: null };
}
