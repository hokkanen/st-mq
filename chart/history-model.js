import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { FLOOR_PREHEAT_SIGNALS } from '../src/domain/floor-circuits.js';
import { stackPowerSeries } from './power-stack.js';
import { isInterpolatedTemperature } from '../src/domain/chart-temperatures.js';
import { temperatureIntervalKnots } from './temperature-curves.js';
import { chartResponseSize } from './chart-response-size.js';
import { HISTORY_AXIS_BY_KEY, CARAVAN_DEHUMIDIFIER_STATES, SIGNAL_INFO, MODEL_INPUT_INFO, MODEL_COEFFICIENT_INFO, PHASE_ENERGY_SIGNALS, COUNTER_SIGNALS } from '../src/domain/history-series.js';
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

/** A new start shows one day; the end picker keeps its own suggested date. */
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

export const defaultVisibility = Object.freeze({ heatOff: true, compressorHome: true, compressorGarage: true, operatingMode: true, dhwr: true, fireplace: true, spot_price: true });
export const operationModes = Object.freeze({ 0: 'Off', 1: 'Auto', 2: 'Compressor only', 3: 'Auxiliary only', 4: 'Hot water only' });
export const defaultPalette = Object.freeze({
  text: '#e0ede6', muted: '#9bb4a5', border: '#334d3e', grid: '#243c30',
  property: '#e99583', ev: '#66c7bd', ev2: '#b99bdc', auxiliary: '#e47f79', phase1: '#dfc16c', phase2: '#66c7bd', phase3: '#cf94c7',
  indoor: '#81ca99', upstairs: '#e99583', downstairs: '#e5cb75', bedroom: '#d3b7ed', garage: '#c57739', garageFront: '#f4cd95', garagePump: '#bb8bd0', caravan: '#58c8d1', outdoor: '#83b8da', integral: '#80cbb3', price: '#ffffff', spot: '#b7c4bd',
  garagePipeRear: '#73a8f4', garagePipeFront: '#e28abc',
  supply: '#df9980', return: '#d5bb7d', brineIn: '#70c3bd', brineOut: '#86adda', reference: '#b6c6b7',
  heatOff: '#7891a7', compressorSpace: '#d5c456', compressorDhw: '#83b8da', dhwr: '#e47f79', learning: '#c0a0df', solar: '#dfc16c',
  firewood: '#d8aa75', fireplace: '#b79b28',
});

export function visible(key, preferences = {}) {
  return preferences[key] ?? defaultVisibility[key] ?? true;
}

