import { evaluateCycle, cycleForecastCovered, forecastIntervals, phaseAt } from './planner.js';
import { homePlanningState } from '../domain/home-model.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const costsLess = (a, b) => a < b - 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));

/** A retained forecast is a control assumption, never renewed source evidence.
 * Its fixed schedule can still execute when a fresh comparison is unavailable. */
export function continuationInput(input, plan, schedule = plan.schedule) {
  const current = forecastIntervals(input.prices, input.forecast, input.now);
  const fresh = cycleForecastCovered(current, schedule, input.now);
  const retained = (plan.continuation?.intervals ?? plan.intervals ?? [])
    .filter(row => row.end > input.now).map(row => ({ ...row, start: Math.max(row.start, input.now) }));
  const byEnd = new Map(current.map(row => [row.end, row]));
  const missingSolar = fresh && retained.some(row => {
    const replacement = byEnd.get(row.end) ?? current.find(next => next.start < row.end && next.end >= row.end);
    return finite(row.solarRadiationWm2) && replacement && !finite(replacement.solarRadiationWm2);
  });
  const intervals = fresh && !missingSolar ? current : retained;
  const observed = input.observations?.indoor;
  const measured = finite(observed?.value) && !observed.stale && observed.observedAt <= input.now;
  const previous = plan.continuation;
  let state = input.thermalState;
  const model = input.checkpoint?.model ?? previous?.model ?? plan.model;
  if (!measured && !finite(state?.indoorC) || !finite(state?.reserveC)
    || model.floor?.enabled && !finite(state?.slabC)) {
    const anchor = previous?.initialState ?? plan.initialState;
    const from = previous?.at ?? plan.executionStartedAt ?? plan.generatedAt ?? plan.intervals?.[0]?.start;
    const history = (previous?.intervals ?? plan.intervals ?? []).filter(row => row.end > from && row.start < input.now)
      .map(row => ({ ...row, start: Math.max(row.start, from), end: Math.min(row.end, input.now) }));
    if (anchor && history.length && history[0].start === from && history.at(-1).end === input.now) {
      state = evaluateCycle({ intervals: history, model, initialState: anchor,
        // A pending plan has delivered no heat. Missed planned actions cannot
        // become stored-heat evidence merely because its start time passed.
        schedule: finite(plan.executionStartedAt) ? schedule : null,
        targetC: plan.targetC, config: plan.config, equipment: plan.equipment,
        occupancy: plan.occupancy, maxDropC: plan.maxDropC, maxRiseC: plan.maxRiseC }).endState;
    } else state = state ?? anchor;
  }
  const indoorC = measured ? observed.value : state?.indoorC ?? plan.initialState?.indoorC;
  const initialState = homePlanningState(model, indoorC, intervals[0]?.outdoorC,
    intervals[0]?.solarRadiationWm2, state);
  const equipment = { ...plan.equipment, ...input.equipment };
  const evidenceMissing = plan.equipment?.h66Available === true && input.equipment?.h66Available === false
    || ['supplyC', 'brineC', 'compressorOn', 'dhwRouting'].some(key =>
      finite(plan.equipment?.[key]) && input.equipment && input.equipment[key] == null)
    || ['on', 'off'].includes(plan.equipment?.floorOverrideMode)
      && input.equipment && !['on', 'off'].includes(input.equipment.floorOverrideMode);
  // Missing water/source telemetry cannot erase the accepted source assumption.
  for (const key of ['supplyC', 'normalSupplyC', 'brineC', 'nativeAuxAllowed'])
    if (equipment[key] == null) equipment[key] = previous?.equipment?.[key] ?? plan.equipment?.[key];
  if (evidenceMissing) for (const key of ['h66Available', 'reductionTelemetryAvailable', 'preheatAvailable', 'floorOverrideAvailable'])
    if (equipment[key] !== true && (previous?.equipment?.[key] ?? plan.equipment?.[key]) === true) equipment[key] = true;
  return { now: input.now, intervals, model, initialState, targetC: input.settings?.comfort?.targetC ?? plan.targetC,
    config: input.config ?? plan.config, equipment, occupancy: input.settings?.occupancy ?? plan.occupancy,
    maxDropC: input.settings?.comfort?.maxDropC ?? plan.maxDropC,
    maxRiseC: input.settings?.comfort?.maxRiseC ?? plan.maxRiseC,
    approvedExtraCostCents: plan.trial
      ? Math.max(0, (plan.prediction?.costCents ?? 0) - (plan.referencePrediction?.costCents ?? 0))
      : Math.max(0, -(plan.config?.minimumHomeBenefitCents ?? 0)),
    freshComparison: fresh && measured && !evidenceMissing && !missingSolar,
    retained: !fresh || !measured || evidenceMissing || missingSolar };
}

export const withoutFurtherPreheat = (schedule, now) => ({ ...schedule,
  preheatStart: Math.min(schedule.preheatStart, now), preheatEnd: Math.min(schedule.preheatEnd, now) });

export const endTreatmentNow = (schedule, now) => ({ ...withoutFurtherPreheat(schedule, now),
  reductionStart: Math.min(schedule.reductionStart, now), reductionEnd: Math.min(schedule.reductionEnd, now) });

/** Temperature of delivered/stored heat after removing the current action now.
 * No hypothetical remaining preheat, latency padding or error-envelope veto. */
