import { selectedHistoryPredicate } from '../storage/schema.js';

export const CHARGING_ALLOWANCE_SIGNALS = Object.freeze({ charger1: 'charger1_current_allowance', charger2: 'charger2_current_allowance' });
export const CHARGING_ALLOWANCE_MODES = Object.freeze(['unknown', 'inactive', 'unrestricted', 'limited', 'fallback']);
const SOURCE = 'charging-allowance';
// Charger 1 follows the existing minute update; Shelly publishes on its five-second poll.
const COVERAGE_GAP_MS = Object.freeze({ charger1: 90_000, charger2: 30_000 });
const APPLICATION = new Set(['confirmed', 'pending', 'blocked', 'unknown', 'inactive']);
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
  if (connected === false) return { ...unknownLimiter('disconnected'), mode: 'inactive', applicationStatus: 'inactive' };
  if (connected !== true || enabled !== true || !limit || current(limit.currentA) === null)
    return unknownLimiter('limiter-unavailable');
  const allowanceA = current(limit.currentA), loadAllowanceA = current(limit.loadCurrentA);
  const pending = limit.measurementPending === true && limit.fallback !== true;
  const mode = limit.fallback === true ? 'fallback'
    : pending ? 'unknown' : pausedByLimiter && loadAllowanceA === 0 ? 'paused-by-balancing'
      : loadAllowanceA === null || current(maximumCurrentA) === null ? 'unknown'
        : loadAllowanceA >= maximumCurrentA ? 'unrestricted' : 'limited';
  return { mode, allowanceA, loadAllowanceA,
    reason: pending ? 'measurement-pair-pending'
      : reasonCode(loadAllowanceA !== null && allowanceA < loadAllowanceA ? limit.reason ?? limit.loadReason
      : limit.fallback ? limit.fallbackReason ?? limit.reason : limit.loadReason ?? limit.reason) ?? 'limiter-unavailable',
    appliedCurrentA: current(appliedCurrentA), applicationStatus: APPLICATION.has(applicationStatus) ? applicationStatus : 'unknown' };
}


const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const unknown = (reason, extra = {}) => ({ mode: 'unknown', allowanceA: null, maximumCurrentA: null,
  reportedAllowanceA: null, reason, source: null, measuredAt: null, receivedAt: null, sourceTimes: [], sourceEpoch: null, limiter: null, ...extra });

/** The Equalizer minimum is capped only by fixed equipment limits. A schedule,
 * adjustable setting, vehicle restriction, or local OCPP status is not its source. */
