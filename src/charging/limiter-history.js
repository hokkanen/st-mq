import { selectedHistoryPredicate } from '../storage/schema.js';

export const SHELLY_LIMITER_SIGNAL = 'shelly_limiter_mode';
export const SHELLY_LIMITER_MODES = Object.freeze(['unknown', 'inactive', 'unrestricted', 'limited', 'paused-by-balancing', 'fallback']);
const SOURCE = 'charging-limiter';
const COVERAGE_GAP_MS = 30_000;
const APPLICATION = new Set(['confirmed', 'pending', 'blocked', 'unknown', 'inactive']);
const current = value => Number.isInteger(value) && value >= 0 && value <= 80 ? value : null;
const reasonCode = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : null;
const unknown = reason => ({ mode: 'unknown', allowanceA: null, loadAllowanceA: null,
  reason, appliedCurrentA: null, applicationStatus: 'unknown' });

/** This is a controller decision and separate native-setting readback. Neither
 * the selected allowance nor a confirmed setting claims actual charging draw. */
export function shellyLimiterStatus({ enabled, connected, online, maximumCurrentA, limit,
  appliedCurrentA = null, applicationStatus = 'unknown', pausedByLimiter = false } = {}) {
  if (enabled === false) return { ...unknown('limiter-disabled'), mode: 'inactive', applicationStatus: 'inactive' };
  if (online !== true) return unknown('charger-unavailable');
  if (connected === false) return { ...unknown('disconnected'), mode: 'inactive', applicationStatus: 'inactive' };
  if (connected !== true || enabled !== true || !limit || current(limit.currentA) === null)
    return unknown('limiter-unavailable');
  const allowanceA = current(limit.currentA), loadAllowanceA = current(limit.loadCurrentA);
  const settling = limit.settling === true && limit.fallback !== true;
  const mode = limit.fallback === true ? 'fallback'
    : settling ? 'unknown' : pausedByLimiter && loadAllowanceA === 0 ? 'paused-by-balancing'
      : loadAllowanceA === null || current(maximumCurrentA) === null ? 'unknown'
        : loadAllowanceA >= maximumCurrentA ? 'unrestricted' : 'limited';
  return { mode, allowanceA, loadAllowanceA,
    reason: settling ? 'measurement-settling'
      : reasonCode(limit.fallback ? limit.fallbackReason ?? limit.reason : limit.loadReason ?? limit.reason) ?? 'limiter-unavailable',
    appliedCurrentA: current(appliedCurrentA), applicationStatus: APPLICATION.has(applicationStatus) ? applicationStatus : 'unknown' };
}

