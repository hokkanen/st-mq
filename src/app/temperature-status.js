import { HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS, SENSOR_SETTLING_MS } from '../domain/indoor-sensors.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { H66_MAX_AGE_MS, OUTDOOR_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { indoorReadingUsable } from './indoor-readings.js';
import { goodQuality } from '../control/learning.js';

const qualityReasons = Object.freeze({
  missing: 'missing-reading', invalid: 'invalid-value', 'invalid-value': 'invalid-value',
  'invalid-payload': 'invalid-value', invalid_numeric: 'invalid-value', invalid_unit: 'unsupported-unit',
  'unsupported-unit': 'unsupported-unit', source_time_unknown: 'unknown-source-time',
  'unknown-source-time': 'unknown-source-time', future_source_time: 'future-source-time',
  'future-source-time': 'future-source-time', retained: 'retained',
  'mqtt-disconnected': 'disconnected', 'subscription-failed': 'subscription-failed',
  'report-policy-changed': 'report-policy-changed', 'missing-report': 'missing-report',
  'out-of-order-source-time': 'out-of-order-source-time', 'unverified-scaling': 'unverified-h66',
  duplicate: 'duplicate', stale: 'out-of-date', disconnected: 'disconnected',
  implausible_temperature: 'out-of-range', 'mqtt-subscription-failed': 'subscription-failed',
  suspect_zero_indoor: 'out-of-range', conflicting_duplicate: 'conflicting-duplicate',
  provider_error: 'provider-error', 'acquisition-failed': 'provider-error',
});
const accepted = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit', 'corrected_price']);
const unique = reasons => [...new Set(reasons)];
const decode = row => row ? { id: row.id, source: row.source, device: row.device, signal: row.signal,
  value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
  quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null } : null;

/** Display diagnostics use fixed codes only. Never expose a provider's raw
 * payload, device identity or arbitrary quality/error strings in status text. */
export function temperatureFailureReasons(observation, now) {
  if (!observation) return ['missing-reading'];
  const reasons = [], held = HELD_TEMPERATURE_SIGNALS.includes(observation.signal);
  if (!Number.isFinite(observation.value)) reasons.push(observation.value == null ? 'missing-reading' : 'invalid-value');
  if (!Number.isFinite(observation.sourceTime)) reasons.push('unknown-source-time');
  else if (observation.sourceTime > now) reasons.push('future-source-time');
  if (held && !Number.isFinite(observation.receivedAt)) reasons.push('unknown-receipt-time');
  if (Number.isFinite(observation.receivedAt)) {
    if (observation.receivedAt > now) reasons.push('future-receipt-time');
    if (held && observation.sourceTime > observation.receivedAt) reasons.push('source-time-after-receipt');
  }
  if (held && !['degC', '°C'].includes(observation.unit)) reasons.push('unsupported-unit');
  if (observation.source === 'controller-estimate') reasons.push('controller-estimate');
  if (observation.raw?.auditOnly) reasons.push('audit-only');
  if (observation.raw?.retained) reasons.push('retained');
  for (const flag of observation.quality ?? []) {
    if (accepted.has(flag) && (!held || flag !== 'corrected_price') || held && flag === 'stale'
      || observation.source === 'openmeteo' && observation.signal === 'outdoor_temperature' && flag === 'estimated') continue;
    reasons.push(Object.hasOwn(qualityReasons, flag) ? qualityReasons[flag] : 'invalid-quality');
  }
  if (observation.raw?.timeBasis === 'availability-transition' && !reasons.some(reason =>
    ['disconnected', 'subscription-failed', 'report-policy-changed'].includes(reason))) reasons.push('availability-transition');
  if (observation.source?.startsWith('husdata') && observation.raw?.usableForControl !== true
    && !(held && observation.quality?.includes('stale') && observation.raw?.verification)
    && !reasons.length) reasons.push('unverified-h66');
  if (Number.isFinite(observation.value)) {
    const outside = observation.signal === 'garage_temperature' ? observation.value < -60 || observation.value > 70
      : held ? observation.value <= 2 || observation.value >= 40 : observation.value < -60 || observation.value > 50;
    if (outside) reasons.push('out-of-range');
  }
  return unique(reasons);
}

export function temperatureTimeMetadata(observation, now) {
  return { ageMs: Number.isFinite(observation?.sourceTime) ? Math.max(0, now - observation.sourceTime) : null,
    sourceTimeBasis: observation?.raw?.timeBasis === 'mqtt-received' ? 'received-at' : 'measurement' };
}

/** Metadata is separate from lastIndoorReading: learning's frozen v8 sample
 * and replay selection must not change when diagnostic fields are added. */
