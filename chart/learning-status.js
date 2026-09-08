import { operationModes } from './history-model.js';

const finite = Number.isFinite;
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const words = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const metricDefinitions = [
  ['profit', 'Profit after recovery', '€/cycle', 'Estimated mean benefit against each cycle’s best feasible shorter-reduction alternative, including normal heating, fixed when planned. Includes preheating, reduction and full recovery. Negative values mean the completed cycles cost more.'],
  ['auxProfit', 'Profit with auxiliary recovery', '€/cycle', 'The same estimate, restricted to completed cycles with observed space-heating auxiliary use during recovery. Unknown auxiliary history is excluded; no qualifying cycles means unavailable, not zero.'],
  ['recoveryError', 'Recovery cost prediction error', '€/cycle', 'Mean absolute difference between the original recovery cost prediction and the completed recovery cost estimate. Lower is better; this checks the prediction, not a measured saving.'],
  ['indoorTemperature', 'Normal indoor temperature', '°C', 'Temperature learned from occupied periods with normal heating. It is held through preheating and recovery so a temporary boost does not raise the comfort reference.'],
];

export function learningDisplay(learning = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, health = adaptive.health ?? {};
  const validation = model.validation, p = model.parameters ?? {}, energy = model.energy ?? {};
  const status = health.status ?? learning.status;
  const title = status === 'prior-estimates' ? 'Learning from initial estimates'
    : status === 'retained-previous' ? 'Keeping the previous model'
      : status === 'learning' ? 'Learning from observed temperatures' : words(status || 'Collecting observations');
  const process = 'The controller compares changes in indoor temperature with outdoor temperature, the solar forecast and heating operation. It adjusts a model of heat loss, heating response and the house’s slow heat reserve. Later observations check each proposed update; a worse fit is rejected. Completed heating cycles then update recovery electricity estimates. Missing data and incomplete cycles do not count as successful learning.';
  const evidence = [];
  if (finite(health.usableSamples)) evidence.push(`${health.usableSamples} usable temperature observations; ${health.acceptedFits ?? 0} accepted model updates and ${health.rejectedFits ?? 0} attempts without an accepted update.`);
  if (health.phaseSamples) evidence.push(`Observation coverage: ${Object.entries(health.phaseSamples).map(([phase, count]) => `${words(phase)} ${count}`).join(', ')}. Actions with little evidence still rely on initial estimates.`);
  if (validation?.accepted && finite(validation.maeCPerHour)) evidence.push(`Later one-hour temperature checks: ${number(validation.maeCPerHour)} °C/h mean absolute error over ${validation.samples} checks${finite(validation.persistenceMaeCPerHour) ? `; holding the last temperature gives ${number(validation.persistenceMaeCPerHour)} °C/h` : ''}. This does not validate full-cycle cost.`);
  if (health.reason) evidence.push(`Latest update: ${words(health.reason)}.`);
  if (health.evidence === 'includes-requested-modes') evidence.push('Some heating observations describe requested operation. Device readback is used where available.');
  if (finite(p.lossPerHour)) evidence.push(`Current model: with the house 10 °C warmer than outdoors, heat loss contributes about ${number(p.lossPerHour * 10)} °C/h before heating, sunshine and stored heat. This is a model estimate, not a direct cooling measurement.`);
  if (finite(p.normalHeatCPerHour) && finite(p.reducedHeatCPerHour)) evidence.push(`Estimated normal heating contribution at full modeled duty: ${number(p.normalHeatCPerHour)} °C/h. The reduced-mode heating allowance is ${number(p.reducedHeatCPerHour)} °C/h. Actual duty and heat loss determine the net temperature change.`);
  if (finite(p.reserveTimeHours)) evidence.push(`Slow heat reserve adjusts over about ${number(p.reserveTimeHours, 1)} hours. This represents the building’s temperature memory; it is not a measured floor temperature or storage capacity.`);
  if (finite(energy.compressorKw)) evidence.push(`Electricity basis: compressor ${number(energy.compressorKw)} kW, auxiliary capacity ${number(energy.auxiliaryKw)} kW; ${words(energy.basis ?? 'estimated')}. Solar input uses FMI radiation forecasts with Open-Meteo as backup. It is modeled radiation.`);
  if (finite(energy.relativeUncertainty)) evidence.push(`Electricity uncertainty allowance: ${number(energy.relativeUncertainty * 100, 0)}%. It describes the model's uncertainty budget, not a meter's accuracy or a statistical confidence interval.`);
  const configured = learning.parameters;
  if (configured) evidence.push(`Configured native-control assumptions: auxiliary integral A2 ${number(configured.auxIntegralA2, 0)} (${configured.a2Basis === 'offset' ? 'relative to A1' : 'absolute'}); auxiliary hysteresis ${number(configured.auxHysteresisC, 0)} °C. Compressor A1 ${finite(configured.compressorIntegralA1) ? number(configured.compressorIntegralA1, 0) : 'unknown'}; compressor hysteresis ${finite(configured.compressorHysteresisC) ? `${number(configured.compressorHysteresisC, 0)} °C` : 'unknown'}. These come from configuration; the current integral reading does not expose those settings.`);
  const metrics = metricDefinitions.map(([key, title, unit, explanation]) => {
    const metric = learning.metrics?.[key] ?? {};
    const value = key === 'indoorTemperature' ? metric.value ?? adaptive.baselineC : metric.value;
    const available = finite(value) && (key === 'indoorTemperature' || metric.count > 0);
    return { key, title, value: available ? `${number(value, key === 'indoorTemperature' ? 1 : 2)} ${unit}` : 'Not available yet',
      detail: explanation, evidence: `${key !== 'indoorTemperature' ? `${metric.count ?? 0} completed cycles. ` : ''}${metric.basis ?? ''}${available && finite(metric.uncertainty) ? ` · Model cost uncertainty allowance about ±${number(metric.uncertainty)} €/cycle; not a statistical confidence interval.` : ''}`.trim() };
  });
  const episode = learning.episode;
  if (episode) evidence.push(`Current cycle: ${words(episode.phase ?? episode.status ?? 'in progress')}. Profit is assessed only after recovery is complete; an unfinished cycle does not enter the averages.`);
  return { title, message: learning.message ?? learning.reason ?? (model.trainedAt ? 'The current model has passed later temperature checks. Cost and unfamiliar actions retain their own uncertainty.' : 'Initial estimates support bounded decisions while evidence is collected.'),
    process, metrics, evidence, history: 'The chart stores these values when they are assessed. Earlier history keeps the estimate known at that time; later model updates do not rewrite it.' };
}

