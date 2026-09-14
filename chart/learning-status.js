import { operationModes } from './history-model.js';
import { MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { H66_MAX_AGE_MS } from '../src/domain/reading-freshness.js';
import { durationText, qualityReasonText } from './reading-status.js';
import { renderLearningRows } from './learning-rows.js';

const finite = Number.isFinite;
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const words = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const metricDefinitions = [
  ['profit', 'Assessed space-heating benefit', '€/cycle', 'Estimated mean space-heating benefit against the alternative fixed when planned, including recovery. This completed-cycle subset does not establish total household or hot-water savings. Negative values mean the assessed heating cycles cost more.'],
  ['auxProfit', 'Benefit with auxiliary recovery', '€/cycle', 'The same space-heating estimate, restricted to completed cycles with observed space-heating auxiliary use during recovery. Unknown auxiliary history is excluded; no qualifying cycles means unavailable, not zero.'],
  ['recoveryError', 'Space-heating recovery prediction error', '€/cycle', 'Mean absolute difference between the original space-heating recovery prediction and the completed recovery cost estimate. Lower is better; this checks the prediction, not a measured saving.'],
  ['indoorTemperature', 'Normal indoor temperature', '°C', 'The temperature achieved during sustained, stable periods declared occupied with normal heating. Verified heating activity supports the reference; sustained cool weather can establish a provisional reference when equipment observations are missing. Preheating, recovery and logged fireplace heating do not raise it.'],
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
  model_indoor_temperature: 'The configured sensors contribute according to their weights. Their latest genuine readings can be held between reports; freshness and report coverage determine whether the interval is usable. A missing contributing sensor or a gap in required reports excludes the average. The chart preserves the originally supplied average, including sensor-change settling gaps; corrected learning can use preserved readings behind those settling gaps.',
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
  const presentation = {
    model_indoor_temperature: ['Temperatures & weather', 'Recorded average'],
    model_outdoor_temperature: ['Temperatures & weather', 'Recorded or modeled · source varies'],
    model_solar_radiation: ['Temperatures & weather', 'Modeled forecast'],
    model_compressor_duty: ['Observed heating', 'Calculated from recorded states'],
    model_auxiliary_power: ['Observed heating', 'Estimated from recorded output'],
    model_controller_phase: ['Control context', 'Recorded request'],
    model_room_boost: ['Control context', 'Recorded request'],
    model_target_temperature: ['Control context', 'Recorded reference'],
    firewood_load: ['Firewood', 'Manually recorded'],
    model_fireplace_release: ['Firewood', 'Modeled release'],
  };
  return Object.entries(MODEL_INPUT_INFO).map(([key, info]) => ({ key, modelInput: key, title: info.label, unit: info.unit,
    value: info.unit, group: presentation[key][0], provenance: presentation[key][1],
    detail: info.detail, sources: inputSources[key], evidence: inputSources[key] }));
}

function retainedValidatedCoefficient(validation, key) {
  const evidence = validation?.parameterEvidence?.[key];
  return validation?.accepted === true && evidence?.status === 'identified' && evidence.fitStatus === 'retained-unchanged';
}

const evidenceReasons = {
  'fewer-than-three-days-of-observed-heat-input': 'Needs at least three days and 96 usable intervals with observed heating input',
  'fewer-than-three-sunlit-days': 'Needs at least three sunlit days',
  'fewer-than-three-observed-auxiliary-episodes': 'Needs at least three episodes with observed auxiliary heating',
  'fireplace-requires-validated-house-response-and-three-separated-burns': 'Needs a validated house response and three separate firing periods',
  'insensitive-to-available-inputs': 'Available observations show too little effect to estimate this response',
  'confounded-with-other-heat-inputs': 'Available observations cannot separate this response from other heating inputs',
  'unmeasured-slow-state; fixed-structural-prior': 'The slow heat reserve is unmeasured; this is a fixed assumption',
  'insufficient-clean-intervals': 'Too few usable intervals in the current fitting window',
};
const evidenceReason = reason => evidenceReasons[reason] ?? words(reason);

function coefficientState(model, key, info) {
  if (!finite(model.parameters?.[key])) return 'unavailable';
  if (info.legacy) return 'legacy';
  if (info.fixed) return 'fixed';
  if (model.validation?.accepted !== true) return 'initial';
  if (model.validation.fittedParameters?.includes(key)) return 'fitted';
  return retainedValidatedCoefficient(model.validation, key) ? 'retained' : 'unvalidated';
}

const coefficientProvenance = {
  unavailable: 'Unavailable', legacy: 'Legacy model value', fixed: 'Fixed assumption',
  fitted: 'Fitted in current model', retained: 'Retained from an earlier validated fit',
  unvalidated: 'Estimate — not independently identified', initial: 'Initial estimate — not validated',
};

function coefficientEvidenceText(evidence) {
  if (!evidence) return '';
  const parts = [evidence.status === 'identified' ? 'Independent input evidence established'
    : evidence.status === 'fixed' ? 'Not fitted from this window' : words(evidence.status)];
  if (evidence.reason) parts.push(evidenceReason(evidence.reason));
  if (evidence.currentWindowEvidence) parts.push(`Current fitting window: ${evidenceReason(evidence.currentWindowEvidence.reason)
    || words(evidence.currentWindowEvidence.status)}`);
  return parts.filter(Boolean).join(' · ');
}

/** Current model disclosures; chart history is reconstructed separately from the journal. */
export function modelCoefficientDescriptions(learning = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, validation = model.validation;
  return Object.entries(coefficientInfo).filter(([key]) => Object.hasOwn(model.parameters ?? {}, key)).map(([key, info]) => {
    const rawValue = model.parameters[key], available = finite(rawValue);
    const evidence = validation?.parameterEvidence?.[key];
    const state = coefficientState(model, key, info);
    const latest = adaptive.health?.status === 'retained-previous' ? adaptive.health.parameterEvidence?.[key] : null;
    return { key, title: coefficientLabels[key], unit: info.unit, available,
      group: info.fixed ? 'Building assumptions' : info.legacy ? 'Legacy values' : 'Thermal responses',
      value: available ? `${number(rawValue, info.digits)} ${info.unit}` : 'Unavailable',
      provenance: coefficientProvenance[state],
      detail: `${info.detail}${['normalHeatCPerHour', 'auxiliaryCPerKwh'].includes(key)
        ? ' This model places hydronic heat into the estimated slow reserve before it reaches indoor air.' : ''}`,
      evidence: [coefficientEvidenceText(evidence), latest?.reason ? `Latest unaccepted update: ${evidenceReason(latest.reason)}` : ''].filter(Boolean).join(' · ') };
  });
}

export function learningDisplay(learning = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, health = adaptive.health ?? {};
  const validation = model.validation, p = model.parameters ?? {}, energy = model.energy ?? {};
  const status = health.status ?? learning.status;
  const title = status === 'prior-estimates' ? 'Learning from initial estimates'
    : status === 'retained-previous' ? 'Keeping the previous model'
      : status === 'learning' ? 'Learning from observed temperatures' : words(status || 'Collecting observations');
  const process = 'The house model learns from completed 15-minute intervals of recorded temperatures, solar forecasts, observed space-heating input and the delayed release of logged firewood. Changes within an interval retain their own timing. Later temperature trajectories check proposed updates with observed heating input supplied. Separate checks assess compressor response to requested actions and forecasts saved before completed cycles. These checks do not measure savings against an observed alternative.';
  const evidence = [], coefficientEvidence = [], evidenceRows = [], coefficientEvidenceRows = [];
  const record = (title, value, detail) => {
    evidence.push(detail);
    evidenceRows.push({ key: title, title, value, detail });
  };
  const basis = (title, value, detail) => {
    coefficientEvidence.push(detail);
    coefficientEvidenceRows.push({ key: title, title, value, detail });
  };
  if (finite(health.usableSamples)) record('Retained observations', `${health.usableSamples} intervals`, `${health.usableSamples} retained usable temperature intervals; ${health.acceptedFits ?? 0} accepted model updates and ${health.rejectedFits ?? 0} attempts without an accepted update. Interval counts describe the retained learning window, not lifetime sensor reports.`);
  if (health.phaseSamples) record('Control-phase coverage', 'Retained fitting window', `Retained intervals by control phase: ${Object.entries(health.phaseSamples).map(([phase, count]) => `${words(phase)} ${count}`).join(', ')}. These counts do not establish independent completed-cycle evidence.`);
  const horizon = finite(validation?.horizonHours) ? `${number(validation.horizonHours, 1)}${finite(validation.maximumHorizonHours) && validation.maximumHorizonHours !== validation.horizonHours ? `–${number(validation.maximumHorizonHours, 1)}` : ''} hours` : 'the saved forecast horizon';
  if (validation?.accepted && finite(validation.maeC)) record('Temperature prediction', `${number(validation.maeC)} °C mean error`, `Conditional temperature validation: ${number(validation.maeC)} °C mean absolute trajectory error over ${validation.samples ?? 0} later blocks of ${horizon}${finite(validation.maxErrorC) ? `; maximum ${number(validation.maxErrorC)} °C` : ''}${finite(validation.persistenceMaeC) ? `. Holding the initial temperature gives ${number(validation.persistenceMaeC)} °C` : ''}. Errors are weighted by duration. Each trajectory starts once and runs forward with observed heat input supplied; this does not validate full-cycle cost or future compressor duty.`);
  else if (validation?.accepted && finite(validation.maeCPerHour)) record('Legacy temperature check', `${number(validation.maeCPerHour)} °C/h`, `Legacy temperature validation: ${number(validation.maeCPerHour)} °C/h over ${validation.samples ?? 0} saved checks of ${horizon}. This rate-normalized legacy score does not validate full-cycle cost or current action readiness.`);
  if (health.reason) record('Latest model update', words(health.reason), `Latest update: ${words(health.reason)}.`);
  if (finite(p.fireplaceCPerKg)) {
    const fire = validation?.fireplace;
    const fireStatus = learning.reconstruction === 'snapshot'
      ? `${fire?.accepted === true ? 'saved firing-period check passed' : 'saved firing-period validation is not established'}; live readiness is unavailable`
      : learning.readiness?.fireplaceValidated === true ? 'validated on later firing periods' : 'provisional; independent firing evidence is still required';
    record('Fireplace validation', learning.reconstruction === 'snapshot' ? 'Saved check only' : learning.readiness?.fireplaceValidated === true ? 'Validated' : 'Provisional', `Fireplace response: ${fireStatus}${fire ? `; ${fire.trainingBurns ?? 0} training firing groups and ${fire.validationBurns ?? 0} later validation groups` : ''}. Nearby additions belong to one overlapping heating episode. Firewood cost estimates remain model comparisons, not metered savings.`);
  }
  if (health.evidence === 'includes-requested-modes') record('Heating observation basis', 'Includes requested modes', 'Some heating observations describe requested operation. Device readback is used where available.');
  if (finite(p.lossPerHour)) basis('Heat loss in context', `${number(p.lossPerHour * 10)} °C/h at 10 °C difference`, `Current model: with the house 10 °C warmer than outdoors, heat loss contributes about ${number(p.lossPerHour * 10)} °C/h before heating, sunshine and stored heat. This is a model estimate, not a direct cooling measurement.`);
  if (finite(energy.compressorKw)) basis('Electricity assumptions', `${number(energy.compressorKw)} kW compressor`, `Electricity basis: compressor ${number(energy.compressorKw)} kW, auxiliary capacity ${number(energy.auxiliaryKw)} kW; ${words(energy.basis ?? 'estimated')}. Solar input uses FMI radiation forecasts with Open-Meteo as backup. It is modeled radiation.`);
  if (finite(energy.relativeUncertainty)) basis('Electricity uncertainty allowance', `${number(energy.relativeUncertainty * 100, 0)}%`, `Electricity uncertainty allowance: ${number(energy.relativeUncertainty * 100, 0)}%. It describes the model's uncertainty budget, not a meter's accuracy or a statistical confidence interval.`);
  const coefficientStates = Object.entries(coefficientInfo).filter(([key]) => Object.hasOwn(p, key))
    .map(([key, info]) => coefficientState(model, key, info));
  if (coefficientStates.length) {
    const count = (...states) => coefficientStates.filter(state => states.includes(state)).length;
    basis('Coefficient evidence', `${count('fitted')} fitted · ${count('retained')} retained`, `Thermal coefficients: ${count('fitted')} fitted in current model; ${count('retained')} retained from an earlier validated fit; ${count('fixed')} fixed assumptions; ${count('initial', 'unvalidated')} estimates without independent validation${count('legacy') ? `; ${count('legacy')} legacy values` : ''}${count('unavailable') ? `; ${count('unavailable')} unavailable` : ''}. A fitted value alone does not establish overall model readiness.`);
  }
  const actionChecks = model.equipmentResponse?.validation?.phases;
  if (actionChecks) for (const [phase, result] of Object.entries(actionChecks)) {
    record(`${words(phase)} equipment response`, result.accepted ? 'Validated' : 'Awaiting evidence', `${words(phase)} equipment-response check: ${result.accepted ? result.fitStatus === 'retained-unchanged' ? 'retained earlier validation' : 'passed' : 'not established'} over ${result.episodes ?? 0} held-out completed episodes${finite(result.maeDuty) ? `; error in mean episode compressor duty ${number(result.maeDuty * 100, 1)} percentage points` : ''}${result.accepted && finite(result.maxDurationHours) ? `; supported phase duration up to ${number(result.maxDurationHours, 1)} hours` : ''}. This check uses recorded indoor and outdoor temperatures and requested control context; it does not check a forecast made before the cycle.`);
  }
  const advance = model.forecastValidation;
  if (advance) record('Forecast saved before the cycle', advance.accepted ? 'Validated' : 'Awaiting evidence', `Frozen advance forecast: ${advance.accepted ? 'passed' : 'not established'} over ${advance.episodes ?? 0} completed episodes${finite(advance.temperatureMaeC) ? `; temperature error ${number(advance.temperatureMaeC)} °C` : ''}${finite(advance.energyRelativeError) ? `; energy error ${number(advance.energyRelativeError * 100, 1)}%` : ''}${finite(advance.costRelativeError) ? `; space-heating cost error ${number(advance.costRelativeError * 100, 1)}%` : ''}${advance.accepted && finite(advance.maxReductionHours) ? `; supported reduction duration up to ${number(advance.maxReductionHours, 1)} hours` : ''}. This compares the forecast saved before an action with its later outcome. Electricity can still use nominal-power estimates unless the episode was metered; this is not measured savings.`);
  const readiness = learning.readiness;
  if (readiness) {
    record('Action readiness', readiness.actionValidated ? 'Validation requirements met' : 'Awaiting episode evidence', `Temperature prediction: ${readiness.thermalValidated ? 'validated with observed heat input' : 'awaiting validation'}.${typeof readiness.responseValidated === 'boolean' ? ` Equipment response: ${readiness.responseValidated ? 'validated on later episodes' : 'awaiting independent episode evidence'}.` : ''}${typeof readiness.advanceValidated === 'boolean' ? ` Frozen advance forecast: ${readiness.advanceValidated ? 'validated against later outcomes' : 'awaiting independent outcome evidence'}.` : ''} Action prediction: ${readiness.actionValidated ? 'validation requirements met within demonstrated durations' : 'awaiting independent episode evidence'}. Learning trial: ${readiness.trialReady ? 'basic evidence and budget requirements met' : 'not ready'}. Current comfort, authority, price and duration checks still determine whether an action can run.`);
    if (readiness.reasons?.length) record('Readiness conditions', 'Current assessment', `Readiness: ${readiness.reasons.map(words).join('; ')}.`);
  }
  const outcomes = learning.outcomes;
  if (outcomes) record('Attempted cycles', `${outcomes.completed ?? 0} completed / ${outcomes.attempted ?? 0} attempted`, `Recent attempted cycles (latest 100): ${outcomes.attempted ?? 0}; completed ${outcomes.completed ?? 0}, incomplete ${outcomes.incomplete ?? 0}${finite(outcomes.aborted) ? `, aborted ${outcomes.aborted}` : ''}, in progress ${outcomes.inProgress ?? 0}. ${outcomes.assessed ?? 0} have a comparable space-heating assessment.${finite(outcomes.observedCostCents) ? ` Covered cycle electricity cost estimate: €${number(outcomes.observedCostCents / 100)}; nominal power is used unless metered.` : ''}${finite(outcomes.missingHours) && outcomes.missingHours > 0 ? ` ${number(outcomes.missingHours, 1)} hours without cost coverage are excluded.` : ''} Completed-subset benefits exclude unfinished attempts; hot-water service changes prevent a whole-cycle savings claim.`);
  const configured = learning.parameters;
  if (finite(learning.controlHold?.until)) record('Automatic cycle hold', 'Waiting after an incomplete attempt', `Automatic cycles wait until ${new Date(learning.controlHold.until).toLocaleString('en-GB', { dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Helsinki' })} Finnish time after an incomplete attempt (${words(learning.controlHold.reason)}). Recording and passive learning continue.`);
  if (configured) basis('Native-control assumptions', 'From configuration', `Configured native-control assumptions: auxiliary integral A2 ${number(configured.auxIntegralA2, 0)} °min (${configured.a2Basis === 'offset' ? 'relative to A1' : 'absolute'}); auxiliary hysteresis ${number(configured.auxHysteresisC, 0)} °C. Compressor A1 ${finite(configured.compressorIntegralA1) ? `${number(configured.compressorIntegralA1, 0)} °min` : 'unknown'}; compressor hysteresis ${finite(configured.compressorHysteresisC) ? `${number(configured.compressorHysteresisC, 0)} °C` : 'unknown'}. These come from configuration; the current integral reading does not expose those settings.`);
  const metrics = metricDefinitions.map(([key, title, unit, explanation]) => {
    const metric = learning.metrics?.[key] ?? {};
    const value = key === 'indoorTemperature' ? metric.value ?? adaptive.baselineC : metric.value;
    const available = finite(value) && (key === 'indoorTemperature' || metric.count > 0);
    const reference = adaptive.comfortReference;
    const basis = key !== 'indoorTemperature'
      ? learning.reconstruction === 'snapshot' && !learning.metrics
        ? 'Completed-cycle assessments are unavailable in this snapshot.'
        : `${metric.count ?? 0} assessed ${metric.count === 1 ? 'cycle' : 'cycles'} among the latest 30 completed cycles. Space heating only; electricity is estimated unless metered.`
      : !available ? learning.reconstruction === 'snapshot' ? 'No normal-temperature reference is available in this snapshot.'
        : 'Waiting for a sustained occupied normal-temperature plateau.'
        : reference?.confidence === 'provisional-heating-demand-baseline'
          ? 'Provisional reference: supported by sustained cool weather; heating activity was not verified.'
          : reference?.confidence === 'observed-heating-baseline'
            ? 'Reference supported by a stable occupied temperature plateau and verified space-heating activity.'
            : metric.basis || 'Retained reference; its original heating evidence is unavailable here.';
    const provenance = key !== 'indoorTemperature'
      ? finite(metric.count) ? `${metric.count} assessed ${metric.count === 1 ? 'cycle' : 'cycles'} · latest 30 completed` : 'Assessment count unavailable'
      : !available ? 'Awaiting a stable occupied reference'
        : reference?.confidence === 'provisional-heating-demand-baseline' ? 'Provisional · heating activity unverified'
          : reference?.confidence === 'observed-heating-baseline' ? 'Learned · heating activity verified' : 'Retained reference · original evidence unavailable';
    return { key, title, available, provenance, value: available ? `${number(value, key === 'indoorTemperature' ? 1 : 2)} ${unit}` : 'Not available yet',
      detail: explanation, evidence: `${basis}${available && finite(metric.uncertainty) ? ` · Model cost uncertainty allowance about ±${number(metric.uncertainty)} €/cycle; not a statistical confidence interval.` : ''}` };
  });
  const episode = learning.episode;
  if (episode) record('Current cycle', words(episode.phase ?? episode.status ?? 'in progress'), `Current cycle: ${words(episode.phase ?? episode.status ?? 'in progress')}. Space-heating benefit is assessed only after recovery is complete; an unfinished cycle does not enter the averages.`);
  return { title, message: learning.message ?? learning.reason ?? (readiness?.thermalValidated === true
    ? 'Temperature prediction has passed later checks with observed heat input. Action prediction and economic readiness are assessed separately.'
    : validation?.accepted ? 'An accepted parameter update is in use. Identified heat loss and heating response are both required for temperature readiness; action evidence is checked separately.'
      : 'Initial estimates remain in use while independent evidence is collected.'),
    process, metrics, evidence, evidenceRows, coefficientEvidenceRows, inputs: modelInputDescriptions(), coefficients: modelCoefficientDescriptions(learning), coefficientEvidence,
    coefficientHistory: 'These are current values from the latest retained model. Select Model coefficients on the chart to see the five coefficients eligible for fitting, reconstructed from the learning journal and applicable firewood and sensor-change history. The chart preserves initial, fitted and retained estimates; today’s values are not applied to earlier intervals. Corrections can change retrospective reconstruction. Fixed building assumptions are shown here only. Reconstruction stays in memory and creates no additional stored history.',
    history: 'The chart stores these values when they are assessed. Earlier history keeps the estimate known at that time; later model updates do not rewrite it.' };
}

/** Static definitions stay mounted during status refreshes, preserving open
 * folds and keyboard focus while measurements and readiness continue updating. */
export function renderModelInputs(root, rows = modelInputDescriptions(), { sensorChanges, outdoorSensorChanges } = {}) {
  if (!root || root.childElementCount) return;
  renderLearningRows(root, rows, { document });
  for (const row of rows) {
    const changes = row.key === 'model_indoor_temperature' ? sensorChanges
      : row.key === 'model_outdoor_temperature' ? outdoorSensorChanges : null;
    if (changes) {
      root.querySelector(`[data-model-input="${row.key}"] .learning-entry-body`).append(changes);
      changes.hidden = false;
    }
  }
}

export const h66Registers = {
  '0007': { label: 'Outdoor temperature', unit: '°C' }, '0002': { label: 'Supply temperature', unit: '°C' },
  '0001': { label: 'Return temperature', unit: '°C' }, '0009': { label: 'Hot water temperature', unit: '°C' },
  '0107': { label: 'Supply temperature target', unit: '°C' },
  '1A20': { label: 'Pump alarm', unit: '' },
  '8105': { label: 'Heating integral', unit: '°min' }, '0203': { label: 'Room setting', unit: '°C', min: 10, max: 30 },
  '0212': { label: 'DHW start temperature', unit: '°C', min: 30, max: 60 },
  '0208': { label: 'DHW stop temperature', unit: '°C', min: 30, max: 65 },
  '2201': { label: 'Operating mode', unit: '' }, '1A01': { label: 'Compressor', unit: '' },
  '1A07': { label: 'Heating destination', unit: '' }, '3104': { label: 'Auxiliary output', unit: '%' },
  '0233': { label: 'Tariff reduction setting', unit: '°C' },
};

/** Readback validity comes from the controller. Its MQTT connection and the
 * recency of its publications are separate facts, with the same age boundary. */
export function h66ReadingStatus(h66 = {}, reading, { now = Date.now() } = {}) {
  const maxAgeMs = finite(h66.maxAgeMs) && h66.maxAgeMs > 0 ? Math.min(h66.maxAgeMs, H66_MAX_AGE_MS) : H66_MAX_AGE_MS;
  const value = reading?.observedAt ?? reading?.receivedAt ?? reading?.at;
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : null;
  const age = finite(at) && finite(now) ? now - at : null;
  const usable = h66.connected === true && finite(reading?.value) && reading.available === true
    && !reading.stale && reading.usableForControl !== false && (age === null || age >= 0 && age <= maxAgeMs);
  const receiptTime = reading?.timeBasis === 'mqtt-received' || reading?.sourceAt == null && reading?.sensorMeasuredAt == null;
  const timeBasis = receiptTime ? 'Age uses MQTT receipt time; the sensor measurement time is unknown.'
    : 'Age uses the source measurement time.';
  if (usable) return { usable: true, reason: null, detail: `Current H66 device readback.${age === null ? ''
    : ` Age ${durationText(age)}; limit ${durationText(maxAgeMs)}.`} ${timeBasis}` };
  const reasons = [];
  if (h66.enabled === false) reasons.push('H66 is disabled');
  if (h66.brokerConnected === false || h66.brokerConnected == null && h66.connected !== true) reasons.push('H66 disconnected');
  const issues = [...(Array.isArray(reading?.issues) ? reading.issues : []),
    ...(Array.isArray(reading?.unavailableReasons) ? reading.unavailableReasons : [])];
  if (reading?.retained === true && !issues.includes('retained')) issues.push('retained');
  if (reading?.duplicate === true && !issues.includes('duplicate')) issues.push('duplicate');
  for (const issue of issues) {
    const text = issue === 'invalid-value' ? 'the value is outside the accepted register range' : qualityReasonText(issue);
    if (text) reasons.push(text);
  }
  if (!reading) reasons.push('no readback has been received');
  else {
    if (!finite(reading.value) && !issues.some(issue => ['invalid-payload', 'invalid-value'].includes(issue)))
      reasons.push('no valid numeric value was received');
    if (age === null) reasons.push('the readback timestamp is missing or invalid');
    else if (age < 0) reasons.push(`the ${receiptTime ? 'receipt' : 'measurement'} time is ${durationText(-age)} in the future`);
    else if (age > maxAgeMs) reasons.push(`the readback is ${durationText(age)} old; limit ${durationText(maxAgeMs)}`);
  }
  if (!reasons.length && h66.brokerConnected === true && h66.connected !== true) {
    const publicationAge = finite(h66.lastPublicationAt) ? now - h66.lastPublicationAt : null;
    reasons.push(publicationAge !== null && publicationAge > maxAgeMs
      ? `the last live H66 publication is ${durationText(publicationAge)} old; limit ${durationText(maxAgeMs)}`
      : 'waiting for a live H66 publication');
  }
  if (!reasons.length) reasons.push('H66 rejected this readback without reporting a specific reason');
  const reason = [...new Set(reasons)].join('; ');
  return { usable: false, reason, detail: `Unavailable: ${reason}. ${timeBasis}` };
}

/** Compact readbacks must never turn a stale value or sent request into a
 * current device confirmation. The tariff relay has no H66 status register. */
export function h66HomeSummary(status = {}) {
  const h66 = status.h66 ?? {}, readings = h66.readings ?? {};
  const describe = reading => h66ReadingStatus(h66, reading, { now: status.now ?? Date.now() });
  const unavailable = reading => `Unavailable · ${describe(reading).reason}`;
  const current = register => describe(readings[register]).usable;
  const readingRow = (key, title, register) => {
    const display = describe(readings[register]);
    return { key, title, available: display.usable,
      value: display.usable ? h66ReadingValue(register, readings[register]) : unavailable(readings[register]), detail: display.detail };
  };
  const start = readings['0212'], stop = readings['0208'], rangeAvailable = current('0212') && current('0208');
  const rangeReasons = ['0212', '0208'].filter(register => !current(register)).map(register =>
    `${register === '0212' ? 'Start' : 'Stop'} setting: ${describe(readings[register]).reason}`);
  const rows = [readingRow('mode', 'Heat pump mode', '2201'), readingRow('room', 'Heat pump room setting', '0203'),
    { key: 'dhw', title: 'DHW target range', available: rangeAvailable,
      value: rangeAvailable ? `${number(start.value, Number.isInteger(start.value) ? 0 : 1)}–${number(stop.value, Number.isInteger(stop.value) ? 0 : 1)} °C`
        : `Unavailable · ${rangeReasons.join('; ')}`, detail: rangeAvailable
          ? `Current H66 start–stop temperature settings for domestic hot water. ${describe(start).detail} ${describe(stop).detail}`
          : rangeReasons.join('. ') }];
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

/** Equipment overview keeps compressor activity alongside current pump settings.
 * Temperature targets use the same qualified readbacks as the detailed summary. */
export function h66EquipmentSummary(status = {}) {
  const h66 = status.h66 ?? {}, readings = h66.readings ?? {}, now = status.now ?? Date.now();
  const availability = h66ReadingStatus(h66, readings['1A01'], { now });
  const activity = { key: 'state', title: 'Compressor state', available: availability.usable,
    value: availability.usable ? h66ReadingValue('1A01', readings['1A01']) : 'Unavailable', detail: availability.detail };
  const value = readings['1A01']?.value, tracked = h66.compressorState;
  if (activity.available && [0, 1].includes(value)) {
    activity.value = value === 1 ? 'Running' : 'Idle';
    if (tracked?.value === value && finite(tracked.since) && tracked.since <= now) {
      const minutes = Math.floor((now - tracked.since) / 60_000);
      const elapsed = durationText(minutes * 60_000);
      if (minutes > 0) activity.value += ` for ${tracked.transitionObserved ? '' : 'at least '}${elapsed}`;
      else if (tracked.transitionObserved) activity.value += ' for <1 min';
      activity.detail += tracked.transitionObserved
        ? ' Duration starts when H66 reported the change in compressor state.'
        : ' This state was already active when observation began. The duration is the minimum continuously observed time; its actual start is unknown.';
    } else activity.detail += ' The current state is known, but its duration is not yet available.';
    activity.detail += ' Running means the compressor is on; Idle means it is off. Auxiliary heating may operate separately.';
  } else if (activity.available) {
    activity.available = false;
    activity.detail = 'The heat pump has not reported a recognized compressor state.';
  }
  const settings = h66HomeSummary(status);
  return [activity, ...['dhw', 'room'].map(key => ({ ...settings.find(row => row.key === key),
    title: key === 'dhw' ? 'Hot water target' : 'Room setting' }))];
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
