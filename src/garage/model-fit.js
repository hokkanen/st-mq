// One duration-weighted cooling coefficient per measured location. Fixed-size
// sufficient statistics preserve rare OFF evidence across ordinary ON operation.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function createGarageRegression(specs) {
  return { values: specs.map(spec => spec[1]), evidence: specs.map(() => 0), samples: 0, hours: 0,
    active: specs.map(() => false), fitted: specs.map(() => false), information: 0,
    statistics: { off: { hours: 0, xx: 0, xy: 0 } } };
}
export function fitGarageRegression(reg, specs, features, rate, hours, regime = 'off') {
  if (regime !== 'off' || specs.length !== 1 || features.length !== 1
    || !Number.isFinite(rate) || !Number.isFinite(features[0]) || !(hours > 0)
    || Math.abs(features[0]) < 2) return;
  const source = reg.statistics.off, timeConstant = 48 / Math.LN2;
  const retain = Math.exp(-hours / timeConstant), weight = timeConstant * (1 - retain);
  source.hours = source.hours * retain + weight;
  source.xx = source.xx * retain + features[0] ** 2 * weight;
  source.xy = source.xy * retain + features[0] * rate * weight;
  reg.samples++; reg.hours += hours; reg.evidence[0] += hours; reg.information = source.xx;
  if (source.hours < .25 || source.xx < 1) return;
  // A small declared regularizer prevents one nearly flat interval from erasing
  // the conservative seed. Only clean OFF intervals can change this estimate.
  reg.values[0] = clamp((source.xy + 2 * specs[0][1]) / (source.xx + 2), specs[0][2], specs[0][3]);
  reg.active[0] = true; reg.fitted[0] = true;
}
