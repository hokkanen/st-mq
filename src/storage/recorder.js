import { H66_MAX_AGE_MS, OUTDOOR_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { INDOOR_SIGNALS, HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS } from '../domain/indoor-sensors.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { isRecordedDataset } from './recorded-datasets.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, YEAR = 365.25 * DAY;
const VERSION = 'adaptive-recorder-v1';
const GLOBAL_KEY = 'recorder:global:v1';
const DISABLED_H66 = new Set(['discharge_temperature', 'brine_pump_active']);
const EXACT = /(?:_active$|_routing$|_mode$|_code$|_setting$|_hours$|^room_influence$|^heating_curve$|^heating_setpoint$|^auxiliary_output$)/;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const flags = quality => [...new Set(quality ?? [])].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = o => JSON.stringify([o.source, o.device, o.signal]);
const stateKey = key => `recorder:signal:${key}`;
const finiteTime = at => Number.isSafeInteger(at) && Math.abs(at) <= 8640000000000000;
const numericalFloor = (a,b) => Math.max(1,Math.abs(a??0),Math.abs(b??0))*Number.EPSILON*32;
const semanticQuality = raw => Object.fromEntries(['usableForControl','verified','retained','cached','installationVerified',
  'verification','timeBasis','publicationMayUseGatewayCache','basis','reportIntervalMs','reportGraceMs','eventOnly','temperatureRouteSignature'].filter(key=>raw?.[key]!==undefined).map(key=>[key,raw[key]]));
// Source validity is independent of the recording budget/maximum spacing.
// Increasing storage compression must never make old measurements fresher.
// Room and garage readings remain the last reported measurement until replaced.
// Their source clock still controls ordering, recording and measurement lineage.
const sourceAge = o => o.source === 'mqtt-equipment' && o.unit === 'state' && (o.eventOnly || o.raw?.eventOnly) ? Infinity
  : temperatureReportMaxAge(o) ?? (HELD_TEMPERATURE_SIGNALS.includes(o.signal) ? Infinity : o.source === 'husdata-h66' ? H66_MAX_AGE_MS
  : /temperature$/.test(o.signal) ? OUTDOOR_MAX_AGE_MS : o.signal === 'solar_radiation' ? 6 * HOUR : 5 * MINUTE);

const DIAGNOSTIC_QUALITY = new Set(['missing', 'invalid-value', 'invalid-numeric', 'invalid-unit', 'invalid-payload',
  'retained', 'source-time-unknown', 'future-source-time', 'out-of-order-source-time', 'conflicting-duplicate',
  'disconnected', 'mqtt-disconnected', 'subscription-failed', 'provider-error', 'implausible-temperature', 'suspect-zero-indoor']);

/** Explain the recorded acquisition and its current deadline without writing a
 * new observation, extending coverage, or changing historical classification. */
function recordingFreshness(state, coverage, now) {
  const eventOnly = state.source === 'mqtt-equipment' && state.unit === 'state' && state.eventOnly === true;
  const periodicAge = temperatureReportMaxAge({ raw: state.reportPolicy });
  const interval = /_energy_l[123]$/.test(state.signal) || state.signal === 'ev2_energy';
  const held = !interval && periodicAge === null && HELD_TEMPERATURE_SIGNALS.includes(state.signal);
  const maximumAge = interval ? null : sourceAge({ ...state, raw: state.reportPolicy });
  const maxAgeMs = Number.isFinite(maximumAge) ? maximumAge : null;
  const sourceObservedAt = Number.isFinite(coverage?.source_time) ? coverage.source_time
    : Number.isFinite(state.lastSourceTime) ? state.lastSourceTime : null;
  const age = sourceObservedAt === null ? null : now - sourceObservedAt;
  const reasons = state.status === 'fresh' ? [] : (state.last?.quality ?? []).filter(flag => typeof flag === 'string')
    .map(flag => flag.replaceAll('_', '-')).filter(flag => DIAGNOSTIC_QUALITY.has(flag));
  let status = state.status ?? 'waiting';
  if (status === 'failed' && !reasons.length) reasons.push('provider-error');
  if (status === 'unavailable' && !reasons.length) reasons.push('invalid-quality');
  if (Number.isFinite(state.last?.sourceTime) && Number.isFinite(state.last?.receivedAt)
    && state.last.sourceTime > state.last.receivedAt) reasons.push('source-time-after-receipt');
  if (age !== null && age < 0) {
    reasons.push('future-source-time');
    if (status === 'fresh') status = 'unavailable';
  }
  if (!interval && age !== null && maxAgeMs !== null
    && (periodicAge !== null ? age >= maxAgeMs : age > maxAgeMs)) {
    reasons.push(periodicAge !== null ? 'missing-report' : 'source-expired');
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
    ...(held ? { attentionAfterMs: INDOOR_ATTENTION_MS } : {}) };
}

/** Acquisition may be fast; only this persisted, causal approximation trains.
 * All continuous signals share one normalized error tolerance. Signal scale is
 * learned from variation, never model importance or a unit-specific target.
 */
export class Recorder {
  constructor(store, { config = {}, clock = Date.now } = {}) {
    this.store = store; this.clock = clock;
    this.configure(config);
  }

  configure(config = {}) {
    this.config = {
      maxIntervalMs: config.maxIntervalMs ?? 5 * MINUTE,
      annualBudgetBytes: config.annualBudgetBytes ?? 10_000_000_000,
    };
    if (!Number.isFinite(this.config.maxIntervalMs) || this.config.maxIntervalMs < 1000
      || !Number.isFinite(this.config.annualBudgetBytes) || this.config.annualBudgetBytes <= 0)
      throw new TypeError('Recorder interval and annual budget must be positive');
  }

  global(now) {
    let g = this.store.getState(GLOBAL_KEY);
    if (!g) g = { version: VERSION, startedAt: now, measuredAt: now, measuredBytes: this.store.databaseBytes(),
      tolerance: 0.02, bytesPerDay: 0, bytesPerDay7d: 0, measuredHours: 0 };
    const elapsed = now - g.measuredAt;
    if (elapsed >= HOUR) {
      const bytes = this.store.databaseBytes(), daily = Math.max(0, bytes - g.measuredBytes) * DAY / elapsed;
      const alpha = 1 - Math.exp(-elapsed / DAY), weeklyAlpha = 1 - Math.exp(-elapsed / (7 * DAY));
      g.bytesPerDay = g.measuredHours ? g.bytesPerDay + alpha * (daily - g.bytesPerDay) : daily;
      g.bytesPerDay7d = g.measuredHours ? g.bytesPerDay7d + weeklyAlpha * (daily - g.bytesPerDay7d) : daily;
      // This is a rolling price of accuracy, not a calendar quota. Hourly changes
      // are deliberately small; a burst cannot trigger a December-like squeeze.
      const ratio = g.bytesPerDay / (this.config.annualBudgetBytes * DAY / YEAR);
      const step = clamp(Math.log(Math.max(ratio, 0.05)) * Math.min(elapsed / DAY, 0.125), -0.12, 0.12);
      g.tolerance = clamp(g.tolerance * Math.exp(step), 1e-6, 10);
      g.measuredHours += elapsed / HOUR; g.measuredAt = now; g.measuredBytes = bytes;
      this.store.db.prepare('DELETE FROM recorder_metrics WHERE bucket<?').run(Math.floor(now/HOUR)*HOUR-7*DAY);
    }
    return g;
  }

  signalState(observation, now) {
    const key = keyOf(observation);
    return this.store.getState(stateKey(key)) ?? { key, source: observation.source, device: observation.device,
      signal: observation.signal, unit: observation.unit, startedAt: now, last: null, lastPollAt: null,
      lastSourceTime: null, mean: null, variance: 0, step: 0, scale: 0, previousValue: null,
      lastFreshAt: null, coverageId: null, status: null };
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
        o.received_at AS observed_received_at,o.quality,o.raw FROM recorder_coverage c
        JOIN observations o ON o.id=c.observation_id WHERE c.source=? AND c.device=? AND c.signal=?
        AND c.status='fresh' AND c.start_at<=? AND c.end_at<=? ORDER BY c.id DESC LIMIT 1`)
        .get(reading.source, reading.device, reading.signal, at, at);
      const previousRaw = span?.raw ? JSON.parse(span.raw) : reading.raw ?? {};
      const sourceTime = span?.source_time ?? reading.sourceTime;
      const receivedAt = span ? span.source_time === span.observed_source_time
        ? previousRaw.originalReportReceivedAt ?? span.end_at : span.end_at : reading.receivedAt;
      const value = span?.value ?? reading.value, unit = span?.unit ?? reading.unit;
      if (!recoverConnection && same(s.reportPolicy, policy)) return { changed: false, reportSourceTime: sourceTime, reportReceivedAt: receivedAt,
        observation: { source: reading.source, device: reading.device, signal: reading.signal, ...s.last, unit,
          raw: { ...policy, timeBasis: s.last.semanticQuality?.timeBasis } } };
      const quality = span?.quality ? JSON.parse(span.quality) : reading.quality ?? [];
      const lastQuality = s.last.quality ?? [];
      const ageOnly = lastQuality.every(flag => ['missing', 'missing-report', 'report-policy-changed', 'stale', 'unavailable'].includes(flag))
        && (s.status === 'stale' || lastQuality.some(flag => ['missing-report', 'report-policy-changed'].includes(flag)));
      const genuine = finiteTime(sourceTime) && finiteTime(receivedAt) && sourceTime <= receivedAt && receivedAt <= at
        && Number.isFinite(value) && ['degC', '°C'].includes(unit)
        && (reading.signal === 'garage_temperature' ? value >= -60 && value <= 70 : value > 2 && value < 40)
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
            raw: { ...previousRaw, ...policy, temperatureRouteSignature: routeSignature } } };
        const transport = flag => ['mqtt-disconnected', 'mqtt-subscription-failed'].includes(flag);
        const allowed = flag => transport(flag) || ['missing', 'failed', 'unavailable', 'stale', 'missing-report', 'report-policy-changed'].includes(flag);
        if (!lastQuality.some(transport) || !lastQuality.every(allowed)) return { changed: false };
        // A subsequent disconnect must not hide an earlier invalid payload.
        // Start at the genuine receipt, not a later policy/recovery event time.
        const attempts = this.store.db.prepare(`SELECT quality,raw FROM observations WHERE source=? AND device=? AND signal=?
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
      const raw = compactRaw({ ...previousRaw, ...policy, timeBasis: recoverConnection ? 'mqtt-transport-recovery' : 'report-policy-change',
        ...(recoverConnection ? { transportRecoveredAt: at, temperatureRouteSignature: routeSignature } : { reportPolicyChangedAt: at }), originalReportReceivedAt: receivedAt,
        originalReportSourceTime: sourceTime,
        originalReportTimeBasis: previousRaw.originalReportTimeBasis ?? previousRaw.timeBasis });
      raw.recorder = { version: VERSION, reason: recoverConnection ? 'mqtt-transport-recovery' : 'report-policy-change', status: fresh ? 'fresh' : 'unavailable',
        originalSourceTime: sourceTime, temporalBasis: recoverConnection ? 'transport-recovery' : 'policy-change' };
      const observation = { source: reading.source, device: reading.device, signal: reading.signal,
        value: fresh ? value : null, unit, sourceTime: fresh ? sourceTime : null, receivedAt: at, quality: q, raw };
      const id = this.store.observation(observation);
      observation.id = id;
      s.last = { id, value: observation.value, sourceTime: observation.sourceTime, receivedAt: at,
        quality: q, semanticQuality: semanticQuality(raw) };
      s.unit = unit; s.reportPolicy = { ...policy }; s.status = fresh ? 'fresh' : 'unavailable';
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
    if (q.some(x => /failed|disconnected|fetch-error|acquisition-failed|provider[-_]error/.test(x))) return 'failed';
    if (o.value === null || !Number.isFinite(o.sourceTime) || q.some(x => /missing|invalid|retained|unavailable/.test(x))) return 'unavailable';
    if (q.some(x => /stale|out-of-order/.test(x)) || o.sourceTime > o.receivedAt
      || (temperatureReportMaxAge(o) !== null
        ? o.receivedAt - o.sourceTime >= sourceAge(o) : o.receivedAt - o.sourceTime > sourceAge(o))
      || temperatureReportMaxAge(o) !== null && state.status && state.status !== 'fresh'
        && o.sourceTime <= state.lastSourceTime
      || temperatureReportMaxAge(o) !== null && state.reportUnavailableSince != null
        && o.sourceTime < state.reportUnavailableSince
      || temperatureReportMaxAge(o) !== null && o.sourceTime === state.lastSourceTime
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
    this.store.db.prepare(`INSERT INTO recorder_metrics
      (key,bucket,polls,records,bytes,error_squared_time,error_time,stale,failed,unavailable) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key,bucket) DO UPDATE SET polls=polls+excluded.polls,records=records+excluded.records,bytes=bytes+excluded.bytes,
      error_squared_time=error_squared_time+excluded.error_squared_time,error_time=error_time+excluded.error_time,
      stale=stale+excluded.stale,failed=failed+excluded.failed,unavailable=unavailable+excluded.unavailable`)
      .run(state.key,hour,polls,Number(saved),bytes,errorTime ? error*error*errorTime : 0,errorTime,
        polls*Number(state.status==='stale'),polls*Number(state.status==='failed'),polls*Number(state.status==='unavailable'));
  }

  coverage(state, o, status, freshUpdate = true) {
    // Coverage describes successful source updates and availability separately
    // from the value approximation. An unchanged OLD timestamp never advances
    // measurement freshness, even though its HTTP request succeeded.
    const at = o.receivedAt, observed = Number.isFinite(o.sourceTime) ? o.sourceTime : null;
    // Polling a cached MQTT reading is not another detector report. Keep the
    // compact span's endpoint on the actual report's source and receipt clocks.
    if (temperatureReportMaxAge(o) !== null && status === 'fresh' && !freshUpdate) return;
    // If recording is configured less often than source freshness, two fresh
    // polls can still surround an unobserved gap. Preserve separate spans even
    // when both polls map to the same saved value. Receipt must also precede
    // expiry of the previous source reading: a later arrival cannot prove that
    // an earlier controller already had fresh data. This makes every historical
    // prefix of an extended span independently valid.
    const continuous = status !== 'fresh' || !Number.isFinite(state.lastSourceTime)
      || observed - state.lastSourceTime <= sourceAge(o) && at - state.lastSourceTime <= sourceAge(o);
    if (state.coverageId && state.status === status && state.coverageObservationId === state.last?.id && continuous) {
      this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+1 WHERE id=?')
        .run(at, observed, state.coverageId);
    } else {
      state.coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(o.source,o.device,o.signal,status,at,at,observed,state.last?.id ?? null).lastInsertRowid);
      state.coverageObservationId = state.last?.id ?? null;
    }
    state.status = status;
  }

  record(observation, { force = false, kind } = {}) {
    const o = { ...observation, receivedAt: observation.receivedAt ?? this.clock(), sourceTime: observation.sourceTime ?? null,
      quality: flags(observation.quality), raw: observation.raw ?? null };
    if (!finiteTime(o.receivedAt)) throw new TypeError('Invalid recorder receipt timestamp');
    if (!isRecordedDataset(o) || o.raw?.acquisitionOnly || o.raw?.auditOnly || o.source === 'husdata-h66' && DISABLED_H66.has(o.signal))
      return { saved: false, reason: 'not-in-recorded-dataset', observation: null };
    if ((o.raw?.retained === true || o.quality.includes('retained')) && o.raw?.reportIntervalMs !== 0
      && (temperatureReportMaxAge(o) !== null || this.store.getState(stateKey(keyOf(o)))?.reportPolicy))
      // Broker replay is neither a detector report nor an availability change.
      // A recorded disconnect remains in force until a genuine newer report.
      return { saved:false,reason:'retained-periodic-report',observation:null };
    return this.store.transaction(() => {
      const s = this.signalState(o,o.receivedAt), g = this.global(o.receivedAt);
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
      const freshUpdate = fresh && (s.lastSourceTime === null || o.sourceTime > s.lastSourceTime
        || o.sourceTime === s.lastSourceTime && s.previousValue !== o.value);
      if (freshUpdate) this.scale(s,o.value,o.sourceTime);
      const exact = periodic || kind === 'state' || ['state','code'].includes(o.unit) || EXACT.test(o.signal);
      const changed = s.last === null || o.value !== s.last.value;
      const transition = s.last && (status !== s.status || !same(o.quality,s.last.quality)
        || o.unit!==s.unit || !same(semanticQuality(o.raw),s.last.semanticQuality??{}));
      const crossingZero = /pump_speed$/.test(o.signal) && s.last && (o.value === 0) !== (s.last.value === 0);
      const threshold = Math.max(s.scale * g.tolerance,numericalFloor(o.value,s.last?.value));
      let reason = !s.last ? 'initial' : transition ? 'quality-or-availability' : force ? 'forced'
        : freshUpdate && (crossingZero || exact && changed) ? 'state-change'
        : !periodic && freshUpdate && o.sourceTime - s.last.sourceTime >= this.config.maxIntervalMs ? 'maximum-interval'
        : freshUpdate && changed && Math.abs(o.value - s.last.value) > threshold ? 'learned-change' : null;
      // Repeated unavailable/stale polls compact into coverage, never fake data.
      if (!fresh && s.last && !transition && !force) reason = null;
      const prior = s.last;
      let committed = null;
      if (reason) {
        const raw = compactRaw(o.raw);
        raw.recorder = { version: VERSION, reason, threshold: exact ? null : threshold,
          originalSourceTime: o.sourceTime, status, temporalBasis: 'source-observation' };
        committed = { ...o, raw, quality: fresh ? o.quality : flags([...o.quality,status]) };
        committed.id = this.store.observation(committed);
        s.last = { id:committed.id,value:o.value,sourceTime:o.sourceTime,receivedAt:o.receivedAt,
          quality:o.quality,usableForControl:o.raw?.usableForControl,semanticQuality:semanticQuality(o.raw) };
        s.unit=o.unit;
      }
      this.coverage(s,o,status,freshUpdate);
      if (periodic) s.reportUnavailableSince = fresh ? null : s.reportUnavailableSince ?? o.receivedAt;
      const elapsed = s.lastPollAt === null ? 0 : Math.min(o.receivedAt - s.lastPollAt,this.config.maxIntervalMs);
      // Error is the held saved value at every acquisition, time weighted so
      // bursts of readings do not count as extra independent accuracy evidence.
      const error = fresh && prior && s.scale > 0 ? Math.abs(o.value-prior.value)/s.scale : null;
      this.count(s,o.receivedAt,{saved:Boolean(reason),error,elapsed,bytes:committed ? Buffer.byteLength(JSON.stringify(committed)) : 0});
      s.lastPollAt = o.receivedAt;
      if (fresh) s.lastSourceTime = Math.max(s.lastSourceTime ?? o.sourceTime,o.sourceTime);
      this.store.setState(stateKey(s.key),s); this.store.setState(GLOBAL_KEY,g);
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
    const { source = 'easee', device, prefix, start, end, energies, powers, quality = [], receivedAt = end } = interval;
    const signals = energySignals(prefix);
    if (!signals || !finiteTime(start) || !finiteTime(end) || end <= start
      || !finiteTime(receivedAt) || !Array.isArray(energies) || energies.length !== signals.length
      || energies.some(n => !Number.isFinite(n) || n < 0) || !Array.isArray(powers) || powers.length !== signals.length
      || powers.some(n => !Number.isFinite(n) || n < 0)) throw new TypeError('Invalid phase energy interval');
    return this.store.transaction(() => {
      const checkpointKey = `recorder:energy:${JSON.stringify([source,device,prefix])}`;
      const state = this.store.getState(checkpointKey) ?? { lastEnd:null,pending:null,lastPowers:null,scales:signals.map(()=>null),lastQuality:null };
      if (state.lastEnd !== null && end <= state.lastEnd) return { saved:false,reason:'duplicate-interval',observations:[] };
      if (state.lastEnd !== null && start < state.lastEnd) throw new Error('Overlapping energy integration intervals');
      const q = flags(quality), g = this.global(receivedAt), observations = [], previousPowers = state.lastPowers;
      // Close the previous valid interval before any gap or quality transition;
      // do not spread its energy over missing time or blend measurement bases.
      if (state.pending && (state.pending.end !== start || !same(state.pending.quality,q)))
        observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,'boundary'));
      if (!state.pending) state.pending = {start,end,energies:signals.map(()=>0),quality:q};
      for (let i=0;i<signals.length;i++) state.pending.energies[i] += energies[i];
      state.pending.end = end; state.lastEnd = end;
      let changed = false;
      for (let i=0;i<signals.length;i++) {
        const s = state.scales[i] ?? {mean:null,variance:0,step:0,previousValue:null,lastFreshAt:null,scale:0};
        this.scale(s,powers[i],end); state.scales[i] = s;
        if (state.lastPowers && ((powers[i] === 0) !== (state.lastPowers[i] === 0)
          || Math.abs(powers[i]-state.lastPowers[i]) > Math.max(s.scale*g.tolerance,numericalFloor(powers[i],state.lastPowers[i])))) changed = true;
      }
      const reason = state.lastPowers === null ? 'initial' : !same(state.lastQuality,q) ? 'quality-or-availability'
        : changed ? 'learned-change' : end-state.pending.start >= this.config.maxIntervalMs ? 'maximum-interval' : null;
      if (reason) observations.push(...this.commitEnergy(state,source,device,prefix,receivedAt,reason));
      for (let i=0;i<signals.length;i++) {
        const s = this.signalState({source,device,signal:signals[i],unit:'kWh'},receivedAt);
        s.scale = state.scales[i].scale; s.lastPollAt = receivedAt;
        this.count(s,receivedAt,{elapsed:end-start,error:previousPowers && s.scale>0 ? Math.abs(powers[i]-previousPowers[i])/s.scale : null});
        this.store.setState(stateKey(s.key),s);
      }
      this.store.setState(checkpointKey,state); this.store.setState(GLOBAL_KEY,g);
      return {saved:observations.length>0,reason:reason ?? 'within-threshold',observations};
    });
  }

  commitEnergy(state,source,device,prefix,receivedAt,reason) {
    const p = state.pending;
    if (!p) return [];
    const signals = energySignals(prefix);
    const observations = p.energies.map((value,i) => {
      const o = {source,device,signal:signals[i],value,unit:'kWh',sourceTime:p.end,receivedAt,
        quality:p.quality,raw:{intervalStart:p.start,intervalEnd:p.end,durationMs:p.end-p.start,
          basis:prefix==='ev2'?'integrated-total-power':'integrated-power-phase-allocation',recorder:{version:VERSION,reason,group:prefix}}};
      o.id = this.store.observation(o);
      const s = this.signalState(o,receivedAt);
      const previous = s.last;
      s.last = {id:o.id,value,sourceTime:p.end,receivedAt,quality:p.quality};
      s.lastPollAt = receivedAt; s.lastSourceTime = p.end;
      s.scale = state.scales[i]?.scale ?? 0;
      this.coverage(s,o,'fresh');
      this.count(s,receivedAt,{saved:true,polls:0,elapsed:previous ? p.end-previous.sourceTime : 0,bytes:Buffer.byteLength(JSON.stringify(o))});
      this.store.setState(stateKey(s.key),s);
      return o;
    });
    // This is exactly reconstructible from the recorded energy and duration.
    // The last acquisition endpoint alone is not the recorded approximation.
    state.lastPowers = p.energies.map(value=>value*HOUR/(p.end-p.start));
    state.lastQuality = p.quality;
    state.pending = null;
    return observations;
  }

  energyGap({ source = 'easee', device, prefix, start, end, quality = ['acquisition-failed'] }) {
    const signals = energySignals(prefix);
    if (!signals || !finiteTime(start) || !finiteTime(end) || end < start)
      throw new TypeError('Invalid phase energy gap');
    return this.store.transaction(() => {
      const key = `recorder:energy:${JSON.stringify([source,device,prefix])}`, state = this.store.getState(key);
      const observations = state ? this.commitEnergy(state,source,device,prefix,end,'availability-boundary') : [];
      if (state) { state.lastPowers = null; state.lastQuality = null; this.store.setState(key,state); }
      for (const signal of signals) {
        const result = this.record({source,device,signal,value:null,unit:'kWh',
          sourceTime:end,receivedAt:end,quality:flags([...quality,'missing']),
          raw:{basis:'availability-gap',intervalStart:start,intervalEnd:end,durationMs:end-start}});
        if (result.saved) observations.push(result.observation);
      }
      return observations;
    });
  }

  /** Flush only completed acquisition intervals; never extrapolate through an
   * outage. Normal callers need not force writes; shutdown may finalize pending.
   */
  flush(now = this.clock(), { force = false } = {}) {
    return this.store.transaction(() => {
      const observations = [];
      for (const row of this.store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%'").all()) {
        const s = JSON.parse(row.value), p = s.pending;
        if (!p || !force && now-p.start < this.config.maxIntervalMs) continue;
        const [source,device,prefix] = JSON.parse(row.key.slice('recorder:energy:'.length));
        observations.push(...this.commitEnergy(s,source,device,prefix,now,force ? 'flush' : 'maximum-interval'));
        this.store.setState(row.key,s);
      }
      this.store.setState(GLOBAL_KEY,this.global(now));
      return observations;
    });
  }

  committedAt(signal,at) {
    if (!finiteTime(at)) throw new TypeError('Invalid committed timestamp');
    const row = this.store.db.prepare(`SELECT * FROM observations WHERE signal=? AND source_time<=? AND received_at<=?
      AND import_id IS NULL ORDER BY source_time DESC,id DESC LIMIT 1`).get(signal,at,at);
    if (!row) return null;
    const o = {id:row.id,source:row.source,device:row.device,signal:row.signal,value:row.value,unit:row.unit,
      sourceTime:row.source_time,receivedAt:row.received_at,quality:JSON.parse(row.quality),raw:row.raw ? JSON.parse(row.raw) : null};
    if (o.raw?.acquisitionOnly || o.raw?.auditOnly) return null;
    const reportAge = temperatureReportMaxAge(o);
    if (reportAge !== null) {
      const span = this.store.db.prepare(`SELECT * FROM recorder_coverage WHERE source=? AND device=? AND signal=?
        AND start_at<=? ORDER BY start_at DESC,id DESC LIMIT 1`).get(o.source,o.device,signal,at);
      const available = span?.status==='fresh' && at<=span.source_time+reportAge;
      return {...o,value:available?o.value:null,quality:available?o.quality:flags([...o.quality,span?.status==='fresh'?'missing-report':span?.status??'unavailable']),
        reportObservedAt:span?.end_at<=at?span.source_time:null,
        reportReceivedAt:span?.end_at<=at?span.end_at:null,
        reportExpiresAt:available?Math.min(span.source_time+reportAge,span.end_at>at?at:Infinity):null};
    }
    const coverage = this.store.db.prepare(`SELECT * FROM recorder_coverage WHERE signal=? AND start_at<=? AND end_at<=?
      ORDER BY end_at DESC,id DESC LIMIT 1`).get(signal,at,at);
    if (coverage && coverage.end_at >= o.receivedAt) {
      if (coverage.status !== 'fresh') return {...o,value:null,quality:flags([...o.quality,coverage.status])};
      if (coverage.observation_id === o.id && coverage.source_time > o.sourceTime)
        return {...o,sourceTime:coverage.source_time,receivedAt:coverage.end_at,
          raw:{...o.raw,recorder:{...o.raw?.recorder,originalSourceTime:o.sourceTime,temporalBasis:'held-recorded-value',coverageId:coverage.id}}};
    }
    return o;
  }

  latestCommitted(signal) { return this.committedAt(signal,this.clock()); }

  status(now = this.clock()) {
    const g = this.store.getState(GLOBAL_KEY) ?? this.global(now);
    const revision = this.store.db.prepare(`SELECT (SELECT MAX(id) FROM observations) observations,
      (SELECT MAX(id) FROM provider_snapshot_fetches) snapshots,(SELECT MAX(id) FROM recorder_coverage) coverage`).get();
    const rows = this.store.db.prepare("SELECT value FROM state WHERE key LIKE 'recorder:signal:%'").all();
    const states = rows.map(row=>JSON.parse(row.value)).filter(isRecordedDataset);
    // Constant temperatures extend existing coverage rows. Give their report
    // deadlines a separate revision so long plots can refresh without following
    // every fast power acquisition. Device identifiers stay out of the revision.
    const temperatureReportRevision = JSON.stringify(states.filter(s=>s.reportPolicy)
      .map(s=>[s.signal,s.lastSourceTime,s.coverageId,s.status]).sort((a,b)=>a[0].localeCompare(b[0])||a[2]-b[2]));
    const latestCoverage = this.store.db.prepare('SELECT source_time FROM recorder_coverage WHERE id=?');
    const parameters = states.map(s => {
      const stats = {};
      const history = this.store.db.prepare('SELECT * FROM recorder_metrics WHERE key=? AND bucket>=? ORDER BY bucket')
        .all(s.key,now-7*DAY-HOUR);
      for (const [label,span] of [['hour',HOUR],['day',DAY],['week',7*DAY]]) {
        const buckets = history.filter(b => b.bucket+HOUR > now-span);
        const records = buckets.reduce((n,b)=>n+b.records,0), polls = buckets.reduce((n,b)=>n+b.polls,0);
        const duration = Math.min(span,Math.max(0,now-s.startedAt)), errorTime = buckets.reduce((n,b)=>n+b.error_time,0);
        stats[label] = {records,polls,averageIntervalMs:records>1 ? duration/(records-1) : null,
          normalizedRmsError:errorTime ? Math.sqrt(buckets.reduce((n,b)=>n+b.error_squared_time,0)/errorTime) : null,
          estimatedBytes:buckets.reduce((n,b)=>n+b.bytes,0)};
      }
      const grouped = /_energy_l[123]$/.test(s.signal), totalEnergy = s.signal==='ev2_energy', exact = Boolean(s.reportPolicy) || ['state','code'].includes(s.unit) || EXACT.test(s.signal);
      return {signal:s.signal,source:s.source,unit:s.unit,status:s.status,lastSavedAt:s.last?.receivedAt ?? null,
        lastSourceTime:s.lastSourceTime,lastPollAt:s.lastPollAt,scale:s.scale,
        freshness:recordingFreshness(s,s.coverageId ? latestCoverage.get(s.coverageId) : null,now),
        threshold:exact ? null : s.scale*g.tolerance,thresholdUnit:grouped || totalEnergy ? 'kW' : s.unit,
        optimizedQuantity:grouped ? 'phase-power' : totalEnergy ? 'total-power' : 'value',grouped,...stats};
    }).sort((a,b)=>a.signal.localeCompare(b.signal));
    return {version:VERSION,...this.config,historyRevision:JSON.stringify(revision),temperatureReportRevision,normalizedTolerance:g.tolerance,measuredDatabaseBytes:this.store.databaseBytes(),
      bytesPerDay:g.bytesPerDay,bytesPerDay7d:g.bytesPerDay7d,projectedAnnualBytes:g.bytesPerDay7d*YEAR/DAY,
      measurementHours:g.measuredHours,budgetBasis:'soft-rolling-growth',parameters};
  }
}

function energySignals(prefix) {
  return prefix === 'ev2' ? ['ev2_energy'] : ['ev1','property'].includes(prefix)
    ? [1,2,3].map(phase=>`${prefix}_energy_l${phase}`) : null;
}

function compactRaw(raw) {
  if (!raw || typeof raw !== 'object') return {};
  // Repeated MQTT payload text and device metadata have no independent numeric
  // information. Retain interpretation, quality and lineage used by consumers.
  const allowed = ['usableForControl','timeBasis','sensorMeasuredAt','installationVerified','verification','register',
    'verified','retained','cached','publicationMayUseGatewayCache','verificationEvidence',
    'basis','energyBasis','source','issuedAt','fetchedAt','snapshotId','provenance','intervalStart','intervalEnd','durationMs',
    'modelVersion','controllerPhase','estimated','forecast','reportIntervalMs','reportGraceMs',
    'reportPolicyChangedAt','originalReportReceivedAt','originalReportSourceTime','originalReportTimeBasis','transportRecoveredAt','temperatureRouteSignature'];
  return Object.fromEntries(allowed.filter(key=>raw[key] !== undefined).map(key=>[key,raw[key]]));
}
