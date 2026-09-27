import { historyValueLabel, coefficientStatusLabel, firewoodPointDetail, sessionPointDetail } from './history-model.js';
import { outdoorSourceLabel, providerName, temperatureAttentionDetails } from './provider-status.js';
import { Interaction } from 'chart.js';
import { getRelativePosition } from 'chart.js/helpers';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
function timeRange(start, end) {
  const offset = at => dateTime.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
  // Intl.formatRange can collapse the repeated autumn hour to a single offset.
  // Preserve both actual offsets whenever a recorded interval crosses DST.
  return offset(start) === offset(end) ? dateTime.formatRange(start, end)
    : `${dateTime.format(start)} – ${dateTime.format(end)}`;
}

const outcomeBases = new Map([
  ['continuously-available-achieved-reference', 'achieved normal-heating reference; not a thermostat setting'],
  ['rolling-clean-held-out-off-episode-rmse', 'rolling clean held-out OFF-episode RMSE; lower is better'],
  ['garage-frozen-normal-reference', 'frozen normal-reference model estimate; positive is benefit, negative is extra cost'],
]);
const outcomeElectricityBases = new Map([
  ['qualified-recorded-electricity', 'qualified recorded electricity'],
  ['recorded-and-modeled-electricity', 'recorded and modelled electricity'],
  ['modeled-native-electricity', 'modelled native electricity'],
]);
const outcomeNumber = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
function garageOutcomeDetails(key, raw) {
  const episode = key === 'garage_outcome_benefit';
  const details = [episode ? 'completed episode estimate' : 'replayed model outcome',
    outcomeBases.get(raw.outcomeBasis) ?? 'outcome basis unavailable'];
  if (raw.inputSource) details.push(raw.inputSource);
  if (Number.isFinite(raw.modelUpdatedAt)) details.push(`model updated ${dateTime.format(raw.modelUpdatedAt)}`);
  if (/^[a-f\d]{64}$/.test(raw.correctionRevision)) details.push(`correction revision ${raw.correctionRevision.slice(0, 12)}`);
  if (Number.isFinite(raw.evidenceCount)) details.push(`${outcomeNumber.format(raw.evidenceCount)} ${key.endsWith('_error')
    ? 'clean held-out OFF validation episodes' : 'normal-heating samples'}`);
  if (Number.isFinite(raw.evidenceHours)) details.push(`${outcomeNumber.format(raw.evidenceHours)} h ${key.endsWith('_error')
    ? 'held-out OFF evidence' : 'qualified normal-heating evidence'}`);
  if (episode) {
    if (raw.provisional === true) details.push('provisional model estimate');
    details.push(outcomeElectricityBases.get(raw.electricityBasis) ?? 'electricity basis unavailable');
    for (const [field, label] of [['referenceCostEuro', 'frozen reference cost'], ['actualCostEuro', 'assessed actual cost'],
      ['uncertaintyEuro', 'model uncertainty']])
      if (Number.isFinite(raw[field])) details.push(`${label} ${outcomeNumber.format(raw[field])} €`);
  }
  return details;
}

/** Only committed input quality describes learning eligibility. A raw sensor,
 * forecast or model result cannot tell whether an observation trained a model. */
export function historyLearningLabel(key, point = {}) {
  if (point.sessionCheck || point.auditOnly || key.startsWith('caravan_')) return 'not used for learning';
  if (!point.modelInput || key === 'model_fireplace_release') return '';
  if (point.garageModelInput) return point.inputQualified === true
    ? 'qualified recorded input; fitting depends on the interval and episode'
    : point.inputQualified === false ? 'input unavailable or unqualified' : 'input qualification unavailable';
  return point.learningUsable === true ? 'recorded input quality usable; thermal fitting needs observed heat, sunshine and fresh endpoints'
    : point.learningUsable === false ? 'recorded input quality excluded' : 'recorded input quality unavailable';
}

function timeContext(item) {
  const raw = item.raw ?? {};
  // An indoor average is an endpoint reading, although its journal also names
  // the preceding learning window. Session and interval totals describe spans.
  const start = raw.sessionCheck ? raw.sessionStart : raw.intervalStart;
  const end = raw.sessionCheck ? raw.sessionEnd : raw.intervalEnd;
  if (!raw.carriedForward && item.dataset.key !== 'model_indoor_temperature'
    && Number.isFinite(start) && Number.isFinite(end) && end > start)
    return { start, end };
  return { start: item.parsed.x, end: item.parsed.x };
}

/** Keep every series available in shared hover. Different recorded periods are
 * grouped and named in the title instead of repeating dates after the values. */
export function historyTooltipTitle(items) {
  const groups = new Map();
  for (const item of items) {
    const context = timeContext(item);
    if (!Number.isFinite(context.start)) continue;
    const key = `${context.start}:${context.end}`, group = groups.get(key) ?? { ...context, names: [] };
    if (!group.names.includes(item.dataset.label)) group.names.push(item.dataset.label);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => `${groups.size > 1 ? `${group.names.join(', ')}: ` : ''}${group.start === group.end
    ? dateTime.format(group.start) : timeRange(group.start, group.end)} · Finland`);
}

