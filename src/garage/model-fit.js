// Duration-weighted, stratified sufficient statistics. Routine operation cannot
// forget the rare OFF/recovery evidence merely by supplying more polling rows.
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function moments(size) {
  return { hours: 0, xx: Array.from({ length: size }, () => Array(size).fill(0)), xy: Array(size).fill(0) };
}
export function createGarageRegression(specs) {
  return { values: specs.map(spec => spec[1]), evidence: specs.map(() => 0), samples: 0, hours: 0,
    active: specs.map(() => false), fitted: specs.map(() => false), information: 0,
    statistics: Object.fromEntries(['normal', 'off', 'recovery'].map(key => [key, moments(specs.length)])) };
}
function combined(reg, only = null) {
  const result = moments(reg.values.length);
  for (const [key, source] of Object.entries(reg.statistics)) {
    if (only && key !== only) continue;
    // Preserve each regime's mean and at most 48 equivalent hours of influence.
    // The statistics have fixed size; no observations or per-poll snapshots grow.
    const weight = source.hours ? Math.min(1, 48 / source.hours) : 0;
    result.hours += source.hours * weight;
    for (let i = 0; i < result.xy.length; i++) {
      result.xy[i] += source.xy[i] * weight;
      for (let j = 0; j < result.xy.length; j++) result.xx[i][j] += source.xx[i][j] * weight;
    }
  }
  return result;
}
function solve(reg, specs, data, indices) {
  const priorStrength = index => specs[index][0].includes('loss') || specs[index][0].includes('Loss') ? 100 : .25;
  const matrix = indices.map(i => indices.map(j => data.xx[i][j] + (i === j ? priorStrength(i) : 0)));
  const rhs = indices.map(i => data.xy[i] - dot(data.xx[i], reg.values.map((value, j) => indices.includes(j) ? 0 : value))
    + priorStrength(i) * specs[i][1]);
  const values = [...rhs];
  for (let i = 0; i < indices.length; i++) {
    const pivot = matrix[i][i];
    if (!(pivot > 1e-10)) return;
    for (let j = i + 1; j < indices.length; j++) {
      const ratio = matrix[j][i] / pivot;
      for (let k = i; k < indices.length; k++) matrix[j][k] -= ratio * matrix[i][k];
      values[j] -= ratio * values[i];
    }
  }
  for (let i = indices.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < indices.length; j++) values[i] -= matrix[i][j] * values[j];
    values[i] /= matrix[i][i];
  }
  indices.forEach((index, i) => { reg.values[index] = clamp(values[i], specs[index][2], specs[index][3]); reg.active[index] = true; reg.fitted[index] = true; });
}
export function fitGarageRegression(reg, specs, features, rate, hours, regime, kind, { allowDemand = false } = {}) {
  if (!Number.isFinite(rate) || !(hours > 0) || !features.every(Number.isFinite)) return;
  const source = reg.statistics[regime];
  // Adapt only when this physical regime provides new qualified evidence.
  // Ninety-six hours of ON data cannot age a single retained OFF observation.
  const timeConstant = (regime === 'off' ? 48 : 96) / Math.LN2;
  const retain = Math.exp(-hours / timeConstant), weightedHours = timeConstant * (1 - retain);
  source.hours = source.hours * retain + weightedHours; reg.hours += hours; reg.samples++;
  for (let i = 0; i < features.length; i++) {
    source.xy[i] *= retain;
    for (let j = 0; j < features.length; j++) source.xx[i][j] *= retain;
  }
  for (let i = 0; i < features.length; i++) {
    source.xy[i] += features[i] * rate * weightedHours;
    if (Math.abs(features[i]) > .005) reg.evidence[i] += hours;
    for (let j = 0; j < features.length; j++) source.xx[i][j] += features[i] * features[j] * weightedHours;
  }
  const data = combined(reg);
  if (kind === 'rear') {
    const heat = reg.evidence[2] >= 2 || reg.evidence[2] >= reg.evidence[3] ? 2 : 3;
    const a = data.xx[0][0], b = data.xx[heat][heat], cross = data.xx[0][heat];
    reg.information = a > 0 && b > 0 ? Math.max(0, 1 - cross * cross / (a * b)) : 0;
    // A repeatedly nonzero input is not independent heating/loss information.
    if (reg.hours >= 4 && reg.information >= .01 && b >= .1) solve(reg, specs, data, [0, heat]);
    else if (reg.statistics.off.hours >= .25) solve(reg, specs, combined(reg, 'off'), [0]);
    if (reg.active[0] && !reg.active[heat] && b >= .25 && reg.statistics.off.hours >= .5)
      solve(reg, specs, data, [heat]);
    // Power and activity are alternative input paths, not two simultaneous fits.
    const other = heat === 2 ? 3 : 2;
    reg.active[other] = false;
  } else if (kind === 'front') {
    if (reg.hours >= 2 && data.xx[1][1] >= 1) solve(reg, specs, data, [1]);
  } else {
    const ordinary = combined(reg, 'normal');
    const weight = ordinary.xx[0][0];
    const spread = weight ? Math.max(0, ordinary.xx[1][1] / weight - (ordinary.xx[0][1] / weight) ** 2) : 0;
    reg.information = spread;
    if (ordinary.hours >= 12 && spread >= 9) solve(reg, specs, ordinary, [0, 1]);
    else if (ordinary.hours >= 2) solve(reg, specs, ordinary, [0]);
    const recovery = combined(reg, 'recovery');
    if (allowDemand && reg.active[0] && recovery.hours >= 1 && recovery.xx[2][2] >= .3)
      solve(reg, specs, recovery, [2]);
  }
}
