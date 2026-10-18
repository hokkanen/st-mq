import { selectedHistoryPredicate } from '../storage/schema.js';

export const CHARGING_ALLOWANCE_SIGNALS = Object.freeze({ charger1: 'charger1_current_allowance', charger2: 'charger2_current_allowance' });
export const CHARGING_ALLOWANCE_MODES = Object.freeze(['unknown', 'inactive', 'unrestricted', 'limited', 'fallback']);
const SOURCE = 'charging-allowance';
// Charger 1 follows the existing minute update; Shelly publishes on its five-second poll.
const COVERAGE_GAP_MS = Object.freeze({ charger1: 90_000, charger2: 30_000 });
const COVERAGE_SAVE_MS = Object.freeze({ charger1: 60_000, charger2: 5_000 });
const APPLICATION = new Set(['confirmed', 'idle', 'pending', 'blocked', 'unknown', 'inactive']);
const current = value => Number.isFinite(value) && value >= 0 && value <= 1000 ? value : null;
const reasonCode = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : null;
const unknownLimiter = reason => ({ mode: 'unknown', allowanceA: null, loadAllowanceA: null,
  reason, appliedCurrentA: null, applicationStatus: 'unknown' });

/** This is a controller decision and separate native-setting readback. Neither
 * the selected allowance nor a confirmed setting claims actual charging draw. */
export function shellyLimiterStatus({ enabled, connected, online, maximumCurrentA, limit,
  appliedCurrentA = null, applicationStatus = 'unknown', pausedByLimiter = false } = {}) {
  if (enabled === false) return { ...unknownLimiter('limiter-disabled'), mode: 'inactive', applicationStatus: 'inactive' };
  if (online !== true) return unknownLimiter('charger-unavailable');
  if (typeof connected !== 'boolean' || enabled !== true || !limit || current(limit.currentA) === null)
    return unknownLimiter('limiter-unavailable');
  const allowanceA = current(limit.currentA), loadAllowanceA = current(limit.loadCurrentA);
  const mode = limit.fallback === true ? 'fallback'
    : connected && pausedByLimiter && loadAllowanceA === 0 ? 'paused-by-balancing'
      : loadAllowanceA === null || current(maximumCurrentA) === null ? 'unknown'
        : loadAllowanceA >= maximumCurrentA ? 'unrestricted' : 'limited';
  return { mode, allowanceA, loadAllowanceA,
    reason: reasonCode(loadAllowanceA !== null && allowanceA < loadAllowanceA ? limit.reason ?? limit.loadReason
      : limit.fallback ? limit.fallbackReason ?? limit.reason : limit.loadReason ?? limit.reason) ?? 'limiter-unavailable',
    appliedCurrentA: current(appliedCurrentA), applicationStatus: connected === false ? 'inactive'
      : APPLICATION.has(applicationStatus) ? applicationStatus : 'unknown' };
}


const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const unknown = (reason, extra = {}) => ({ mode: 'unknown', allowanceA: null, maximumCurrentA: null,
  reportedAllowanceA: null, reason, source: null, measuredAt: null, receivedAt: null, sourceTimes: [], sourceEpoch: null, limiter: null, ...extra });

/** The Equalizer minimum is capped only by fixed equipment limits. A schedule,
 * adjustable setting, vehicle restriction, or local OCPP status is not its source. */
export function easeeAllowanceStatus({ enabled = true, telemetry = {}, now = Date.now() } = {}) {
  if (!enabled) return unknown('charger-disabled', { mode: 'inactive' });
  if (telemetry.providerConnected !== true) return unknown('charger-unavailable');
  if (telemetry.externalLoadBalancing === false) return unknown('equalizer-disabled', { mode: 'inactive' });
  const field = telemetry.availableCurrentA, maximum = telemetry.maxCurrentA;
  const times = (field?.inputs ?? []).map(row => timestamp(row.measuredAt));
  const receivedAt = timestamp(field?.receivedAt), measuredAt = times.length === 3 && times.every(at => at !== null) ? Math.min(...times) : null;
  const maximumCurrentA = maximum?.available ? current(maximum.value) : null;
  const evidence = field?.sourceEvidence;
  const healthyStream = evidence?.source === 'easee-stream' && evidence.connected === true
    && evidence.synchronized === true && evidence.online === true && evidence.epoch != null;
  const base = { source: 'easee-equalizer', maximumCurrentA, receivedAt, measuredAt, sourceTimes: times,
    sourceEpoch: evidence?.epoch == null ? null : `${evidence.source}:${evidence.epoch}` };
  if (field?.available !== true || current(field.value) === null || field.source !== 'easee-equalizer'
    || evidence && (evidence.connected !== true || evidence.synchronized !== true || evidence.online === false)
    || receivedAt === null || receivedAt > now || !healthyStream && now - receivedAt > 300_000
    || measuredAt === null || times.some(at => at > now) || maximumCurrentA === null)
    return unknown('equalizer-allowance-unavailable', base);
  const allowanceA = Math.min(field.value, maximumCurrentA);
  return { ...unknown('equalizer-allowance'), ...base, allowanceA, reportedAllowanceA: field.value,
    mode: allowanceA > 0 && allowanceA >= maximumCurrentA ? 'unrestricted' : 'limited' };
}

