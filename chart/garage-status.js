import { isReadOnlyReplica } from './replica-status.js';
import { outdoorSourceLabel } from './provider-status.js';
import { equipmentReadingRows } from './equipment.js';
import { setStatusDetail } from './status-details.js';
import { renderCurrentPrice } from './current-price.js';
import { garageHeatingConfirmation, garageNativeReadingFresh, setHeatingStatusDetail } from './heating-status.js';
import { finnishDateTime } from './home-controls.js';
import { confirmPausedHeating, garageHeatingWarning } from './heating-warning.js';
import { GARAGE_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { GARAGE_HEAT_TRANSFER_SAFETY_FACTOR } from '../src/garage/settings.js';
import { renderLearningRows } from './learning-rows.js';
const finite = Number.isFinite;
const text = value => typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ') : 'Unknown';
const number = (value, unit = '') => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
const native = value => value && typeof value === 'object' ? value.value : value;
const temperature = reading => finite(reading?.value) ? `${number(reading.value, '°C')}${reading.stale ? ' · stale' : ''}` : 'Unavailable';
const state = value => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
const clock = value => finite(value) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) : 'Unknown';
const sentences = values => values.map(value => text(value).trim().replace(/[.\s]+$/, '')).filter(Boolean).map(value => `${value}.`).join(' ');
const opportunity = reason => ({
  'automatic-control-disabled': 'Automatic control is disabled',
  'normal-heating-preference': 'Normal heating selected',
  'insufficient-validated-thermal-evidence': 'Waiting for validated temperature evidence',
  'learning-episode-recovering': 'Waiting for the current learning episode to recover',
  'learning-trial-recovery-interval': 'Waiting between learning trials',
  'benefit-below-warmth-or-prediction-resolution': 'Expected timing benefit does not cover warmth and prediction uncertainty',
  'credible-price-timing-opportunity': 'Price timing supports a pause within validated limits',
  'prepare-for-later-price-opportunity': 'Heating remains available before a later price opportunity',
})[reason] ?? text(reason ?? 'Normal heating').replace(/^./, value => value.toUpperCase());
const opportunitySummary = reason => ({
  'automatic-control-disabled': 'Automatic control disabled',
  'normal-heating-preference': 'Normal heating selected',
  'insufficient-validated-thermal-evidence': 'Awaiting temperature evidence',
  'learning-episode-recovering': 'Awaiting recovery',
  'learning-trial-recovery-interval': 'Between learning trials',
  'benefit-below-warmth-or-prediction-resolution': 'Insufficient timing benefit',
  'credible-price-timing-opportunity': 'Price-supported pause',
  'prepare-for-later-price-opportunity': 'Preparing for a later opportunity',
})[reason] ?? opportunity(reason);
const coefficientNumber = (value, unit) => finite(value)
  ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(value)} ${unit}` : 'Unavailable';
const coefficientInfo = Object.fromEntries(Object.values(GARAGE_COEFFICIENT_INFO).map(info => [`${info.location}.${info.parameter}`, info]));
const coefficientDetails = {
  'rear.lossPerHour': 'Cooling per degree of rear-to-outdoor temperature difference.',
  'rear.memoryExchangePerHour': 'Exchange between rear air and estimated building warmth.',
  'rear.powerHeatCPerKwh': 'Rear temperature response per kWh of pump electricity; not measured heat output or COP.',
  'rear.activityHeatCPerHour': 'Rear heating contribution at full compressor activity; alternative to the electrical input.',
  'front.differenceRelaxationPerHour': 'Rate at which the front–rear temperature difference relaxes.',
  'front.localLossPerHour': 'Additional front cooling per degree of rear-to-outdoor temperature difference.',
  'front.powerDistributionCPerKwh': 'Change in the front–rear difference per kWh of pump electricity.',
  'front.activityDistributionCPerHour': 'Change in the front–rear difference at full compressor activity.',
  'native.idleAndMaintenanceKw': 'Normal-heating electrical level before temperature demand adjusts the prediction; not a standby measurement.',
  'native.coldWeatherKwPerC': 'Additional electrical demand per degree outdoors below 0°C.',
  'native.demandKwPerC': 'Additional electrical demand per degree below normal rear warmth; requires recovery evidence.',
  'native.restartKw': 'Extra electrical demand during modeled restart; retained as an assumption.',
};

function garageCoefficientRows(learning) {
  const details = [];
  const rows = Object.entries(learning.coefficients ?? {}).flatMap(([group, values]) => Array.isArray(values) ? values.map(value => {
    const key = `${group}.${value.name}`, info = coefficientInfo[key];
    if (!info) return null;
    const scope = { rear: 'Rear air', front: 'Front–rear difference', native: 'Pump electricity' }[group];
    const label = info.label.replace(/^Garage (rear|front|native) · /, '');
    const provenance = !finite(value.value) ? 'Value unavailable' : value.basis === 'fitted-effective-response' ? 'Fitted in current model'
      : value.basis === 'retained-effective-response' ? 'Retained from an earlier fit'
        : info.fixed ? 'Fixed assumption' : 'Initial estimate — not validated';
    const evidence = finite(value.evidence) ? `${number(value.evidence)} ${value.evidenceUnit === 'hours' ? 'h with input present' : 'intervals with input present'}` : 'Input coverage unavailable';
    const ev = /^ev[12]/.test(value.name), activity = /Active/.test(value.name);
    const detail = coefficientDetails[key] ?? (ev
      ? `${group === 'front' ? 'Front–rear difference' : 'Rear temperature'} contribution ${activity ? 'at full charging activity' : 'per kWh of charging electricity'}; fixed charger assumption.` : '');
    details.push({ key: `${group}-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
      group: scope, title: label, value: coefficientNumber(value.value, info.unit), available: finite(value.value),
      provenance: !finite(value.value) ? 'Unavailable' : value.basis === 'fitted-effective-response' ? 'Fitted'
        : value.basis === 'retained-effective-response' ? 'Retained fit' : info.fixed ? 'Fixed assumption' : 'Initial estimate',
      detail, evidence: `${provenance}. ${evidence}. Input coverage describes exposure to this input; it does not establish that the coefficient was identified or validated.` });
    return [`${scope} · ${label}`, `${coefficientNumber(value.value, info.unit)} · ${provenance}. ${detail} ${evidence}.`];
  }).filter(Boolean) : []);
  if (finite(learning.structure?.memoryTimeHours)) {
    const value = coefficientNumber(learning.structure.memoryTimeHours, 'h');
    const detail = 'Time scale for modeled building warmth to follow rear air temperature.';
    rows.push(['Building warmth · Memory time', `${value} · Fixed assumption. ${detail}`]);
    details.push({ key: 'building-memory-time', group: 'Building assumptions', title: 'Building warmth memory',
      value, provenance: 'Fixed assumption', detail });
  }
  if (finite(learning.normalReference?.outdoorSlope)) {
    const value = coefficientNumber(learning.normalReference.outdoorSlope, '°C/°C');
    const detail = 'Change in the normal rear-temperature reference per degree outdoors; the reference level is estimated separately.';
    rows.push(['Normal rear warmth · Weather response', `${value} · Fixed assumption. ${detail}`]);
    details.push({ key: 'normal-warmth-weather-response', group: 'Building assumptions', title: 'Normal warmth weather response',
      value, provenance: 'Fixed assumption', detail });
  }
  if (!details.length) details.push({ key: 'coefficients-unavailable', title: 'Model coefficients',
    value: 'Unavailable', provenance: 'Unavailable', available: false, detail: 'Initial estimates and fitted coefficients are not available yet.' });
  details.push({ key: 'coefficient-fitting-method', group: 'Learning method', title: 'How coefficients are learned',
    value: '5 responses + recovery', provenance: 'Method',
    detail: 'The sparse model can fit five responses, plus a sixth recovery-demand response when supported. Pump electricity and compressor activity are alternative heating paths. Normal rear warmth and the activity baseline are estimated separately. The other coefficients stay fixed.',
    evidence: 'Hours with an input present describe exposure to that input, not proof that its coefficient was identified or validated. Current values do not replace older chart history.' });
  return { rows, details };
}

