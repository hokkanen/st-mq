import { setStatusDetail } from './status-details.js';

export const priceStatuses = {
  simulated: 'Synthetic example prices', configured: 'All-in outlook available for configured dates',
  'contract-not-configured': 'Spot available · contract rates needed for all-in prices',
  'no-contract-coverage': 'Spot available · rates do not cover these dates',
  'missing-market-data': 'Waiting for market prices', 'stale-market-data': 'Market prices are stale',
  'partial-contract-coverage': 'All-in prices cover part of the outlook',
  'incomplete-market-coverage': 'Market outlook has missing intervals',
};

/** Home and Garage share the current household import rate and its provenance. */
export function currentPriceDisplay(status = {}) {
  const current = (status.prices ?? []).find(row => row.start <= status.now && row.end > status.now && Number.isFinite(row.allInCentsPerKWh));
  const spot = (status.spot ?? []).find(row => row.start <= status.now && row.end > status.now && Number.isFinite(row.spotCtPerKwh));
  const simulated = status.input === 'simulated';
  const value = current ? current.allInCentsPerKWh.toFixed(2) : spot ? spot.spotCtPerKwh.toFixed(2) : '—';
  const baseTitle = simulated ? 'Example all-in price' : current ? 'All-in price' : spot ? 'Spot price' : 'Electricity price';
  const description = simulated ? 'Synthetic simulation data.' : current ? 'Import price, including variable charges.'
    : spot ? 'Spot price only; excludes VAT and other charges.' : priceStatuses[status.priceStatus] ?? 'Waiting for price data';
  const spotPrice = spot?.spotCtPerKwh ?? current?.spotCtPerKwh;
  const spotDetail = current ? Number.isFinite(spotPrice)
    ? `Spot price: ${spotPrice.toFixed(2)} c/kWh, excluding VAT and other charges.`
    : 'Spot price is unavailable for this interval.' : '';
  const title = status.readOnly === true ? `Recorded ${baseTitle.toLowerCase()}` : baseTitle;
  return { value, title, label: status.readOnly === true ? 'RECORDED PRICE' : title.toUpperCase(), unit: current || spot ? 'c/kWh' : '',
    detail: [status.readOnly === true ? 'Price at the recorded snapshot time. This does not confirm the current electricity price.' : '', `${current || spot ? `${value} c/kWh. ` : ''}${description}`, spotDetail].filter(Boolean).join('\n\n') };
}

export function renderCurrentPrice(document, status, prefix = '') {
  const display = currentPriceDisplay(status), id = `${prefix}price`;
  const label = document.getElementById(`${id}-label`), unit = document.getElementById(`${id}-unit`);
  if (label) label.textContent = display.label;
  if (unit) unit.textContent = display.unit;
  setStatusDetail(document.getElementById(id), { key: `metric-${id}`, label: display.value,
    title: display.title, detail: display.detail });
}
