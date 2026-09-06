import moment from 'moment-timezone';
import { validateContract, priceIntervals } from '../domain/prices.js';

export function contractWithPeriod(existing, input) {
  if (!input || typeof input.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate)) throw new Error('Effective date must be YYYY-MM-DD in Finland');
  const date = moment.tz(input.effectiveDate, 'YYYY-MM-DD', true, 'Europe/Helsinki');
  if (!date.isValid()) throw new Error('Invalid effective date');
  const from = date.valueOf();
  const periods = existing ? validateContract(existing).periods.map(p => ({ ...p, to: Number.isFinite(p.to) ? p.to : null })) : [];
  if (periods.some(p => p.from >= from)) throw new Error('New rates must start after the last configured period; existing historical rates are preserved');
  if (periods.length >= 100) throw new Error('At most 100 contract periods are supported');
  const previous = periods.at(-1);
  if (previous && (previous.to === null || previous.to > from)) previous.to = from;
  const next = { from, marginCtPerKwh: input.marginCtPerKwh, taxCtPerKwh: input.taxCtPerKwh,
    vatRate: input.vatRate, tariff: input.tariff,
    provenance: 'Household entered rates; effective at Finnish local midnight' };
  if (!['day-night', 'seasonal'].includes(next.tariff)) throw new Error('Select a transfer tariff');
  if (next.marginCtPerKwh < -20 || next.marginCtPerKwh > 100 || next.taxCtPerKwh > 100) throw new Error('Check charge units: enter c/kWh excluding VAT');
  const contract = { mode: 'billing', periods: [...periods, next] };
  validateContract(contract);
  return contract;
}

export function assembleOutlook(market, weather, contract, now) {
  const output = { prices: [], forecast: [], spot: [], priceStatus: 'missing-market-data', weatherStatus: 'missing-forecast' };
  const continuous = intervals => {
    let cursor = now;
    for (const interval of intervals) {
      if (interval.start > cursor) return false;
      cursor = Math.max(cursor, interval.end);
    }
    return cursor > now;
  };
  if (market) {
    const age = now - market.fetchedAt;
    if (age >= 0 && age <= 36 * 3_600_000) {
      output.spot = market.intervals.filter(p => p.end > now).sort((a, b) => a.start - b.start);
      output.priceStatus = contract ? 'no-contract-coverage' : 'contract-not-configured';
      if (contract) {
        const periods = validateContract(contract).periods;
        // A future tariff may cover only part of the outlook. Keep covered
        // intervals without making up rates for uncovered periods.
        for (const interval of output.spot) {
          for (const period of periods) {
            const start = Math.max(interval.start, period.from), end = Math.min(interval.end, period.to);
            if (end <= start) continue;
            output.prices.push(...priceIntervals([{ ...interval, start, end }], contract)
              .map(p => ({ ...p, allInCentsPerKWh: p.totalCtPerKwh })));
          }
        }
        if (output.prices.length) {
          const duration = rows => rows.reduce((sum, row) => sum + Math.max(0, row.end - Math.max(now, row.start)), 0);
          output.priceStatus = duration(output.prices) < duration(output.spot) ? 'partial-contract-coverage'
            : continuous(output.prices) ? 'configured' : 'incomplete-market-coverage';
        }
      }
    } else output.priceStatus = 'stale-market-data';
  }
  if (weather) {
    const age = now - weather.fetchedAt;
    if (age >= 0 && age <= 6 * 3_600_000) {
      output.forecast = weather.forecast.filter(p => {
        const issued = p.issuedAt == null && p.issuedAtBasis === 'fetched-snapshot' ? p.fetchedAt : p.issuedAt;
        return p.end > now && Number.isFinite(p.fetchedAt) && now >= p.fetchedAt && now - p.fetchedAt <= 6 * 3_600_000
          && Number.isFinite(issued) && now >= issued && now - issued <= 6 * 3_600_000;
      }).sort((a, b) => a.start - b.start);
      if (output.forecast.length) output.weatherStatus = continuous(output.forecast) ? 'available' : 'partial-forecast-coverage';
      else if (weather.forecast.some(p => p.end > now)) output.weatherStatus = 'stale-forecast';
    } else output.weatherStatus = 'stale-forecast';
  }
  return output;
}
