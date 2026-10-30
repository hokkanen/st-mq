import { createHash } from 'node:crypto';
import { H66_MAX_AGE_MS, OUTDOOR_MAX_AGE_MS, DEFAULT_SOURCE_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { INDOOR_SIGNALS, HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS } from '../domain/indoor-sensors.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { isRecordedDataset } from './recorded-datasets.js';
import { validEnergyQuality } from './energy-history.js';
import { recordingPolicy, recordingStreamKey as keyOf, hasSourceReportCoverage } from '../domain/recording-policy.js';
import { VOLTAGE_RECORDING_FLOOR_V, VOLTAGE_SIGNALS, voltageRecordingStatus } from './voltage.js';
import { recordedTransport } from '../domain/recording-source.js';
import { ADAPTIVE_BUDGET_KEY, initialAdaptiveBudget as initialBudget, readAdaptiveBudget } from './adaptive-recording-budget.js';
import { STORAGE_METRICS_KEY, initialStorageMetrics, readStorageMetrics } from './recording-metrics.js';
import { observationTimeAdmitted, observationAvailableAt, sourceTimeAdmission, validateAdmittedSourceTime } from '../domain/time-evidence.js';
import { selectedCoverageSpan } from './coverage-history.js';
import { caravanState, hasCaravanEvidence, caravanRecordingEvidence, caravanEvidenceDeadline,
  caravanEvidenceContinues, caravanCoverageDeadline } from '../domain/caravan-recording-evidence.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, YEAR = 365.25 * DAY;
export const RECORDING_VERSION = 'recording-contract-v2';
const VERSION = RECORDING_VERSION;
const METRIC_FLUSH_MS = 30_000, MAX_PENDING_METRIC_BUCKETS = 256;
const METADATA_FLUSH_MS = 30_000, MAX_PENDING_SIGNALS = 256;
const COALESCED_SOURCES = new Set(['husdata-h66', 'garage-adapter', 'voltage-estimate']);
const METRIC_SUMS = ['polls', 'records', 'bytes', 'error_squared_time', 'error_time', 'stale', 'failed', 'unavailable'];
function combineMetrics(left, right) {
  const row = { ...left };
  for (const field of METRIC_SUMS) row[field] = (left[field] ?? 0) + (right[field] ?? 0);
  row.first_saved_at = left.first_saved_at === null ? right.first_saved_at
    : right.first_saved_at === null ? left.first_saved_at : Math.min(left.first_saved_at, right.first_saved_at);
  row.last_saved_at = left.last_saved_at === null ? right.last_saved_at
    : right.last_saved_at === null ? left.last_saved_at : Math.max(left.last_saved_at, right.last_saved_at);
  return row;
}
// Logical row estimate, including source/quality/provenance metadata and JSON
// structure. Local SQL IDs and unrelated table/index allocation never affect it.
const observationBytes = o => Buffer.byteLength(JSON.stringify({ source: o.source, device: o.device,
  signal: o.signal, value: o.value, unit: o.unit, sourceTime: o.sourceTime,
  receivedAt: o.receivedAt, quality: o.quality, raw: o.raw }));
const DISABLED_H66 = new Set(['discharge_temperature', 'brine_pump_active']);
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const flags = quality => [...new Set(quality ?? [])].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stateKey = key => `recorder:signal:${key}`;
const finiteTime = at => Number.isSafeInteger(at) && Math.abs(at) <= 8640000000000000;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRecordingWait = wait => wait && Object.keys(wait).length === 5
  && ['startedAt', 'recordingSince', 'deadline'].every(key => finiteTime(wait[key]) && wait[key] >= 0)
  && wait.recordingSince <= wait.startedAt && wait.deadline > wait.startedAt
  && digest(wait.identity) && digest(wait.meterSignature);

/** A recording boundary resumes only from this receipt. Original native report
 * clocks remain distinct from the prospective availability boundary. */
function caravanRecordingBoundary(o, newReport) {
  const raw = o?.raw, wait = raw?.sourceTimeWait, evidence = raw?.locationEvidence;
  const age = temperatureReportMaxAge(o), at = o?.receivedAt;
  const fields = o?.value === 0 ? ['power'] : ['power', 'fanSpeed'];
  const basis = newReport ? 'recording-source-admission' : 'recording-availability-recovery';
  return caravanState(o) && [0, 1, 2, 3].includes(o.value) && finiteTime(at)
    && raw?.timeBasis === basis && raw.availabilityRecoveredAt === at
    && raw.recorder?.version === VERSION && raw.recorder.temporalBasis === (newReport ? 'source-admission' : 'availability-recovery')
    && raw.recorder.reason === basis && raw.recorder.status === 'fresh'
    && raw.recorder.policy === recordingPolicy(o).id && raw.recorder.originalSourceTime === o.sourceTime
    && validRecordingWait(wait) && wait.startedAt <= at && at < wait.deadline
    && raw.identity === wait.identity && o.sourceTime === raw.originalReportSourceTime
    && o.sourceTime >= wait.recordingSince
    && (newReport ? finiteTime(raw.recorder.previousSourceTime)
      && raw.recorder.previousSourceTime >= wait.recordingSince && raw.recorder.previousSourceTime <= wait.startedAt
      && raw.recorder.previousSourceTime < o.sourceTime
      && observationTimeAdmitted({ sourceTime: raw.recorder.previousSourceTime, receivedAt: raw.recorder.previousReportReceivedAt,
        raw: { timeAdmission: raw.recorder.previousReportTimeAdmission } }, wait.startedAt)
      : raw.originalReportReceivedAt <= wait.startedAt)
    && raw.originalReportTimeBasis === 'mqtt-live-status' && raw.timeAdmission === undefined
    && observationTimeAdmitted({ sourceTime: o.sourceTime, receivedAt: raw.originalReportReceivedAt,
      raw: { timeAdmission: raw.originalReportTimeAdmission } }, newReport ? at : wait.startedAt)
    && (o.quality ?? []).every(flag => flag === 'good') && !raw.retained && !raw.cached
    && !raw.auditOnly && !raw.acquisitionOnly
    && age !== null && Number.isSafeInteger(raw.maxAgeMs) && raw.maxAgeMs > 0 && age <= raw.maxAgeMs
    && caravanEvidenceDeadline(caravanRecordingEvidence(o)) > at
    && fields.every(field => finiteTime(raw.fieldTimestamps?.[field]) && raw.fieldTimestamps[field] >= 0
      && raw.fieldTimestamps[field] <= at && at < raw.fieldTimestamps[field] + raw.maxAgeMs)
    && wait.deadline <= Math.min(...fields.map(field => raw.fieldTimestamps[field])) + raw.maxAgeMs
    && o.sourceTime === Math.max(...fields.map(field => raw.fieldTimestamps[field])) && at < o.sourceTime + age
    && evidence?.method === 'native-power-cycle-v1' && evidence.meterSignature === wait.meterSignature
    && ['startedAt', 'completedAt', 'meterObservedAt'].every(key => finiteTime(evidence[key]) && evidence[key] >= 0)
    && evidence.startedAt <= evidence.completedAt && evidence.completedAt <= wait.recordingSince
    && evidence.meterObservedAt >= evidence.startedAt && evidence.meterObservedAt <= at
    && ['powerRiseW', 'powerFallW'].every(key => Number.isFinite(evidence[key]) && evidence[key] >= evidence.minimumChangeW)
    && Number.isFinite(evidence.minimumChangeW) && evidence.minimumChangeW >= 3
    && ['baseline', 'on', 'off'].every(phase => {
      const row = evidence.phases?.[phase];
      return row && (finiteTime(row.commandAt) || phase === 'baseline' && row.commandAt === null)
        && finiteTime(row.firstPowerObservedAt) && row.firstPowerObservedAt >= 0
        && finiteTime(row.lastPowerObservedAt) && row.lastPowerObservedAt >= row.firstPowerObservedAt
        && row.lastPowerObservedAt <= evidence.completedAt
        && (row.commandAt === null || row.commandAt >= 0 && row.firstPowerObservedAt >= row.commandAt);
    });
}
export const isCaravanRecordingRecovery = o => caravanRecordingBoundary(o, false);
export const isCaravanRecordingAdmission = o => caravanRecordingBoundary(o, true);
// Correlated output replies use the host clock. Signed Meross contacts have a
// whole-second source clock and retain their distinct receive/admission order.
// Neither case rewrites source time or admits repeated measurement timestamps.
const contactReport = o => o.unit === 'state' && (o.sourceTime === o.receivedAt
  && (o.source === 'sonoff-floor' && o.raw?.timeBasis === 'mqtt-received' && o.raw?.evidence === 'gpio_output_readback'
    || o.source === 'mqtt-equipment' && o.signal === 'dhwr_active' && o.raw?.timeBasis === 'mqtt-received')
  || o.source === 'mqtt-equipment' && o.raw?.timeBasis === 'meross-contact'
    && /_open$/.test(o.signal) && o.sourceTime % 1000 === 0 && [0, 1].includes(o.value));
const numericalFloor = (a,b) => Math.max(1,Math.abs(a??0),Math.abs(b??0))*Number.EPSILON*32;
const voltageEstimate = o => o.source === 'voltage-estimate' && VOLTAGE_SIGNALS.includes(o.signal) && o.unit === 'V';
const valueFloor = o => voltageEstimate(o) ? VOLTAGE_RECORDING_FLOOR_V : 0;
// This is a history-selection floor, never a power/energy clamp. Every accepted
// Wh remains in the durable interval, including a charger's real standby load.
const CHARGER_POWER_FLOOR_KW = 0.010;
const chargerEnergy = prefix => ['ev1','ev2'].includes(prefix);
const nativeChargerEnergy = prefix => prefix === 'ev2';
// These flags describe ordinary source-clock bookkeeping within otherwise
// usable integration. Keep a conservative union in the span, without making
// each fresh/held poll a new historical cohort. All other quality changes,
// including stale power/phase weights and a different measurement basis, split.
const ENERGY_BOOKKEEPING = new Set(['held_source_values','last_reported_observations']);
const energyQuality = quality => flags(quality).filter(flag=>!ENERGY_BOOKKEEPING.has(flag));
const PHASE_WEIGHT_QUALITY = new Set(['voltage_current_phase_weights','current_phase_weights',
  'last_reported_zero_phase_weights','last_reported_phase_weights','asynchronous_snapshot']);
function sameEnergyQuality(a,b,{ zeroA = false,zeroB = false } = {}) {
  let left = energyQuality(a), right = energyQuality(b);
  // A reported exact zero needs no phase weights. Their absence is neutral;
  // comparing two actual allocation methods still creates a boundary. Preserve
  // the union in the span so any used/held weights remain explicit provenance.
  if (left.includes('reported_active_power') && right.includes('reported_active_power')) {
    if (zeroA && !left.some(flag=>PHASE_WEIGHT_QUALITY.has(flag))) right = right.filter(flag=>!PHASE_WEIGHT_QUALITY.has(flag));
    if (zeroB && !right.some(flag=>PHASE_WEIGHT_QUALITY.has(flag))) left = left.filter(flag=>!PHASE_WEIGHT_QUALITY.has(flag));
  }
  return same(left,right);
}
const semanticQuality = (raw, observation) => Object.fromEntries(['usableForControl','verified','retained','cached','installationVerified',
  'verification','diagnosticAvailable','accuracyVerified','contractVersion','supported','timeBasis','publicationMayUseGatewayCache','basis','reportIntervalMs','reportGraceMs','eventOnly','temperatureRouteSignature',
  'transport','voltageSource','voltageAvailability'].filter(key=>raw?.[key]!==undefined).map(key=>[key,raw[key]])
  .concat(raw?.voltageEstimate ? [['voltageInputs',raw.voltageEstimate.inputs],['voltageInput',raw.voltageEstimate.input]] : [])
  .concat(caravanState(observation) && raw?.fieldTimestamps && raw?.maxAgeMs !== undefined ? [['applianceEvidenceScope', {
    identity: raw.identity, maxAgeMs: raw.maxAgeMs,
    ...(raw.locationEvidence ? { association: Object.fromEntries(Object.entries(raw.locationEvidence)
      .filter(([key]) => key !== 'meterObservedAt')) } : {}) }]] : []));
// Source validity is independent of the recording budget.
// Increasing storage compression must never make old measurements fresher.
// Room and garage readings remain the last reported measurement until replaced.
// Their source clock still controls ordering, recording and measurement lineage.
const sourceAge = o => voltageEstimate(o) ? Infinity
  : o.source === 'mqtt-equipment' && o.unit === 'state' && (o.eventOnly || o.raw?.eventOnly) ? Infinity
  : temperatureReportMaxAge(o) ?? (HELD_TEMPERATURE_SIGNALS.includes(o.signal) ? Infinity : o.source === 'husdata-h66' ? H66_MAX_AGE_MS
  : /temperature$/.test(o.signal) ? OUTDOOR_MAX_AGE_MS : o.signal === 'solar_radiation' ? 6 * HOUR : DEFAULT_SOURCE_MAX_AGE_MS);

const DIAGNOSTIC_QUALITY = new Set(['missing', 'invalid-value', 'invalid-numeric', 'invalid-unit', 'invalid-payload',
  'retained', 'source-time-unknown', 'future-source-time', 'out-of-order-source-time', 'conflicting-duplicate',
  'disconnected', 'mqtt-disconnected', 'subscription-failed', 'provider-error', 'implausible-temperature', 'suspect-zero-indoor',
  'location-unconfirmed', 'state-evidence-unavailable']);

/** Explain the recorded acquisition and its current deadline without writing a
 * new observation, extending coverage, or changing historical classification. */
function recordingFreshness(state, coverage, now) {
  const eventOnly = state.source === 'mqtt-equipment' && state.unit === 'state' && state.eventOnly === true;
  const periodicAge = temperatureReportMaxAge({ raw: state.reportPolicy });
  const interval = /_energy_l[123]$/.test(state.signal) || state.signal === 'caravan_energy';
  const held = !interval && periodicAge === null && HELD_TEMPERATURE_SIGNALS.includes(state.signal);
  const maximumAge = interval ? null : sourceAge({ ...state, raw: state.reportPolicy });
  const maxAgeMs = Number.isFinite(maximumAge) ? maximumAge : null;
  const sourceObservedAt = Number.isFinite(coverage?.source_time) ? coverage.source_time
    : Number.isFinite(state.lastSourceTime) ? state.lastSourceTime : null;
  const age = sourceObservedAt === null ? null : now - sourceObservedAt;
  const evidenceDeadline = coverage?.evidence ? caravanEvidenceDeadline(JSON.parse(coverage.evidence)) : null;
  const reasons = state.status === 'fresh' ? [] : (state.last?.quality ?? []).filter(flag => typeof flag === 'string')
    .map(flag => flag.replaceAll('_', '-')).filter(flag => DIAGNOSTIC_QUALITY.has(flag));
  let status = state.status ?? 'waiting';
  if (state.recordingEvidence && evidenceDeadline === null) {
    reasons.push('invalid-quality');
    if (status === 'fresh') status = 'unavailable';
  }
  if (status === 'failed' && !reasons.length) reasons.push('provider-error');
  if (status === 'unavailable' && !reasons.length) reasons.push('invalid-quality');
  if (Number.isFinite(state.last?.sourceTime) && Number.isFinite(state.last?.receivedAt)
    && !observationTimeAdmitted({ ...state.last, raw: { timeAdmission: state.last.timeAdmission } }, now)) reasons.push('source-time-after-receipt');
  if (age !== null && age < 0) {
    reasons.push('future-source-time');
    if (status === 'fresh') status = 'unavailable';
  }
  if (!interval && age !== null && maxAgeMs !== null
    && (periodicAge !== null ? age >= maxAgeMs : age > maxAgeMs)) {
    reasons.push(periodicAge !== null ? 'missing-report' : 'source-expired');
    if (status === 'fresh') status = 'stale';
  }
  if (evidenceDeadline !== null && now >= evidenceDeadline) {
    reasons.push('missing-report');
    if (status === 'fresh') status = 'stale';
  }
  if (status === 'stale' && !reasons.length) reasons.push('invalid-quality');
  if (status === 'fresh' && interval) status = 'recorded-interval';
  if (status === 'fresh' && held) status = age > INDOOR_ATTENTION_MS ? 'held-attention' : 'held';
  if (status === 'fresh' && eventOnly) status = 'last-reported';
  return { status, reasons: [...new Set(reasons)], sourceObservedAt, maxAgeMs,
    savedValueAt: state.last?.sourceTime ?? null, lastAcceptedSourceAt: state.lastSourceTime,
    ageBasis: interval ? 'completed-interval' : eventOnly ? 'event-only' : periodicAge !== null ? 'periodic-report' : 'source-observation',
    ...(periodicAge !== null ? { reportIntervalMs: state.reportPolicy.reportIntervalMs,
      reportGraceMs: state.reportPolicy.reportGraceMs ?? 0 } : {}),
    ...(evidenceDeadline !== null ? { evidenceExpiresAt: evidenceDeadline } : {}),
    ...(held ? { attentionAfterMs: INDOOR_ATTENTION_MS } : {}) };
}

function sourceParameter(state, coverage, now, observedStreams) {
  return { signal:state.signal,source:state.source,unit:state.unit,status:state.status,
    lastSavedAt:state.last?.receivedAt ?? null,observedThisRun:observedStreams.has(state.key),
    ...(state.source === 'easee' ? {transport:recordedTransport({raw:state.last?.semanticQuality,quality:state.last?.quality})} : {}),
    streamId:createHash('sha256').update(state.key).digest('hex').slice(0,12),
    policy:recordingPolicy(state).id,lastSourceTime:state.lastSourceTime,lastPollAt:state.lastPollAt,
    freshness:recordingFreshness(state,coverage,now) };
}

/** Acquisition may be fast; only this persisted, causal approximation trains.
 * All continuous signals share one normalized error tolerance. Signal scale is
 * learned from variation, never model importance or a unit-specific target.
 */
export class Recorder {
  constructor(store, { config = {}, clock = Date.now } = {}) {
    this.store = store; this.clock = clock;
    // Presentation evidence only. A restored checkpoint is not an acquisition
    // made by this runtime, and this marker grants no device authority.
    this.observedStreams = new Set();
    // Unchanged scalar receipt endpoints can share a bounded metadata flush.
    // Value/quality boundaries and every accepted energy increment remain
    // immediate. A crash can lose only this unsaved endpoint/diagnostic tail;
    // restart never extends committed coverage from remembered live health.
    this.pendingMetrics = new Map();
    this.pendingSignals = new Map();
    this.metadataHolds = new Set();
    this.configure(config);
    this.adaptiveBudgetState();
    readStorageMetrics(store.db);
  }

  configure(config = {}) {
    for (const key of Object.keys(config)) if (key !== 'annualBudgetBytes')
      throw new TypeError(`Unsupported recording setting: ${key}`);
    this.config = {
      annualBudgetBytes: config.annualBudgetBytes ?? 10_000_000_000,
    };
    if (!Number.isFinite(this.config.annualBudgetBytes) || this.config.annualBudgetBytes <= 0)
      throw new TypeError('Recorder annual budget must be positive');
  }

  storageMetrics(now) {
    const g = readStorageMetrics(this.store.db) ?? initialStorageMetrics(now,this.store.databaseBytes());
    const elapsed = now - g.measuredAt;
    if (elapsed >= HOUR) {
      const bytes = this.store.databaseBytes(), daily = Math.max(0, bytes - g.measuredBytes) * DAY / elapsed;
      // Weight all measured time during warmup. Seeding a slow exponential
      // average with the first hour makes startup allocation dominate for days.
      // Once enough time is covered, retain the bounded daily/weekly response.
      const warmupAlpha = elapsed / (g.measuredHours * HOUR + elapsed);
      const alpha = Math.max(warmupAlpha, -Math.expm1(-elapsed / DAY));
      const weeklyAlpha = Math.max(warmupAlpha, -Math.expm1(-elapsed / (7 * DAY)));
      g.bytesPerDay += alpha * (daily - g.bytesPerDay);
      g.bytesPerDay7d += weeklyAlpha * (daily - g.bytesPerDay7d);
      g.measuredHours += elapsed / HOUR; g.measuredAt = now; g.measuredBytes = bytes;
      g.metricsPrunedBefore = Math.floor(now/HOUR)*HOUR-7*DAY;
      this.store.db.prepare('DELETE FROM recorder_metrics WHERE bucket<?').run(g.metricsPrunedBefore);
    }
    return g;
  }

  adaptiveBudgetState() {
    return readAdaptiveBudget(this.store.db);
  }

  adaptiveBudget(now) {
    const budget = this.adaptiveBudgetState() ?? initialBudget(now), elapsed = now - budget.measuredAt;
    if (elapsed >= HOUR) {
      const daily = (budget.estimatedBytes - budget.measuredBytes) * DAY / elapsed;
      const alpha = 1 - Math.exp(-elapsed / DAY), weeklyAlpha = 1 - Math.exp(-elapsed / (7 * DAY));
      budget.bytesPerDay = budget.measuredHours ? budget.bytesPerDay + alpha * (daily - budget.bytesPerDay) : daily;
      budget.bytesPerDay7d = budget.measuredHours ? budget.bytesPerDay7d + weeklyAlpha * (daily - budget.bytesPerDay7d) : daily;
      // Only prospective adaptive observations price future precision. Exact
      // records, recovery, imports and SQLite allocation remain separate costs.
      const ratio = budget.bytesPerDay / (this.config.annualBudgetBytes * DAY / YEAR);
      const step = clamp(Math.log(Math.max(ratio, 0.05)) * Math.min(elapsed / DAY, 0.125), -0.12, 0.12);
      budget.tolerance = clamp(budget.tolerance * Math.exp(step), 1e-6, 10);
      budget.measuredHours += elapsed / HOUR; budget.measuredAt = now; budget.measuredBytes = budget.estimatedBytes;
    }
    return budget;
  }

  signalState(observation, now) {
    const key = keyOf(observation);
    const pending = this.pendingSignals.get(key);
    if (pending) return structuredClone(pending.state);
    return this.store.getState(stateKey(key)) ?? { key, source: observation.source, device: observation.device,
      signal: observation.signal, unit: observation.unit, startedAt: now, last: null, lastPollAt: null,
      lastSourceTime: null, mean: null, variance: 0, step: 0, scale: 0, previousValue: null,
      lastFreshAt: null, coverageId: null, status: null };
  }

  // A history mutation must compare the latest confirmed coverage, not an
  // older endpoint awaiting its ordinary batch. The caller flushes inside its
  // queued admission; this scope keeps later receipts immediate until it ends.
  holdMetadata() {
    const token = {};
    this.metadataHolds.add(token);
    return () => this.metadataHolds.delete(token);
  }

  setPendingSignal(key, value) {
    const previous = this.pendingSignals.get(key);
    this.store.afterRollback(() => {
      if (previous) this.pendingSignals.set(key, previous); else this.pendingSignals.delete(key);
    });
    if (value) this.pendingSignals.set(key, value); else this.pendingSignals.delete(key);
    this.store.afterCommit(() => this.scheduleMetadataFlush());
  }

  scheduleMetadataFlush() {
    const shutdown = this.store.writeQueue?.shutdown.signal;
    if (!this.pendingSignals.size || shutdown?.aborted) {
      clearTimeout(this.metadataTimer); this.metadataTimer = null;
      if (this.metadataAbort) shutdown?.removeEventListener('abort', this.metadataAbort);
      return;
    }
    if (this.metadataTimer) return;
    this.metadataAbort ??= () => { clearTimeout(this.metadataTimer); this.metadataTimer = null; };
    shutdown?.addEventListener('abort', this.metadataAbort, { once: true });
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = null;
      shutdown?.removeEventListener('abort', this.metadataAbort);
      if (shutdown?.aborted || !this.store.db.isOpen) return;
      // One queued flush for all unchanged streams. Never keep an SQLite
      // transaction open while waiting for more source messages.
      this.store.runWrite(() => this.flushMetadata(this.clock(), { force: true }))
        .catch(() => { this.scheduleMetadataFlush(); });
    }, METADATA_FLUSH_MS);
    this.metadataTimer.unref?.();
  }

  savePendingSignal(key) {
    const pending = this.pendingSignals.get(key);
    if (!pending) return;
    const { state, endAt, sourceTime, samples } = pending;
    this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+?,evidence=? WHERE id=?')
      .run(endAt, sourceTime, samples, state.recordingEvidence ? JSON.stringify(state.recordingEvidence) : null, state.coverageId);
    this.store.setState(stateKey(key), state);
    this.setPendingSignal(key, null);
  }

  flushMetadata(now, { force = false } = {}) {
    if (!this.pendingSignals.size) return;
    const due = force || this.pendingSignals.size >= MAX_PENDING_SIGNALS
      || [...this.pendingSignals.values()].some(row => now < row.firstAt || now - row.firstAt >= METADATA_FLUSH_MS);
    if (!due) return;
    for (const [key, row] of this.pendingSignals) if (row.endAt <= now) this.savePendingSignal(key);
    this.flushMetrics(now, { force: true });
  }

  /** Resume an already recorded connection after its bounded source-clock wait.
   * A held state is an availability event; a newly admitted native report retains
   * its own clocks and measurement count. Neither can repair an ordinary outage. */
  resumeCaravanRecording(reading, at = this.clock()) {
    if (!caravanState(reading) || !finiteTime(at) || !validRecordingWait(reading.raw?.sourceTimeWait))
      return { changed: false };
    return this.store.transaction(() => {
      const s = this.signalState(reading, at), wait = reading.raw.sourceTimeWait;
      this.savePendingSignal(s.key);
      // A queued writer can save the pause after the new source clock. Native
      // ordering and its actual admission proof govern the report, not gap time.
      const newReport = Number.isSafeInteger(reading.sourceTime) && reading.sourceTime > s.lastSourceTime;
      if (s.status !== 'unavailable' || !s.last || s.lastPollAt > at
        || !newReport && (s.lastSourceTime !== reading.sourceTime || s.previousValue !== reading.value)
        || newReport && !observationTimeAdmitted(reading, at)
        || !s.last.quality.includes('location-unconfirmed')
        || !s.last.quality.every(flag => ['location-unconfirmed', 'missing', 'unavailable'].includes(flag)))
        return { changed: false };
      const gap = this.store.db.prepare('SELECT * FROM active_observations WHERE id=?').get(s.last.id);
      const gapRaw = gap?.raw ? JSON.parse(gap.raw) : null;
      if (gap?.value !== null || gap.received_at !== wait.startedAt || !same(gapRaw?.sourceTimeWait, wait))
        return { changed: false };
      const prior = this.store.db.prepare(`SELECT c.source_time,c.end_at,c.evidence,o.raw,o.value FROM active_recorder_coverage c
        JOIN active_observations o ON o.id=c.observation_id WHERE c.source=? AND c.device=? AND c.signal=?
        AND c.status='fresh' AND c.end_at<=? AND ${selectedCoverageSpan('c', '?')}
        ORDER BY c.end_at DESC,c.start_at DESC,c.id DESC LIMIT 1`)
        .get(reading.source, reading.device, reading.signal, wait.startedAt, wait.startedAt);
      const priorRaw = prior?.raw ? JSON.parse(prior.raw) : null;
      const priorEvidence = prior?.evidence ? JSON.parse(prior.evidence) : null;
      const probe = evidence => evidence && Object.fromEntries(['method', 'meterSignature', 'startedAt', 'completedAt',
        'maxAgeMs', 'powerRiseW', 'powerFallW', 'minimumChangeW', 'phases'].map(key => [key, evidence[key]]));
      const fields = reading.value === 0 ? ['power'] : ['power', 'fanSpeed'];
      if (!prior || prior.source_time !== s.lastSourceTime || prior.value !== s.previousValue
        || priorRaw?.identity !== wait.identity || !same(probe(priorRaw.locationEvidence), probe(reading.raw.locationEvidence))
        || fields.some(field => (priorEvidence?.[field] ?? priorRaw.fieldTimestamps?.[field]) !== undefined
          && (!finiteTime(priorEvidence?.[field] ?? priorRaw.fieldTimestamps[field])
            || reading.raw.fieldTimestamps?.[field] < (priorEvidence?.[field] ?? priorRaw.fieldTimestamps[field]))))
        return { changed: false };
      const previousReport = s.lastReportTime;
      if (!previousReport || previousReport.sourceTime !== s.lastSourceTime) return { changed: false };
      // This bounded safety window includes every unit/policy and malformed
      // attempt. Seek receipts instead of sorting the retained stream prefix.
      for (const attempt of this.store.db.prepare(`SELECT value,quality,raw,received_at FROM active_observations
        WHERE +source=? AND +device=? AND +signal=? AND received_at>=? AND received_at<=? ORDER BY received_at,id`)
        .iterate(reading.source, reading.device, reading.signal, Math.max(previousReport.receivedAt, prior.end_at), at)) {
        const raw = attempt.raw ? JSON.parse(attempt.raw) : {}, quality = JSON.parse(attempt.quality);
        const fresh = attempt.value !== null && raw.recorder?.status === 'fresh' && quality.every(flag => flag === 'good');
        const waiting = attempt.value === null && attempt.received_at === wait.startedAt && same(raw.sourceTimeWait, wait)
          && quality.includes('location-unconfirmed')
          && quality.every(flag => ['location-unconfirmed', 'missing', 'unavailable'].includes(flag));
        if (!fresh && !waiting) return { changed: false };
      }
      const report = newReport ? { sourceTime: reading.sourceTime, receivedAt: reading.receivedAt,
        ...(reading.raw.timeAdmission ? { admittedAt: reading.raw.timeAdmission.admittedAt } : {}) } : previousReport;
      const admission = newReport ? reading.raw.timeAdmission : report.admittedAt === undefined ? undefined : sourceTimeAdmission({
        sourceTime: report.sourceTime, receivedAt: report.receivedAt, now: report.admittedAt, deferred: true });
      const previousAdmission = previousReport.admittedAt === undefined ? undefined : sourceTimeAdmission({
        sourceTime: previousReport.sourceTime, receivedAt: previousReport.receivedAt, now: previousReport.admittedAt, deferred: true });
      const basis = newReport ? 'recording-source-admission' : 'recording-availability-recovery';
      const raw = compactRaw({ ...reading.raw, timeAdmission: undefined,
        timeBasis: basis, availabilityRecoveredAt: at,
        originalReportSourceTime: report.sourceTime, originalReportReceivedAt: report.receivedAt,
        originalReportTimeBasis: 'mqtt-live-status', originalReportTimeAdmission: admission }, reading);
      raw.recorder = { version: VERSION, policy: recordingPolicy(reading).id, status: 'fresh',
        reason: basis, originalSourceTime: report.sourceTime, temporalBasis: newReport ? 'source-admission' : 'availability-recovery',
        ...(newReport ? { previousSourceTime: s.lastSourceTime, previousReportReceivedAt: previousReport.receivedAt,
          ...(previousAdmission ? { previousReportTimeAdmission: previousAdmission } : {}) } : {}) };
      const observation = { source: reading.source, device: reading.device, signal: reading.signal, unit: reading.unit,
        value: reading.value, sourceTime: reading.sourceTime, receivedAt: at, quality: flags(reading.quality), raw };
      if (!(newReport ? isCaravanRecordingAdmission(observation) : isCaravanRecordingRecovery(observation))) return { changed: false };
      observation.id = this.store.observation(observation);
      s.last = { id: observation.id, value: observation.value, sourceTime: observation.sourceTime, receivedAt: at,
        quality: observation.quality, semanticQuality: semanticQuality(raw, observation) };
      s.reportPolicy = { reportIntervalMs: raw.reportIntervalMs, reportGraceMs: raw.reportGraceMs ?? 0 };
      s.status = 'fresh'; s.recordingPolicy = raw.recorder.policy; s.lastPollAt = at; s.reportUnavailableSince = null;
      s.recordingEvidence = caravanRecordingEvidence(observation);
      s.coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(reading.source, reading.device, reading.signal, 'fresh', at, at, reading.sourceTime, observation.id, Number(newReport),
          s.recordingEvidence ? JSON.stringify(s.recordingEvidence) : null).lastInsertRowid);
      s.coverageObservationId = observation.id;
      if (newReport) { this.scale(s, reading.value, reading.sourceTime); s.lastSourceTime = reading.sourceTime; s.lastReportTime = report; }
      this.count(s, at, { saved: true, bytes: Buffer.byteLength(JSON.stringify(observation)), polls: Number(newReport) });
      this.store.setState(stateKey(s.key), s);
      return { changed: true, observation };
    });
  }

  /** A successful subscription repairs a transport outage, not a sensor's age.
   * The caller must confirm the configured route before using this method. */
  recoverTemperatureConnection(reading, policy, at = this.clock(), { routeSignature } = {}) {
    if (!INDOOR_SIGNALS.includes(reading?.signal) || reading.source !== 'mqtt-temperature' || reading.device !== reading.signal)
      return { changed: false };
    return this.transitionTemperatureReportPolicy(reading, policy, at, { recoverConnection: true, routeSignature });
  }

  /** Apply a report deadline prospectively, retaining an already known genuine
   * report. This is a policy event, never a new sensor report or an extension of
   * an old coverage span. Earlier missed-report intervals remain untouched. */
  transitionTemperatureReportPolicy(reading, policy, at = this.clock(), { recoverConnection = false, routeSignature } = {}) {
    const age = temperatureReportMaxAge({ raw: policy });
    if (!HELD_TEMPERATURE_SIGNALS.includes(reading?.signal) || age === null || !finiteTime(at))
      throw new TypeError('A held temperature and valid reporting policy are required');
    return this.store.transaction(() => {
      const s = this.signalState(reading, at);
      if (!s.last || s.lastPollAt > at) return { changed: false };
      const span = this.store.db.prepare(`SELECT c.*,o.value,o.unit,o.source_time AS observed_source_time,
        o.received_at AS observed_received_at,o.quality,o.raw FROM active_recorder_coverage c
        JOIN active_observations o ON o.id=c.observation_id WHERE c.source=? AND c.device=? AND c.signal=?
        AND c.status='fresh' AND c.start_at<=? AND c.end_at<=? AND ${selectedCoverageSpan('c', '?')}
        ORDER BY c.start_at DESC,c.id DESC LIMIT 1`)
        .get(reading.source, reading.device, reading.signal, at, at, at);
      const previousRaw = span?.raw ? JSON.parse(span.raw) : reading.raw ?? {};
      const sourceTime = span?.source_time ?? reading.sourceTime;
      const lastReportTime = s.lastReportTime?.sourceTime === sourceTime ? s.lastReportTime : null;
      const receivedAt = lastReportTime?.receivedAt ?? (span ? span.source_time === span.observed_source_time
        ? previousRaw.originalReportReceivedAt ?? span.observed_received_at : span.end_at : reading.receivedAt);
      const reportAdmission = lastReportTime
        ? lastReportTime.admittedAt === undefined ? undefined
          : sourceTimeAdmission({ sourceTime, receivedAt, now: lastReportTime.admittedAt, deferred: true })
        : previousRaw.originalReportTimeAdmission ?? previousRaw.timeAdmission;
      const value = span?.value ?? reading.value, unit = span?.unit ?? reading.unit;
      if (!recoverConnection && same(s.reportPolicy, policy)) return { changed: false, reportSourceTime: sourceTime, reportReceivedAt: receivedAt,
        observation: { source: reading.source, device: reading.device, signal: reading.signal, ...s.last, unit,
          raw: { ...policy, timeBasis: s.last.semanticQuality?.timeBasis,
            ...(s.last.timeAdmission ? { timeAdmission: s.last.timeAdmission } : {}) } } };
      const quality = span?.quality ? JSON.parse(span.quality) : reading.quality ?? [];
      const lastQuality = s.last.quality ?? [];
      const ageOnly = lastQuality.every(flag => ['missing', 'missing-report', 'report-policy-changed', 'stale', 'unavailable'].includes(flag))
        && (s.status === 'stale' || lastQuality.some(flag => ['missing-report', 'report-policy-changed'].includes(flag)));
      const genuine = observationTimeAdmitted({ sourceTime, receivedAt, raw: { timeAdmission: reportAdmission } }, at)
        && Number.isFinite(value) && ['degC', '°C'].includes(unit)
        && (['garage_temperature', 'garage_temperature_2'].includes(reading.signal) ? value >= -60 && value <= 70 : value > 2 && value < 40)
        && quality.every(flag => ['good', 'simulated', 'historical', 'converted_fahrenheit', 'stale'].includes(flag))
        && !previousRaw.retained && !previousRaw.acquisitionOnly && !previousRaw.auditOnly;
      if (recoverConnection) {
        const previousSignature = previousRaw.temperatureRouteSignature;
        if (typeof routeSignature !== 'string' || !/^[a-f0-9]{64}$/.test(routeSignature)
          || previousSignature !== routeSignature)
          return { changed: false };
        if (!genuine || at >= sourceTime + age) return { changed: false };
        if (s.status === 'fresh') return { changed: false, reportSourceTime: sourceTime, reportReceivedAt: receivedAt,
          observation: { ...reading, sourceTime, receivedAt, value, unit, quality,
            raw: { ...previousRaw, ...policy, timeAdmission: reportAdmission, temperatureRouteSignature: routeSignature } } };
        const transport = flag => ['mqtt-disconnected', 'mqtt-subscription-failed'].includes(flag);
        const allowed = flag => transport(flag) || ['missing', 'failed', 'unavailable', 'stale', 'missing-report', 'report-policy-changed'].includes(flag);
        if (!lastQuality.some(transport) || !lastQuality.every(allowed)) return { changed: false };
        // A subsequent disconnect must not hide an earlier invalid payload.
        // Start at the genuine receipt, not a later policy/recovery event time.
        const attempts = this.store.db.prepare(`SELECT quality,raw FROM active_observations AS observations WHERE source=? AND device=? AND signal=?
          AND signal IN ('indoor_temperature','downstairs_temperature','bedroom_temperature','garage_temperature','garage_temperature_2','outdoor_temperature')
          AND received_at>=? AND received_at<=? AND id>? ORDER BY received_at,id`)
          .all(reading.source, reading.device, reading.signal, receivedAt, at, span?.observation_id ?? reading.id ?? 0);
        for (const attempt of attempts) {
          const attemptRaw = attempt.raw ? JSON.parse(attempt.raw) : {}, attemptQuality = JSON.parse(attempt.quality);
          if (attemptRaw.retained || attemptQuality.includes('retained')) continue;
          const valid = attemptQuality.every(flag => ['good', 'converted_fahrenheit'].includes(flag))
            && (!attemptRaw.recorder || attemptRaw.recorder.status === 'fresh');
          const transportOnly = attemptQuality.some(transport) && attemptQuality.every(allowed);
          const ageOnly = attemptQuality.some(flag => ['missing-report', 'report-policy-changed'].includes(flag))
            && attemptQuality.every(flag => ['missing', 'stale', 'unavailable', 'missing-report', 'report-policy-changed'].includes(flag));
          if (!valid && !transportOnly && !ageOnly) return { changed: false };
        }
      }
      const fresh = genuine && (s.status === 'fresh' || ageOnly || recoverConnection) && at < sourceTime + age;
      const q = fresh ? quality.filter(flag => flag !== 'stale') : flags(['missing',
        ...(s.status !== 'fresh' && !ageOnly ? lastQuality : ['missing-report'])]);
      const raw = compactRaw({ ...previousRaw, ...policy, timeAdmission: undefined,
        originalReportTimeAdmission: reportAdmission,
        timeBasis: recoverConnection ? 'mqtt-transport-recovery' : 'report-policy-change',
        ...(recoverConnection ? { transportRecoveredAt: at, temperatureRouteSignature: routeSignature } : { reportPolicyChangedAt: at }), originalReportReceivedAt: receivedAt,
        originalReportSourceTime: sourceTime,
        originalReportTimeBasis: previousRaw.originalReportTimeBasis ?? previousRaw.timeBasis }, reading);
      raw.recorder = { version: VERSION, policy: recordingPolicy({ ...reading, raw }).id,
        reason: recoverConnection ? 'mqtt-transport-recovery' : 'report-policy-change', status: fresh ? 'fresh' : 'unavailable',
        originalSourceTime: sourceTime, temporalBasis: recoverConnection ? 'transport-recovery' : 'policy-change' };
      const observation = { source: reading.source, device: reading.device, signal: reading.signal,
        value: fresh ? value : null, unit, sourceTime: fresh ? sourceTime : null, receivedAt: at, quality: q, raw };
      const id = this.store.observation(observation);
      observation.id = id;
      s.last = { id, value: observation.value, sourceTime: observation.sourceTime, receivedAt: at,
        quality: q, semanticQuality: semanticQuality(raw) };
      s.unit = unit; s.reportPolicy = { ...policy }; s.status = fresh ? 'fresh' : 'unavailable';
      s.recordingPolicy = raw.recorder.policy;
      s.coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,0)`)
        .run(reading.source, reading.device, reading.signal, s.status, at, at, fresh ? sourceTime : null, id).lastInsertRowid);
      s.coverageObservationId = id; s.lastPollAt = at;
      s.reportUnavailableSince = fresh ? null : s.reportUnavailableSince ?? at;
      this.count(s, at, { saved: true, bytes: Buffer.byteLength(JSON.stringify(observation)), polls: 0 });
      this.store.setState(stateKey(s.key), s);
      return { changed: true, observation, reportSourceTime: sourceTime, reportReceivedAt: receivedAt };
    });
  }

  classify(o, state) {
    const q = flags(o.quality);
    const contact = contactReport(o);
    if (q.some(x => /failed|disconnected|fetch-error|acquisition-failed|provider[-_]error/.test(x))) return 'failed';
    if (o.value === null || !Number.isFinite(o.sourceTime) || q.some(x => /missing|invalid|retained|unavailable/.test(x))) return 'unavailable';
    if (hasCaravanEvidence(o)) {
      const evidence = caravanRecordingEvidence(o), deadline = caravanEvidenceDeadline(evidence);
      const availableAt = observationAvailableAt(o) ?? o.receivedAt;
      if (deadline === null || Math.max(evidence.power, evidence.fanSpeed ?? 0, evidence.meter?.observedAt ?? 0) > availableAt
        || o.sourceTime !== Math.max(evidence.power, evidence.fanSpeed ?? evidence.power)) return 'unavailable';
      if (availableAt >= deadline) return 'stale';
    }
    if (q.some(x => /stale|out-of-order/.test(x)) || !observationTimeAdmitted(o, o.raw?.timeAdmission ? this.clock() : Infinity)
      || (temperatureReportMaxAge(o) !== null
        ? o.receivedAt - o.sourceTime >= sourceAge(o) : o.receivedAt - o.sourceTime > sourceAge(o))
      || temperatureReportMaxAge(o) !== null && state.status && state.status !== 'fresh'
        && (o.sourceTime < state.lastSourceTime || !contact && o.sourceTime === state.lastSourceTime)
      || temperatureReportMaxAge(o) !== null && state.reportUnavailableSince != null
        && o.sourceTime < state.reportUnavailableSince
      || !contact && temperatureReportMaxAge(o) !== null && o.sourceTime === state.lastSourceTime
        && o.value !== state.previousValue
      || state.lastSourceTime != null && o.sourceTime < state.lastSourceTime) return 'stale';
    return 'fresh';
  }

  scale(state, value, at) {
    if (!Number.isFinite(value)) return;
    if (state.mean === null) state.mean = value;
    const dt = Math.max(1, at - (state.lastFreshAt ?? at)), alpha = clamp(1 - Math.exp(-dt / DAY), 0.002, 0.2);
    const delta = value - state.mean, change = state.previousValue === null ? 0 : Math.abs(value - state.previousValue);
    state.mean += alpha * delta;
    state.variance = (1 - alpha) * (state.variance + alpha * delta * delta);
    if (change > 0) state.step = state.step > 0 ? Math.min(state.step * 1.002, change) : change;
    // A learned quantization floor prevents numerical noise from dominating a
    // nearly constant signal. The other term scales with sustained variation.
    state.scale = Math.max(Math.sqrt(state.variance), state.step, Math.abs(value) * Number.EPSILON * 32, Number.EPSILON);
    state.previousValue = value; state.lastFreshAt = at;
  }

  count(state, now, { saved = false, error = null, elapsed = 0, bytes = 0, polls = 1 } = {}) {
    const hour = Math.floor(now / HOUR) * HOUR;
    const errorTime = Number.isFinite(error) && elapsed>0 ? elapsed : 0;
    const id = JSON.stringify([state.key, hour]);
    const increment = { key: state.key, bucket: hour, polls, records: Number(saved), bytes,
      first_saved_at: saved ? now : null, last_saved_at: saved ? now : null,
      error_squared_time: errorTime ? error * error * errorTime : 0, error_time: errorTime,
      stale: polls * Number(state.status === 'stale'), failed: polls * Number(state.status === 'failed'),
      unavailable: polls * Number(state.status === 'unavailable') };
    const previous = this.pendingMetrics.get(id);
    const pending = { ...(previous ? combineMetrics(previous, increment) : increment),
      firstPendingAt: previous?.firstPendingAt ?? now, lastPendingAt: now };
    this.setPendingMetrics(id, pending);
    // New hour rows remain explicit even if this receipt selected no record.
    // Record counts, bytes and extrema always commit with their observation.
    if (saved || now - pending.firstPendingAt >= METRIC_FLUSH_MS
      || !previous && !this.store.db.prepare('SELECT 1 FROM recorder_metrics WHERE key=? AND bucket=?').get(state.key, hour))
      this.savePendingMetrics(id, now);
    if (this.pendingMetrics.size > MAX_PENDING_METRIC_BUCKETS)
      this.savePendingMetrics(this.pendingMetrics.keys().next().value, now);
  }

  setPendingMetrics(id, value) {
    const previous = this.pendingMetrics.get(id);
    this.store.afterRollback(() => {
      if (previous) this.pendingMetrics.set(id, previous); else this.pendingMetrics.delete(id);
    });
    if (value) this.pendingMetrics.set(id, value); else this.pendingMetrics.delete(id);
  }

  savePendingMetrics(id, now) {
    const row = this.pendingMetrics.get(id);
    if (!row) return;
    if (row.bucket < Math.floor(now / HOUR) * HOUR - 7 * DAY) {
      this.setPendingMetrics(id, null);
      return;
    }
    this.store.db.prepare(`INSERT INTO recorder_metrics
      (key,bucket,polls,records,first_saved_at,last_saved_at,bytes,error_squared_time,error_time,stale,failed,unavailable) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key,bucket) DO UPDATE SET polls=polls+excluded.polls,records=records+excluded.records,bytes=bytes+excluded.bytes,
      first_saved_at=CASE WHEN excluded.first_saved_at IS NULL THEN first_saved_at
        WHEN first_saved_at IS NULL THEN excluded.first_saved_at ELSE MIN(first_saved_at,excluded.first_saved_at) END,
      last_saved_at=CASE WHEN excluded.last_saved_at IS NULL THEN last_saved_at
        WHEN last_saved_at IS NULL THEN excluded.last_saved_at ELSE MAX(last_saved_at,excluded.last_saved_at) END,
      error_squared_time=error_squared_time+excluded.error_squared_time,error_time=error_time+excluded.error_time,
      stale=stale+excluded.stale,failed=failed+excluded.failed,unavailable=unavailable+excluded.unavailable`)
      .run(row.key,row.bucket,row.polls,row.records,row.first_saved_at,row.last_saved_at,row.bytes,
        row.error_squared_time,row.error_time,row.stale,row.failed,row.unavailable);
    this.setPendingMetrics(id, null);
  }

  flushMetrics(now, { force = false } = {}) {
    const hour = Math.floor(now / HOUR) * HOUR, oldest = hour - 7 * DAY;
    for (const [id, row] of this.pendingMetrics) {
      // A long suspended runtime must not resurrect already expired statistics.
      if (row.bucket < oldest) this.setPendingMetrics(id, null);
      else if (force || row.bucket < hour || now - row.firstPendingAt >= METRIC_FLUSH_MS)
        this.savePendingMetrics(id, now);
    }
  }

  metricHistory(rows, key, from, to, now, prunedBefore) {
    const history = new Map(rows.map(row => [row.bucket, row]));
    for (const row of this.pendingMetrics.values()) {
      if (row.key !== key || row.bucket < Math.max(from, prunedBefore) || row.bucket > to || row.lastPendingAt > now) continue;
      const saved = history.get(row.bucket);
      history.set(row.bucket, saved ? combineMetrics(saved, row) : row);
    }
    return [...history.values()].sort((a,b) => a.bucket - b.bucket);
  }

  coverage(state, o, status, freshUpdate = true, reportPolicyChanged = false, evidence = null) {
    // Coverage describes successful source updates and availability separately
    // from the value approximation. An unchanged OLD timestamp never advances
    // measurement freshness, even though its HTTP request succeeded.
    const at = status === 'fresh' ? observationAvailableAt(o) ?? o.receivedAt : o.receivedAt;
    const observed = Number.isFinite(o.sourceTime) ? o.sourceTime : null;
    // Polling a cached MQTT reading is not another detector report. Keep the
    // compact span's endpoint on the actual report's source and receipt clocks.
    if (!evidence && temperatureReportMaxAge(o) !== null && status === 'fresh' && !freshUpdate) {
      if (reportPolicyChanged) {
        // A revised remaining lifetime changes availability from this receipt,
        // but is not another source measurement or an edit of earlier history.
        state.coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
          (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,0)`)
          .run(o.source,o.device,o.signal,status,at,at,observed,state.last?.id ?? null).lastInsertRowid);
        state.coverageObservationId = state.last?.id ?? null;
        state.status = status;
      }
      return;
    }
    // If recording is configured less often than source freshness, two fresh
    // polls can still surround an unobserved gap. Preserve separate spans even
    // when both polls map to the same saved value. Receipt must also precede
    // expiry of the previous source reading: a later arrival cannot prove that
    // an earlier controller already had fresh data. This makes every historical
    // prefix of an extended span independently valid.
    const continuous = evidence ? caravanEvidenceContinues(state.recordingEvidence, evidence, at)
      : status !== 'fresh' || !Number.isFinite(state.lastSourceTime)
        || observed - state.lastSourceTime <= sourceAge(o) && at - state.lastSourceTime <= sourceAge(o);
    if (state.coverageId && state.status === status && state.coverageObservationId === state.last?.id && continuous) {
      this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+?,evidence=? WHERE id=?')
        .run(at, observed, evidence ? Number(freshUpdate) : 1, evidence ? JSON.stringify(evidence) : null, state.coverageId);
    } else {
      state.coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(o.source,o.device,o.signal,status,at,at,observed,state.last?.id ?? null,
          evidence ? Number(freshUpdate) : 1, evidence ? JSON.stringify(evidence) : null).lastInsertRowid);
      state.coverageObservationId = state.last?.id ?? null;
    }
    state.status = status;
  }

  record(observation, { force = false, kind } = {}) {
    const o = { ...observation, receivedAt: observation.receivedAt ?? this.clock(), sourceTime: observation.sourceTime ?? null,
      quality: flags(observation.quality), raw: observation.raw ?? null };
    o.recordingPolicy = recordingPolicy(o, { kind }).id;
    if (!finiteTime(o.receivedAt)) throw new TypeError('Invalid recorder receipt timestamp');
    if (!isRecordedDataset(o) || o.raw?.acquisitionOnly || o.raw?.auditOnly || o.source === 'husdata-h66' && DISABLED_H66.has(o.signal))
      return { saved: false, reason: 'not-in-recorded-dataset', observation: null };
    if ((o.raw?.retained === true || o.quality.includes('retained')) && o.raw?.reportIntervalMs !== 0
      && (temperatureReportMaxAge(o) !== null || this.store.getState(stateKey(keyOf(o)))?.reportPolicy))
      // Broker replay is neither a detector report nor an availability change.
      // A recorded disconnect remains in force until a genuine newer report.
      return { saved:false,reason:'retained-periodic-report',observation:null };
    return this.store.transaction(() => {
      const policy = recordingPolicy(o, { kind });
      const budget = policy.adaptive ? this.adaptiveBudget(o.receivedAt) : null;
      const s = this.signalState(o,o.receivedAt), g = this.storageMetrics(o.receivedAt);
      if (o.source === 'mqtt-equipment' && o.unit === 'state' && typeof o.raw?.eventOnly === 'boolean') s.eventOnly = o.raw.eventOnly;
      if (o.raw?.reportIntervalMs === 0) {
        delete s.reportPolicy;
        delete s.reportUnavailableSince;
      }
      if (o.raw?.reportIntervalMs === undefined && s.reportPolicy
        && (o.value === null || o.quality.some(flag=>/failed|disconnected|missing|invalid|unavailable/.test(flag))))
        o.raw = { ...o.raw, ...s.reportPolicy };
      const periodic = temperatureReportMaxAge(o) !== null;
      if (periodic) s.reportPolicy = { reportIntervalMs:o.raw.reportIntervalMs,reportGraceMs:o.raw.reportGraceMs ?? 0 };
      if (s.lastPollAt !== null && o.receivedAt < s.lastPollAt) return { saved: false, reason: 'out-of-order-receipt', observation: null };
      // Indoor age alone is usable. Keep source rollback distinguishable from
      // age so restoring the last known reading cannot revive a delayed value.
      if (HELD_TEMPERATURE_SIGNALS.includes(o.signal) && Number.isFinite(o.sourceTime)
        && (s.lastSourceTime != null && o.sourceTime < s.lastSourceTime
          || periodic && (o.sourceTime===s.lastSourceTime && o.value!==s.previousValue
            || s.reportUnavailableSince!=null && (o.sourceTime<s.reportUnavailableSince || o.sourceTime<=s.lastSourceTime))))
        o.quality = flags([...o.quality, 'out-of-order-source-time']);
      const status = this.classify(o,s), fresh = status === 'fresh';
      const evidence = fresh ? caravanRecordingEvidence(o) : null;
      const freshUpdate = fresh && (contactReport(o) || s.lastSourceTime === null || o.sourceTime > s.lastSourceTime
        || o.sourceTime === s.lastSourceTime && s.previousValue !== o.value);
      // Coverage stores admission endpoints. Keep the latest genuine report's
      // original clocks independently so policy/reconnect events cannot mistake
      // a deferred endpoint for another physical receipt.
      if (freshUpdate) s.lastReportTime = { sourceTime: o.sourceTime, receivedAt: o.receivedAt,
        ...(o.raw?.timeAdmission ? { admittedAt: o.raw.timeAdmission.admittedAt } : {}) };
      if (freshUpdate) this.scale(s,o.value,o.sourceTime);
      const exact = !policy.adaptive;
      s.recordingPolicy = policy.id;
      const changed = s.last === null || o.value !== s.last.value;
      const transition = s.last && (status !== s.status || !same(o.quality,s.last.quality)
        || o.unit!==s.unit || !same(semanticQuality(o.raw,o),s.last.semanticQuality??{}));
      const crossingZero = /pump_speed$/.test(o.signal) && s.last && (o.value === 0) !== (s.last.value === 0);
      const threshold = Math.max(valueFloor(o),s.scale * (budget?.tolerance ?? 0),numericalFloor(o.value,s.last?.value));
      let reason = !s.last ? 'initial' : transition ? 'quality-or-availability' : force ? 'forced'
        : freshUpdate && (crossingZero || exact && changed) ? 'state-change'
        : freshUpdate && changed && Math.abs(o.value - s.last.value) > threshold ? 'learned-change' : null;
      // Repeated unavailable/stale polls compact into coverage, never fake data.
      if (!fresh && s.last && !transition && !force) reason = null;
      const prior = s.last;
      const reportPolicyChanged = periodic && prior && temperatureReportMaxAge({ raw: prior.semanticQuality }) !== temperatureReportMaxAge(o);
      const cachedPolicyChange = reportPolicyChanged && fresh && !freshUpdate;
      let committed = null;
      if (reason) {
        const raw = compactRaw(o.raw, o);
        if (cachedPolicyChange) {
          const report = this.store.db.prepare(`SELECT c.end_at,c.source_time,o.source_time AS original_source_time,o.raw
            FROM active_recorder_coverage c JOIN active_observations o ON o.id=c.observation_id WHERE c.id=?`).get(s.coverageId);
          const previousRaw = report?.raw ? JSON.parse(report.raw) : {};
          const original = s.lastReportTime?.sourceTime === o.sourceTime ? s.lastReportTime : null;
          const originalReceivedAt = original?.receivedAt ?? (report?.source_time === report?.original_source_time
            ? previousRaw.originalReportReceivedAt ?? previousRaw.timeAdmission?.receivedAt ?? prior.receivedAt : report?.end_at ?? prior.receivedAt);
          const originalAdmission = original ? original.admittedAt === undefined ? undefined : sourceTimeAdmission({
            sourceTime: original.sourceTime, receivedAt: original.receivedAt, now: original.admittedAt, deferred: true })
            : previousRaw.originalReportTimeAdmission ?? previousRaw.timeAdmission;
          delete raw.timeAdmission;
          Object.assign(raw, { timeBasis: 'report-policy-change', reportPolicyChangedAt: o.receivedAt,
            originalReportSourceTime: o.sourceTime,
            originalReportReceivedAt: originalReceivedAt,
            originalReportTimeAdmission: originalAdmission,
            originalReportTimeBasis: previousRaw.originalReportTimeBasis ?? previousRaw.timeBasis ?? o.raw?.timeBasis });
        }
        raw.recorder = { version: VERSION, policy: policy.id, reason: cachedPolicyChange ? 'report-policy-change' : reason,
          threshold: exact ? null : threshold, originalSourceTime: o.sourceTime, status,
          temporalBasis: cachedPolicyChange ? 'policy-change' : 'source-observation' };
        committed = { ...o, raw, quality: fresh ? o.quality : flags([...o.quality,status]) };
        committed.id = this.store.observation(committed);
        s.last = { id:committed.id,value:o.value,sourceTime:o.sourceTime,receivedAt:o.receivedAt,
          ...(o.raw?.timeAdmission ? { timeAdmission: o.raw.timeAdmission } : {}),
          quality:o.quality,usableForControl:o.raw?.usableForControl,semanticQuality:semanticQuality(o.raw,o) };
        s.unit=o.unit;
      }
      // Only an exactly unchanged, continuously fresh scalar can wait. A gap,
      // actual change, force, policy/quality boundary or energy receipt flushes
      // its earlier endpoint before recording the new evidence.
      const pending = this.pendingSignals.get(s.key);
      const coalesce = !this.metadataHolds.size && (COALESCED_SOURCES.has(o.source) || evidence) && o.unit !== 'kWh' && !reason && !force
        && (evidence ? caravanEvidenceContinues(s.recordingEvidence, evidence, observationAvailableAt(o) ?? o.receivedAt) : freshUpdate)
        && fresh && prior && o.value === prior.value && !transition && !reportPolicyChanged
        && s.status === status && s.coverageId && s.coverageObservationId === prior.id
        && Number.isFinite(s.lastSourceTime) && o.sourceTime - s.lastSourceTime <= sourceAge(o)
        && o.receivedAt - s.lastSourceTime <= sourceAge(o);
      if (!coalesce) {
        if (pending) this.savePendingSignal(s.key);
        this.coverage(s,o,status,freshUpdate,reportPolicyChanged,evidence);
      }
      if (evidence) s.recordingEvidence = evidence;
      else delete s.recordingEvidence;
      if (periodic) s.reportUnavailableSince = fresh ? null : s.reportUnavailableSince ?? o.receivedAt;
      const elapsed = s.lastPollAt === null ? 0 : Math.min(o.receivedAt - s.lastPollAt,sourceAge(o));
      // Error is the held saved value at every acquisition, time weighted so
      // bursts of readings do not count as extra independent accuracy evidence.
      const error = policy.adaptive && fresh && prior && s.scale > 0 ? Math.abs(o.value-prior.value)/s.scale : null;
      this.count(s,o.receivedAt,{saved:Boolean(reason),error,elapsed,bytes:committed ? Buffer.byteLength(JSON.stringify(committed)) : 0});
      if (budget) {
        if (committed) budget.estimatedBytes += observationBytes(committed);
        this.store.setState(ADAPTIVE_BUDGET_KEY,budget);
      }
      s.lastPollAt = o.receivedAt;
      if (fresh) s.lastSourceTime = Math.max(s.lastSourceTime ?? o.sourceTime,o.sourceTime);
      if (coalesce) this.setPendingSignal(s.key, { state: s, firstAt: pending?.firstAt ?? o.receivedAt,
        endAt: observationAvailableAt(o) ?? o.receivedAt, sourceTime: o.sourceTime,
        samples: (pending?.samples ?? 0) + (evidence ? Number(freshUpdate) : 1) });
      else this.store.setState(stateKey(s.key),s);
      this.store.setState(STORAGE_METRICS_KEY,g);
      this.flushMetadata(o.receivedAt);
      if (!this.observedStreams.has(s.key)) this.store.afterRollback(() => this.observedStreams.delete(s.key));
      this.observedStreams.add(s.key);
      return { saved:Boolean(reason),id:committed?.id ?? null,observation:committed,reason:reason ?? (freshUpdate ? 'within-threshold' : 'unchanged-source-time'),
        ...(o.quality.includes('out-of-order-source-time') ? { rejectedSourceTime: true } : {}) };
    });
  }

  recordFailure({ source, device, signal, unit, at = this.clock(), quality = ['acquisition-failed'], raw }) {
    return this.record({source,device,signal,unit,value:null,sourceTime:null,receivedAt:at,quality,...(raw ? {raw} : {})});
  }

  /** Input intervals already integrate every usable fast acquisition. Pending
   * increments and inserts share a transaction; retries cannot count energy twice.
   */
  recordEnergy(interval) {
    const { source = 'easee', device, prefix, start, end, energies, powers, quality = [], receivedAt = end, admittedAt } = interval;
    const transport = recordedTransport(interval);
    const signals = energySignals(prefix);
    if (!signals || !finiteTime(start) || !finiteTime(end) || end <= start
      || !validateAdmittedSourceTime({ sourceTime: end, receivedAt, admittedAt, now: admittedAt === undefined ? Infinity : this.clock() }) || !Array.isArray(energies) || energies.length !== signals.length
      || energies.some(n => !Number.isFinite(n) || n < 0) || !Array.isArray(powers) || powers.length !== signals.length
      || powers.some(n => !Number.isFinite(n) || n < 0)) throw new TypeError('Invalid phase energy interval');
    return this.store.transaction(() => {
      const checkpointKey = `recorder:energy:${JSON.stringify([source,device,prefix])}`;
      const state = this.store.getState(checkpointKey) ?? { lastEnd:null,pending:null,lastPowers:null,scales:signals.map(()=>null),lastQuality:null };
      if (state.lastEnd !== null && end <= state.lastEnd) return { saved:false,reason:'duplicate-interval',observations:[] };
      if (state.lastEnd !== null && start < state.lastEnd) throw new Error('Overlapping energy integration intervals');
      if (state.lastReceivedAt != null && receivedAt < state.lastReceivedAt)
        throw new TypeError('Out-of-order energy receipt');
      const budget = this.adaptiveBudget(receivedAt);
      const q = flags(quality), g = this.storageMetrics(receivedAt), observations = [];
      const native = nativeChargerEnergy(prefix), powerFloor = chargerEnergy(prefix) ? CHARGER_POWER_FLOOR_KW : 0;
      const previousPowers = native ? state.lastSelectionPowers ?? null : state.lastPowers;
      const zero = powers.every(value=>value===0) && energies.every(value=>value===0);
      // Recovery preserves original donor evidence without replacing live
      // acquisition cursors. A subsequent local interval can straddle that
      // recovered history. Keep the recovered evidence, skip the indivisible
      // local interval and advance normally, so retries cannot double count or
      // permanently stall acquisition. Any uncovered remainder is a real gap.
      let recoveredEnd = null;
      const availableAt = Math.max(receivedAt, admittedAt ?? 0);
      for (const row of this.store.db.prepare(`SELECT o.source_time,o.received_at,o.quality,o.raw FROM active_observations o
        WHERE o.signal IN (${signals.map(()=>'?').join(',')}) AND o.unit='kWh' AND o.value>=0
          AND o.import_id IS NULL AND o.source_time>? AND o.source_time<=? AND o.received_at<=?
          AND ${source === 'simulation' ? "o.source='simulation'" : "o.source<>'simulation'"}
          AND json_valid(o.raw) AND json_extract(o.raw,'$.intervalStart')<?
          AND EXISTS (SELECT 1 FROM recovery_provenance p WHERE p.table_name IN ('observations','recorder_pending_energy')
            AND p.target_id=CAST(o.id AS TEXT) AND p.disposition='missing')`)
        .iterate(...signals,start,availableAt,availableAt,end)) {
        const raw = JSON.parse(row.raw);
        let quality; try { quality = JSON.parse(row.quality); } catch { continue; }
        if (raw.timeBasis === 'completed-hour' || raw.auditOnly || raw.acquisitionOnly || !validEnergyQuality(quality)
          || !finiteTime(raw.intervalStart) || raw.intervalEnd !== row.source_time
          || raw.intervalEnd <= raw.intervalStart || !observationTimeAdmitted({
            sourceTime: row.source_time, receivedAt: row.received_at, raw,
          }, availableAt)) continue;
        recoveredEnd = Math.max(recoveredEnd ?? -Infinity,raw.intervalEnd);
      }
      if (recoveredEnd !== null) {
        observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,'recovery-boundary',budget));
        state.lastEnd=end; state.lastReceivedAt=receivedAt; state.lastPowers=null; state.lastQuality=null;
        state.lastSelectionPowers=null;
        this.store.setState(checkpointKey,state);
        g.energyRevision++; this.store.setState(STORAGE_METRICS_KEY,g);
        this.store.setState(ADAPTIVE_BUDGET_KEY,budget);
        if (recoveredEnd<end) observations.push(...this.energyGap({source,device,prefix,start:Math.max(start,recoveredEnd),end,
          receivedAt,admittedAt,quality:['recovery-overlap','missing']}));
        return {saved:observations.length>0,reason:'recovered-interval-overlap',observations};
      }
      // Close the previous valid interval before any gap or quality transition;
      // do not spread its energy over missing time or blend measurement bases.
      if (state.pending && (state.pending.end !== start || (state.pending.transport ?? null) !== transport || !sameEnergyQuality(state.pending.quality,q,
        {zeroA:state.pending.energies.every(value=>value===0),zeroB:zero})))
        observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,'boundary',budget));
      // A native counter may hold its value between quantized increments while
      // reporting positive instantaneous power. Compare like with like for
      // selection; reconstructible interval power still describes its energy.
      const selectionPowers = native ? state.lastSelectionPowers ?? null : state.lastPowers;
      let changed = false;
      for (let i=0;i<signals.length;i++) {
        const s = state.scales[i] ?? {mean:null,variance:0,step:0,previousValue:null,lastFreshAt:null,scale:0};
        this.scale(s,powers[i],end); state.scales[i] = s;
        if (selectionPowers && (((powers[i] === 0) !== (selectionPowers[i] === 0)
            && Math.max(powers[i],selectionPowers[i]) > powerFloor)
          || Math.abs(powers[i]-selectionPowers[i]) > Math.max(powerFloor,s.scale*budget.tolerance,numericalFloor(powers[i],selectionPowers[i])))) changed = true;
      }
      const reason = selectionPowers === null ? 'initial' : !sameEnergyQuality(state.lastQuality,q,
        {zeroA:state.lastPowers?.every(value=>value===0),zeroB:zero}) ? 'quality-or-availability'
        : changed ? 'learned-change' : null;
      // Keep a newly detected transition out of the preceding steady span;
      // blending it backwards would distort already observed history.
      if (reason && state.pending)
        observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,'power-boundary',budget));
      if (!state.pending) state.pending = {start,end,receivedAt,energies:signals.map(()=>0),quality:q,
        ...(transport ? {transport} : {})};
      for (let i=0;i<signals.length;i++) state.pending.energies[i] += energies[i];
      state.pending.quality = flags([...state.pending.quality,...q]);
      if (native) state.pending.selectionPowers = [...powers];
      state.pending.end = end; state.pending.receivedAt = receivedAt;
      // A later packet may already have arrived while an earlier ordered
      // report was pending. Its original receipt cannot erase that wait.
      if (admittedAt !== undefined || state.pending.admittedAt !== undefined)
        state.pending.admittedAt = Math.max(state.pending.admittedAt ?? 0, admittedAt ?? receivedAt);
      state.lastEnd = end; state.lastReceivedAt = receivedAt;
      // Only complete valid zero charger tails can keep a proven unchanged
      // prefix indefinitely. Other adaptive groups close at a genuine accepted
      // acquisition boundary after a day. Preserve exact integrated energy,
      // including a single original interval longer than a day; no timer
      // creates observations or turns unknown quality into valid idle evidence.
      const compactIdle = ['ev1', 'ev2'].includes(prefix) && validEnergyQuality(state.pending.quality)
        && state.pending.energies.every(value => value === 0);
      const durationBoundary = !compactIdle && state.pending.end - state.pending.start >= 24 * HOUR;
      if (reason || durationBoundary) observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,reason ?? 'duration-boundary',budget));
      for (let i=0;i<signals.length;i++) {
        const s = this.signalState({source,device,signal:signals[i],unit:'kWh'},receivedAt);
        s.scale = state.scales[i].scale; s.lastPollAt = receivedAt; s.recordingPolicy = 'adaptive-energy';
        this.count(s,receivedAt,{elapsed:end-start,error:previousPowers && s.scale>0 ? Math.abs(powers[i]-previousPowers[i])/s.scale : null});
        this.store.setState(stateKey(s.key),s);
        if (!this.observedStreams.has(s.key)) this.store.afterRollback(() => this.observedStreams.delete(s.key));
        this.observedStreams.add(s.key);
      }
      g.energyRevision++;
      this.store.setState(checkpointKey,state); this.store.setState(STORAGE_METRICS_KEY,g);
      this.store.setState(ADAPTIVE_BUDGET_KEY,budget);
      return {saved:observations.length>0,reason:reason ?? (durationBoundary ? 'duration-boundary' : 'within-threshold'),observations};
    });
  }

  commitEnergy(state,source,device,prefix,receivedAt,reason,budget) {
    const p = state.pending;
    if (!p) return [];
    const signals = energySignals(prefix);
    const observations = p.energies.map((value,i) => {
      const o = {source,device,signal:signals[i],value,unit:'kWh',sourceTime:p.end,receivedAt,
        quality:p.quality,raw:{intervalStart:p.start,intervalEnd:p.end,durationMs:p.end-p.start,
          ...(p.admittedAt !== undefined ? {
            timeAdmission: sourceTimeAdmission({ sourceTime: p.end, receivedAt,
              now: Math.max(receivedAt, p.admittedAt), deferred: true }),
            ...(p.receivedAt !== receivedAt ? { originalReportReceivedAt: p.receivedAt } : {}),
          } : {}),
          ...(p.transport ? {transport:p.transport} : {}),
          basis:prefix==='caravan'?'meter-counter-delta':prefix==='ev2'?'native-meter-counter-phase-allocation':'integrated-power-phase-allocation',
          ...(prefix==='caravan'?{learningRole:'history-only'}:{}),recorder:{version:VERSION,policy:'adaptive-energy',reason,group:prefix}}};
      o.id = this.store.observation(o);
      budget.estimatedBytes += observationBytes(o);
      const s = this.signalState(o,receivedAt);
      const previous = s.last;
      s.last = {id:o.id,value,sourceTime:p.end,receivedAt,quality:p.quality,semanticQuality:semanticQuality(o.raw),
        ...(o.raw.timeAdmission ? { timeAdmission: o.raw.timeAdmission } : {})};
      s.lastPollAt = receivedAt; s.lastSourceTime = p.end; s.unit = 'kWh'; s.recordingPolicy = 'adaptive-energy';
      s.scale = state.scales[i]?.scale ?? 0;
      this.coverage(s,o,'fresh');
      this.count(s,receivedAt,{saved:true,polls:0,elapsed:previous ? p.end-previous.sourceTime : 0,bytes:Buffer.byteLength(JSON.stringify(o))});
      this.store.setState(stateKey(s.key),s);
      return o;
    });
    // This is exactly reconstructible from the recorded energy and duration.
    // The last acquisition endpoint alone is not the recorded approximation.
    state.lastPowers = p.energies.map(value=>value*HOUR/(p.end-p.start));
    if (nativeChargerEnergy(prefix)) state.lastSelectionPowers = p.selectionPowers ?? null;
    state.lastQuality = p.quality;
    state.pending = null;
    return observations;
  }

  energyGap({ source = 'easee', device, prefix, start, end, receivedAt = end, admittedAt, quality = ['acquisition-failed'], transport }) {
    const signals = energySignals(prefix);
    if (!signals || !finiteTime(start) || !finiteTime(end) || end < start
      || !validateAdmittedSourceTime({ sourceTime: end, receivedAt, admittedAt, now: admittedAt === undefined ? Infinity : this.clock() }))
      throw new TypeError('Invalid phase energy gap');
    return this.store.transaction(() => {
      const key = `recorder:energy:${JSON.stringify([source,device,prefix])}`, state = this.store.getState(key);
      if (state?.lastReceivedAt != null && receivedAt < state.lastReceivedAt)
        throw new TypeError('Out-of-order energy gap receipt');
      const budget = state?.pending ? this.adaptiveBudget(receivedAt) : null;
      const observations = budget ? this.commitEnergy(state,source,device,prefix,receivedAt,'availability-boundary',budget) : [];
      if (budget) this.store.setState(ADAPTIVE_BUDGET_KEY,budget);
      if (state) {
        state.lastPowers = null; state.lastSelectionPowers = null; state.lastQuality = null;
        state.lastReceivedAt = receivedAt; this.store.setState(key,state);
      }
      for (const signal of signals) {
        const result = this.record({source,device,signal,value:null,unit:'kWh',
          sourceTime:end,receivedAt,quality:flags([...quality,'missing']),
          raw:{basis:'availability-gap',intervalStart:start,intervalEnd:end,durationMs:end-start,
            ...(admittedAt !== undefined ? { timeAdmission: sourceTimeAdmission({ sourceTime: end, receivedAt, now: admittedAt, deferred: true }) } : {}),
            ...(['cloud','ocpp'].includes(transport) ? {transport} : {})}});
        if (result.saved) observations.push(result.observation);
      }
      return observations;
    });
  }

  /** Only an explicit boundary finalizes pending energy. Routine ticks maintain
   * storage statistics, never manufacture time-based history. The durable open
   * interval remains readable and survives restart without extrapolation.
   */
  flush(now = this.clock(), { force = false, source, device, prefix } = {}) {
    if (!finiteTime(now)) throw new TypeError('Invalid energy flush timestamp');
    const selected = prefix === undefined ? null : Array.isArray(prefix) ? prefix : [prefix];
    if (selected?.some(value=>!energySignals(value))) throw new TypeError('Invalid energy flush group');
    return this.store.transaction(() => {
      const observations = [];
      this.flushMetadata(now, { force });
      this.flushMetrics(now, { force });
      let budget = this.adaptiveBudgetState() ? this.adaptiveBudget(now) : null;
      for (const row of this.store.db.prepare("SELECT key,value FROM state WHERE key GLOB 'recorder:energy:*'").all()) {
        const s = JSON.parse(row.value), p = s.pending;
        if (!p || !force) continue;
        const [recordSource,recordDevice,recordPrefix] = JSON.parse(row.key.slice('recorder:energy:'.length));
        if (source !== undefined && source !== recordSource || device !== undefined && device !== recordDevice
          || selected && !selected.includes(recordPrefix)) continue;
        if (!validateAdmittedSourceTime({ sourceTime: p.end, receivedAt: p.receivedAt, admittedAt: p.admittedAt, now }))
          throw new TypeError('Cannot finalize energy before its evidence was admitted');
        budget ??= this.adaptiveBudget(now);
        observations.push(...this.commitEnergy(s,recordSource,recordDevice,recordPrefix,now,'flush',budget));
        this.store.setState(row.key,s);
      }
      this.store.setState(STORAGE_METRICS_KEY,this.storageMetrics(now));
      if (budget) this.store.setState(ADAPTIVE_BUDGET_KEY,budget);
      return observations;
    });
  }

  committedAt(signal,at) {
    if (!finiteTime(at)) throw new TypeError('Invalid committed timestamp');
    // The writer bridge materializes iterate() before returning it. Seek one
    // candidate at a time so an ordinary control read cannot transfer its past.
    const query = this.store.db.prepare(`SELECT * FROM active_observations AS observations
      WHERE signal=? AND (source_time,id)<=(?,?) AND received_at<=?
        AND import_id IS NULL ORDER BY source_time DESC,id DESC LIMIT 1`);
    let o = null, time = at, id = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const row = query.get(signal,time,id,at);
      if (!row) break;
      const candidate = {id:row.id,source:row.source,device:row.device,signal:row.signal,value:row.value,unit:row.unit,
        sourceTime:row.source_time,receivedAt:row.received_at,quality:JSON.parse(row.quality),raw:row.raw ? JSON.parse(row.raw) : null};
      if (observationTimeAdmitted(candidate, at)) { o = candidate; break; }
      time = row.source_time; id = row.id - 1;
    }
    if (!o) return null;
    if (o.raw?.acquisitionOnly || o.raw?.auditOnly) return null;
    const reportAge = temperatureReportMaxAge(o);
    if (reportAge !== null) {
      const span = this.store.db.prepare(`SELECT * FROM active_recorder_coverage AS recorder_coverage WHERE source=? AND device=? AND signal=?
        AND start_at<=? AND ${selectedCoverageSpan('recorder_coverage')} ORDER BY start_at DESC,id DESC LIMIT 1`).get(o.source,o.device,signal,at);
      const deadline = hasCaravanEvidence(o) ? caravanCoverageDeadline(o, span, at) : span?.source_time + reportAge;
      const available = span?.status==='fresh' && deadline !== null && at<deadline;
      return {...o,value:available?o.value:null,quality:available?o.quality:flags([...o.quality,span?.status==='fresh'?'missing-report':span?.status??'unavailable']),
        reportObservedAt:span?.end_at<=at?span.source_time:null,
        reportReceivedAt:span?.end_at<=at?span.end_at:null,
        reportExpiresAt:available?Math.min(deadline,span.end_at>at?at:Infinity):null};
    }
    const coverage = this.store.db.prepare(`SELECT * FROM active_recorder_coverage AS recorder_coverage WHERE source=? AND device=? AND signal=? AND start_at<=?
      AND ${selectedCoverageSpan('recorder_coverage')} ORDER BY start_at DESC,id DESC LIMIT 1`).get(o.source,o.device,signal,at);
    if (coverage && coverage.end_at >= o.receivedAt) {
      if (coverage.status !== 'fresh') return {...o,value:null,quality:flags([...o.quality,coverage.status])};
      if (coverage.end_at <= at && coverage.observation_id === o.id && coverage.source_time > o.sourceTime) {
        // Deferred coverage endpoints are admission clocks, not another
        // physical receipt. Keep the measured row and its proof intact.
        if (o.raw?.timeAdmission) return {...o,reportObservedAt:coverage.source_time,reportAvailableAt:coverage.end_at,
          raw:{...o.raw,recorder:{...o.raw.recorder,temporalBasis:'held-recorded-value',coverageId:coverage.id}}};
        return {...o,sourceTime:coverage.source_time,receivedAt:coverage.end_at,
          raw:{...o.raw,recorder:{...o.raw?.recorder,originalSourceTime:o.sourceTime,temporalBasis:'held-recorded-value',coverageId:coverage.id}}};
      }
    }
    return o;
  }

  latestCommitted(signal) { return this.committedAt(signal,this.clock()); }

  /** Current committed source evidence only. No statistics/history scans,
   * storage accounting, acquisition or coverage writes run in health reads. */
  sourceStatus(now = this.clock()) {
    const states = this.store.db.prepare("SELECT value FROM state WHERE key GLOB 'recorder:signal:*'").all()
      .map(row=>JSON.parse(row.value)).filter(isRecordedDataset);
    const latestCoverage = this.store.db.prepare('SELECT source_time,evidence FROM recorder_coverage WHERE id=?');
    const parameters = states.map(state=>sourceParameter(state,
      state.coverageId ? latestCoverage.get(state.coverageId) : null,now,this.observedStreams))
      .sort((a,b)=>a.signal.localeCompare(b.signal));
    return {parameters:parameters.filter(row=>row.policy.startsWith('adaptive-')),
      exactParameters:parameters.filter(row=>!row.policy.startsWith('adaptive-'))};
  }

  status(now = this.clock()) {
    const g = readStorageMetrics(this.store.db) ?? this.storageMetrics(now);
    const recordedBudget = this.adaptiveBudgetState(), budget = recordedBudget ?? initialBudget(now);
    const historySelection = this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
    const revision = this.store.db.prepare(`SELECT (SELECT MAX(id) FROM observations) observations,
      (SELECT MAX(id) FROM provider_snapshot_fetches) snapshots,(SELECT MAX(id) FROM recorder_coverage) coverage`).get();
    const rows = this.store.db.prepare("SELECT value FROM state WHERE key GLOB 'recorder:signal:*'").all();
    const states = rows.map(row=>JSON.parse(row.value)).filter(isRecordedDataset);
    const voltageStatuses = new Map(states.filter(voltageEstimate).map(s => [s.device, null]));
    for (const input of voltageStatuses.keys()) voltageStatuses.set(input, voltageRecordingStatus(this.store,input,now));
    const openEnergy = new Map();
    for (const row of this.store.db.prepare("SELECT key,value FROM state WHERE key GLOB 'recorder:energy:*'").all()) {
      const [source,device,prefix] = JSON.parse(row.key.slice('recorder:energy:'.length));
      const pending = JSON.parse(row.value).pending;
      if (!pending || !validateAdmittedSourceTime({ sourceTime: pending.end, receivedAt: pending.receivedAt,
        admittedAt: pending.admittedAt, now })) continue;
      for (const [i,signal] of (energySignals(prefix) ?? []).entries())
        openEnergy.set(keyOf({source,device,signal,unit:'kWh'}), { start:pending.start,end:pending.end,
          receivedAt:pending.receivedAt,kwh:pending.energies[i],...(pending.transport ? {transport:pending.transport} : {}) });
    }
    // Constant temperatures extend existing coverage rows. Give their report
    // deadlines a separate revision so long plots can refresh without following
    // every fast power acquisition. Device identifiers stay out of the revision.
    const temperatureReportRevision = JSON.stringify(states.filter(s=>s.reportPolicy && s.signal!=='dhwr_active')
      .map(s=>[s.signal,s.lastSourceTime,s.coverageId,s.status,caravanEvidenceDeadline(s.recordingEvidence)])
      .sort((a,b)=>a[0].localeCompare(b[0])||a[2]-b[2]));
    const sourceReportRevision = JSON.stringify(states.filter(hasSourceReportCoverage)
      .map(s=>[s.source,s.signal,s.lastSourceTime,s.coverageId,s.status])
      .sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1])||a[3]-b[3]));
    const latestCoverage = this.store.db.prepare('SELECT source_time,evidence FROM recorder_coverage WHERE id=?');
    // Complete hours already have exact counts and timestamp extrema. Only the
    // four rolling-window edges require reading observation index entries;
    // increasing archive density must not turn each control tick into a week scan.
    const currentHour = Math.floor(now/HOUR)*HOUR;
    const savedEdge = this.store.db.prepare(`SELECT COUNT(*) records,MIN(received_at) first_saved_at,MAX(received_at) last_saved_at
      FROM observations INDEXED BY observations_stream_receipt
      WHERE source=? AND device=? AND signal=? AND unit=?
        AND json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.recorder.policy')=?
        AND import_id IS NULL AND received_at>=? AND received_at<?`);
    const metrics = this.store.db.prepare('SELECT * FROM recorder_metrics WHERE key=? AND bucket>=? AND bucket<=? ORDER BY bucket');
    const streamEndpoint = order => this.store.db.prepare(`SELECT received_at,source_time FROM observations INDEXED BY observations_stream_receipt
      WHERE source=? AND device=? AND signal=? AND unit=?
        AND json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.recorder.policy')=?
        AND import_id IS NULL AND received_at<=? ORDER BY received_at ${order} LIMIT 1`);
    const firstSaved = streamEndpoint('ASC'), lastSaved = streamEndpoint('DESC');
    const parameters = states.map(s => {
      const stats = {};
      const stream = [s.source,s.device,s.signal,s.unit,s.recordingPolicy];
      const current = savedEdge.get(...stream,currentHour,now+1);
      const history = this.metricHistory(metrics.all(s.key,now-7*DAY-HOUR,currentHour),
        s.key,now-7*DAY-HOUR,currentHour,now,g.metricsPrunedBefore);
      for (const [label,span] of [['hour',HOUR],['day',DAY],['week',7*DAY]]) {
        const from = now-span, completeFrom = Math.max(Math.ceil(from/HOUR)*HOUR,g.metricsPrunedBefore);
        const buckets = history.filter(b => b.bucket+HOUR > from);
        const complete = buckets.filter(b => b.bucket>=completeFrom && b.bucket<currentHour);
        // An explicitly historical request can predate retained metric hours.
        // Only that pruned portion falls back to archive rows; live status does not.
        const edgeEnd = Math.min(completeFrom,currentHour);
        const saved = [current,...complete,...(from<edgeEnd ? [savedEdge.get(...stream,from,edgeEnd)] : [])];
        const records = saved.reduce((n,b)=>n+b.records,0), polls = buckets.reduce((n,b)=>n+b.polls,0);
        const first = Math.min(...saved.filter(b=>b.records>0).map(b=>b.first_saved_at));
        const last = Math.max(...saved.filter(b=>b.records>0).map(b=>b.last_saved_at));
        const errorTime = buckets.reduce((n,b)=>n+b.error_time,0);
        stats[label] = {records,polls,averageIntervalMs:records>1 ? (last-first)/(records-1) : null,
          normalizedRmsChange:errorTime ? Math.sqrt(buckets.reduce((n,b)=>n+b.error_squared_time,0)/errorTime) : null,
          estimatedBytes:buckets.reduce((n,b)=>n+b.bytes,0)};
      }
      const grouped = /_energy_l[123]$/.test(s.signal), totalEnergy = s.signal === 'caravan_energy';
      const policy = recordingPolicy(s), exact = !policy.adaptive;
      const powerFloor = policy.id==='adaptive-energy' && /^ev[12]_energy_l[123]$/.test(s.signal) ? CHARGER_POWER_FLOOR_KW : 0;
      const voltage = voltageStatuses.get(s.device)?.[s.signal];
      const first = firstSaved.get(...stream,now), last = lastSaved.get(...stream,now);
      return {...sourceParameter(s,s.coverageId ? latestCoverage.get(s.coverageId) : null,now,this.observedStreams),
        recordedPeriod:{firstSavedAt:first?.received_at ?? null,lastSavedAt:last?.received_at ?? null},
        ...(voltage ? {voltage} : {}),
        openInterval:openEnergy.get(s.key) ?? null,scale:s.scale,
        threshold:exact ? null : Math.max(powerFloor,valueFloor(s),s.scale*budget.tolerance),thresholdUnit:grouped || totalEnergy ? 'kW' : s.unit,
        optimizedQuantity:grouped ? 'phase-power' : totalEnergy ? 'total-power' : 'value',grouped,...stats};
    }).sort((a,b)=>a.signal.localeCompare(b.signal));
    return {version:VERSION,...this.config,historySelection,historyRevision:JSON.stringify({...revision,selection:historySelection,energy:g.energyRevision}),temperatureReportRevision,sourceReportRevision,normalizedTolerance:budget.tolerance,measuredDatabaseBytes:this.store.databaseBytes(),
      adaptiveAccountingStartedAt:recordedBudget?.startedAt ?? null,
      adaptiveEstimatedBytes:budget.estimatedBytes,adaptiveEstimatedBytesPerDay:budget.bytesPerDay,
      adaptiveEstimatedBytesPerDay7d:budget.bytesPerDay7d,adaptiveProjectedAnnualBytes:budget.bytesPerDay7d*YEAR/DAY,
      adaptiveMeasurementHours:budget.measuredHours,budgetBasis:'adaptive-observation-payload',
      totalDatabaseBytesPerDay:g.bytesPerDay,totalDatabaseBytesPerDay7d:g.bytesPerDay7d,
      totalDatabaseProjectedAnnualBytes:g.bytesPerDay7d*YEAR/DAY,totalDatabaseMeasurementHours:g.measuredHours,
      parameters:parameters.filter(row=>row.policy.startsWith('adaptive-')),
      exactParameters:parameters.filter(row=>!row.policy.startsWith('adaptive-'))};
  }
}

