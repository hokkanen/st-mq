// Fixed meanings: these codes are recorded evidence, never today's configured
// device names. A phase accumulator resets when a contributing device changes.
export const VOLTAGE_INPUT_LABELS = Object.freeze({
  1: 'Charger 1 · OCPP', 2: 'Charger 1 · Easee Cloud',
  4: 'Equalizer · Easee Cloud', 8: 'Simulation',
});
export function validVoltageProvenance(value) {
  return Number.isInteger(value?.input) && Number.isInteger(value?.inputs) && value.inputs > 0 && value.inputs <= 15
    && Object.hasOwn(VOLTAGE_INPUT_LABELS, value?.input) && (value.inputs & value.input) === value.input
    && (!(value.inputs & 8) || value.inputs === 8);
}
export function voltageProvenanceDetails(value) {
  const complete = validVoltageProvenance(value);
  const contributors = complete ? Object.entries(VOLTAGE_INPUT_LABELS)
    .filter(([bit]) => value.inputs & Number(bit)).map(([, label]) => label) : [];
  return { contributors, latest: complete ? VOLTAGE_INPUT_LABELS[value.input] : null,
    complete, mixed: contributors.length > 1 };
}
export function voltageInput(observation, scope) {
  if (!/^(property|ev1)_voltage_l[123]$/.test(observation.signal)) return null;
  if (scope === 'simulated') return observation.source === 'simulation' ? 8 : null;
  if (observation.source !== 'easee') return null;
  if (/^property_voltage_l[123]$/.test(observation.signal)
    && [undefined, 'cloud'].includes(observation.raw?.transport)) return 4;
  if (!/^ev1_voltage_l[123]$/.test(observation.signal)) return null;
  return observation.raw?.transport === 'ocpp' ? 1 : observation.raw?.transport === 'cloud' ? 2 : null;
}
