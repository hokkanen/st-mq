import { HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS } from '../domain/indoor-sensors.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';

const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit', 'stale']);

/** Age is an attention condition, independent of whether a measurement is real.
 * Live acquisition-only values may serve control; the committed lookup below
 * additionally rejects them so the learner sees only recorded observations. */
export function indoorReadingUsable(observation, at) {
  if (!observation || !HELD_TEMPERATURE_SIGNALS.includes(observation.signal)
    || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || !Number.isFinite(observation.receivedAt) || observation.sourceTime > at
    || observation.receivedAt > at || observation.sourceTime > observation.receivedAt
    || !['degC', '°C'].includes(observation.unit) || observation.source === 'controller-estimate'
    || observation.raw?.auditOnly || observation.raw?.retained === true
    || observation.raw?.timeBasis === 'availability-transition'
    || (observation.quality ?? []).some(flag => !ALLOWED.has(flag))) return false;
  if (observation.source?.startsWith('husdata') && observation.raw?.usableForControl !== true
    && !(observation.quality?.includes('stale') && observation.raw?.verification)) return false;
  return observation.signal === 'garage_temperature'
    ? observation.value >= -60 && observation.value <= 70 : observation.value > 2 && observation.value < 40;
}

export function indoorReadingAttention(reading, at, { latest = reading } = {}) {
  const attentionReasons = [];
  const reportAge = temperatureReportMaxAge(reading);
  if (reportAge !== null) {
    const expiresAt = reading.reportExpiresAt ?? reading.sourceTime + reportAge;
    if (at > expiresAt) attentionReasons.push('missing-report');
  } else if (reading && at - reading.sourceTime > INDOOR_ATTENTION_MS) attentionReasons.push('old-reading');
  if (latest && reading && latest !== reading && latest.receivedAt >= reading.receivedAt
    && latest.source === reading.source && latest.device === reading.device && latest.signal === reading.signal
    && latest.receivedAt <= at && latest.raw?.retained !== true && !latest.quality?.includes('retained')) {
    if (latest.quality?.some(flag => /disconnected|subscription-failed/.test(flag))) attentionReasons.push('disconnected');
    else if (!indoorReadingUsable(latest, at)) attentionReasons.push('invalid-reading');
  }
  return { needsAttention: attentionReasons.length > 0, attentionReasons, held: attentionReasons.length > 0 };
}

/** Original measurement age and periodic report availability are independent.
 * The saved value can stay unchanged for days while new reports keep it usable. */
export function indoorReportStatus(reading, at, attention = indoorReadingAttention(reading, at)) {
  const maxAge = temperatureReportMaxAge(reading);
  if (maxAge === null) return {};
  const reportExpiresAt = reading.reportExpiresAt ?? reading.sourceTime + maxAge;
  return { periodicReports: true, reportExpiresAt,
    stale: at > reportExpiresAt || attention.attentionReasons.some(reason => ['disconnected', 'invalid-reading'].includes(reason)) };
}

const decode = row => ({ id: row.id, source: row.source, device: row.device, signal: row.signal,
  value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
  quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null,
  provenance: row.import_id === null ? null : { importId: row.import_id, rowNumber: row.row_number } });

/** The recorder extends a fresh span only when each newer report arrives before
 * the preceding source report expires. Its interior therefore proves continuous
 * availability, even after its compact end advances beyond this query. A later
 * span cannot fill an earlier gap. No discarded report timestamp is invented. */
