import { defaultPalette, historyDatasets, visible } from './history-model.js';
import { clipChartSeries } from './chart-resolution.js';
import { preparePowerFills } from './power-fill.js';

const pointOptions = ['pointBackgroundColor', 'pointBorderWidth', 'pointRadius', 'pointHoverRadius', 'pointHitRadius'];
function compact(value) {
  return Array.isArray(value) && value.length && value.every(item => item === value[0]) ? value[0] : value;
}

/** Geometry keeps every selected vertex and all original tooltip metadata.
 * Uniform marker options are scalars so Chart.js can share resolved options
 * instead of allocating one options object per point on every redraw. */
export function prepareChartGeometry({ series, descriptor, visibility, interpolation = true, view }) {
  const display = { interpolation };
  const selected = view ? clipChartSeries(series, view, display) : series;
  const datasets = preparePowerFills(historyDatasets(selected, descriptor, visibility, defaultPalette, display));
  for (const dataset of datasets) {
    for (const key of pointOptions) dataset[key] = compact(dataset[key]);
    dataset.chartEvidence = {
      carriedForward: dataset.data.some(point => point.carriedForward),
      needsAttention: dataset.data.some(point => point.needsAttention),
      hasValues: dataset.data.some(point => Number.isFinite(point.y)),
    };
  }
  return datasets;
}
/** Only stack visibility changes geometry. Ordinary series toggles and theme
 * changes reuse the same data, knots, aligned stacks and marker radii. */
export function chartGeometryKey(descriptor, visibility, interpolation, view) {
  const stack = descriptor.stackPower ? ['charger_power', 'charger2_power']
    : descriptor.stackPhases ? [1, 2, 3].flatMap(phase => [`ev1_current_l${phase}`, `ev2_current_l${phase}`]) : [];
  return JSON.stringify([descriptor.key, descriptor.leftSignals, descriptor.rightSignals, interpolation,
    stack.map(key => visible(key, visibility)), view?.from, view?.to]);
}

export function styleChartGeometry(datasets, descriptor, visibility, palette, interpolation = true) {
  const styles = historyDatasets({}, descriptor, visibility, palette, { interpolation });
  for (let index = 0; index < datasets.length; index++) {
    const dataset = datasets[index], style = styles[index], previousColor = dataset.borderColor;
    for (const key of ['borderColor', 'backgroundColor', 'pointBorderColor', 'hidden']) dataset[key] = style[key];
    if (previousColor !== dataset.borderColor) dataset.pointBackgroundColor = Array.isArray(dataset.pointBackgroundColor)
      ? dataset.pointBackgroundColor.map(value => value === 'transparent' ? value : dataset.borderColor)
      : dataset.pointBackgroundColor === 'transparent' ? 'transparent' : dataset.borderColor;
  }
  return datasets;
}
