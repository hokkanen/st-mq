import { historyValueLabel, coefficientStatusLabel, firewoodPointDetail, sessionPointDetail } from './history-model.js';
import { outdoorSourceLabel, providerName, temperatureAttentionDetails } from './provider-status.js';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
function timeRange(start, end) {
  const offset = at => dateTime.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
  // Intl.formatRange can collapse the repeated autumn hour to a single offset.
  // Preserve both actual offsets whenever a recorded interval crosses DST.
  return offset(start) === offset(end) ? dateTime.formatRange(start, end)
    : `${dateTime.format(start)} – ${dateTime.format(end)}`;
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
  const source = raw.modelInput ? null : key === 'outdoor_temperature' ? outdoorSourceLabel(raw.source) : providerName(raw.source);
  if (source) details.push(source);
  if (raw.modelCoefficient) {
    details.push('model result', coefficientStatusLabel(raw.coefficientStatus));
    if (raw.inputSource) details.push(raw.inputSource);
    if (Number.isFinite(raw.modelUpdatedAt)) details.push(`model updated ${dateTime.format(raw.modelUpdatedAt)}`);
    if (Number.isFinite(raw.evidenceHours)) details.push(`input evidence at that update: ${new Intl.NumberFormat('en-GB',
      { maximumFractionDigits: 2 }).format(raw.evidenceHours)} h`);
  }
  const firewood = firewoodPointDetail(key, raw);
  if (firewood) details.push(firewood);
  else if (raw.modelInput) details.push(raw.savedIndoorAverage ? 'saved indoor average'
    : raw.garageModelInput ? 'saved garage input' : 'saved learning input');
  else if (key.startsWith('learning_')) details.push('model assessment');
  else if (key === 'heat_pump_power') details.push('reconstructed estimate');
  else if (key === 'caravan_energy') {
    details.push('meter energy over the recorded interval');
  }
  else if (raw.equivalentCurrent) details.push('interval average', 'equivalent at 230 V');
  else if (['property_power', 'charger_power', 'charger2_power'].includes(key) && Number.isFinite(raw.intervalStart)) details.push('interval average from recorded energy');
  else if (key.endsWith('_energy') || /_energy_l[123]$/.test(key)) details.push('recorded interval energy');
  else if (key.endsWith('_forecast') || key === 'solar_radiation') details.push(key === 'solar_radiation' ? 'archived forecast' : 'forecast');
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

export const historyTooltipCallbacks = {
  title: items => wrapHistoryTooltip(historyTooltipTitle(items), items[0]?.chart, { bold: true }),
  label: item => wrapHistoryTooltip(historyTooltipLabel(item), item.chart),
};
