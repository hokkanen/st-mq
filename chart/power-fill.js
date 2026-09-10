const finite = Number.isFinite;

function ordered(points = []) {
  return points.every((point, index) => finite(point.x) && (!index || point.x >= points[index - 1].x));
}

/** Our stepped load bands already share their complete timestamp groups.
 * Keep those points intact and bypass the generic filler's repeated searches
 * through every disconnected target segment. Other fills retain Chart.js. */
export function preparePowerFills(datasets = []) {
  return datasets.map((dataset, index) => {
    if (dataset.kind !== 'fill' || dataset.stepped !== true || !ordered(dataset.data)) return dataset;
    const target = dataset.fill;
    if (target !== 'origin') {
      const base = Number.isInteger(target) && target !== index ? datasets[target] : undefined;
      if (!base || base.hidden || base.stepped !== true || base.data.length !== dataset.data.length
        || !base.data.every((point, at) => point.x === dataset.data[at].x)) return dataset;
    }
    return { ...dataset, fill: false, powerFill: { target } };
  });
}

/** Paint pixel coordinates in one pass, using the same horizontal-then-vertical
 * forward steps as Chart.js stepped:true. The lower boundary walks backwards.
 * Every null, skipped point or stopped segment breaks the supported band. */
export function fillSteppedBand(ctx, upper = [], lower) {
  const origin = finite(lower);
  if (!origin && (!Array.isArray(lower) || lower.length !== upper.length)) return 0;
  const bottom = index => origin ? { x: upper[index].x, y: lower } : lower[index];
  const valid = index => {
    const top = upper[index], base = bottom(index);
    return top && base && !top.skip && !base.skip && finite(top.x) && finite(top.y)
      && finite(base.y) && base.x === top.x;
  };
  let start = -1, count = 0;
  ctx.beginPath();
  function close(end) {
    if (start < 0 || end <= start) return;
    ctx.moveTo(upper[start].x, upper[start].y);
    for (let index = start + 1; index <= end; index++) {
      ctx.lineTo(upper[index].x, upper[index - 1].y);
      ctx.lineTo(upper[index].x, upper[index].y);
    }
    ctx.lineTo(bottom(end).x, bottom(end).y);
    for (let index = end - 1; index >= start; index--) {
      ctx.lineTo(bottom(index + 1).x, bottom(index).y);
      ctx.lineTo(bottom(index).x, bottom(index).y);
    }
    ctx.closePath(); count++;
  }
  for (let index = 0; index <= upper.length; index++) {
    const supported = index < upper.length && valid(index);
    if (!supported || upper[index].stop || !origin && lower[index].stop) {
      close(index - 1); start = -1;
    }
    if (supported && start < 0) start = index;
  }
  if (count) ctx.fill('nonzero');
  return count;
}

export const powerFillPlugin = {
  id: 'powerBands',
  beforeDatasetDraw(chart, { index, meta }) {
    const dataset = chart.data.datasets[index], configuration = dataset.powerFill;
    if (!configuration || !chart.chartArea) return;
    const target = configuration.target;
    if (target !== 'origin' && !chart.isDatasetVisible(target)) return;
    const lower = target === 'origin' ? meta.vScale.getBasePixel() : chart.getDatasetMeta(target).data;
    const { ctx, chartArea } = chart;
    ctx.save(); ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top); ctx.clip();
    ctx.fillStyle = meta.dataset.options.backgroundColor;
    fillSteppedBand(ctx, meta.data, lower);
    ctx.restore();
  },
};
