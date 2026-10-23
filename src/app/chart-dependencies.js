import { CHART_VIEW_BY_KEY } from '../domain/chart-views.js';
import { HISTORY_AXIS_BY_KEY, MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO } from '../domain/history-series.js';
import { FIREWOOD_OUTCOME_NAMES } from './chart-fireplace.js';

export function chartSignals(args) {
  const view = Object.hasOwn(CHART_VIEW_BY_KEY, args.view) ? CHART_VIEW_BY_KEY[args.view] : null;
  if (view) return [...view.leftSignals, ...view.rightSignals, ...view.tracks];
  const left = args.left ?? 'power';
  if (!Object.hasOwn(HISTORY_AXIS_BY_KEY, left)) return [];
  const signals = HISTORY_AXIS_BY_KEY[left].signals;
  // Grouped axes include the saved indoor-temperature reference even when it
  // is not one of the axis's left-hand signals (see getChartData).
  return signals.length > 1 ? [...signals, 'model_indoor_temperature'] : signals;
}
export const chartNeedsAssessment = args => args.summaryOnly === true
  || chartSignals(args).some(signal => FIREWOOD_OUTCOME_NAMES.includes(signal));
export const chartNeedsLearningHistory = args => chartNeedsAssessment(args)
  || chartSignals(args).some(signal => Object.hasOwn(MODEL_INPUT_INFO, signal)
    || Object.hasOwn(MODEL_COEFFICIENT_INFO, signal) || signal.startsWith('learning_'));
