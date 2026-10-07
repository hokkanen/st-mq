import { CONTROL_DEFAULTS } from '../app/config.js';
import { HEATING_STRATEGIES } from '../domain/heating-strategy.js';
import { initialAdaptiveModel } from './adaptive-learning.js';
import { chooseCycle, evaluateCycle, economicAdmission, forecastIntervals, learningReadiness,
  phaseAt, validatedReductionHours, cycleForecastCovered, effectiveComfortDropC } from './planner.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const LIMITS = Object.freeze({
  maxReductionHours: { label: 'Maximum reduction', min: .25, max: 12, step: .25, unit: 'h' },
  maxAwayReductionHours: { label: 'Maximum reduction while away', min: .25, max: 24, step: .25, unit: 'h' },
  maxDropC: { label: 'Allowed average temperature drop', min: 0, max: 2, step: .25, unit: '°C' },
  maxRiseC: { label: 'Allowed average temperature rise', min: .25, max: 2, step: .25, unit: '°C' },
  maxPreheatHours: { label: 'Maximum preheat', min: .25, max: 6, step: .25, unit: 'h' },
  preheatRoomBoostC: { label: 'Preheat ROOM increase', min: 1, max: 5, step: 1, unit: '°C', integer: true },
});

/** Only explicit household policy can be explored. Equipment, evidence, training
 * budgets, native protection and source assumptions are never request fields. */