/** Keep observed capacity separate from the effective setting and confirmed
 * readback. An unplugged capacity observation grants no instruction to apply. */
export function shellyAllowanceStatus({ limiter, limit, maximumCurrentA, evaluatedAt = null, sourceEpoch = null } = {}) {
  const known = limiter && ['unrestricted', 'limited', 'paused-by-balancing', 'fallback'].includes(limiter.mode)
    && current(limiter.loadAllowanceA) !== null;
  // The allowance and the effective setting have independent reasons. A car
  // or native setting below the available capacity must not replace its basis.
  const allowanceReason = known ? reasonCode(limiter.mode === 'fallback' ? limit?.fallbackReason : limit?.loadReason) : null;
  return { ...unknown(known ? allowanceReason ?? 'allowance-reason-unavailable' : limiter?.reason ?? 'limiter-unavailable'),
    mode: known ? limiter.mode === 'paused-by-balancing' ? 'limited' : limiter.mode : limiter?.mode === 'inactive' ? 'inactive' : 'unknown',
    allowanceA: known ? limiter.loadAllowanceA : null, maximumCurrentA: current(maximumCurrentA),
    source: 'st-mq-load-balancing', sourceEpoch, measuredAt: timestamp(evaluatedAt), receivedAt: timestamp(evaluatedAt),
    limiter: limiter ?? null };
}

function canonicalStatus(value) {
  const keys = ['mode', 'allowanceA', 'maximumCurrentA', 'reportedAllowanceA', 'reason', 'source', 'measuredAt', 'receivedAt', 'sourceTimes', 'sourceEpoch', 'limiter'];
  const limiterKeys = ['mode', 'allowanceA', 'loadAllowanceA', 'reason', 'appliedCurrentA', 'applicationStatus'];
  if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || !CHARGING_ALLOWANCE_MODES.includes(value.mode) || reasonCode(value.reason) === null
    || ![null, 'easee-equalizer', 'st-mq-load-balancing'].includes(value.source)
    || value.sourceEpoch !== null && (typeof value.sourceEpoch !== 'string' || value.sourceEpoch.length > 160)
    || ['allowanceA', 'maximumCurrentA', 'reportedAllowanceA'].some(key => value[key] !== null && current(value[key]) === null)
    || ['unknown', 'inactive'].includes(value.mode) !== (value.allowanceA === null)
    || ['measuredAt', 'receivedAt'].some(key => value[key] !== null && timestamp(value[key]) === null)
    || !Array.isArray(value.sourceTimes) || ![0, 3].includes(value.sourceTimes.length)
    || value.sourceTimes.some(at => at !== null && timestamp(at) === null)
    || value.limiter !== null && (Object.keys(value.limiter).length !== limiterKeys.length
      || Object.keys(value.limiter).some(key => !limiterKeys.includes(key))
      || ![...CHARGING_ALLOWANCE_MODES, 'paused-by-balancing'].includes(value.limiter.mode)
      || !APPLICATION.has(value.limiter.applicationStatus) || reasonCode(value.limiter.reason) === null
      || ['allowanceA', 'loadAllowanceA', 'appliedCurrentA'].some(key => value.limiter[key] !== null && current(value.limiter[key]) === null)))
    throw new TypeError('Invalid charging allowance history status');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function observationUpdate(previous, { chargerId, association, status } = {}, now) {
  if (!Object.hasOwn(CHARGING_ALLOWANCE_SIGNALS, chargerId) || !Number.isSafeInteger(now) || now < 0
    || typeof association !== 'string' || !/^[a-f0-9]{64}$/.test(association))
    throw new TypeError('Allowance history requires charger and equipment identity and a valid observation time');
  const value = canonicalStatus(status ?? unknown('allowance-unavailable'));
  const { measuredAt, receivedAt, sourceTimes, ...meaning } = value;
  const signature = JSON.stringify([association, meaning]);
  const continuous = Boolean(previous && previous.association === association && previous.sourceEpoch === value.sourceEpoch
    && now - previous.at <= COVERAGE_GAP_MS[chargerId]);
  return { chargerId, association, value, signature, continuous,
    same: continuous && signature === previous.signature,
    outOfOrder: Boolean(previous && now < previous.at), sourceTime: measuredAt ?? now };
}

