import moment from 'moment-timezone';
import { validateContract, priceIntervals, DEFAULT_TRANSFER_RATES_EX_VAT } from '../domain/prices.js';

export const DEFAULT_PRICE_SETTINGS = Object.freeze({ marginCtPerKwh: 0.33, taxCtPerKwh: 2.325,
  vatRate: 0.255, tariff: 'day-night', transferRates: DEFAULT_TRANSFER_RATES_EX_VAT });
const CONFIGURATION_PROVENANCE = 'Options/configuration; all monetary inputs exclude VAT; transfer rates and VAT saved for this period';

function effectiveDateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Effective date must be YYYY-MM-DD in Finland');
  const date = moment.tz(value, 'YYYY-MM-DD', true, 'Europe/Helsinki');
  if (!date.isValid()) throw new Error('Invalid effective date');
  return date.valueOf();
}

/** Options contain only ex-VAT monetary values; VAT is applied exactly once. */
export function configuredPriceSettings(input = {}) {
  const settings = {
    marginCtPerKwh: input.margin_ct_per_kwh_ex_vat ?? DEFAULT_PRICE_SETTINGS.marginCtPerKwh,
    taxCtPerKwh: input.tax_ct_per_kwh_ex_vat ?? DEFAULT_PRICE_SETTINGS.taxCtPerKwh,
    vatRate: (input.vat_percent ?? 25.5) / 100,
    tariff: input.transfer_tariff ?? DEFAULT_PRICE_SETTINGS.tariff,
    transferRates: { vatIncluded: false,
      dayCtPerKwh: input.day_transfer_ct_per_kwh_ex_vat ?? DEFAULT_TRANSFER_RATES_EX_VAT.dayCtPerKwh,
      nightCtPerKwh: input.night_transfer_ct_per_kwh_ex_vat ?? DEFAULT_TRANSFER_RATES_EX_VAT.nightCtPerKwh,
      winterDayCtPerKwh: input.winter_day_transfer_ct_per_kwh_ex_vat ?? DEFAULT_TRANSFER_RATES_EX_VAT.winterDayCtPerKwh,
      otherCtPerKwh: input.other_transfer_ct_per_kwh_ex_vat ?? DEFAULT_TRANSFER_RATES_EX_VAT.otherCtPerKwh },
  };
  if (input.vat_percent != null && (typeof input.vat_percent !== 'number' || !Number.isFinite(input.vat_percent))) throw new Error('VAT percent must be a number');
  if (input.effective_date != null && input.effective_date !== '') {
    effectiveDateMs(input.effective_date);
    settings.effectiveDate = input.effective_date;
  }
  if (settings.marginCtPerKwh < -20 || settings.marginCtPerKwh > 100 || settings.taxCtPerKwh > 100) throw new Error('Check charge units: enter c/kWh excluding VAT');
  validateContract({ periods: [{ ...settings, from: 0 }] });
  return settings;
}

/** Apply configured rates without replacing previous rate snapshots. */
export function reconcileConfiguredContract(existing, settings, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('A valid configuration application time is required');
  const checked = validateContract({ periods: [{ ...settings, from: 0 }] }).periods[0];
  if (checked.transferRates.vatIncluded !== false) throw new Error('Configured transfer rates must exclude VAT');
  const periods = existing ? validateContract(existing).periods.map(p => ({ ...p, to: Number.isFinite(p.to) ? p.to : null })) : [];
  const signature = period => JSON.stringify({ marginCtPerKwh: period.marginCtPerKwh, taxCtPerKwh: period.taxCtPerKwh,
    vatRate: period.vatRate, tariff: period.tariff, transferRates: period.transferRates });
  const explicitFrom = settings.effectiveDate ? effectiveDateMs(settings.effectiveDate) : null;
  let previous = periods.at(-1);
  const unchanged = () => previous && signature(previous) === signature(checked) && previous.to === null;
  // An unchanged future appointment is stable on restart. Clearing or changing
  // its effective date is an intentional schedule edit, even with equal rates.
  if (unchanged() && (previous.from <= now || explicitFrom === previous.from)) return { ...existing, mode: 'billing', periods };
  let removedFuture = false;
  while (previous?.from > now && (previous.configurationManaged === true || previous.provenance === CONFIGURATION_PROVENANCE)) {
    const removed = periods.pop();
    removedFuture = true;
    previous = periods.at(-1);
    if (previous?.to === removed.from) {
      previous.to = Object.hasOwn(removed, 'previousPeriodTo') ? removed.previousPeriodTo : null;
    }
  }
  // Restoring the current values and clearing effective_date cancels an
  // unstarted change; no new duplicate period or historical edit is needed.
  if (removedFuture && explicitFrom === null && previous?.from <= now && (previous.to === null || previous.to > now)
    && signature(previous) === signature(checked)) return { ...existing, mode: 'billing', periods };
  if (unchanged() && previous.from <= now) return { ...existing, mode: 'billing', periods };
  const from = explicitFrom ?? (existing ? now : moment.tz(now, 'Europe/Helsinki').startOf('day').valueOf());
  if (previous && from <= previous.from) throw new Error('Configured electricity rates must start after the last saved period; choose a later effective_date or leave it empty');
  if (existing && from < now) throw new Error('Configured electricity changes cannot rewrite elapsed history; use a future effective_date or leave it empty');
  if (periods.length >= 512) throw new Error('At most 512 contract periods are supported');
  const previousPeriodTo = previous?.to ?? null;
  if (previous && (previous.to === null || previous.to > from)) previous.to = from;
  const { effectiveDate, ...rates } = settings;
  const contract = { mode: 'billing', periods: [...periods, { ...rates, transferRates: { ...checked.transferRates }, from, to: null,
    configurationManaged: true, ...(from > now ? { previousPeriodTo } : {}), provenance: CONFIGURATION_PROVENANCE }] };
  validateContract(contract);
  return contract;
}

export function contractWithPeriod(existing, input) {
  const from = effectiveDateMs(input?.effectiveDate);
  const periods = existing ? validateContract(existing).periods.map(p => ({ ...p, to: Number.isFinite(p.to) ? p.to : null })) : [];
  if (periods.some(p => p.from >= from)) throw new Error('New rates must start after the last configured period; existing historical rates are preserved');
  if (periods.length >= 100) throw new Error('At most 100 contract periods are supported');
  const previous = periods.at(-1);
  if (previous && (previous.to === null || previous.to > from)) previous.to = from;
  const next = { from, marginCtPerKwh: input.marginCtPerKwh, taxCtPerKwh: input.taxCtPerKwh,
    vatRate: input.vatRate, tariff: input.tariff,
    ...(input.transferRates ? { transferRates: { ...input.transferRates } } : {}),
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