export function validateExplorerOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides)))
    throw new TypeError('Heating scenario limits must be an object');
  const result = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'savingsStrategy') {
      if (!HEATING_STRATEGIES.some(option => option.id === value)) throw new TypeError('Unknown savings strategy');
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

export function applyExplorerOverrides(input, overrides = {}) {
  const changes = validateExplorerOverrides(overrides), result = structuredClone(input);
  result.config = { ...CONTROL_DEFAULTS, ...result.config };
  result.settings = { ...result.settings, comfort: { ...result.settings.comfort } };
  for (const [key, value] of Object.entries(changes)) {
    if (['maxDropC', 'maxRiseC'].includes(key)) result.settings.comfort[key] = value;
    else if (key === 'savingsStrategy') result.settings.savingsStrategy = value;
    else {
      result.config[key] = value;
      if (key === 'preheatRoomBoostC') result.settings.preheatRoomBoostC = value;
    }
  }
  return result;
}

function policy(input) {
  const c = { ...CONTROL_DEFAULTS, ...input.config };
  return { maxReductionHours: c.maxReductionHours, maxAwayReductionHours: c.maxAwayReductionHours,
    maxPreheatHours: c.maxPreheatHours, preheatRoomBoostC: c.preheatRoomBoostC,
    maxDropC: input.settings.comfort.maxDropC, maxRiseC: input.settings.comfort.maxRiseC ?? 1.5,
    savingsStrategy: input.settings.savingsStrategy ?? 'balanced' };
}

function evaluationArgs(input) {
  const indoor = input.observations?.indoor, targetC = input.settings.comfort.targetC ?? input.checkpoint?.baselineC;
  const intervals = forecastIntervals(input.prices, input.forecast, input.now);
  if (!finite(indoor?.value) || indoor.stale || !finite(indoor.observedAt) || indoor.observedAt > input.now
    || !finite(targetC) || !intervals.length) return null;
  return { intervals, model: input.checkpoint?.model ?? initialAdaptiveModel(input.config),
    initialState: { indoorC: indoor.value, reserveC: input.thermalState?.reserveC ?? indoor.value,
      slabC: input.thermalState?.slabC ?? null, integral: input.equipment?.integral }, targetC,
    occupancy: input.settings.occupancy, maxDropC: input.settings.comfort.maxDropC,
    maxRiseC: input.settings.comfort.maxRiseC ?? 1.5, savingsStrategy: input.settings.savingsStrategy,
    config: input.config, equipment: input.equipment ?? {} };
}

function outcomes(prediction, args) {
  if (!prediction || !args) return null;
  const rows = prediction.trajectory;
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
    outcomes: outcomes(prediction, args),
    estimatedBenefitCents: prediction && baseline ? baseline.costCents - prediction.costCents : null,
    lowerBenefitCents: economics?.lowerBenefitCents ?? null, uncertaintyCents: economics?.uncertaintyCents ?? plan?.uncertaintyCents ?? null,
    trajectory: prediction?.trajectory.map(row => ({ at: row.at, indoorC: row.indoorC,
      uncertaintyC: row.uncertaintyC, phase: row.phase })) ?? [],
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
      status: !evidence.actionValidated || evidence.validatedReductionHours < p[durationKey] ? 'blocking' : 'available',
      detail: 'Normal economic planning needs thermal, equipment-response and frozen advance-forecast evidence for the duration and treatment. Simulations add no evidence.' },
    { key: 'forecastCoverage', label: 'Price and weather coverage', kind: 'forecast', value: null, unit: null,
      status: decision.reasons.includes('missing-or-incomplete-price-weather-horizon') ? 'blocking' : d?.forecastRejected ? 'blocking' : 'available',
      detail: d?.forecastRejected ? `${d.forecastRejected} candidates lacked coverage through at least two recovery hours.`
        : 'A candidate needs contiguous fresh forecasts through reduction and at least two recovery hours.' },
    { key: 'economicAdmission', label: 'Benefit, comfort and recovery', kind: 'economic', value: null, unit: null,
      status: d?.economicsRejected ? 'blocking' : d?.economicsAssessed ? 'available' : 'unknown',
      detail: d?.economicsAssessed ? `${d.economicsRejected} of ${d.economicsAssessed} shortlisted alternatives failed paired stress, benefit or comfort hurdles.`
        : 'No normally eligible shortlist was assessed. Lower electricity purchase cost alone is insufficient.' },
  ];
  if (input.equipment?.comfortReferenceProvisional === true) result.push({ key: 'provisionalReference',
    label: 'Provisional normal temperature', kind: 'safety', status: 'limiting',
    value: effectiveComfortDropC(p.maxDropC, input.equipment), unit: '°C',
    detail: 'Until enough normal heating evidence is available, the occupied average drop is capped at 0.5 °C.' });
  if (!input.equipment?.h66Available) result.push({ key: 'unobservedEquipment', label: 'Native equipment observation',
    kind: 'safety', status: 'blocking', value: input.config.maxUnobservedReductionHours, unit: 'h',
    detail: 'Without native readback the separate conservative duration ceiling remains in force; this explorer cannot relax it.' });
  if (!input.equipment?.preheatAvailable || violations.some(row => row.code === 'preheat-source-range'))
    result.push({ key: 'preheatAvailability', label: 'Preheat readiness', kind: 'safety', status: 'blocking', value: null, unit: null,
      detail: 'Preheat requires equipment authority, native ROOM headroom, supported supply temperatures and applicable treatment evidence.' });
  if (!evidence.trialReady || !(input.trialBudgetRemainingCents > 0)) result.push({ key: 'trialReadiness',
    label: 'Learning trial allowance', kind: 'evidence', status: 'blocking', value: input.trialBudgetRemainingCents ?? 0, unit: 'cents',
    detail: 'A trial needs existing permission, observed equipment, usable evidence, remaining budget and the ordinary cold/hot stress checks.' });
  for (const reason of decision.reasons.filter(reason => ['missing-or-stale-indoor', 'awaiting-normal-temperature-reference',
    'awaiting-fireplace-response-evidence'].includes(reason))) result.push({ key: reason, label: reason.replaceAll('-', ' '),
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
  const evidenceDuration = validatedReductionHours(args.model);
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
  const changes = validateExplorerOverrides(overrides);
  const frozen = applyExplorerOverrides(input, {}), hypothetical = applyExplorerOverrides(frozen, changes);
  const currentPolicy = policy(frozen), scenarioPolicy = policy(hypothetical);
  const changedKeys = Object.keys(changes).filter(key => scenarioPolicy[key] !== currentPolicy[key]);
  const freshDecision = chooseCycle(frozen);
  const scenarioDecision = changedKeys.length ? chooseCycle(hypothetical) : freshDecision;
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
  const evidence = { ...readiness, validatedReductionHours: validatedReductionHours(hypothetical.checkpoint?.model) };
  const boundaries = constraints(hypothetical, scenarioDecision, evidence, scenario);
  const opportunities = [];
  let plannerRuns = changedKeys.length ? 2 : 1;
  // One duration probe, one comfort probe and only then a combined probe if
  // necessary. Slider requests do not repeat this automatic scan.
  if (options.includeOpportunities !== false && !Object.keys(changes).length && args && evidence.actionValidated) {
    const durationKey = frozen.settings.occupancy.mode === 'away' ? 'maxAwayReductionHours' : 'maxReductionHours';
    const maxDuration = Math.min(LIMITS[durationKey].max, evidence.validatedReductionHours, currentPolicy[durationKey] * 2);
    const durationChanges = maxDuration > currentPolicy[durationKey] ? { [durationKey]: maxDuration } : {};
    const comfortChanges = currentPolicy.maxDropC < 2 ? { maxDropC: Math.min(2, currentPolicy.maxDropC + .5) } : {};
    const probe = proposal => {
      if (!Object.keys(proposal).length) return false;
      const candidateInput = applyExplorerOverrides(frozen, proposal), candidate = chooseCycle(candidateInput); plannerRuns++;
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
        evidence: 'One frozen comparison with existing validated evidence; this is not new learning or a recommendation to change defaults.',
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
    .map(([key, spec]) => ({ key, ...spec, value: currentPolicy[key], effectiveValue: effectivePolicy[key], scenarioValue: scenarioPolicy[key] }));
  controls.push({ key: 'savingsStrategy', label: 'Savings strategy', value: currentPolicy.savingsStrategy,
    effectiveValue: effectivePolicy.savingsStrategy, scenarioValue: scenarioPolicy.savingsStrategy,
    options: HEATING_STRATEGIES.map(item => ({ value: item.id, label: item.label })) });
  const result = { version: 1, snapshotAt: frozen.now, snapshotId: frozen.snapshotId ?? null,
    controls, limits: scenarioPolicy, changedKeys, current, refreshedCurrent,
    currentDiffersFromRecalculation: compare(current, refreshedCurrent).changed,
    scenario, normal, comparison: compare(current, scenario), constraints: boundaries, opportunities, evidence,
    illustrative: illustrate(hypothetical, changes, current, scenario, scenarioArgs, scenarioBaseline),
    computation: { plannerRuns, maxAutomaticProbeRuns: 3 },
    limitations: [
      'All figures are estimates on a frozen snapshot. Simulations do not operate equipment, change configuration or teach the model.',
      'Space-heating cost includes preheat, reduction, recovery and priced remaining heat debt. Electricity totals exclude that unobserved tail. Hot-water service and whole-house savings are not established.',
      'Temperature bounds and adverse physical scenarios are engineering uncertainty allowances, not calibrated statistical confidence intervals.',
      'Comfort uses the configured weighted indoor average; individual room temperatures do not impose separate limits.',
      'Bounded candidate search identifies evaluated alternatives, not a mathematical global optimum.',
    ],
  };
  if (options.includePlan === true) result.executablePlan = scenarioDecision.plan ? structuredClone(scenarioDecision.plan) : null;
  return result;
}
