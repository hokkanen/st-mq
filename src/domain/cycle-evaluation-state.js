const number = Number.isFinite;
export const CYCLE_EVALUATION_CONTINUATION_VERSION = 1;
const EVALUATION_TOTALS = ['costCents', 'electricityKwh', 'auxiliaryKwh', 'recoveryCostCents', 'preheatCostCents',
  'absoluteCostCents', 'recoveryEnergyKwh', 'recoveryAuxKwh', 'spaceHeatingCostCents', 'spaceHeatingKwh', 'penalty'];
export function validateCycleEvaluationState(saved, binding = saved?.binding) {
  const fail = () => { throw new TypeError('Invalid, finalized or changed cycle evaluation continuation'); };
  const fields = ['version', 'binding', 'finalized', 'origin', 'previousEnd', 'elapsed', 'state', 'nativeState', 'totals',
    'discomfort', 'severe', 'uncertaintyC', 'recoverySettledHours', 'recoveredAt', 'recoveryFallbackAt', 'indoorTrendCPerHour',
    'lastPrice', 'violations'];
  if (!saved || !/^[a-f0-9]{64}$/.test(saved.binding ?? '') || saved.version !== CYCLE_EVALUATION_CONTINUATION_VERSION || saved.binding !== binding
    || saved.finalized !== false || Object.keys(saved).length !== fields.length
    || Object.keys(saved).some(key => !fields.includes(key))) fail();
  const nullable = value => value === null || number(value);
  const thermal = value => value && Object.keys(value).length === 3 && number(value.indoorC)
    && number(value.reserveC) && nullable(value.slabC);
  if (!thermal(saved.state) || !thermal(saved.nativeState) || !saved.totals
    || Object.keys(saved.totals).length !== EVALUATION_TOTALS.length
    || !EVALUATION_TOTALS.every(key => number(saved.totals[key]))
    || !saved.discomfort || Object.keys(saved.discomfort).length !== 2
    || !['cold', 'hot'].every(key => number(saved.discomfort[key]) && saved.discomfort[key] >= 0)
    || typeof saved.severe !== 'boolean' || !nullable(saved.uncertaintyC)
    || !number(saved.elapsed) || saved.elapsed < 0 || !number(saved.recoverySettledHours) || saved.recoverySettledHours < 0
    || !['origin', 'previousEnd', 'recoveredAt', 'recoveryFallbackAt', 'indoorTrendCPerHour', 'lastPrice'].every(key => nullable(saved[key]))
    || (saved.origin === null) !== (saved.previousEnd === null)
    || (saved.previousEnd === null ? saved.lastPrice !== null : !number(saved.lastPrice))
    || saved.origin === null && saved.elapsed !== 0 || saved.origin !== null && saved.previousEnd < saved.origin
    || !Array.isArray(saved.violations) || saved.violations.length > 24) fail();
  const codes = new Set();
  for (const entry of saved.violations) {
    if (!entry || Object.keys(entry).length !== 6 || typeof entry.code !== 'string' || codes.has(entry.code)
      || !number(entry.at) || !nullable(entry.value) || !nullable(entry.limit) || entry.unit !== '°C'
      || !number(entry.excess) || entry.excess < 0) fail();
    codes.add(entry.code);
  }
}