export function indoorReportCoverage(store, { reading, from, at, notBefore = -Infinity }) {
  let age = temperatureReportMaxAge(reading);
  if (age === null) {
    if (from === at) return null;
    // Disabling periodic reporting changes future availability only. A window
    // that began under that contract must still retain any earlier report gap.
    const earlier = store.db.prepare(`SELECT o.raw FROM recorder_coverage c JOIN observations o ON o.id=c.observation_id
      WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at<=?
        AND json_extract(o.raw,'$.reportIntervalMs')>0
        AND COALESCE((SELECT n.start_at FROM recorder_coverage n WHERE n.source=c.source AND n.device=c.device
          AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1),?)>?
      ORDER BY c.start_at DESC,c.id DESC LIMIT 1`).get(reading.source, reading.device, reading.signal, at, at, from);
    age = earlier ? temperatureReportMaxAge({ raw: JSON.parse(earlier.raw) }) : null;
    if (age === null) return null;
  }
  const args = [reading.source, reading.device, reading.signal, at, from, from - age, from];
  const spans = store.db.prepare(`SELECT c.*,o.id AS original_id,o.source_time AS original_source_time,
      o.received_at AS original_received_at,o.value,o.unit,o.quality,o.raw,o.import_id,o.row_number,
      (SELECT n.start_at FROM recorder_coverage n WHERE n.source=c.source AND n.device=c.device
        AND n.signal=c.signal AND n.id>c.id ORDER BY n.id LIMIT 1) AS next_start
    FROM recorder_coverage c LEFT JOIN observations o ON o.id=c.observation_id
    WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at<=?
      AND (c.source_time+COALESCE(json_extract(o.raw,'$.reportIntervalMs'),0)
        +COALESCE(json_extract(o.raw,'$.reportGraceMs'),0)>=? OR c.end_at>=?
        OR c.id=(SELECT n.id FROM recorder_coverage n WHERE n.source=c.source AND n.device=c.device
          AND n.signal=c.signal AND n.start_at<=? ORDER BY n.start_at DESC,n.id DESC LIMIT 1))
    ORDER BY c.start_at,c.id`).all(...args);
  const events = spans.map(span => {
    const observation = decode({ ...span, id: span.original_id, source_time: span.original_source_time,
      received_at: span.original_received_at, quality: span.quality ?? '[]' });
    return { start: span.start_at, end: span.source_time + (temperatureReportMaxAge(observation) ?? Infinity),
      receivedAt: span.end_at, coverageId: span.id, status: span.status, observation, nextStart: span.next_start };
  });
  // Direct committed observations (including fixtures/imports) still establish
  // their own bounded interval. Recorder observations use their coverage only.
  for (const row of store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.source=? AND o.device=? AND o.signal=? AND o.received_at<=? AND o.received_at>=?
      AND (o.import_id IS NULL OR i.status='complete')
      AND NOT EXISTS (SELECT 1 FROM recorder_coverage c WHERE c.observation_id=o.id)
    ORDER BY o.received_at,o.id`).all(reading.source, reading.device, reading.signal, at, from - age)) {
    const observation = decode(row);
    if (observation.raw?.retained || observation.quality.includes('retained') || observation.raw?.acquisitionOnly) continue;
    events.push({ start: observation.receivedAt, end: observation.sourceTime + (temperatureReportMaxAge(observation) ?? Infinity),
      receivedAt: observation.receivedAt, observation, coverageId: null, status: 'fresh' });
  }
  events.sort((a, b) => a.start - b.start || (a.coverageId ?? a.observation.id) - (b.coverageId ?? b.observation.id));
  let coveredThrough = from, endpoint = null;
  const observations = new Set(), coverage = new Set();
  for (let i = 0; i < events.length; i++) {
    const event = events[i], observation = event.observation;
    if (event.status !== 'fresh' || observation.sourceTime < notBefore
      || observation.raw?.acquisitionOnly || !indoorReadingUsable(observation, at)) continue;
    // The next source event may have been excluded by the time/age query (for
    // example an old failure followed by a shorter reporting policy). It still
    // terminates this span; filtering must never join across that failure.
    const next = Math.min(event.nextStart ?? Infinity, events[i + 1]?.start ?? Infinity);
    const end = Math.min(event.end, next);
    if (end < from || event.start > at || end < event.start) continue;
    if (event.start <= coveredThrough) coveredThrough = Math.max(coveredThrough, Math.min(at, end));
    observations.add(observation.id); if (event.coverageId) coverage.add(event.coverageId);
    if (event.start <= at && event.end >= at && next > at)
      endpoint = { expiresAt: event.receivedAt <= at ? event.end : at };
  }
  return { complete: coveredThrough >= at && endpoint !== null, available: endpoint !== null,
    coveredThrough, expiresAt: endpoint?.expiresAt ?? null,
    observations: [...observations], coverage: [...coverage] };
}

/** Last genuine indoor measurement known at a causal boundary. Availability
 * events and age do not erase it, and no receipt/coverage span renews its time. */
export function lastIndoorReading(store, { signal, at, input, notBefore = -Infinity }) {
  const scope = input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'";
  let newerCoverage;
  const withRecordedOrder = observation => {
    // Older recorder rows used "stale" for both age and source-time rollback.
    // A compressed fresh update can prove a rollback even when its actual value
    // was not saved. Only evidence already known on receipt may reject the row;
    // coverage never changes the retained measurement's original timestamp.
    if (observation.quality.includes('stale') && !observation.quality.includes('out-of-order-source-time')) {
      newerCoverage ??= store.db.prepare(`SELECT 1 FROM recorder_coverage
        WHERE source=? AND device=? AND signal=? AND status='fresh'
          AND source_time>? AND source_time<=? AND end_at<=? LIMIT 1`);
      if (newerCoverage.get(observation.source, observation.device, observation.signal,
        observation.sourceTime, observation.receivedAt, observation.receivedAt))
        return { ...observation, quality: [...observation.quality, 'out-of-order-source-time'] };
    }
    return observation;
  };
  const query = store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.signal=? AND o.source_time>=? AND o.source_time<=? AND o.received_at<=?
      AND o.value IS NOT NULL AND (o.import_id IS NULL OR i.status='complete') AND ${scope}
    ORDER BY o.source_time DESC,o.id DESC`);
  for (const row of query.iterate(signal, notBefore, at, at)) {
    const observation = withRecordedOrder(decode(row));
    if (!observation.raw?.acquisitionOnly && indoorReadingUsable(observation, at)) {
      const after = store.db.prepare(`SELECT * FROM observations WHERE signal=? AND source=? AND device=?
        AND received_at>=? AND received_at<=? AND (source_time IS NULL OR source_time>=? AND source_time<=?)
        ORDER BY received_at DESC,id DESC`);
      let latest = observation;
      for (const attempt of after.iterate(signal, observation.source, observation.device, observation.receivedAt, at, observation.sourceTime, at)) {
        const candidate = withRecordedOrder(decode(attempt));
        if (candidate.raw?.retained === true || candidate.quality?.includes('retained') || candidate.raw?.acquisitionOnly) continue;
        latest = candidate; break;
      }
      const coverage = indoorReportCoverage(store, { reading: observation, from: at, at, notBefore });
      const reading = coverage ? { ...observation,
        reportExpiresAt: coverage.expiresAt ?? Math.min(at - 1, observation.sourceTime + temperatureReportMaxAge(observation)),
        reportCoverage: coverage } : observation;
      const attention = indoorReadingAttention(reading, at, { latest });
      return { ...reading, ...attention, ...indoorReportStatus(reading, at, attention) };
    }
  }
  return null;
}