function energySignals(prefix) {
  return prefix === 'caravan' ? ['caravan_energy'] : ['ev1','ev2','property'].includes(prefix)
    ? [1,2,3].map(phase=>`${prefix}_energy_l${phase}`) : null;
}

function compactRaw(raw, observation) {
  if (!raw || typeof raw !== 'object') return {};
  // Repeated MQTT payload text and device metadata have no independent numeric
  // information. Retain interpretation, quality and lineage used by consumers.
  const allowed = ['usableForControl','timeBasis','timeAdmission','sensorMeasuredAt','installationVerified','verification','register',
    'verified','retained','cached','publicationMayUseGatewayCache','verificationEvidence',
    'diagnosticAvailable','accuracyVerified','contractVersion','supported',
    'basis','energyBasis','source','issuedAt','fetchedAt','snapshotId','provenance','intervalStart','intervalEnd','durationMs',
    'modelVersion','controllerPhase','estimated','forecast','reportIntervalMs','reportGraceMs','eventOnly','maxAgeMs',
    'reportPolicyChangedAt','originalReportReceivedAt','originalReportSourceTime','originalReportTimeBasis','originalReportTimeAdmission','transportRecoveredAt','temperatureRouteSignature',
    'transport','voltageSource','voltageAvailability','voltageEstimate'];
  const result = Object.fromEntries(allowed.filter(key=>raw[key] !== undefined).map(key=>[key,raw[key]]));
  if (observation?.source === 'sonoff-floor' && observation.unit === 'state'
    && raw.evidence === 'gpio_output_readback') {
    result.evidence = raw.evidence;
    if (typeof raw.generation === 'string' && /^[a-f0-9]{32}$/.test(raw.generation)) result.generation = raw.generation;
    if (Number.isSafeInteger(raw.deviceMonotonicMs) && raw.deviceMonotonicMs >= 0)
      result.deviceMonotonicMs = raw.deviceMonotonicMs;
  }
  // Caravan appliance history stores one power/fan state. Keep its physical
  // identity and evidence clocks without retaining sensor or setting values.
  if (observation?.source === 'mqtt-equipment' && observation.signal === 'caravan_dehumidifier_state' && observation.unit === 'state') {
    if (validRecordingWait(raw.sourceTimeWait)) result.sourceTimeWait = { ...raw.sourceTimeWait };
    if (finiteTime(raw.availabilityRecoveredAt)) result.availabilityRecoveredAt = raw.availabilityRecoveredAt;
    if (typeof raw.identity === 'string' && /^[a-f0-9]{64}$/.test(raw.identity)) result.identity = raw.identity;
    if (finiteTime(raw.fieldTimestamps?.power)) {
      result.fieldTimestamps = { power: raw.fieldTimestamps.power };
      if ([1, 2, 3].includes(observation.value) && finiteTime(raw.fieldTimestamps?.fanSpeed))
        result.fieldTimestamps.fanSpeed = raw.fieldTimestamps.fanSpeed;
    }
    const evidence = raw.locationEvidence;
    if (evidence?.method === 'native-power-cycle-v1'
      && typeof evidence.meterSignature === 'string' && /^[a-f0-9]{64}$/.test(evidence.meterSignature)
      && ['startedAt', 'completedAt', 'meterObservedAt'].every(key => finiteTime(evidence[key]))
      && evidence.completedAt >= evidence.startedAt && evidence.meterObservedAt >= evidence.startedAt
      && ['powerRiseW', 'powerFallW', 'minimumChangeW'].every(key => Number.isFinite(evidence[key]) && evidence[key] >= 3))
      result.locationEvidence = Object.fromEntries(['method', 'meterSignature', 'startedAt', 'completedAt',
        'meterObservedAt', 'maxAgeMs', 'powerRiseW', 'powerFallW', 'minimumChangeW'].map(key => [key, evidence[key]]));
    if (result.locationEvidence && evidence.phases && ['baseline', 'on', 'off'].every(phase => {
      const row = evidence.phases[phase];
      return row && (finiteTime(row.commandAt) || phase === 'baseline' && row.commandAt === null)
        && finiteTime(row.firstPowerObservedAt) && finiteTime(row.lastPowerObservedAt)
        && row.lastPowerObservedAt >= row.firstPowerObservedAt
        && (row.commandAt === null || row.firstPowerObservedAt >= row.commandAt);
    })) result.locationEvidence.phases = Object.fromEntries(['baseline', 'on', 'off'].map(phase => [phase,
      Object.fromEntries(['commandAt', 'firstPowerObservedAt', 'lastPowerObservedAt'].map(key => [key, evidence.phases[phase][key]]))]));
  }
  return result;
}
