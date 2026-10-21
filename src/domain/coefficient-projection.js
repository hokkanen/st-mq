import { MODEL_COEFFICIENT_INFO } from './history-series.js';
import { isDeepStrictEqual } from 'node:util';

export const emptyCoefficientProjection = () => ({ at: null, cursor: 0, learned: [], fitted: [], coefficients: null, blocked: true });
export const compactCoefficientProjection = state => Object.fromEntries(['at','cursor','learned','fitted','coefficients','blocked']
  .map(key => [key, structuredClone(state[key])]));

/** Presentation evidence is carried separately from the numerical model. The
 * already calculated next checkpoint is never refitted to record a chart row. */
export function projectCoefficientTransition(state, entry, prior, next) {
  const previous = state.coefficients;
  state.at = Math.max(state.at ?? -Infinity, entry.at); state.cursor = entry.id;
  const validation = next.model.validation, learned = new Set(state.learned), fitted = new Set(state.fitted);
  const seeded = !prior || Boolean(entry.payload.value.historySeed?.model);
  const accepted = next.health?.acceptedFits > (prior?.health?.acceptedFits ?? 0) || next.model.trainedAt !== prior?.model?.trainedAt;
  if (seeded) { learned.clear(); fitted.clear(); }
  if (seeded || accepted) {
    fitted.clear();
    for (const parameter of validation?.accepted === true ? validation.fittedParameters ?? [] : []) { fitted.add(parameter); learned.add(parameter); }
    if (validation?.accepted === true) for (const [parameter, evidence] of Object.entries(validation.parameterEvidence ?? {}))
      if (evidence?.status === 'identified' && evidence.fitStatus === 'retained-unchanged') learned.add(parameter);
  }
  const initial = prior ?? entry.payload.seed;
  const reset = initial?.learningConfiguration && ['auxRatedKw', 'heatPumpModelConfirmed', 'floorThermalPriors']
    .some(key => !isDeepStrictEqual(initial.learningConfiguration[key] ?? null, entry.payload.configuration[key] ?? null));
  if (reset && !entry.payload.value.historySeed?.model && validation?.accepted !== true) { learned.clear(); fitted.clear(); }
  state.learned = [...learned]; state.fitted = [...fitted]; state.blocked = false;
  state.coefficients = Object.fromEntries(Object.entries(MODEL_COEFFICIENT_INFO).map(([key, info]) => {
    const value = next.model.parameters[info.parameter], old = previous?.[key];
    return [key, { value: Number.isFinite(value) ? value : null,
      status: fitted.has(info.parameter) && next.health?.status !== 'retained-previous' ? 'fitted' : learned.has(info.parameter) ? 'retained' : 'initial',
      updatedAt: old?.value === value ? old.updatedAt : state.at }];
  }));
  return isDeepStrictEqual(previous, state.coefficients) ? null : { cursor: entry.id, at: state.at, coefficients: structuredClone(state.coefficients) };
}
