import moment from 'moment-timezone';
import { fireplaceLearningContext } from './fireplace-inputs.js';
import { fireplaceRate, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';

const WINDOW = 15 * 60_000;
export const FIREPLACE_INPUT_NAMES = ['firewood_load', 'model_fireplace_release'];
export const FIREWOOD_OUTCOME_NAMES = ['firewood_savings', 'firewood_electricity_avoided'];
const sourceLabel = input => input === 'simulated' ? 'Simulated fireplace records' : 'Manual fireplace records';

/** Manual fuel is retained once. Plot its current corrected interpretation in
 * memory, including tails from loads before the selected dates. No telemetry or
 * learner snapshots are manufactured for these derived inputs. */
export function addFireplaceInputs({ store, input, range, now, envelopes }) {
  const end = Math.min(now, range.to), source = input === 'offline' ? 'history' : input;
  const context = fireplaceLearningContext(store, source, undefined, now);
  const events = context.fireplaceEvents.filter(event => event.at <= end && event.at + FIREPLACE_HORIZON_MS > range.from)
    .sort((a, b) => a.at - b.at || a.id - b.id);
  const metadata = { inputSource: sourceLabel(input), fireplaceRevision: context.fireplaceRevision };
  const stats = { records: 0, releaseIntervals: 0, revision: context.fireplaceRevision,
    basis: 'corrected-manual-fireplace-history', loggingStartedAt: context.fireplaceStartedAt };
  if (envelopes.firewood_load) {
    const loads = new Map();
    for (const event of events) if (event.at >= range.from && event.at <= end) {
      const total = loads.get(event.at) ?? { kg: 0, count: 0 };
      total.kg += event.kg; total.count++; loads.set(event.at, total); stats.records++;
    }
    for (const [at, total] of loads) envelopes.firewood_load.add(at, total.kg,
      { ...metadata, manualFirewood: true, loadCount: total.count });
  }
  if (!envelopes.model_fireplace_release || end <= range.from) return stats;
  const known = context.fireplaceStartedAt;
  if (!Number.isFinite(known) || known >= end) {
    envelopes.model_fireplace_release.add(range.from, null, metadata); return stats;
  }
  let at = Math.max(range.from, known), cursor = 0, active = [];
  if (at > range.from) envelopes.model_fireplace_release.add(range.from, null, metadata);
  while (at < end) {
    const until = Math.min(end, (Math.floor(at / WINDOW) + 1) * WINDOW);
    while (cursor < events.length && events[cursor].at < until) active.push(events[cursor++]);
    active = active.filter(event => event.at + FIREPLACE_HORIZON_MS > at);
    // Preserve ignition boundaries as well as the fixed learning-window grid.
    const boundaries = [...new Set([at, until, ...active.map(event => event.at).filter(time => time > at && time < until)])]
      .sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const from = boundaries[i - 1], to = boundaries[i], rate = fireplaceRate(active, from, to);
      const detail = { ...metadata, modelInput: true, fireplaceRelease: true, intervalStart: from, intervalEnd: to };
      envelopes.model_fireplace_release.add(from, rate, detail);
      envelopes.model_fireplace_release.add(to - 1, rate, detail);
      stats.releaseIntervals++;
    }
    at = until;
  }
  envelopes.model_fireplace_release.add(end, null, metadata);
  return stats;
}

/** One total per Finnish calendar day, clipped to the selected elapsed dates.
 * An incomplete day stays an explicitly partial estimate; missing intervals are
 * never scaled up. Both card totals and chart points use the same intervals. */
export function addFirewoodOutcomes({ result, range, now, envelopes }) {
  const end = Math.min(now, range.to), days = new Map();
  for (let day = moment.tz(range.from, 'Europe/Helsinki').startOf('day'); day.valueOf() < end; day.add(1, 'day')) {
    const start = Math.max(range.from, day.valueOf()), until = Math.min(end, day.clone().add(1, 'day').valueOf());
    days.set(day.format('YYYY-MM-DD'), { start, end: until, cents: 0, kwh: 0, includedMs: 0, status: 'validated' });
  }
  for (const row of result.intervals ?? []) {
    if (!Number.isFinite(row.benefitCents) || !Number.isFinite(row.avoidedKwh) || row.end <= row.start) continue;
    let at = Math.max(row.start, range.from), until = Math.min(row.end, end);
    while (at < until) {
      const day = moment.tz(at, 'Europe/Helsinki'), bucket = days.get(day.format('YYYY-MM-DD'));
      const to = Math.min(until, day.startOf('day').add(1, 'day').valueOf()), ratio = (to - at) / (row.end - row.start);
      if (bucket) {
        bucket.cents += row.benefitCents * ratio; bucket.kwh += row.avoidedKwh * ratio;
        bucket.includedMs += Number.isFinite(row.includedMs) ? row.includedMs * ratio : to - at;
        if (row.status !== 'validated') bucket.status = 'provisional';
      }
      at = to;
    }
  }
  for (const bucket of days.values()) {
    const available = bucket.includedMs > 0;
    const metadata = { firewoodBenefit: true, status: available ? bucket.status : 'unavailable',
      intervalStart: bucket.start, intervalEnd: bucket.end,
      coverage: Math.min(1, bucket.includedMs / (bucket.end - bucket.start)),
      partial: bucket.includedMs < bucket.end - bucket.start,
      fireplaceRevision: result.summary?.fireplaceRevision, modelVersion: result.summary?.modelVersion };
    for (const [key, value] of [['firewood_savings', bucket.cents / 100], ['firewood_electricity_avoided', bucket.kwh]])
      envelopes[key]?.add(bucket.start, available ? value : null, metadata);
  }
  return { days: days.size, basis: 'retrospective-firewood-counterfactual', status: result.summary?.status ?? 'unavailable' };
}
