import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';
import { chargerSummary, chargingCost } from './charging-summary.js';

const finite = Number.isFinite;
const number = (value, unit = '') => finite(value) ? `${Number(value.toFixed(1))}${unit ? ` ${unit}` : ''}` : 'Unknown';
const human = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const validTime = value => value != null && value !== '' && finite(new Date(value).getTime());
const dateKey = (value, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export function chargingTime(value, timezone = 'Europe/Helsinki', now = Date.now()) {
  if (!validTime(value)) return 'Time unknown';
  try {
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    const day = dateKey(value, timezone), today = dateKey(now, timezone);
    if (day === today) return clock;
    // Compare local calendar dates rather than adding 24 hours across DST.
    const nextDate = new Date(`${today}T12:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    if (day === nextDate.toISOString().slice(0, 10)) return `tomorrow ${clock}`;
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short',
      ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) }).format(new Date(value));
    return `${date} ${clock}`;
  } catch { return new Date(value).toISOString(); }
}
const automatic = field => field?.available === true && !['manual', 'manual-fallback', 'assumed'].includes(field.source);
const sourceLabel = field => {
  if (['manual', 'manual-fallback'].includes(field?.source)) return 'Manual fallback';
  if (field?.assumed || field?.source === 'assumed') return 'Planning assumption';
  if (field?.available !== true) return 'Awaiting a reading';
  return ({ mqtt: 'Vehicle MQTT', teslamate: 'TeslaMate', easee: 'Easee' })[field.source] ?? 'Automatic';
};
const notices = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => human(item?.message ?? item?.reason ?? item));
const settingId = (id, key) => `${id}-setting-${key.replaceAll('.', '-')}`;
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function assign(object, path, value) {
  const keys = path.split('.'), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
}

// One field definition and one renderer serve every charger. The server supplies
// first-use defaults and capabilities, including for chargers added later.
export const chargingFields = [
  { key: 'manualSoc', reading: 'soc', label: 'Starting charge · %', type: 'number', min: 0, max: 100, step: 0.1, automatic: true,
    help: 'Starting point when the vehicle does not report its charge. Delivered energy updates the estimate from here.' },
  { key: 'minimumSoc', label: 'Target charge · %', type: 'number', min: 0, max: 100, step: 1, automatic: true,
    help: 'The vehicle charge target takes priority when available.' },
  { key: 'readyBy', label: 'Ready-by time · local', type: 'time', scheduling: true,
    help: 'Plan to reach the target by this time. The final charging period continues until the vehicle finishes.' },
  { key: 'capacityKwh', label: 'Usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, automatic: true,
    help: 'Manual fallback when the vehicle does not report usable capacity.' },
].map(field => ({ type: 'text', ...field }));

export function chargingReadingTime(value, timezone = 'Europe/Helsinki') {
  if (!validTime(value)) return 'Time unknown';
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function householdReferenceText(reference, now) {
  if (!reference) return 'Household reference details are not available yet.';
  const hasReference = finite(reference.nights) && reference.nights > 0;
  if (reference.loading && !hasReference) return 'Preparing household history. A confirmed schedule stays in effect; otherwise charging is allowed while the forecast is prepared.';
  if ((reference.unavailable || reference.error) && !hasReference) return 'Household history could not be prepared. A confirmed schedule stays in effect; otherwise charging is allowed while preparation retries.';
  if (reference.noHistory) return 'No usable household reference yet; zero other household load is assumed.';
  const count = reference.nights;
  const countText = finite(reference.minimumNights) && reference.minimumNights < count ? `${reference.minimumNights}–${count}` : count;
  const parts = [finite(count) ? `${countText} comparable ${count === 1 ? 'night' : 'nights'}` : 'Comparable household history'];
  if (reference.limited) parts.push('early estimate');
  if (Array.isArray(reference.temperatureRangeC) && reference.temperatureRangeC.length === 2
    && reference.temperatureRangeC.every(finite)) parts.push(`${number(reference.temperatureRangeC[0])} to ${number(reference.temperatureRangeC[1], '°C')}`);
  if (validTime(reference.oldestAt) && now - Number(reference.oldestAt) > 180 * 86400_000) parts.push('includes older seasonal readings');
  if (reference.unknownCharger2) parts.push('older readings may include unmeasured charging');
  if (reference.missingHours > 0) parts.push('zero other load for hours without any usable reference');
  if (reference.loading) parts.push('refreshing the reference');
  else if (reference.unavailable || reference.error) parts.push('last reference retained while refresh retries');
  return `${parts.join(' · ')}.`;
}

export function chargerDisplay(charger, { now = Date.now(), timezone = 'Europe/Helsinki', assumptions = {} } = {}) {
  const values = charger.values ?? {}, settings = charger.settings ?? {}, control = charger.control ?? {};
  const plan = charger.plan ?? {}, forecast = charger.forecast ?? {}, soc = values.soc ?? {};
  const time = value => chargingTime(value, timezone, now);
  const connected = values.connected?.value, charging = connected === true && values.charging?.value === true;
  const supported = charger.capabilities?.scheduling === true, enabled = supported && settings.enabled === true;
  const phase = control.phase ?? '', manual = enabled ? control.manual ?? control.manualOverride : null;
  const uncertain = enabled && (['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed'].includes(phase) || Boolean(control.errorCode));
  const yielded = enabled && (['yielded', 'manual'].includes(phase) || Boolean(manual));
  const activeManual = yielded && manual?.kind !== 'unknown';
  const handoverUnconfirmed = !enabled && control.handoverConfirmed === false;
  const released = enabled && ['released', 'charging'].includes(phase);
  const provisional = enabled && phase === 'provisional';
  const owned = enabled && !yielded && control.confirmed !== false ? control.owned : null;
  const execution = enabled && !yielded ? control.execution : null;
  const ownedPeriods = (execution?.periods ?? owned?.periods ?? []).filter(period => validTime(period.startAt));
  const ownedStart = validTime(owned?.startAt) ? owned.startAt : ownedPeriods[0]?.startAt;
  const periods = ownedPeriods.length ? ownedPeriods : ownedStart != null ? [{ startAt: ownedStart, endAt: null }]
    : !yielded && !uncertain ? (plan.periods ?? []).filter(period => validTime(period.startAt)) : [];
  const currentPeriod = periods.find(period => Number(period.startAt) <= now && (!validTime(period.endAt) || Number(period.endAt) > now));
  const nextPeriod = periods.find(period => Number(period.startAt) > now);
  const confirmedRevision = Boolean(execution?.planId) && execution.planId === plan.id;
  const revisionPending = !confirmedRevision && ownedStart != null && (ownedPeriods.length > 0 && Array.isArray(plan.periods)
    ? JSON.stringify(ownedPeriods.map(p => [p.startAt, p.endAt])) !== JSON.stringify(plan.periods.map(p => [p.startAt, p.endAt]))
    : validTime(plan.startAt) && Number(ownedStart) !== Number(plan.startAt));
  const nativeStart = values.scheduledStartAt?.value, nativeEnd = values.scheduledEndAt?.value;
  const endKind = charger.scheduledEndKind ?? charger.telemetry?.scheduledEndKind ?? values.scheduledEndAt?.kind;
  const nativeStops = ['enforced', 'scheduled-stop'].includes(endKind);
  const progress = charger.progress ?? {};
  const creditedGridKwh = progress.deliveredGridKwh ?? progress.creditedGridKwh;
  const hasProgress = finite(creditedGridKwh) && creditedGridKwh > 0;
  const estimatedSoc = finite(progress.estimatedSoc) && progress.hasEnergyEstimate === true;
  const requiredGridKwh = charger.progress?.remainingGridKwh ?? charger.requiredGridKwh ?? plan.requiredGridKwh ?? forecast.requiredGridKwh ?? forecast.gridEnergyKwh;
  const minimum = values.minimumSoc?.value, socKnown = finite(soc.value) && (soc.available || soc.source === 'manual-fallback');
  const finishAt = Object.hasOwn(forecast, 'finishAt') ? forecast.finishAt : plan.finishAt;
  const manualStart = manual?.startsAt ?? manual?.startAt ?? nativeStart;
  const manualEnd = manual?.windowEndAt ?? manual?.endsAt ?? manual?.endAt ?? (nativeStops ? nativeEnd : null);
  const resumeAt = manual?.resumeAt ?? manual?.expiresAt ?? manualEnd;
  const hasManualWindow = activeManual && manual?.kind === 'window' && validTime(manualEnd ?? resumeAt);
  const cycleCapped = validTime(manualEnd) && validTime(resumeAt) && Number(resumeAt) < Number(manualEnd);
  const window = (start, end, includePastStart = false) => {
    if (!validTime(start) || !includePastStart && Number(start) <= now) return `until ${time(end)}`;
    const endTime = dateKey(start, timezone) === dateKey(end, timezone) ? time(end).match(/\d{2}:\d{2}$/)?.[0] : time(end);
    return `${time(start)}–${endTime}`;
  };
  const resumption = validTime(resumeAt) ? Number(resumeAt) <= now ? 'Manual priority expired; automatic handover awaiting confirmation.'
    : `Automatic control resumes ${time(resumeAt)}${cycleCapped ? ' at the ready-by boundary' : ''}.` : '';
  let state = connected === false ? 'Not connected' : connected === true ? 'Connected' : 'Connection unknown';
  let event = '', eventAt = null, eventKind = null;
  if (connected !== true) {
    event = activeManual && resumption ? resumption : enabled ? connected === false ? 'Automatic charging is ready for the next connection' : 'Waiting for charger readings'
      : supported ? 'Automatic charging OFF' : 'Monitoring';
  } else if (activeManual && validTime(resumeAt) && Number(resumeAt) <= now) {
    state = charging ? 'Charging' : 'Handover pending';
    event = charging && finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now` : 'Automatic handover pending';
  } else if (activeManual) {
    state = charging ? hasManualWindow ? 'Charging · manual schedule' : 'Charging · manual control' : hasManualWindow ? 'Manual schedule' : 'Manual control';
    event = `${charging && finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now · ` : ''}${hasManualWindow
      ? `Manual window ${window(manualStart, manualEnd ?? resumeAt)}` : manual?.reason || 'Manual charger control is active.'}`;
    eventAt = validTime(resumeAt) ? Number(manualStart) > now ? manualStart : resumeAt : null; eventKind = 'manual';
  } else if (charging) {
    state = 'Charging'; event = finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now` : 'Charging now';
    if (phase === 'pause-unconfirmed') event += ' · pause awaiting confirmation';
    else if (currentPeriod && validTime(currentPeriod.endAt) && !released) event += ` · pauses ${time(currentPeriod.endAt)}`;
    else if (!enabled && nativeStops && validTime(nativeEnd) && Number(nativeEnd) > now) event += ` · scheduled until ${time(nativeEnd)}`;
    else if (finite(requiredGridKwh) && requiredGridKwh <= 0) event += ' · target reached';
    else if (validTime(finishAt)) event += ` · ${number(minimum, '%')} estimated ${time(finishAt)}`;
  } else if (ownedStart != null && nextPeriod) {
    const resuming = periods.some(period => Number(period.startAt) <= now);
    state = uncertain ? 'Update unconfirmed' : resuming ? 'Paused between periods' : 'Scheduled';
    eventAt = nextPeriod.startAt; eventKind = 'confirmed';
    event = `${uncertain ? 'Last confirmed ' : ''}${resuming ? uncertain ? 'resume' : 'Resumes' : uncertain ? 'start' : 'Starts'} ${time(eventAt)}${revisionPending && !uncertain ? ' · update awaiting confirmation' : ''}`;
  } else if (handoverUnconfirmed) {
    state = 'Handover unconfirmed'; event = 'Waiting for the charger to confirm the handover.';
  } else if (uncertain || enabled && manual?.kind === 'unknown') {
    state = 'Control unavailable'; event = 'Waiting for a confirmed charger instruction.';
  } else if (released || provisional || (owned || execution) && currentPeriod) {
    event = 'Charging is allowed';
    if (validTime(finishAt) && Number(finishAt) > now && requiredGridKwh > 0) event += ` · ${number(minimum, '%')} estimated ${time(finishAt)}`;
  } else if (enabled && validTime(nextPeriod?.startAt ?? plan.startAt) && Number(nextPeriod?.startAt ?? plan.startAt) > now) {
    eventAt = nextPeriod?.startAt ?? plan.startAt; eventKind = 'proposed'; event = `Proposed start ${time(eventAt)}`;
  } else if (!enabled && validTime(nativeStart) && Number(nativeStart) > now) {
    eventAt = nativeStart; eventKind = 'vehicle';
    event = nativeStops && validTime(nativeEnd) ? `Scheduled ${window(nativeStart, nativeEnd)}` : `Scheduled start ${time(nativeStart)}`;
  } else if (enabled) event = control.reason || 'Waiting for a charging plan';
  else event = supported ? 'Automatic charging OFF' : 'Monitoring';
  if (handoverUnconfirmed) state = 'Handover unconfirmed';
  const showMetrics = connected === true;
  const showPlan = enabled && showMetrics && !yielded && (!uncertain || ownedStart != null);
  const currentForecast = Object.hasOwn(forecast, 'feasible') ? forecast : plan;
  const risk = showPlan && currentForecast.feasible === false && currentForecast.reason === 'insufficient-time';
  const deadline = showMetrics && enabled && !yielded && validTime(plan.deadlineAt ?? charger.deadlineAt) ? `Ready by ${time(plan.deadlineAt ?? charger.deadlineAt)}` : '';
  const readiness = !deadline ? '' : finite(requiredGridKwh) && requiredGridKwh <= 0 ? 'Target reached'
    : risk ? `${number(minimum, '%')} by ready-by is at risk`
      : currentForecast.feasible === true && validTime(finishAt) ? 'Expected on time' : 'Readiness being checked';
  const readingTime = showMetrics && automatic(soc) ? validTime(soc.measuredAt) ? `Charge measured ${chargingReadingTime(soc.measuredAt, timezone)}`
    : validTime(soc.receivedAt) ? `Charge received ${chargingReadingTime(soc.receivedAt, timezone)} · measurement time unknown` : 'Charge measurement time unknown' : '';
  const rows = [];
  if (activeManual && validTime(manual.detectedAt)) rows.push(['Manual change noticed', chargingReadingTime(manual.detectedAt, timezone)]);
  if (charging && finite(values.actualCurrentA?.value)) rows.push(['Drawing now', number(values.actualCurrentA.value, 'A per phase')]);
  if (showMetrics && charger.capabilities?.externalLoadBalancing && finite(values.availableCurrentA?.value))
    rows.push(['Last reported Equalizer allowance', `${number(values.availableCurrentA.value, 'A per phase')}${validTime(values.availableCurrentA.measuredAt)
      ? ` · ${time(values.availableCurrentA.measuredAt)}` : validTime(values.availableCurrentA.receivedAt) ? ` · received ${time(values.availableCurrentA.receivedAt)}` : ''}`]);
  else if (showMetrics && !charger.capabilities?.externalLoadBalancing && finite(values.currentA?.value)) rows.push(['Selected charging current', number(values.currentA.value, 'A per phase')]);
  if (showMetrics && finite(values.maximumCurrentA?.value)) rows.push(['Charging limit', number(values.maximumCurrentA.value, 'A per phase')]);
  if (showPlan && requiredGridKwh > 0 && finite(forecast.powerKw) && finite(forecast.shortfallGridKwh)
    && typeof forecast.feasible === 'boolean')
    rows.push(['Forecast charging power', `${number(forecast.powerKw, 'kW')} average during planned periods`]);
  if (showPlan) for (const load of assumptions.competingLoads ?? []) {
    if (load.chargerId === charger.id || load.known !== true || !validTime(load.startAt) || !validTime(load.endAt)
      || Number(load.endAt) <= now || validTime(plan.deadlineAt ?? charger.deadlineAt) && Number(load.startAt) >= Number(plan.deadlineAt ?? charger.deadlineAt)
      || !finite(load.powerKw) || load.powerKw <= 0) continue;
    rows.push(['Other scheduled charging', `${load.label ?? human(load.chargerId)} · ${Number(load.startAt) > now ? `starts ${time(load.startAt)} · ` : ''}${number(load.powerKw, 'kW')} until about ${time(load.endAt)}`]);
  }
  if (showMetrics && hasProgress) rows.push(['Delivered since starting charge', `${number(creditedGridKwh, 'kWh')} from the grid`]);
  if (showMetrics && estimatedSoc && automatic(soc)) rows.push(['Vehicle charge reading', `${number(soc.value, '%')} · ${sourceLabel(soc)}`]);
  if (showPlan && !released && !charging && finite(plan.costCents) && !uncertain && !revisionPending) {
    rows.push(['Estimated cost to target', `€${(plan.costCents / 100).toFixed(2)}`]);
    if (periods.length > 1 && finite(plan.savingsCents) && plan.savingsCents > 0) rows.push(['Saving from pauses', `€${(plan.savingsCents / 100).toFixed(2)} compared with one continuous period`]);
  }
  const periodRows = showPlan && !released && !provisional ? periods.map((period, index) => [`Period ${index + 1}`, validTime(period.endAt)
    ? window(period.startAt, period.endAt, true) : `${time(period.startAt)} onwards · vehicle finishes naturally`]) : [];
  const periodCount = showPlan && !released && !provisional && periods.length > 1 ? `${periods.length} charging periods${ownedPeriods.length ? '' : ' proposed'}` : '';
  const fallbackNotice = /manual (?:fallback|battery percentage|minimum)|remembered manual|assumes? (?:0|20)%|phase count is known|preview assumes the vehicle/i;
  const shortfall = currentForecast.shortfallGridKwh;
  const shortfallNote = risk && finite(shortfall) && shortfall > 0 && finite(minimum) && deadline
    ? `Forecast is ${shortfall < 0.1 ? 'less than 0.1 kWh' : number(shortfall, 'kWh')} short of the ${number(minimum, '%')} target by ${deadline.replace(/^Ready by /, '')}.` : '';
  const notes = enabled && showMetrics && !yielded && !uncertain
    ? [...notices(plan.warnings), ...notices(forecast.warnings)].filter(note => !fallbackNotice.test(note)
      && !(shortfallNote && /predicted charging capacity cannot deliver/i.test(note))
      && !(currentForecast !== plan && currentForecast.feasible !== false && /cannot deliver|insufficient.*time|target at risk/i.test(note))) : [];
  if (shortfallNote && !uncertain) notes.push(shortfallNote);
  let problem = uncertain || handoverUnconfirmed || enabled && manual?.kind === 'unknown' ? control.reason || 'The charger instruction could not be confirmed. Another reading will be requested.' : '';
  if (charger.error) problem ||= ({ 'charging-adapter-unavailable': 'The charger connection is unavailable. Automatic control is waiting for a connection.',
    'charging-reconciliation-unavailable': 'The charger schedule could not be confirmed. The last instruction may still be active; another reading will be requested.',
    'charging-planning-unavailable': 'The charging forecast could not be updated. The last confirmed instruction remains in effect; planning will retry.' })[charger.error] ?? human(charger.error);
  const missed = control.lastMissedTransition;
  if (enabled && showMetrics && !yielded && validTime(missed?.pauseAt) && validTime(missed?.resumeAt))
    notes.push(`Planned pause ${window(missed.pauseAt, missed.resumeAt, true)} was not confirmed; charging may have continued.`);
  if (showMetrics && charger.mqtt?.reason && !['awaiting-mqtt', 'awaiting-subscription', 'awaiting-report', 'idle', 'asleep'].includes(charger.mqtt.reason))
    notes.push(`Vehicle feed: ${human(charger.mqtt.reason)}. The last valid reading remains visible with its original timestamp.`);
  if (showMetrics && progress.basis?.energyCoverageIncomplete) notes.push('Some charging energy was not measured. The charge estimate may be low until a new vehicle reading arrives.');
  const controlDetail = !supported ? 'This integration supports monitoring only.'
    : activeManual ? 'Resume automatic charging to end manual priority early. A later manual change takes priority again.'
      : provisional ? 'Charging is allowed for now. The forecast is being updated; economical periods can still be scheduled when it improves.'
      : 'Choose economical charging periods to reach the target by the ready-by time.';
  const efficiency = charger.configuration?.efficiency;
  const explanations = [
    ['Readings & fallbacks', 'Vehicle charge, target and usable capacity take priority when available. Otherwise, the saved starting charge, requested target and capacity are used. The original date and time of a vehicle reading stay visible as it ages.'],
    ['Charging progress', 'Delivered charging energy raises the estimated charge from the starting value, allowing for charging losses and usable capacity. A new vehicle reading updates that starting point. The original vehicle reading stays separate; missing energy is not invented. The estimate can keep rising beyond the requested target.'],
    ['Energy estimate', `Three-phase charging is assumed; voltage comes from provider readings.${finite(efficiency) ? ` Charging efficiency is ${number(efficiency * 100, '%')}; grid energy includes those losses.` : ''}`],
  ];
  if (supported) explanations.push(
    ['Price planning', 'Charging may pause between cheaper periods when the saving is worthwhile. Planned pauses last at least 15 minutes. The final period leaves charging enabled until the vehicle finishes, including beyond the target and ready-by time. Estimates cover reaching the requested target.'],
    ['Period transitions', 'Installing planned pauses and next starts requires this service and the Easee cloud. Easee shows the current instruction; this page shows all planned periods. If contact is lost, the last instruction remains in effect and an open period may continue past a planned pause. Missed or unconfirmed transitions are reported when contact resumes.'],
    ['Household forecast', 'Property consumption is reduced by known charging, then matched to local hours and outdoor conditions. A couple of usable nights can begin the estimate. Recent similar nights carry more weight, while older cold-weather readings remain useful when those conditions return. Broader history is used when close matches are scarce; zero other load is assumed only when no usable reference exists.'],
    ['Current reference', householdReferenceText(assumptions.householdReference, now)],
    ['Other charging', 'Another charger is reserved as a future load only when a charging event is scheduled. Actual consumption is already reflected in property readings.'],
    ['Manual priority', 'A noticed external schedule change has priority until its window ends or the next ready-by time, whichever comes first. Resume automatic charging ends that priority early; a later manual change takes priority again. Changes are observed with automatic charging off too. A fresh charger read is required before handover.'],
    ['Saved priority', 'The first charger reading establishes a baseline; existing schedules alone do not claim priority. Our own changes and normal schedule expiry do not count as manual changes. Priority survives reconnection and restart. Editing ready-by does not move an already recorded expiry.'],
    ['Unavailable data', 'Without a reliable price or power forecast, or with too little time, charging is allowed immediately while planning continues. Economical periods can still be scheduled when the forecast improves. A disabled charger, fault or authorization requirement must be resolved first. Unconfirmed changes retain the last known instruction and are retried after another charger reading.'],
  );
  if (charger.capabilities?.externalLoadBalancing) {
    const basis = ({
      'observed-budget': 'The forecast infers available supply from Equalizer and property readings, then applies expected household use.',
      'observed-lower-bound': 'The forecast uses a lower bound inferred from capped Equalizer and property readings; actual headroom may be higher. Expected household use is deducted from that bound.',
      'equalizer-adjusted': 'The forecast replaces current household demand in Equalizer and property readings with expected household use.',
      'equalizer-live': 'Supply-budget evidence is unavailable, so the forecast uses the last reported Equalizer allowance without subtracting household use again.',
      unavailable: 'A usable supply estimate is still being established.',
    })[assumptions.supply] ?? 'The night forecast combines the available supply with expected household use; the last reported allowance describes current conditions.';
    explanations.splice(2, 0, ['Current allocation', `Equalizer controls the current and protects the property supply. ${basis} The charging limit caps the forecast. Automatic charging does not change Equalizer limits.`]);
  }
  const socSource = estimatedSoc ? automatic(soc) ? 'Estimated from vehicle charge + delivered energy' : 'Estimated from starting charge + delivered energy'
    : automatic(soc) ? sourceLabel(soc) : 'Starting charge';
  const targetSource = automatic(values.minimumSoc) ? `Target from ${sourceLabel(values.minimumSoc)}` : 'Requested target';
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk, showMetrics,
    soc: estimatedSoc ? `≈${Math.round(progress.estimatedSoc)} %` : socKnown ? number(soc.value, '%') : 'Unknown', socSource, minimum: number(minimum, '%'),
    minimumSource: targetSource, sources: socSource,
    gridEnergy: `${estimatedSoc && requiredGridKwh > 0 ? '≈' : ''}${number(requiredGridKwh, 'kWh')}`, deadline, readiness, readingTime, periodCount, periodRows,
    priority: activeManual && showMetrics ? resumption : '',
    energyLabel: hasProgress ? 'Grid remaining' : 'Grid to target',
    energyNote: requiredGridKwh === 0 ? hasProgress ? 'Target energy delivered' : 'Target already met' : 'Includes losses', problem,
    rows, notes: [...new Set(notes)].filter(note => note !== event), explanations, yielded: activeManual, supported, controlDetail };
}