export const h66Registers = {
  '0007': { label: 'Outdoor temperature', unit: '°C' }, '0002': { label: 'Supply temperature', unit: '°C' },
  '0001': { label: 'Return temperature', unit: '°C' }, '0009': { label: 'Hot water temperature', unit: '°C' },
  '0008': { label: 'Pump indoor temperature', unit: '°C' }, '0107': { label: 'Supply temperature target', unit: '°C' },
  '1A20': { label: 'Pump alarm', unit: '' },
  '8105': { label: 'Heating integral', unit: '°min' }, '0203': { label: 'ROOM setting', unit: '°C', min: 10, max: 30 },
  '0212': { label: 'DHW start temperature', unit: '°C', min: 30, max: 60 },
  '0208': { label: 'DHW stop temperature', unit: '°C', min: 30, max: 65 },
  '2201': { label: 'Operating mode', unit: '' }, '1A01': { label: 'Compressor', unit: '' },
  '1A07': { label: 'Heating destination', unit: '' }, '3104': { label: 'Auxiliary output', unit: '%' },
};

export function h66ReadingValue(register, reading) {
  if (!finite(reading?.value)) return 'Unavailable';
  if (register === '2201') return operationModes[reading.value] ?? `Unknown mode (${reading.value})`;
  if (register === '1A01') return reading.value === 1 ? 'On' : reading.value === 0 ? 'Off' : 'Unknown';
  if (register === '1A20') return reading.value === 1 ? 'Alarm active' : reading.value === 0 ? 'No active alarm' : 'Unknown';
  if (register === '1A07') return reading.value === 1 ? 'Domestic hot water' : reading.value === 0 ? 'Space heating' : 'Unknown';
  const unit = reading.unit === 'degC' ? '°C' : reading.unit ?? h66Registers[register]?.unit ?? '';
  return `${number(reading.value, Number.isInteger(reading.value) ? 0 : 1)} ${unit}`.trim();
}

export function h66Control(h66, register) {
  const control = h66?.controls?.[register];
  const available = h66?.connected === true && (control === true || control?.available === true);
  return { ...h66Registers[register], ...(typeof control === 'object' ? control : {}), available,
    reason: control?.reason ?? h66?.reason ?? (available ? '' : 'Waiting for a fresh, writable H66 control.') };
}