export function historyTooltipLabel(item) {
  const { key } = item.dataset, raw = item.raw ?? {}, details = [];
  const source = raw.modelInput || raw.modelOutcome ? null : key === 'outdoor_temperature' ? outdoorSourceLabel(raw.source) : providerName(raw.source);
  if (source) details.push(source);
  if (raw.modelCoefficient) {
    details.push('model result', coefficientStatusLabel(raw.coefficientStatus));
    if (raw.inputSource) details.push(raw.inputSource);
    if (Number.isFinite(raw.modelUpdatedAt)) details.push(`model updated ${dateTime.format(raw.modelUpdatedAt)}`);
    if (Number.isFinite(raw.evidenceHours)) details.push(`input evidence at that update: ${new Intl.NumberFormat('en-GB',
      { maximumFractionDigits: 2 }).format(raw.evidenceHours)} h`);
  }
  if (raw.modelOutcome) details.push(...garageOutcomeDetails(key, raw));
  const firewood = firewoodPointDetail(key, raw);
  if (firewood) details.push(firewood);
  else if (raw.modelInput) details.push(raw.savedIndoorAverage ? 'saved indoor average'
    : raw.garageModelInput ? 'saved garage input' : 'saved learning input');
  else if (key.startsWith('learning_')) details.push('model assessment');
  else if (key === 'heat_pump_power') details.push('reconstructed estimate');
  else if (key === 'caravan_energy') {
    details.push('meter energy over the recorded interval');
  }
  else if (key === 'garage_native_energy') details.push('cumulative native meter counter; not interval consumption');
  else if (key === 'garage_energy') {
    details.push(raw.basis === 'counter-delta' ? 'native meter difference over the recorded interval'
      : raw.basis === 'power-trapezoid' ? 'integrated reported power over the recorded interval' : 'recorded interval energy; measurement basis unavailable');
    if (raw.provisional) details.push('provisional estimate');
    details.push(raw.accuracyVerified === true ? 'accuracy verified' : 'accuracy unverified');
  }
  else if (raw.equivalentCurrent) details.push('interval average', 'equivalent at 230 V');
  else if (['property_power', 'charger_power', 'charger2_power', 'caravan_power'].includes(key) && Number.isFinite(raw.intervalStart)) details.push('interval average from recorded energy');
  else if (key.endsWith('_energy') || /_energy_l[123]$/.test(key)) details.push('recorded interval energy');
  else if (key === 'solar_radiation') details.push('historical solar estimate from the forecast available at the time');
  else if (key.endsWith('_forecast')) details.push('forecast');
  if (raw.assumedPrice) details.push('assumed price');
  const session = sessionPointDetail(raw);
  if (session) details.push(session);
  else if (raw.auditOnly) details.push('meter check only');
  const learning = historyLearningLabel(key, raw);
  if (learning) details.push(learning);
  if (raw.displayBoundary) details.push(`${raw.interpolated ? 'interpolated' : 'held'} display boundary; not a measurement`);
  if (raw.savedIndoorAverage && (raw.held || raw.needsAttention)) {
    if (raw.needsAttention) details.push('needs attention');
    const sensors = temperatureAttentionDetails(raw.attentionSensors, at => dateTime.format(at), { now: raw.intervalEnd ?? raw.x });
    details.push(`using last known readings${sensors ? `: ${sensors}` : ''}`);
  }
  if (raw.carriedForward && Number.isFinite(raw.observedAt)) details.push(`last recorded ${dateTime.format(raw.observedAt)}`);
  const value = historyValueLabel(key, raw.componentValue ?? item.parsed.y, item.dataset.unit);
  return `${item.dataset.label}: ${value}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}

/** Canvas tooltips do not wrap automatically. Use the actual font metrics so
 * the same provenance remains readable on fullscreen phones and on desktops. */
export function wrapHistoryTooltip(lines, chart, { bold = false } = {}) {
  const source = Array.isArray(lines) ? lines : [lines];
  if (!chart?.ctx || !Number.isFinite(chart.width)) return source;
  const width = Math.max(90, Math.min(520, chart.width - 52)), ctx = chart.ctx;
  const font = chart.options.font ?? {};
  ctx.save(); ctx.font = `${bold ? 'bold ' : ''}12px ${font.family ?? 'sans-serif'}`;
  try {
    return source.flatMap(line => {
      const wrapped = []; let current = '';
      for (const word of line.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(next).width > width) { wrapped.push(current); current = word; }
        else current = next;
      }
      if (current) wrapped.push(current);
      return wrapped;
    });
  } finally { ctx.restore(); }
}

export function historyTooltipsEnabled({ fullscreen, coarsePointer }) {
  return Boolean(fullscreen || !coarsePointer);
}

/** Large report markers own their generous hit targets even beside dense price
 * points. Other genuine points use XY distance, so vertically aligned readings
 * cannot steal a direct hit. Outside all targets retain shared nearest-time hover. */
export function historyTooltipInteraction(chart, event, options, useFinalPosition) {
  const position = getRelativePosition(event, chart);
  const hits = Interaction.modes.point(chart, event, { ...options, axis: 'xy', includeInvisible: false }, useFinalPosition)
    .filter(({ datasetIndex, index }) => {
      const point = chart.data.datasets[datasetIndex]?.data[index];
      return point && !point.displayBoundary && !point.carriedForward && !point.displayContext && !point.interpolated;
    });
  const markers = hits.filter(({ element }) => element.options.radius >= 4);
  let nearest = [], distance = Infinity;
  for (const item of markers.length ? markers : hits) {
    const center = item.element.getCenterPoint(useFinalPosition);
    const candidate = Math.hypot(position.x - center.x, position.y - center.y);
    if (candidate < distance) { nearest = [item]; distance = candidate; }
    else if (candidate === distance) nearest.push(item);
  }
  return nearest.length ? nearest : Interaction.modes.nearest(chart, event, { ...options, axis: 'x', intersect: false }, useFinalPosition);
}

export const historyTooltipCallbacks = {
  title: items => wrapHistoryTooltip(historyTooltipTitle(items), items[0]?.chart, { bold: true }),
  label: item => wrapHistoryTooltip(historyTooltipLabel(item), item.chart),
};
