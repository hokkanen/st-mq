import { CONTROL_DEFAULTS } from '../app/config.js';
import { HEATING_STRATEGIES, heatingEconomics, DEFAULT_HEATING_STRATEGY } from '../domain/heating-strategy.js';
import { initialAdaptiveModel, equipmentResponseEstimate } from './adaptive-learning.js';
import { homePlanningState } from '../domain/home-model.js';
import { chooseCycle, evaluateCycle, economicAdmission, forecastIntervals, learningReadiness,
  phaseAt, validatedReductionHours, cycleForecastCovered, indoorUncertaintyAt, preheatRoomRequest } from './planner.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const LIMITS = Object.freeze({
  maxReductionHours: { label: 'Maximum reduction', min: .25, max: 46, step: .25, unit: 'h' },
  maxAwayReductionHours: { label: 'Maximum reduction while away', min: .25, max: 46, step: .25, unit: 'h' },
  maxUnobservedReductionHours: { label: 'Reduction limit without pump telemetry', min: .25, max: 46, step: .25, unit: 'h' },
  maxDropC: { label: 'Allowed average temperature drop', min: 0, max: 35, step: .25, unit: '°C' },
  maxRiseC: { label: 'Allowed average temperature rise', min: .25, max: 35, step: .25, unit: '°C' },
  maxPreheatHours: { label: 'Maximum preheat', min: .25, max: 24, step: .25, unit: 'h' },
  preheatRoomBoostC: { label: 'ROOM setting increase', min: 1, max: 5, step: 1, unit: '°C', integer: true },
  maxTrialCostCents: { label: 'One-cycle experiment budget', min: 0, max: 1_000_000_000, step: 1, unit: 'cents' },
  minimumHomeBenefitCents: { label: 'Minimum estimated saving', min: -1_000_000_000, max: 1_000_000_000, step: 1, unit: 'cents' },
  homeDiscomfortCentsPerDegreeSquaredHour:{label:'Temperature deviation penalty',min:0,max:1_000_000_000,step:1,unit:'c/°C²h'},
  cycleStartCostCents:{label:'Cycle start penalty',min:0,max:1_000_000_000,step:1,unit:'cents'},
  cycleHourCostCents:{label:'Preheat/reduction duration penalty',min:0,max:1_000_000_000,step:1,unit:'c/h'},
  economicUncertaintyFloorCents:{label:'Minimum savings uncertainty deduction',min:0,max:1_000_000_000,step:1,unit:'cents'},
  learningPriorityPriceCents:{label:'Learning priority price threshold',min:0,max:1_000_000_000,step:1,unit:'c/kWh'},
});
const CONTROL_DETAILS = Object.freeze({
  savingsStrategy:{help:'Chooses how much of the best eligible conservative saving to retain: Gentle 60%, Balanced 80%, More savings 100%. Among qualifying cycles, the planner prefers the lowest temperature deviation penalty, then the shortest combined preheat and reduction. With a zero temperature penalty, duration decides. Monetary settings and temperature limits are independent of this choice. The percentages are relative to the best eligible cycle, not a promised reduction in your heating bill.'},
  maxReductionHours:{help:'The longest reduction the planner may choose while the home is occupied, in hours. It may choose a shorter reduction or none. The normal-temperature limits and forecast coverage still apply; this is a ceiling, not a requested duration.'},
  maxAwayReductionHours:{help:'The longest reduction the planner may choose while the home is away, in hours. Native frost protection remains active. The declared return time and recovery are included when assessing the return to occupied comfort.'},
  maxDropC:{help:'The largest permitted drop of the weighted indoor average below its normal reference, in °C. For example, a 21 °C reference and 1.5 °C drop give a 19.5 °C lower boundary. Prediction and sensor-estimate uncertainty are included. Zero permits no predicted drop below the reference.'},
  maxRiseC:{help:'The largest permitted rise of the weighted indoor average above its normal reference, in °C. For example, a 21 °C reference and 1.5 °C rise give a 22.5 °C upper boundary. The planner also checks delayed warming after preheat and includes uncertainty.'},
  maxPreheatHours:{help:'The longest preheat before a reduction, in hours. Preheat stores warmth ahead of expensive electricity. The planner chooses whether and how long to preheat while checking the temperature rise, recovery and complete-cycle cost.'},
  preheatRoomBoostC:{help:'The maximum increase of the heat pump’s native ROOM setting during preheat. This setting shifts the heating curve; it does not request the same increase in indoor temperature. The model assumes roughly 3 °C more heating-water temperature per 1 °C ROOM increase. Native limits may require a smaller increase; the separate allowed indoor rise still applies.'},
  maxUnobservedReductionHours:{advanced:true,help:'An additional reduction ceiling when current native heat-pump telemetry is unavailable. For example, 0.5 h means at most 30 minutes; a shorter ordinary reduction limit still applies. With native telemetry available, only the ordinary reduction ceiling applies. This is separate from model training or startup. Actual command capability and restoration remain required.'},
  maxTrialCostCents:{advanced:true,help:'The estimated cost-exposure budget for one manually reviewed learning cycle, in cents: 150 cents is €1.50. It covers modeled extra cost and a better saving opportunity the experiment might displace. Leaving this value unchanged retains the automatic per-cycle limit and remaining daily allowance. Changing it supplies a separate reviewed one-cycle allowance; it does not enable trials. Zero permits only trials with no modeled extra cost or displaced saving. It is an estimate, not a guarantee of the final bill.'},
  minimumHomeBenefitCents:{advanced:true,help:'The minimum conservative estimated saving required to start a cycle, in cents, before adding the other penalties. Zero requires a positive saving after those penalties. A negative value explicitly permits estimated extra cost. Full preheat, reduction, recovery and remaining heat debt are included in the electricity-cost comparison.'},
  homeDiscomfortCentsPerDegreeSquaredHour:{advanced:true,help:'An economic penalty for extra indoor-temperature deviation compared with Normal heating, within the permitted limits. Hot and cold deviations from the normal reference are squared and integrated over time, then compared with Normal heating. If Normal stays at the reference, a 1 °C deviation for 2 h gives 2 °C²h; a 2 °C deviation for 1 h gives 4 °C²h. Multiply by this rate in cents. Zero removes this penalty while keeping the temperature limits.'},
  cycleStartCostCents:{advanced:true,help:'An extra economic hurdle for starting a new cycle, in cents. For example, 10 cents requires the estimated saving to cover an extra 10 cents before starting. Zero adds no start penalty. This is a planning preference, not an electricity charge, and is not charged again when continuing the same cycle.'},
  cycleHourCostCents:{advanced:true,help:'An extra economic penalty per additional preheat and reduction hour, in cents per hour. For example, 5 c/h over 3 extra hours adds a 15-cent hurdle. Recovery hours are not counted by this penalty; recovery electricity is already included in energy cost. Zero removes this duration penalty.'},
  economicUncertaintyFloorCents:{advanced:true,help:'A minimum deduction from nominal estimated savings, in cents. The planner uses the greater of this amount and the deduction indicated by its paired physical stress cases. For example, 10 cents means deducting at least 10 cents, not adding 10 cents to an existing larger deduction. Zero adds no minimum; the stress checks still apply.'},
  learningPriorityPriceCents:{advanced:true,help:'The current all-in electricity price at or below which learning gets greater priority, in cents per kWh. At 15 c/kWh, the planner is more willing to spend its experiment budget on useful information. This is not a trial price ceiling. Budget, temperature and equipment checks still apply, and an upcoming expensive-price opportunity is protected.'},
  learningTrials: { advanced: true, help: 'Allow learning trials in this preview and any explicitly approved cycle. The initial choice follows automatic trial permission. Changing this checkbox does not change saved settings or grant a new budget. Leaving the budget unchanged retains the captured automatic allowance; changing it supplies a separate reviewed allowance for this one cycle. Equipment, temperature and evidence checks remain required.' },
});

