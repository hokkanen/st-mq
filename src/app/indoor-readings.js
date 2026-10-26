import { HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS } from '../domain/indoor-sensors.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { observationTimeAdmitted, observationAvailableAt } from '../domain/time-evidence.js';
import { selectedCoverageSpan, nextCoverageStart } from '../storage/coverage-history.js';

const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit', 'stale']);

/** Age is an attention condition, independent of whether a measurement is real.
 * Live acquisition-only values may serve control; the committed lookup below
 * additionally rejects them so the learner sees only recorded observations. */
export function indoorReadingUsable(observation, at) {
  if (!observation || !HELD_TEMPERATURE_SIGNALS.includes(observation.signal)
    || observation.signal === 'indoor_temperature' && observation.source?.startsWith('husdata')
    || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || !Number.isFinite(observation.receivedAt) || observation.sourceTime > at
    || !observationTimeAdmitted(observation, at)
    || !['degC', '°C'].includes(observation.unit) || observation.source === 'controller-estimate'
    || observation.raw?.auditOnly || observation.raw?.retained === true
    || observation.raw?.timeBasis === 'availability-transition'
    || (observation.quality ?? []).some(flag => !ALLOWED.has(flag))) return false;
  if (observation.source?.startsWith('husdata') && observation.raw?.usableForControl !== true
    && !(observation.quality?.includes('stale') && observation.raw?.verification)) return false;
  return ['garage_temperature', 'garage_temperature_2'].includes(observation.signal)
    ? observation.value >= -60 && observation.value <= 70 : observation.value > 2 && observation.value < 40;
}

export function indoorReadingAttention(reading, at, { latest = reading } = {}) {
  const attentionReasons = [];
  const reportAge = temperatureReportMaxAge(reading);
  if (reportAge !== null) {
    const expiresAt = reading.reportExpiresAt ?? reading.sourceTime + reportAge;
    const coveredBoundary = reading.reportCoverage?.available && reading.reportCoverage.knownAt === at;
    if (at >= expiresAt && !coveredBoundary) attentionReasons.push('missing-report');
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
    stale: at >= reportExpiresAt && !(reading.reportCoverage?.available && reading.reportCoverage.knownAt === at)
      || attention.attentionReasons.some(reason => ['disconnected', 'invalid-reading'].includes(reason)) };
}

const decode = row => ({ id: row.id, source: row.source, device: row.device, signal: row.signal,
  value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
  quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null,
  provenance: row.import_id === null ? null : { importId: row.import_id, rowNumber: row.row_number } });

// Probe physical source/device prefixes before the chronological lookup. A
// missing environment/signal must not search another environment's whole past.
function hasScopedReading(store, { signal, input }) {
  const firstSource = store.db.prepare('SELECT source FROM observations ORDER BY source LIMIT 1');
  const nextSource = store.db.prepare('SELECT source FROM observations WHERE source>? ORDER BY source LIMIT 1');
  const firstDevice = store.db.prepare('SELECT device FROM observations WHERE source=? ORDER BY device LIMIT 1');
  const nextDevice = store.db.prepare('SELECT device FROM observations WHERE source=? AND device>? ORDER BY device LIMIT 1');
  // Check only the indexed physical prefix. A clock/quality residual here can
  // walk the whole old stream when a new sensor boundary has no measurement.
  // The following chronological lookup owns time and selected-history checks.
  const present = store.db.prepare(`SELECT 1 FROM observations
    WHERE source=? AND device=? AND signal=? LIMIT 1`);
  for (let row = input === 'simulated' ? { source: 'simulation' } : firstSource.get(); row;
    row = input === 'simulated' ? null : nextSource.get(row.source)) {
    if (input !== 'simulated' && row.source === 'simulation' || row.source === 'controller-estimate'
      || signal === 'indoor_temperature' && row.source.startsWith('husdata')) continue;
    for (let device = firstDevice.get(row.source); device; device = nextDevice.get(row.source, device.device)) {
      if (present.get(row.source, device.device, signal)) return true;
    }
  }
  return false;
}

