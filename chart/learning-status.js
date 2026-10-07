import { HEATING_STRATEGIES } from '../src/domain/heating-strategy.js';
import { operationModes } from './history-model.js';
import { MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { H66_MAX_AGE_MS } from '../src/domain/reading-freshness.js';
import { durationText, qualityReasonText } from './reading-status.js';
import { renderLearningRows } from './learning-rows.js';
import { coefficientCalculation, floorCalculation, sourceCalculation, heatBalanceCalculation, outcomeCalculation,
  inputCalculation, dutyCalculation, economicCalculation, validationCalculation, calibrationCalculation, fittingCalculation,
  preheatCalculation, recoveryHoldCalculation, hotWaterCalculation } from './home-learning-math.js';

const finite = Number.isFinite;
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const words = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
// Keep each group contiguous; the renderer preserves disclosure nodes by key.
const groupRows = (rows, order = [...new Set(rows.map(row => row.group))]) =>
  rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
const metricDefinitions = [
  ['profit', 'Assessed space-heating benefit', '€/cycle', 'Estimated mean space-heating benefit against the alternative fixed when planned, including recovery. This completed-cycle subset does not establish total household or hot-water savings. Negative values mean the assessed heating cycles cost more.'],
  ['auxProfit', 'Benefit with auxiliary recovery', '€/cycle', 'The same space-heating estimate, restricted to completed cycles with observed space-heating auxiliary use during recovery. Unknown auxiliary history is excluded; no qualifying cycles means unavailable, not zero.'],
  ['recoveryError', 'Space-heating recovery prediction error', '€/cycle', 'Mean absolute difference between the original space-heating recovery prediction and the completed recovery cost estimate. Lower is better; this checks the prediction, not a measured saving.'],
  ['indoorTemperature', 'Normal indoor temperature', '°C', 'The configured indoor average achieved during occupied Normal heating. One supported hour establishes a provisional reference; ordinary valid observations refine it gradually. Verified heating activity supports the reference; cool weather can provide provisional heating-demand evidence when equipment observations are missing. Missing sensor estimates, preheating, reduction, recovery and logged fireplace heating do not train it.'],
];
const coefficientLabels = {
  lossPerHour: 'Heat loss', hydronicCPerKwh: 'Combined compressor + auxiliary response', solarCPerHourPerKwM2: 'Solar response',
  fireplaceCPerKg: 'Fireplace response', memoryExchangePerHour: 'Building heat exchange', reserveTimeHours: 'Building memory time',
};
const coefficientInfo = {
  ...Object.fromEntries(Object.values(MODEL_COEFFICIENT_INFO).map(info => [info.parameter, info])),
  memoryExchangePerHour: { unit: '1/h', digits: 4, fixed: true, detail: 'Exchange rate between the modeled building heat reserve and indoor air. The slow reserve is unmeasured, so this remains a fixed structural assumption.' },
  reserveTimeHours: { unit: 'h', digits: 1, fixed: true, detail: 'Time scale of the modeled building heat reserve. This is temperature memory, not a measured floor temperature or storage capacity.' },
};
const inputSources = {
  model_indoor_temperature: 'The configured sensors contribute according to their weights. Their latest genuine readings can be held between reports; freshness and report coverage determine whether the interval is usable. A missing contributing sensor or a gap in required reports excludes the average. The chart preserves the originally supplied average, including sensor-change settling gaps; corrected learning can use preserved readings behind those settling gaps.',
  model_outdoor_temperature: 'FMI station, with an Open-Meteo estimate when the station is unavailable. Source validity is checked at each segment.',
  model_solar_radiation: 'Archived FMI radiation forecast, with Open-Meteo as backup. Radiation is modeled, not measured at the house. It is expressed in W/m²; the model converts it to kW/m².',
  model_compressor_duty: 'Recorded compressor-active and DHW-routing states are intersected in time. Space-heating activity is 1, other known activity is 0; the chart expresses duty as a percentage.',
  model_hydronic_heat: 'Recorded space-heating compressor duty is multiplied by the fixed DHP-H 10 thermal-output estimate at the saved heating-water supply temperature, then estimated space-heating AUX kW is added. Supply fallback, routing and model assumptions remain explicit; electricity is costed separately.',
  model_valve_override: 'The saved relay-output mode distinguishes confirmed pooled override from normal thermostat authority. Relay and timer feedback confirms the electrical override, not valve movement, water flow or delivered heat. Permanently open circuits remain background heating paths in both modes.',
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
    model_compressor_duty: ['Heating inputs', 'Calculated from recorded states'],
    model_hydronic_heat: ['Heating inputs', 'Estimated thermal power'],
    model_valve_override: ['Control context', 'Recorded relay mode'],
    model_auxiliary_power: ['Heating inputs', 'Estimated from recorded output'],
    model_controller_phase: ['Control context', 'Recorded request'],
    model_room_boost: ['Control context', 'Recorded request'],
    model_target_temperature: ['Control context', 'Recorded reference'],
    firewood_load: ['Firewood', 'Manually recorded'],
    model_fireplace_release: ['Firewood', 'Modeled release'],
  };
  return groupRows(Object.entries(MODEL_INPUT_INFO).map(([key, info]) => ({ key, modelInput: key, title: info.label, unit: info.unit,
    value: info.unit, group: presentation[key]?.[0] ?? 'Model inputs', provenance: presentation[key]?.[1] ?? 'Recorded or modeled',
    detail: info.detail, calculation: inputCalculation(key), sources: inputSources[key], evidence: inputSources[key] })));
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
  'confounded-with-fixed-uncertain-inputs': 'This response cannot be separated from another uncertain heat input, even if that input is held fixed',
  'confounded-with-other-heat-inputs': 'Available observations cannot separate this response from other heating inputs',
  'unmeasured-slow-state; fixed-structural-prior': 'The slow heat reserve is unmeasured; this is a fixed assumption',
  'insufficient-clean-intervals': 'Too few usable intervals in the current fitting window',
};
const evidenceReason = reason => evidenceReasons[reason] ?? words(reason);

