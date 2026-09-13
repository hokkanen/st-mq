import { INDOOR_ATTENTION_MS, SENSOR_SETTLING_MS, TEMPERATURE_SENSORS } from '../src/domain/indoor-sensors.js';
import { outdoorMaxAgeMs } from '../src/domain/reading-freshness.js';
import { durationText, qualityReasonText } from './reading-status.js';

const finite = Number.isFinite;
const codes = values => Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
const unique = values => [...new Set(values.filter(Boolean))];
const knownSensor = sensor => Object.hasOwn(TEMPERATURE_SENSORS, sensor?.signal);
const validTime = at => finite(at) && Math.abs(at) <= 8640000000000000;
const timeKnown = (at, now) => validTime(at) && at <= now;
const age = (at, now) => timeKnown(at, now) ? `${durationText(now - at)} old` : 'age unknown';
const ageLimit = reading => finite(reading?.maxAgeMs) && reading.maxAgeMs > 0
  ? Math.min(reading.maxAgeMs, outdoorMaxAgeMs(reading.source)) : outdoorMaxAgeMs(reading?.source);

function reportDetail(reading, { now, formatTime }) {
  const reportAt = reading.lastReportAt;
  const deadline = reading.reportExpiresAt;
  const maximum = reading.reportMaxAgeMs;
  const parts = [timeKnown(reportAt, now)
    ? `last report ${formatTime(reportAt)} (${age(reportAt, now)})` : 'last report time unavailable'];
  if (finite(maximum) && maximum > 0) {
    const policy = finite(reading.reportIntervalMs) && finite(reading.reportGraceMs)
      ? ` (${durationText(reading.reportIntervalMs)} interval + ${durationText(reading.reportGraceMs)} grace)` : '';
    parts.push(`limit ${durationText(maximum)}${policy}`);
  }
  if (validTime(deadline)) parts.push(`deadline ${formatTime(deadline)}${now > deadline ? `, overdue by ${durationText(now - deadline)}` : ''}`);
  return `Expected temperature report missing: ${parts.join('; ')}.`;
}

function reasonDetails(reading, options) {
  const { now, formatTime, outdoor = false } = options;
  const reasons = unique([...codes(reading?.availabilityReasons), ...codes(reading?.attentionReasons)]);
  const details = [];
  if (reasons.includes('missing-report') || reading?.periodicReports && finite(reading.reportExpiresAt) && now > reading.reportExpiresAt)
    details.push(reportDetail(reading, options));
  if (reading?.settling || reasons.includes('sensor-settling')) details.push(`Settling after sensor change${finite(reading.settlingUntil)
    ? ` until ${formatTime(reading.settlingUntil)} (${durationText(Math.max(0, reading.settlingUntil - now))} remaining; settling period ${durationText(SENSOR_SETTLING_MS)})`
    : `; settling period ${durationText(SENSOR_SETTLING_MS)}`}.`);
  if (outdoor && timeKnown(reading?.observedAt, now) && now - reading.observedAt > ageLimit(reading)) {
    const clock = reading.sourceTimeBasis === 'received-at' ? 'receipt' : 'reading';
    details.push(`Out of date: latest ${clock} ${formatTime(reading.observedAt)} is ${age(reading.observedAt, now)}; limit ${durationText(ageLimit(reading))}.`);
  }
  for (const code of reasons) {
    if (['missing-report', 'sensor-settling', 'out-of-date', 'missing-member', 'old-reading', 'invalid-reading'].includes(code)) continue;
    const text = qualityReasonText(code);
    if (text) details.push(`${text[0].toUpperCase()}${text.slice(1)}.`);
  }
  if (reasons.includes('invalid-reading')) {
    const why = unique(codes(reading.lastAttemptReasons).map(qualityReasonText));
    details.push(`Latest publication${validTime(reading.lastAttemptAt) ? ` ${formatTime(reading.lastAttemptAt)}` : ''} was invalid: ${why.join('; ') || 'source validation failed; no more specific reason was recorded'}.`);
  }
  return unique(details);
}