// Mirror only immutable scalar exclusions in the indexed candidate query. The
// shared JavaScript validator still owns admission, source and quality meaning.
// JSON false/zero/empty text follow JavaScript truthiness; text "0" is not false.
const falseyRaw = (alias, path) => `(json_type(${alias}.raw,'$.${path}') IS NULL
  OR json_type(${alias}.raw,'$.${path}') IN ('null','false')
  OR json_type(${alias}.raw,'$.${path}') IN ('integer','real') AND json_extract(${alias}.raw,'$.${path}')=0
  OR json_type(${alias}.raw,'$.${path}')='text' AND json_extract(${alias}.raw,'$.${path}')='')`;
const recordedCandidate = `o.unit IN ('degC','°C') AND o.source<>'controller-estimate'
  AND ${falseyRaw('o', 'acquisitionOnly')} AND ${falseyRaw('o', 'auditOnly')}
  AND COALESCE(json_type(o.raw,'$.retained'),'null')<>'true'
  AND COALESCE(json_extract(o.raw,'$.timeBasis'),'')<>'availability-transition'
  AND json_type(o.quality)='array'
  AND NOT EXISTS(SELECT 1 FROM json_each(o.quality) WHERE value NOT IN (${[...ALLOWED].map(value => `'${value}'`).join(',')}))
  AND (o.source NOT GLOB 'husdata*' OR json_type(o.raw,'$.usableForControl')='true'
    OR EXISTS(SELECT 1 FROM json_each(o.quality) WHERE value='stale') AND NOT ${falseyRaw('o', 'verification')})`;

// The writer bridge materializes iterate() results. Fetch just one candidate:
// a larger LIMIT would scan all unrelated history trying to fill a sparse page
// even when its first candidate is already usable. Quality remains checked here.
function* readingCandidates(store, { signal, at, input, notBefore }) {
  if (!HELD_TEMPERATURE_SIGNALS.includes(signal)) return;
  if (!hasScopedReading(store, { signal, at, input, notBefore })) return;
  let time = at, id = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = store.db.prepare(`SELECT o.* FROM active_observations o LEFT JOIN active_imports i ON i.id=o.import_id
      WHERE o.signal=? AND o.source_time>=? AND (o.source_time,o.id)<=(?,?) AND o.received_at<=?
        AND o.value IS NOT NULL AND (o.import_id IS NULL OR i.status='complete')
        AND ${recordedCandidate}
        AND ${signal === 'indoor_temperature' ? "o.source NOT GLOB 'husdata*' AND o.value>2 AND o.value<40"
          : ['garage_temperature', 'garage_temperature_2'].includes(signal) ? 'o.value>=-60 AND o.value<=70' : 'o.value>2 AND o.value<40'}
        AND ${input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'"}
      ORDER BY o.source_time DESC,o.id DESC LIMIT 1`).all(signal, notBefore, time, id, at);
    yield* rows;
    if (!rows.length) return;
    const last = rows.at(-1); time = last.source_time; id = last.id - 1;
  }
}