const seriesInfo = {
  property_power: ['Property', 'kW · interval average from recorded energy; current history uses estimated per-phase voltage', 'property'],
  charger_power: ['Charger 1', 'kW · interval average from recorded energy; current history uses estimated per-phase voltage', 'ev', 'fill'],
  charger2_power: ['Charger 2', 'kW · interval average from recorded native total meter energy', 'ev2', 'fill'],
  caravan_energy: ['Caravan energy', 'kWh · measured meter energy over the recorded interval', 'property', 'interval-energy'],
  caravan_power: ['Caravan power', 'kW · interval average from recorded meter energy', 'property'],
  caravan_temperature: ['Caravan air', '°C', 'caravan'],
  caravan_humidity: ['Caravan relative humidity', '%', 'outdoor'],
  caravan_dehumidifier_state: ['Caravan dehumidifier', 'state · reported power and fan', 'garage'],
  ev1_session_energy_check: ['Charger 1', 'kWh · finalized session electricity reading', 'ev', 'session'],
  auxiliary_power: ['Auxiliary heat', 'kW · estimated from H66 output and configured capacity', 'auxiliary'],
  property_current_l1: ['Property L1', 'A', 'phase1'],
  property_current_l2: ['Property L2', 'A', 'phase2'],
  property_current_l3: ['Property L3', 'A', 'phase3'],
  property_current_max: ['Property highest phase', 'A · highest simultaneous phase-current estimate', 'property'],
  ev1_current_allowance: ['Charger 1 allowance', 'A · native Equalizer minimum phase allowance', 'ev'],
  ev2_current_allowance: ['Charger 2 allowance', 'A · controller load-balancing allowance', 'outdoor'],
  ev2_current_fallback: ['Charger 2 fallback', 'A · fallback cap; verified load allowance unavailable', 'learning'],
  ev1_current_l1: ['Charger 1 L1', 'A', 'phase1'],
  ev1_current_l2: ['Charger 1 L2', 'A', 'phase2'],
  ev1_current_l3: ['Charger 1 L3', 'A', 'phase3'],
  ev2_current_l1: ['Charger 2 L1', 'A · equivalent interval average from estimated phase energy', 'phase1'],
  ev2_current_l2: ['Charger 2 L2', 'A · equivalent interval average from estimated phase energy', 'phase2'],
  ev2_current_l3: ['Charger 2 L3', 'A · equivalent interval average from estimated phase energy', 'phase3'],
  heating_integral: ['Heating integral', '°min', 'integral'],
  learning_profit: ['Space-heating benefit after recovery', '€/cycle · estimated completed-cycle mean; hot-water service excluded', 'learning', 'learning'],
  learning_aux_profit: ['Space-heating benefit with auxiliary recovery', '€/cycle · observed space-heating auxiliary recovery cycles only', 'learning', 'learning'],
  learning_recovery_error: ['Space-heating recovery-cost prediction error', '€/cycle · mean absolute error; lower is better', 'learning', 'learning'],
  learning_indoor_temperature: ['Learned normal temperature', '°C · learned reference, not a thermostat command', 'learning', 'learning'],
  firewood_savings: ['Firewood electricity cost avoided', '€/day · retrospective model estimate; wood cost €0', 'firewood', 'daily'],
  firewood_electricity_avoided: ['Firewood electricity avoided', 'kWh/day · retrospective model estimate, not metered savings', 'firewood', 'daily'],
  solar_radiation: ['Solar estimate', 'W/m² · historical estimate from the forecast available at the time, not a measured solar sensor', 'solar', 'estimate'],
  solar_forecast: ['Solar forecast', 'W/m² · forecast', 'solar', 'forecast'],
  indoor_temperature: ['Upstairs', '°C', 'upstairs'],
  downstairs_temperature: ['Downstairs', '°C', 'downstairs'],
  bedroom_temperature: ['Bedroom', '°C', 'bedroom'],
  garage_temperature: ['Garage rear', '°C', 'garage'],
  garage_temperature_2: ['Garage front', '°C', 'garageFront'],
  outdoor_temperature: ['Outdoor', '°C · FMI station or Open-Meteo model estimate', 'outdoor'],
  outdoor_forecast: ['Outdoor forecast', '°C · forecast', 'outdoor', 'forecast'],
  all_in_price: ['All-in price', 'c/kWh', 'price'],
  spot_price: ['Spot price', 'c/kWh · excludes VAT and other charges', 'spot'],
};
for (const [signal, info] of Object.entries(SIGNAL_INFO)) {
  seriesInfo[signal] ??= [info.label, `${info.unit} · ${info.detail ?? info.kind.toLowerCase()}`,
    PHASE_ENERGY_SIGNALS.includes(signal) ? `phase${signal.at(-1)}` : signal.startsWith('ev1') ? 'ev' : signal.startsWith('property') ? 'property' : info.group === 'Ground loop' ? 'outdoor' : info.group === 'Garage heat pump' ? 'garage' : 'integral',
    PHASE_ENERGY_SIGNALS.includes(signal) ? 'interval-energy' : COUNTER_SIGNALS.includes(signal) ? 'audit' : 'line'];
}
Object.assign(seriesInfo, {
  heat_pump_power: ['Heat pump', 'kW · reconstructed estimated electrical input', 'auxiliary'],
  controller_phase: ['Requested phase', 'state · 0 normal, 1 preheat, 2 reduction, 3 recovery', 'learning'],
  dhwr_request: ['Hot-water circulation request', 'state · requested, not confirmed flow', 'dhwr'],
  garage_native_energy: ['Garage pump meter counter', 'kWh · native cumulative counter observation; not interval consumption', 'garagePump', 'audit'],
  garage_energy: ['Garage pump energy', 'kWh · original recording interval; inspect the point for its measurement basis', 'garagePump', 'interval-energy'],
});
for (const [signal, info] of Object.entries({ ...MODEL_INPUT_INFO, ...MODEL_COEFFICIENT_INFO }))
  seriesInfo[signal] = [info.label, `${info.unit} · ${info.detail}`, info.color, signal === 'firewood_load' ? 'event' : 'line'];

