import moment from 'moment-timezone';
import { MAX_SOURCE_AHEAD_MS, sourceTimeAdmission } from '../domain/time-evidence.js';

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
  now = Date.now(), receivedAt = now, deferred = false, association = 'vehicle-mqtt', vehicleId, sourceId,
} = {}) {
  const reject = reason => ({ accepted: false, reading: previous ?? null, reason });
  let value;
  try { value = typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload; }
  catch { return reject('malformed-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid-payload');
  if (value.provider !== undefined && value.provider !== 'bmw-cardata') return reject('invalid-provider');
  if (!validSoc(value.soc)) return reject('invalid-soc');
  if (value.usableCapacityKwh !== undefined && (!Number.isFinite(value.usableCapacityKwh)
    || value.usableCapacityKwh < 1 || value.usableCapacityKwh > 300)) return reject('invalid-capacity');
  if (value.chargeLimitSoc !== undefined && !validSoc(value.chargeLimitSoc)) return reject('invalid-charge-limit');
  if (vehicleId !== undefined && value.vehicleId !== vehicleId || sourceId !== undefined && value.sourceId !== sourceId) return reject('identity-mismatch');
  if (!identity(value.readingId)) return reject('missing-reading-id');
  const measuredAt = socMeasurementTime(value.measuredAt);
  if (Number.isNaN(measuredAt) || measuredAt > receivedAt + MAX_SOURCE_AHEAD_MS) return reject('invalid-measurement-time');
  const sequence = value.sequence == null ? null : value.sequence;
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) return reject('invalid-sequence');
  const sameIdentity = previous?.association === association
    && (vehicleId === undefined || previous?.vehicleId === vehicleId) && (sourceId === undefined || previous?.sourceId === sourceId);
  let socRejection = null;
  if (sameIdentity) {
    if (previous.readingId === value.readingId) socRejection = 'duplicate-reading';
    else if (Number.isFinite(previous.measuredAt) && Number.isFinite(measuredAt)) {
      if (measuredAt < previous.measuredAt) socRejection = 'older-reading';
      if (measuredAt === previous.measuredAt && !(sequence !== null && Number.isSafeInteger(previous.sequence) && sequence > previous.sequence)) socRejection = 'unordered-reading';
    } else if (Number.isSafeInteger(previous.sequence) && sequence !== null) {
      if (sequence <= previous.sequence) socRejection = 'older-reading';
    } else if (Number.isFinite(previous.measuredAt) && !Number.isFinite(measuredAt)) socRejection = 'unordered-reading';
  }
  const optional = {}, fields = {};
  let independentUpdate = false;
  for (const key of ['usableCapacityKwh', 'chargeLimitSoc']) {
    const supplied = value.fields?.[key];
    const fieldTime = supplied === undefined ? measuredAt : socMeasurementTime(supplied?.measuredAt);
    const fieldId = supplied === undefined ? value.readingId : supplied?.readingId;
    if (supplied !== undefined && (value[key] === undefined || !identity(fieldId)
      || Number.isNaN(fieldTime) || fieldTime > receivedAt + MAX_SOURCE_AHEAD_MS)) return reject('invalid-field-metadata');
    const prior = sameIdentity && Number.isFinite(previous[key]) ? previous.fields?.[key]
      ?? { measuredAt: previous.measuredAt ?? null, receivedAt: previous.receivedAt ?? null, readingId: previous.readingId } : null;
    // CarData reports charge target/capacity independently of battery percentage.
    // Accept new facts without rebasing SoC or refreshing older field clocks.
    const sharesOrderedSoc = supplied === undefined && !socRejection;
    const newer = !prior || (fieldId !== prior.readingId && (Number.isFinite(prior.measuredAt)
      ? Number.isFinite(fieldTime) && (fieldTime > prior.measuredAt
        || sharesOrderedSoc && fieldTime === prior.measuredAt) : true));
    if (value[key] !== undefined && newer && (!socRejection || supplied !== undefined)) {
      optional[key] = value[key]; fields[key] = { measuredAt: fieldTime, receivedAt, readingId: fieldId,
        ...(sourceTimeAdmission({ sourceTime: fieldTime, receivedAt, now, deferred }) ? { admittedAt: now } : {}) };
      independentUpdate ||= supplied !== undefined;
    } else if (prior) {
      // Configuration-like vehicle facts may be published less frequently than
      // SoC. Retain their own clocks instead of making them look freshly read.
      optional[key] = previous[key]; fields[key] = prior;
    }
  }
  // A publisher upgrade may identify an already saved reading. Its provider is
  // metadata, not a new measurement; older or conflicting replays cannot add it.
  const exactDuplicate = socRejection === 'duplicate-reading' && value.soc === previous.soc
    && measuredAt === previous.measuredAt && sequence === previous.sequence;
  const provider = value.provider !== undefined && (!socRejection || exactDuplicate)
    ? value.provider : socRejection && sameIdentity ? previous.provider : undefined;
  const provenance = provider === 'bmw-cardata' ? { provider } : {};
  const providerUpdate = exactDuplicate && provider !== previous.provider;
  if (socRejection) return independentUpdate || providerUpdate
    ? { accepted: true, reason: null, reading: { ...previous, ...optional, fields, ...provenance } } : reject(socRejection);
  return { accepted: true, reason: null, reading: { association, ...(vehicleId !== undefined ? { vehicleId } : {}), ...(sourceId !== undefined ? { sourceId } : {}), readingId: value.readingId,
    soc: value.soc, measuredAt, receivedAt, sequence, ...optional, ...provenance,
    ...(sourceTimeAdmission({ sourceTime: measuredAt, receivedAt, now, deferred }) ? { admittedAt: now } : {}),
    ...(Object.keys(fields).length ? { fields } : {}) } };
}

/** Automatic battery telemetry always wins over the remembered manual fallback. */
export function effectiveSoc({ automatic = null, fallbackSoc = 20 } = {}) {
  if (validSoc(automatic?.soc)) return { soc: automatic.soc, source: automatic.source ?? 'mqtt', assumed: false,
    measuredAt: automatic.measuredAt ?? null, receivedAt: automatic.receivedAt ?? null,
    readingId: automatic.readingId };
  return { soc: validSoc(fallbackSoc) ? fallbackSoc : 20, source: 'manual-fallback', assumed: true,
    measuredAt: null, receivedAt: null };
}