export function deliveredHeatLimit(args, schedule) {
  if (!cycleForecastCovered(args.intervals, schedule, args.now) || !finite(args.initialState?.indoorC)) return null;
  const phase = phaseAt(schedule, args.now);
  const stopped = phase === 'reduction' ? endTreatmentNow(schedule, args.now)
    : withoutFurtherPreheat(schedule, args.now);
  const prediction = evaluateCycle({ ...args, schedule: stopped });
  const occupied = args.occupancy?.mode !== 'away';
  const returnAt = typeof args.occupancy?.returnAt === 'number' ? args.occupancy.returnAt : Date.parse(args.occupancy?.returnAt);
  const values = prediction.trajectory.filter(row => occupied || finite(returnAt) && row.at >= returnAt).map(row => row.indoorC);
  if (occupied) values.push(args.initialState.indoorC);
  if (!values.length) return null;
  return { hot: Math.max(...values) > args.targetC + args.maxRiseC,
    cold: Math.min(...values) < args.targetC - args.maxDropC,
    peakC: Math.max(...values), minimumC: Math.min(...values) };
}

export function scheduledHeatingPhase(args, schedule) {
  const phase = phaseAt(schedule, args.now);
  if (!['preheat', 'reduction'].includes(phase)) return { phase, reason: null };
  const limit = deliveredHeatLimit(args, schedule);
  const reason = phase === 'preheat' && limit?.hot ? 'delivered-heat-upper-limit'
    : phase === 'reduction' && limit?.cold ? 'delivered-cooling-lower-limit' : null;
  return { phase: reason ? 'normal' : phase, reason };
}

/** Bounded remaining-window search. The reduction window and delivered prefix
 * are fixed. The existing worker owns this calculation; it has no authority. */
export function reviseHeatingCycle({ args, schedule, preheatHours = 0 }) {
  if (!args.freshComparison || !cycleForecastCovered(args.intervals, schedule, args.now)) return null;
  const evaluate = candidate => evaluateCycle({ ...args, schedule: candidate });
  const incumbent = evaluate(schedule);
  const roomBoostC = finite(args.equipment.roomSettingC)
    ? Math.min(schedule.roomBoostC ?? 0, Math.max(0, (args.equipment.roomSettingMaximumC ?? 35) - args.equipment.roomSettingC))
    : schedule.roomBoostC;
  const minimum = prediction => Math.min(args.initialState.indoorC, ...prediction.trajectory.map(row => row.indoorC));
  const coldFloor = Math.min(args.targetC - args.maxDropC, minimum(incumbent));
  const optionalHeatFits = (candidate, prediction) => candidate.preheatEnd <= Math.max(args.now, candidate.preheatStart)
    || candidate.roomBoostC <= roomBoostC
      && preheatHours + (candidate.preheatEnd - Math.max(args.now, candidate.preheatStart)) / HOUR <= args.config.maxPreheatHours
      && !prediction.trajectory.some(row => row.indoorC > args.targetC + args.maxRiseC);
  let best = optionalHeatFits(schedule, incumbent) ? { schedule, prediction: incumbent } : null;
  const noPreheat = withoutFurtherPreheat(schedule, args.now);
  const consider = candidate => {
    const prediction = evaluate(candidate);
    // Central bounds constrain optional future heat, not the useful reduction
    // of an already warm house. Cold reduction is owned by the live stop test.
    if (!optionalHeatFits(candidate, prediction) || minimum(prediction) < coldFloor - 1e-8) return;
    if (!best || costsLess(prediction.costCents, best.prediction.costCents)) best = { schedule: candidate, prediction };
  };
  consider(noPreheat);
  if (schedule.reductionStart > args.now && (roomBoostC > 0 || schedule.floorOverride === true)) {
    const maximum = Math.min(args.config.maxPreheatHours - preheatHours, (schedule.reductionStart - args.now) / HOUR);
    const durations = [...new Set([.25, .5, .75, 1, 1.5, 2, 3, 4, 6, maximum,
      Math.max(0, schedule.preheatEnd - Math.max(args.now, schedule.preheatStart)) / HOUR])]
      .filter(hours => hours > 0 && hours <= maximum);
    // At most 32 diverse endpoints, including the incumbent and reduction.
    const changes = args.intervals.filter((row, i, rows) => i && row.price !== rows[i - 1].price
      && row.start > args.now && row.start < schedule.reductionStart).map(row => row.start);
    const ends = [...new Set([schedule.reductionStart, schedule.preheatEnd,
      ...changes.filter((_, i) => i % Math.max(1, Math.ceil(changes.length / 30)) === 0)])]
      .filter(at => at > args.now && at <= schedule.reductionStart);
    for (const end of ends) for (const hours of durations) {
      const start = end - hours * HOUR;
      if (start < args.now) continue;
      consider({ ...schedule, preheatStart: start, preheatEnd: end, roomBoostC,
        roomSettingC: finite(args.equipment.roomSettingC)
          ? args.equipment.roomSettingC + roomBoostC
          : schedule.roomSettingC });
    }
  }
  // No feasible repair is a reason to retain intent, not to invent an exit.
  best ??= { schedule, prediction: incumbent };
  const stopped = evaluate(endTreatmentNow(schedule, args.now));
  return { schedule: best.schedule, end: costsLess(stopped.costCents + (args.approvedExtraCostCents ?? 0), best.prediction.costCents),
    continuedCostCents: best.prediction.costCents, stoppedCostCents: stopped.costCents };
}