/** Only explicit household policy and a reviewed one-cycle budget can be explored.
 * Equipment, evidence, automatic daily budgets and native protection remain independent. */
export function validateExplorerOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides)))
    throw new TypeError('Heating scenario limits must be an object');
  const result = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'savingsStrategy') {
      if (!HEATING_STRATEGIES.some(option => option.id === value)) throw new TypeError('Unknown savings strategy');
    } else if (key === 'learningTrials') {
      if (typeof value !== 'boolean') throw new TypeError('Learning trial permission must be a boolean');
    } else {
      const spec = Object.hasOwn(LIMITS, key) ? LIMITS[key] : null;
      if (!spec) throw new TypeError(`Unsupported heating scenario limit: ${key}`);
      if (!finite(value) || value < spec.min || value > spec.max || spec.integer && !Number.isInteger(value))
        throw new RangeError(`${spec.label} must be ${spec.min}–${spec.max} ${spec.unit}`);
    }
    result[key] = value;
  }
  return result;
}

/** Presence alone is not an edit, especially for a reviewed trial allowance. */
export function explorerOverrideChanges(input, overrides = {}) {
  const current = policy(input);
  return Object.fromEntries(Object.entries(validateExplorerOverrides(overrides))
    .filter(([key, value]) => value !== current[key]));
}

