import moment from 'moment-timezone';

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
  now = Date.now(), association = 'vehicle-mqtt', vehicleId, sourceId,
} = {}) {
  const reject = reason => ({ accepted: false, reading: previous ?? null, reason });
  let value;
  try { value = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload; }
  catch { return reject('malformed-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid-payload');
  if (!validSoc(value.soc)) return reject('invalid-soc');
  if (value.usableCapacityKwh !== undefined && (!Number.isFinite(value.usableCapacityKwh)
    || value.usableCapacityKwh < 1 || value.usableCapacityKwh > 300)) return reject('invalid-capacity');
  if (value.chargeLimitSoc !== undefined && !validSoc(value.chargeLimitSoc)) return reject('invalid-charge-limit');
  if (vehicleId !== undefined && value.vehicleId !== vehicleId || sourceId !== undefined && value.sourceId !== sourceId) return reject('identity-mismatch');
  if (!identity(value.readingId)) return reject('missing-reading-id');
  const measuredAt = socMeasurementTime(value.measuredAt);
  if (Number.isNaN(measuredAt) || measuredAt > now + 5 * 60_000) return reject('invalid-measurement-time');
  const sequence = value.sequence == null ? null : value.sequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) return reject('invalid-sequence');
  const sameIdentity = previous?.association === association
    && (vehicleId === undefined || previous?.vehicleId === vehicleId) && (sourceId === undefined || previous?.sourceId === sourceId);
  if (sameIdentity) {
    if (previous.readingId === value.readingId) return reject('duplicate-reading');
    if (Number.isFinite(previous.measuredAt) && Number.isFinite(measuredAt)) {
      if (measuredAt < previous.measuredAt) return reject('older-reading');
      if (measuredAt === previous.measuredAt && !(sequence !== null && Number.isSafeInteger(previous.sequence) && sequence > previous.sequence)) return reject('unordered-reading');
    } else if (Number.isSafeInteger(previous.sequence) && sequence !== null) {
      if (sequence <= previous.sequence) return reject('older-reading');
    } else if (Number.isFinite(previous.measuredAt) && !Number.isFinite(measuredAt)) return reject('unordered-reading');
  }
  const optional = {}, fields = {};
  for (const key of ['usableCapacityKwh', 'chargeLimitSoc']) {
    if (value[key] !== undefined) {
      optional[key] = value[key]; fields[key] = { measuredAt, receivedAt: now, readingId: value.readingId };
    } else if (sameIdentity && Number.isFinite(previous[key])) {
      // Configuration-like vehicle facts may be published less frequently than
      // SoC. Retain their own clocks instead of making them look freshly read.
      optional[key] = previous[key]; fields[key] = previous.fields?.[key]
        ?? { measuredAt: previous.measuredAt ?? null, receivedAt: previous.receivedAt ?? null, readingId: previous.readingId };
    }
  }
  return { accepted: true, reason: null, reading: { association, ...(vehicleId !== undefined ? { vehicleId } : {}), ...(sourceId !== undefined ? { sourceId } : {}), readingId: value.readingId,
    soc: value.soc, measuredAt, receivedAt: now, sequence, ...optional,
    ...(Object.keys(fields).length ? { fields } : {}) } };
}

/** Automatic battery telemetry always wins over the remembered manual fallback. */
export function effectiveSoc({ automatic = null, fallbackSoc = 40 } = {}) {
  if (validSoc(automatic?.soc)) return { soc: automatic.soc, source: automatic.source ?? 'mqtt', assumed: false,
    measuredAt: automatic.measuredAt ?? null, receivedAt: automatic.receivedAt ?? null,
    readingId: automatic.readingId };
  return { soc: validSoc(fallbackSoc) ? fallbackSoc : 40, source: 'manual-fallback', assumed: true,
    measuredAt: null, receivedAt: null };
}