function garageLearningRows(garage, policy) {
  const learning = garage.learning ?? {}, validation = learning.validation, plan = garage.plan ?? {};
  const evidence = plan.evidence, reference = learning.normalReference;
  const thermal = learning.thermalReady, electrical = learning.electricalReady;
  const duration = learning.maxPauseHours;
  const coefficients = Object.values(learning.coefficients ?? {}).flatMap(rows => Array.isArray(rows) ? rows : []);
  const fittedCount = coefficients.filter(row => row.basis === 'fitted-effective-response').length;
  const retainedCount = coefficients.filter(row => row.basis === 'retained-effective-response').length;
  const supportedDuration = finite(duration) && duration > 0 ? number(duration, 'h') : finite(duration) ? 'Not yet established' : 'Unavailable';
  const outcomeRows = [
    ['Temperature prediction', thermal === true ? 'Validated on complete cooling and recovery episodes'
      : thermal === false ? 'Awaiting complete episode validation' : 'Unavailable'],
    ['Electricity prediction', electrical === true ? 'Qualified on recorded cooling and recovery episodes'
      : electrical === false ? 'Awaiting electrical and recovery evidence' : 'Unavailable'],
    ['Validated thermal pause duration', supportedDuration],
    ['Economic pause support', thermal === true && electrical === true ? supportedDuration
      : thermal === false || electrical === false ? 'Not yet qualified; temperature and electricity checks must both pass' : 'Unavailable'],
    ['Learning trial support', evidence ? evidence.trialEligible === true
      ? `${number(evidence.trialHours, 'h')} maximum in the current plan assessment; protection and recovery still apply`
      : 'Not eligible in the current plan assessment' : 'Not assessed in the current plan'],
    ['Current opportunity', plan.learningTrial === true ? 'Bounded learning trial; duration beyond economic evidence'
      : opportunity(plan.reason)],
  ];
  if (validation) {
    outcomeRows.push(['Complete clean episodes', `${number(validation.completedEpisodes)} in retained history · ${number(validation.trainingEpisodes)} training · ${number(validation.validationEpisodes)} later episodes supporting the current model; the latest 24 ended episodes are retained`],
      ['Electrical recovery checks', `${number(validation.recoveryEpisodes)} later episodes passed`]);
    outcomeRows.push(['Episode error coverage', `${number(validation.horizonHours, 'h')} longest checked cooling and recovery period. Errors cover clean ended validation episodes, including failed recovery; duration support requires complete passing episodes.`]);
    for (const location of ['rear', 'front']) {
      const label = location === 'rear' ? 'Rear' : 'Front';
      outcomeRows.push([`${label} whole-episode error`, finite(validation[`${location}Rmse`])
        ? `RMSE ${number(validation[`${location}Rmse`], '°C')} · bias ${number(validation[`${location}Bias`], '°C')}` : 'Not available yet'],
        [`${label} cooling-only episode error`, finite(validation[`off${label}Rmse`])
          ? `RMSE ${number(validation[`off${label}Rmse`], '°C')}` : 'Not available yet']);
    }
    if (validation.active) outcomeRows.push(['Episode being assessed', `${validation.active.phase === 'off' ? 'Cooling' : 'Recovery'} · ${number(validation.active.offHours, 'h')} heating off · ${number(validation.active.recoveryHours, 'h')} recovery so far`]);
  }
  if (reference) outcomeRows.push(['Normal rear warmth', `${number(reference.rearC, '°C')} · ${reference.initialized === true
    ? 'Learned during continuous normal heating' : reference.initialized === false ? 'Initial estimate — not validated' : 'Unknown reference provenance'} · ${number(reference.qualifiedHours, 'h')} qualified reference observations`]);
  if (learning.nativeActivity) outcomeRows.push(['Normal activity baseline', `${number(learning.nativeActivity.mean)} on a 0–1 scale · ${learning.nativeActivity.basis === 'learned-dimensionless-activity'
    ? 'Learned activity baseline' : learning.nativeActivity.basis === 'prior-activity-response' ? 'Initial activity estimate' : 'Unknown activity provenance'} · ${number(learning.nativeActivity.hours, 'h')} observed activity. The prediction adjusts this baseline for outdoor cold and missing rear warmth; it is not measured kW.`]);
  if (coefficients.length) outcomeRows.push(['Fitted responses', `${fittedCount} fitted in current model · ${retainedCount} retained from an earlier fit; coefficient fitting and episode validation are separate checks`]);
  const electricalError = learning.heldOut?.native;
  if (electricalError) outcomeRows.push(['Electrical short-step error', `${number(electricalError.hours, 'h')} checked · ${number(electricalError.n)} predictions · MAE ${number(electricalError.mae, 'kW')} · bias ${number(electricalError.bias, 'kW')}`]);
  outcomeRows.push(['Recorded history reconstruction', ({ current: 'Up to date', snapshot: 'Recorded primary snapshot', rebuilding: 'Rebuilding from recorded history', failed: 'Reconstruction unavailable' })[learning.reconstruction] ?? 'Unavailable']);
  const modelVersion = learning.algorithm?.match(/^committed-garage-v(\d+)-/);
  if (modelVersion) outcomeRows.push(['Model version', `Garage ${modelVersion[1]}`]);
  const inputRows = [
    ['Rear air temperature · °C', 'Air beside the rear pipe, recorded separately. Earlier rear-only history keeps the same meaning.'],
    ['Front air temperature · °C', `${garage.settings?.frontRequired ? 'Marked required for front monitoring. ' : ''}Air beside the front pipe. Both locations need fresh readings for every automatic pause.`],
    ['Outdoor temperature · °C', `${outdoorSourceLabel(garage.observations?.outdoor?.source) ?? 'Unknown source'}. Recorded weather supports learning; planning uses forecasts available at the decision time.`],
    ['Heat-pump input · kW or activity', 'Qualified electrical power or observed compressor activity on a 0–1 scale. These are alternative thermal inputs; activity is not measured electricity.'],
    ['Heating availability', 'The built-in controller may run or idle while heating is available. An OFF request is distinct from confirmed native OFF.'],
    ['Charger 1 and charger 2 · kW or activity', 'Charging is recorded separately for each vehicle. Its thermal effects remain fixed assumptions; protection excludes anticipated charging warmth.'],
    ['Doors and local cooling', 'Known disturbances exclude affected episodes from validation. A cold plunge still contributes fully to local protection exposure.'],
    ['Estimated building warmth · °C', `${number(learning.state?.coreC, '°C')}. Slow temperature memory from rear observations; not measured pipe temperature or stored kWh.`],
    ['Pump temperature and energy reports', 'Separate equipment readings. Unsupported telemetry remains unknown; compressor frequency is not converted into measured watts.'],
    ['Local allowance recovery', 'Allowance recovers continuously as the local reference warms. Its temperature and the surrounding air determine the rate; rear and front recover independently.'],
  ];
  const outcomeDescriptions = Object.fromEntries(outcomeRows), inputDescriptions = Object.fromEntries(inputRows);
  const outcome = (key, title, value, group, provenance = 'Calculated', detail = outcomeDescriptions[title]) =>
    ({ key, title, value, group, provenance, detail, available: value !== 'Unavailable' });
  const outcomeDetails = [
    outcome('temperature-prediction', 'Temperature prediction', thermal === true ? 'Validated' : thermal === false ? 'Awaiting validation' : 'Unavailable', 'Pause readiness'),
    outcome('electricity-prediction', 'Electricity prediction', electrical === true ? 'Qualified' : electrical === false ? 'Awaiting evidence' : 'Unavailable', 'Pause readiness'),
    outcome('thermal-pause-duration', 'Validated thermal pause duration', supportedDuration, 'Pause readiness', 'Complete episode checks',
      'Longest pause duration supported by complete passing cooling and recovery episodes. Temperature readiness also requires a learned normal-warmth reference and fitted rear and front cooling responses.'),
    outcome('economic-pause-support', 'Economic pause support', thermal === true && electrical === true ? supportedDuration
      : thermal === false || electrical === false ? 'Not yet qualified' : 'Unavailable', 'Pause readiness', 'Calculated',
      'Temperature and electricity checks must both pass before a pause has economic support. The current plan also checks protection, recovery and price timing.'),
    outcome('learning-trial-support', 'Learning trial support', evidence ? evidence.trialEligible === true
      ? `${number(evidence.trialHours, 'h')} maximum` : 'Not eligible' : 'Not assessed', 'Pause readiness', 'Current plan'),
    outcome('current-opportunity', 'Current opportunity', plan.learningTrial === true ? 'Bounded learning trial' : opportunitySummary(plan.reason), 'Pause readiness', 'Current plan'),
  ];
  if (reference) outcomeDetails.push(outcome('normal-rear-warmth', 'Normal rear warmth', number(reference.rearC, '°C'), 'Learned references',
    reference.initialized === true ? 'Learned' : reference.initialized === false ? 'Initial estimate' : 'Unknown basis',
    'Rear air temperature achieved during qualified continuous normal heating, adjusted for outdoor temperature. It is distinct from the configured pump setting.'));
  if (reference) outcomeDetails.at(-1).evidence = `${reference.initialized === true ? 'Learned during continuous normal heating.'
    : reference.initialized === false ? 'Initial estimate — not validated.' : 'Unknown reference provenance.'} ${number(reference.qualifiedHours, 'h')} qualified reference observations.`;
  if (learning.nativeActivity) outcomeDetails.push({ ...outcome('normal-activity-baseline', 'Normal activity baseline',
    finite(learning.nativeActivity.mean) ? `${number(learning.nativeActivity.mean)} / 1` : 'Unavailable', 'Learned references',
    learning.nativeActivity.basis === 'learned-dimensionless-activity' ? 'Learned'
      : learning.nativeActivity.basis === 'prior-activity-response' ? 'Initial estimate' : 'Unknown basis',
    'Compressor activity on a 0–1 scale. The prediction adjusts the learned baseline for outdoor cold and missing rear warmth; it is not measured kW. Before enough activity is observed, activity prediction uses an initial electrical-response assumption.'),
    evidence: `${number(learning.nativeActivity.hours, 'h')} observed activity.` });
  if (coefficients.length) outcomeDetails.push(outcome('fitted-responses', 'Fitted responses', `${fittedCount} fitted · ${retainedCount} retained`, 'Model record', 'Current model'));
  outcomeDetails.push(outcome('recorded-history-reconstruction', 'Recorded history reconstruction', outcomeDescriptions['Recorded history reconstruction'], 'Model record', 'Recorded history',
    'Reconstruction status of the model built from recorded history. A recorded primary snapshot is supplied by the primary installation.'));
  if (modelVersion) outcomeDetails.push(outcome('model-version', 'Model version', `Garage ${modelVersion[1]}`, 'Model record', 'Algorithm',
    'Version of the Garage learning algorithm used for the current model and its recorded reconstruction.'));
  const evidenceDetails = [];
  if (validation) {
    evidenceDetails.push(outcome('complete-clean-episodes', 'Complete clean episodes', number(validation.completedEpisodes), 'Episode evidence', 'Recorded episodes'),
      outcome('electrical-recovery-checks', 'Electrical recovery checks', finite(validation.recoveryEpisodes) ? `${number(validation.recoveryEpisodes)} passed` : 'Unavailable', 'Episode evidence', 'Validation'),
      outcome('episode-error-coverage', 'Episode error coverage', number(validation.horizonHours, 'h'), 'Episode evidence', 'Validation'));
    for (const location of ['rear', 'front']) {
      const label = location === 'rear' ? 'Rear' : 'Front';
      evidenceDetails.push({ ...outcome(`${location}-whole-episode-error`, `${label} whole-episode error`,
        finite(validation[`${location}Rmse`]) ? `RMSE ${number(validation[`${location}Rmse`], '°C')}` : 'Unavailable', 'Temperature errors', 'Validation',
        'Temperature prediction error across clean ended validation episodes, including failed recovery. The model is frozen before the pause and its predicted temperatures are not corrected during assessment.'),
        evidence: `Bias ${number(validation[`${location}Bias`], '°C')}. Positive bias means the prediction was too cold.` },
      outcome(`${location}-cooling-error`, `${label} cooling-only episode error`, finite(validation[`off${label}Rmse`])
        ? `RMSE ${number(validation[`off${label}Rmse`], '°C')}` : 'Unavailable', 'Temperature errors', 'Validation',
      'Temperature prediction error during the heating-off portion of clean ended validation episodes. Cooling-only error does not establish recovery or economic pause support.'));
    }
    if (validation.active) evidenceDetails.push(outcome('active-episode', 'Episode being assessed',
      validation.active.phase === 'off' ? 'Cooling' : 'Recovery', 'Current episode', 'In progress'));
  }
  if (electricalError) evidenceDetails.push({ ...outcome('electrical-short-step-error', 'Electrical short-step error',
    finite(electricalError.mae) ? `MAE ${number(electricalError.mae, 'kW')}` : 'Unavailable', 'Electricity error', 'Validation',
    'Error between modeled and qualified recorded pump power in held-out intervals with heating available. This check is separate from complete cooling and recovery validation.'),
    evidence: `${number(electricalError.hours, 'h')} checked · ${number(electricalError.n)} predictions · bias ${number(electricalError.bias, 'kW')}. Positive bias means the prediction was too low.` });
  evidenceDetails.push({ key: 'validation-method', group: 'Learning method', title: 'How validation works', value: 'Cooling + recovery', provenance: 'Method',
    detail: 'Pause support requires complete cooling and recovery checks with a model frozen before the pause, without correcting its predicted temperatures. They use observed weather, so they do not measure weather-forecast accuracy.',
    evidence: 'RMSE is root mean square error; MAE is mean absolute error; positive bias means the prediction was too cold or too low. Error coverage includes clean ended validation episodes that failed recovery; supported pause duration requires complete passing episodes.' });
  const input = (key, title, value, group, provenance, detail, available = true) => ({ key, title, value, group, provenance, detail, available });
  const observations = garage.observations ?? {};
  const inputDetails = [
    input('rear-air-temperature', 'Rear air temperature', temperature(observations.rear), 'Temperatures', 'Recorded', inputDescriptions['Rear air temperature · °C'], finite(observations.rear?.value)),
    input('front-air-temperature', 'Front air temperature', temperature(observations.front), 'Temperatures', 'Recorded', inputDescriptions['Front air temperature · °C'], finite(observations.front?.value)),
    input('outdoor-temperature', 'Outdoor temperature', temperature(observations.outdoor), 'Temperatures',
      observations.outdoor?.source === 'openmeteo' ? 'Modeled' : ['husdata-h66', 'fmi', 'mqtt-temperature', 'shelly-mqtt'].includes(observations.outdoor?.source) ? 'Recorded' : 'Source varies',
      `${outdoorSourceLabel(observations.outdoor?.source) ?? 'Source unavailable'}. Learning uses the outdoor input recorded for each interval, which can include a modeled fallback estimate. Planning uses forecasts available at the decision time.`, finite(observations.outdoor?.value)),
    input('front-rear-difference', 'Front–rear temperature difference', number(learning.state?.differenceC, '°C'), 'Temperatures', 'Calculated',
      'Front air minus rear air, last calculated from qualified observations in the model. This value is carried between qualified front readings; it is not a separate sensor measurement.', finite(learning.state?.differenceC)),
    input('heat-pump-input', 'Heat-pump input', 'kW or 0–1 activity', 'Heating inputs', 'Recorded',
      `${inputDescriptions['Heat-pump input · kW or activity']} Qualified electrical telemetry may be verified or provisional; recorded does not imply verified accuracy.`),
    ...[1, 2].map(id => input(`charger-${id}-input`, `Charger ${id} input`, 'kW or 0–1 activity', 'Heating inputs', 'Recorded / calculated',
      `Charging electricity or observed activity for charger ${id}, recorded separately from the other vehicle. Electrical input can be calculated from qualified recorded energy. Its thermal effects remain fixed assumptions; protection excludes anticipated charging warmth.`)),
    input('heating-availability', 'Heating availability', 'Native ON / OFF', 'Operating context', 'Recorded', inputDescriptions['Heating availability']),
    input('doors-and-local-cooling', 'Doors and local cooling', 'Episode qualification', 'Operating context', 'Context', inputDescriptions['Doors and local cooling']),
    input('pump-equipment-reports', 'Pump temperature and energy reports', 'Equipment readings', 'Operating context', 'Recorded', inputDescriptions['Pump temperature and energy reports']),
    input('estimated-building-warmth', 'Estimated building warmth', number(learning.state?.coreC, '°C'), 'Modeled state', 'Modeled',
      'Slow temperature memory from rear observations; not measured pipe temperature or stored kWh. Neither an air-temperature forecast nor this building-warmth state measures pipe temperature.', finite(learning.state?.coreC)),
    input('future-pump-response', 'Future pump response', 'kW and 0–1 activity', 'Modeled state', 'Modeled',
      'Planning predicts future pump electricity and compressor activity from outdoor temperature, normal rear warmth, current warmth and restart state. Heating availability lets the built-in controller run or idle; it does not force compressor activity.'),
    input('local-allowance-recovery', 'Local allowance recovery', finite(policy.marginC) ? 'Continuous' : 'Unavailable', 'Protection context', 'Calculated',
      `${inputDescriptions['Local allowance recovery']} The water-filled copper reference is separate from learned building coefficients.`, finite(policy.marginC)),
  ];
  return { outcomeRows, inputRows, outcomeDetails, evidenceDetails, inputDetails,
    outcomeContext: 'Pause support requires complete cooling and recovery checks. Temperature evidence, electricity qualification and the current plan are shown separately.',
    inputContext: 'Values show the latest reported temperatures and retained model state; the chart’s Model inputs view shows the original learning inputs. Missing readings remain unknown.',
    coefficientContext: 'Fitted responses, initial estimates and fixed assumptions are shown separately. Expand a coefficient for its role and input coverage.' };
}