/** Historical callers supply the saved window time, never today's sensor age. */
export function temperatureAttentionDetails(sensors, formatTime, { now } = {}) {
  if (!Array.isArray(sensors)) return '';
  return sensors.filter(sensor => knownSensor(sensor) && finite(sensor.observedAt)).map(sensor => {
    const reasons = unique(codes(sensor.reasons ?? sensor.attentionReasons).map(reason => reason === 'old-reading'
      ? `over 2 hours old${finite(now) ? `; age ${durationText(Math.max(0, now - sensor.observedAt))}; attention threshold ${durationText(INDOOR_ATTENTION_MS)}` : ''}`
      : reason === 'disconnected' ? 'sensor disconnected' : reason === 'invalid-reading'
        ? `latest publication was invalid: ${unique(codes(sensor.lastAttemptReasons).map(qualityReasonText)).join('; ') || 'no more specific reason was recorded'}`
        : qualityReasonText(reason)));
    return `${TEMPERATURE_SENSORS[sensor.signal]} observed ${formatTime(sensor.observedAt)}${reasons.length ? ` (${reasons.join(', ')})` : ''}`;
  }).join('; ');
}

export function temperatureReadingStatus(reading, { now, formatTime, outdoor = false, member = false }) {
  const options = { now, formatTime, outdoor };
  if (reading?.configured === false) return { usable: false, attention: false, detail: 'Not configured' };
  const members = !member && Array.isArray(reading?.missingMembers) ? reading.missingMembers.filter(knownSensor) : [];
  const expired = outdoor && timeKnown(reading?.observedAt, now) && now - reading.observedAt > ageLimit(reading);
  const reportExpired = reading?.periodicReports && finite(reading.reportExpiresAt) && now > reading.reportExpiresAt;
  const usable = finite(reading?.value) && reading.stale !== true && timeKnown(reading.observedAt, now)
    && !expired && !reportExpired && !reading.settling && !members.length;
  const reasons = codes(reading?.attentionReasons);
  const old = usable && !outdoor && !reading.periodicReports && now - reading.observedAt > INDOOR_ATTENTION_MS;
  const actionable = codes(reading?.availabilityReasons).some(code => !['missing-reading', 'unknown-source-time', 'unknown-receipt-time', 'missing-member'].includes(code)
    && (qualityReasonText(code) || code === 'out-of-date'));
  const attention = reading?.needsAttention === true || reasons.some(reason => qualityReasonText(reason) || reason === 'old-reading')
    || old || reportExpired || expired || Boolean(reading?.settling) || Boolean(actionable);
  if (!usable) {
    let details = reasonDetails(reading, options);
    for (const sensor of members) {
      const projected = { ...sensor, availabilityReasons: sensor.availabilityReasons ?? sensor.reasons, stale: true };
      details.push(`${TEMPERATURE_SENSORS[sensor.signal]}: ${temperatureReadingStatus(projected, { ...options, outdoor: false, member: true }).detail}`);
    }
    if (!details.length) {
      const quality = unique(codes(reading?.quality).map(qualityReasonText));
      if (quality.length) details = quality.map(text => `${text[0].toUpperCase()}${text.slice(1)}.`);
      else if (!finite(reading?.value)) details = ['No current reading received: no valid numeric temperature is available.'];
      else if (!validTime(reading.observedAt)) details = ['The measurement time is missing or invalid.'];
      else if (reading.observedAt > now) details = [`The measurement time ${formatTime(reading.observedAt)} is ${durationText(reading.observedAt - now)} in the future.`];
      else details = ['The source marked this reading unavailable; no detailed reason was recorded.'];
    }
    return { usable, attention, detail: `Unavailable · ${details.join(' ')}` };
  }
  if (attention || reading.held) {
    const sensors = temperatureAttentionDetails(reading.attentionSensors, formatTime, { now });
    const warnings = reasonDetails(reading, options);
    if (old || reasons.includes('old-reading')) warnings.unshift(`over 2 hours old; age ${durationText(now - reading.observedAt)}; attention threshold ${durationText(INDOOR_ATTENTION_MS)}`);
    if (reasons.includes('disconnected')) warnings.unshift('sensor disconnected');
    return { usable, attention, detail: `${attention ? 'Needs attention · ' : ''}${sensors
      ? `Using last known readings: ${sensors}.`
      : `Using last known reading from ${formatTime(reading.observedAt)}${warnings.length ? ` (${warnings.join('; ')})` : ''}.`}` };
  }
  return { usable, attention, detail: reading.periodicReports && finite(reading.reportExpiresAt)
    ? `Temperature reports current; next deadline ${formatTime(reading.reportExpiresAt)}${finite(reading.reportMaxAgeMs) ? ` (report limit ${durationText(reading.reportMaxAgeMs)})` : ''}.`
    : `${reading.source === 'openmeteo' ? 'Valid at' : reading.sourceTimeBasis === 'received-at' ? 'Received' : 'Observed'} ${formatTime(reading.observedAt)}` };
}
