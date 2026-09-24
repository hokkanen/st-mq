import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';
import { chargerSummary, chargingCost, chargingNotice } from './charging-summary.js';
import { CHARGING_LOSS_FRACTION, CHARGING_EFFICIENCY } from '../src/domain/charging-energy.js';

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
const sourceLabel = (field, vehicle) => {
  if (['manual', 'manual-fallback'].includes(field?.source)) return 'Manual fallback';
  if (field?.assumed || field?.source === 'assumed') return 'Planning assumption';
  if (field?.available !== true) return 'Awaiting a reading';
  if (field.source === 'bmw-target-filter') return 'Held BMW target';
  if (field.source === 'session-target') return 'Session planning choice';
  const source = field.provider ?? (field.source === 'mqtt' && vehicle?.state === 'identified'
    ? vehicle.source ?? ({ bmw: 'bmw-cardata', tesla: 'teslamate' })[vehicle.id] ?? field.source : field.source);
  return ({ mqtt: 'Vehicle MQTT', 'bmw-cardata': 'BMW CarData', teslamate: 'TeslaMate', easee: 'Easee', 'shelly-evse':'Shelly EVSE', 'session-anchor':'Connection charge anchor', 'session-request':'Connection request' })[source] ?? 'Automatic';
};
const automaticFor = (charger, field) => (!charger.vehicle || charger.vehicle.state === 'identified') && automatic(field);
const capacityProfileFor = charger => charger.vehicle?.state === 'identified' ? charger.vehicle.id : `generic:${charger.id}`;
const sessionTargetFor = charger => charger.vehicle?.state === 'identified' && charger.vehicle.id === 'bmw'
  && charger.values?.connected?.value === true && Number.isSafeInteger(charger.targetSelection?.connectedAt)
  ? charger.targetSelection : null;