export function garageColdBudget(garage = {}, location) {
  const name = location === 'rear' ? 'Rear' : 'Front';
  const policy = garage.settings?.protection, protection = garage.protection;
  const local = protection?.locations?.[location];
  const title = `${name} cold allowance remaining`;
  const unavailable = (summary, detail) => ({ label: `${name} —`, value: '—', title, summary, detail, remaining: null, available: false, attention: false });
  if (policy?.approved !== true)
    return unavailable(policy?.approved === false ? 'Policy not approved' : 'Approval unknown', 'The garage freezing-protection policy has not been approved.');
  if (protection?.approved !== true)
    return unavailable('Assessment unavailable', 'No approved garage freezing-protection assessment is available.');
  if (!local || !finite(local.remainingKjPerM) || local.remainingKjPerM < 0 || !finite(local.estimatedC))
    return unavailable('Assessment unavailable', 'A valid thermal reserve estimate is not available for this location.');
  if (local.fresh !== true)
    return unavailable('Awaiting fresh temperature', 'A fresh, qualified temperature report is required to show this location’s allowance.');
  if (local.reason === 'initializing-reserve')
    return unavailable('Establishing reserve', 'Fresh local temperature reports are establishing the reference’s warmth. Allowance becomes available as it recovers.');
  if (local.uncertain)
    return unavailable('Temperature history uncertain', 'Missing temperature history makes this location’s reserve uncertain. Fresh local readings must establish its recovery before an allowance is shown.');
  const remaining = local.remainingKjPerM, exhausted = remaining === 0;
  // A small positive reserve must not be displayed as exhausted.
  const value = remaining > 0 && remaining < .01 ? '<0.01 kJ/m' : number(remaining, 'kJ/m');
  const limit = local.reason ?? (protection.limitingLocation === location
    && protection.reasons?.includes('restoration-margin-exhausted') ? 'restoration-margin-exhausted' : null);
  const reason = limit != null ? ` Current protection limit: ${text(limit)}.` : '';
  return { label: `${name} ${value}`, value, title, remaining, estimatedC: local.estimatedC, available: true,
    summary: exhausted ? 'Allowance exhausted' : limit != null ? 'Heating reserve required' : `Reference estimate ${number(local.estimatedC, '°C')}`,
    attention: exhausted || limit != null,
    detail: `${value} of estimated warmth above the ${number(policy.marginC, '°C')} protection margin, per metre of the water-filled copper reference. Reference temperature: ${number(local.estimatedC, '°C')}.${reason} Heating resumes while enough reserve remains to restore useful heat. The allowance changes continuously with local temperature history; it is not a measured pipe temperature or a countdown.` };
}