/** One exact state per semantic change. Repeated confirmations advance bounded
 * RAM coverage, persisted at the source cadence or before a state boundary.
 * Original source clocks stay separate; restart and delayed ticks leave gaps. */
export class ChargingAllowanceHistory {
  constructor({ store, input }) {
    if (!store?.db || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
      throw new TypeError('A history store and supported input are required');
    this.store = store; this.input = input; this.previous = new Map();
  }
  remember(chargerId, next) {
    const previous = this.previous.get(chargerId);
    if (this.store.transactionDepth) this.store.afterRollback(() => {
      if (previous) this.previous.set(chargerId, previous); else this.previous.delete(chargerId);
    });
    if (next) this.previous.set(chargerId, next); else this.previous.delete(chargerId);
  }
  suspend(chargerId) {
    for (const id of chargerId ? [chargerId] : [...this.previous.keys()]) this.remember(id, null);
  }
  needsWrite(observation = {}, now) {
    const previous = this.previous.get(observation.chargerId);
    const update = observationUpdate(previous, observation, now);
    return !update.outOfOrder && (!update.same || now - previous.persistedAt >= COVERAGE_SAVE_MS[update.chargerId]);
  }
  extend(previous, at = previous.at, sourceTime = previous.sourceTime, samples = previous.pendingSamples) {
    this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+? WHERE id=?')
      .run(at, sourceTime, samples, previous.coverageId);
  }
  flush(chargerId) {
    if (chargerId !== undefined && !Object.hasOwn(CHARGING_ALLOWANCE_SIGNALS, chargerId))
      throw new TypeError('Unknown charger allowance history');
    const pending = [...this.previous].filter(([id, previous]) => (chargerId === undefined || chargerId === id) && previous.pendingSamples);
    if (!pending.length) return 0;
    return this.store.transaction(() => {
      for (const [id, previous] of pending) {
        this.extend(previous);
        this.remember(id, { ...previous, persistedAt: previous.at, pendingSamples: 0 });
      }
      return pending.length;
    });
  }
  observe(observation = {}, now) {
    const previous = this.previous.get(observation.chargerId);
    const { chargerId, association, value, signature, continuous, same, sourceTime, outOfOrder } = observationUpdate(previous, observation, now);
    if (outOfOrder) return { saved: false, reason: 'out-of-order' };
    if (same) {
      const next = { ...previous, at: now, sourceTime, pendingSamples: previous.pendingSamples + 1 };
      if (now - previous.persistedAt < COVERAGE_SAVE_MS[chargerId]) {
        this.remember(chargerId, next);
        return { saved: false, id: previous.id };
      }
      return this.store.transaction(() => {
        this.extend(next);
        this.remember(chargerId, { ...next, persistedAt: now, pendingSamples: 0 });
        return { saved: false, id: previous.id };
      });
    }
    return this.store.transaction(() => {
      if (previous) {
        // Only a continuous usable transition can close the preceding state at
        // this receipt. Unknown/lost/replaced sources confirm no later coverage.
        if (continuous && (value.mode !== 'unknown' || previous.mode === 'unknown'))
          this.extend(previous, now, previous.sourceTime, previous.pendingSamples + 1);
        else if (previous.pendingSamples) this.extend(previous);
      }
      const signal = CHARGING_ALLOWANCE_SIGNALS[chargerId];
      const id = this.store.observation({ source: SOURCE, device: association, signal,
        value: value.allowanceA, unit: 'A', sourceTime, receivedAt: now,
        quality: [value.source === 'easee-equalizer' ? 'native-allowance' : 'controller-decision', value.mode],
        raw: { input: this.input, allowance: value, timeBasis: 'controller-observed',
          recorder: { policy: 'change-only', reason: 'state-change' } } });
      const coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(SOURCE, association, signal, 'fresh', now, now, sourceTime, id).lastInsertRowid);
      this.remember(chargerId, { signature, association, sourceEpoch: value.sourceEpoch, mode: value.mode,
        at: now, sourceTime, persistedAt: now, pendingSamples: 0, coverageId, id });
      return { saved: true, id };
    });
  }
}

