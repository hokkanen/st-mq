/** Prices are c/kWh. Instants are epoch milliseconds or ISO strings with a zone. */
export const TIME_ZONE = 'Europe/Helsinki';
const calendar = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function instantMs(value) {
  if (typeof value === 'string' && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError('Timestamp must contain time and UTC offset');
  }
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || !Number.isFinite(new Date(result).getTime())) throw new TypeError('Invalid timestamp');
  return result;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

export function helsinkiCalendar(instant) {
  const parts = Object.fromEntries(calendar.formatToParts(instantMs(instant)).map(({ type, value }) => [type, value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour,
    minute: +parts.minute, weekday: weekdays.indexOf(parts.weekday), timeZone: TIME_ZONE };
}

/** User-supplied marginal transfer rates, including VAT. No inferred holiday exceptions. */
export function transferPrice(instant, tariff = 'day-night') {
  const { month, hour, weekday } = helsinkiCalendar(instant);
  const day = hour >= 7 && hour < 22;
  if (tariff === 'day-night') return day ? 3.34 : 1.96;
  if (tariff === 'seasonal') return (month >= 11 || month <= 3) && weekday !== 0 && day ? 4.17 : 2.07;
  throw new TypeError(`Unsupported transfer tariff: ${tariff}`);
}

/** No end timestamp is guessed from spacing: each provider must supply actual duration. */
export function normalizePriceIntervals(rows, { unit, vatIncluded, source } = {}) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new RangeError('Normalize at most 10000 price intervals per page');
  const factors = { 'EUR/MWh': 0.1, 'EUR/kWh': 100, 'c/kWh': 1 };
  if (!Object.hasOwn(factors, unit)) throw new TypeError('Explicit supported price unit is required');
  if (vatIncluded !== false) throw new TypeError('Spot prices must be explicitly excluding VAT');
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('Price source is required');
  const result = rows.map(({ start, end, value }) => {
    const from = instantMs(start), to = instantMs(end);
    if (to <= from) throw new RangeError('Price interval end must follow start');
    return { start: from, end: to, spotCtPerKwh: finite(finite(value, 'Spot price') * factors[unit], 'Normalized spot price'),
      unit: 'c/kWh', vatIncluded: false, source };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < result.length; i++) {
    if (result[i].start < result[i - 1].end) throw new RangeError('Overlapping price intervals');
  }
  return result;
}

export function validateContract(contract) {
  if (!contract || !Array.isArray(contract.periods) || !contract.periods.length) throw new TypeError('Effective-dated contract periods are required');
  if (contract.periods.length > 512) throw new RangeError('Too many contract periods');
  const mode = contract.mode ?? 'billing';
  if (!['billing', 'scenario'].includes(mode)) throw new TypeError('Contract mode must be billing or scenario');
  if (mode === 'scenario') instantMs(contract.scenarioAt);
  const periods = contract.periods.map(period => {
    const from = instantMs(period.from), to = period.to == null ? Infinity : instantMs(period.to);
    if (to <= from) throw new RangeError('Contract period end must follow start');
    const marginCtPerKwh = finite(period.marginCtPerKwh, 'Retailer margin');
    const taxCtPerKwh = finite(period.taxCtPerKwh, 'Electricity tax');
    const vatRate = finite(period.vatRate, 'VAT fraction');
    if (taxCtPerKwh < 0 || vatRate < 0 || vatRate > 1) throw new RangeError('Tax must be nonnegative; VAT must be a fraction from 0 to 1');
    const tariff = period.tariff ?? 'day-night';
    transferPrice(from, tariff);
    return { ...period, from, to, marginCtPerKwh, taxCtPerKwh, vatRate, tariff };
  }).sort((a, b) => a.from - b.from);
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].from < periods[i - 1].to) throw new RangeError('Overlapping contract periods');
  }
  // Fixed charges belong to bill reporting; unknown demand charges cannot be silently ignored.
  if (contract.demandCharge != null) throw new TypeError('Demand-charge contracts require a dedicated billing model');
  return { ...contract, mode, periods };
}

function calculate(instant, spotCtPerKwh, contract) {
  const at = instantMs(instant);
  const rateAt = contract.mode === 'scenario' ? instantMs(contract.scenarioAt) : at;
  const period = contract.periods.find(p => p.from <= rateAt && rateAt < p.to);
  if (!period) throw new RangeError('No verified/configured contract rates cover this instant; historical calculation requires historical rates');
  const spot = finite(spotCtPerKwh, 'Spot price');
  const { marginCtPerKwh, taxCtPerKwh, vatRate, tariff } = period;
  const transferIncludingVatCtPerKwh = transferPrice(at, tariff);
  const vatCtPerKwh = (spot + marginCtPerKwh + taxCtPerKwh) * vatRate;
  return { spotCtPerKwh: spot, marginCtPerKwh, taxCtPerKwh, vatRate, vatCtPerKwh,
    transferIncludingVatCtPerKwh,
    totalCtPerKwh: finite(spot + marginCtPerKwh + taxCtPerKwh + vatCtPerKwh + transferIncludingVatCtPerKwh, 'All-in price'),
    unit: 'c/kWh', tariff, mode: contract.mode, rateFrom: period.from,
    provenance: period.provenance ?? 'User-configured rates; not independently verified' };
}

export function allInPrice(instant, spotCtPerKwh, contract) {
  return calculate(instant, spotCtPerKwh, validateContract(contract));
}

/** Split actual intervals at tariff and rate boundaries, including repeated DST hours. */
export function priceIntervals(intervals, contractInput) {
  if (!Array.isArray(intervals) || intervals.length > 10000) throw new RangeError('Price at most 10000 intervals per page');
  const contract = validateContract(contractInput);
  const result = [];
  let previousEnd = -Infinity;
  for (const interval of intervals) {
    const start = instantMs(interval.start), end = instantMs(interval.end);
    if (end - start > 25 * 3_600_000) throw new RangeError('Price intervals must not exceed one DST calendar day');
    if (end <= start || start < previousEnd) throw new RangeError('Price intervals must be ordered, positive and nonoverlapping');
    if (interval.unit !== 'c/kWh' || interval.vatIncluded !== false) throw new TypeError('Use normalized ex-VAT spot intervals');
    const boundaries = new Set([start, end]);
    // Finnish tariff changes occur on whole local hours; UTC hours cover both DST offsets.
    for (let at = Math.floor(start / 3_600_000) * 3_600_000 + 3_600_000; at < end; at += 3_600_000) boundaries.add(at);
    if (contract.mode !== 'scenario') for (const period of contract.periods) {
      for (const at of [period.from, period.to]) if (start < at && at < end) boundaries.add(at);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      result.push({ ...interval, start: sorted[i], end: sorted[i + 1],
        durationHours: (sorted[i + 1] - sorted[i]) / 3_600_000,
        ...calculate(sorted[i], interval.spotCtPerKwh, contract) });
      if (result.length > 100_000) throw new RangeError('Too many split price intervals; use bounded batches');
    }
    previousEnd = end;
  }
  return result;
}

/** Cost of an explicitly supplied constant import power; this does not estimate pump demand. */
export function costForPower(pricedIntervals, powerKw) {
  if (finite(powerKw, 'Import power kW') < 0) throw new RangeError('Export requires separate economics');
  return pricedIntervals.reduce((sum, p) => {
    const hours = (instantMs(p.end) - instantMs(p.start)) / 3_600_000;
    if (hours <= 0) throw new RangeError('Nonpositive interval duration');
    return sum + finite(p.totalCtPerKwh, 'All-in price') * powerKw * hours / 100;
  }, 0);
}