/** Public monitoring projection only. Never serialize raw adapter state, topics,
 * device identifiers, command payloads or private configuration into the DOM. */
export function garageDisplay(garage = {}, now = Date.now()) {
  const settings = garage.settings ?? {}, protection = garage.protection ?? {}, locations = protection.locations ?? {};
  const adapter = garage.adapter ?? {}, reported = adapter.native ?? adapter.readbacks ?? {}, health = adapter.health ?? {};
  const telemetry = adapter.telemetry ?? {};
  const telemetryValue = (signal, unit) => {
    const row = telemetry[signal];
    if (!row?.supported || !finite(row.value)) return 'Unavailable';
    return `${number(row.value, unit)}${row.usable ? row.accuracyVerified ? ' · verified' : ' · provisional' : row.quality?.includes('stale') ? ' · stale' : ' · unqualified'}`;
  };
  const plan = garage.plan ?? {}, learning = garage.learning ?? {};
  const episode = garage.episode ?? {};
  const rows = [];
  for (const location of ['rear', 'front']) {
    const label = location === 'rear' ? 'Rear air · near pipe' : 'Front air · near door';
    const local = locations[location] ?? {}, observation = garage.observations?.[location];
    rows.push([label, temperature(observation)]);
    rows.push([`${location === 'rear' ? 'Rear' : 'Front'} allowance remaining`, finite(local.remainingKjPerM)
      ? `${number(local.remainingKjPerM, 'kJ/m')}${local.uncertain ? ' · uncertain history' : ''}` : 'Unavailable']);
    rows.push([`${location === 'rear' ? 'Rear' : 'Front'} reference estimate`, finite(local.estimatedC)
      ? `${number(local.estimatedC, '°C')}${local.uncertain ? ' · uncertain history' : ''}` : 'Unavailable']);
    if (finite(local.interventionAt)) rows.push([`${location === 'rear' ? 'Rear' : 'Front'} intervention by`, clock(local.interventionAt)]);
  }
  rows.push(['Limiting protection location', text(protection.limitingLocation)],
    ['Configured normal Mitsubishi setting', number(settings.baselineC, '°C')],
    ['Native power', reported.power === null || reported.power === undefined ? 'Unknown' : `${text(native(reported.power))}${!finite(reported.powerAt) ? ' · freshness unknown' : !garageNativeReadingFresh(garage, 'power', now) ? ' · current reading unavailable' : ''}`], ['Native mode', text(native(reported.mode))],
    ['Native target', number(native(reported.targetC), '°C')],
    ['Pump indoor temperature', telemetryValue('garage_native_indoor_temperature', '°C')], ['Pump outdoor temperature', telemetryValue('garage_native_outdoor_temperature', '°C')],
    ['Electrical power', telemetryValue('garage_power', 'W')], ['Native cumulative energy', telemetryValue('garage_native_energy', 'kWh')],
    ['Compressor frequency', telemetryValue('garage_compressor_frequency', 'Hz')],
    ['Compressor / fan / defrost', [reported.compressorActive, reported.fanStage, reported.defrost].map(value => value === undefined || value === null ? 'Unknown' : typeof native(value) === 'boolean' ? state(native(value)) : text(native(value))).join(' · ')],
    ['Device online', state(health.deviceOnline)], ['Driver progressing', state(health.driverProgressing)],
    ['Pump communicating', state(health.pumpCommunicating)],
    ['Local lease remaining', finite(adapter.episode?.leaseExpiresAt) ? number(Math.max(0, adapter.episode.leaseExpiresAt - now) / 60_000, 'min') : 'No accepted lease'],
    ['Recovery', episode.restorationPending || adapter.restorePending ? 'Restoration pending · awaiting evidence' : text(episode.phase ?? adapter.phase ?? 'No managed episode')],
    ['Adapter contract', `${adapter.contractVersion ?? 'Unavailable'} · ${text(adapter.contractStatus)}`],
    ['Native baseline verified', state(adapter.baselineVerified)],
    ['Last heating request', adapter.lastCommand ? `${text(({ start: 'pause', renew: 'pause renewal', release: 'restore heating' })[adapter.lastCommand.action])} · ${text(adapter.lastCommand.status)}` : 'No request'],
    ['Native command confirmation', finite(adapter.lastCommand?.nativeConfirmedAt) ? clock(adapter.lastCommand.nativeConfirmedAt) : 'Not confirmed'],
    ['Heat response after restore', finite(adapter.lastCommand?.usefulHeatAt) ? clock(adapter.lastCommand.usefulHeatAt) : adapter.lastCommand?.action === 'release' ? 'Awaiting useful heat evidence' : 'No restore assessment'],
    ['Control capability', adapter.liveControlSupported ? 'Installed contract' : 'Monitoring · real contract unavailable'],
    ['Plan', text(plan.reason ?? garage.reason)], ['Planned pause endpoint', finite(plan.pauseUntil) ? clock(plan.pauseUntil) : 'No pause planned']);
  const policy = settings.protection ?? {};
  const settingGroups = {
    heating: [
      ['Normal Mitsubishi setting', number(settings.baselineC, '°C'), 'The existing pump setting used as the normal-heating reference. ST-MQ does not raise the thermostat.'],
      ['Savings aggressiveness', finite(settings.aggressiveness) ? `${number(settings.aggressiveness)} / 100` : 'Unavailable', 'Higher values favor savings over the depth and duration of cooling. At 0, normal heating remains available and learning continues.'],
    ],
    protection: [
      ['Protection margin', number(policy.marginC, '°C'), 'Heat reserve is calculated above this temperature. Heating is requested early to allow time for warming.'],
      ['Reference pipe diameter', number(policy.pipeOutsideDiameterMm, 'mm'), 'Outside diameter of the bare, water-filled copper pipe used as the protection reference.'],
      ['Assumed wall thickness', number(policy.pipeWallMm, 'mm'), 'The copper wall thickness used to calculate the reference’s capacity to store warmth.'],
      ['Heat transfer', number(policy.heatTransferWPerM2K, 'W/m²K'), 'Initial estimate of how readily the reference exchanges heat with the surrounding air.'],
      ['Safety factor', `${GARAGE_HEAT_TRANSFER_SAFETY_FACTOR}×`, 'Counts cooling twice as quickly and warming half as quickly.'],
    ],
    recovery: [
      ['Cold allowance', 'Calculated · kJ/m', 'The reference’s stored warmth determines each location’s allowance. A warmer starting point provides more reserve.'],
      ['Recovery', 'Continuous', 'Local air warms the reference and restores allowance gradually. A greater temperature difference restores it faster.'],
    ],
  };
  const coefficients = garageCoefficientRows(learning);
  const learningRows = garageLearningRows(garage, policy);
  return { status: text(garage.status ?? (settings.enabled ? 'commissioning' : 'monitoring')),
    reason: text(garage.reason ?? 'Automatic control awaits the implemented adapter contract and installed commissioning')
      .trim().replace(/^./, value => value.toUpperCase()),
    rows, settingGroups, coefficients: coefficients.rows, coefficientDetails: coefficients.details, ...learningRows, limitations: learning.limitations ?? [] };
}