function coefficientState(model, key, info) {
  if (!finite(model.parameters?.[key])) return 'unavailable';
  if (info.fixed) return 'fixed';
  if (model.validation?.accepted !== true) return model.trainedAt ? 'unvalidated' : 'initial';
  if (model.validation.fittedParameters?.includes(key)) return 'fitted';
  return retainedValidatedCoefficient(model.validation, key) ? 'retained' : 'unvalidated';
}

const coefficientProvenance = {
  unavailable: 'Unavailable', fixed: 'Fixed assumption',
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
  const rows = Object.entries(coefficientInfo).filter(([key]) => Object.hasOwn(model.parameters ?? {}, key)).map(([key, info]) => {
    const rawValue = model.parameters[key], available = finite(rawValue);
    const evidence = validation?.parameterEvidence?.[key];
    const state = coefficientState(model, key, info);
    const latest = adaptive.health?.status === 'retained-previous' ? adaptive.health.parameterEvidence?.[key] : null;
    return { key, title: coefficientLabels[key], unit: info.unit, available,
      group: info.fixed ? 'Building assumptions' : 'Thermal responses',
      value: available ? `${number(rawValue, info.digits)} ${info.unit}` : 'Unavailable',
      provenance: coefficientProvenance[state],
      detail: key === 'hydronicCPerKwh' && model.floor?.enabled
        ? 'Effective temperature response per estimated thermal kWh supplied by the compressor and resistance heater together. Heat enters the remaining building reserve and selected slab before it reaches indoor air. This is a house response, not COP or measured heat capacity.'
        : info.detail,
      calculation: key === 'reserveTimeHours' && !finite(model.parameters?.hydronicCPerKwh)
        ? undefined : coefficientCalculation(key, model),
      evidence: [coefficientEvidenceText(evidence), latest?.reason ? `Latest unaccepted update: ${evidenceReason(latest.reason)}` : ''].filter(Boolean).join(' · ') };
  });
  if (finite(model.parameters?.hydronicCPerKwh)) {
    rows.push({ key: 'source-model-confirmed', title: 'Installed heat-pump model', group: 'Source assumptions',
      value: model.performance?.modelConfirmed ? 'Confirmed DHP-H 10' : 'DHP-H 10 assumed', provenance: 'Configured assumption', calculation: sourceCalculation(),
      detail: 'The source map applies to the standard DHP-H 10. An unconfirmed installed variant increases the modeled source uncertainty. A good temperature fit cannot independently verify compressor output or identify a brine-temperature correction.' });
  }
  if (model.floor?.enabled) {
    const floor = model.floor;
    for (const [key, title, unit, digits, detail] of [
      ['capacityKwhPerC', 'Selected slab capacity', 'kWh/K', 2, 'Material sensible heat capacity at uniform temperature. Effective charge, useful tariff-period heat and electricity saved can all be smaller. By default, selected capacity is taken from the seeded reserve capacity rather than added twice.'],
      ['nativeCapacityKwhPerC', 'Remaining building reserve capacity', 'kWh/K', 2, 'Fixed effective reserve capacity after allocating the selected slab. This latent state is not a measured temperature or independently identified heat capacity.'],
      ['exchangeKwPerC', 'Slab heat exchange', 'kW/K', 3, 'Fixed transfer between the selected slab and room; the model keeps slab temperature through relay transitions. It is not currently learned from room-only readings.'],
      ['groundLossKwPerC', 'Slab ground exchange', 'kW/K', 3, 'Fixed passive exchange with the configured slow ground boundary, separate from the current above-ground envelope coefficient.'],
      ['groundC', 'Ground boundary temperature', '°C', 1, 'Configured slow ground temperature, separate from the outdoor-air temperature. This is a physical prior, not a ground sensor reading.'],
      ['openAllocationFraction', 'Heat allocation with override', 'fraction', 2, 'Fraction of already supplied hydronic heat entering the selected slab with all override outputs confirmed. The remaining heat enters the building reserve; no extra heat is invented.'],
      ['closedAllocationFraction', 'Heat allocation in normal mode', 'fraction', 2, 'Background fraction entering the selected slab with normal thermostat authority. Other permanently open circuits remain available and are not credited as newly enabled storage.'],
    ]) if (finite(floor[key])) rows.push({ key: `floor-${key}`, title, unit, group: 'Floor assumptions',
      value: `${number(floor[key], digits)} ${unit}`, provenance: 'Fixed assumption · not fitted', detail, calculation: floorCalculation(key) });
    rows.push({ key: 'floor-state-validation', title: 'Storage-response learning', group: 'Floor assumptions',
      value: 'Fixed priors', provenance: 'Awaiting independent storage evidence',
      detail: `No extra storage-response coefficient is fitted. Complete override charging and recovery episodes must distinguish charging amount from release timing before one can be added. Floor capacity, allocation, ground loss and exchange cannot all be identified from sparse room readings.${floor.capacityBudgetExceeded ? ' The selected capacity exceeds the configured reserve budget; the structural assumptions need review.' : ''}` });
  }
  return groupRows(rows);
}