export function applyExplorerOverrides(input, overrides = {}) {
  const changes = explorerOverrideChanges(input, overrides), result = structuredClone(input);
  result.config = { ...CONTROL_DEFAULTS, ...result.config };
  result.settings = { ...result.settings, comfort: { ...result.settings.comfort } };
  for (const [key, value] of Object.entries(changes)) {
    if (['maxDropC', 'maxRiseC'].includes(key)) result.settings.comfort[key] = value;
    else if (key === 'savingsStrategy') result.settings.savingsStrategy = value;
    else {
      result.config[key] = value;
      if (key === 'preheatRoomBoostC') result.settings.preheatRoomBoostC = value;
      if (key === 'maxTrialCostCents') {
        result.trialBudgetRemainingCents = value;
        result.equipment = { ...result.equipment, trialBudgetRemainingCents: value };
      }
    }
  }
  if (!finite(result.trialBudgetRemainingCents)) result.trialBudgetRemainingCents = null;
  return result;
}

function policy(input) {
  const c = { ...CONTROL_DEFAULTS, ...input.config };
  return { maxReductionHours: c.maxReductionHours, maxAwayReductionHours: c.maxAwayReductionHours,
    maxPreheatHours: c.maxPreheatHours, preheatRoomBoostC: c.preheatRoomBoostC,
    maxUnobservedReductionHours: c.maxUnobservedReductionHours, maxTrialCostCents: c.maxTrialCostCents,
    learningPriorityPriceCents:c.learningPriorityPriceCents,
    learningTrials: c.learningTrials,
    ...heatingEconomics(c),
    maxDropC: input.settings.comfort.maxDropC, maxRiseC: input.settings.comfort.maxRiseC ?? 1.5,
    savingsStrategy: input.settings.savingsStrategy ?? DEFAULT_HEATING_STRATEGY };
}

function evaluationArgs(input) {
  const indoor = input.observations?.indoor, targetC = input.settings.comfort.targetC ?? input.checkpoint?.baselineC ?? indoor?.value;
  const intervals = forecastIntervals(input.prices, input.forecast, input.now);
  if (!finite(indoor?.value) || indoor.stale || !finite(indoor.observedAt) || indoor.observedAt > input.now
    || !finite(targetC) || !intervals.length) return null;
  const model = input.checkpoint?.model ?? initialAdaptiveModel(input.config);
  return { intervals, model,
    initialState: { ...homePlanningState(model,indoor.value,intervals[0].outdoorC,intervals[0].solarRadiationWm2,input.thermalState),
      integral: input.equipment?.integral }, targetC,
    occupancy: input.settings.occupancy, maxDropC: input.settings.comfort.maxDropC,
    maxRiseC: input.settings.comfort.maxRiseC ?? 1.5, savingsStrategy: input.settings.savingsStrategy,
    config: input.config, equipment: input.equipment ?? {} };
}

function trajectory(prediction, args, schedule = null) {
  if (!prediction || !args) return [];
  const at = args.intervals[0]?.start;
  return [...(finite(at) ? [{ at, indoorC: args.initialState.indoorC,
    uncertaintyC: indoorUncertaintyAt(args.equipment, 0, at), phase: phaseAt(schedule, at) }] : []),
  ...prediction.trajectory.map(row => ({ at: row.at, indoorC: row.indoorC,
    uncertaintyC: row.uncertaintyC, phase: row.phase }))];
}

function outcomes(prediction, args) {
  if (!prediction || !args) return null;
  // The captured starting temperature is part of the evaluated horizon. A
  // recovering first step must not hide the initial cold or warm extreme.
  const rows = trajectory(prediction, args);
  let coldestIndoor = null, warmestIndoor = null, maxIndoorDropC = 0, maxIndoorRiseC = 0;
  for (const row of rows) {
    const valueC = row.indoorC, referenceC = args.targetC;
    const common = { label: 'Weighted indoor average', at: row.at, valueC, referenceC };
    if (!coldestIndoor || valueC < coldestIndoor.valueC)
      coldestIndoor = { ...common, conservativeC: finite(row.uncertaintyC) ? valueC - row.uncertaintyC : null };
    if (!warmestIndoor || valueC > warmestIndoor.valueC)
      warmestIndoor = { ...common, conservativeC: finite(row.uncertaintyC) ? valueC + row.uncertaintyC : null };
    maxIndoorDropC = Math.max(maxIndoorDropC, referenceC - valueC);
    maxIndoorRiseC = Math.max(maxIndoorRiseC, valueC - referenceC);
  }
  return { costCents: prediction.costCents, electricityKwh: prediction.electricityKwh,
    auxiliaryKwh: prediction.auxiliaryKwh, recoveryCostCents: prediction.recoveryCostCents,
    recoveryEnergyKwh: prediction.recoveryEnergyKwh, recoveryAuxKwh: prediction.recoveryAuxKwh,
    terminalKwh: prediction.terminalKwh, terminalCostCents: prediction.terminalCostCents,
    recoveredAt: prediction.recoveredAt, completeRecoveryPredicted: prediction.completeRecoveryPredicted,
    minIndoorC: Math.min(args.initialState.indoorC, ...rows.map(row => row.indoorC)),
    maxIndoorC: Math.max(args.initialState.indoorC, ...rows.map(row => row.indoorC)),
    maxIndoorDropC: coldestIndoor ? maxIndoorDropC : null, maxIndoorRiseC: warmestIndoor ? maxIndoorRiseC : null,
    coldestIndoor, warmestIndoor,
    uncertaintyC: rows.length && rows.every(row => finite(row.uncertaintyC)) ? Math.max(...rows.map(row => row.uncertaintyC)) : null,
    comfortSafe: !prediction.severe, violations: prediction.violations ?? [],
    basis: prediction.basis, energyIncludesTail: false, costIncludesTail: true };
}