// The same physical quantity keeps its colour across views and saved inputs.
for (const [key, color] of Object.entries({
  supply_temperature: 'supply', heating_setpoint: 'garage', return_temperature: 'return',
  brine_in_temperature: 'brineIn', brine_out_temperature: 'brineOut',
  heating_pump_speed: 'supply', brine_pump_speed: 'brineIn', maximum_supply_setting: 'auxiliary',
  model_target_temperature: 'reference', room_setting: 'reference', heating_curve: 'garage', heat_stop_setting: 'outdoor', tariff_reduction_setting: 'learning',
  learning_aux_profit: 'auxiliary', compressor_hours: 'compressorSpace', dhw_hours: 'compressorDhw',
  auxiliary_3kw_hours: 'auxiliary', auxiliary_6kw_hours: 'garagePump',
  dhw_temperature: 'compressorDhw', dhw_start_setting: 'brineIn', dhw_stop_setting: 'supply',
})) if (seriesInfo[key]) seriesInfo[key][2] = color;
// Shared signal metadata also drives state tracks, so their legend swatches and
// scalar/explorer representations retain one colour throughout the catalogue.
for (const [key, info] of Object.entries(SIGNAL_INFO)) if (info.color) seriesInfo[key][2] = info.color;

const forecastSignals = new Set(['outdoor_forecast', 'solar_forecast']);
export const chartLinePatterns = Object.freeze({
  solid: Object.freeze([]), temperature: Object.freeze([6, 4]),
  reference: Object.freeze([12, 4]), forecast: Object.freeze([8, 3, 2, 3]), fallback: Object.freeze([8, 3, 2, 3]), price: Object.freeze([1, 3]),
});

/** Colour stays semantic; stroke distinguishes axes, references and forecasts. */
export function historySeriesStyle(key, axis, kind = 'line', { interpolation: enabled = true } = {}) {
  const temperature = isInterpolatedTemperature(key);
  const temperatureUnit = temperature || seriesInfo[key]?.[1].split(' · ')[0] === '°C';
  const forecast = kind === 'forecast' || forecastSignals.has(key);
  const price = key.endsWith('_price');
  const pointsOnly = ['event', 'daily', 'session', 'interval-energy', 'audit'].includes(kind);
  const interpolation = !enabled ? 'step' : temperature || key === 'caravan_humidity' ? 'monotone'
    : key === 'heating_integral' ? 'linear' : 'step';
  return {
    forecast, interpolation, showLine: !pointsOnly,
    borderDash: key === 'ev2_current_fallback' ? chartLinePatterns.fallback : forecast ? chartLinePatterns.forecast : price ? chartLinePatterns.price
      : axis === 'right' && temperatureUnit ? chartLinePatterns.temperature : chartLinePatterns.solid,
    stepped: pointsOnly || interpolation !== 'step' ? false : price ? 'before' : true,
    cubicInterpolationMode: interpolation === 'monotone' ? 'monotone' : 'default',
  };
}

function fillColor(color) {
  // Canvas accepts CSS hex alpha; the outline and legend retain the full colour.
  return /^#[\da-f]{6}$/i.test(color) ? `${color}45` : color;
}

