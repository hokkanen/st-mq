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

export const defaultVisibility = Object.freeze({ heatOff: true, auxHeat: true, dhwr: false, spot_price: false });
export const leftGroups = Object.freeze({
  power: ['property_power', 'charger_power'],
  phases: ['property_current_l1', 'property_current_l2', 'property_current_l3', 'ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3'],
  integral: ['heating_integral'],
});
export const defaultPalette = Object.freeze({
  text: '#e0ede6', muted: '#9bb4a5', border: '#334d3e', grid: '#243c30',
  property: '#e98576', ev: '#e98576', phase1: '#66cbd0', phase2: '#cf94d3', phase3: '#dfc16c',
  indoor: '#81ca99', garage: '#e3b47b', outdoor: '#83b8da', integral: '#cea0dc', price: '#e6e9cf', spot: '#b6a6c9',
  heatOff: '#6ba58d', auxHeat: '#d38e66', dhwr: '#b3a15a',
});

export function visible(key, preferences = {}) {
  return preferences[key] ?? defaultVisibility[key] ?? true;
}

const seriesInfo = {
  property_power: ['Property', 'kW, estimated from phase currents', 'property'],
  charger_power: ['Charger', 'kW, estimated from phase currents', 'ev', 'fill'],
  property_current_l1: ['Property L1', 'A', 'phase1'],
  property_current_l2: ['Property L2', 'A', 'phase2'],
  property_current_l3: ['Property L3', 'A', 'phase3'],
  ev1_current_l1: ['Charger L1', 'A', 'phase1', 'fill'],
  ev1_current_l2: ['Charger L2', 'A', 'phase2', 'fill'],
  ev1_current_l3: ['Charger L3', 'A', 'phase3', 'fill'],
  heating_integral: ['Heating integral', '°min', 'integral'],
  indoor_temperature: ['Indoor', '°C', 'indoor'],
  garage_temperature: ['Garage', '°C', 'garage'],
  outdoor_temperature: ['Outdoor', '°C · dashed line is forecast', 'outdoor'],
  outdoor_forecast: ['Outdoor forecast', '°C · forecast', 'outdoor', 'forecast'],
  all_in_price: ['All-in price', 'c/kWh', 'price'],
  spot_price: ['Spot price', 'c/kWh · excludes VAT and other charges', 'spot'],
};
const rightKeys = ['indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast', 'all_in_price', 'spot_price'];

export function historyDatasets(series = {}, left = 'power', preferences = {}, palette = defaultPalette) {
  if (!leftGroups[left]) throw new RangeError('Choose power, phase currents or heating integral.');
  return [...leftGroups[left], ...rightKeys].map(key => {
    const [label, unit, colorKey, kind = 'line'] = seriesInfo[key];
    const visibilityKey = key === 'outdoor_forecast' ? 'outdoor_temperature' : key;
    const isLeft = leftGroups[left].includes(key);
    const isPrice = key.endsWith('_price');
    return {
      key, visibilityKey, unit, kind, label,
      data: series[key] ?? [],
      yAxisID: isLeft ? 'left' : 'right',
      borderColor: palette[colorKey], backgroundColor: palette[colorKey],
      borderWidth: kind === 'fill' ? 0 : isPrice ? 1.5 : 1.8,
      borderDash: kind === 'forecast' ? [5, 4] : key === 'spot_price' ? [2, 4] : [],
      fill: kind === 'fill' ? 'origin' : false,
      order: kind === 'fill' ? 2 : 1,
      pointRadius: (series[key] ?? []).filter(point => Number.isFinite(point.y)).length === 1 ? 2 : 0,
      pointHoverRadius: 3, pointHitRadius: 8,
      // Duplicate interval-edge points from the API retain exact price/forecast steps.
      stepped: isPrice || kind === 'forecast' || isLeft && left !== 'integral',
      tension: 0, spanGaps: false, hidden: !visible(visibilityKey, preferences),
    };
  });
}

export function chartQuery(selection) {
  if (!validDate(selection.startDate) || !validDate(selection.endDate) || selection.endDate < selection.startDate) throw new RangeError('The end date must be on or after the start date.');
  if (!leftGroups[selection.left]) throw new RangeError('Choose a valid left axis.');
  const points = selection.points ?? 800;
  if (!Number.isInteger(points) || points < 100 || points > 2000) throw new RangeError('Invalid chart resolution.');
  return `/api/chart?${new URLSearchParams({ start: selection.startDate, end: selection.endDate, left: selection.left, points: String(points) })}`;
}

/** Small response cache plus last-request-wins cancellation, independent of the DOM. */
export function createChartLoader({ api, now = Date.now, maxEntries = 6, liveTtlMs = 60_000, pastTtlMs = 300_000 }) {
  const cache = new Map();
  let pending, generation = 0;
  function cancel() { generation++; pending?.controller.abort(); pending = undefined; }
  function invalidate() { cache.clear(); cancel(); }
  function load(selection, { force = false, today = finnishDate(now()) } = {}) {
    const path = chartQuery(selection);
    if (pending?.path === path && !force) return pending.promise;
    cancel();
    const entry = cache.get(path);
    const ttl = selection.endDate >= today ? liveTtlMs : pastTtlMs;
    if (!force && entry && now() - entry.at < ttl) {
      cache.delete(path); cache.set(path, entry);
      return Promise.resolve(entry.data);
    }
    const sequence = generation, controller = new AbortController();
    const request = { path, controller };
    request.promise = Promise.resolve().then(() => api(path, { signal: controller.signal })).then(data => {
      if (sequence !== generation) throw new DOMException('A newer chart selection is active.', 'AbortError');
      cache.delete(path); cache.set(path, { data, at: now() });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request.promise;
  }
  return { load, invalidate, close: cancel };
}