export function indoorStatusMetadata(reading, now, { latest = reading, store, knownAt = now, stale = false } = {}) {
  const maxAge = temperatureReportMaxAge(reading), metadata = temperatureTimeMetadata(reading, now);
  let lastReportAt = reading?.sourceTime ?? null, reportExpiresAt;
  if (store && reading) {
    const span = store.db.prepare(`SELECT source_time,end_at FROM recorder_coverage
      WHERE source=? AND device=? AND signal=? AND status='fresh' AND start_at<=?
      ORDER BY start_at DESC,id DESC LIMIT 1`).get(reading.source, reading.device, reading.signal, knownAt);
    if (span?.end_at > knownAt) {
      // A compact span proves availability at this earlier boundary, but its
      // later endpoint cannot reveal the actual last report known then.
      lastReportAt = null; reportExpiresAt = reading.reportExpiresAt ?? knownAt;
    } else if (span && span.source_time >= lastReportAt) lastReportAt = span.source_time;
    latest = decode(store.db.prepare(`SELECT * FROM observations WHERE source=? AND device=? AND signal=?
      AND received_at>=? AND received_at<=? AND COALESCE(json_extract(raw,'$.retained'),0)<>1
      AND NOT EXISTS(SELECT 1 FROM json_each(quality) WHERE value='retained')
      ORDER BY received_at DESC,id DESC LIMIT 1`)
      .get(reading.source, reading.device, reading.signal, reading.receivedAt, knownAt)) ?? latest;
  }
  if (maxAge === null) metadata.attentionAfterMs = INDOOR_ATTENTION_MS;
  else Object.assign(metadata, { reportMaxAgeMs: maxAge, reportIntervalMs: reading.raw.reportIntervalMs,
    reportGraceMs: reading.raw.reportGraceMs ?? 0, lastReportAt, reportExpiresAt: reportExpiresAt ?? lastReportAt + maxAge });
  const lastAttemptReasons = latest && !indoorReadingUsable(latest, now) ? temperatureFailureReasons(latest, now) : [];
  if (lastAttemptReasons.length && latest.receivedAt >= reading?.receivedAt) Object.assign(metadata,
    { lastAttemptAt: latest.receivedAt, lastAttemptReasons });
  metadata.availabilityReasons = stale ? unique([
    ...(!reading || !indoorReadingUsable(reading, now) ? temperatureFailureReasons(reading, now) : []),
    ...(maxAge !== null && now > metadata.reportExpiresAt ? ['missing-report'] : []),
    ...lastAttemptReasons,
  ]) : [];
  if (stale && !metadata.availabilityReasons.length) metadata.availabilityReasons.push(maxAge !== null ? 'missing-report' : 'missing-reading');
  if (latest?.quality?.includes('report-policy-changed') && temperatureReportMaxAge(latest) !== null) Object.assign(metadata,
    { periodicReports: true, stale: true, reportMaxAgeMs: temperatureReportMaxAge(latest),
      reportIntervalMs: latest.raw.reportIntervalMs, reportGraceMs: latest.raw.reportGraceMs ?? 0,
      lastReportAt: null, reportExpiresAt: null, availabilityReasons: ['report-policy-changed'] });
  return metadata;
}

export function outdoorReadingStatus(observation, now, { maxAgeMs, h66 } = {}) {
  maxAgeMs = observation?.source === 'husdata-h66' ? Math.min(H66_MAX_AGE_MS, maxAgeMs ?? H66_MAX_AGE_MS) : OUTDOOR_MAX_AGE_MS;
  const availabilityReasons = temperatureFailureReasons(observation, now);
  if (Number.isFinite(observation?.sourceTime) && now - observation.sourceTime > maxAgeMs) availabilityReasons.push('out-of-date');
  if (observation?.source === 'husdata-h66' && h66 && h66.readings?.['0007']?.available !== true) {
    if ((h66.brokerConnected ?? h66.connected) === false) availabilityReasons.push('disconnected');
    else if (h66.readings?.['0007']?.unavailableReasons?.includes('awaiting-live-report') || !availabilityReasons.length)
      availabilityReasons.push('awaiting-live-report');
  }
  return { value: observation?.value ?? null, observedAt: observation?.sourceTime ?? null,
    quality: observation?.quality ?? [], source: observation?.source ?? null,
    ...temperatureTimeMetadata(observation, now), maxAgeMs,
    stale: availabilityReasons.length > 0, availabilityReasons: unique(availabilityReasons) };
}

export function temperatureBoundaryStatus(reading, changedAt, now, { clearValue = false } = {}) {
  if (!Number.isFinite(changedAt)) return reading;
  const settlingUntil = changedAt + SENSOR_SETTLING_MS, settling = now < settlingUntil;
  const before = !Number.isFinite(reading?.observedAt) || reading.observedAt < changedAt;
  if (!settling && !before) return reading;
  return { ...reading, ...(clearValue ? { value: null } : {}), stale: true, settling, settlingUntil,
    measurementChangedAt: changedAt, availabilityReasons: unique([...(reading?.availabilityReasons ?? []),
      ...(settling ? ['sensor-settling'] : []), ...(before ? ['before-sensor-change'] : [])]) };
}