// One pending overlap cluster is enough: once a second record overlaps it,
// the union is unknown. Earlier non-overlapping prefixes can be emitted now.
function* allowanceSpans(rows, from, to, truncated) {
  let pending = null, edge = from, any = false;
  for (const row of rows) {
    const start = Math.max(from, row.start_at), end = Math.min(to, row.end_at);
    if (end <= start) continue;
    any = true;
    let value = row.chartAllowance;
    if (!value) {
      try { value = canonicalStatus(JSON.parse(row.raw).allowance); } catch { value = unknown('invalid-history'); }
      row.chartAllowance = value;
    }
    if (pending && start < pending.end) {
      if (start > pending.start) yield { ...pending, end: start };
      pending = { start, end: Math.max(pending.end, end), ...unknown('overlapping-history'), equipment: null };
      continue;
    }
    if (pending) { yield pending; edge = pending.end; }
    if (start > edge) yield { start: edge, end: start,
      ...unknown(truncated && edge === from ? 'history-detail-required' : 'unobserved'), equipment: null };
    pending = { start, end, ...value, equipment: row.device };
  }
  if (pending) { yield pending; edge = pending.end; }
  if (any && edge < to) yield { start: edge, end: to, ...unknown('unobserved'), equipment: null };
}

export function readChargingAllowanceHistory({ store, range, now, input, maxSpans = 4000, onSpan }) {
  const from = range.from, to = Math.min(range.to, now);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isInteger(maxSpans) || maxSpans < 2 || maxSpans > 10_000
    || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
    throw new TypeError('Invalid allowance history range or limit');
  return Object.fromEntries(Object.entries(CHARGING_ALLOWANCE_SIGNALS).map(([chargerId, signal]) => {
    const result = { spans: [], truncated: false };
    if (to <= from) return [chargerId, result];
    const visit = onSpan?.[chargerId];
    const query = store.db.prepare(`SELECT c.id,c.device,c.start_at,c.end_at,o.raw FROM recorder_coverage c
      JOIN observations o ON o.id=c.observation_id WHERE c.signal=? AND c.source=?
        AND c.end_at>? AND c.start_at<? AND o.received_at<=?
        AND json_extract(o.raw,'$.input') ${input === 'simulated' ? '=' : '<>'} 'simulated'
        AND ${selectedHistoryPredicate('recorder_coverage', 'c')} AND ${selectedHistoryPredicate('observations', 'o')}
      ORDER BY ${visit ? 'c.start_at,c.id' : 'c.end_at DESC,c.id DESC LIMIT ?'}`);
    let rows;
    if (visit) rows = query.iterate(signal, SOURCE, from, to, now);
    else {
      rows = query.all(signal, SOURCE, from, to, now, maxSpans + 1);
      result.truncated = rows.length > maxSpans;
      if (result.truncated) rows.length = maxSpans;
      rows.sort((a, b) => a.start_at - b.start_at || a.id - b.id);
    }
    if (!visit) result.spans = [...allowanceSpans(rows, from, to, result.truncated)];
    else {
      const ring = new Array(maxSpans); let count = 0, offset = 0;
      function* retainedRows() {
        for (const row of rows) {
          if (count === maxSpans) { ring[offset] = row; offset = (offset + 1) % maxSpans; result.truncated = true; }
          else ring[count++] = row;
          yield row;
        }
      }
      for (const span of allowanceSpans(retainedRows(), from, to, false)) visit(span);
      const recent = Array.from({ length: count }, (_, index) => ring[(offset + index) % maxSpans]);
      // Reuse the already validated statuses; numeric detail keeps the same
      // recent-record budget, independently of full-period bar occupancy.
      result.spans = [...allowanceSpans(recent, from, to, result.truncated)];
    }
    return [chargerId, result];
  }));
}
