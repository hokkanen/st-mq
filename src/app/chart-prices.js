import { allInPrice, instantMs, priceIntervals, validateContract } from '../domain/prices.js';

const HOUR = 3_600_000, BATCH_SIZE = 1000;

function upperBound(values, at) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= at) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Chart estimates retain historical spot prices and tariff hours. Missing
 * contract coverage uses the nearest effective period, measured from its
 * endpoints; an instant equally distant from two periods uses the earlier one.
 * Billing and controller pricing remain strict about dated contract coverage. */
export function createHistoricalPricing(contractValidated) {
  // Validated contracts use Infinity; the public domain functions accept null
  // for an open end. Copy before converting so stored contracts are untouched.
  const contract = validateContract({ ...contractValidated,
    periods: contractValidated.periods.map(period => ({ ...period, to: period.to === Infinity ? null : period.to })) });
  const periods = contract.periods, starts = periods.map(period => period.from);
  const contracts = periods.map(period => {
    const billing = { ...contract, mode: 'billing',
      periods: [{ ...period, to: Number.isFinite(period.to) ? period.to : null }] };
    return { billing, scenario: { ...billing, mode: 'scenario', scenarioAt: period.from } };
  });
  const boundaries = new Set();
  periods.forEach((period, index) => {
    boundaries.add(period.from);
    if (Number.isFinite(period.to)) boundaries.add(period.to);
    const next = periods[index + 1];
    if (next && period.to < next.from) boundaries.add(period.to + (next.from - period.to) / 2);
  });
  const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
  const select = at => {
    const previous = upperBound(starts, at) - 1;
    if (previous < 0) return { index: 0, assumedPrice: true };
    const period = periods[previous];
    if (at < period.to) return { index: previous, assumedPrice: false };
    const next = periods[previous + 1];
    return { index: next && next.from - at < at - period.to ? previous + 1 : previous, assumedPrice: true };
  };
  const contractFor = ({ index, assumedPrice }) => contracts[index][assumedPrice ? 'scenario' : 'billing'];
  const bases = new Map();

  return {
    total(instant, spotCtPerKwh) {
      const at = instantMs(instant), selected = select(at), period = periods[selected.index];
      if (!Number.isFinite(spotCtPerKwh)) throw new TypeError('Spot price must be a finite number');
      const key = `${Math.floor(at / HOUR)}:${selected.index}`;
      let base = bases.get(key);
      if (base === undefined) {
        base = allInPrice(at, 0, contractFor(selected)).totalCtPerKwh;
        if (bases.size >= 4096) bases.delete(bases.keys().next().value);
        bases.set(key, base);
      }
      const totalCtPerKwh = base + spotCtPerKwh * (1 + period.vatRate);
      if (!Number.isFinite(totalCtPerKwh)) throw new TypeError('All-in price must be a finite number');
      return { totalCtPerKwh, assumedPrice: selected.assumedPrice, rateFrom: period.from };
    },

    intervals(rows) {
      if (!Array.isArray(rows)) throw new TypeError('Normalized price intervals are required');
      const result = [];
      let batch = [], selection, previousEnd = -Infinity;
      const flush = () => {
        if (!batch.length) return;
        for (const row of priceIntervals(batch, contractFor(selection)))
          result.push({ ...row, assumedPrice: selection.assumedPrice });
        batch = [];
      };
      for (const row of rows) {
        const start = instantMs(row.start), end = instantMs(row.end);
        if (end - start > 25 * HOUR) throw new RangeError('Price intervals must not exceed one DST calendar day');
        if (end <= start || start < previousEnd) throw new RangeError('Price intervals must be ordered, positive and nonoverlapping');
        let cursor = start, boundaryIndex = upperBound(orderedBoundaries, start);
        while (cursor < end) {
          const until = Math.min(end, orderedBoundaries[boundaryIndex] ?? Infinity);
          // At a gap midpoint the point tie belongs to the earlier period, but
          // the following positive-duration interval belongs to the later one.
          const selected = select(cursor + (until - cursor) / 2);
          if (selection && (selection.index !== selected.index || selection.assumedPrice !== selected.assumedPrice)
            || batch.length >= BATCH_SIZE) flush();
          selection = selected;
          batch.push({ ...row, start: cursor, end: until });
          cursor = until; boundaryIndex++;
        }
        previousEnd = end;
      }
      flush();
      return result;
    },
  };
}
