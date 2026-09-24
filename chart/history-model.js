import { stackPowerSeries } from './power-stack.js';
import { isInterpolatedTemperature } from '../src/domain/chart-temperatures.js';
import { temperatureIntervalKnots } from './temperature-curves.js';
import { HISTORY_AXES, CARAVAN_RUNNING_STATES, GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO, SIGNAL_INFO, MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO, PHASE_ENERGY_SIGNALS, RIGHT_AXIS_SIGNALS } from '../src/domain/history-series.js';
// Calendar navigation always refers to the house, regardless of browser timezone.
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
const hourInFinland = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', hourCycle: 'h23' });
export function finnishDate(timestamp = Date.now()) {
  const parts = Object.fromEntries(calendar.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

export function shiftDate(date, days) {
  if (!validDate(date) || !Number.isInteger(days)) throw new RangeError('Choose a valid calendar date.');
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function selectedRange(preset, now) {
  const today = finnishDate(now);
  if (preset === 'yesterday') return { startDate: shiftDate(today, -1), endDate: today };
  if (preset === 'tomorrow') return { startDate: today, endDate: shiftDate(today, 1) };
  return { startDate: today, endDate: today };
}

/** A new start shows one day immediately; the end may then extend it. */
export function dateSelection(selection, field, value) {
  if (!validDate(value)) return null;
  if (field === 'start') return { startDate: value, endDate: value };
  if (field === 'end' && value >= selection.startDate) return { startDate: selection.startDate, endDate: value };
  return null;
}

function finnishMidnight(date) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  // Finnish DST changes occur after local midnight. The UTC-midnight offset
  // therefore also describes the beginning of that Finnish calendar day.
  return utcMidnight - Number(hourInFinland.format(utcMidnight)) * 3_600_000;
}

export function calendarTicks(range, maxTicks = 9) {
  const days = Math.round((Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) / 86_400_000) + 1;
  const ticks = [range.from];
  if (days <= 3) {
    const wanted = (range.to - range.from) / 3_600_000 / (maxTicks - 1);
    const step = [1, 2, 3, 4, 6, 12, 24].find(value => value >= wanted) ?? 24;
    for (let at = range.from + 3_600_000; at < range.to; at += 3_600_000) {
      if (Number(hourInFinland.format(at)) % step === 0) ticks.push(at);
    }
  } else {
    const step = Math.max(1, Math.ceil(days / (maxTicks - 1)));
    for (let index = step; index < days; index += step) ticks.push(finnishMidnight(shiftDate(range.startDate, index)));
  }
  ticks.push(range.to);
  return ticks.map(value => ({ value }));
}

export const defaultVisibility = Object.freeze({ heatOff: true, compressorSpace: true, compressorDhw: true, compressorGarage: true, operatingMode: true, dhwr: true, fireplace: true, spot_price: true });
export const leftGroups = Object.freeze({
  ...Object.fromEntries(HISTORY_AXES.map(axis => [axis.key, axis.signals])),
  power: ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power'],
  phases: ['property_current_l1', 'property_current_l2', 'property_current_l3', 'ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3'],
  integral: ['heating_integral'],
  learning_profit: ['learning_profit'],
  learning_aux_profit: ['learning_aux_profit'],
  learning_recovery_error: ['learning_recovery_error'],
  learning_indoor_temperature: ['learning_indoor_temperature'],
  solar_radiation: ['solar_radiation', 'solar_forecast'],
});
export const leftTitles = Object.freeze({ power: 'Power · kW', phases: 'Current · A', integral: 'Heating integral · °min',
  ...Object.fromEntries(HISTORY_AXES.map(axis => [axis.key, `${axis.label} · ${axis.unit}`])),
  temperatures: 'Air temperature · °C',
  learning_profit: 'Estimated space-heating benefit · €/cycle', learning_aux_profit: 'Space-heating benefit with auxiliary recovery · €/cycle',
  learning_recovery_error: 'Space-heating recovery-cost prediction error · €/cycle', learning_indoor_temperature: 'Learned normal temperature · °C',
  solar_radiation: 'Solar radiation forecast · W/m²' });
export const operationModes = Object.freeze({ 0: 'Off', 1: 'Auto', 2: 'Compressor only', 3: 'Auxiliary only', 4: 'Hot water only' });
export const defaultPalette = Object.freeze({
  text: '#e0ede6', muted: '#9bb4a5', border: '#334d3e', grid: '#243c30',
  property: '#e98576', ev: '#e98576', ev2: '#b493db', auxiliary: '#e86868', phase1: '#66cbd0', phase2: '#cf94d3', phase3: '#dfc16c',
  indoor: '#81ca99', upstairs: '#e99583', downstairs: '#e5cb75', bedroom: '#d3b7ed', garage: '#eda65e', outdoor: '#83b8da', integral: '#cea0dc', price: '#ffffff', spot: '#c5c5c5',
  heatOff: '#9ba89e', compressorSpace: '#dbc754', compressorDhw: '#549edd', dhwr: '#e05555', learning: '#baa0de', solar: '#e4ca67',
  firewood: '#d8aa75', fireplace: '#b79b28',
});

export function visible(key, preferences = {}) {
  return preferences[key] ?? defaultVisibility[key] ?? true;
}

const seriesInfo = {
  property_power: ['Property', 'kW · interval average from recorded energy; older history uses 230 V × current', 'property'],
  charger_power: ['Charger 1', 'kW · interval average from recorded energy; older history uses 230 V × current', 'ev', 'fill'],
  charger2_power: ['Charger 2', 'kW · interval average from recorded total energy; phase distribution unknown', 'ev2', 'fill'],
  caravan_energy: ['Caravan energy', 'kWh · measured meter energy over the recorded interval', 'garage', 'interval-energy'],
  caravan_temperature: ['Caravan air', '°C', 'garage'],
  caravan_humidity: ['Caravan relative humidity', '%', 'outdoor'],
  caravan_dehumidifier_running_state: ['Caravan dehumidifier', 'state · reported running state', 'garage'],
  ev2_energy: ['Charger 2 total energy', 'kWh · physical Shelly EVSE meter difference over the recorded interval', 'ev2', 'interval-energy'],
  ev1_session_energy_check: ['Charger 1', 'kWh · finalized session electricity reading', 'ev', 'session'],
  shelly_session_energy_check: ['Charger 2', 'kWh · finalized physical charging session electricity', 'ev2', 'session'],
  auxiliary_power: ['Auxiliary heat', 'kW · estimated from H66 output and configured capacity', 'auxiliary', 'fill'],
  property_current_l1: ['Property L1', 'A', 'phase1'],
  property_current_l2: ['Property L2', 'A', 'phase2'],
  property_current_l3: ['Property L3', 'A', 'phase3'],
  ev1_current_l1: ['Charger 1 L1', 'A', 'phase1', 'fill'],
  ev1_current_l2: ['Charger 1 L2', 'A', 'phase2', 'fill'],
  ev1_current_l3: ['Charger 1 L3', 'A', 'phase3', 'fill'],
  heating_integral: ['Heating integral', '°min', 'integral'],
  learning_profit: ['Space-heating benefit after recovery', '€/cycle · estimated completed-cycle mean; hot-water service excluded', 'learning', 'learning'],
  learning_aux_profit: ['Space-heating benefit with auxiliary recovery', '€/cycle · observed space-heating auxiliary recovery cycles only', 'learning', 'learning'],
  learning_recovery_error: ['Space-heating recovery-cost prediction error', '€/cycle · mean absolute error; lower is better', 'learning', 'learning'],
  learning_indoor_temperature: ['Learned normal temperature', '°C · learned reference, not a thermostat command', 'learning', 'learning'],
  firewood_savings: ['Firewood electricity cost avoided', '€/day · retrospective model estimate; wood cost €0', 'firewood', 'daily'],
  firewood_electricity_avoided: ['Firewood electricity avoided', 'kWh/day · retrospective model estimate, not metered savings', 'firewood', 'daily'],
  solar_radiation: ['Archived solar forecast', 'W/m² · forecast archived at the time, not a measured solar sensor', 'solar', 'learning'],
  solar_forecast: ['Solar forecast', 'W/m² · forecast', 'solar', 'forecast'],
  indoor_temperature: ['Upstairs', '°C', 'upstairs'],
  downstairs_temperature: ['Downstairs', '°C', 'downstairs'],
  bedroom_temperature: ['Bedroom', '°C', 'bedroom'],
  garage_temperature: ['Garage rear', '°C', 'garage'],
  garage_temperature_2: ['Garage front', '°C', 'garage'],
  outdoor_temperature: ['Outdoor', '°C · FMI station or Open-Meteo model estimate; dashed line is forecast', 'outdoor'],
  outdoor_forecast: ['Outdoor forecast', '°C · forecast', 'outdoor', 'forecast'],
  all_in_price: ['All-in price', 'c/kWh', 'price'],
  spot_price: ['Spot price', 'c/kWh · excludes VAT and other charges', 'spot'],
};
for (const [signal, info] of Object.entries(SIGNAL_INFO)) {
  seriesInfo[signal] ??= [info.label, `${info.unit} · ${info.detail ?? info.kind.toLowerCase()}`,
    PHASE_ENERGY_SIGNALS.includes(signal) ? `phase${signal.at(-1)}` : signal.startsWith('ev1') ? 'ev' : signal.startsWith('property') ? 'property' : info.group === 'Ground loop' ? 'outdoor' : info.group === 'Garage heat pump' ? 'garage' : 'integral',
    PHASE_ENERGY_SIGNALS.includes(signal) ? 'interval-energy' : 'line'];
}
Object.assign(seriesInfo, {
  heat_pump_power: ['Heat pump', 'kW · reconstructed estimated electrical input', 'auxiliary'],
  controller_phase: ['Requested phase', 'state · 0 normal, 1 preheat, 2 reduction, 3 recovery', 'learning'],
  dhwr_request: ['Recirculation request', 'state · requested, not confirmed flow', 'learning'],
});
for (const [signal, info] of Object.entries({ ...MODEL_INPUT_INFO, ...MODEL_COEFFICIENT_INFO, ...GARAGE_INPUT_INFO, ...GARAGE_COEFFICIENT_INFO }))
  seriesInfo[signal] = [info.label, `${info.unit} · ${info.detail}`, info.color, signal === 'firewood_load' ? 'event' : 'line'];

export function firewoodPointDetail(key, point = {}) {
  if (key === 'firewood_load') return `Recorded manual ${point.loadCount > 1 ? `total of ${point.loadCount} additions at this time` : 'addition'} · corrected history`;
  if (key === 'model_fireplace_release') return 'Calculated delayed release · fuel equivalent, not measured heat';
  if (!['firewood_savings', 'firewood_electricity_avoided'].includes(key)) return '';
  const status = point.status === 'validated' ? 'Validated model estimate' : point.status === 'unavailable' ? 'Estimate unavailable' : 'Provisional model estimate';
  const coverage = Number.isFinite(point.coverage) ? ` · ${Math.round(Math.max(0, Math.min(1, point.coverage)) * 100)}% of elapsed time included` : '';
  return `${status} · retrospective daily total${coverage}${key === 'firewood_savings' ? ' · wood cost €0' : ''}`;
}

/** Shared right-axis readings must not conceal an empty selected left axis. */
export function leftAxisAvailability(datasets) {
  const left = datasets.filter(dataset => dataset.yAxisID === 'left');
  if (!left.some(dataset => dataset.data.some(point => Number.isFinite(point.y)))) return 'No recorded values for the selected left axis in these dates';
  if (!left.some(dataset => !dataset.hidden && dataset.data.some(point => Number.isFinite(point.y)))) return 'Selected left-axis values are hidden in the legend';
  return '';
}

export function historyStateLabel(key, value) {
  if (key === 'caravan_dehumidifier_running_state') return CARAVAN_RUNNING_STATES[value] ?? 'Unknown';
  if (/^garage_door[12]_open$/.test(key)) return value === 1 ? 'Open' : value === 0 ? 'Closed' : `Unknown (${value})`;
  if (key === 'operating_mode') return operationModes[value] ?? `Unknown mode (${value})`;
  if (['controller_phase', 'model_controller_phase'].includes(key))
    return ['Normal', 'Preheat', 'Tariff reduction', 'Recovery'][value] ?? `Unknown phase (${value})`;
  if (key === 'dhw_routing') return value === 0 ? 'Space heating' : value === 1 ? 'Hot water' : `Unknown route (${value})`;
  if (key === 'garage_model_available') return value === 1 ? 'Available to native control' : value === 0 ? 'Reported off' : 'Unknown';
  if (['compressor_active', 'garage_compressor_active', 'heating_pump_active', 'alarm_active'].includes(key)) return value === 1 ? 'Active' : value === 0 ? 'Inactive' : `Unknown (${value})`;
  if (key === 'model_valve_override') return ['Normal valve mode', 'Pooled override confirmed', 'Partial override', 'Unconfirmed override'][value] ?? 'Unknown valve mode';
  if (key === 'dhwr_request') return value === 1 ? 'On requested' : value === 0 ? 'Off requested' : `Unknown (${value})`;
  return null;
}

export function historyValueLabel(key, value, unit) {
  const state = historyStateLabel(key, value);
  if (state) return state;
  const digits = (MODEL_COEFFICIENT_INFO[key] ?? GARAGE_COEFFICIENT_INFO[key])?.digits;
  return `${new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 2 }).format(value)} ${unit.split(' · ')[0]}`;
}

export function coefficientStatusLabel(status) {
  return { observed: 'Recorded normal-heating average', fitted: 'Fitted in current model', retained: 'Retained from an earlier fit',
    'fixed-prior': 'Fixed assumption', initial: 'Initial estimate — not validated' }[status] ?? 'Coefficient status unavailable';
}

export function sessionPointDetail(point = {}) {
  if (!point.sessionCheck) return '';
  const basis = 'session electricity meter';
  return `${basis} · ${point.comparisonEligible ? 'included in session averages' : 'excluded from session averages: incomplete comparison'}`;
}

// Learning and H66 output have their own bounded/recorded-state semantics.
const heldReadingKeys = ['property_power', 'charger_power', 'charger2_power', ...leftGroups.phases, 'heating_integral', 'indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature', 'caravan_temperature', 'caravan_humidity', 'caravan_dehumidifier_running_state'];

/** Advance display tails without changing source timestamps or cached history. */
export function historySeriesAt(payload, now = payload.now) {
  const { range, series = {}, meta = {} } = payload;
  if (!Number.isFinite(now) || now < range.from || now >= range.to) return series;
  const projected = { ...series };
  for (const key of heldReadingKeys) {
    if (!Object.hasOwn(series, key)) continue;
    const points = series[key];
    const last = meta.lastReadings?.[key] ?? points.at(-1);
    if (!last || !Number.isFinite(last.x) || !Number.isFinite(last.y) || last.x > now) continue;
    if (key.startsWith('caravan_') && !last.periodicCoverage) continue;
    // Explicit missing/invalid readings remain breaks, even if older metadata
    // was paired with a newer series. Never bridge a missing final sample.
    const end = points.at(-1);
    if (end && (end.x > now || !Number.isFinite(end.y) || end.x > last.x)) continue;
    const start = Math.max(range.from, last.x);
    const until = last.periodicCoverage ? Math.min(now, last.reportExpiresAt-1) : now;
    const carried = x => ({ ...last, x, y: last.y, carriedForward: true, observedAt: last.observedAt??last.x });
    const tail = [];
    if (!end && start <= until) tail.push(carried(start));
    if (until > (end?.x ?? start)) tail.push(carried(until));
    if (last.periodicCoverage && now>=last.reportExpiresAt)
      tail.push({...last,x:Math.max(range.from,last.reportExpiresAt),y:null,displayBoundary:true});
    if (tail.length) projected[key] = [...points, ...tail];
  }
  return projected;
}

/** Align displayed step segments, preserving both sides of duplicate edges and
 * explicit gaps. This changes presentation only; original readings and interval
 * provenance remain attached to every point used in the cumulative fill. */
export function stackedPowerSeries(auxiliary = [], charger = []) {
  const [alignedAuxiliary, alignedCharger] = stackPowerSeries([auxiliary, charger]);
  return { auxiliary: alignedAuxiliary, charger: alignedCharger };
}

export function historyDatasets(series = {}, left = 'power', preferences = {}, palette = defaultPalette) {
  if (!leftGroups[left]) throw new RangeError('Choose a valid left axis.');
  const keys = [...new Set([...leftGroups[left], ...RIGHT_AXIS_SIGNALS])];
  const powerKeys = ['auxiliary_power', 'charger_power', 'charger2_power'];
  const stackedData = new Map(), stackBases = new Map();
  if (left === 'power') {
    let group = [];
    for (const key of powerKeys) {
      if (!visible(key, preferences) || !(series[key] ?? []).some(point => Number.isFinite(point.y))) continue;
      const next = [...group, key];
      const aligned = stackPowerSeries(next.map(component => series[component]));
      if (next.length > 1 && aligned.at(-1).some(point => Number.isFinite(point.y))) {
        group = next;
        group.forEach((component, index) => {
          stackedData.set(component, aligned[index]);
          if (index) stackBases.set(component, group[index - 1]);
        });
      } else {
        // Without any shared observations, retain this load at its recorded
        // power. A following load can still stack on that supported baseline.
        group = [key];
      }
    }
  }
  return keys.map(key => {
    const [label, unit, colorKey, kind = 'line'] = seriesInfo[key];
    const visibilityKey = key === 'outdoor_forecast' ? 'outdoor_temperature' : key;
    const isLeft = leftGroups[left].includes(key) && !(left === 'temperatures' && RIGHT_AXIS_SIGNALS.includes(key));
    const isPrice = key.endsWith('_price');
    const temperature = isInterpolatedTemperature(key);
    const original = stackedData.get(key) ?? series[key] ?? [];
    const data = ['outdoor_forecast', 'model_outdoor_temperature'].includes(key) ? temperatureIntervalKnots(original) : original;
    const stackBase = stackBases.get(key);
    return {
      key, visibilityKey, unit, kind, label,
      data,
      ...(powerKeys.includes(key) ? { powerStacked: Boolean(stackBase), powerStackBase: stackBase ?? null } : {}),
      showLine: !['event', 'daily', 'session', 'interval-energy'].includes(kind),
      yAxisID: isLeft ? 'left' : 'right',
      borderColor: palette[colorKey], backgroundColor: palette[colorKey],
      borderWidth: kind === 'fill' ? 0 : isPrice ? 1 : isLeft ? 1.25 : 1.5,
      borderDash: kind === 'forecast' || PHASE_ENERGY_SIGNALS.includes(key) && key.startsWith('ev1') ? [5, 4] : isPrice ? [1, 3] : [],
      fill: stackBase ? keys.indexOf(stackBase) : kind === 'fill' ? 'origin' : false,
      order: powerKeys.includes(key) ? 4 - powerKeys.indexOf(key) : kind === 'fill' ? 2 : 1,
      pointBackgroundColor: kind === 'daily' ? data.map(point => point.status === 'validated' ? palette[colorKey] : 'transparent')
        : kind === 'session' ? data.map(point => point.comparisonEligible ? palette[colorKey] : 'transparent') : palette[colorKey], pointBorderColor: palette[colorKey],
      pointStyle: kind === 'event' ? 'triangle' : kind === 'daily' ? 'rectRot' : isLeft && !['session', 'interval-energy', 'fill'].includes(kind) ? 'rect' : 'circle',
      // A finite reading surrounded by gaps has no line segment to draw.
      pointRadius: kind === 'event' ? 5 : ['daily', 'session', 'interval-energy'].includes(kind) ? 4 : isPrice ? 1 : data.map((point, index) => Number.isFinite(point.y)
        && !Number.isFinite(data[index - 1]?.y) && !Number.isFinite(data[index + 1]?.y) ? 2
        : isLeft && kind !== 'fill' && Number.isFinite(point.y) && index % Math.max(1, Math.ceil(data.length / 12)) === 0 ? 1.6 : 0),
      pointHoverRadius: kind === 'event' ? 7 : ['daily', 'session', 'interval-energy'].includes(kind) ? 6 : 3, pointHitRadius: 8,
      // Duplicate interval-edge points from the API retain exact price/forecast steps.
      stepped: temperature ? false : isPrice ? 'before' : kind === 'forecast' || isLeft && left !== 'integral' && !PHASE_ENERGY_SIGNALS.includes(key),
      // Chart.js' monotone cubic Hermite interpolation is O(n), preserves local
      // extrema and never overshoots adjacent values. Zero tension is ignored
      // in monotone mode; no synthetic samples enter storage or the learner.
      cubicInterpolationMode: temperature ? 'monotone' : 'default',
      tension: 0, spanGaps: false, hidden: !visible(visibilityKey, preferences),
    };
  });
}

export function chartQuery(selection) {
  if (!validDate(selection.startDate) || !validDate(selection.endDate) || selection.endDate < selection.startDate) throw new RangeError('The end date must be on or after the start date.');
  if (!leftGroups[selection.left]) throw new RangeError('Choose a valid left axis.');
  const points = selection.points ?? 800;
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Invalid chart resolution.');
  const params = new URLSearchParams({ start: selection.startDate, end: selection.endDate, left: selection.left, points: String(points) });
  if (selection.viewFrom !== undefined || selection.viewTo !== undefined) {
    if (!Number.isSafeInteger(selection.viewFrom) || !Number.isSafeInteger(selection.viewTo) || selection.viewFrom >= selection.viewTo)
      throw new RangeError('Invalid chart viewport.');
    params.set('viewFrom', String(selection.viewFrom)); params.set('viewTo', String(selection.viewTo));
  }
  return `/api/chart?${params}`;
}

/** Small response cache plus last-request-wins cancellation, independent of the DOM. */
export function createChartLoader({ api, now = Date.now, maxEntries = 6, liveTtlMs = 60_000, pastTtlMs = 300_000 }) {
  const cache = new Map();
  let pending, generation = 0;
  function cancel() { generation++; pending?.controller.abort(); pending = undefined; }
  function invalidate() { cache.clear(); cancel(); }
  function load(selection, { force = false, today = finnishDate(now()) } = {}) {
    const path = chartQuery(selection);
    if (pending?.path === path) {
      // New telemetry should not repeatedly kill a slow identical query. Let
      // it finish, then fetch its newer readings on the following refresh.
      pending.refreshRequested ||= force;
      return pending.promise;
    }
    cancel();
    const entry = cache.get(path);
    const longRange=Date.parse(selection.endDate)-Date.parse(selection.startDate)>=7*86400000;
    const ttl = selection.endDate >= today && !longRange ? liveTtlMs : pastTtlMs;
    if (!force && entry && now() - entry.at < ttl) {
      cache.delete(path); cache.set(path, entry);
      return Promise.resolve(entry.data);
    }
    const sequence = generation, controller = new AbortController();
    const request = { path, controller };
    request.promise = Promise.resolve().then(() => api(path, { signal: controller.signal })).then(data => {
      if (sequence !== generation) throw new DOMException('A newer chart selection is active.', 'AbortError');
      cache.delete(path);
      if (!request.refreshRequested) cache.set(path, { data, at: now() });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request.promise;
  }
  return { load, invalidate, close: cancel };
}
