const finnishInput = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** datetime-local fields show house time, regardless of the browser's timezone. */
export function finnishDateTime(value) {
  if (value == null) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(finnishInput.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function temporaryValues(status) {
  const occupancy = status.settings?.occupancy;
  const away = occupancy?.mode === 'away' && Date.parse(occupancy.returnAt) > status.now;
  return { awayUntilLocal: away ? finnishDateTime(occupancy.returnAt) : '',
    pauseUntilLocal: status.override?.expiresAt > status.now ? finnishDateTime(status.override.expiresAt) : '' };
}

export function activeRates(status) {
  return status.contract?.periods?.find(period => Number(period.from) <= status.now
    && (period.to == null || Number(period.to) > status.now)) ?? null;
}

/** Legacy snapshots include transfer VAT; new configured snapshots exclude it. */
export function rateRows(period) {
  if (!period) return [];
  const multiplier = 1 + period.vatRate;
  const rows = [['Retailer margin', period.marginCtPerKwh], ['Electricity tax', period.taxCtPerKwh]]
    .map(([name, excludingVat]) => ({ name, excludingVat, includingVat: excludingVat * multiplier }));
  const transfer = period.transferRates;
  if (transfer) {
    const choices = period.tariff === 'seasonal'
      ? [['Winter day transfer', transfer.winterDayCtPerKwh], ['Other times transfer', transfer.otherCtPerKwh]]
      : [['Day transfer', transfer.dayCtPerKwh], ['Night transfer', transfer.nightCtPerKwh]];
    for (const [name, value] of choices) {
      rows.push({ name, excludingVat: transfer.vatIncluded === false ? value : value / multiplier,
        includingVat: transfer.vatIncluded === false ? value * multiplier : value });
    }
  }
  return rows;
}