function summary(decision, args, baseline, { origin = 'recalculated', plan = decision?.plan } = {}) {
  const schedule = plan?.schedule ?? null;
  const prediction = args ? schedule ? evaluateCycle({ ...args, schedule }) : baseline : null;
  const phases = schedule ? [
    ...(schedule.preheatEnd > schedule.preheatStart ? [{ phase: 'preheat', start: schedule.preheatStart, end: schedule.preheatEnd, estimated: false }] : []),
    { phase: 'reduction', start: schedule.reductionStart, end: schedule.reductionEnd, estimated: false },
    { phase: 'recovery', start: schedule.reductionEnd, end: prediction?.recoveredAt ?? null, estimated: true },
  ] : [{ phase: 'normal', start: args?.intervals[0]?.start ?? null, end: args?.intervals.at(-1)?.end ?? null, estimated: false }];
  const economics = origin === 'selected' && schedule && args && baseline
    ? economicAdmission({ prediction, referencePrediction: baseline, args, schedule,
      settings: { savingsStrategy: args.savingsStrategy } }) : plan?.economics ?? null;
  return { origin, action: decision?.action ?? 'normal', phase: decision?.phase ?? 'normal',
    reasons: decision?.reasons ?? (plan ? ['currently-selected-cycle'] : ['normal-operation']),
    schedule: schedule ? structuredClone(schedule) : null, phases, trial: plan?.trial === true,
    trialExposureCents: plan?.trial === true ? plan.trialAllowanceCents ?? null : null,
    outcomes: outcomes(prediction, args),
    estimatedBenefitCents: prediction && baseline ? baseline.costCents - prediction.costCents : null,
    lowerBenefitCents: economics?.lowerBenefitCents ?? null, uncertaintyCents: economics?.uncertaintyCents ?? plan?.uncertaintyCents ?? null,
    trajectory: trajectory(prediction, args, schedule),
    evaluationStartAt: args?.intervals[0]?.start ?? null,
    evaluationEndAt: args?.intervals.at(-1)?.end ?? null,
    search: plan?.search ?? decision?.evaluation?.search ?? null,
    diagnostics: decision?.diagnostics ?? plan?.diagnostics ?? null,
    economics: economics ? structuredClone(economics) : null,
  };
}

function compare(current, alternative) {
  const left = current.outcomes, right = alternative.outcomes;
  return { additionalBenefitCents: left && right ? left.costCents - right.costCents : null,
    additionalElectricityKwh: left && right ? right.electricityKwh - left.electricityKwh : null,
    additionalIndoorDropC: finite(left?.maxIndoorDropC) && finite(right?.maxIndoorDropC) ? right.maxIndoorDropC - left.maxIndoorDropC : null,
    additionalIndoorRiseC: finite(left?.maxIndoorRiseC) && finite(right?.maxIndoorRiseC) ? right.maxIndoorRiseC - left.maxIndoorRiseC : null,
    changed: JSON.stringify(current.schedule) !== JSON.stringify(alternative.schedule),
    basis: 'Estimated space-heating difference on identical inputs, including priced remaining heat debt; hot-water service is not modeled.' };
}