export function chargingDisplay(charging, now = Date.now()) {
  return { chargers: (charging?.chargers ?? []).map(charger => chargerDisplay(charger, { now,
    timezone: charging.timezone ?? 'Europe/Helsinki', assumptions: charging.coordination?.assumptions })) };
}
export function chargingContext(charging, now = Date.now()) {
  return chargingDisplay(charging, now).chargers.filter(view => view.state === 'Charging' || view.eventAt != null)
    .map(view => `${view.label}: ${view.event}.`).join(' ');
}

export function createChargingPanel({ document, request, beforeRequest = () => {}, onStatus = () => {}, afterRequest = () => {} }) {
  const $ = id => document.getElementById(id), devices = new Map(), listeners = [];
  let status, busy = false;
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className; if (id) node.id = id; return node;
  };
  const bind = (node, event, action) => { if (!node) return; node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action)); };
  const writable = () => Boolean(status?.charging && status.readOnly !== true && status.charging.readOnly !== true && !isReadOnlyReplica(status));
  const set = (id, text) => { if ($(id)) $(id).textContent = text; };
  const rowNodes = new WeakMap();
  const energyNodes = new WeakMap();
  function energyText(root, text) {
    let parts = energyNodes.get(root);
    if (!parts) {
      parts = { value: make('span'), unit: make('span', '', 'charging-energy-unit') };
      root.replaceChildren(parts.value, parts.unit); energyNodes.set(root, parts);
    }
    const match = text.match(/^(.*) kWh$/);
    parts.value.textContent = match?.[1] ?? text;
    parts.unit.textContent = match ? ' kWh' : '';
  }
  const metricTriggers = new WeakSet();
  function metricDetail(root, options) {
    const trigger = setStatusDetail(root, options);
    if (trigger && !metricTriggers.has(trigger)) {
      metricTriggers.add(trigger);
      bind(trigger, 'click', event => { event.preventDefault(); event.stopPropagation(); });
    }
  }
  function list(root, rows) {
    const nodes = rowNodes.get(root) ?? new Map(); rowNodes.set(root, nodes);
    const keys = new Set(), occurrences = new Map();
    rows.forEach(([label, text, detail], index) => {
      const occurrence = occurrences.get(label) ?? 0; occurrences.set(label, occurrence + 1);
      const key = `${label}:${occurrence}`; keys.add(key);
      let row = nodes.get(key);
      if (!row) { row = { term: make('dt'), value: make('dd') }; nodes.set(key, row); root.append(row.term, row.value); }
      setStatusDetail(row.term, { label, title: label, detail, key: `${root.id}:${key}` });
      row.value.textContent = text;
      if (root.children[index * 2] !== row.term) root.insertBefore(row.term, root.children[index * 2] ?? null);
      if (root.children[index * 2 + 1] !== row.value) root.insertBefore(row.value, root.children[index * 2 + 1] ?? null);
    });
    for (const [key, row] of nodes) if (!keys.has(key)) { row.term.remove(); row.value.remove(); nodes.delete(key); }
  }
  function createField(group, field, root) {
    const container = make('div', '', 'charging-field');
    const label = make('label', field.label), input = make('input', '', '', settingId(group.id, field.key));
    input.type = field.type; input.disabled = true; input.required = !field.nullable;
    for (const key of ['min', 'max', 'step']) if (field[key] !== undefined) input[key] = field[key];
    if (field.nullable) input.placeholder = 'Not set';
    const help = make('small', '', 'charging-field-help', `${input.id}-help`);
    label.htmlFor = input.id; input.setAttribute('aria-describedby', help.id);
    container.append(label, input, help); root.append(container);
    group.fields.set(field.key, { field, input, label: container, help });
    bind(input, 'input', () => { group.dirty.add(field.key); group.drafts.set(field.key, input.value); refreshControls(); });
  }
  function group(id, descriptors, root, form, save, message, path) {
    const result = { id, fields: new Map(), dirty: new Set(), drafts: new Map(), save, message, path };
    for (const field of descriptors) createField(result, field, root(field));
    bind(form, 'submit', event => {
      event.preventDefault(); if (form.reportValidity && !form.reportValidity()) return;
      const payload = {}, saved = [];
      for (const [key, { input, field }] of result.fields) {
        if (!result.dirty.has(key) || input.disabled) continue;
        assign(payload, key, input.value === '' && field.nullable ? null : field.type === 'number' ? Number(input.value) : input.value.trim()); saved.push(key);
      }
      if (saved.length) return mutate(path, payload, message, 'Settings saved.', () => saved.forEach(key => { result.dirty.delete(key); result.drafts.delete(key); }));
    });
    return result;
  }
  function createDevice(charger) {
    const { id } = charger, prefix = `/api/charging/chargers/${encodeURIComponent(id)}`;
    const section = make('details', '', 'equipment-device charging-device', `${id}-device`);
    section.setAttribute('aria-labelledby', `${id}-title`);
    const summary = make('summary', '', 'equipment-device-summary', `${id}-device-summary`);
    const heading = make('div', '', 'equipment-device-heading'), title = make('h4', charger.label, '', `${id}-title`);
    const state = make('span', '', 'equipment-device-status', `${id}-state`); heading.append(title, state); summary.append(heading);
    const overview = make('div', '', 'charging-overview', `${id}-overview`), metrics = {};
    const charge = make('div', '', 'equipment-value charging-charge');
    const current = make('strong', 'Unknown', '', `${id}-soc`), target = make('strong', 'Unknown', '', `${id}-minimum`);
    const sources = make('small', '', '', `${id}-sources`);
    const chargeLabel = make('span', 'Charge', '', `${id}-charge-label`);
    charge.append(chargeLabel, current, sources);
    const arrow = make('span', '→', 'charging-progress-arrow'); arrow.setAttribute('aria-hidden', 'true');
    const targetMetric = make('div', '', 'equipment-value charging-target');
    const targetLabel = make('span', 'Target', '', `${id}-target-label`); targetMetric.append(targetLabel, target);
    const completionMetric = make('div', '', 'equipment-value charging-completion');
    const completion = make('strong', 'No estimate', '', `${id}-completion`);
    const completionLabel = make('span', 'Est. target', '', `${id}-completion-label`); completionMetric.append(completionLabel, completion);
    overview.append(charge, arrow, targetMetric, completionMetric);
    metrics.soc = { value: current }; metrics.minimum = { value: target };
    const timing = make('div', '', 'charging-timing'), event = make('div', '', 'charging-event', `${id}-event`);
    const eventLabel = make('span', '', 'charging-event-label', `${id}-event-label`);
    const eventValue = make('strong', '', 'charging-event-value', `${id}-event-value`);
    event.append(eventLabel, eventValue);
    const deadlineGroup = make('div', '', 'charging-ready-by');
    const deadline = make('strong', '', 'charging-deadline', `${id}-deadline`);
    deadlineGroup.append(make('span', 'Ready by'), deadline); timing.append(event, deadlineGroup);
    const readiness = make('p', '', 'charging-readiness', `${id}-readiness`);
    const priority = make('p', '', 'charging-priority', `${id}-priority`);
    summary.append(overview, timing, readiness, priority);
    const problem = make('p', '', 'charging-problem', `${id}-problem`); problem.setAttribute('role', 'status'); summary.append(problem);
    const body = make('div', '', 'equipment-device-body charging-settings', `${id}-settings-details`);
    const facts = make('div', '', 'charging-fact-overview');
    const delivered = make('div', '', 'charging-detail-metric charging-delivered');
    const deliveredLabel = make('span'), deliveredValue = make('strong', '', '', `${id}-delivered`);
    delivered.append(deliveredLabel, deliveredValue);
    const remaining = make('div', '', 'charging-detail-metric charging-remaining', `${id}-remaining`);
    const energyLabel = make('span'), energyValue = make('strong', '', '', `${id}-energy`);
    remaining.append(energyLabel, energyValue);
    const costMetric = make('div', '', 'charging-detail-metric charging-cost');
    const costLabel = make('span'), cost = make('strong', '', '', `${id}-cost`); costMetric.append(costLabel, cost);
    facts.append(delivered, remaining, costMetric);
    const readingTime = make('p', '', 'charging-reading-time', `${id}-reading-time`);
    const scheduleHeading = make('div', '', 'charging-schedule-heading');
    const scheduleInfo = make('span', '', '', `${id}-schedule-info`), periodCount = make('span', '', 'charging-period-count', `${id}-period-count`);
    scheduleHeading.append(scheduleInfo, periodCount);
    const readings = make('dl', '', 'equipment-readings charging-facts', `${id}-readings`), notes = make('ul', '', 'charging-notes', `${id}-notes`);
    const periods = make('dl', '', 'equipment-readings charging-periods', `${id}-periods`);
    body.append(facts, readingTime, scheduleHeading, periods, readings, notes);
    const master = make('div', '', 'charging-master'), masterLabel = make('span', 'Automatic charging', '', `${id}-enabled-label`);
    const toggle = make('button', 'OFF', '', `${id}-enabled`); toggle.type = 'button'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false'); toggle.setAttribute('aria-labelledby', masterLabel.id); master.append(masterLabel, toggle);
    const controlDetail = make('p', '', 'muted charging-form-help', `${id}-control-detail`);
    const resume = make('button', 'Resume automatic charging', 'secondary-button', `${id}-resume`); resume.type = 'button';
    const controlMessage = make('p', '', 'temporary-status', `${id}-control-message`); controlMessage.setAttribute('role', 'status');
    body.append(master, controlDetail, resume, controlMessage);
    const form = make('form', '', 'charging-settings-form', `${id}-settings-form`), primaryFields = make('div', '', 'charging-fields');
    const save = make('button', 'Save settings', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, save); body.append(form, message);
    const settings = group(id, chargingFields, () => primaryFields, form, save, message, `${prefix}/settings`);
    const explanationFold = make('details', '', 'equipment-fold charging-explanations', `${id}-explanation-details`);
    explanationFold.append(make('summary', 'How charging works'));
    const explanations = make('dl', '', 'equipment-readings', `${id}-explanations`); explanationFold.append(explanations); body.append(explanationFold);
    section.append(summary, body); $('charging-devices')?.append(section);
    const device = { id, section, title, state, event, eventLabel, eventValue, overview, sources, metrics, chargeLabel, targetLabel, completionLabel, completion, readiness, priority, readingTime, deadline, deadlineGroup, facts, deliveredLabel, deliveredValue, remaining, energyLabel, energyValue, costLabel, cost, costMetric, scheduleInfo, scheduleHeading, periodCount, periods, problem, explanations, readings, notes, settings, toggle, resume, controlDetail, charger };
    bind(toggle, 'click', () => mutate(`${prefix}/settings`, { enabled: !device.charger.settings.enabled }, controlMessage, 'Control preference saved.'));
    bind(resume, 'click', () => mutate(`${prefix}/resume`, {}, controlMessage, 'Automatic control requested.'));
    devices.set(id, device); return device;
  }
  async function mutate(path, payload, message, success, saved = () => {}) {
    if (busy || !writable()) return;
    busy = true; message.textContent = 'Saving…'; message.classList.remove('form-error'); refreshControls();
    try {
      beforeRequest(); const result = await request(path, payload); saved(); update(result); onStatus(result); message.textContent = success;
    } catch (error) { message.textContent = error.message ?? 'Could not save charging settings.'; message.classList.add('form-error'); }
    finally { busy = false; refreshControls(); afterRequest(); }
  }
  function updateFields(group, settings, charger) {
    for (const [key, { field, input, help }] of group.fields) {
      const reading = charger?.values?.[field.reading ?? key], live = field.automatic && automatic(reading);
      input.value = (live ? reading.value : group.dirty.has(key) ? group.drafts.get(key) : get(settings, key)) ?? '';
      const unsupported = field.scheduling && !charger?.capabilities?.scheduling;
      const detail = live ? `${sourceLabel(reading)} supplies this value. Saved fallback: ${get(settings, key)}${key === 'capacityKwh' ? ' kWh' : '%'}. ${field.help ?? ''}`
        : unsupported ? 'Scheduling is unavailable with this integration.' : field.help ?? '';
      help.textContent = detail;
      help.hidden = !detail;
    }
  }
  function refreshControls() {
    const locked = busy || !writable();
    for (const device of devices.values()) {
      const { charger, settings } = device, supported = charger.capabilities?.scheduling === true;
      for (const [key, { field, input, label }] of settings.fields) {
        const unsupported = field.scheduling && !supported, live = field.automatic && automatic(charger.values?.[field.reading ?? key]);
        input.disabled = locked || unsupported || live; label.hidden = unsupported; label.classList.toggle('charging-field-disabled', Boolean(unsupported || live));
      }
      settings.save.disabled = locked || ![...settings.fields].some(([key, { input }]) => settings.dirty.has(key) && !input.disabled);
      device.toggle.disabled = locked || !supported; device.toggle.parentElement.hidden = !supported;
      const view = chargerDisplay(charger);
      device.resume.hidden = !supported || !charger.settings.enabled || !view.yielded;
      device.resume.disabled = locked || device.resume.hidden;
    }
  }
  function update(next) {
    status = next;
    const charging = next?.charging;
    const globalError = ({ 'charging-planning-unavailable': 'The charging plan could not be updated. The last charger instructions remain in effect.',
      'charging-reconciliation-unavailable': 'The current charging instructions could not be confirmed.' })[charging?.error] ?? (charging?.error ? human(charging.error) : '');
    set('charging-status', globalError); if ($('charging-status')) $('charging-status').hidden = !globalError;
    const views = chargingDisplay(charging, next?.now).chargers;
    const currentIds = new Set();
    for (const charger of charging?.chargers ?? []) {
      currentIds.add(charger.id);
      const device = devices.get(charger.id) ?? createDevice(charger), view = views.find(item => item.id === charger.id);
      const presentation = chargerSummary(charger, view, { now: next.now,
        formatTime: value => chargingTime(value, charging.timezone ?? 'Europe/Helsinki', next.now) });
      const explanation = Object.fromEntries(view.explanations);
      device.charger = charger; device.title.textContent = charger.label;
      device.section.dataset.state = view.state;
      device.state.textContent = presentation.roleLabel; device.state.dataset.state = presentation.roleState;
      device.state.title = presentation.roleDetail;
      const timedEvent = presentation.activity.match(/^(Starts|Scheduled start|Proposed start|Last confirmed start|Resumes|Last confirmed resume) (.+)$/);
      device.eventLabel.textContent = timedEvent ? timedEvent[1] === 'Scheduled start' ? 'Starts' : timedEvent[1] : '';
      device.eventLabel.hidden = !timedEvent;
      device.eventValue.textContent = timedEvent ? timedEvent[2] : presentation.activity;
      device.event.dataset.state = view.risk ? 'attention' : 'normal';
      device.overview.hidden = !view.showMetrics;
      device.metrics.soc.value.textContent = view.soc; device.metrics.minimum.value.textContent = view.minimum;
      device.sources.textContent = view.soc.startsWith('≈') ? 'Estimated charge' : view.sources;
      device.completion.textContent = presentation.completion.value;
      const sourceDetail = [view.soc.startsWith('≈') ? `${view.socSource}, allowing for charging losses.` : view.socSource, view.readingTime].filter(Boolean).join('\n');
      metricDetail(device.chargeLabel, { label: 'Charge', title: 'Current charge', detail: sourceDetail, key: `${charger.id}:source` });
      metricDetail(device.targetLabel, { label: 'Target', title: 'Target charge', detail: view.minimumSource, key: `${charger.id}:target` });
      const completionDetail = presentation.completion.at !== null
        ? 'Forecast time to reach the displayed target at the expected charging power. Charging can continue after the target is reached.'
        : presentation.completion.detail;
      metricDetail(device.completionLabel, { label: 'Est. target', title: 'Estimated target time', detail: completionDetail, key: `${charger.id}:completion` });
      device.readingTime.textContent = view.readingTime; device.readingTime.hidden = !view.readingTime;
      device.deadline.textContent = view.deadline.replace(/^Ready by /, ''); device.deadlineGroup.hidden = !view.deadline;
      device.readiness.textContent = view.risk ? view.readiness : '';
      device.readiness.hidden = !view.risk; device.readiness.dataset.state = view.risk ? 'attention' : 'normal';
      device.remaining.hidden = !view.showMetrics;
      energyText(device.energyValue, view.gridEnergy);
      const deliveredEnergy = charger.progress?.deliveredGridKwh ?? charger.progress?.creditedGridKwh;
      energyText(device.deliveredValue, finite(deliveredEnergy) ? number(deliveredEnergy, 'kWh') : '—');
      setStatusDetail(device.deliveredLabel, { label: 'Added so far', title: 'Energy added since starting charge',
        detail: finite(deliveredEnergy) ? 'Measured energy delivered from the grid since the starting charge. Some energy is lost during charging.' : 'No delivered-energy reading is available for the current starting charge.', key: `${charger.id}:delivered` });
      setStatusDetail(device.energyLabel, { label: view.energyLabel, title: view.energyLabel,
        detail: `${view.energyNote}. ${explanation['Energy estimate'] ?? ''}`, key: `${charger.id}:energy` });
      const cost = chargingCost(charger, view, presentation, { now: next.now, prices: next.prices });
      device.cost.textContent = cost.value;
      device.facts.hidden = !view.showMetrics;
      setStatusDetail(device.costLabel, { label: 'Estimated cost', title: 'Estimated cost to target',
        detail: cost.detail, key: `${charger.id}:cost` });
      device.priority.textContent = view.priority; device.priority.hidden = !view.priority;
      device.periodCount.textContent = view.periodCount; device.periodCount.hidden = !view.periodCount;
      device.problem.textContent = view.problem; device.problem.hidden = !view.problem;
      setStatusDetail(device.scheduleInfo, { label: 'Charging schedule', title: 'Charging periods',
        detail: explanation['Price planning'], key: `${charger.id}:schedule` });
      device.scheduleHeading.hidden = !view.periodRows.length;
      list(device.periods, view.periodRows.map(([label, text]) => [label, text.replace(' onwards · vehicle finishes naturally', ' onwards')]));
      device.periods.hidden = !view.periodRows.length;
      list(device.explanations, view.explanations);
      const rows = view.rows.filter(([label]) => !['Estimated cost to target', 'Delivered since starting charge'].includes(label)).map(([label, text]) => {
        if (label === 'Last reported Equalizer allowance') return ['Reported allowance', text.split(' · ')[0], `${text}. ${explanation['Current allocation'] ?? ''}`];
        if (label === 'Forecast charging power') return ['Forecast power', text.replace(' average during planned periods', ''), `${text}. ${explanation['Current allocation'] ?? explanation['Energy estimate'] ?? ''}`];
        if (label === 'Other scheduled charging') return ['Other charging', text.split(' · ')[0], `${text}. ${explanation['Other charging'] ?? ''}`];
        if (label === 'Saving from pauses') return [label, text.split(' compared with ')[0], text];
        if (label === 'Charging limit') return [label, text, 'The configured maximum current per phase. Actual current can be lower when supply is shared or the vehicle limits its draw.'];
        return [label, text];
      });
      list(device.readings, rows); device.readings.hidden = !rows.length;
      device.notes.replaceChildren(...view.notes.map(note => make('li', note))); device.notes.hidden = !view.notes.length;
      setStatusDetail(device.controlDetail, { label: 'About charging control', title: presentation.roleLabel,
        detail: `${presentation.roleDetail}\n\n${view.controlDetail}`, key: `${charger.id}:control` });
      const enabled = charger.settings.enabled === true; device.toggle.textContent = enabled ? 'ON' : 'OFF'; device.toggle.setAttribute('aria-checked', String(enabled));
      updateFields(device.settings, charger.settings, charger);
      set(`${charger.id}-summary`, presentation.compactSummary); if ($(`${charger.id}-summary`)) $(`${charger.id}-summary`).title = presentation.compactSummary;
    }
    for (const [id, device] of devices) if (!currentIds.has(id)) { device.section.remove(); devices.delete(id); }
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { for (const remove of listeners) remove(); } };
}
