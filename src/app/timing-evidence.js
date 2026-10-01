const POWER_SOURCES = new Set(['measured', 'observed', 'currents', 'retrospective-currents', 'recorded', 'unknown', 'simulated']);

export function timingEvidenceSource(key) {
  return POWER_SOURCES.has(key) ? key : 'unknown';
}
