import { indoorAverage, indoorWeights, INDOOR_ATTENTION_MS } from './indoor-sensors.js';

const HOUR = 3_600_000;
export const INDOOR_ESTIMATE_MAX_AGE_MS = 72 * HOUR;
const validTemperature = value => Number.isFinite(value) && value > 2 && value < 40;
// A report can confirm an unchanged measurement; reading a cache cannot.
const evidenceTime = reading => Math.max(reading?.observedAt ?? -Infinity, reading?.lastReportAt ?? -Infinity);
const fresh = (reading, now) => validTemperature(reading?.value) && !reading.stale
  && Number.isFinite(reading.observedAt) && reading.observedAt <= evidenceTime(reading)
  && !(reading.quality ?? []).some(flag => !['good', 'simulated', 'historical', 'converted_fahrenheit'].includes(flag))
  && !(reading.availabilityReasons ?? []).length && !reading.estimated
  && evidenceTime(reading) <= now && now - evidenceTime(reading) <= (reading.reportMaxAgeMs ?? INDOOR_ATTENTION_MS);

/** A separate control estimate. Never insert its output into observation history or learning. */
export function indoorControl(readings, config, now, savedAnchor = null, identity = '') {
  const measured = indoorAverage(readings, config), weights = indoorWeights(config), signals = Object.keys(weights);
  const signature = JSON.stringify([identity, weights]);
  let anchor = savedAnchor?.version === 1 && savedAnchor.signature === signature
    && Number.isFinite(savedAnchor.at) && savedAnchor.at <= now
    && signals.every(signal => validTemperature(savedAnchor.members?.[signal]?.value)
      && Number.isFinite(savedAnchor.members[signal].observedAt)
      && Number.isFinite(savedAnchor.members[signal].supportAt)
      && savedAnchor.members[signal].observedAt <= savedAnchor.members[signal].supportAt
      && savedAnchor.members[signal].supportAt >= savedAnchor.at && savedAnchor.members[signal].supportAt <= now
      && savedAnchor.members[signal].source === readings[signal]?.source) ? savedAnchor : null;
  if (signals.every(signal => fresh(readings[signal], now))) {
    // Keep the original source clocks, including healthy unchanged-value reports.
    const at = Math.min(...signals.map(signal => evidenceTime(readings[signal])));
    anchor = { version: 1, signature, at, members: Object.fromEntries(signals.map(signal => [signal, {
      value: readings[signal].value, source: readings[signal].source,
      observedAt: readings[signal].observedAt, supportAt: evidenceTime(readings[signal]),
    }])) };
    return { observation: { ...measured, estimated: false, uncertaintyC: 0 }, anchor };
  }
  if (!measured.stale) return { observation: { ...measured, estimated: false, uncertaintyC: 0 }, anchor };
  const unavailable = reason => ({ observation: { ...measured, estimated: false, estimateReason: reason }, anchor });
  const missing = signals.filter(signal => !fresh(readings[signal], now));
  if (signals.length !== 3 || missing.length !== 1) return unavailable('requires-two-fresh-rooms');
  if (!anchor) return unavailable('no-common-observed-anchor');
  if (now - anchor.at > INDOOR_ESTIMATE_MAX_AGE_MS) return unavailable('estimate-anchor-expired');
  if (signals.some(signal => (readings[signal]?.availabilityReasons ?? [])
    .some(reason => ['sensor-settling', 'before-sensor-change'].includes(reason)))) return unavailable('sensor-measurement-changed');
  const estimatedSensor = missing[0], online = signals.filter(signal => signal !== estimatedSensor);
  const changes = online.map(signal => readings[signal].value - anchor.members[signal].value);
  const onlineWeight = online.reduce((sum, signal) => sum + weights[signal], 0);
  const change = online.reduce((sum, signal, index) => sum + weights[signal] * changes[index], 0) / onlineWeight;
  const missingC = anchor.members[estimatedSensor].value + change;
  if (!validTemperature(missingC)) return unavailable('estimate-out-of-range');
  const ageHours = (now - anchor.at) / HOUR;
  const uncertaintyC = weights[estimatedSensor] * (0.3 + 0.02 * ageHours + Math.abs(changes[0] - changes[1]));
  const supportObservedAt = Object.fromEntries(online.map(signal => [signal, evidenceTime(readings[signal])]));
  return { anchor, observation: {
    value: online.reduce((sum, signal) => sum + weights[signal] * readings[signal].value, 0) + weights[estimatedSensor] * missingC,
    source: 'indoor-control-estimate', quality: ['estimated'], stale: false, estimated: true, weights,
    estimatedSensor, estimatedValueC: missingC, anchorAt: anchor.at,
    estimatedSourceObservedAt: anchor.members[estimatedSensor].observedAt, supportObservedAt,
    observedAt: Math.min(...Object.values(supportObservedAt)),
    uncertaintyC, uncertaintyGrowthCPerHour: weights[estimatedSensor] * 0.02,
    validUntil: anchor.at + INDOOR_ESTIMATE_MAX_AGE_MS, estimateReason: 'one-room-following-observed-trend',
  } };
}
