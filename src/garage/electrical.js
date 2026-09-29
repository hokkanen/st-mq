import { SHELLY_CN105_CONTRACT } from './contract.js';
const HOUR = 3_600_000;
const MAX_TIMING_INTERVAL_MS = 15 * 60_000;

/** One selected electrical path. Fast telemetry does not imply fast counter
 * updates, and a compressor-frequency reading never becomes electrical power. */
export function createGarageElectrical({ source = 'none', onEnergy = () => {}, persisted = null,
  contractVersion = SHELLY_CN105_CONTRACT } = {}) {
  const provisional = false;
  let previous = null;
  let lastEnd = Number.isSafeInteger(persisted?.lastEnd) ? persisted.lastEnd : null;
  let lastIssue = null;
  const snapshot = () => ({ source, lastEnd, lastIssue });
  const reset = reason => { previous = null; lastIssue = reason; };
  function receive(field) {
    if (source === 'none') return null;
    const signal = source === 'native-counter' ? 'garage_native_energy' : 'garage_power';
    if (field.signal !== signal) return null;
    if (!field.usable || field.meterScope !== 'garage-heat-pump-only') { reset('electrical-evidence-unqualified'); return null; }
    if (field.timeBasis !== 'source-measured') { reset('electrical-source-clock-unqualified'); return null; }
    if (previous && field.sourceTime <= previous.sourceTime) return null;
    if (lastEnd !== null && field.sourceTime <= lastEnd) return null;
    const prior = previous;
    previous = structuredClone(field);
    if (!prior) { lastIssue = 'awaiting-electrical-interval'; return null; }
    if (prior.bootId !== field.bootId || prior.counterEpoch !== field.counterEpoch) { lastIssue = 'counter-or-adapter-restarted'; return null; }
    if (field.accuracyVerified !== prior.accuracyVerified || field.resolution !== prior.resolution
      || field.updateIntervalMs !== prior.updateIntervalMs) { lastIssue = 'electrical-quality-transition'; return null; }
    const start = prior.sourceTime, end = field.sourceTime, duration = end - start;
    const counter = source === 'native-counter';
    // Unknown counter cadence/quantization cannot be rescued by frequent MQTT
    // packets. Keep the cumulative reading for diagnostics, with no timing claim.
    if (counter && (field.updateIntervalMs === null || field.resolution === null
      || field.updateIntervalMs > MAX_TIMING_INTERVAL_MS)) { lastIssue = 'counter-timing-unqualified'; return null; }
    const maxGap = counter ? Math.min(MAX_TIMING_INTERVAL_MS, Math.max(field.updateIntervalMs * 2, 60_000)) : 120_000;
    if (duration > maxGap) { lastIssue = 'electrical-observation-gap'; return null; }
    if (counter && field.value < prior.value) { lastIssue = 'counter-reset-or-unproven-rollover'; return null; }
    const value = counter ? field.value - prior.value : (field.value + prior.value) / 2 / 1000 * duration / HOUR;
    if (value > 20 * duration / HOUR + (counter ? field.resolution : 0)) { lastIssue = 'implausible-energy-delta'; return null; }
    // A coarse counter can sit unchanged then jump. Wait for a genuine update;
    // do not manufacture a sequence of zero-energy minutes from cached totals.
    if (counter && value === 0) { previous = prior; lastIssue = 'awaiting-counter-update'; return null; }
    const quality = [...(provisional ? ['provisional-contract'] : []), ...(field.accuracyVerified ? [] : ['meter-accuracy-unverified']),
      ...(counter ? ['counter-time-allocation'] : ['integrated-power-estimate'])];
    const observation = { source: 'garage-adapter', device: 'garage-heat-pump', signal: 'garage_energy', value,
      unit: 'kWh', sourceTime: end, receivedAt: field.receivedAt, quality,
      raw: { intervalStart: start, intervalEnd: end, coveredMs: duration, durationMs: duration,
        timingEligible: true, accuracyVerified: field.accuracyVerified, provisional,
        meterScope: 'garage-heat-pump-only', energyBasis: counter ? 'counter-delta' : 'power-trapezoid',
        sourceId: `garage-adapter:${source}`, contractVersion,
        resolutionKwh: counter ? field.resolution : null, counterUpdateIntervalMs: counter ? field.updateIntervalMs : null,
        timeBasis: 'source-measured', usableForControl: false } };
    // Persisting the interval must succeed before advancing the de-duplication
    // watermark, so a failed storage transaction remains retryable.
    try { onEnergy(observation); } catch (error) { previous = prior; throw error; }
    lastEnd = end; lastIssue = null;
    return observation;
  }
  return { receive, reset, snapshot, status: snapshot };
}
