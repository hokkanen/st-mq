import { isReadOnlyReplica } from './replica-status.js';
import { HEATING_STRATEGIES } from '../src/domain/heating-strategy.js';

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

/** Automation permission belongs to the selected feature; manual commands are independent. */
export function priceControlState(status = {}, { feature = 'home', enabled = true, paused = false, away = false } = {}) {
  if (isReadOnlyReplica(status)) return { label: 'Recorded', state: 'muted' };
  if (status.input === 'offline') return { label: 'History viewer', state: 'muted' };
  if (paused) return { label: 'Paused', state: 'paused' };
  if (enabled !== true) return { label: 'Unavailable', state: 'muted' };
  const automation = status.automation?.[feature];
  if (!automation) return { label: 'Unavailable', state: 'muted' };
  if (!automation.enabled) return { label: 'Paused', state: 'paused' };
  if (automation.available === false) return { label: 'Unavailable', state: 'muted' };
  return { label: away ? 'Away · Automatic' : 'Automatic', state: 'active' };
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

/** Policy summaries use the current snapshot, never inventing missing settings. */
export function homePolicyValues(status = {}) {
  const settings = status.settings ?? {}, comfort = settings.comfort ?? {};
  const strategy = HEATING_STRATEGIES.find(option => option.id === settings.savingsStrategy);
  const parameters = status.learning?.parameters ?? {};
  const amount = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
  const money = value => `€${amount(value / 100)}`;
  const trialBudget = parameters.learningTrials === false ? 'Learning trials are disabled in configuration.'
    : parameters.learningTrials === true && Number.isFinite(parameters.trialBudgetCentsPerDay) && Number.isFinite(parameters.maxTrialCostCents)
      ? `Learning trials are enabled, with estimated exposure capped at ${money(parameters.maxTrialCostCents)} per trial and ${money(parameters.trialBudgetCentsPerDay)} per day. Current evidence and remaining budget still determine whether a trial can run.`
      : 'Learning-trial settings are unavailable.';
  const economics = status.decision?.plan?.economics;
  const benefit = status.decision?.plan?.trial === true
    ? 'This is a bounded learning trial, not a cycle admitted for predicted savings.'
    : Number.isFinite(economics?.lowerBenefitCents) && Number.isFinite(economics?.hurdleCents)
      ? `Latest cycle comparison: ${money(economics.lowerBenefitCents)} conservative space-heating benefit against a ${money(economics.hurdleCents)} required benefit. Both are estimates; the current checks still determine execution.` : '';
  const durations = ['maxPreheatHours', 'maxReductionHours', 'maxAwayReductionHours', 'maxUnobservedReductionHours']
    .every(key => Number.isFinite(parameters[key]))
    ? `Configured ceilings: preheat ${amount(parameters.maxPreheatHours)} h; reduction ${amount(parameters.maxReductionHours)} h at home or ${amount(parameters.maxAwayReductionHours)} h away. Without native heat-pump observations, reduction is capped at ${amount(parameters.maxUnobservedReductionHours)} h. Demonstrated response, comfort and forecast coverage can shorten these limits.`
    : 'Configured duration limits are unavailable.';
  return {
    strategy: strategy?.label ?? 'Unavailable', strategyId: strategy?.id ?? null,
    preheat: Number.isFinite(settings.preheatRoomBoostC) ? `${amount(settings.preheatRoomBoostC)} °C` : 'Unavailable',
    maximumRise: Number.isFinite(comfort.maxRiseC) ? `${amount(comfort.maxRiseC)} °C` : 'Unavailable',
    limits: Number.isFinite(comfort.maxDropC) && Number.isFinite(comfort.maxRiseC)
      ? `−${amount(comfort.maxDropC)} / +${amount(comfort.maxRiseC)} °C` : 'Limits unavailable',
    trialBudget, benefit, durations,
  };
}

/** Keep native disclosures and selection summaries stable through status polling. */
export function renderHomePolicy(document, status) {
  const policy = homePolicyValues(status);
  for (const [id, value] of Object.entries({
    'home-savings-strategy': policy.strategy, 'home-preheat-setting': policy.preheat,
    'home-maximum-rise': policy.maximumRise, 'home-policy-trials': policy.trialBudget,
    'home-policy-durations': policy.durations, 'home-policy-economics': policy.benefit,
    'home-comfort-limits': status.decision?.comfort?.maxDropApplies === false ? 'Away · limits inactive' : policy.limits,
  })) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }
  for (const strategy of HEATING_STRATEGIES) {
    const selected = strategy.id === policy.strategyId;
    const option = document.getElementById(`home-strategy-${strategy.id}`);
    if (option) option.dataset.selected = String(selected);
    const current = document.getElementById(`home-strategy-${strategy.id}-current`);
    if (current) current.hidden = !selected;
  }
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