export function renderGarage(document, status) {
  const display = garageDisplay(status?.garage, status?.now);
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const detail = (id, label, title, description, stale = false) => {
    const node = document.getElementById(id); if (!node) return;
    node.classList.toggle('stale', stale);
    setStatusDetail(node, { label, title, detail: description, key: id });
  };
  const garage = status?.garage ?? {}, adapter = garage.adapter ?? {}, reported = adapter.native ?? adapter.readbacks ?? {};
  const now = status?.now ?? Date.now();
  const control = document.getElementById('garage-control-price');
  if (control) {
    control.textContent = garage.temporary?.pauseActive ? 'Paused'
      : garage.settings?.enabled === true ? 'Active' : garage.settings?.enabled === false ? 'Disabled' : '—';
    control.parentElement.dataset.state = garage.temporary?.pauseActive ? 'paused'
      : garage.settings?.enabled === true ? 'active' : 'muted';
  }
  const devices = status?.equipment?.devices ?? [];
  const temperatureDevice = devices.find(device => device.enabled !== false && device.readings?.garage_temperature);
  const rear = garage.observations?.rear;
  const main = finite(rear?.value) ? equipmentReadingRows({ kind: 'temperature', available: rear.stale === false,
    readings: { garage_temperature: { ...rear, unit: 'degC', label: 'Main garage temperature' } } })[0]
    : temperatureDevice ? equipmentReadingRows(temperatureDevice).find(row => row.signal === 'garage_temperature') : null;
  detail('garage-temperature', main?.value ?? 'Unavailable', 'Garage temperature',
    main?.detail ?? 'Waiting for a usable garage temperature.', main?.stale ?? true);
  document.getElementById('garage-temperature')?.classList.toggle('metric-unavailable', !main || main.stale);
  set('garage-temperature-age', !main || main.stale ? 'Waiting for current readings'
    : main.qualifier ?? 'Readings current');
  const temperatureNote = document.getElementById('garage-temperature-age');
  if (temperatureNote) temperatureNote.hidden = Boolean(main && !main.stale && !main.qualifier);
  for (const location of ['rear', 'front']) {
    const budget = garageColdBudget(garage, location);
    const settingId = `garage-settings-budget-${location}`;
    detail(settingId, budget.value, budget.title, budget.detail);
    const settingNode = document.getElementById(settingId);
    if (settingNode) settingNode.dataset.state = budget.attention ? 'attention' : 'muted';
    set(`${settingId}-remaining`, budget.summary);
  }
  const doors = devices.filter(device => device.enabled !== false && device.kind === 'door' && ((device.area ?? 'garage') === 'garage'
    || Object.keys(device.readings ?? {}).some(signal => /^garage_door/.test(signal)))).flatMap(device => {
    const rows = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
    return rows.length ? rows.map(row => ({ ...row, name: device.label ?? row.label }))
      : [{ name: device.label ?? 'Door', value: 'Unknown', stale: true, detail: 'No usable reading received' }];
  });
  const openDoors = doors.filter(row => row.value === 'Open'), closedDoors = doors.filter(row => row.value === 'Closed');
  const unknownDoors = doors.filter(row => !['Open', 'Closed'].includes(row.value));
  const doorName = row => /^garage_door(\d+)_open$/.test(row.signal)
    ? `Door ${row.signal.match(/^garage_door(\d+)_open$/)[1]}` : row.name.replace(/^Garage\s+/i, '');
  let doorSummary = 'Unknown';
  if (doors.length === 1) doorSummary = doors[0].value;
  else if (doors.length === 2) {
    if (openDoors.length === 2) doorSummary = 'Both open';
    else if (closedDoors.length === 2) doorSummary = 'Both closed';
    else if (openDoors.length === 1) doorSummary = `${doorName(openDoors[0])} open${unknownDoors.length ? ' · other unknown' : ''}`;
    else if (unknownDoors.length === 2) doorSummary = 'Both unknown';
    else doorSummary = `${doorName(unknownDoors[0])} unknown`;
  } else if (doors.length > 2) {
    doorSummary = [[openDoors.length, 'open'], [closedDoors.length, 'closed'], [unknownDoors.length, 'unknown']]
      .filter(([count]) => count).map(([count, state]) => `${count} ${state}`).join(' · ');
  }
  detail('garage-door-summary', doorSummary,
    'Garage doors', doors.length ? doors.map(row => `${row.name}: ${row.value}. ${row.detail}`).join('\n')
      : 'No garage door reports are available.', !doors.length || doors.some(row => row.stale));
  const doorStatus = document.getElementById('garage-door-summary');
  if (doorStatus) doorStatus.dataset.state = doors.length && closedDoors.length === doors.length && !doors.some(row => row.stale)
    ? 'confirmed' : 'attention';

  const nativeReading = (field, title, format) => {
    const value = native(reported[field]), at = reported.readbacks?.[field]?.measuredAt
      ?? (field === 'power' ? reported.powerAt : null);
    const fresh = garageNativeReadingFresh(garage, field, now);
    const last = value === null || value === undefined ? 'Unknown' : format(value);
    const id = `garage-native-${field === 'targetC' ? 'target' : field}`;
    const available = fresh && last !== 'Unknown';
    set(id, available ? last : '—');
    const node = document.getElementById(id); node?.classList.toggle('stale', !available); node?.classList.toggle('muted', !available);
    return { value, fresh, detail: `${title}: ${last === 'Unknown' ? 'No usable native reading received.'
      : `Last reported ${last} · ${finite(at) ? clock(at) : 'freshness unknown'}${fresh ? '' : ' · current reading unavailable'}`}` };
  };
  const power = nativeReading('power', 'Mitsubishi power', text);
  const mode = nativeReading('mode', 'Mitsubishi mode', text);
  const target = nativeReading('targetC', 'Mitsubishi target', value => number(value, '°C'));
  detail('garage-pump-reading-info', 'Reading details', 'Mitsubishi heat-pump readings', [power, mode, target].map(reading => reading.detail).join('\n\n'));
  const controls = garage.heatingControls ?? {}, action = garage.plan?.nextAction;
  const held = controls.paused && controls.holdUntil > now;
  const requested = controls.requestedMode === 'off' ? 'Off'
    : controls.requestedMode === 'normal' ? 'Normal'
      : adapter.phase === 'paused' ? 'Reduction'
        : adapter.restorePending || garage.episode?.restorationPending || adapter.phase === 'restoring' ? 'Restoring'
          : ['pause', 'renew'].includes(action) ? 'Reduction'
            : ['available', 'release'].includes(action) || garage.temporary?.pauseActive ? 'Normal' : 'No request';
  set('garage-requested-label', 'HEATING REQUEST');
  setHeatingStatusDetail(document.getElementById('garage-requested'), { key: 'garage-requested',
    label: `${requested}${held ? ' · held' : ''}`, title: 'Garage heating request',
    confirmation: garageHeatingConfirmation(status, requested),
    detail: `${display.reason}.${held ? ` Manual heating selection is held until ${clock(controls.holdUntil)} or Resume now.` : ''} The request describes the heating plan.` });
  renderCurrentPrice(document, status, 'garage-');
  set('garage-pause-overview', garage.temporary?.pauseActive
    ? `Price control paused until ${clock(garage.temporary.pauseUntil)}` : 'Pause automatic price control');
  const list = (id, rows) => {
    const root = document.getElementById(id); if (!root) return;
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; fragment.append(dt, dd);
    }
    root.replaceChildren(fragment);
  };
  set('garage-controller-state', display.status); set('garage-controller-reason', display.reason);
  list('garage-controller-readings', display.rows.filter(([label]) => !['Native power', 'Native mode', 'Native target'].includes(label)));
  const approved = garage.settings?.protection?.approved;
  set('garage-protection-approval', approved === true ? 'Owner-approved' : approved === false ? 'Not approved' : 'Approval unknown');
  for (const [group, rows] of Object.entries(display.settingGroups)) {
    const root = document.getElementById(`garage-${group}-settings`); if (!root) continue;
    const fragment = document.createDocumentFragment();
    for (const [label, value, description] of rows) {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      const help = document.createElement('small');
      row.className = 'garage-setting';
      dt.textContent = label; help.textContent = description; dt.append(help);
      dd.textContent = value; row.append(dt, dd); fragment.append(row);
    }
    root.replaceChildren(fragment);
  }
  renderLearningRows(document.getElementById('garage-learning-outcomes'), display.outcomeDetails, { document });
  renderLearningRows(document.getElementById('garage-learning-evidence'), display.evidenceDetails, { document });
  renderLearningRows(document.getElementById('garage-learning-inputs'), display.inputDetails, { document });
  set('garage-learning-context', display.outcomeContext); set('garage-input-context', display.inputContext);
  set('garage-coefficient-context', display.coefficientContext);
  renderLearningRows(document.getElementById('garage-learning-coefficients'), display.coefficientDetails, { document });
  set('garage-learning-limitations', sentences(display.limitations));
}