function latestReadingAttempt(store, observation, at) {
  // Unit and recording policy precede receipt in the existing index. Seek each
  // prefix; invalid units must remain eligible to report a later failed reading.
  const policy = "json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.recorder.policy')";
  const prefix = [observation.source, observation.device, observation.signal];
  const first = store.db.prepare(`SELECT unit,${policy} AS policy FROM observations
    WHERE source=? AND device=? AND signal=? ORDER BY unit,${policy} LIMIT 1`);
  const nextPolicy = store.db.prepare(`SELECT unit,${policy} AS policy FROM observations
    WHERE source=? AND device=? AND signal=? AND unit=? AND ${policy}>? ORDER BY ${policy} LIMIT 1`);
  const firstPolicy = store.db.prepare(`SELECT unit,${policy} AS policy FROM observations
    WHERE source=? AND device=? AND signal=? AND unit=? AND ${policy} IS NOT NULL ORDER BY ${policy} LIMIT 1`);
  const nextUnit = store.db.prepare(`SELECT unit,${policy} AS policy FROM observations
    WHERE source=? AND device=? AND signal=? AND unit>? ORDER BY unit,${policy} LIMIT 1`);
  const next = stream => (stream.policy === null ? firstPolicy.get(...prefix, stream.unit)
    : nextPolicy.get(...prefix, stream.unit, stream.policy)) ?? nextUnit.get(...prefix, stream.unit);
  const query = store.db.prepare(`SELECT * FROM active_observations WHERE source=? AND device=? AND signal=?
    AND unit=? AND ${policy} IS ? AND received_at>=? AND (received_at,id)<=(?,?)
    AND (source_time IS NULL OR source_time>=? AND source_time<=?)
    ORDER BY received_at DESC,id DESC LIMIT 1`);
  let latest = observation;
  for (let stream = first.get(...prefix); stream; stream = next(stream)) {
    let time = at, id = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const row = query.get(...prefix, stream.unit, stream.policy, observation.receivedAt, time, id, observation.sourceTime, at);
      if (!row) break;
      const candidate = decode(row);
      time = row.received_at; id = row.id - 1;
      if (candidate.raw?.retained === true || candidate.quality?.includes('retained') || candidate.raw?.acquisitionOnly) continue;
      if (candidate.receivedAt > latest.receivedAt || candidate.receivedAt === latest.receivedAt && candidate.id > latest.id) latest = candidate;
      break;
    }
  }
  return latest;
}

/** The recorder extends a fresh span only when each newer report arrives before
 * the preceding source report expires. Its interior therefore proves continuous
 * availability, even after its compact end advances beyond this query. A later
 * span cannot fill an earlier gap. No discarded report timestamp is invented. */