function vehiclePresentation(charger) {
  const vehicle = charger.vehicle;
  if (vehicle?.state === 'identified') return { label: `${vehicle.label} identified`,
    detail: `${vehicle.label} is associated with this physical charger for the current connection. Vehicle readings carry their own source and quality.` };
  if (vehicle?.state === 'conflict') return { label: 'Vehicle evidence conflicts', detail: 'Both connections remain separately metered. Use the charger fallback request until the evidence resolves.' };
  if (vehicle?.reason === 'awaiting-stop-confirmation' && charger.values?.connected?.value === true)
    return { label: 'BMW identification pending', detail: 'BMW is a candidate for this connection. Waiting for matching charging-stop readings from BMW and Easee before confirming it. Saved vehicle settings remain in use.' };
  if (vehicle?.state === 'identifying') return { label: 'Identifying vehicle',
    detail: 'Checking which vehicle is connected. You can enter starting charge, target and usable battery capacity below; these values are used until a vehicle is identified.' };
  if (charger.values?.connected?.value === true) return { label: 'Vehicle unidentified',
    detail: 'Use the saved starting charge, target and usable battery capacity below for this vehicle, including visitors. BMW or Tesla readings take over only after identification.' };
  return { label: 'Any vehicle', detail: 'This charger accepts any vehicle. Saved manual settings are available for visitors; BMW and Tesla readings are used only after identification.' };
}
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
  { key: 'readyBy', label: 'Ready-by time · local', type: 'time', scheduling: true,
    help: 'Plan to reach the target by this time. New prices can move charging to cheaper periods. Reaching the target or this time does not stop charging.' },
  { key: 'manualSoc', reading: 'soc', label: 'Starting charge · %', type: 'number', min: 0, max: 100, step: 0.1, automatic: true,
    help: 'Saved starting charge for an unidentified vehicle or a missing vehicle reading. Update it for a visitor or after driving; delivered energy updates the estimate from here.' },
  { key: 'minimumSoc', label: 'Target charge · %', type: 'number', min: 0, max: 100, step: 1, automatic: true,
    help: 'Saved target for an unidentified vehicle. An identified vehicle’s reported target takes priority without changing this saved value.' },
  { key: 'capacityKwh', label: 'Usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, automatic: true,
    help: 'Saved usable capacity for an unidentified vehicle or a missing capacity reading.' },
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
  const targetReached = finite(requiredGridKwh) && requiredGridKwh <= 0;
  const minimum = values.minimumSoc?.value, socKnown = finite(soc.value) && (soc.available || soc.source === 'manual-fallback');
  const forecastAbsent = Object.hasOwn(charger, 'forecast') && charger.forecast === null;
  const finishAt = forecastAbsent ? null : Object.hasOwn(forecast, 'finishAt') ? forecast.finishAt : plan.finishAt;
  const currentFinish = validTime(finishAt) && Number(finishAt) > now;
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
    else if (currentFinish) event += ` · ${number(minimum, '%')} estimated ${time(finishAt)}`;
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
  } else if (phase === 'identifying') {
    state = 'Identifying vehicle'; event = 'Observing initial charging before scheduling';
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
  const currentForecast = forecastAbsent || Object.hasOwn(forecast, 'feasible') ? forecast : plan;
  const deadlineAt = plan.deadlineAt ?? charger.deadlineAt;
  const risk = showPlan && !targetReached
    && (currentForecast.feasible === false && currentForecast.reason === 'insufficient-time'
    || currentFinish && validTime(deadlineAt) && Number(finishAt) > Number(deadlineAt));
  const deadline = showMetrics && enabled && !yielded && validTime(deadlineAt) ? `Ready by ${time(deadlineAt)}` : '';
  const readiness = !deadline ? '' : targetReached ? 'Target reached'
    : risk ? `${number(minimum, '%')} by ready-by is at risk`
      : currentForecast.feasible === true && currentFinish && !uncertain && !revisionPending
        ? 'Expected on time' : 'Readiness being checked';
  const readingTime = showMetrics && automatic(soc) ? validTime(soc.measuredAt) ? `Charge measured ${chargingReadingTime(soc.measuredAt, timezone)}`
    : validTime(soc.receivedAt) ? `Charge received ${chargingReadingTime(soc.receivedAt, timezone)} · measurement time unknown` : 'Charge measurement time unknown' : '';
  const rows = [];
  if (activeManual && validTime(manual.detectedAt)) rows.push(['Manual change noticed', chargingReadingTime(manual.detectedAt, timezone)]);
  if (charging && finite(values.actualCurrentA?.value)) rows.push(['Drawing now', number(values.actualCurrentA.value, 'A per phase')]);
  if (charger.capabilities?.externalLoadBalancing && finite(values.availableCurrentA?.value))
    rows.push(['Last reported Equalizer allowance', `${number(values.availableCurrentA.value, 'A per phase')}${validTime(values.availableCurrentA.measuredAt)
      ? ` · ${time(values.availableCurrentA.measuredAt)}` : validTime(values.availableCurrentA.receivedAt) ? ` · received ${time(values.availableCurrentA.receivedAt)}` : ''}`]);
  else if (showMetrics && !charger.capabilities?.externalLoadBalancing && finite(values.currentA?.value)) rows.push(['Selected charging current', number(values.currentA.value, 'A per phase')]);
  if (finite(values.maximumCurrentA?.value)) rows.push(['Charging limit', number(values.maximumCurrentA.value, 'A per phase')]);
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
  if (showMetrics && estimatedSoc && automatic(soc)) rows.push(['Last reported charge',
    `${number(soc.value, '%')} · ${sourceLabel(soc, charger.vehicle)} · ${readingTime.replace(/^Charge /, '')}`,
    'This is the last charge reported by the vehicle. The main charge estimate adds measured energy delivered after this reference, allowing for charging losses. The reference can be newer than plugging in; it is not necessarily the session’s starting charge.']);
  else if (showMetrics && estimatedSoc && finite(soc.value)) rows.push(['Starting charge (manual)', number(soc.value, '%'),
    'This saved starting charge is the reference for the main estimate. Measured energy delivered after this reference advances the estimate, allowing for charging losses. Update the starting value for another vehicle or after driving.']);
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
      && !(targetReached && /cannot deliver|insufficient.*time|target at risk/i.test(note))
      && !(currentForecast !== plan && currentForecast.feasible !== false && /cannot deliver|insufficient.*time|target at risk/i.test(note))) : [];
  if (shortfallNote && !uncertain) notes.push(shortfallNote);
  let problem = uncertain || handoverUnconfirmed || enabled && manual?.kind === 'unknown' ? control.reason || 'The charger instruction could not be confirmed. Another reading will be requested.' : '';
  if (charger.error) problem ||= ({ 'charging-adapter-unavailable': supported
    ? 'The charger connection is unavailable. Automatic control is waiting for a connection.'
    : 'The vehicle connection is unavailable. Waiting for fresh charging readings.',
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
  const provider = charger.provider ?? charger.telemetry?.provider;
  const recorded = charger.readOnly === true && charger.recorded === true;
  const recordedEfficiency = charger.configuration?.efficiency;
  const energyAssumption = recorded
    ? finite(recordedEfficiency) && recordedEfficiency > 0 && recordedEfficiency <= 1
      ? `The recorded snapshot assumed ${number((1 - recordedEfficiency) * 100, '%')} charging loss (${number(recordedEfficiency * 100, '%')} efficiency). Its energy and cost estimates are shown as recorded, without recalculation.`
      : 'The original charging-loss assumption is unavailable in this recorded snapshot. Its energy and cost estimates are shown as recorded, without recalculation.'
    : `Charging loss is fixed at ${number(CHARGING_LOSS_FRACTION * 100, '%')} of grid energy (${number(CHARGING_EFFICIENCY * 100, '%')} reaches the battery). Grid energy and cost estimates include these losses.`;
  const explanations = [
    ['Vehicle identification', vehiclePresentation(charger).detail],
    ['Readings & fallbacks', 'Only an identified vehicle’s charge, target and usable capacity take priority, separately for each available field. Otherwise, saved starting charge, target and capacity are used and remain editable. Update these for a visitor or after driving. Automatic readings do not erase saved values. The original reading time stays visible as it ages; a receipt time is labeled separately when measurement time is unknown.'],
    ['Target & completion', 'The displayed target comes from the vehicle when available. A saved target is used for estimates and does not change the vehicle’s own charge limit. The estimated target time is a forecast, not a command to stop charging. Estimated cost includes all energy delivered since plugging in plus the energy still needed to reach the target. It stays visible after reaching the target and grows with any further charging.'],
    ['Charging progress', 'Delivered charging energy raises the estimated charge from the starting value, allowing for charging losses and usable capacity. Added energy is counted since that reference, not necessarily since plugging in. A new vehicle reading updates the reference and starts that count again. The original vehicle reading stays separate; missing energy is not invented. The estimate can keep rising beyond the requested target. Disconnecting clears connection progress; a saved starting charge must be updated after driving when no vehicle reading is available.'],
    ['Energy estimate', `Three-phase charging is assumed; voltage comes from provider readings. ${energyAssumption}`],
  ];
  if (!supported) explanations.push(
    ['Monitoring', 'This integration observes charging and estimates progress. Set charging schedules and current limits in the vehicle or charger controls. This page cannot start, pause or schedule charging, and has no automatic ready-by deadline.'],
    ['Native schedule', 'Vehicle and charger native constraints remain separate from the planning request. A forecast completion is not a scheduled stop.'],
  );
  if (supported) explanations.push(
    ['Ready-by time', 'The saved local time is the deadline for reaching the target. The estimated target time shows the current forecast; readiness compares that forecast with the deadline. Ready-by is not a scheduled stop.'],
    ['Price planning', 'New prices can pause automatic charging for cheaper periods if the target is still unmet, ready-by can still be met, and the remaining charge costs less. Charging runs at least 15 minutes before such a pause, and planned pauses last at least 15 minutes. Manual charging instructions keep priority. Reaching the target or ready-by time does not stop charging. Estimates cover reaching the requested target.'],
    ['Period transitions', provider === 'easee'
      ? 'Installing planned pauses and next starts requires this service and the Easee cloud. Easee shows the current instruction; this page shows all planned periods. An installed one-off start can run independently. If contact is lost, the last instruction remains in effect and an open period may continue past a planned pause. A confirmed schedule does not by itself confirm a physical pause. Missed or unconfirmed transitions are reported when contact resumes.'
      : 'Proposed periods and confirmed charger instructions are kept separate. Unconfirmed updates do not replace the last known instruction. Actual charging activity is shown separately from schedule confirmation.'],
    ['Household forecast', 'Property consumption is reduced by known charging, then matched to local hours and outdoor conditions. A couple of usable nights can begin the estimate. Recent similar nights carry more weight, while older cold-weather readings remain useful when those conditions return. Broader history is used when close matches are scarce; zero other load is assumed only when no usable reference exists.'],
    ['Current reference', householdReferenceText(assumptions.householdReference, now)],
    ['Other charging', 'A physically charging peer consumes capacity even with automatic scheduling off. Its continuing demand remains reserved when its stop is unknown. Household forecasting subtracts each physical charger once.'],
    ['Manual priority', 'A simple manual schedule has priority through its complete window, including after ready-by. Charge now has priority until unplugging. Multiple periods or an unknown end require Resume automatic charging; a later manual change takes priority again. A fresh charger read is required before handover.'],
    ['Saved priority', 'An existing schedule with unknown ownership is preserved. Our own changes and normal schedule expiry do not count as manual changes. Manual windows survive reconnection and restart. Editing ready-by does not move a recorded window end.'],
    ['Turning automatic charging off', 'OFF stops automatic scheduling and removes only a confirmed restriction owned by this service. Newer manual instructions are preserved. OFF does not stop physical charging. If the charger cannot confirm removal, the handover stays visibly unconfirmed.'],
    ['Unavailable data', 'Without a reliable price or power forecast, or with too little time, charging is allowed immediately while planning continues. Economical periods can still be scheduled when the forecast improves. A disabled charger, fault or authorization requirement must be resolved first. Unconfirmed changes retain the last known instruction and are retried after another charger reading.'],
  );
  if (charger.capabilities?.externalLoadBalancing) {
    const limiter = provider === 'easee' ? 'Equalizer' : 'the external load balancer';
    const basis = ({
      'observed-budget': `The forecast infers available supply from ${limiter} and property readings, then applies expected household use.`,
      'observed-lower-bound': `The forecast uses a lower bound inferred from capped readings from ${limiter} and the property; actual headroom may be higher. Expected household use is deducted from that bound.`,
      'equalizer-adjusted': `The forecast replaces current household demand in readings from ${limiter} and the property with expected household use.`,
      'equalizer-live': `Supply-budget evidence is unavailable, so the forecast uses the last reported ${provider === 'easee' ? 'Equalizer allowance' : 'allowance from the external load balancer'} without subtracting household use again.`,
      unavailable: 'A usable supply estimate is still being established.',
    })[assumptions.supply] ?? 'The night forecast combines the available supply with expected household use; the last reported allowance describes current conditions.';
    explanations.push(['Current allocation', `${provider === 'easee' ? 'Equalizer' : 'The external load balancer'} controls the current and protects the property supply. The reported allowance, charger limit and actual draw are separate: a limit does not promise that current is available now. ${supported ? `${basis} ` : ''}The charging limit caps the forecast. Automatic charging does not change the external limits.`]);
  } else explanations.push(['Charging current', `Selected current is the vehicle or charger’s requested current, capped by its reported maximum. Actual draw can be lower. Power is the measured charging rate; the target forecast uses available current and voltage.${charger.capabilities?.currentControl === true ? '' : ' This page does not change charging current.'}`]);
  const socSource = estimatedSoc ? automatic(soc) ? 'Estimated from vehicle charge + delivered energy' : 'Estimated from starting charge + delivered energy'
    : automatic(soc) ? sourceLabel(soc, charger.vehicle) : 'Starting charge';
  const targetSource = values.minimumSoc?.source === 'session-target' ? 'Planning target for this connection'
    : values.minimumSoc?.source === 'bmw-target-filter' ? 'BMW target held after conflicting reports'
      : automatic(values.minimumSoc) ? `Target from ${sourceLabel(values.minimumSoc, charger.vehicle)}` : 'Requested target';
  const targetSelection = sessionTargetFor(charger);
  const targetNotice = targetSelection?.conflict
    ? `BMW target reports conflict. Planning for ${number(targetSelection.selected?.value, '%')}; latest report: ${number(targetSelection.raw?.value, '%')}.`
    : targetSelection?.mode === 'full' ? 'Planning for 100% for this connection.' : '';
  const targetDetail = targetSelection ? [targetNotice,
    targetSelection.mode === 'full'
      ? `Planning choice: 100%${validTime(targetSelection.selected?.receivedAt)
        ? `, chosen ${chargingReadingTime(targetSelection.selected.receivedAt, timezone)}` : '; choice time unknown'}.`
      : `Selected planning target: ${number(targetSelection.selected?.value, '%')}${validTime(targetSelection.selected?.measuredAt)
        ? `, measured ${chargingReadingTime(targetSelection.selected.measuredAt, timezone)}`
        : validTime(targetSelection.selected?.receivedAt) ? `, received ${chargingReadingTime(targetSelection.selected.receivedAt, timezone)}; measurement time unknown` : '; measurement time unknown'}.`,
    `Latest BMW target report: ${number(targetSelection.raw?.value, '%')}${validTime(targetSelection.raw?.measuredAt)
      ? `, measured ${chargingReadingTime(targetSelection.raw.measuredAt, timezone)}`
      : validTime(targetSelection.raw?.receivedAt) ? `, received ${chargingReadingTime(targetSelection.raw.receivedAt, timezone)}; measurement time unknown` : '; measurement time unknown'}.`,
    targetSelection.conflict ? 'In automatic mode, planning uses the latest BMW target below 100% after repeated conflicting reports.' : '',
    'This choice changes planning only. For a full charge, also set 100% in the car. Unplugging restores automatic target selection.',
  ].filter(Boolean).join('\n\n') : '';
  const vehicle = vehiclePresentation(charger);
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk, showMetrics, vehicle,
    soc: estimatedSoc ? `≈${Math.round(progress.estimatedSoc)} %` : socKnown ? number(soc.value, '%') : 'Unknown', socSource, minimum: number(minimum, '%'),
    minimumSource: targetSource, sources: socSource, targetSelection, targetNotice, targetDetail,
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
    bind(input, 'input', () => { if (!group.dirty.size) group.draftSession = group.currentSession;
      group.dirty.add(field.key); group.drafts.set(field.key, input.value); refreshControls(); });
  }
  function group(id, descriptors, root, form, save, message, path) {
    const result = { id, fields: new Map(), dirty: new Set(), drafts: new Map(), capacityDrafts: new Map(), save, message, path };
    for (const field of descriptors) createField(result, field, root(field));
    bind(form, 'submit', event => {
      event.preventDefault(); if (form.reportValidity && !form.reportValidity()) return;
      const payload = {}, saved = [];
      for (const [key, { input, field }] of result.fields) {
        if (!result.dirty.has(key) || input.disabled) continue;
        assign(payload, key, input.value === '' && field.nullable ? null : field.type === 'number' ? Number(input.value) : input.value.trim());
        saved.push({ key, draft: result.drafts.get(key), profile: result.capacityProfile });
        if (key === 'capacityKwh') payload.capacityProfile = result.capacityProfile;
      }
      if (saved.length) return mutate(path, payload, message, 'Settings saved.', () => saved.forEach(({ key, draft, profile }) => {
        if (key === 'capacityKwh' && result.capacityProfile !== profile) {
          if (result.capacityDrafts.get(profile) === draft) result.capacityDrafts.delete(profile);
        } else if (result.drafts.get(key) === draft) { result.dirty.delete(key); result.drafts.delete(key); }
      }));
    });
    return result;
  }
  function createDevice(charger) {
    const { id } = charger, prefix = `/api/charging/chargers/${encodeURIComponent(id)}`;
    const section = make('details', '', 'equipment-device charging-device', `${id}-device`);
    section.setAttribute('aria-labelledby', `${id}-title`);
    const summary = make('summary', '', 'equipment-device-summary', `${id}-device-summary`);
    const heading = make('div', '', 'equipment-device-heading'), title = make('h4', charger.label, '', `${id}-title`);
    const identity = make('div', '', 'charging-identity'), vehicle = make('span', '', 'charging-vehicle', `${id}-vehicle`); identity.append(title, vehicle);
    const state = make('span', '', 'equipment-device-status', `${id}-state`); heading.append(identity, state); summary.append(heading);
    const overview = make('div', '', 'charging-overview', `${id}-overview`), metrics = {};
    const charge = make('div', '', 'equipment-value charging-charge');
    const current = make('strong', 'Unknown', '', `${id}-soc`), target = make('strong', 'Unknown', '', `${id}-minimum`);
    const sources = make('small', '', '', `${id}-sources`);
    const chargeLabel = make('span', 'Charge', '', `${id}-charge-label`);
    charge.append(chargeLabel, current, sources);
    const arrow = make('span', '→', 'charging-progress-arrow'); arrow.setAttribute('aria-hidden', 'true');
    const targetMetric = make('div', '', 'equipment-value charging-target');
    const targetLabel = make('span', 'Target', '', `${id}-target-label`);
    const targetSource = make('small', '', '', `${id}-target-source`); targetMetric.append(targetLabel, target, targetSource);
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
    const targetNotice = make('div', '', 'charging-notice charging-target-notice', `${id}-target-notice`); targetNotice.setAttribute('role', 'status');
    summary.append(timing, overview, targetNotice);
    const problem = make('p', '', 'charging-problem', `${id}-problem`); problem.setAttribute('role', 'status');
    const body = make('div', '', 'equipment-device-body charging-settings', `${id}-settings-details`);
    const facts = make('div', '', 'charging-fact-overview');
    const delivered = make('div', '', 'charging-detail-metric charging-delivered');
    const deliveredLabel = make('span', '', '', `${id}-delivered-label`), deliveredValue = make('strong', '', '', `${id}-delivered`);
    delivered.append(deliveredLabel, deliveredValue);
    const remaining = make('div', '', 'charging-detail-metric charging-remaining', `${id}-remaining`);
    const energyLabel = make('span', '', '', `${id}-energy-label`), energyValue = make('strong', '', '', `${id}-energy`);
    remaining.append(energyLabel, energyValue);
    const costMetric = make('div', '', 'charging-detail-metric charging-cost');
    const costLabel = make('span', '', '', `${id}-cost-label`), cost = make('strong', '', '', `${id}-cost`); costMetric.append(costLabel, cost);
    facts.append(delivered, remaining, costMetric);
    const notice = make('div', '', 'charging-notice', `${id}-notice`);
    const footer = make('div', '', 'charging-disclosure');
    footer.append(make('span', 'Details & settings', 'charging-disclosure-closed'), make('span', 'Close details', 'charging-disclosure-open'));
    const footerHint = make('span', '', 'charging-disclosure-hint'); footer.append(footerHint);
    summary.append(facts, notice, footer);
    const readingTime = make('p', '', 'charging-reading-time', `${id}-reading-time`);
    const scheduleHeading = make('div', '', 'charging-schedule-heading');
    const scheduleInfo = make('span', '', '', `${id}-schedule-info`), periodCount = make('span', '', 'charging-period-count', `${id}-period-count`);
    scheduleHeading.append(scheduleInfo, periodCount);
    const readings = make('dl', '', 'equipment-readings charging-facts', `${id}-readings`), notes = make('ul', '', 'charging-notes', `${id}-notes`);
    const periods = make('dl', '', 'equipment-readings charging-periods', `${id}-periods`);
    const session = make('section', '', 'charging-detail-section');
    const sessionStatus = make('p', '', 'charging-session-status', `${id}-session-status`);
    session.append(make('h5', 'Schedule & readings'), sessionStatus, problem, priority, readiness, readingTime, scheduleHeading, periods, readings, notes);
    body.append(session);
    const master = make('div', '', 'charging-master'), masterLabel = make('span', 'Automatic charging', '', `${id}-enabled-label`);
    const toggle = make('button', 'OFF', '', `${id}-enabled`); toggle.type = 'button'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false'); toggle.setAttribute('aria-labelledby', masterLabel.id); master.append(masterLabel, toggle);
    const controlDetail = make('p', '', 'muted charging-form-help', `${id}-control-detail`);
    const resume = make('button', 'Resume automatic charging', 'secondary-button', `${id}-resume`); resume.type = 'button';
    const controlMessage = make('p', '', 'temporary-status', `${id}-control-message`); controlMessage.setAttribute('role', 'status');
    const preferences = make('section', '', 'charging-detail-section');
    preferences.append(make('h5', 'Charging preferences'), master, controlDetail, resume, controlMessage); body.append(preferences);
    const form = make('form', '', 'charging-settings-form', `${id}-settings-form`), primaryFields = make('div', '', 'charging-fields');
    const save = make('button', 'Save defaults', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, save); preferences.append(form, message);
    const settings = group(id, chargingFields, () => primaryFields, form, save, message, `${prefix}/settings`);
    const sessionEdit = make('button', 'Apply edits to this connection', 'secondary-button', `${id}-session-save`); sessionEdit.type = 'button'; form.append(sessionEdit);
    bind(sessionEdit, 'click', () => {
      const current = devices.get(id)?.charger; if (!current?.request) return;
      const changes = {};
      for (const [key, { input, field }] of settings.fields) if (settings.dirty.has(key)) changes[key] = field.type === 'number' ? Number(input.value) : input.value;
      if (!Object.keys(changes).length) return;
      if (settings.draftSession !== `${current.association}:${current.request.sessionId}:${current.request.revision}`) {
        message.textContent = 'Connection changed. Review and edit the values again before applying them.'; return;
      }
      return mutate(`${prefix}/settings`, { scope: 'session', association: current.association, sessionId: current.request.sessionId, revision: current.request.revision, changes }, message, 'Request updated for this connection.', () => { settings.dirty.clear(); settings.drafts.clear(); });
    });
    const targetControls = make('div', '', '', `${id}-target-controls`);
    const targetHelp = make('p', '', 'charging-form-help', `${id}-target-help`);
    const targetToggle = make('button', '', 'secondary-button', `${id}-target-toggle`); targetToggle.type = 'button';
    targetToggle.setAttribute('aria-describedby', targetHelp.id);
    targetControls.append(targetHelp, targetToggle); settings.fields.get('minimumSoc').label.append(targetControls);
    const targetMessage = make('p', '', 'temporary-status', `${id}-target-message`); targetMessage.setAttribute('role', 'status');
    preferences.append(targetMessage);
    const explanationFold = make('details', '', 'equipment-fold charging-explanations', `${id}-explanation-details`);
    explanationFold.append(make('summary', 'How charging works'));
    const explanations = make('dl', '', 'equipment-readings', `${id}-explanations`); explanationFold.append(explanations); body.append(explanationFold);
    section.append(summary, body); $('charging-devices')?.append(section);
    const device = { id, sessionEdit, section, title, vehicle, state, event, eventLabel, eventValue, overview, sources, metrics, chargeLabel, targetLabel, targetSource, targetNotice, targetControls, targetHelp, targetToggle, targetMessage, completionLabel, completion, readiness, priority, readingTime, deadline, deadlineGroup, facts, deliveredLabel, deliveredValue, remaining, energyLabel, energyValue, costLabel, cost, costMetric, scheduleInfo, scheduleHeading, periodCount, periods, problem, explanations, readings, notes, settings, toggle, resume, controlDetail, charger, notice, footerHint, sessionStatus };
    bind(toggle, 'click', () => mutate(`${prefix}/settings`, { enabled: !device.charger.settings.enabled }, controlMessage, 'Control preference saved.'));
    bind(resume, 'click', () => mutate(`${prefix}/resume`, {}, controlMessage, 'Automatic control requested.'));
    bind(targetToggle, 'click', () => {
      if (targetToggle.disabled || !device.targetAction) return;
      const action = { ...device.targetAction };
      return mutate(`${prefix}/target`, action, targetMessage, () => device.targetAction?.connectedAt === action.connectedAt
        ? 'Planning target updated for this connection.' : 'The connection changed. Review the current target.');
    });
    devices.set(id, device); return device;
  }
  async function mutate(path, payload, message, success, saved = () => {}) {
    if (busy || !writable()) return;
    busy = true; message.textContent = 'Saving…'; message.classList.remove('form-error'); refreshControls();
    try {
      beforeRequest(); const result = await request(path, payload); saved(); update(result); onStatus(result); message.textContent = typeof success === 'function' ? success() : success;
    } catch (error) { message.textContent = error.message ?? 'Could not save charging settings.'; message.classList.add('form-error'); }
    finally { busy = false; refreshControls(); afterRequest(); }
  }
  function updateFields(group, settings, charger) {
    const capacityProfile = capacityProfileFor(charger);
    if (group.capacityProfile !== capacityProfile) {
      if (group.capacityProfile && group.dirty.has('capacityKwh')) group.capacityDrafts.set(group.capacityProfile, group.drafts.get('capacityKwh'));
      group.dirty.delete('capacityKwh'); group.drafts.delete('capacityKwh'); group.capacityProfile = capacityProfile;
      if (group.capacityDrafts.has(capacityProfile)) {
        group.dirty.add('capacityKwh'); group.drafts.set('capacityKwh', group.capacityDrafts.get(capacityProfile));
        group.capacityDrafts.delete(capacityProfile);
      }
    }
    for (const [key, { field, input, help }] of group.fields) {
      const reading = charger?.values?.[field.reading ?? key], live = field.automatic && automaticFor(charger, reading);
      input.value = (group.dirty.has(key) ? group.drafts.get(key) : live ? reading.value : get(settings, key)) ?? '';
      const unsupported = field.scheduling && !charger?.capabilities?.scheduling;
      const detail = live ? `${sourceLabel(reading, charger.vehicle)} supplies this value. Saved fallback: ${get(settings, key)}${key === 'capacityKwh' ? ' kWh' : '%'}. ${field.help ?? ''}`
        : unsupported ? 'Scheduling is unavailable with this integration.'
          : key === 'capacityKwh' && capacityProfile === 'tesla'
            ? `Saved usable capacity for Tesla, shared wherever Tesla charges.${charger.id === 'charger2' ? '' : ' Editing it keeps this charger’s generic vehicle default unchanged.'}` : field.help ?? '';
      help.textContent = detail;
      help.hidden = !detail;
    }
  }
  function refreshControls() {
    const locked = busy || !writable();
    for (const device of devices.values()) {
      const { charger, settings } = device, supported = charger.capabilities?.scheduling === true;
      for (const [key, { field, input, label }] of settings.fields) {
        const unsupported = field.scheduling && !supported, live = field.automatic && automaticFor(charger, charger.values?.[field.reading ?? key]);
        input.disabled = Boolean(locked || unsupported); label.hidden = unsupported; label.classList.toggle('charging-field-disabled', Boolean(unsupported));
      }
      settings.currentSession = charger.request ? `${charger.association}:${charger.request.sessionId}:${charger.request.revision}` : null;
      device.sessionEdit.disabled = locked || !charger.request || !settings.dirty.size || settings.draftSession !== settings.currentSession;
      settings.save.disabled = locked || ![...settings.fields].some(([key, { input }]) => settings.dirty.has(key) && !input.disabled);
      device.toggle.disabled = locked || !supported; device.toggle.parentElement.hidden = !supported;
      const view = chargerDisplay(charger);
      device.resume.hidden = !supported || !charger.settings.enabled || !view.yielded;
      device.resume.disabled = locked || device.resume.hidden;
      device.targetToggle.disabled = locked || charger.readOnly === true || !device.targetAction;
    }
  }
  function update(next) {
    if (Number.isSafeInteger(next?.charging?.revision) && Number.isSafeInteger(status?.charging?.revision) && next.charging.revision < status.charging.revision) return;
    status = next;
    const charging = next?.charging;
    let prioritySelect = $('charging-priority');
    if (!prioritySelect && $('charging-devices')) {
      const label = make('label', 'Charger priority '); prioritySelect = make('select', '', '', 'charging-priority');
      for (const [value, text] of [['balanced', 'Balanced'], ['charger1', 'Charger 1 · Easee'], ['charger2', 'Charger 2 · Shelly']]) { const option = make('option', text); option.value = value; prioritySelect.append(option); }
      label.append(prioritySelect); const devicesRoot=$('charging-devices');
      if (devicesRoot.before) devicesRoot.before(label); else devicesRoot.append(label);
      const message = make('span', '', 'temporary-status'); label.append(message);
      bind(prioritySelect, 'change', () => mutate('/api/charging/settings', { priority: prioritySelect.value }, message, 'Priority updated.'));
    }
    if (prioritySelect) { prioritySelect.value = charging?.settings?.priority ?? 'balanced'; prioritySelect.disabled = busy || !writable(); }
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
      metricDetail(device.vehicle, { label: `${charger.provider === 'easee' ? 'Easee · ' : charger.provider === 'shelly-evse' ? 'Shelly · ' : ''}${view.vehicle.label}`, title: 'Vehicle at this charger', detail: view.vehicle.detail, key: `${charger.id}:vehicle` });
      device.section.dataset.state = view.state;
      device.section.dataset.connected = String(charger.values?.connected?.value === true);
      metricDetail(device.state, { label: presentation.roleLabel, title: 'Charging control', detail: presentation.roleDetail, key: `${charger.id}:role` });
      device.state.dataset.state = presentation.roleState;
      const timedEvent = presentation.activity.match(/^(Starts|Scheduled start|Proposed start|Last confirmed start|Resumes|Last confirmed resume) (.+)$/);
      device.eventLabel.textContent = timedEvent ? timedEvent[1] === 'Scheduled start' ? 'Starts' : timedEvent[1] : '';
      device.eventLabel.hidden = !timedEvent;
      const activity = view.showMetrics ? presentation.activity : charger.values?.connected?.value === false ? 'Not connected' : 'Connection unknown';
      metricDetail(device.eventValue, { label: timedEvent ? timedEvent[2].replace(' · update awaiting confirmation', '') : activity,
        title: 'Charging activity', detail: [presentation.activity, view.controlDetail].filter(Boolean).join('\n\n'), key: `${charger.id}:activity` });
      device.event.dataset.state = view.risk ? 'attention' : 'normal';
      device.overview.hidden = false;
      device.metrics.soc.value.textContent = view.showMetrics ? view.soc : '—'; device.metrics.minimum.value.textContent = view.showMetrics ? view.minimum : '—';
      device.sources.textContent = !view.showMetrics ? 'Awaiting data' : view.soc.startsWith('≈') ? 'Estimated charge' : view.sources;
      device.targetSource.textContent = view.targetSelection?.mode === 'full' ? 'This connection'
        : view.targetSelection?.conflict ? 'Held BMW target' : '';
      device.targetSource.hidden = !device.targetSource.textContent;
      device.targetNotice.textContent = view.targetNotice; device.targetNotice.hidden = !view.targetNotice;
      device.targetNotice.dataset.state = view.targetSelection?.conflict ? 'attention' : 'quiet';
      const targetSelection = view.targetSelection;
      if (device.targetAction?.connectedAt !== targetSelection?.connectedAt) {
        device.targetMessage.textContent = ''; device.targetMessage.classList.remove('form-error');
      }
      device.targetAction = targetSelection ? { connectedAt: targetSelection.connectedAt, mode: targetSelection.mode === 'full' ? 'automatic' : 'full' } : null;
      device.targetControls.hidden = !targetSelection;
      device.targetToggle.textContent = targetSelection?.mode === 'full' ? 'Use automatic target again' : 'Plan for 100% this connection';
      device.targetHelp.textContent = targetSelection?.mode === 'full'
        ? 'Planning for 100% until unplugging. This does not change the car’s charge limit; set 100% in the car too for a full charge.'
        : 'This changes the plan for this connection only. For a full charge, also set 100% in the car.';
      device.completion.textContent = presentation.completion.value;
      const sourceDetail = !view.showMetrics ? 'A confirmed vehicle connection is needed before a remembered charge reading can be shown as current.'
        : [view.soc.startsWith('≈') ? `${view.socSource}, allowing for charging losses. Added energy is counted after the reference reading, which may be newer than plugging in.` : view.socSource, view.readingTime].filter(Boolean).join('\n');
      metricDetail(device.chargeLabel, { label: 'Charge', title: 'Current charge', detail: sourceDetail, key: `${charger.id}:source` });
      metricDetail(device.targetLabel, { label: 'Target', title: 'Target charge', detail: !view.showMetrics ? 'The target will be shown for the connected vehicle. Your saved fallback is in Charging preferences.' : [`${view.minimumSource}. Estimates cover reaching this charge, which is not a command to stop the vehicle.`, view.targetDetail].filter(Boolean).join('\n\n'), key: `${charger.id}:target` });
      const completionDetail = presentation.completion.at !== null
        ? 'Forecast time to reach the displayed target at the expected charging power. Charging can continue after the target is reached.'
        : presentation.completion.detail;
      metricDetail(device.completionLabel, { label: 'Est. target', title: 'Estimated target time', detail: completionDetail, key: `${charger.id}:completion` });
      device.readingTime.textContent = view.readingTime; device.readingTime.hidden = !view.readingTime;
      device.sessionStatus.textContent = view.showMetrics ? presentation.activity
        : `${presentation.activity.replace(/\.$/, '')}. Readings and estimates will appear when a vehicle is confirmed connected.`;
      device.deadline.textContent = view.deadline.replace(/^Ready by /, ''); device.deadlineGroup.hidden = !view.deadline;
      device.readiness.textContent = presentation.roleState === 'uncertain' ? '' : view.readiness;
      device.readiness.hidden = !device.readiness.textContent; device.readiness.dataset.state = view.risk ? 'attention' : 'normal';
      device.remaining.hidden = false;
      energyText(device.energyValue, view.showMetrics ? view.gridEnergy : '—');
      const deliveredEnergy = charger.progress?.deliveredGridKwh ?? charger.progress?.creditedGridKwh;
      energyText(device.deliveredValue, view.showMetrics && finite(deliveredEnergy) ? number(deliveredEnergy, 'kWh') : '—');
      metricDetail(device.deliveredLabel, { label: 'Added energy', title: 'Energy added since the charge reference',
        detail: view.showMetrics && finite(deliveredEnergy) ? 'Measured grid energy since the last vehicle charge reading or manually set starting charge, including charging losses. A new vehicle reading resets this reference; this is not a total for the whole connection.' : 'No delivered-energy reading is available for the current charge reference.', key: `${charger.id}:delivered` });
      metricDetail(device.energyLabel, { label: view.energyLabel === 'Grid remaining' ? 'Remaining' : 'To target', title: view.energyLabel,
        detail: `${view.energyNote}. ${explanation['Energy estimate'] ?? ''}`, key: `${charger.id}:energy` });
      const cost = chargingCost(charger, view, presentation, { now: next.now, prices: next.prices });
      device.cost.textContent = cost.value;
      device.facts.hidden = false;
      metricDetail(device.costLabel, { label: 'Est. cost', title: 'Estimated total session cost',
        detail: cost.detail, key: `${charger.id}:cost` });
      const notice = chargingNotice(charger, view, presentation);
      device.notice.dataset.state = notice.state;
      metricDetail(device.notice, { label: notice.label, title: 'Charging status', detail: notice.detail, key: `${charger.id}:notice` });
      device.footerHint.textContent = view.supported ? 'Schedule · readings · help' : 'Readings · help';
      device.priority.textContent = view.priority; device.priority.hidden = !view.priority;
      device.periodCount.textContent = view.periodCount; device.periodCount.hidden = !view.periodCount;
      device.problem.textContent = view.problem; device.problem.hidden = !view.problem;
      setStatusDetail(device.scheduleInfo, { label: 'Charging schedule', title: 'Charging periods',
        detail: explanation['Price planning'], key: `${charger.id}:schedule` });
      device.scheduleHeading.hidden = !view.periodRows.length;
      list(device.periods, view.periodRows.map(([label, text]) => [label, text.replace(' onwards · vehicle finishes naturally', ' onwards')]));
      device.periods.hidden = !view.periodRows.length;
      list(device.explanations, view.explanations);
      const rows = view.rows.filter(([label]) => !['Estimated cost to target', 'Delivered since starting charge'].includes(label)).map(([label, text, detail]) => {
        if (label === 'Last reported Equalizer allowance') return ['Reported allowance', text.split(' · ')[0], `${text}. ${explanation['Current allocation'] ?? ''}`];
        if (label === 'Forecast charging power') return ['Forecast power', text.replace(' average during planned periods', ''), `${text}. ${explanation['Current allocation'] ?? explanation['Energy estimate'] ?? ''}`];
        if (label === 'Other scheduled charging') return ['Other charging', text.split(' · ')[0], `${text}. ${explanation['Other charging'] ?? ''}`];
        if (label === 'Saving from pauses') return [label, text.split(' compared with ')[0], text];
        if (label === 'Charging limit') return [label, text, 'The configured maximum current per phase. Actual current can be lower when supply is shared or the vehicle limits its draw.'];
        return [label, text, detail];
      });
      if (charger.control?.limiter) rows.push(['Current policy', `${human(charger.control.reason)} · ${number(charger.control.limiter.currentA, 'A')} offered ceiling`], ['Command confirmation', human(charger.control.executionStage ?? 'unconfirmed')]);
      if (charger.telemetry?.commissioning) rows.push(['EVSE readiness', charger.telemetry.commissioning.controlReady ? 'Verified profile admitted' : 'Commissioning required'], ['Controller loss', 'Autonomous fallback unverified']);
      if (charger.values?.vehicleNotBefore?.available) rows.push(['Vehicle may accept from', chargingTime(charger.values.vehicleNotBefore.value, charging.timezone, next.now)]);
      if (charger.values?.vehicleCurrentA?.available) rows.push(['Vehicle current ceiling', number(charger.values.vehicleCurrentA.value, 'A')]);
      if (charger.sessionCost) rows.push(['Connection delivered', number(charger.sessionCost.deliveredGridKwh, 'kWh')]);
      list(device.readings, rows); device.readings.hidden = !rows.length;
      device.notes.replaceChildren(...view.notes.map(note => make('li', note))); device.notes.hidden = !view.notes.length;
      device.controlDetail.textContent = presentation.roleState === 'uncertain' ? presentation.roleDetail : view.controlDetail;
      const enabled = charger.settings.enabled === true; device.toggle.textContent = enabled ? 'ON' : 'OFF'; device.toggle.setAttribute('aria-checked', String(enabled));
      updateFields(device.settings, charger.settings, charger);
    }
    for (const [id, device] of devices) if (!currentIds.has(id)) { device.section.remove(); devices.delete(id); }
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { for (const remove of listeners) remove(); } };
}