export function recordedTemperatureAttempt(store, signal, knownAt, input) {
  return decode(store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.signal=? AND o.received_at<=? AND (o.import_id IS NULL OR i.status='complete')
    AND ${input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'"}
    ORDER BY o.received_at DESC,o.id DESC LIMIT 1`).get(signal, knownAt));
}

const outdoorTrustworthy = (row, now) => Boolean(row && Number.isFinite(row.value)
  && Number.isFinite(row.sourceTime) && row.sourceTime <= now && row.value >= -60 && row.value <= 50
  && goodQuality((row.quality ?? []).filter(flag => !(row.source === 'openmeteo' && flag === 'estimated'))));
const transition = row => row?.value === null && row.raw?.timeBasis === 'availability-transition';

/** The primary and replica apply the same source update rules: retained packets
 * cannot replace live H66; failed downloads preserve a still-valid weather
 * reading; explicit source outages require a subsequent genuine measurement. */
export function rememberOutdoorReading(prior, observation, now) {
  if (!observation) return prior;
  const incomingValid = outdoorTrustworthy(observation, now), priorValid = outdoorTrustworthy(prior, now);
  const sameSource = prior?.source === observation.source && prior?.device === observation.device;
  const retained = observation.raw?.retained === true || observation.quality?.includes('retained');
  if (transition(observation)) return !retained && Number.isFinite(observation.receivedAt) && observation.receivedAt <= now
    && (!prior || sameSource && observation.receivedAt >= Math.max(prior.receivedAt ?? 0, priorValid ? prior.sourceTime : 0))
    ? observation : prior;
  if (sameSource && transition(prior) && (retained || observation.sourceTime < prior.receivedAt
    || (observation.receivedAt ?? 0) < prior.receivedAt)) return prior;
  let selected = !prior || incomingValid && (!priorValid || observation.sourceTime >= prior.sourceTime)
    || !priorValid && !incomingValid && (observation.receivedAt ?? 0) >= (prior.receivedAt ?? 0) ? observation : prior;
  if (observation.source === 'husdata-h66' && !retained && (observation.receivedAt ?? 0) >= (prior?.receivedAt ?? 0)
    && (!incomingValid || observation.raw?.usableForControl !== true)) selected = observation;
  return selected;
}

/** Use only evidence available in the published snapshot. Recorder coverage
 * can confirm a held outdoor value without inventing a new measurement. */
export function recordedOutdoorObservation(store, now, { knownAt = now, input } = {}) {
  if (!store) return outdoorReadingStatus(null, now);
  const sources = ['mqtt', 'providers'].includes(input) ? ['husdata-h66', 'fmi', 'openmeteo'] : null;
  const candidates = [];
  const scopes = sources ?? [input === 'simulated' ? 'simulation' : null];
  for (const source of scopes) {
    const scope = source ? 'AND o.source=?' : "AND o.source<>'simulation'";
    const since = knownAt - OUTDOOR_MAX_AGE_MS;
    const rows = store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
      WHERE o.signal='outdoor_temperature' AND o.received_at>=? AND o.received_at<=?
      AND (o.import_id IS NULL OR i.status='complete') ${scope}
      ORDER BY o.received_at,o.id`).all(since, knownAt, ...(source ? [source] : [])).map(decode);
    const earlier = decode(store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
      WHERE o.signal='outdoor_temperature' AND o.received_at<?
      AND (o.import_id IS NULL OR i.status='complete') ${scope}
      ORDER BY o.received_at DESC,o.id DESC LIMIT 1`).get(since, ...(source ? [source] : [])));
    if (earlier) rows.unshift(earlier);
    for (const span of store.db.prepare(`SELECT o.*,c.source_time AS report_time,c.end_at,c.status
      FROM recorder_coverage c JOIN observations o ON o.id=c.observation_id
      WHERE c.signal='outdoor_temperature' AND c.end_at>=? AND c.end_at<=? ${scope}
      ORDER BY c.end_at,c.id`).all(since, knownAt, ...(source ? [source] : []))) {
      const row = decode(span);
      rows.push(span.status === 'fresh' ? { ...row, sourceTime: span.report_time, receivedAt: span.end_at } : row);
    }
    rows.sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
    let observation;
    for (const row of rows) observation = rememberOutdoorReading(observation, row, knownAt);
    if (!observation) continue;
    candidates.push(observation);
  }
  const selected = candidates.find(row => !outdoorReadingStatus(row, now).stale)
    ?? candidates.filter(row => !temperatureFailureReasons(row, now).length).sort((a, b) => b.sourceTime - a.sourceTime)[0]
    ?? candidates.sort((a, b) => b.receivedAt - a.receivedAt)[0];
  return { ...outdoorReadingStatus(selected, now), recorded: true };
}