export function garageReleaseAvailable(status) {
  const adapter = status?.garage?.adapter;
  return Boolean(status && status.readOnly !== true && !isReadOnlyReplica(status)
    && adapter?.restorePending === true && (adapter.liveControlSupported === true || adapter.simulation === true));
}

/** Ending an owned pause uses the safe release route. This never introduces a
 * generic switch capable of overriding an unmanaged or manual OFF state. */
export function createGarageControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id);
  const button = $('garage-release'), message = $('garage-release-message');
  const form = $('garage-pause-form'), until = $('garage-pause-until');
  let status = null, busy = false, closed = false, dirty = false;
  const notices = new Map();
  const restorationPending = value => Boolean(value?.garage?.adapter?.restorePending
    || value?.garage?.episode?.restorationPending || value?.garage?.adapter?.phase === 'restoring');
  const rememberNotice = (target, result, refresh) => notices.set(target, { result, refresh });
  const refreshControls = () => {
    const locked = closed || busy || blocked() || !status || isReadOnlyReplica(status);
    if (button) button.disabled = locked || !garageReleaseAvailable(status);
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    for (const mode of ['normal', 'off']) {
      const node = $(`garage-mode-${mode}`); if (!node) continue;
      node.disabled = locked || controls[`${mode}Available`] !== true;
      const selected = (controls.requestedMode ?? controls.selectedMode) === mode;
      node.setAttribute('aria-pressed', String(selected));
      node.setAttribute('aria-label', `${mode === 'normal' ? 'Normal heating' : 'Heating off'}${selected ? controls.confirmed ? ' · active' : ' · requested' : ''}`);
      node.querySelector('.heating-button-state').textContent = selected ? '✓' : '';
    }
    if ($('garage-pause-submit')) $('garage-pause-submit').disabled = locked || !temporary.available || !dirty;
    if ($('garage-resume-now')) $('garage-resume-now').disabled = locked || !temporary.available || !temporary.pauseActive;
    if (until) until.disabled = locked || !temporary.available;
  };
  const render = () => {
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    if (until && !dirty) until.value = temporary.pauseUntilLocal ?? finnishDateTime(temporary.pauseUntil);
    if ($('garage-pause-status')) $('garage-pause-status').textContent = temporary.pauseActive
      ? `Price control paused until ${clock(temporary.pauseUntil)}.` : 'Price control is not paused.';
    if ($('garage-heating-help')) $('garage-heating-help').textContent = controls.available
      ? 'If price control is not paused, manual changes revert on the next update, normally within 1 minute. During Pause, they stay until it ends. Freeze protection can restore heating sooner.'
      : controls.reason ?? 'Waiting for the garage heating connection.';
    const off = $('garage-mode-off');
    if (off) off.title = controls.offAvailable ? '' : controls.offReason ?? controls.reason ?? 'Heating off is unavailable.';
    const warning = garageHeatingWarning(status, clock), node = $('garage-hold-warning');
    if (node) { node.hidden = !warning; node.textContent = warning; }
    if (!busy) for (const [target, notice] of notices) {
      target.textContent = notice.refresh(status, notice.result);
      if (!target.textContent) { notices.delete(target); target.classList.remove('form-error'); }
    }
    refreshControls();
  };
  const send = async (path, input, target, pending, success, refresh) => {
    if (closed || busy || blocked() || !status || isReadOnlyReplica(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    notices.delete(target);
    target.classList.remove('form-error'); target.textContent = pending;
    try {
      const result = await request(path, input);
      if (path.endsWith('/temporary')) dirty = false;
      status = result; onStatus(result); render(); target.textContent = success(result);
      rememberNotice(target, result, refresh);
    } catch (error) { target.classList.add('form-error'); target.textContent = error.message; }
    finally { busy = false; onBusy(false); refreshControls(); }
    await afterRequest();
  };
  const heat = async mode => {
    const controls = status?.garage?.heatingControls;
    if (!controls?.[`${mode}Available`] || busy || blocked() || closed) return;
    if (status.garage.temporary?.pauseActive && !await confirmPausedHeating({ document,
      title: mode === 'off' ? 'Turn garage heating off during Pause?' : 'Change garage heating during Pause?',
      message: `${mode === 'off' ? 'Heating will stay off' : 'Normal heating will stay selected'} until ${clock(status.garage.temporary.pauseUntil)} or Resume now. ${mode === 'off'
        ? 'A cold garage can freeze pipes and stored equipment. Freeze protection may restore heating sooner.'
        : 'Automatic price control stays paused until then.'} Normal heating returns when the pause ends.`,
      action: mode === 'off' ? 'Turn heating off' : 'Apply normal heating' })) return;
    if (!status?.garage?.heatingControls?.[`${mode}Available`]) return;
    const heatingMessage = result => {
      const next = result.garage?.heatingControls, held = next?.paused && next.holdUntil > result.now;
      return `${mode === 'off' ? 'Heating off' : 'Normal heating'} requested. ${held
        ? `Held until ${clock(next.holdUntil)} or Resume now.` : 'Automatic control takes over on its next update, normally within 1 minute.'} ${next?.confirmed ? 'Device confirmed.' : 'Check the reported pump state for confirmation.'}`;
    };
    await send('/api/garage/heating', { mode }, $('garage-heating-message'), 'Applying garage heating…', heatingMessage, (next, requested) => {
      const controls = next.garage?.heatingControls;
      if (controls?.requestedMode === mode && controls.holdUntil === requested.garage?.heatingControls?.holdUntil
        && controls.holdUntil > next.now) return heatingMessage(next);
      if (controls?.requestedMode && controls.holdUntil > next.now) return '';
      return restorationPending(next) ? 'Temporary heating request ended. Waiting for normal heating confirmation.' : '';
    });
  };
  const pauseMessage = (next, requested) => {
    const temporary = next.garage?.temporary;
    if (temporary?.pauseActive && temporary.pauseUntil > next.now) return temporary.pauseUntil === requested.garage?.temporary?.pauseUntil
      ? `Price control paused until ${clock(temporary.pauseUntil)}. Manual changes stay until the pause ends.` : '';
    return !next.garage?.heatingControls?.requestedMode && restorationPending(next)
      ? 'Price control resumed. Waiting for normal heating confirmation.' : '';
  };
  const pause = event => {
    event.preventDefault();
    if (!dirty || !status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntilLocal: until.value || null }, $('garage-pause-message'), 'Updating garage pause…',
      result => result.garage?.temporary?.pauseActive ? 'Pause saved. Normal heating is requested; later manual changes stay until the pause ends.' : 'Price control resumed.', pauseMessage);
  };
  const resume = () => {
    if (!status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntil: null }, $('garage-pause-message'), 'Resuming garage price control…',
      result => restorationPending(result) ? 'Price control resumed. Waiting for normal heating confirmation.' : 'Price control resumed.', pauseMessage);
  };
  const edit = () => { dirty = true; refreshControls(); };
  const normal = () => { void heat('normal'); }, off = () => { void heat('off'); };
  $('garage-mode-normal')?.addEventListener('click', normal);
  $('garage-mode-off')?.addEventListener('click', off);
  form?.addEventListener('submit', pause); until?.addEventListener('input', edit);
  $('garage-resume-now')?.addEventListener('click', resume);
  const release = async () => {
    if (closed || busy || blocked() || !garageReleaseAvailable(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    notices.delete(message);
    button.setAttribute('aria-busy', 'true'); message.classList.remove('form-error');
    message.textContent = 'Ending garage pause; awaiting heating confirmation…';
    try {
      const result = await request('/api/garage/release', {});
      status = result; onStatus(result);
      message.textContent = result.garage?.adapter?.restorePending
        ? 'Restoration requested. Waiting for heating confirmation.' : 'Garage pause ended.';
      rememberNotice(message, result, next => next.garage?.heatingControls?.requestedMode === 'off' ? ''
        : restorationPending(next) ? 'Restoration requested. Waiting for heating confirmation.' : '');
    } catch (error) {
      message.classList.add('form-error'); message.textContent = error.message;
    } finally {
      busy = false; button.removeAttribute('aria-busy'); onBusy(false); refreshControls();
    }
    await afterRequest();
  };
  button?.addEventListener('click', release); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() {
      closed = true; button?.removeEventListener('click', release);
      $('garage-mode-normal')?.removeEventListener('click', normal); $('garage-mode-off')?.removeEventListener('click', off);
      form?.removeEventListener('submit', pause); until?.removeEventListener('input', edit);
      $('garage-resume-now')?.removeEventListener('click', resume); refreshControls();
    } };
}
