import { instantMs } from './prices.js';

/** Dated manual counters. DHW overlaps compressor operation and is never added as energy. */
export function auxiliaryCounterDelta(before, after, { stagePowersKw = [3, 6],
  provenance = 'Owner-supplied nominal 3 kW and 6 kW counter meanings; verify configured live powers' } = {}) {
  const start = instantMs(before.at), end = instantMs(after.at);
  if (end <= start) throw new RangeError('Counter observation dates must increase');
  if (!Array.isArray(stagePowersKw) || stagePowersKw.length !== 2 || stagePowersKw.some(p => !Number.isFinite(p) || p <= 0)) {
    throw new TypeError('Two positive explicit auxiliary stage powers required');
  }
  const elapsedHours = (end - start) / 3_600_000;
  const issues = [], deltas = {};
  for (const key of ['compressorHours', 'auxiliary3kwHours', 'auxiliary6kwHours', 'dhwHours']) {
    const a = before[key], b = after[key];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
      deltas[key] = null; issues.push(`missing-or-invalid:${key}`); continue;
    }
    const delta = b - a;
    if (delta < 0 || delta > elapsedHours + 1) {
      deltas[key] = null; issues.push(`${delta < 0 ? 'counter-reset' : 'implausible-runtime'}:${key}`); continue;
    }
    deltas[key] = delta;
  }
  const auxiliaryKwh = deltas.auxiliary3kwHours == null || deltas.auxiliary6kwHours == null ? null :
    deltas.auxiliary3kwHours * stagePowersKw[0] + deltas.auxiliary6kwHours * stagePowersKw[1];
  return { start, end, elapsedHours, deltas, auxiliaryKwh, stagePowersKw: [...stagePowersKw],
    quality: auxiliaryKwh == null ? 'invalid' : 'nominal-estimate', provenance, issues,
    compressorKwh: null, dhwKwh: null, cause: 'unknown',
    limitation: 'Runtime-derived nominal auxiliary energy; no timing, power meter or causal attribution. DHW is overlapping runtime.' };
}

/** Snapshot quality only: amperes are neither active energy nor a heat-pump meter. */
export function assessPhaseCurrents(row, { mainFuseAmps = 25, comparisonToleranceAmps = 1 } = {}) {
  if (!Number.isFinite(mainFuseAmps) || mainFuseAmps <= 0 || !Number.isFinite(comparisonToleranceAmps) || comparisonToleranceAmps < 0) {
    throw new TypeError('Invalid fuse limit or comparison tolerance');
  }
  const charging = [row.ch_curr1, row.ch_curr2, row.ch_curr3];
  const property = [row.eq_curr1, row.eq_curr2, row.eq_curr3];
  const issues = [];
  if ([...charging, ...property].some(v => !Number.isFinite(v) || v < 0)) issues.push('missing-or-invalid-current');
  if (property.every(v => v === 0)) issues.push('all-zero-property-snapshot');
  if (charging.some((value, i) => Number.isFinite(value) && Number.isFinite(property[i]) && value > property[i] + comparisonToleranceAmps)) {
    issues.push('ev-exceeds-property-snapshot');
  }
  const phasesAboveFuse = property.flatMap((v, i) => Number.isFinite(v) && v > mainFuseAmps ? [i + 1] : []);
  if (phasesAboveFuse.length) issues.push('phase-above-reported-fuse');
  return { chargingAmps: charging, propertyAmps: property, phasesAboveFuse, mainFuseAmps,
    quality: issues.length ? 'suspect' : 'snapshot-only', issues,
    activePowerKw: null, energyKwh: null, heatPumpPowerKw: null,
    limitation: 'Current snapshots may be asynchronous; voltage, power factor and unmetered EV2 prevent metered-energy or heat-pump attribution.' };
}