function constraints(input, decision, evidence, selected) {
  const p = policy(input), away = input.settings.occupancy.mode === 'away';
  const durationKey = away ? 'maxAwayReductionHours' : 'maxReductionHours';
  const duration = selected.schedule ? (selected.schedule.reductionEnd - selected.schedule.reductionStart) / HOUR : 0;
  const d = decision.diagnostics, violations = d?.violations ?? [];
  const intervals = forecastIntervals(input.prices, input.forecast, input.now);
  const forecastCovered = intervals.length > 0 && intervals.at(-1).end - input.now >= 4 * HOUR;
  const result = [
    { key: durationKey, label: 'Configured reduction ceiling', kind: 'policy', value: p[durationKey], unit: 'h',
      status: duration >= p[durationKey] ? 'reached' : d ? 'available' : 'unknown',
      detail: 'A reached ceiling alone does not show that a longer reduction would be worthwhile.' },
    ...['maxDropC', 'maxRiseC'].map(key => ({ key, label: LIMITS[key].label, kind: 'policy', value: p[key], unit: '°C',
      status: violations.some(row => row.code === (key === 'maxDropC' ? 'indoor-drop-limit' : 'indoor-rise-limit')) ? 'blocking' : d ? 'available' : 'unknown',
      detail: away ? 'Occupied average limits apply again at the scheduled return; away does not establish equal heating service.'
        : 'Checked against the weighted indoor normal reference, including model and sensor-estimate uncertainty. Rejections concern evaluated alternatives.',
      diagnostics: violations.filter(row => row.code === (key === 'maxDropC' ? 'indoor-drop-limit' : 'indoor-rise-limit')) })),
    { key: 'maxPreheatHours', label: 'Configured preheat ceiling', kind: 'policy', value: p.maxPreheatHours, unit: 'h',
      status: selected.schedule && (selected.schedule.preheatEnd - selected.schedule.preheatStart) / HOUR >= p.maxPreheatHours
        ? 'reached' : selected.search?.preheatExpansions > 0 ? 'available' : 'unknown',
      detail: 'The bounded preheat search considers permitted durations through this ceiling; treatment evidence and conservative average-temperature checks still apply.' },
    { key: 'validatedReductionHours', label: 'Demonstrated reduction duration', kind: 'evidence', value: evidence.validatedReductionHours, unit: 'h',
      status: evidence.actionValidated && evidence.validatedReductionHours >= p[durationKey] ? 'available' : evidence.initialReady ? 'initial' : 'blocking',
      detail: 'Initial estimates permit economic planning within configured limits. Demonstrated duration describes independently observed support; simulations add no evidence.' },
    { key: 'forecastCoverage', label: 'Price and weather coverage', kind: 'forecast', value: null, unit: null,
      status: !forecastCovered ? 'blocking' : 'available',
      detail: !forecastCovered ? 'Fewer than four contiguous hours of fresh price and weather evidence are available.'
        : d?.forecastRejected ? `${d.forecastRejected} candidates lacked coverage through at least two recovery hours.`
        : 'A candidate needs contiguous fresh forecasts through reduction and at least two recovery hours.' },
    { key: 'economicAdmission', label: 'Benefit, comfort and recovery', kind: 'economic', value: null, unit: null,
      status: d?.economicsAdmitted > 0 ? 'available' : d?.economicsAssessed ? 'blocking' : 'unknown',
      detail: d?.economicsAssessed ? `${d.economicsRejected} of ${d.economicsAssessed} shortlisted alternatives failed paired stress, benefit or comfort hurdles.`
        : 'No normally eligible shortlist was assessed. Lower electricity purchase cost alone is insufficient.' },
  ];
  result.unshift({ key: 'normalReference',
    label: 'Normal temperature reference', kind: 'evidence', status: input.equipment?.comfortReferenceProvisional === true
      ? 'learning' : finite(input.checkpoint?.baselineC) ? 'available' : 'unknown',
    value: input.settings.comfort.targetC ?? input.checkpoint?.baselineC ?? decision.comfort?.targetC ?? null, unit: '°C',
    detail: 'The reference temperature used for planning the weighted indoor average. The allowed drop and rise are shown separately. An initial measured Normal reference can be used while the occupied reference is learning.' });
  if (!input.equipment?.h66Available) result.push({ key: 'unobservedEquipment', label: 'Native equipment observation',
    kind: 'safety', status: 'blocking', value: input.config.maxUnobservedReductionHours, unit: 'h',
    detail: 'The shorter of the ordinary and unavailable-telemetry duration limits applies; an explicit one-cycle override can change either limit. Device authority and restoration remain required.' });
  if (!input.equipment?.preheatAvailable || violations.some(row => row.code === 'preheat-source-range'))
    result.push({ key: 'preheatAvailability', label: 'Preheat readiness', kind: 'safety', status: 'blocking', value: null, unit: null,
      detail: 'Preheat requires equipment authority, native ROOM headroom, supported supply temperatures and applicable treatment evidence.' });
  if (input.equipment?.preheatAvailable) {
    const treatmentKey=selected.schedule?.roomBoostC>0?selected.schedule.treatmentKey
      :input.equipment.floorOverrideAvailable?'room-boost-floor-v1':'room-boost-v1';
    const response=equipmentResponseEstimate(input.checkpoint?.model,'preheat',treatmentKey);
    const summary=input.checkpoint?.model?.equipmentResponse?.validation?.phases?.preheat;
    const validated = response?.validation??(summary?.treatmentKey===treatmentKey?summary:null);
    const maxBoost = validated?.accepted === true && finite(validated.maxRoomBoostC) ? validated.maxRoomBoostC : null;
    const requestedBoost = preheatRoomRequest(input.equipment, input.config).roomBoostC;
    result.push({ key: 'validatedPreheatBoostC', label: 'Demonstrated preheat ROOM increase', kind: 'evidence',
      status: !finite(requestedBoost) ? 'unknown' : maxBoost !== null && requestedBoost <= maxBoost ? 'available' : evidence.initialReady ? 'initial' : 'blocking',
      value: maxBoost, unit: '°C',
      detail: 'Initial estimates permit preheat with native ROOM headroom and conservative temperature checks. Demonstrated increases describe observed support; simulations add no evidence.' });
  }
  if (!evidence.trialReady || !finite(input.trialBudgetRemainingCents) || input.trialBudgetRemainingCents < 0) result.push({ key: 'trialReadiness',
    label: 'Learning trial readiness', kind: 'evidence', status: 'blocking', value: null, unit: null,
    detail: 'Experiments require enabled permission, current compressor and hot-water routing observations, a measured indoor average, budget for their estimated exposure and cold/hot stress checks. Zero budget still permits zero-exposure trials. Economic cycles can use the initialized model within current input, equipment and configured limits while experiment prerequisites are missing.' });
  for (const reason of decision.reasons.filter(reason => ['missing-or-stale-indoor', 'awaiting-normal-temperature-reference',
    'awaiting-fireplace-response-evidence', 'no-useful-space-heating-window',
    'trial-comfort-or-forecast-limited', 'trial-incremental-cost-exceeds-allowance',
    'daily-learning-trial-target-reached'].includes(reason))) result.push({ key: reason, label: reason.replaceAll('-', ' '),
    kind: 'evidence', status: 'blocking', value: null, unit: null, detail: 'This prerequisite is unchanged by policy exploration.' });
  return result;
}