export function learningDisplay(learning = {}, context = {}) {
  const adaptive = learning.adaptive ?? {}, model = adaptive.model ?? {}, health = adaptive.health ?? {};
  const validation = model.validation, p = model.parameters ?? {}, energy = model.energy ?? {};
  const status = health.status ?? learning.status;
  const title = status === 'prior-estimates' ? 'Learning from initial estimates'
    : status === 'retained-previous' ? 'Keeping the previous model'
      : status === 'learning' ? 'Learning from observed temperatures' : words(status || 'Collecting observations');
  const process = 'Learning fits the temperature response from completed 15-minute intervals, preserving genuine sensor-report timing and changes in heat input. Later observations test those estimates. Temperature checks use recorded heat input; equipment-response checks predict compressor duty; forecasts saved before a cycle test the complete prediction. These checks determine which predictions planning can use. They do not observe the unexecuted alternative or prove savings.';
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
  if (validation?.accepted === false && finite(validation.maxErrorC)) record('Current temperature check', 'Not currently validated', `Retained coefficients fail the current holdout: maximum ${number(validation.maxErrorC)} °C error; mean ${number(validation.maeC)} °C. Earlier accepted evidence does not authorize present predictions.`);
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

  if (finite(energy.compressorKw)) basis('Electricity assumptions', finite(p.hydronicCPerKwh) ? 'Performance map + AUX rating' : `${number(energy.compressorKw)} kW compressor`, `Electricity basis: ${finite(p.hydronicCPerKwh) ? `compressor input follows the fixed source map; the saved ${number(energy.compressorKw)} kW nominal/calibration statistic does not replace that map` : `compressor ${number(energy.compressorKw)} kW`}, auxiliary capacity ${number(energy.auxiliaryKw)} kW; ${words(energy.basis ?? 'estimated')}.`);
  if (finite(energy.recoveryMultiplier)) basis('Recovery diagnostic calibration', `${number(energy.recoveryMultiplier)} ×`, `This retained multiplier compares recovery electricity with the cycle’s predicted non-AUX recovery energy; the current planner uses the source performance map and does not apply this multiplier. ${energy.recoveryCalibrationEpisodes ?? 0} attributable completed episodes support this estimate${energy.recoveryCalibrationBasis ? `; ${words(energy.recoveryCalibrationBasis)}` : ''}. It is a reporting diagnostic, not another building heat-response coefficient or a measured COP.`);
  if (finite(energy.auxiliaryRiskScale)) basis('Auxiliary exposure calibration', `${number(energy.auxiliaryRiskScale)} ×`, `The separate auxiliary exposure scale is adjusted from observed output and routing against predicted space-heating AUX energy. ${energy.auxiliaryCalibrationEpisodes ?? 0} qualifying episodes; nominal heater power remains an estimate. This changes predicted risk and cost, not the shared response per thermal kWh.`);
  if (finite(energy.relativeUncertainty)) basis('Electricity uncertainty allowance', `${number(energy.relativeUncertainty * 100, 0)}%`, `Electricity uncertainty allowance: ${number(energy.relativeUncertainty * 100, 0)}%. This supports reported cost allowances; automatic economic admission uses the separate paired physical stress checks. It is not meter accuracy or a statistical confidence interval.`);
  const policy = context.settings ?? {};
  const strategy = HEATING_STRATEGIES.find(option => option.id === policy.savingsStrategy);
  if (strategy) {
    basis('Savings strategy', strategy.label, `${strategy.description} The strategy changes economic thresholds and the preference among qualified plans; it never widens average-temperature limits, enables an unsupported action or grants equipment authority. It carries no annual savings guarantee. Edit the saved configuration, then Apply reviewed configuration; use Away & pause for a temporary change.`);
    basis('Worthwhile cycle threshold', `${number(strategy.minimumHomeBenefitCents, 0)} ct before comfort and duration allowances`, `The current strategy requires conservative benefit above ${number(strategy.minimumHomeBenefitCents, 0)} cents to start, plus ${number(strategy.homeDiscomfortCentsPerDegreeSquaredHour, 1)} cents per weighted hot/cold °C²-hour, 2 cents per extra active hour and a 2-cent start allowance. These allowances guide selection; they are not electricity charges. Ongoing-cycle checks omit the already committed starting hurdle. Among qualified plans, the mildest retaining at least ${number(strategy.retainedBenefitFraction * 100, 0)}% of the best conservative benefit is preferred.`);
    basis('Shared economic stress checks', 'Same scenarios for action and reference', 'Selection, dispatch and continuation compare paired physical scenarios: heat response ±15%, heat loss ±15%, initial reserve/slab ±0.5 °C, compressor duty ±0.08, source electricity within its operating-point allowance and AUX exposure ±50%. A residual 5-cent uncertainty floor remains. These are engineering stress cases, not probability bounds or measured savings. The bounded search examines a nominal shortlist independently of savings strategy; no exhaustive optimum is claimed.');
  }
  if (Object.keys(policy).length) {
    basis('Preheat and comfort policy', finite(policy.preheatRoomBoostC) ? `ROOM +${number(policy.preheatRoomBoostC, 1)} °C` : 'Configured control limits', `Preheating increases the saved normal ROOM setting${finite(policy.preheatRoomBoostC) ? ` by ${number(policy.preheatRoomBoostC, 1)} °C` : ''}, limited by verified native bounds. Repeated commands use the same baseline rather than stacking increases. ROOM is a heat-pump demand setting, not a room-air target. Configured floor outputs form one pooled override. Normal hot-water recirculation keeps its own schedule during preheat. Occupied-average limits${finite(policy.comfort?.maxDropC) && finite(policy.comfort?.maxRiseC) ? ` are ${number(policy.comfort.maxDropC, 1)} °C below and ${number(policy.comfort.maxRiseC, 1)} °C above the normal average reference` : ' remain hard constraints'} with every savings strategy. Individual rooms have no separate veto; their fixed configured weights determine their influence. Automatic forecasts assume supply rises 3 °C per degree of ROOM increase; that fixed planning prior is not a learned heating curve or an H66 forecast.`);
    const holdMinutes = learning.parameters?.recoveryHoldMinutes;
    basis('Recovery hold', finite(holdMinutes) ? `${number(holdMinutes, 0)} min shared deadline` : 'Duration unavailable', `After tariff reduction ends, ${finite(holdMinutes) ? `one ${number(holdMinutes, 0)}-minute hold` : 'a configured timed hold'} keeps the reduced DHW settings, suppresses automatic recirculation and applies the AUX restriction when enabled. The compressor can recover space heating. An indoor-average safeguard releases AUX permission early without restarting recirculation or restoring DHW settings. At the fixed deadline, normal settings and scheduled recirculation eligibility resume even if thermal recovery assessment continues. The hold is a configured engineering choice, not a learned recovery time.`);
  }
  if (finite(p.hydronicCPerKwh)) record('Heating treatment evidence', 'Combined hydronic model', 'Source/rating or floor-assumption changes clear thermal and action validation. An automatic cycle retains its original treatment identity through reduction and recovery even after the override closes. Current valve mode is recorded separately; ROOM-only evidence cannot qualify newly opened circuits. Retained episodes preserve causal thermal warmup, and unsupported initial storage cannot establish fit acceptance.');
  if (finite(p.hydronicCPerKwh)) {
    record('Forward uncertainty', 'Conditional errors + engineering allowances', 'Conditional temperature validation supplies observed heating input. Forward forecasts additionally carry engineering allowances for source estimates, unvalidated actions, missing solar, fireplace response and optional floor storage, plus paired economic stress cases. Learning trials additionally test full compressor and permitted rated AUX heat during preheat, followed by native demand until the delayed room peak is covered; insufficient coverage or excessive average warmth blocks the trial. The calculated equipment-duty error is disclosed separately; these bounds are not calibrated probabilities. Frozen forecasts saved before cycles require their own later-outcome validation.');
    record('Domestic hot-water boundary', 'Zero modeled room-heat contribution', 'The space-heating model assumes zero room heating from the hot-water tank, hot-water use and recirculation losses. Recorded DHW routing excludes that compressor and AUX heat from the house thermal input. This is a simplifying assumption, not a measurement of physical losses. Tank demand, delivered service and tank recovery are not matched in the counterfactual, so assessed space-heating benefit does not establish whole-house savings.');
  }
  if (model.floor) basis('Floor storage assumptions', model.floor.enabled ? 'Configured physical priors' : 'Floor model disabled', 'Selected-slab capacity, heat allocation, release timing and ground exchange are fixed configured priors, not measured or automatically identified values. The same concrete exists before and after the override: opening valves changes heat allocation, not material capacity. Permanently open circuits remain available in both modes. Slab state is retained when valves close; thermal kWh stored are not electricity saved. Enabling the physical model does not commission the valve hardware or establish storage-response validation. Automatic floor preheating also requires available, commissioned controls. See the physical assumption rows for configured values.');
  if (context.preheatValves) {
    const valves = context.preheatValves;
    const duration = finite(valves.leaseSeconds) ? valves.leaseSeconds / 60 : 15;
    const renewal = finite(valves.renewSeconds) ? valves.renewSeconds / 60 : 5;
    basis('Valve override lease', valves.enabled === false ? 'Disabled in configuration'
      : valves.active === true ? 'All outputs confirmed active' : valves.restorationPending ? 'Release pending'
        : valves.available === true ? 'Ready · no active override' : 'Device confirmation required', `Preheat valve outputs use device-local timed ON commands: normally a ${number(duration, Number.isInteger(duration) ? 0 : 1)}-minute expiry renewed every ${number(renewal, Number.isInteger(renewal) ? 0 : 1)} minutes, capped at the planned preheat end. The application renews only while preheating remains authorized. A missed renewal lets the local timer turn the valve override off even during a controller or network outage. This device-local expiry releases only the valve overrides; H66 ROOM has no device-side lease and relies on durable application restoration and retries. OFF restores normal thermostat authority where commissioned wiring provides that behavior; it does not remove stored slab heat. Commissioning, device feedback and local timer behavior must be established before control is enabled.`);
  }
  const coefficientStates = Object.entries(coefficientInfo).filter(([key]) => Object.hasOwn(p, key))
    .map(([key, info]) => coefficientState(model, key, info));
  if (coefficientStates.length) {
    const count = (...states) => coefficientStates.filter(state => states.includes(state)).length;
    basis('Coefficient evidence', `${count('fitted')} fitted · ${count('retained')} retained`, `Thermal coefficients: ${count('fitted')} fitted in current model; ${count('retained')} retained from an earlier validated fit; ${count('fixed')} fixed assumptions; ${count('initial', 'unvalidated')} estimates without independent validation${count('unavailable') ? `; ${count('unavailable')} unavailable` : ''}. Source and optional slab assumptions are additional fixed quantities listed separately from this coefficient count. A fitted value alone does not establish overall model readiness.`);
  }
  for (const [phase, estimate] of Object.entries(model.equipmentResponse?.phases ?? {})) {
    if (finite(estimate.ratio)) basis(`${words(phase)} duty response`, `${number(estimate.ratio)} × normal demand`, `Episode-weighted compressor-duty response from ${estimate.trainingEpisodes ?? 0} training episodes. It starts near unchanged native demand and can change with informative observations. Ratios apply only to the supported hydraulic treatment; requested modes and a good thermal fit cannot independently validate equipment timing.`);
  }
  const actionChecks = model.equipmentResponse?.validation?.phases;
  if (actionChecks) for (const [phase, result] of Object.entries(actionChecks)) {
    record(`${words(phase)} equipment response`, result.accepted ? 'Validated' : 'Awaiting evidence', `${words(phase)} equipment-response check: ${result.accepted ? result.fitStatus === 'retained-unchanged' ? 'retained earlier validation' : 'passed' : 'not established'} over ${result.episodes ?? 0} held-out completed episodes${finite(result.maeDuty) ? `; error in mean episode compressor duty ${number(result.maeDuty * 100, 1)} percentage points` : ''}${result.accepted && finite(result.maxDurationHours) ? `; supported phase duration up to ${number(result.maxDurationHours, 1)} hours` : ''}. This check uses recorded indoor and outdoor temperatures and requested control context; it does not check a forecast made before the cycle.`);
  }
  const advance = model.forecastValidation;
  if (advance) record('Forecast saved before the cycle', advance.accepted ? 'Validated' : 'Awaiting evidence', `Frozen advance forecast: ${advance.accepted ? 'passed' : 'not established'} over ${advance.episodes ?? 0} completed episodes${finite(advance.temperatureMaeC) ? `; temperature error ${number(advance.temperatureMaeC)} °C` : ''}${finite(advance.energyRelativeError) ? `; energy error ${number(advance.energyRelativeError * 100, 1)}%` : ''}${finite(advance.costRelativeError) ? `; space-heating cost error ${number(advance.costRelativeError * 100, 1)}%` : ''}${advance.accepted && finite(advance.maxReductionHours) ? `; supported reduction duration up to ${number(advance.maxReductionHours, 1)} hours` : ''}. This compares the forecast saved before an action with its later outcome. Electricity can still use source-map and nominal AUX estimates unless the episode was metered; this is not measured savings.`);
  const readiness = learning.readiness;
  if (readiness) {
    record('Action readiness', readiness.actionValidated ? 'Validation requirements met' : 'Awaiting episode evidence', `Temperature prediction: ${readiness.thermalValidated ? 'validated with observed heat input' : 'awaiting validation'}.${typeof readiness.responseValidated === 'boolean' ? ` Equipment response: ${readiness.responseValidated ? 'validated on later episodes' : 'awaiting independent episode evidence'}.` : ''}${typeof readiness.advanceValidated === 'boolean' ? ` Frozen advance forecast: ${readiness.advanceValidated ? 'validated against later outcomes' : 'awaiting independent outcome evidence'}.` : ''} Action prediction: ${readiness.actionValidated ? 'validation requirements met within demonstrated durations' : 'awaiting independent episode evidence'}. Learning trial: ${readiness.trialReady ? 'basic evidence and budget requirements met' : 'not ready'}. Current comfort, authority, price and duration checks still determine whether an action can run.`);
    if (readiness.reasons?.length) record('Readiness conditions', 'Current assessment', `Readiness: ${readiness.reasons.map(words).join('; ')}.`);
  }
  const outcomes = learning.outcomes;
  if (outcomes) record('Attempted cycles', `${outcomes.completed ?? 0} completed / ${outcomes.attempted ?? 0} attempted`, `Recent attempted cycles (latest 100): ${outcomes.attempted ?? 0}; completed ${outcomes.completed ?? 0}, incomplete ${outcomes.incomplete ?? 0}${finite(outcomes.aborted) ? `, aborted ${outcomes.aborted}` : ''}, in progress ${outcomes.inProgress ?? 0}. ${outcomes.assessed ?? 0} have a comparable space-heating assessment.${finite(outcomes.observedCostCents) ? ` Covered cycle electricity cost estimate: €${number(outcomes.observedCostCents / 100)}; source-map or nominal-power estimates are used unless metered.` : ''}${finite(outcomes.missingHours) && outcomes.missingHours > 0 ? ` ${number(outcomes.missingHours, 1)} hours without cost coverage are excluded.` : ''} Completed-subset benefits exclude unfinished attempts; hot-water service changes prevent a whole-cycle savings claim.`);
  const configured = learning.parameters;
  if (finite(learning.controlHold?.until)) record('Automatic cycle hold', 'Waiting after an incomplete attempt', `Automatic cycles wait until ${new Date(learning.controlHold.until).toLocaleString('en-GB', { dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Helsinki' })} Finnish time after an incomplete attempt (${words(learning.controlHold.reason)}). Recording and passive learning continue.`);
  if (configured) basis('Native-control assumptions', 'From configuration', `Configured native-control assumptions: auxiliary integral A2 ${number(configured.auxIntegralA2, 0)} °min (${configured.a2Basis === 'offset' ? 'relative to A1' : 'absolute'}); auxiliary hysteresis ${number(configured.auxHysteresisC, 0)} °C. Compressor A1 ${finite(configured.compressorIntegralA1) ? `${number(configured.compressorIntegralA1, 0)} °min` : 'unknown'}; compressor hysteresis ${finite(configured.compressorHysteresisC) ? `${number(configured.compressorHysteresisC, 0)} °C` : 'unknown'}. These come from configuration; the current integral reading does not expose those settings.`);
  const metrics = metricDefinitions.map(([key, title, unit, explanation]) => {
    const metric = learning.metrics?.[key] ?? {};
    const value = key === 'indoorTemperature' ? metric.value ?? adaptive.baselineC : metric.value;
    const available = finite(value) && (key === 'indoorTemperature' || metric.count > 0);
    const reference = adaptive.comfortReference;
    const referenceState = adaptive.comfortLearning;
    const referenceSupport = key === 'indoorTemperature' ? [
      reference?.provisional ? 'Provisional reference: fewer than 24 hours supported by verified heating. Occupied reduction is limited to the smaller of the configured drop and 0.5 °C.' : '',
      finite(reference?.evidenceHours ?? referenceState?.evidenceHours) ? `${number(reference?.evidenceHours ?? referenceState.evidenceHours, 1)} supported hours.` : '',
      reference?.updatedAt ? `Latest supporting evidence: ${new Date(reference.updatedAt).toLocaleString('en-GB', { timeZone: 'Europe/Helsinki' })} Finnish time.` : '',
      referenceState?.status && referenceState.status !== 'learning' ? `Learning paused: ${words(referenceState.reason ?? referenceState.status)}.` : '',
    ].filter(Boolean).join(' ') : '';
    const basis = key !== 'indoorTemperature'
      ? learning.reconstruction === 'snapshot' && !learning.metrics
        ? 'Completed-cycle assessments are unavailable in this snapshot.'
        : `${metric.count ?? 0} assessed ${metric.count === 1 ? 'cycle' : 'cycles'} among the latest 30 completed cycles. Space heating only; electricity is estimated unless metered.`
      : !available ? learning.reconstruction === 'snapshot' ? 'No normal-temperature reference is available in this snapshot.'
        : 'Waiting for one supported hour of occupied Normal heating.'
        : reference?.confidence === 'provisional-heating-demand-baseline'
          ? 'Provisional reference: supported by sustained cool weather; heating activity was not verified.'
          : reference?.confidence === 'observed-heating-baseline'
            ? 'Reference supported by occupied Normal observations and verified space-heating activity.'
            : metric.basis || 'Retained reference; its original heating evidence is unavailable here.';
    const provenance = key !== 'indoorTemperature'
      ? finite(metric.count) ? `${metric.count} assessed ${metric.count === 1 ? 'cycle' : 'cycles'} · latest 30 completed` : 'Assessment count unavailable'
      : !available ? 'Awaiting supported Normal observations'
        : reference?.confidence === 'provisional-heating-demand-baseline' ? 'Provisional · heating activity unverified'
          : reference?.confidence === 'observed-heating-baseline' ? `${reference.provisional ? 'Provisional' : 'Learned'} · heating activity verified` : 'Retained reference · original evidence unavailable';
    return { key, title, available, provenance, value: available ? `${number(value, key === 'indoorTemperature' ? 1 : 2)} ${unit}` : 'Not available yet',
      group: key === 'indoorTemperature' ? 'Comfort reference' : 'Completed cycles',
      detail: explanation, calculation: outcomeCalculation(key), evidence: `${basis}${referenceSupport ? ` ${referenceSupport}` : ''}${available && finite(metric.uncertainty) ? ` · Model cost uncertainty allowance about ±${number(metric.uncertainty)} €/cycle; not a statistical confidence interval.` : ''}` };
  });
  const episode = learning.episode;
  if (episode) record('Current cycle', words(episode.phase ?? episode.status ?? 'in progress'), `Current cycle: ${words(episode.phase ?? episode.status ?? 'in progress')}. Space-heating benefit is assessed only after recovery is complete; an unfinished cycle does not enter the averages.`);
  // Keep evidence and policy separate in the UI; the text collections also
  // support summaries without changing the provenance of individual rows.
  const policyGroups = {
    'Savings strategy': 'Economic decisions', 'Worthwhile cycle threshold': 'Economic decisions',
    'Shared economic stress checks': 'Economic decisions',
    'Preheat and comfort policy': 'Comfort & control', 'Recovery hold': 'Comfort & control',
    'Forward uncertainty': 'Comfort & control', 'Valve override lease': 'Comfort & control',
    'Native-control assumptions': 'Comfort & control', 'Domestic hot-water boundary': 'Scope of savings',
  };
  const policyRows = [...coefficientEvidenceRows, ...evidenceRows]
    .filter(row => policyGroups[row.key]).map(row => ({ ...row, group: policyGroups[row.key] }));
  const evidenceGroup = key => ['Action readiness', 'Readiness conditions', 'Temperature prediction',
    'Fireplace validation', 'Forecast saved before the cycle'].includes(key) || key.endsWith(' equipment response')
    ? 'Prediction checks' : ['Attempted cycles', 'Current cycle', 'Automatic cycle hold'].includes(key)
      ? 'Cycle coverage' : 'Learning evidence';
  const visibleEvidenceRows = evidenceRows.filter(row => !policyGroups[row.key]).map(row => ({ ...row,
    group: evidenceGroup(row.key), calculation: validationCalculation(row.key) }));
  const visibleCoefficientRows = coefficientEvidenceRows.filter(row => !policyGroups[row.key] && row.key !== 'Heat loss in context')
    .map(row => ({ ...row, group: row.key.endsWith(' duty response') ? 'Equipment response'
      : ['Electricity assumptions', 'Recovery diagnostic calibration', 'Auxiliary exposure calibration', 'Electricity uncertainty allowance'].includes(row.key)
        ? 'Energy estimates' : 'Model structure', calculation: row.key.endsWith(' duty response') ? dutyCalculation() : calibrationCalculation(row.key) }));
  if (finite(p.hydronicCPerKwh)) visibleCoefficientRows.unshift({ key: 'heat-balance', title: 'How the heat balance works',
    value: model.floor?.enabled ? 'Room + reserve + selected slab' : 'Room + slow reserve', group: 'Model structure',
    detail: 'Heat loss cools the room; solar and fireplace inputs warm it directly. Hydronic heat first enters storage, then reaches the room through temperature-driven exchange.',
    calculation: heatBalanceCalculation(model) });
  if (finite(p.hydronicCPerKwh)) visibleCoefficientRows.push({ key: 'model-fitting', title: 'How parameters are fitted',
    value: 'Independent evidence + later checks', group: 'Model structure',
    detail: 'Only responses that the available inputs can distinguish are eligible for fitting. A bounded search tests candidate values; separate later temperature trajectories decide whether to keep the update.',
    calculation: fittingCalculation() });
  groupRows(visibleCoefficientRows, ['Model structure', 'Equipment response', 'Energy estimates']);
  groupRows(visibleEvidenceRows, ['Prediction checks', 'Cycle coverage', 'Learning evidence']);
  groupRows(policyRows, ['Economic decisions', 'Comfort & control', 'Scope of savings']);
  const economics = policyRows.find(row => row.key === 'Worthwhile cycle threshold');
  if (economics) {
    economics.detail = 'A new cycle must cover the starting hurdle, additional discomfort and extra active time under the shared stress checks. Qualified plans are compared by benefit and comfort; ongoing cycles omit the start hurdle.';
    economics.calculation = economicCalculation(strategy?.id);
  }
  const policySummaries = {
    'Preheat and comfort policy': 'Preheat raises ROOM above its saved normal setting and, when available, enables the pooled valve override. It keeps normal recirculation scheduling. Occupied-average limits remain hard constraints.',
    'Recovery hold': 'A single timed hold keeps reduced DHW settings and suppresses automatic recirculation after tariff reduction. The AUX restriction, when enabled, can end early for cold-average protection without changing the hot-water deadline.',
    'Domestic hot-water boundary': 'Hot-water heat is assigned no contribution to room warming. Hot-water service and its recovery remain outside the space-heating benefit comparison.',
    'Forward uncertainty': 'Future actions add uncertainty beyond a temperature check supplied with observed heating. Source estimates, equipment behavior and stored heat each contribute allowances; learning trials also test a high-heat case.',
    'Valve override lease': 'Device-local timed commands let the valve override expire if renewals stop. The application renews only while preheating remains authorized; restoring the H66 ROOM setting separately requires the application.',
    'Shared economic stress checks': 'The action and reference use the same two physical stress directions. Conservative benefit must clear the economic hurdle; these engineering allowances are not statistical confidence bounds.',
  };
  for (const row of policyRows) if (policySummaries[row.key]) {
    const math = row.key === 'Preheat and comfort policy' ? preheatCalculation()
      : row.key === 'Recovery hold' ? recoveryHoldCalculation()
        : row.key === 'Domestic hot-water boundary' ? hotWaterCalculation() : validationCalculation(row.key);
    const dedicated = ['Preheat and comfort policy', 'Recovery hold', 'Domestic hot-water boundary'].includes(row.key);
    row.calculation = math ? { ...math, paragraphs: dedicated ? [...math.paragraphs] : [...math.paragraphs, row.detail] }
      : { summary: 'Assumptions & limits', equations: [], paragraphs: [row.detail] };
    if (row.key === 'Preheat and comfort policy' && finite(policy.comfort?.maxDropC) && finite(policy.comfort?.maxRiseC))
      row.calculation.paragraphs.push(`Current occupied-average limits: ${number(policy.comfort.maxDropC, 1)} °C below and ${number(policy.comfort.maxRiseC, 1)} °C above the normal average reference.`);
    row.detail = policySummaries[row.key];
  }
  return { title, message: learning.message ?? learning.reason ?? (readiness?.thermalValidated === true
    ? 'Temperature prediction has passed later checks with observed heat input. Action prediction and economic readiness are assessed separately.'
    : validation?.accepted ? 'An accepted parameter update is in use. Identified heat loss and heating response are both required for temperature readiness; action evidence is checked separately.'
      : model.trainedAt ? 'Coefficients are retained as an unvalidated fallback after contradictory current evidence.'
        : 'Initial estimates remain in use while independent evidence is collected.'),
    process, metrics, evidence, evidenceRows: visibleEvidenceRows, coefficientEvidenceRows: visibleCoefficientRows, policyRows, inputs: modelInputDescriptions(), coefficients: modelCoefficientDescriptions(learning), coefficientEvidence,
    coefficientHistory: 'These are current values from the latest retained model. Select Model coefficients on the chart to see the four coefficients eligible for fitting, reconstructed from the learning journal and applicable firewood and sensor-change history. The chart preserves initial, fitted and retained estimates; today’s values are not applied to earlier intervals. Corrections can change retrospective reconstruction. Fixed building and source assumptions are shown here only. Reconstruction stays in memory and creates no additional stored history.',
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

export const h66ReadingGroups = [
  { label: 'Heating', readings: [
    ['0002', { label: 'Supply temperature', unit: '°C', description: 'Water leaving the heat pump for home heating.' }],
    ['0001', { label: 'Return temperature', unit: '°C', description: 'Water returning from the home heating circuit.' }],
    ['0107', { label: 'Supply temperature target', unit: '°C', description: 'Flow temperature the heat pump is aiming for.' }],
    ['0007', { label: 'Outdoor temperature', unit: '°C', description: 'Temperature at the heat pump’s outdoor sensor.' }],
    ['8105', { label: 'Heating integral', unit: '°min', description: 'Accumulated difference between actual and target supply temperature.' }],
    ['1A06', { label: 'Heating pump', unit: '', description: 'Whether the heating circulation pump is running.' }],
    ['3109', { label: 'Heating pump speed', unit: '%', description: 'Reported speed of the heating circulation pump.' }],
    ['3104', { label: 'Auxiliary output', unit: '%', description: 'Reported backup heater output, as a share of rated capacity.' }],
  ] },
  { label: 'Ground loop', readings: [
    ['0005', { label: 'Brine in', unit: '°C', description: 'Ground-loop fluid entering the heat pump from the ground.' }],
    ['0006', { label: 'Brine out', unit: '°C', description: 'Ground-loop fluid leaving the heat pump for the ground.' }],
    ['3110', { label: 'Brine pump speed', unit: '%', description: 'Reported speed of the ground-loop circulation pump.' }],
  ] },
  { label: 'Hot water', readings: [
    ['0009', { label: 'Hot water temperature', unit: '°C', description: 'Temperature measured in the hot-water tank.' }],
    ['0212', { label: 'Hot water start', unit: '°C', min: 30, max: 60, description: 'Tank temperature setting for starting hot-water heating.' }],
    ['0208', { label: 'Hot water stop', unit: '°C', min: 30, max: 65, description: 'Reported stop setting; compressor cutoff may differ.' }],
    ['1A07', { label: 'Heating destination', unit: '', description: 'Whether heat is routed to the home or the hot-water tank.' }],
  ] },
  { label: 'Equipment states', readings: [
    ['2201', { label: 'Operating mode', unit: '', description: 'Operating mode currently reported by the heat pump.' }],
    ['1A01', { label: 'Compressor', unit: '', description: 'Whether the compressor is running; backup heating is separate.' }],
    ['1A20', { label: 'Pump alarm', unit: '', description: 'Whether the heat pump reports an active alarm.' }],
    ['2A91', { label: 'Alarm code', unit: '', description: 'Reported fault code; see the heat pump’s alarm guide.' }],
  ] },
  { label: 'Settings', readings: [
    ['0203', { label: 'Room setting', unit: '°C', min: 10, max: 30, description: 'Heating reference setting, not a measured room temperature.' }],
    ['0205', { label: 'Heating curve', unit: '°C', description: 'Curve setting used to determine the heating supply target.' }],
    ['2204', { label: 'Room influence', unit: 'factor', description: 'How strongly room temperature affects the heating target.' }],
    ['0206', { label: 'Maximum supply setting', unit: '°C', description: 'Configured upper limit for the heating supply temperature.' }],
    ['0211', { label: 'Heat-stop setting', unit: '°C', description: 'Outdoor temperature setting for stopping space heating.' }],
    ['0233', { label: 'Tariff reduction setting', unit: '°C', description: 'Configured reduction amount; does not confirm tariff control is active.' }],
  ] },
  { label: 'Runtime counters', readings: [
    ['6C60', { label: 'Compressor runtime', unit: 'h', description: 'Accumulated compressor hours reported by the heat pump.' }],
    ['6C63', { label: 'Auxiliary 3 kW runtime', unit: 'h', description: 'Accumulated hours for the 3 kW backup heater stage.' }],
    ['6C66', { label: 'Auxiliary 6 kW runtime', unit: 'h', description: 'Accumulated hours for the 6 kW backup heater stage.' }],
    ['6C64', { label: 'Hot-water runtime', unit: 'h', description: 'Accumulated hot-water heating hours reported by the heat pump.' }],
  ] },
];
export const h66Registers = Object.fromEntries(h66ReadingGroups.flatMap(group => group.readings));

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
    { key: 'dhw', title: 'DHW start / stop settings', available: rangeAvailable,
      value: rangeAvailable ? `${number(start.value, Number.isInteger(start.value) ? 0 : 1)}–${number(stop.value, Number.isInteger(stop.value) ? 0 : 1)} °C`
        : `Unavailable · ${rangeReasons.join('; ')}`, detail: rangeAvailable
          ? `Current H66 start–stop temperature settings for domestic hot water. The stop setting may govern AUX operation only; it is not an established compressor cutoff. ${describe(start).detail} ${describe(stop).detail}`
          : rangeReasons.join('. ') }];
  const actual = status.observations?.actual;
  const knownMode = ['normal', 'reduction'].includes(actual?.mode);
  const confirmed = knownMode && actual.verified === true && actual.stale !== true;
  const requestedMode = actual?.requestedPhase === 'reduction' ? 'reduction'
    : ['normal', 'preheat', 'recovery'].includes(actual?.requestedPhase) ? 'normal'
      : actual?.source === 'mqtt-request' && actual?.stale !== true && knownMode ? actual.mode : null;
  rows.push({ key: 'tariff', title: 'Tariff control', available: confirmed,
    summaryValue: confirmed ? actual.mode === 'reduction' ? 'Reduced' : 'Normal'
      : requestedMode ? requestedMode === 'reduction' ? 'Reduce requested' : 'Normal requested' : 'Unknown',
    summaryNote: confirmed ? status.input === 'simulated' ? 'Simulated' : 'Device confirmed'
      : requestedMode ? 'Not confirmed' : 'No device readback',
    value: confirmed ? `${actual.mode === 'reduction' ? 'Reduction' : 'Normal heating'}${status.input === 'simulated' ? ' · simulated' : ' · confirmed'}`
      : requestedMode ? `${requestedMode === 'reduction' ? 'Reduction' : 'Normal heating'} requested · unverified` : 'Unknown · no device readback',
    detail: 'The tariff relay is verified from its own device report after a request. H66 ROOM is a heat-pump demand setting and its tariff reduction setting is a temperature offset; they do not need to be equal and do not report the relay state.' });
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
  if (register === '1A01' || register === '1A06') return reading.value === 1 ? 'On' : reading.value === 0 ? 'Off' : 'Unknown';
  if (register === '1A20') return reading.value === 1 ? 'Alarm active' : reading.value === 0 ? 'No active alarm' : 'Unknown';
  if (register === '1A07') return reading.value === 1 ? 'Domestic hot water' : reading.value === 0 ? 'Space heating' : 'Unknown';
  const unit = h66Registers[register]?.unit ?? (reading.unit === 'degC' ? '°C' : reading.unit ?? '');
  return `${number(reading.value, Number.isInteger(reading.value) ? 0 : 1)} ${unit}`.trim();
}

export function h66Control(h66, register) {
  const control = h66?.controls?.[register];
  const available = h66?.connected === true && (control === true || control?.available === true);
  return { ...h66Registers[register], ...(typeof control === 'object' ? control : {}), available,
    reason: control?.reason ?? h66?.reason ?? (available ? '' : 'Waiting for a fresh, writable H66 control.') };
}
