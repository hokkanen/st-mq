const POWER_SOURCES = new Set(['measured', 'observed', 'modelled', 'currents', 'recorded', 'unknown', 'simulated']);
const CURRENT_BASIS = 'Three coherent phase currents × nominal 230 V; not an energy meter';

/** Use only evidence saved with this power value. Today's telemetry cannot
 * establish how an older estimate was made. Never expose arbitrary raw fields. */
export function timingPowerEvidence(row) {
  let raw = row.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  let key = 'unknown';
  if (row.source === 'simulation' || row.source === 'controller-estimate' && row.device === 'simulated') key = 'simulated';
  else if (POWER_SOURCES.has(raw.powerBasis)) key = raw.powerBasis;
  else if (raw.basis === 'measured') key = 'measured';
  else if (row.signal === 'charger_power' && raw.basis === CURRENT_BASIS) key = 'currents';
  else if (row.signal === 'heat_pump_power' && raw.basis === 'estimated') {
    if (raw.compressorObserved === true) key = 'observed';
    else if (raw.compressorObserved === false) key = 'modelled';
  }
  const auxiliaryApplies = row.signal === 'heat_pump_power' && !['measured', 'simulated'].includes(key);
  const auxiliaryAssumed = auxiliaryApplies && (typeof raw.auxiliaryAssumed === 'boolean'
    ? raw.auxiliaryAssumed : raw.auxiliaryObserved === false);
  const auxiliaryUnknown = auxiliaryApplies && !auxiliaryAssumed
    && raw.auxiliaryAssumed !== false && raw.auxiliaryObserved !== true;
  return { key, auxiliaryAssumed, auxiliaryUnknown };
}

export function timingEvidenceSource(key) {
  return POWER_SOURCES.has(key) ? key : 'unknown';
}