function illustrate(input, changes, current, scenario, args, normal) {
  const key = input.settings.occupancy.mode === 'away' ? 'maxAwayReductionHours' : 'maxReductionHours';
  if (!Object.hasOwn(changes, key) || !args) return null;
  const duration = changes[key], selected = scenario.schedule ?? current.schedule;
  if (selected && (selected.reductionEnd - selected.reductionStart) / HOUR >= duration) return null;
  const start = Math.max(input.now, selected?.reductionStart ?? input.now);
  const schedule = { preheatStart: start, preheatEnd: start, reductionStart: start,
    reductionEnd: start + duration * HOUR, roomBoostC: 0, treatmentKey: 'reduction-only-v1' };
  if (!cycleForecastCovered(args.intervals, schedule, input.now)) return null;
  const prediction = evaluateCycle({ ...args, schedule });
  const economics = economicAdmission({ prediction, referencePrediction: normal, args, schedule, settings: input.settings });
  const evidenceDuration = validatedReductionHours(args.model, schedule);
  const reasons = ['illustrative-fixed-duration-not-a-selected-plan'];
  if (duration > evidenceDuration) reasons.push('outside-demonstrated-duration');
  if (prediction.severe || economics.unsafe) reasons.push('comfort-stress-check-failed');
  if (!economics.admitted) reasons.push('economic-admission-not-met');
  const plan = { schedule, economics, uncertaintyCents: economics.uncertaintyCents };
  return { ...summary({ action: 'normal', phase: 'normal', reasons, plan }, args, normal, { origin: 'illustrative' }),
    executable: false, extrapolated: duration > evidenceDuration,
    explanation: 'Fixed-duration reduction using the same predictor. This is not an approved or automatically eligible plan; changing the ceiling does not require the planner to use its full duration.' };
}

/** Pure, bounded comparison. Call in the explorer worker, never on a live tick.
 * All alternatives share one copied snapshot and the ordinary planner. */
