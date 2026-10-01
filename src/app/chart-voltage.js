/** Historical conversions retain their voltage basis without changing the
 * original current observations or measured energy. Power factor is unknown. */
export function currentPowerKw(currents, estimate) {
  return currents?.length === 3 && currents.every(Number.isFinite)
    && estimate?.voltageV?.length === 3 && estimate.voltageV.every(value => Number.isFinite(value) && value > 0)
    ? currents.reduce((sum, current, phase) => sum + current * estimate.voltageV[phase], 0) / 1000 : null;
}

export function voltageMetadata(estimate, phase) {
  return { voltageBasis: estimate.basis, voltageV: phase === undefined ? estimate.voltageV : estimate.voltageV[phase],
    powerFactorAssumption: 1, ...(estimate.basis === 'retrospective-voltage-estimate' ? { retrospectiveVoltage: true } : {}) };
}

export function* voltageSegments(reader, start, end, options) {
  if (end <= start) return;
  let at = start, estimate = reader(at, options);
  for (const next of reader.boundaries(start, end)) {
    if (next <= at || next >= end) continue;
    yield { start: at, end: next, estimate };
    at = next; estimate = reader(at, options);
  }
  yield { start: at, end, estimate };
}
