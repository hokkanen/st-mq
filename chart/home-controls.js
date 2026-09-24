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

/** Configured price control is not actively commanding equipment in every mode. */
export function priceControlState(status = {}, { enabled = true, paused = false, away = false } = {}) {
  if (paused) return { label: 'Paused', state: 'paused' };
  if (enabled === false) return { label: 'Disabled', state: 'muted' };
  if (status.input === 'offline') return { label: 'Offline', state: 'muted' };
  if (enabled !== true || !status.mode) return { label: '—', state: 'muted' };
  if (status.mode !== 'active') return { label: status.mode[0].toUpperCase() + status.mode.slice(1), state: 'muted' };
  return { label: away ? 'Away' : 'Active', state: 'active' };
}

export function activeRates(status) {
  return status.contract?.periods?.find(period => Number(period.from) <= status.now
    && (period.to == null || Number(period.to) > status.now)) ?? null;
}

/** Every current contract supplies an explicit tax basis, including historical rates. */
export function rateRows(period) {
  if (!period || typeof period.transferRates?.vatIncluded !== 'boolean') return [];
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

/** Read-only policy summaries follow the existing configuration/reload workflow. */
export function homePolicyValues(status = {}) {
  const settings = status.settings ?? {}, comfort = settings.comfort ?? {};
  return {
    aggressiveness: Number.isFinite(settings.savingsAggressiveness) ? `${settings.savingsAggressiveness} / 100` : 'Unavailable',
    preheat: Number.isFinite(settings.preheatRoomBoostC) ? `ROOM +${settings.preheatRoomBoostC} °C` : 'Unavailable',
    maximumRise: Number.isFinite(comfort.maxRiseC) ? `${comfort.maxRiseC} °C` : 'Unavailable',
    limits: Number.isFinite(comfort.maxDropC) && Number.isFinite(comfort.maxRiseC)
      ? `−${comfort.maxDropC} / +${comfort.maxRiseC} °C` : 'Limits unavailable',
  };
}

/** The backend resolves individual learned references and shared occupied bounds. */
export function homeRoomReferences(status = {}) {
  const temperature = value => Number.isFinite(value)
    ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)} °C` : 'Unavailable';
  return (status.comfortRooms ?? []).map(room => ({
    id: room.id, label: room.label,
    reference: temperature(room.referenceC),
    basis: room.referenceSource === 'room' ? 'Learned room reference'
      : room.referenceSource === 'overall' ? 'Overall reference' : 'Reference not established',
    limits: Number.isFinite(room.minC) && Number.isFinite(room.maxC)
      ? `${temperature(room.minC)} – ${temperature(room.maxC)}` : 'Limits unavailable',
    inactive: room.limitsApply === false,
  }));
}

export function renderHomeRoomReferences(document, status) {
  const root = document.getElementById('home-room-references');
  if (!root) return;
  const rows = homeRoomReferences(status);
  const heading = document.getElementById('home-room-limits-status');
  if (heading) heading.textContent = rows.length && rows.every(row => row.inactive) ? 'Inactive while away' : 'When you are home';
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement('div'), title = document.createElement('dt'), detail = document.createElement('dd');
    const reference = document.createElement('strong');
    title.textContent = row.label; reference.textContent = row.reference;
    detail.append(reference, ` · ${row.basis}. Limits: ${row.limits}${row.inactive ? ' · inactive while away' : ''}.`);
    item.append(title, detail); fragment.append(item);
  }
  if (!rows.length) {
    const unavailable = document.createElement('p');
    unavailable.className = 'muted'; unavailable.textContent = 'Room references are unavailable.';
    fragment.append(unavailable);
  }
  root.replaceChildren(fragment);
}
