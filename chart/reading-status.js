/** Durations retain seconds at deadline boundaries instead of rounding a late
 * reading back down to its allowed age. Values never come from provider text. */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  let seconds = Math.ceil(ms / 1000);
  const parts = [];
  for (const [size, unit] of [[86400, 'd'], [3600, 'h'], [60, 'min'], [1, 's']]) {
    const amount = Math.floor(seconds / size);
    if (amount) parts.push(`${amount} ${unit}`);
    seconds %= size;
  }
  return parts.join(' ') || '0 s';
}

const labels = Object.freeze({
  'missing-reading': 'no genuine reading has been received',
  missing: 'no value was received',
  'invalid-value': 'the value is not a valid number',
  'invalid-numeric': 'the value is not a valid number',
  'invalid-payload': 'the message does not contain a valid numeric value',
  'unknown-source-time': 'the measurement time is unknown',
  'source-time-unknown': 'the measurement time is unknown',
  'unknown-receipt-time': 'the receipt time is unknown',
  'future-source-time': 'the measurement time is in the future',
  'future-receipt-time': 'the receipt time is in the future',
  'source-time-after-receipt': 'the measurement time is later than its receipt time',
  'unsupported-unit': 'the temperature unit is unsupported',
  'invalid-unit': 'the unit is unsupported',
  retained: 'the MQTT message is retained; a live report is required',
  disconnected: 'the sensor connection is disconnected',
  'subscription-failed': 'the sensor subscription failed',
  'report-policy-changed': 'waiting for a report under the changed reporting policy',
  'availability-transition': 'the source reported that readings are unavailable',
  'invalid-quality': 'the reading failed its source quality checks',
  'out-of-order-source-time': 'the report is older than a newer report already received',
  'conflicting-duplicate': 'readings disagree at the same measurement time',
  duplicate: 'the message repeats an earlier report',
  'unverified-h66': 'the H66 reading is not verified for use',
  'unverified-scaling': 'the H66 value scaling is unverified',
  'unknown-register': 'the H66 register is unsupported',
  'out-of-range': 'the temperature is outside the accepted range',
  'implausible-temperature': 'the temperature is outside the accepted range',
  'suspect-zero-indoor': 'the indoor temperature is implausible',
  'missing-report': 'the expected temperature report is missing',
  'sensor-settling': 'the sensor is settling after a recorded change',
  'before-sensor-change': 'the reading predates the recorded sensor change',
  'missing-member': 'a configured indoor sensor is unavailable',
  'controller-estimate': 'a controller estimate cannot replace a sensor measurement',
  'audit-only': 'the reading is recorded for diagnostics only',
  'awaiting-live-report': 'waiting for a live report since reconnection',
  'invalid-reading': 'the latest publication failed validation',
  'provider-error': 'the source request failed',
  'mqtt-disconnected': 'the MQTT connection is disconnected',
});

/** Never echo raw flags, identifiers, payloads or exception messages into UI. */
export function qualityReasonText(code) {
  if (typeof code !== 'string') return null;
  const key = code.replaceAll('_', '-');
  return Object.hasOwn(labels, key) ? labels[key] : null;
}