function phaseColor(color, key) {
  const source = /^(ev[12])_(?:current|energy)_l[123]$/.exec(key)?.[1];
  if (!source || !/^#[\da-f]{6}$/i.test(color)) return color;
  // Phase hue identifies the conductor. A consistent light/dark variation
  // identifies charging sources when several same-phase curves are enabled.
  const target = source === 'ev1' ? 255 : 0;
  return `#${color.slice(1).match(/../g).map(value => Math.round(parseInt(value, 16) * .78 + target * .22).toString(16).padStart(2, '0')).join('')}`;
}

export function firewoodPointDetail(key, point = {}) {
  if (key === 'firewood_load') return `Recorded manual ${point.loadCount > 1 ? `total of ${point.loadCount} additions at this time` : 'addition'} · corrected history`;
  if (key === 'model_fireplace_release') return 'Calculated delayed release · fuel equivalent, not measured heat';
  if (!['firewood_savings', 'firewood_electricity_avoided'].includes(key)) return '';
  const status = point.status === 'validated' ? 'Validated model estimate' : point.status === 'unavailable' ? 'Estimate unavailable' : 'Provisional model estimate';
  const coverage = Number.isFinite(point.coverage) ? ` · ${Math.round(Math.max(0, Math.min(1, point.coverage)) * 100)}% of elapsed time included` : '';
  return `${status} · retrospective daily total${coverage}${key === 'firewood_savings' ? ' · wood cost €0' : ''}`;
}

export function historyStateLabel(key, value) {
  if (key === 'caravan_dehumidifier_state') return Number.isInteger(value) ? CARAVAN_DEHUMIDIFIER_STATES[value] ?? 'Unknown' : 'Unknown';
  if (/^garage_door[12]_open$/.test(key)) return value === 1 ? 'Open' : value === 0 ? 'Closed' : `Unknown (${value})`;
  if (key === 'operating_mode') return operationModes[value] ?? `Unknown mode (${value})`;
  if (['controller_phase', 'model_controller_phase'].includes(key))
    return ['Normal', 'Preheat', 'Tariff reduction', 'Recovery'][value] ?? `Unknown phase (${value})`;
  if (key === 'dhw_routing') return value === 0 ? 'Space heating' : value === 1 ? 'Hot water' : `Unknown route (${value})`;
  if (key === 'garage_away_mode') return value === 1 ? 'Away selected' : value === 0 ? 'Normal selected' : 'Unknown';
  if (key === 'garage_native_power') return value === 1 ? 'Pump on' : value === 0 ? 'Pump off' : 'Unknown';
  if (key === 'garage_external_enabled') return value === 1 ? 'Enabled' : value === 0 ? 'Disabled' : 'Unknown';
  if (key === 'garage_frost_available') return value === 1 ? 'Available' : value === 0 ? 'Unavailable' : 'Unknown';
  if (key === 'garage_frost_active') return value === 1 ? 'Protection override' : value === 0 ? 'No override' : 'Unknown';
  if (['compressor_active', 'garage_compressor_active', 'heating_pump_active', 'alarm_active'].includes(key)) return value === 1 ? 'Active' : value === 0 ? 'Inactive' : `Unknown (${value})`;
  if (key === 'model_valve_override') return ['Normal valve mode', 'Pooled override confirmed', 'Partial override', 'Unconfirmed override'][value] ?? 'Unknown valve mode';
  if (key === 'dhwr_request') return value === 1 ? 'On requested' : value === 0 ? 'Off requested' : `Unknown (${value})`;
  if (['dhwr_active', 'heat_savings_active', 'garage_native_defrost'].includes(key) || FLOOR_PREHEAT_SIGNALS.includes(key))
    return value === 1 ? 'Active' : value === 0 ? 'Inactive' : `Unknown (${value})`;
  return null;
}

export function historyValueLabel(key, value, unit) {
  const state = historyStateLabel(key, value);
  if (state) return state;
  const digits = MODEL_COEFFICIENT_INFO[key]?.digits;
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
const heldReadingKeys = ['property_power', 'charger_power', 'charger2_power',
  ...['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)),
  'heating_integral', 'indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'garage_temperature_2',
  'garage_native_indoor_temperature', 'outdoor_temperature', 'caravan_temperature', 'caravan_humidity', 'caravan_dehumidifier_state'];

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
    if ((key.startsWith('caravan_') || key === 'garage_native_indoor_temperature') && !last.periodicCoverage) continue;
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

export function historyDatasets(series = {}, descriptor, preferences = {}, palette = defaultPalette, { interpolation = true } = {}) {
  if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(descriptor.leftSignals) || !Array.isArray(descriptor.rightSignals))
    throw new RangeError('Choose a chart view or supported series.');
  const { leftSignals, rightSignals } = descriptor;
  const keys = [...new Set([...leftSignals, ...rightSignals])];
  const powerKeys = ['charger_power', 'charger2_power'].filter(key => leftSignals.includes(key));
  const phaseGroups = descriptor.stackPhases ? [1, 2, 3].map(phase => ['ev1', 'ev2']
    .map(prefix => `${prefix}_current_l${phase}`).filter(key => leftSignals.includes(key))) : [];
  const phaseKeys = new Set(phaseGroups.flat());
  const stackGroups = [...(descriptor.stackPower ? [powerKeys] : []), ...phaseGroups];
  const stackedData = new Map(), stackBases = new Map(), fillOrder = new Map();
  for (const stack of stackGroups) {
    let group = [];
    stack.forEach((key, index) => fillOrder.set(key, 4 - index));
    for (const key of stack) {
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
    const info = descriptor?.seriesInfo?.[key];
    const definition = seriesInfo[key] ?? (info ? [info.label, info.unit, info.color ?? 'learning', info.kind ?? 'line'] : null);
    if (!definition) throw new RangeError(`Unknown chart signal: ${key}`);
    const [label, unit, colorKey, baseKind = 'line'] = definition;
    const kind = phaseKeys.has(key) ? 'fill' : baseKind;
    const visibilityKey = key;
    const isLeft = leftSignals.includes(key);
    const isPrice = key.endsWith('_price');
    const temperature = isInterpolatedTemperature(key);
    const points = stackedData.get(key) ?? series[key] ?? [];
    // API clipping can supply a linear value at the visible edge. In step mode
    // use its preceding source value, while preserving explicit missing edges.
    const original = interpolation ? points : points.map(point => point.displayBoundary && point.interpolated
      ? { ...point, y: Number.isFinite(point.y) && Number.isFinite(point.heldValue) ? point.heldValue : null, interpolated: false }
      : point);
    const data = ['audit', 'session', 'interval-energy'].includes(kind) ? original.filter(point => !point.displayBoundary && !point.carriedForward)
      : interpolation && temperature && original.some(point => point.periodicCoverage || point.interpolated || Number.isFinite(point.intervalStart) && Number.isFinite(point.intervalEnd))
        ? temperatureIntervalKnots(original) : original;
    const stackBase = stackBases.get(key);
    const axis = isLeft ? 'left' : 'right';
    const style = historySeriesStyle(key, axis, kind, { interpolation });
    const color = phaseColor(palette[colorKey] ?? defaultPalette[colorKey] ?? palette.learning, key);
    const chargerPhase = /^(ev[12])_current_l[123]$/.exec(key)?.[1];
    const circles = ['session', 'interval-energy', 'audit'].includes(kind);
    const genuine = point => !point.displayBoundary && !point.carriedForward;
    const isolated = (point, index) => genuine(point) && Number.isFinite(point.y)
      && !Number.isFinite(data[index - 1]?.y) && !Number.isFinite(data[index + 1]?.y);
    return {
      key, visibilityKey, unit, kind, label,
      data,
      ...(powerKeys.includes(key) || phaseKeys.has(key) ? { powerStacked: Boolean(stackBase), powerStackBase: stackBase ?? null } : {}),
      ...style,
      yAxisID: axis,
      borderColor: color, backgroundColor: kind === 'fill' ? fillColor(color) : color,
      borderWidth: kind === 'fill' ? 1 : isPrice ? 1.25 : key === 'property_power' ? 2 : 1.65,
      fill: stackBase ? keys.indexOf(stackBase) : kind === 'fill' ? 'origin' : false,
      order: fillOrder.get(key) ?? (kind === 'fill' ? 2 : 1),
      pointBackgroundColor: kind === 'daily' ? data.map(point => point.status === 'validated' ? color : 'transparent')
        : circles ? 'transparent' : data.map((point, index) => isolated(point, index) ? 'transparent' : color), pointBorderColor: color,
      pointBorderWidth: kind === 'session' ? data.map(point => point.comparisonEligible ? 2 : 1) : circles ? 1.75 : 1.5,
      pointStyle: kind === 'event' ? 'triangle' : kind === 'daily' ? 'rectRot' : 'circle',
      // A finite reading surrounded by gaps has no line segment to draw.
      pointRadius: kind === 'event' ? 5 : kind === 'daily' ? 4 : circles ? 5 : data.map((point, index) => isolated(point, index) ? 5
        : !genuine(point) ? 0 : isPrice ? 1 : chargerPhase && kind !== 'fill' && Number.isFinite(point.y) && index % Math.max(1, Math.ceil(data.length / 10)) === 0 ? 2 : 0),
      pointHoverRadius: kind === 'event' || circles ? 7 : kind === 'daily' ? 6
        : data.map((point, index) => !genuine(point) ? 0 : isolated(point, index) ? 7 : 3),
      pointHitRadius: circles || kind === 'event' ? 12 : data.map(point => genuine(point) ? 12 : 0),
      // Chart.js' monotone cubic Hermite interpolation is O(n), preserves local
      // extrema and never overshoots adjacent values. Zero tension is ignored
      // in monotone mode; no synthetic samples enter storage or the learner.
      tension: 0, spanGaps: false, hidden: !visible(visibilityKey, preferences),
    };
  });
}

export function chartQuery(selection) {
  if (!validDate(selection.startDate) || !validDate(selection.endDate) || selection.endDate < selection.startDate) throw new RangeError('The end date must be on or after the start date.');
  if (selection.view !== undefined ? !Object.hasOwn(CHART_VIEW_BY_KEY, selection.view) : !Object.hasOwn(HISTORY_AXIS_BY_KEY, selection.left)) throw new RangeError('Choose a valid chart view or series.');
  if (selection.view !== undefined && selection.left !== undefined) throw new RangeError('Choose either a view or an individual series.');
  const points = selection.points ?? 800;
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Invalid chart resolution.');
  const params = new URLSearchParams({ start: selection.startDate, end: selection.endDate, ...(selection.view !== undefined ? { view: selection.view } : { left: selection.left }), points: String(points) });
  if (selection.viewFrom !== undefined || selection.viewTo !== undefined) {
    if (!Number.isSafeInteger(selection.viewFrom) || !Number.isSafeInteger(selection.viewTo) || selection.viewFrom >= selection.viewTo)
      throw new RangeError('Invalid chart viewport.');
    params.set('viewFrom', String(selection.viewFrom)); params.set('viewTo', String(selection.viewTo));
  }
  return `/api/chart?${params}`;
}

/** One explicit companion per group, only for an inclusive week or less. No
 * preference learning, adjacent-date multiplication or background polling. */
export function chartPrefetchSelection(selection) {
  const companion = { power: 'phases', phases: 'charging_currents', charging_currents: 'power',
    garage: 'garage_control', garage_control: 'garage' }[selection.view];
  const days = (Date.parse(selection.endDate) - Date.parse(selection.startDate)) / 86_400_000 + 1;
  if (!companion || days < 1 || days > 7 || selection.viewFrom !== undefined) return null;
  return { ...selection, view: companion };
}

export function chartResponseWeight(data) {
  // Count retained records without serializing payloads on the browser thread.
  // Strings/metadata are included in the transport byte bound when supplied.
  return Object.values(data.series ?? {}).reduce((sum, rows) => sum + rows.length, 0)
    + Object.values(data.shading ?? {}).reduce((sum, rows) => sum + rows.length, 0)
    + (data.operatingModes?.length ?? 0);
}

/** Bounded LRU plus last-request-wins cancellation. A selected prefetch keeps
 * its running request; unrelated speculation is aborted before foreground work. */
export function createChartLoader({ api, now = Date.now, maxEntries = 6, maxRecords = 160_000,
  maxBytes = 32 * 1024 * 1024, liveTtlMs = 60_000, pastTtlMs = 300_000, prefetchDelay = 350,
  canPrefetch = () => typeof document === 'undefined' || !document.hidden }) {
  const cache = new Map();
  let pending, speculative, timer, wantedPath, prefetchedPath, generation = 0, cacheWeight = 0, cacheBytes = 0, closed = false;
  function forget(path) {
    const entry = cache.get(path);
    if (entry) { cacheWeight -= entry.weight; cacheBytes -= entry.bytes; }
    cache.delete(path);
  }
  function clearTimer() { clearTimeout(timer); timer = undefined; }
  function cancelPrefetch() { clearTimer(); speculative?.controller.abort(); speculative = undefined; }
  function cancel() { pending?.controller.abort(); pending = undefined; }
  function invalidate() { generation++; cache.clear(); cacheWeight = cacheBytes = 0; prefetchedPath = undefined; cancel(); cancelPrefetch(); }
  function cached(selection, today) {
    const path = chartQuery(selection), entry = cache.get(path);
    const longRange = Date.parse(selection.endDate) - Date.parse(selection.startDate) >= 7 * 86400000;
    const ttl = selection.endDate >= today && !longRange ? liveTtlMs : pastTtlMs;
    if (!entry || now() - entry.at >= ttl) { forget(path); return null; }
    cache.delete(path); cache.set(path, entry);
    return entry.data;
  }
  function remember(request, data) {
    forget(request.path);
    const weight = chartResponseWeight(data);
    // Production reads supply exact decoded bytes from the stream worker;
    // direct data callers use a conservative vertex allocation estimate.
    const bytes = chartResponseSize(data) ?? weight * 1024;
    if (request.refreshRequested || maxEntries <= 0 || weight > maxRecords || bytes > maxBytes) return;
    cache.set(request.path, { data, at: now(), weight, bytes }); cacheWeight += weight; cacheBytes += bytes;
    while (cache.size > maxEntries || cacheWeight > maxRecords || cacheBytes > maxBytes) forget(cache.keys().next().value);
  }
  function start(selection, prefetch, onProgress) {
    const path = chartQuery(selection), sequence = generation, controller = new AbortController();
    const request = { path, controller, onProgress };
    request.promise = Promise.resolve().then(() => api(path, { signal: controller.signal, prefetch,
      onProgress(progress) { request.progress = progress; request.onProgress?.(progress); } })).then(data => {
      if (closed || sequence !== generation || controller.signal.aborted)
        throw new DOMException('A newer chart selection is active.', 'AbortError');
      remember(request, data); return data;
    }).finally(() => {
      if (pending === request) pending = undefined;
      if (speculative === request) speculative = undefined;
    });
    return request;
  }
  function load(selection, { force = false, today = finnishDate(now()), onProgress } = {}) {
    if (closed) return Promise.reject(new DOMException('Chart closed', 'AbortError'));
    const path = chartQuery(selection);
    const changed = wantedPath !== path;
    if (changed) { wantedPath = path; prefetchedPath = undefined; clearTimer(); }
    if (pending?.path === path) {
      pending.refreshRequested ||= force; pending.onProgress = onProgress;
      if (pending.progress) onProgress?.(pending.progress);
      return pending.promise;
    }
    cancel();
    if (speculative?.path === path) {
      pending = speculative; speculative = undefined;
      pending.refreshRequested ||= force; pending.onProgress = onProgress;
      if (pending.progress) onProgress?.(pending.progress);
      return pending.promise;
    }
    if (changed) cancelPrefetch();
    const data = !force && cached(selection, today);
    if (data) return Promise.resolve(data);
    cancelPrefetch();
    pending = start(selection, false, onProgress);
    return pending.promise;
  }
  function prefetch(selection, { today = finnishDate(now()) } = {}) {
    const path = chartQuery(selection);
    if (prefetchedPath === path) return;
    const target = chartPrefetchSelection(selection);
    if (closed || !target || !canPrefetch() || pending || speculative || cached(target, today)) return;
    prefetchedPath = path;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || !canPrefetch() || pending || speculative || cached(target, today)) return;
      speculative = start(target, true);
      // Speculation never replaces the selected chart or displays errors.
      void speculative.promise.catch(() => {});
    }, Math.max(0, prefetchDelay));
  }
  return { load, prefetch, cancelPrefetch, invalidate, close() { invalidate(); closed = true; } };
}
