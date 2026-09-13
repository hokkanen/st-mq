import { operationModes } from './history-model.js';
import { MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';

const finite = Number.isFinite;
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const words = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const metricDefinitions = [
  ['profit', 'Assessed space-heating benefit', '€/cycle', 'Estimated mean space-heating benefit against the alternative fixed when planned, including recovery. This completed-cycle subset does not establish total household or hot-water savings. Negative values mean the assessed heating cycles cost more.'],
  ['auxProfit', 'Benefit with auxiliary recovery', '€/cycle', 'The same space-heating estimate, restricted to completed cycles with observed space-heating auxiliary use during recovery. Unknown auxiliary history is excluded; no qualifying cycles means unavailable, not zero.'],
  ['recoveryError', 'Space-heating recovery prediction error', '€/cycle', 'Mean absolute difference between the original space-heating recovery prediction and the completed recovery cost estimate. Lower is better; this checks the prediction, not a measured saving.'],
  ['indoorTemperature', 'Normal indoor temperature', '°C', 'Temperature learned from occupied periods with normal heating. It is held through preheating and recovery so a temporary boost does not raise the comfort reference.'],
];
const coefficientLabels = {
  lossPerHour: 'Heat loss', normalHeatCPerHour: 'Compressor heating response', solarCPerHourPerKwM2: 'Solar response',
  auxiliaryCPerKwh: 'Auxiliary heating response', fireplaceCPerKg: 'Fireplace response', memoryExchangePerHour: 'Building heat exchange', reserveTimeHours: 'Building memory time',
  reducedHeatCPerHour: 'Legacy reduced-mode allowance', preheatCPerHourPerDegree: 'Legacy preheat allowance',
};
const coefficientInfo = {
  ...Object.fromEntries(Object.values(MODEL_COEFFICIENT_INFO).map(info => [info.parameter, info])),
  memoryExchangePerHour: { unit: '1/h', digits: 4, fixed: true, detail: 'Exchange rate between the modeled building heat reserve and indoor air. The slow reserve is unmeasured, so this remains a fixed structural assumption.' },
  reserveTimeHours: { unit: 'h', digits: 1, fixed: true, detail: 'Time scale of the modeled building heat reserve. This is temperature memory, not a measured floor temperature or storage capacity.' },
  reducedHeatCPerHour: { unit: '°C/h', digits: 3, legacy: true, detail: 'Reduced-mode heating allowance carried by a legacy model. The current observed-input model does not fit this coefficient.' },
  preheatCPerHourPerDegree: { unit: '1/h', digits: 4, legacy: true, detail: 'Legacy heating allowance per degree of requested preheat boost. The current model treats boost as control context, without a direct unmeasured heat contribution.' },
};
const inputSources = {
  model_indoor_temperature: 'Upstairs, Downstairs and Bedroom readings contribute according to the configured weights. Every contributing sensor must be available; missing readings leave gaps. The saved average is compared with the predicted temperature after each completed interval. The chart preserves the originally supplied average, including gaps during sensor-change settling; a corrected learner can use preserved readings behind those gaps.',
  model_outdoor_temperature: 'H66 outdoor sensor, then FMI station, then Open-Meteo estimate when the preceding source is unavailable. Source validity is checked at each segment.',
  model_solar_radiation: 'Archived FMI radiation forecast, with Open-Meteo as backup. Radiation is modeled, not measured at the house. It is expressed in W/m²; the model converts it to kW/m².',
  model_compressor_duty: 'Recorded compressor-active and DHW-routing states are intersected in time. Space-heating activity is 1, other known activity is 0; the chart expresses duty as a percentage.',
  model_auxiliary_power: 'Recorded auxiliary output is converted with the saved nominal heater capacity and intersected with space-heating routing. It is an electrical estimate, not measured delivered heat.',
  model_controller_phase: 'The saved controller context supplies normal, preheat, tariff reduction or recovery. It is control context, separate from observed heat delivery.',
  model_room_boost: 'The temporary increase in the native ROOM setting saved in controller context. It describes an action; it is not a fitted direct heat source.',
  model_target_temperature: 'The learned or configured comfort reference saved in controller context. Missing historical context is left unknown.',
  firewood_load: 'The Fireplace control records whole kilograms and the server time for either fireplace or a top-up. Corrections retain the original record internally; this chart shows the effective additions.',
  model_fireplace_release: 'A shared delayed release curve represents both masonry fireplaces. Separate loads overlap and add together. The thermal model learns one effective response per kilogram; earlier periods without logging remain unknown.',
};

export function modelInputDescriptions() {
  return Object.entries(MODEL_INPUT_INFO).map(([key, info]) => ({ key, title: info.label, unit: info.unit,
    detail: info.detail, sources: inputSources[key] }));
}

function retainedValidatedCoefficient(validation, key) {
  const evidence = validation?.parameterEvidence?.[key];
  return validation?.accepted === true && evidence?.status === 'identified' && evidence.fitStatus === 'retained-unchanged';
}

/** Current model cards; chart history is reconstructed separately from the journal. */
export function modelCoefficientDescriptions(learning = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, validation = model.validation;
  const fitted = new Set(validation?.accepted === true ? validation.fittedParameters ?? [] : []);
  return Object.entries(coefficientInfo).filter(([key]) => Object.hasOwn(model.parameters ?? {}, key)).map(([key, info]) => {
    const rawValue = model.parameters[key], available = finite(rawValue);
    const evidence = validation?.parameterEvidence?.[key];
    const learned = available && fitted.has(key) && !info.fixed && !info.legacy;
    const retained = retainedValidatedCoefficient(validation, key);
    return { key, title: coefficientLabels[key], unit: info.unit, available,
      value: available ? `${number(rawValue, info.digits)} ${info.unit}` : 'Unavailable',
      provenance: !available ? 'Unavailable' : info.legacy ? 'Legacy model value' : info.fixed ? 'Fixed building assumption'
        : learned ? 'Fitted in the accepted model' : retained ? 'Retained unchanged / previously validated'
          : validation?.accepted === true ? 'Retained value / awaiting evidence' : 'Initial estimate / awaiting evidence',
      detail: info.detail,
      evidence: evidence ? [words(evidence.status), retained ? words(evidence.fitStatus) : '', words(evidence.reason)].filter(Boolean).join(' · ') : '' };
  });
}

export function learningDisplay(learning = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, health = adaptive.health ?? {};
  const validation = model.validation, p = model.parameters ?? {}, energy = model.energy ?? {};
  const status = health.status ?? learning.status;
  const title = status === 'prior-estimates' ? 'Learning from initial estimates'
    : status === 'retained-previous' ? 'Keeping the previous model'
      : status === 'learning' ? 'Learning from observed temperatures' : words(status || 'Collecting observations');
  const process = 'The house model learns from completed 15-minute intervals of recorded temperatures, solar forecasts, observed space-heating input and the delayed release of logged firewood. Changes within an interval retain their own timing. Later temperature trajectories check proposed updates. A separate equipment-response check asks whether requested actions predict compressor use. Passing the temperature check alone does not validate a savings decision.';
  const evidence = [], coefficientEvidence = [];
  if (finite(health.usableSamples)) evidence.push(`${health.usableSamples} usable temperature observations; ${health.acceptedFits ?? 0} accepted model updates and ${health.rejectedFits ?? 0} attempts without an accepted update.`);
  if (health.phaseSamples) evidence.push(`Observation coverage: ${Object.entries(health.phaseSamples).map(([phase, count]) => `${words(phase)} ${count}`).join(', ')}. Actions with little evidence still rely on initial estimates.`);
  const horizon = finite(validation?.horizonHours) ? `${number(validation.horizonHours, 1)}${finite(validation.maximumHorizonHours) && validation.maximumHorizonHours !== validation.horizonHours ? `–${number(validation.maximumHorizonHours, 1)}` : ''} hours` : 'the saved forecast horizon';
  if (validation?.accepted && finite(validation.maeC)) evidence.push(`Conditional temperature validation: ${number(validation.maeC)} °C mean absolute trajectory error over ${validation.samples ?? 0} later blocks of ${horizon}${finite(validation.maxErrorC) ? `; maximum ${number(validation.maxErrorC)} °C` : ''}${finite(validation.persistenceMaeC) ? `. Holding the initial temperature gives ${number(validation.persistenceMaeC)} °C` : ''}. Observed heat input is supplied during this check; this does not validate full-cycle cost or future compressor duty.`);
  else if (validation?.accepted && finite(validation.maeCPerHour)) evidence.push(`Legacy temperature validation: ${number(validation.maeCPerHour)} °C/h over ${validation.samples ?? 0} saved checks of ${horizon}. This rate-normalized legacy score does not validate full-cycle cost or current action readiness.`);
  if (health.reason) evidence.push(`Latest update: ${words(health.reason)}.`);
  if (finite(p.fireplaceCPerKg)) {
    const fire = validation?.fireplace;
    coefficientEvidence.push(`Fireplace response: ${number(p.fireplaceCPerKg, 3)} °C per logged kg, applied through the delayed masonry release curve. This represents an effective house-temperature contribution, not measured useful kWh or fireplace efficiency.`);
    evidence.push(`Fireplace response: ${learning.readiness?.fireplaceValidated === true ? 'validated on later firing periods' : 'provisional; independent firing evidence is still required'}${fire ? `; ${fire.trainingBurns ?? 0} training firing groups and ${fire.validationBurns ?? 0} later validation groups` : ''}. Nearby additions belong to one overlapping heating episode. Firewood cost estimates remain model comparisons, not metered savings.`);
  }
  if (health.evidence === 'includes-requested-modes') evidence.push('Some heating observations describe requested operation. Device readback is used where available.');
  if (finite(p.lossPerHour)) coefficientEvidence.push(`Current model: with the house 10 °C warmer than outdoors, heat loss contributes about ${number(p.lossPerHour * 10)} °C/h before heating, sunshine and stored heat. This is a model estimate, not a direct cooling measurement.`);
  if (finite(p.normalHeatCPerHour)) coefficientEvidence.push(`Compressor heating response: ${number(p.normalHeatCPerHour)} °C/h at full modeled space-heating duty. Actual compressor duty, heat loss and the building’s stored heat determine the temperature change. Replacing the heat pump requires equipment recalibration.`);
  if (finite(p.reserveTimeHours)) coefficientEvidence.push(`Slow heat reserve adjusts over about ${number(p.reserveTimeHours, 1)} hours. This represents the building’s temperature memory; it is not a measured floor temperature or storage capacity.`);
  if (finite(energy.compressorKw)) coefficientEvidence.push(`Electricity basis: compressor ${number(energy.compressorKw)} kW, auxiliary capacity ${number(energy.auxiliaryKw)} kW; ${words(energy.basis ?? 'estimated')}. Solar input uses FMI radiation forecasts with Open-Meteo as backup. It is modeled radiation.`);
  if (finite(energy.relativeUncertainty)) coefficientEvidence.push(`Electricity uncertainty allowance: ${number(energy.relativeUncertainty * 100, 0)}%. It describes the model's uncertainty budget, not a meter's accuracy or a statistical confidence interval.`);
  const coefficientNames = Object.keys(p).filter(key => coefficientLabels[key]);
  const fitted = new Set(validation?.accepted === true ? validation.fittedParameters ?? [] : []);
  const retained = new Set(coefficientNames.filter(key => !fitted.has(key) && retainedValidatedCoefficient(validation, key)));
  if (coefficientNames.length) coefficientEvidence.push(`Thermal coefficients: ${coefficientNames.filter(key => fitted.has(key)).length} fitted in the accepted update; ${retained.size ? `${retained.size} retained unchanged with validated evidence; ` : ''}${coefficientNames.filter(key => !fitted.has(key) && !retained.has(key)).length} fixed or awaiting evidence. ${coefficientNames.map(key => `${coefficientLabels[key]}: ${fitted.has(key) ? 'fitted' : retained.has(key) ? 'retained unchanged / previously validated' : 'fixed / awaiting evidence'}`).join('; ')}.`);
  for (const [key, info] of Object.entries(validation?.parameterEvidence ?? {})) {
    if (coefficientLabels[key] && info?.reason) coefficientEvidence.push(`${coefficientLabels[key]} evidence: ${words(info.status)} · ${words(info.reason)}.`);
  }
  const actionChecks = model.equipmentResponse?.validation?.phases;
  if (actionChecks) for (const [phase, result] of Object.entries(actionChecks)) {
    evidence.push(`${words(phase)} equipment-response check: ${result.accepted ? 'passed' : 'not established'} over ${result.episodes ?? 0} held-out completed episodes${finite(result.maeDuty) ? `; compressor-duty error ${number(result.maeDuty * 100, 1)} percentage points` : ''}.`);
  }
  const advance = model.forecastValidation;
  if (advance) evidence.push(`Frozen advance forecast: ${advance.accepted ? 'passed' : 'not established'} over ${advance.episodes ?? 0} completed episodes${finite(advance.temperatureMaeC) ? `; temperature error ${number(advance.temperatureMaeC)} °C` : ''}${finite(advance.energyRelativeError) ? `; energy error ${number(advance.energyRelativeError * 100, 1)}%` : ''}${finite(advance.costRelativeError) ? `; space-heating cost error ${number(advance.costRelativeError * 100, 1)}%` : ''}. This compares the forecast saved before an action with its later outcome.`);
  const readiness = learning.readiness;
  if (readiness) {
    evidence.push(`Temperature prediction: ${readiness.thermalValidated ? 'validated on later observations' : 'awaiting validation'}.${typeof readiness.responseValidated === 'boolean' ? ` Equipment response: ${readiness.responseValidated ? 'validated on later episodes' : 'awaiting independent episode evidence'}.` : ''}${typeof readiness.advanceValidated === 'boolean' ? ` Frozen advance forecast: ${readiness.advanceValidated ? 'validated against later outcomes' : 'awaiting independent outcome evidence'}.` : ''} Action prediction: ${readiness.actionValidated ? 'validated on later episodes' : 'awaiting independent episode evidence'}. Learning trial: ${readiness.trialReady ? 'eligible within its configured limits' : 'not ready'}.`);
    if (readiness.reasons?.length) evidence.push(`Readiness: ${readiness.reasons.map(words).join('; ')}.`);
  }
  const outcomes = learning.outcomes;
  if (outcomes) evidence.push(`All attempted cycles: ${outcomes.attempted ?? 0}; completed ${outcomes.completed ?? 0}, incomplete ${outcomes.incomplete ?? 0}${finite(outcomes.aborted) ? `, aborted ${outcomes.aborted}` : ''}, in progress ${outcomes.inProgress ?? 0}. ${outcomes.assessed ?? 0} have a comparable space-heating assessment.${finite(outcomes.observedCostCents) ? ` Recorded cycle electricity cost: €${number(outcomes.observedCostCents / 100)} (${words(outcomes.basis ?? 'estimated')}).` : ''} Completed-subset benefits exclude unfinished attempts; hot-water service changes prevent a whole-cycle savings claim.`);
  const configured = learning.parameters;
  if (finite(learning.controlHold?.until)) evidence.push(`Automatic cycles wait until ${new Date(learning.controlHold.until).toLocaleString('en-GB', { dateStyle:'medium',timeStyle:'short' })} after an incomplete attempt (${words(learning.controlHold.reason)}). Recording and passive learning continue.`);
  if (configured) coefficientEvidence.push(`Configured native-control assumptions: auxiliary integral A2 ${number(configured.auxIntegralA2, 0)} (${configured.a2Basis === 'offset' ? 'relative to A1' : 'absolute'}); auxiliary hysteresis ${number(configured.auxHysteresisC, 0)} °C. Compressor A1 ${finite(configured.compressorIntegralA1) ? number(configured.compressorIntegralA1, 0) : 'unknown'}; compressor hysteresis ${finite(configured.compressorHysteresisC) ? `${number(configured.compressorHysteresisC, 0)} °C` : 'unknown'}. These come from configuration; the current integral reading does not expose those settings.`);
  const metrics = metricDefinitions.map(([key, title, unit, explanation]) => {
    const metric = learning.metrics?.[key] ?? {};
    const value = key === 'indoorTemperature' ? metric.value ?? adaptive.baselineC : metric.value;
    const available = finite(value) && (key === 'indoorTemperature' || metric.count > 0);
    return { key, title, value: available ? `${number(value, key === 'indoorTemperature' ? 1 : 2)} ${unit}` : 'Not available yet',
      detail: explanation, evidence: `${key !== 'indoorTemperature' ? `${metric.count ?? 0} completed cycles. ` : ''}${metric.basis ?? ''}${available && finite(metric.uncertainty) ? ` · Model cost uncertainty allowance about ±${number(metric.uncertainty)} €/cycle; not a statistical confidence interval.` : ''}`.trim() };
  });
  const episode = learning.episode;
  if (episode) evidence.push(`Current cycle: ${words(episode.phase ?? episode.status ?? 'in progress')}. Space-heating benefit is assessed only after recovery is complete; an unfinished cycle does not enter the averages.`);
  return { title, message: learning.message ?? learning.reason ?? (validation?.accepted ? 'The current model has passed later temperature checks. Action prediction and economic readiness are assessed separately.' : 'Initial estimates remain in use while independent evidence is collected.'),
    process, metrics, evidence, inputs: modelInputDescriptions(), coefficients: modelCoefficientDescriptions(learning), coefficientEvidence,
    coefficientHistory: 'These are current values from the latest retained model. Select Model coefficients on the chart to see the five adjustable coefficients reconstructed from the learning journal and applicable firewood and sensor-change history. The chart preserves initial, fitted and retained estimates; today’s values are not applied to earlier intervals. Corrections can change retrospective reconstruction. Fixed building assumptions are shown here only. Reconstruction stays in memory and creates no additional stored history.',
    history: 'The chart stores these values when they are assessed. Earlier history keeps the estimate known at that time; later model updates do not rewrite it.' };
}

/** Static definitions stay mounted during status refreshes, preserving open
 * folds and keyboard focus while measurements and readiness continue updating. */
export function renderModelInputs(root, rows = modelInputDescriptions(), { sensorChanges, outdoorSensorChanges } = {}) {
  if (!root || root.childElementCount) return;
  const intro = document.createElement('p'); intro.className = 'muted';
  intro.textContent = 'These inputs describe how the house model learns: recorded sensor readings, the temperature target, control context and logged firewood. Select Model inputs on the chart to inspect manual additions or calculated interval inputs. Temperature inputs show what was originally supplied to learning, including sensor-change settling gaps. Relearning can use preserved readings behind those gaps; Model coefficients shows the corrected reconstruction. Fireplace release is reconstructed from its corrected history; unknown and rejected intervals remain gaps.';
  root.append(intro);
  for (const row of rows) {
    const fold = document.createElement('details'); fold.dataset.modelInput = row.key;
    const summary = document.createElement('summary'); summary.textContent = `${row.title} · ${row.unit}`;
    const detail = document.createElement('p'); detail.textContent = row.detail;
    const sources = document.createElement('p'); sources.className = 'muted'; sources.textContent = row.sources;
    fold.append(summary, detail, sources);
    const changes = row.key === 'model_indoor_temperature' ? sensorChanges
      : row.key === 'model_outdoor_temperature' ? outdoorSensorChanges : null;
    if (changes) { fold.append(changes); changes.hidden = false; }
    root.append(fold);
  }
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
  '0233': { label: 'Tariff reduction setting', unit: '°C' },
};

/** Compact readbacks must never turn a stale value or sent request into a
 * current device confirmation. The tariff relay has no H66 status register. */
export function h66HomeSummary(status = {}) {
  const h66 = status.h66 ?? {}, readings = h66.readings ?? {};
  const unavailable = reading => h66.connected !== true ? 'Unavailable · H66 disconnected'
    : reading?.stale ? 'Unavailable · stale readback' : 'Unavailable · no current readback';
  const current = register => h66.connected === true && finite(readings[register]?.value)
    && readings[register].available === true && !readings[register].stale && readings[register].usableForControl !== false;
  const readingRow = (key, title, register) => ({ key, title, available: current(register),
    value: current(register) ? h66ReadingValue(register, readings[register]) : unavailable(readings[register]),
    detail: 'Current H66 device readback.' });
  const start = readings['0212'], stop = readings['0208'], rangeAvailable = current('0212') && current('0208');
  const rows = [readingRow('mode', 'Heat pump mode', '2201'), readingRow('room', 'Heat pump ROOM setting', '0203'),
    { key: 'dhw', title: 'DHW target range', available: rangeAvailable,
      value: rangeAvailable ? `${number(start.value, Number.isInteger(start.value) ? 0 : 1)}–${number(stop.value, Number.isInteger(stop.value) ? 0 : 1)} °C`
        : unavailable(start?.stale ? start : stop), detail: 'Current H66 start–stop temperature settings for domestic hot water.' }];
  const actual = status.observations?.actual;
  const knownMode = ['normal', 'reduction'].includes(actual?.mode);
  const confirmed = knownMode && actual.verified === true && actual.stale !== true;
  const requested = knownMode && actual.source === 'mqtt-request' && actual.stale !== true;
  rows.push({ key: 'tariff', title: 'Tariff control', available: confirmed,
    value: confirmed ? `${actual.mode === 'reduction' ? 'Reduction' : 'Normal heating'}${status.input === 'simulated' ? ' · simulated' : ' · confirmed'}`
      : requested ? `${actual.mode === 'reduction' ? 'Reduction' : 'Normal heating'} requested · unverified` : 'Unknown · no device readback',
    detail: 'The tariff relay is separate from H66. A sent request, operating mode or compressor reading does not confirm its state.' });
  rows.push(readingRow('compressor', 'Compressor', '1A01'), readingRow('destination', 'Heating destination', '1A07'),
    readingRow('aux', 'Auxiliary output', '3104'), readingRow('alarm', 'Heat pump alarm', '1A20'));
  if (readings['0233']) rows.push(readingRow('tariffSetting', 'Tariff reduction setting', '0233'));
  return rows;
}

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