export function indoorReportCoverage(store, { reading, from, at, notBefore = -Infinity, includeIntervals = false }) {
  let age = temperatureReportMaxAge(reading);
  if (age === null && from === at) return null;
  // This boundary is constant for the whole query. Correlating it with each
  // candidate span repeatedly scans/sorts the same stream as history grows.
  const preceding = store.db.prepare(`SELECT id,start_at FROM active_recorder_coverage AS recorder_coverage
    WHERE source=? AND device=? AND signal=? AND start_at<?
      AND ${selectedCoverageSpan('recorder_coverage')}
    ORDER BY start_at DESC,id DESC LIMIT 1`).get(reading.source, reading.device, reading.signal, from);
  if (age === null) {
    // Disabling periodic reporting changes future availability only. A window
    // that began under that contract must still retain any earlier report gap.
    const earlier = store.db.prepare(`SELECT o.raw FROM active_recorder_coverage c JOIN active_observations o ON o.id=c.observation_id
      WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at>=? AND c.start_at<=?
        AND json_extract(o.raw,'$.reportIntervalMs')>0
        AND ${selectedCoverageSpan('c')} AND COALESCE(${nextCoverageStart('c')},?)>?
      ORDER BY c.start_at DESC,c.id DESC LIMIT 1`).get(reading.source, reading.device, reading.signal, preceding?.start_at ?? from, at, at, from);
    age = earlier ? temperatureReportMaxAge({ raw: JSON.parse(earlier.raw) }) : null;
    if (age === null) return null;
  }
  const args = [reading.source, reading.device, reading.signal, preceding?.start_at ?? from, at, from, from - age, preceding?.id ?? null];
  const spans = store.db.prepare(`SELECT c.*,o.id AS original_id,o.source_time AS original_source_time,
      o.received_at AS original_received_at,o.value,o.unit,o.quality,o.raw,o.import_id,o.row_number,
      ${nextCoverageStart('c')} AS next_start
    FROM active_recorder_coverage c LEFT JOIN active_observations o ON o.id=c.observation_id
    WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at>=? AND c.start_at<=? AND ${selectedCoverageSpan('c')}
      AND (c.source_time+COALESCE(json_extract(o.raw,'$.reportIntervalMs'),0)
        +COALESCE(json_extract(o.raw,'$.reportGraceMs'),0)>=? OR c.end_at>=?
        OR c.id=?)
    ORDER BY c.start_at,c.id`).all(...args);
  const events = spans.map(span => {
    const observation = decode({ ...span, id: span.original_id, source_time: span.original_source_time,
      received_at: span.original_received_at, quality: span.quality ?? '[]' });
    return { start: span.start_at, end: span.source_time + (temperatureReportMaxAge(observation) ?? Infinity),
      receivedAt: span.end_at, coverageId: span.id, status: span.status, observation, nextStart: span.next_start };
  });
  // Direct committed observations (including fixtures/imports) still establish
  // their own bounded interval. Recorder observations use their coverage only.
  // The stream index places unit/policy before receipt; without those prefixes
  // it scans the complete sensor archive. Leave receipt as the indexed seek;
  // the selected view may also be a current recovery overlay without that index.
  for (const row of store.db.prepare(`SELECT o.* FROM active_observations o LEFT JOIN active_imports i ON i.id=o.import_id
    WHERE +o.source=? AND +o.device=? AND +o.signal=? AND o.received_at<=? AND o.received_at>=?
      AND (o.import_id IS NULL OR i.status='complete')
      AND NOT EXISTS (SELECT 1 FROM active_recorder_coverage c WHERE c.observation_id=o.id)
    ORDER BY o.received_at,o.id`).all(reading.source, reading.device, reading.signal, at, from - age)) {
    const observation = decode(row);
    if (observation.raw?.retained || observation.quality.includes('retained') || observation.raw?.acquisitionOnly) continue;
    events.push({ start: observationAvailableAt(observation) ?? observation.receivedAt, end: observation.sourceTime + (temperatureReportMaxAge(observation) ?? Infinity),
      receivedAt: observation.receivedAt, observation, coverageId: null, status: 'fresh' });
  }
  events.sort((a, b) => a.start - b.start || (a.coverageId ?? a.observation.id) - (b.coverageId ?? b.observation.id));
  let coveredThrough = from, endpoint = null;
  const observations = new Set(), coverage = new Set(), intervals = [];
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
    if (includeIntervals) intervals.push({ start: Math.max(from, event.start), end: Math.min(at, end), observedAt: observation.sourceTime,
      endpoint: event.start <= at && event.end > at && next > at });
    if (event.start <= coveredThrough) coveredThrough = Math.max(coveredThrough, Math.min(at, end));
    observations.add(observation.id); if (event.coverageId) coverage.add(event.coverageId);
    if (event.start <= at && event.end > at && next > at)
      endpoint = { expiresAt: event.receivedAt <= at ? event.end : at };
  }
  return { complete: coveredThrough >= at && endpoint !== null, available: endpoint !== null, knownAt: at,
    coveredThrough, expiresAt: endpoint?.expiresAt ?? null,
    observations: [...observations], coverage: [...coverage], ...(includeIntervals ? { intervals } : {}) };
}

/** Last genuine indoor measurement known at a causal boundary. Availability
 * events and age do not erase it, and no receipt/coverage span renews its time.
 * Recording can ask only whether a genuine measurement already exists after
 * a sensor boundary; that does not need to reconstruct report availability. */
export function lastIndoorReading(store, { signal, at, input, notBefore = -Infinity, includeAvailability = true }) {
  for (const row of readingCandidates(store, { signal, at, input, notBefore })) {
    const observation = decode(row);
    if (!observation.raw?.acquisitionOnly && indoorReadingUsable(observation, at)) {
      if (!includeAvailability) return observation;
      const latest = latestReadingAttempt(store, observation, at);
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