function canonicalStatus(value) {
  const keys = ['mode', 'allowanceA', 'loadAllowanceA', 'reason', 'appliedCurrentA', 'applicationStatus'];
  if (!value || !SHELLY_LIMITER_MODES.includes(value.mode) || !APPLICATION.has(value.applicationStatus)
    || Object.keys(value).some(key => !keys.includes(key))
    || reasonCode(value.reason) === null
    || ['allowanceA', 'loadAllowanceA', 'appliedCurrentA'].some(key => value[key] !== null && current(value[key]) === null))
    throw new TypeError('Invalid Shelly limiter history status');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

/** One exact state row per changed decision/readback. Successful unchanged
 * observations only extend the existing coverage row. The cursor is deliberately
 * process-local: restart, ownership replacement, or a delayed control tick cannot
 * turn unobserved downtime into a continuous limiter state. No report retention
 * or restoration state is involved. */
export class ChargingLimiterHistory {
  constructor({ store, input }) {
    if (!store?.db || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
      throw new TypeError('A history store and supported input are required');
    this.store = store; this.input = input; this.previous = null;
  }
  suspend() { this.previous = null; }
  observe({ association, status } = {}, now) {
    if (!Number.isSafeInteger(now) || now < 0 || typeof association !== 'string' || !/^[a-f0-9]{64}$/.test(association))
      throw new TypeError('Limiter history requires equipment identity and a valid observation time');
    const value = canonicalStatus(status ?? unknown('limiter-unavailable'));
    const signature = JSON.stringify([association, value]), previous = this.previous;
    if (previous && now < previous.at) return { saved: false, reason: 'out-of-order' };
    const continuous = previous && previous.association === association && now - previous.at <= COVERAGE_GAP_MS;
    const same = continuous && signature === previous.signature;
    const next = this.store.transaction(() => {
      // An explicit unavailable observation supplies no evidence for the time
      // since the previous known observation. Keep that gap visible.
      if (continuous && (value.mode !== 'unknown' || previous.mode === 'unknown'))
        this.store.db.prepare('UPDATE recorder_coverage SET end_at=?,source_time=?,samples=samples+1 WHERE id=?')
          .run(now, now, previous.coverageId);
      if (same) return { ...previous, at: now };
      const id = this.store.observation({ source: SOURCE, device: association, signal: SHELLY_LIMITER_SIGNAL,
        value: SHELLY_LIMITER_MODES.indexOf(value.mode), unit: 'state', sourceTime: now, receivedAt: now,
        quality: ['controller-decision'], raw: { input: this.input, limiter: value,
          timeBasis: 'controller-observed', recorder: { policy: 'change-only', reason: 'state-change' } } });
      const coverageId = Number(this.store.db.prepare(`INSERT INTO recorder_coverage
        (source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,1)`)
        .run(SOURCE, association, SHELLY_LIMITER_SIGNAL, 'fresh', now, now, now, id).lastInsertRowid);
      return { signature, association, mode: value.mode, at: now, coverageId, id };
    });
    this.previous = next;
    return { saved: !same, id: next.id };
  }
}

/** Query exact covered spans with bounded memory/output. Missing coverage is
 * explicit, including the unconfirmed tail after the last runtime observation.
 * Dense selections retain recent exact transitions and mark the omitted prefix
 * unknown; zooming requests the omitted period independently. */
export function readShellyLimiterHistory({ store, range, now, input, maxSpans = 4000 }) {
  const from = range.from, to = Math.min(range.to, now);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || !Number.isInteger(maxSpans) || maxSpans < 2 || maxSpans > 10_000
    || !['providers', 'mqtt', 'offline', 'simulated'].includes(input))
    throw new TypeError('Invalid limiter history range or limit');
  const result = { chargerId: 'charger2', spans: [], truncated: false };
  if (to <= from) return result;
  const rows = store.db.prepare(`SELECT c.id,c.device,c.start_at,c.end_at,o.raw FROM recorder_coverage c
    JOIN observations o ON o.id=c.observation_id WHERE c.signal=? AND c.source=?
      AND c.end_at>? AND c.start_at<? AND o.received_at<=?
      AND json_extract(o.raw,'$.input') ${input === 'simulated' ? '=' : '<>'} 'simulated'
      AND ${selectedHistoryPredicate('recorder_coverage', 'c')} AND ${selectedHistoryPredicate('observations', 'o')}
    ORDER BY c.end_at DESC,c.id DESC LIMIT ?`).all(SHELLY_LIMITER_SIGNAL, SOURCE, from, to, now, maxSpans + 1);
  result.truncated = rows.length > maxSpans;
  if (result.truncated) rows.length = maxSpans;
  rows.sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  if (!rows.length) return result;
  const append = (start, end, status, equipment = null) => {
    if (end > start) result.spans.push({ start, end, ...status, equipment });
  };
  let edge = from;
  for (const row of rows) {
    const start = Math.max(from, row.start_at), end = Math.min(to, row.end_at);
    if (end <= start) continue;
    if (start > edge) append(edge, start, unknown(result.truncated && edge === from ? 'history-detail-required' : 'unobserved'));
    let value;
    try { value = canonicalStatus(JSON.parse(row.raw).limiter); } catch { value = unknown('invalid-history'); }
    // Concurrent writers or recovered overlaps do not establish one owner.
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
  return result;
}