export function easeeAllowanceStatus({ enabled = true, telemetry = {}, now = Date.now() } = {}) {
  if (!enabled) return unknown('charger-disabled', { mode: 'inactive' });
  if (telemetry.providerConnected !== true) return unknown('charger-unavailable');
  if (telemetry.connected?.available && telemetry.connected.value === false) return unknown('disconnected', { mode: 'inactive' });
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

/** Keep the load entitlement separate from the effective setting and confirmed
 * readback. An unpaired measurement hold cannot claim currently known headroom. */
export function shellyAllowanceStatus({ limiter, maximumCurrentA, evaluatedAt = null, sourceEpoch = null } = {}) {
  const known = limiter && ['unrestricted', 'limited', 'paused-by-balancing', 'fallback'].includes(limiter.mode)
    && current(limiter.loadAllowanceA) !== null;
  return { ...unknown(limiter?.reason ?? 'limiter-unavailable'),
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

/** One exact state per semantic change. Source/receipt clocks do not manufacture
 * new decisions: the state preserves its initial clocks and compact coverage
 * retains the latest source clock. Restart and delayed ticks leave real gaps. */
export class ChargingAllowanceHistory {
  constructor({ store, input }) {
    if (!store?.db || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
      throw new TypeError('A history store and supported input are required');
    this.store = store; this.input = input; this.previous = new Map();
  }
  suspend(chargerId) { if (chargerId) this.previous.delete(chargerId); else this.previous.clear(); }
  observe({ chargerId, association, status } = {}, now) {
    if (!Object.hasOwn(CHARGING_ALLOWANCE_SIGNALS, chargerId) || !Number.isSafeInteger(now) || now < 0
      || typeof association !== 'string' || !/^[a-f0-9]{64}$/.test(association))
      throw new TypeError('Allowance history requires charger and equipment identity and a valid observation time');
    const value = canonicalStatus(status ?? unknown('allowance-unavailable'));
    const { measuredAt, receivedAt, sourceTimes, ...meaning } = value;
    const signature = JSON.stringify([association, meaning]), previous = this.previous.get(chargerId);
    if (previous && now < previous.at) return { saved: false, reason: 'out-of-order' };
    const continuous = previous && previous.association === association && previous.sourceEpoch === value.sourceEpoch && now - previous.at <= COVERAGE_GAP_MS[chargerId];
    const same = continuous && signature === previous.signature, sourceTime = measuredAt ?? now;
    const next = this.store.transaction(() => {
      if (continuous && (value.mode !== 'unknown' || previous.mode === 'unknown'))
        this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+1 WHERE id=?')
          .run(now, sourceTime, previous.coverageId);
      if (same) return { ...previous, at: now };
      const signal = CHARGING_ALLOWANCE_SIGNALS[chargerId];
      const id = this.store.observation({ source: SOURCE, device: association, signal,
        value: value.allowanceA, unit: 'A', sourceTime, receivedAt: now,
        quality: [value.source === 'easee-equalizer' ? 'native-allowance' : 'controller-decision', value.mode],
        raw: { input: this.input, allowance: value, timeBasis: 'controller-observed',
          recorder: { policy: 'change-only', reason: 'state-change' } } });
      const coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(SOURCE, association, signal, 'fresh', now, now, sourceTime, id).lastInsertRowid);
      return { signature, association, sourceEpoch: value.sourceEpoch, mode: value.mode, at: now, coverageId, id };
    });
    this.previous.set(chargerId, next);
    return { saved: !same, id: next.id };
  }
}

export function readChargingAllowanceHistory({ store, range, now, input, maxSpans = 4000 }) {
  const from = range.from, to = Math.min(range.to, now);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isInteger(maxSpans) || maxSpans < 2 || maxSpans > 10_000
    || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
    throw new TypeError('Invalid allowance history range or limit');
  return Object.fromEntries(Object.entries(CHARGING_ALLOWANCE_SIGNALS).map(([chargerId, signal]) => {
    const result = { spans: [], truncated: false };
    if (to <= from) return [chargerId, result];
    const rows = store.db.prepare(`SELECT c.id,c.device,c.start_at,c.end_at,o.raw FROM recorder_coverage c
      JOIN observations o ON o.id=c.observation_id WHERE c.signal=? AND c.source=?
        AND c.end_at>? AND c.start_at<? AND o.received_at<=?
        AND json_extract(o.raw,'$.input') ${input === 'simulated' ? '=' : '<>'} 'simulated'
        AND ${selectedHistoryPredicate('recorder_coverage', 'c')} AND ${selectedHistoryPredicate('observations', 'o')}
      ORDER BY c.end_at DESC,c.id DESC LIMIT ?`).all(signal, SOURCE, from, to, now, maxSpans + 1);
    result.truncated = rows.length > maxSpans;
    if (result.truncated) rows.length = maxSpans;
    rows.sort((a, b) => a.start_at - b.start_at || a.id - b.id);
    if (!rows.length) return [chargerId, result];
    const append = (start, end, status, equipment = null) => { if (end > start) result.spans.push({ start, end, ...status, equipment }); };
    let edge = from;
    for (const row of rows) {
      const start = Math.max(from, row.start_at), end = Math.min(to, row.end_at);
      if (end <= start) continue;
      if (start > edge) append(edge, start, unknown(result.truncated && edge === from ? 'history-detail-required' : 'unobserved'));
      let value;
      try { value = canonicalStatus(JSON.parse(row.raw).allowance); } catch { value = unknown('invalid-history'); }
      if (start < edge) {
        while (result.spans.length && result.spans.at(-1).end > start) {
          const prior = result.spans.at(-1);
          if (prior.start < start) { prior.end = start; break; }
          result.spans.pop();
        }
        append(start, Math.max(edge, end), unknown('overlapping-history'));
      } else append(start, end, value, row.device);
      edge = Math.max(edge, end);
    }
    append(edge, to, unknown('unobserved'));
    return [chargerId, result];
  }));
}