export function exploreHeatingPlan(input, overrides = {}, options = {}) {
  const changes = explorerOverrideChanges(input, overrides);
  const frozen = applyExplorerOverrides(input, {}), hypothetical = applyExplorerOverrides(frozen, changes);
  const currentPolicy = policy(frozen), scenarioPolicy = policy(hypothetical);
  const changedKeys = Object.keys(changes).filter(key => scenarioPolicy[key] !== currentPolicy[key]);
  const optimize = candidate => chooseCycle({ ...candidate, incumbentPlan: candidate.currentPlan });
  const freshDecision = optimize(frozen);
  const scenarioDecision = changedKeys.length ? optimize(hypothetical) : freshDecision;
  const args = evaluationArgs(frozen), scenarioArgs = evaluationArgs(hypothetical);
  const baseline = args ? evaluateCycle(args) : null;
  const scenarioBaseline = scenarioArgs ? evaluateCycle(scenarioArgs) : null;
  const refreshedCurrent = summary(freshDecision, args, baseline);
  const selectedPlan = frozen.currentPlan;
  // A cancelled approval retains its frozen plan for provenance while live
  // recovery has already returned to configured preferences. The controller's
  // explicit effective settings take precedence for this current comparison.
  const currentConfig = frozen.currentConfig ?? selectedPlan?.config ?? frozen.config;
  const currentSettings = frozen.currentSettings ?? { ...frozen.settings,
    comfort: { ...frozen.settings.comfort,
      maxDropC: selectedPlan?.maxDropC ?? frozen.settings.comfort.maxDropC,
      maxRiseC: selectedPlan?.maxRiseC ?? frozen.settings.comfort.maxRiseC },
    savingsStrategy: selectedPlan?.savingsStrategy ?? frozen.settings.savingsStrategy };
  const effectivePolicy = policy({ ...frozen, config: currentConfig, settings: currentSettings });
  const currentArgs = args && (selectedPlan || frozen.currentSettings || frozen.currentConfig)
    ? { ...args, config: { ...args.config, ...currentConfig },
      maxDropC: effectivePolicy.maxDropC, maxRiseC: effectivePolicy.maxRiseC,
      savingsStrategy: effectivePolicy.savingsStrategy } : args;
  const currentBaseline = currentArgs === args ? baseline : evaluateCycle(currentArgs);
  const current = selectedPlan?.schedule
    ? summary({ action: frozen.currentDecision?.action ?? (phaseAt(selectedPlan.schedule, frozen.now) === 'reduction' ? 'reduction' : 'normal'),
      phase: frozen.currentDecision?.phase ?? phaseAt(selectedPlan.schedule, frozen.now), reasons: frozen.currentDecision?.reasons ?? ['currently-selected-cycle'], plan: selectedPlan },
    currentArgs, currentBaseline, { origin: 'selected' })
    : frozen.currentDecision
      ? summary({ ...frozen.currentDecision, plan: null }, args, baseline, { origin: 'selected' }) : refreshedCurrent;
  const scenario = summary(scenarioDecision, scenarioArgs, scenarioBaseline);
  const normal = summary({ action: 'normal', phase: 'normal', reasons: ['continuous-normal-heating'], plan: null },
    args, baseline, { origin: 'normal' });
  const readiness = scenarioDecision.plan?.readiness ?? scenarioDecision.readiness
    ?? learningReadiness(hypothetical.checkpoint, hypothetical.config, hypothetical.equipment);
  const evidence = { ...readiness, validatedReductionHours: validatedReductionHours(hypothetical.checkpoint?.model, scenario.schedule) };
  const boundaries = constraints(hypothetical, scenarioDecision, evidence, scenario);
  const opportunities = [];
  let plannerRuns = changedKeys.length ? 2 : 1;
  // One duration probe, one comfort probe and only then a combined probe if
  // necessary. Slider requests do not repeat this automatic scan.
  if (options.includeOpportunities !== false && !Object.keys(changes).length && args && (evidence.initialReady || evidence.actionValidated)) {
    const durationKey = frozen.settings.occupancy.mode === 'away' ? 'maxAwayReductionHours' : 'maxReductionHours';
    const maxDuration = Math.min(LIMITS[durationKey].max, evidence.initialReady ? Infinity : evidence.validatedReductionHours, currentPolicy[durationKey] * 2);
    const durationChanges = maxDuration > currentPolicy[durationKey] ? { [durationKey]: maxDuration } : {};
    const comfortChanges = currentPolicy.maxDropC < 2 ? { maxDropC: Math.min(2, currentPolicy.maxDropC + .5) } : {};
    const probe = proposal => {
      if (!Object.keys(proposal).length) return false;
      const candidateInput = applyExplorerOverrides(frozen, proposal), candidate = optimize(candidateInput); plannerRuns++;
      if (!candidate.plan || candidate.plan.trial || !candidate.plan.economics?.admitted) return false;
      const candidateArgs = evaluationArgs(candidateInput), result = summary(candidate, candidateArgs, evaluateCycle(candidateArgs));
      const improvement = compare(refreshedCurrent, result), actualImprovement = compare(current, result);
      // Attribute only improvement over a fresh same-limit optimization. A
      // retained pending plan being different is not evidence against a limit.
      if (!improvement.changed || !(improvement.additionalBenefitCents >= 10) || !(actualImprovement.additionalBenefitCents >= 10)
        || !(candidate.plan.economics.lowerBenefitCents > (freshDecision.plan?.economics?.lowerBenefitCents ?? 0) + 5)) return false;
      opportunities.push({ key: Object.keys(proposal).join('+'), title: 'Opportunity to review', overrides: proposal,
        additionalBenefitCents: actualImprovement.additionalBenefitCents,
        detail: 'The tested limits admit a different plan with a greater estimated full-cycle benefit. Household reasons for the existing limits remain your choice.',
        evidence: 'One frozen comparison using current model estimates; this is not new learning or a recommendation to change defaults.',
        comparison: actualImprovement, scenario: result });
      for (const boundary of boundaries) if (Object.hasOwn(proposal, boundary.key)) {
        boundary.status = 'blocking'; boundary.detail = 'A tested relaxation produces an eligible alternative with at least 10 cents more estimated benefit. Compare its comfort and recovery consequences.';
      }
      return true;
    };
    const durationImproved = probe(durationChanges), comfortImproved = probe(comfortChanges);
    if (!durationImproved && !comfortImproved && Object.keys(durationChanges).length && Object.keys(comfortChanges).length)
      probe({ ...durationChanges, ...comfortChanges });
  }
  current.limits = effectivePolicy;
  const controls = Object.entries(LIMITS).filter(([key]) => key !== (frozen.settings.occupancy.mode === 'away' ? 'maxReductionHours' : 'maxAwayReductionHours'))
    .map(([key, spec]) => ({ key, ...spec, ...CONTROL_DETAILS[key], value: currentPolicy[key], effectiveValue: effectivePolicy[key], scenarioValue: scenarioPolicy[key],
      ...(['minimumHomeBenefitCents','homeDiscomfortCentsPerDegreeSquaredHour'].includes(key)
        ? { usesStrategyDefault: false } : {}) }));
  controls.push({ key: 'savingsStrategy', label: 'Savings strategy', ...CONTROL_DETAILS.savingsStrategy, value: currentPolicy.savingsStrategy,
    effectiveValue: effectivePolicy.savingsStrategy, scenarioValue: scenarioPolicy.savingsStrategy,
    options: HEATING_STRATEGIES.map(item => ({ value: item.id, label: `${item.label} (${item.retainedBenefitFraction * 100}%)` })) });
  controls.push({ key: 'learningTrials', label: 'Enable learning trials', type: 'checkbox', ...CONTROL_DETAILS.learningTrials,
    value: currentPolicy.learningTrials, effectiveValue: effectivePolicy.learningTrials, scenarioValue: scenarioPolicy.learningTrials });
  const indoor = frozen.observations?.indoor;
  const indoorAvailable = finite(indoor?.value) && indoor.stale !== true
    && finite(indoor.observedAt) && indoor.observedAt <= frozen.now;
  const result = { version: 1, snapshotAt: frozen.now, snapshotId: frozen.snapshotId ?? null,
    indoorInput: { valueC: finite(indoor?.value) ? indoor.value : null,
      observedAt: finite(indoor?.observedAt) ? indoor.observedAt : null, available: indoorAvailable,
      estimated: frozen.equipment?.indoorEstimated === true,
      uncertaintyC: indoorAvailable ? indoorUncertaintyAt(frozen.equipment, 0, frozen.now) : null,
      estimateValidUntil: finite(frozen.equipment?.indoorEstimateValidUntil) ? frozen.equipment.indoorEstimateValidUntil : null },
    controls, limits: scenarioPolicy, changedKeys, current, refreshedCurrent,
    learningContext: { automaticEnabled: currentPolicy.learningTrials,
      perCycleLimitCents: currentPolicy.maxTrialCostCents,
      remainingAutomaticAllowanceCents: finite(frozen.trialBudgetRemainingCents) ? frozen.trialBudgetRemainingCents : null,
      allowanceBasis: Object.hasOwn(changes, 'maxTrialCostCents') ? 'reviewed-one-cycle' : 'captured-automatic' },
    currentDiffersFromRecalculation: compare(current, refreshedCurrent).changed,
    scenario, normal, comparison: compare(current, scenario), constraints: boundaries, opportunities, evidence,
    illustrative: illustrate(hypothetical, changes, current, scenario, scenarioArgs, scenarioBaseline),
    computation: { plannerRuns, maxAutomaticProbeRuns: 3 },
    limitations: [
      'All figures are estimates on a frozen snapshot. Simulations do not operate equipment, change configuration or teach the model.',
      'Comparisons start at the captured time. Already elapsed portions of an active cycle and their recorded costs are excluded from these forward estimates.',
      'Space-heating cost includes preheat, reduction, recovery and priced remaining heat debt. Electricity totals exclude that unobserved tail. Hot-water service and whole-house savings are not established.',
      'Temperature bounds and adverse physical scenarios are engineering uncertainty allowances, not calibrated statistical confidence intervals.',
      'Comfort uses the configured weighted indoor average; individual room temperatures do not impose separate limits.',
      'Bounded candidate search identifies evaluated alternatives, not a mathematical global optimum.',
    ],
  };
  if (options.includePlan === true) result.executablePlan = scenarioDecision.plan ? structuredClone(scenarioDecision.plan) : null;
  return result;
}
