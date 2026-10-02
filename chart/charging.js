import { actionReceiptRecent } from './action-receipts.js';
import { isReadOnlyReplica, replicaSnapshotKey } from './replica-status.js';
import { setStatusDetail } from './status-details.js';
import { chargerSummary, chargingCost, chargingNotice } from './charging-summary.js';
import { createChargingPriority } from './charging-priority.js';
import { createChargingTime } from './charging-time.js';
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
  const source = field.provider ?? (field.source === 'mqtt' && vehicle?.state === 'identified'
    ? vehicle.source ?? ({ bmw: 'bmw-cardata', tesla: 'teslamate' })[vehicle.id] ?? field.source : field.source);
  return ({ mqtt: 'Vehicle MQTT', 'bmw-cardata': 'BMW CarData', teslamate: 'TeslaMate', easee: 'Easee', 'shelly-evse':'Shelly EVSE', 'session-anchor':'Connection charge anchor', 'session-request':'Connection request' })[source] ?? 'Automatic';
};
const automaticFor = (charger, field) => (!charger.vehicle || charger.vehicle.state === 'identified') && automatic(field);
const requestKey = charger => charger.request ? `${charger.association}:${charger.request.sessionId}:${charger.request.revision}` : null;
const connectedSession = charger => Boolean(charger.request && charger.values?.connected?.value === true);
const sessionTargetFor = charger => charger.vehicle?.state === 'identified' && charger.vehicle.id === 'bmw'
  && charger.values?.connected?.value === true && Number.isSafeInteger(charger.targetSelection?.connectedAt)
  ? charger.targetSelection : null;
function identificationPresentation(charger) {
  const identification = charger.identification;
  if (!identification || charger.values?.connected?.value === false) return null;
  if (identification.pauseOutstanding && charger.control?.reason === 'identification-resume-required') return {
    label: 'Review charger pause', state: 'Review required', activity: 'Review charger pause', recovery: true,
    detail: 'The charger may have received the identification pause, but its ownership is unconfirmed. A later manual Stop may be active. Review the charger, then choose “Use automatic” to hand control back, or resume it in Shelly.',
  };
  const recovery = identification.pauseOutstanding === true && (!identification.active
    || identification.reason === 'charger-unavailable' || ['uncertain', 'unavailable'].includes(charger.control?.phase));
  if (recovery) return { label: 'Pause recovery pending', state: 'Recovery pending', activity: 'Pause recovery pending', recovery: true,
    detail: 'The identification pause has not been released or its release is unconfirmed. The controller will restore the current charging choice when the charger is reachable. Manual Stop keeps priority.' };
  const waiting = {
    'manual-stop': ['Manual Stop active', 'Waiting for manual Stop to end. Identification will not override it.'],
    'unsupported': ['Live matching only', 'This charger cannot run an identification test. Waiting for live vehicle matching.'],
    'telemetry-unavailable': ['Waiting for vehicle data', 'Waiting for live vehicle readings before testing this connection.'],
    'vehicle-feed-stale': ['Waiting for vehicle data', 'The vehicle feed is not current. Waiting for a live report before requesting a charging test.'],
    'bmw-home-unknown': ['Waiting for home context', 'BMW has no valid last known home location. Unknown GPS does not erase an earlier home report.'],
    'bmw-away': ['BMW last reported away', 'The latest valid BMW location is away. Waiting for a valid home report or another vehicle’s matching evidence.'],
    'bmw-not-plugged': ['Waiting for BMW plug evidence', 'BMW has not reported a usable plugged-in state for this connection.'],
    'charger-unavailable': ['Waiting for charger', 'Waiting for a fresh charger connection before continuing identification.'],
    'another-identification-active': ['Waiting for other charger', 'Waiting for the other charger’s identification test to finish.'],
    'economic-plan-pending': ['Waiting for charging plan', 'Waiting for the current charging plan before deciding whether a brief charging test is needed.'],
    'evidence-capacity': ['Identification history full', 'This connection has reached the limit for stored identification events. Additional automatic tests are stopped; normal charging follows the current choice.'],
  }[identification.reason] ?? ['Waiting for charging', 'Waiting for the vehicle to start charging. Its own timer or charging limit stays in effect.'];
  const blocked = ['manual-stop', 'unsupported', 'telemetry-unavailable', 'vehicle-feed-stale', 'bmw-home-unknown',
    'bmw-away', 'bmw-not-plugged', 'charger-unavailable', 'another-identification-active',
    'economic-plan-pending', 'evidence-capacity'].includes(identification.reason);
  if (identification.phase === 'observing') return {
    label: 'Identification pending', state: 'Pending', activity: 'Waiting for matching reports',
    detail: `${({
      'probe-energy-limit': 'The brief charging test reached its energy budget.',
      'probe-time-limit': 'The brief charging test reached its safety time limit.',
      'telemetry-lost': 'The brief charging test ended because current charger measurements became unavailable.',
      'pause-timeout': 'The brief pause reached its safety deadline.',
    })[identification.reason] ?? (blocked ? waiting[1] : 'The physical charging evidence has been saved.')} The current charging choice applies.${identification.reason === 'evidence-capacity' ? ' Identification remains unresolved for this connection.' : ' Identification remains pending until unplugging. Matching vehicle evidence is still accepted; BMW event reports may arrive later.'}`,
  };
  if (identification.active) return {
    label: identification.phase === 'waiting' || blocked ? 'Identification pending' : 'Identifying vehicle',
    state: identification.phase === 'waiting' || blocked ? 'Pending' : identification.phase === 'pausing' ? 'Confirming' : 'Checking',
    activity: identification.phase === 'waiting' || blocked ? waiting[0]
      : identification.phase === 'pausing' ? charger.values?.charging?.value === true ? 'Pause requested' : 'Confirming vehicle'
          : 'Checking vehicle',
    detail: identification.phase === 'waiting' || blocked ? waiting[1]
      : identification.phase === 'pausing' ? 'A brief pause is checking the physical response. Once the charger confirms the physical stop, the current charging choice resumes. Matching vehicle evidence remains accepted; BMW event reports may arrive later.'
        : identification.probe && identification.probe.endedAt === null
          ? 'The extra charging test uses the charger’s normal current settings and has a 0.15 kWh energy budget, with a safety deadline. The controller ends the test when useful vehicle evidence arrives or a limit is reached; identification can still finish afterward.'
          : 'Normal charging continues while identification waits, without a short charging timeout. Charging will pause briefly as soon as enough evidence is available, if a pause is needed.',
  };
  if (identification.phase === 'inconclusive') return { label: 'Identification inconclusive', state: 'Inconclusive', activity: 'Identification inconclusive',
    detail: `${({
      'manual-stop': 'Manual Stop interrupted the identification test and keeps priority.',
      'pause-timeout': 'The physical identification pause was not confirmed before its deadline.',
    })[identification.reason] ?? 'The identification attempt ended without a conclusive match.'} The current charging choice now applies. Applicable vehicle evidence can still identify this connection until unplugging; choose Identify for an explicit retry when available.` };
  return null;
}
function vehiclePresentation(charger, { now, timezone } = {}) {
  const vehicle = charger.vehicle;
  const identification = identificationPresentation(charger);
  const home = vehicle?.homeContext;
  const homeDetail = home?.source === 'last-known'
    ? ` BMW location is currently unknown. Its last confirmed home position (${chargingTime(home.measuredAt, timezone, now)}) remains usable without a time limit, including after unplugging and reconnecting. A valid away report replaces it. Matching charging evidence is still required for this connection.` : '';
  if (vehicle?.state === 'conflict') return { label: 'Vehicle evidence conflicts',
    detail: `Both connections remain separately metered. Use the charger fallback request until the evidence resolves.${identification ? ` ${identification.detail}` : ''}` };
  if (identification) return { label: vehicle?.state === 'identified'
    ? `${vehicle.label} identified`
    : identification.label,
    detail: `${identification.detail}${vehicle?.state === 'identified' ? ` The confirmed ${vehicle.label} association remains available while this connection is checked.` : ' Session battery settings remain available below.'}${homeDetail}` };
  if (vehicle?.state === 'identified') return { label: `${vehicle.label} identified`,
    detail: `${vehicle.label} is associated with this physical charger for the current connection. Vehicle readings carry their own source and quality.${homeDetail}` };
  if (vehicle?.reason === 'awaiting-stop-confirmation' && charger.values?.connected?.value === true)
    return { label: 'BMW identification pending', detail: `BMW is a candidate for this connection. Waiting for matching charging-stop readings from BMW and the charger before confirming it. Configured vehicle defaults remain in use.${homeDetail}` };
  if (vehicle?.state === 'identifying') return { label: 'Identifying vehicle',
    detail: `Checking which vehicle is connected. You can edit starting charge, target and usable battery capacity for this session below.${homeDetail}` };
  if (charger.values?.connected?.value === true) return { label: 'Vehicle unidentified',
    detail: `Configured defaults cover unidentified vehicles, including visitors. You can change starting charge, target and usable battery capacity for this session below. BMW or Tesla readings take over only after identification.${homeDetail}` };
  return { label: 'Any vehicle', detail: 'This charger accepts any vehicle. Configured defaults are available for visitors; BMW and Tesla readings are used only after identification.' };
}
const notices = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => human(item?.message ?? item?.reason ?? item));
const settingId = (id, key) => `${id}-setting-${key.replaceAll('.', '-')}`;
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
// One field definition and one renderer serve every charger. The server supplies
// configured defaults and capabilities, including for chargers added later.
export const chargingFields = [
  { key: 'readyBy', label: 'Ready-by time · local', type: 'time', scheduling: true,
    help: 'Plan to reach the target by this time. New prices can move charging to cheaper periods. Reaching the target or this time does not stop charging.' },
  { key: 'manualSoc', reading: 'soc', label: 'Starting charge · %', type: 'number', min: 0, max: 100, step: 0.1, automatic: true,
    help: 'Starting charge for this session. Update it for a visitor or after driving; delivered energy updates the estimate from here. A newer vehicle reading can replace this reference.' },
  { key: 'minimumSoc', label: 'Target charge · %', type: 'number', min: 0, max: 100, step: 1, automatic: true,
    help: 'Planning target for this session. This does not change the vehicle’s own charging limit.' },
  { key: 'capacityKwh', label: 'Usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, automatic: true,
    help: 'Usable battery capacity for this session. Permanent defaults are set in configuration.' },
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
  if (reference.retrospectiveVoltage) parts.push('older current readings use the first established voltage estimate retrospectively');
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
  const chargeNow = connected === true && charger.request?.chargeNow === true;
  const identificationActive = connected === true && charger.identification?.active === true;
  const phase = control.phase ?? '', manual = enabled || chargeNow || identificationActive ? control.manual ?? control.manualOverride : null;
  const uncertain = (enabled || chargeNow || identificationActive) && (['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed'].includes(phase)
    || control.confirmed === false || phase === 'unconfirmed' && (chargeNow || identificationActive || control.owned || control.execution)
    || Boolean(control.errorCode));
  const yielded = (enabled || chargeNow || identificationActive) && (['yielded', 'manual'].includes(phase) || Boolean(manual));
  const activeManual = yielded && manual?.kind !== 'unknown';
  const handoverUnconfirmed = !enabled && control.handoverConfirmed === false;
  const released = (enabled || chargeNow) && ['released', 'charging'].includes(phase);
  const provisional = enabled && phase === 'provisional';
  const owned = enabled && !yielded && control.confirmed !== false ? control.owned : null;
  const execution = enabled && !yielded ? control.execution : null;
  const ownedPeriods = (execution?.periods ?? owned?.periods ?? []).filter(period => validTime(period.startAt));
  const ownedStart = validTime(owned?.startAt) ? owned.startAt : ownedPeriods[0]?.startAt;
  const periods = ownedPeriods.length ? ownedPeriods : ownedStart != null ? [{ startAt: ownedStart, endAt: null }]
    : !yielded && !uncertain ? (plan.periods ?? []).filter(period => validTime(period.startAt)) : [];
  const currentPeriod = periods.find(period => Number(period.startAt) <= now && (!validTime(period.endAt) || Number(period.endAt) > now));
  const nextPeriod = periods.find(period => Number(period.startAt) > now);
  const betweenPeriods = !currentPeriod && nextPeriod && periods.some(period => Number(period.startAt) <= now);
  const confirmedRevision = Boolean(execution?.planId) && execution.planId === plan.id;
  const revisionPending = !confirmedRevision && ownedStart != null && (ownedPeriods.length > 0 && Array.isArray(plan.periods)
    ? JSON.stringify(ownedPeriods.map(p => [p.startAt, p.endAt])) !== JSON.stringify(plan.periods.map(p => [p.startAt, p.endAt]))
    : validTime(plan.startAt) && Number(ownedStart) !== Number(plan.startAt));
  const nativeStart = values.scheduledStartAt?.value, nativeEnd = values.scheduledEndAt?.value;
  const endKind = charger.scheduledEndKind ?? charger.telemetry?.scheduledEndKind ?? values.scheduledEndAt?.kind;
  const nativeStops = ['enforced', 'scheduled-stop'].includes(endKind);
  const progress = charger.progress ?? {};
  const retainedVehicleReference = progress.retainedVehicleReference === true && finite(progress.referenceSoc?.value);
  const referenceSoc = retainedVehicleReference ? { ...progress.referenceSoc, available: true } : soc;
  const creditedGridKwh = progress.deliveredGridKwh ?? progress.creditedGridKwh;
  const hasProgress = finite(creditedGridKwh) && creditedGridKwh > 0;
  const estimatedSoc = finite(progress.estimatedSoc) && (progress.hasEnergyEstimate === true || retainedVehicleReference);
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
  const resumption = !validTime(resumeAt) ? '' : !enabled
    ? `${Number(resumeAt) <= now ? 'Manual priority ended; waiting for charger confirmation' : `Manual window ends ${time(resumeAt)}`}. Automatic charging remains off.`
    : Number(resumeAt) <= now ? 'Manual priority expired; automatic handover awaiting confirmation.'
      : `Automatic control resumes ${time(resumeAt)}${cycleCapped ? ' at the ready-by boundary' : ''}.`;
  const identification = identificationPresentation(charger);
  let state = connected === false ? 'Not connected' : connected === true ? 'Connected' : 'Connection unknown';
  let event = '', eventAt = null, eventKind = null;
  let pauseUnconfirmed = false;
  if (connected !== true) {
    event = activeManual && resumption ? resumption : enabled ? connected === false ? 'Automatic charging is ready for the next connection' : 'Waiting for charger readings'
      : supported ? 'Automatic charging OFF' : 'Monitoring';
  } else if (identification?.recovery && !yielded) {
    state = identification.label; event = identification.activity;
  } else if (identificationActive && !yielded && !uncertain && !handoverUnconfirmed) {
    state = identification.label;
    event = identification.activity;
  } else if (chargeNow && !charging && !uncertain && !yielded) {
    state = 'Charge now selected'; event = 'Charging requested until unplugging'; eventKind = 'manual';
  } else if (activeManual && validTime(resumeAt) && Number(resumeAt) <= now) {
    state = charging ? 'Charging' : 'Handover pending';
    event = charging && finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now` : enabled ? 'Automatic handover pending' : 'Charger handover pending';
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
  } else if (ownedStart != null && nextPeriod && !currentPeriod && !released && !provisional) {
    // A planned gap and an idle vehicle do not confirm the charger's pause.
    pauseUnconfirmed = betweenPeriods && !uncertain
      && (phase !== 'paused' || control.pauseConfirmed === false || control.ownsInstruction === false
        || Number(owned?.startAt) !== Number(nextPeriod.startAt));
    state = pauseUnconfirmed ? 'Pause unconfirmed' : uncertain ? 'Update unconfirmed' : betweenPeriods ? 'Paused between periods' : 'Scheduled';
    eventAt = nextPeriod.startAt; eventKind = pauseUnconfirmed ? 'proposed' : 'confirmed';
    event = pauseUnconfirmed ? `Next period ${time(eventAt)} · pause awaiting confirmation`
      : `${uncertain ? 'Last confirmed ' : ''}${betweenPeriods ? uncertain ? 'resume' : 'Resumes' : uncertain ? 'start' : 'Starts'} ${time(eventAt)}${revisionPending && !uncertain ? ' · update awaiting confirmation' : ''}`;
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
  const showPlan = enabled && showMetrics && !identificationActive && !yielded && (!uncertain || ownedStart != null);
  const currentForecast = forecastAbsent || Object.hasOwn(forecast, 'feasible') ? forecast : plan;
  const deadlineAt = plan.deadlineAt ?? charger.deadlineAt;
  const risk = showPlan && !targetReached
    && (currentForecast.feasible === false && currentForecast.reason === 'insufficient-time'
    || currentFinish && validTime(deadlineAt) && Number(finishAt) > Number(deadlineAt));
  const deadline = showMetrics && enabled && !yielded && validTime(deadlineAt) ? `Ready by ${time(deadlineAt)}` : '';
  const readiness = !deadline ? '' : targetReached ? 'Target reached'
    : risk ? `${number(minimum, '%')} by ready-by is at risk`
      : currentForecast.feasible === true && currentFinish && !uncertain && !pauseUnconfirmed && !revisionPending && !identificationActive
        ? 'Expected on time' : 'Readiness being checked';
  const readingTime = showMetrics && automatic(referenceSoc) ? validTime(referenceSoc.measuredAt) ? `Charge measured ${chargingReadingTime(referenceSoc.measuredAt, timezone)}`
    : validTime(referenceSoc.receivedAt) ? `Charge received ${chargingReadingTime(referenceSoc.receivedAt, timezone)} · measurement time unknown` : 'Charge measurement time unknown' : '';
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
  if (showMetrics && estimatedSoc && automatic(referenceSoc)) rows.push(['Last reported charge',
    `${number(referenceSoc.value, '%')} · ${sourceLabel(referenceSoc, charger.vehicle)} · ${readingTime.replace(/^Charge /, '')}`,
    'This is the last charge reported by the vehicle. The main charge estimate adds measured energy delivered after this reference, allowing for charging losses. The reference can be newer than plugging in; it is not necessarily the session’s starting charge.']);
  else if (showMetrics && estimatedSoc && finite(soc.value)) rows.push(['Starting charge (manual)', number(soc.value, '%'),
    'This starting charge is the reference for the main estimate. Measured energy delivered after this reference advances the estimate, allowing for charging losses. Update the starting value for another vehicle or after driving.']);
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
  if (pauseUnconfirmed) problem = 'The pause between charging periods has not been confirmed. Waiting for a fresh charger instruction and reading.';
  if (control.reason === 'identification-resume-required') problem = 'Review the charger pause under Identification below.';
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
  if (showMetrics && retainedVehicleReference) notes.push('Vehicle readings are unavailable. The estimate keeps the last vehicle charge and measured energy for this connection. Edit Starting charge to replace it.');
  const controlDetail = !supported ? 'This integration supports monitoring only.'
    : activeManual ? 'Choose “Use automatic” to end manual priority early. A later manual change takes priority again.'
      : provisional ? 'Charging is allowed for now. The forecast is being updated; economical periods can still be scheduled when it improves.'
      : 'Choose economical charging periods to reach the target by the ready-by time. This preference stays in effect until changed, including after unplugging and restart.';
  const provider = charger.provider ?? charger.telemetry?.provider;
  const shelly = provider === 'shelly-evse', easee = provider === 'easee';
  const localEasee = easee && (control.kind === 'ocpp-tx-pause'
    || control.snapshot?.transport === 'ocpp' || charger.telemetry?.transport === 'ocpp');
  const cloudEasee = easee && !localEasee;
  const pauseRecovery = shelly
    ? 'Pauses set by this application do not expire on the charger. If this application stops or loses contact with Shelly, charging may remain paused until control returns or you resume it in Shelly. Charging that is already running may continue past a planned pause.'
    : localEasee
      ? 'An installed pause expires automatically on the charger at its release time, even if this application loses contact. Charger, vehicle and Equalizer limits still apply. New charging sessions need this application for authorization; pause expiry does not return the charger to cloud control.'
      : cloudEasee
        ? 'An installed one-off start ends the pause at its scheduled time even if this application loses contact. Charger and vehicle limits still apply.' : null;
  const recorded = charger.readOnly === true && charger.recorded === true;
  const recordedEfficiency = charger.configuration?.efficiency;
  const energyAssumption = recorded
    ? finite(recordedEfficiency) && recordedEfficiency > 0 && recordedEfficiency <= 1
      ? `The recorded snapshot assumed ${number((1 - recordedEfficiency) * 100, '%')} charging loss (${number(recordedEfficiency * 100, '%')} efficiency). Its energy and cost estimates are shown as recorded, without recalculation.`
      : 'The original charging-loss assumption is unavailable in this recorded snapshot. Its energy and cost estimates are shown as recorded, without recalculation.'
    : `Charging loss is fixed at ${number(CHARGING_LOSS_FRACTION * 100, '%')} of grid energy (${number(CHARGING_EFFICIENCY * 100, '%')} reaches the battery). Grid energy and cost estimates include these losses.`;
  const explanations = [
    ['Vehicle identification', vehiclePresentation(charger, { now, timezone }).detail],
    ['Readings & fallbacks', 'Only an identified vehicle’s charge, target and usable capacity take priority, separately for each available field. Otherwise, configured starting charge, target and capacity are used. Explicit session edits take priority for this connection; a newer vehicle charge reading can replace the starting-charge reference. Unplugging restores configured defaults. Automatic readings never erase configured values. The original reading time stays visible as it ages; a receipt time is labeled separately when measurement time is unknown.'],
    ['Target & completion', 'The displayed target comes from the vehicle when available. The requested target is used for estimates and does not change the vehicle’s own charge limit. The estimated target time is a forecast, not a command to stop charging. Estimated cost includes all energy delivered since plugging in plus the energy still needed to reach the target. It stays visible after reaching the target and grows with any further charging.'],
    ['Charging progress', 'Delivered charging energy raises the estimated charge from the starting value, allowing for charging losses and usable capacity. Added energy shows recorded grid energy since plugging in and stays until disconnection. A new vehicle reading updates only the battery estimate reference. The original vehicle reading stays separate; missing energy is not invented. The estimate can keep rising beyond the requested target. Disconnecting clears connection progress; the starting charge should be updated for each session after driving when no vehicle reading is available.'],
    ['Energy estimate', `Three-phase charging is assumed. Forecasts use saved smoothed voltage estimates for each phase, with fresh local readings used provisionally while those estimates are established. ${energyAssumption}`],
  ];
  if (!supported) explanations.push(
    ['Monitoring', 'This integration observes charging and estimates progress. Set charging schedules and current limits in the vehicle or charger controls. This page cannot start, pause or schedule charging, and has no automatic ready-by deadline.'],
    ['Native schedule', 'Vehicle and charger native constraints remain separate from the planning request. A forecast completion is not a scheduled stop.'],
  );
  if (supported) explanations.push(
    ['Ready-by time', 'The configured or session-specific local time is the deadline for reaching the target. The estimated target time shows the current forecast; readiness compares that forecast with the deadline. Ready-by is not a scheduled stop.'],
    ['Price planning', `The planner chooses economical charging periods to reach the target by ready-by, with planned pauses of at least 15 minutes. ${easee ? 'New prices can pause automatic charging for cheaper periods if the target is still unmet, ready-by can still be met, and the remaining charge costs less. Charging runs at least 15 minutes before such a pause. ' : ''}Manual charging instructions keep priority. The final period stays open: reaching the target or ready-by time does not stop charging. Estimates cover reaching the requested target.`],
    ['Period transitions', cloudEasee
      ? 'Installing planned pauses and next starts requires this application and the Easee cloud. Easee shows the current instruction; this page shows all planned periods. If contact is lost, an open period may continue past a planned pause. A confirmed schedule does not by itself confirm a physical pause. Missed or unconfirmed transitions are reported when contact resumes.'
      : localEasee
        ? 'Each new pause needs this application and the local charger connection. The charger receives an expiring zero-current restriction for the current charging session. Later pauses may be missed if contact is lost. The page shows planned periods, confirmed restrictions and physical charging activity separately.'
        : `${shelly ? 'Automatic charging can use several charging periods with pauses between them. Each pause and restart needs this application and a working MQTT connection to Shelly. ' : ''}Proposed periods and confirmed charger instructions are kept separate. Actual charging activity is shown separately from command confirmation.`],
    ...(pauseRecovery ? [['Pause recovery', pauseRecovery]] : []),
    ['Household forecast', 'Property consumption is reduced by known charging, then matched to local hours and outdoor conditions. A couple of usable nights can begin the estimate. Recent similar nights carry more weight, while older cold-weather readings remain useful when those conditions return. Broader history is used when close matches are scarce; zero other load is assumed only when no usable reference exists.'],
    ['Current reference', householdReferenceText(assumptions.householdReference, now)],
    ['Other charging', 'A physically charging peer consumes capacity even with automatic scheduling off. Its continuing demand remains reserved when its stop is unknown. Household forecasting subtracts each physical charger once.'],
    ['Manual priority', cloudEasee
      ? 'A simple manual schedule has priority through its complete window, including after ready-by. Multiple periods or an unknown end require “Use automatic”; a later manual change takes priority again. A fresh charger read is required before handover.'
      : shelly
        ? 'Manual Start, Stop and active Shelly schedules take priority over automatic scheduling. “Use automatic” hands back manual Start, Stop and current choices, but an active native schedule must be changed in Shelly. Charge now still respects Manual Stop, native schedules and vehicle limits.'
        : 'A confirmed manual Stop requires explicit resumption. A manual release keeps priority until unplugging or “Use automatic”. Charger and vehicle limits still apply.'],
    ['Manual instruction ownership', cloudEasee
      ? 'An existing schedule with unknown ownership is preserved. Our own changes and normal schedule expiry do not count as manual changes. Manual windows survive reconnection and restart. Editing ready-by does not move a recorded window end.'
      : shelly
        ? 'This application distinguishes its own pauses from manual Start and Stop commands. It does not edit Shelly’s native schedules. An uncertain pause command may need review before charging can resume.'
        : 'This application removes only its own pause restriction. Other charger and vehicle restrictions remain in effect. An accepted command alone does not confirm a physical pause.'],
    ['Automatic charging', `The dashboard remembers automatic charging and shared priority until you change them, including after unplugging and restart. Charge now works with automatic charging ON or OFF and lasts until you turn it off or unplug. OFF stops price scheduling; it does not send a manual Stop. ${shelly ? 'The configured current limiter can remain active and may still pause charging. Manual Stop and native schedules remain in effect.' : 'Only restrictions belonging to this application are removed; newer manual instructions are preserved. If the charger cannot confirm removal, the handover stays visibly unconfirmed.'}`],
    ['Unavailable data', `Missing price or power forecasts, or too little time, do not add a price delay. ${shelly ? 'Charging remains subject to current limits, the configured fallback and native restrictions. ' : ''}A disabled charger, fault or authorization requirement must be resolved first. An unreachable charger cannot receive a release command. Failed or uncertain changes remain visible until reconciled.`],
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
  } else if (shelly && supported) explanations.push(['Charging current', 'This application adjusts Shelly’s current using the configured supply limits, available measurements and shared charger priority. It respects known vehicle and charger limits and pauses when the available current is below the charging minimum. Missing or stale measurements use the configured fallback; this is not a guarantee of property fuse protection. Actual draw can be lower than the selected current.']);
  else explanations.push(['Charging current', `Selected current is the vehicle or charger’s requested current, capped by its reported maximum. Actual draw can be lower. Power is the measured charging rate; the target forecast uses available current and voltage.${charger.capabilities?.currentControl === true ? '' : ' This page does not change charging current.'}`]);
  const socSource = retainedVehicleReference ? `Estimated from last known vehicle charge${hasProgress ? ' + delivered energy' : ''}`
    : estimatedSoc ? automatic(soc) ? 'Estimated from vehicle charge + delivered energy' : 'Estimated from starting charge + delivered energy'
    : automatic(soc) ? sourceLabel(soc, charger.vehicle) : 'Starting charge';
  const targetSource = values.minimumSoc?.source === 'session-request' ? 'Planning target for this connection'
    : values.minimumSoc?.source === 'bmw-target-filter' ? 'BMW target held after conflicting reports'
      : automatic(values.minimumSoc) ? `Target from ${sourceLabel(values.minimumSoc, charger.vehicle)}` : 'Requested target';
  const targetSelection = sessionTargetFor(charger);
  const targetHeld = Boolean(targetSelection && values.minimumSoc?.source === 'bmw-target-filter');
  const targetDetail = targetSelection ? [
    `Selected planning target: ${number(minimum, '%')}${validTime(values.minimumSoc?.measuredAt)
      ? `, measured ${chargingReadingTime(values.minimumSoc.measuredAt, timezone)}`
      : validTime(values.minimumSoc?.receivedAt) ? `, received ${chargingReadingTime(values.minimumSoc.receivedAt, timezone)}; measurement time unknown` : ''}.`,
    `Latest BMW target report: ${number(targetSelection.raw?.value, '%')}${validTime(targetSelection.raw?.measuredAt)
      ? `, measured ${chargingReadingTime(targetSelection.raw.measuredAt, timezone)}`
      : validTime(targetSelection.raw?.receivedAt) ? `, received ${chargingReadingTime(targetSelection.raw.receivedAt, timezone)}; measurement time unknown` : '; measurement time unknown'}.`,
    targetHeld ? 'After BMW reports a change from 100% to a lower target, automatic planning holds the latest target below 100% for this connection and ignores later 100% reports.' : '',
    'Edit the target in Session settings and save to change the plan until unplugging. This does not change the car’s charging limit.',
  ].filter(Boolean).join('\n\n') : '';
  const vehicle = vehiclePresentation(charger, { now, timezone });
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk, showMetrics, vehicle, identification,
    soc: estimatedSoc ? `≈${Math.round(progress.estimatedSoc)} %` : socKnown ? number(soc.value, '%') : 'Unknown', socSource, minimum: number(minimum, '%'),
    minimumSource: targetSource, sources: socSource, targetHeld, targetDetail,
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
  const timePicker = createChargingTime({ document });
  let status, busy = false;
  const actionMessages = new Map();
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className; if (id) node.id = id; return node;
  };
  const bind = (node, event, action) => { if (!node) return; node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action)); };
  const writable = () => Boolean(status?.charging && status.readOnly !== true && status.charging.readOnly !== true && !isReadOnlyReplica(status));
  const sharedPriority = createChargingPriority({ document,
    save: (priority, message) => mutate('/api/charging/settings', {
      associations: Object.fromEntries((status.charging.chargers ?? []).map(charger => [charger.id, charger.association])),
      revision: status.charging.controls.revision, priority,
    }, message, 'Priority saved. It stays in effect until changed.') });
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
    return trigger;
  }
  function actionMessage(root, text, { error = false, pending = false } = {}) {
    root.classList.toggle('form-error', error);
    if (!root.matches('.charging-control-message')) { root.textContent = text; return; }
    const trigger = metricDetail(root, { label: text ? error ? 'Action failed' : pending ? text : 'Preference saved' : '',
      title: 'Charging action', detail: pending ? '' : text, key: root.id });
    // Announce the complete receipt even though its visible label stays compact.
    if (trigger) trigger.setAttribute('aria-label', `${text} Show details`);
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
    container.append(label, input);
    if (field.type === 'time') timePicker.attach(input, container);
    container.append(help); root.append(container);
    group.fields.set(field.key, { field, input, label: container, help });
    bind(input, 'input', () => { if (!group.dirty.size) group.draftSession = group.currentSession;
      group.dirty.add(field.key); group.drafts.set(field.key, input.value); refreshControls(); });
  }
  function group(id, descriptors, root, form, save, message, path) {
    const result = { id, fields: new Map(), dirty: new Set(), drafts: new Map(), save, message, path };
    for (const field of descriptors) createField(result, field, root(field));
    bind(form, 'submit', event => {
      event.preventDefault();
      const charger = devices.get(id)?.charger;
      if (save.disabled || !connectedSession(charger) || form.reportValidity && !form.reportValidity()) return;
      if (result.draftSession !== requestKey(charger)) {
        message.textContent = 'The session changed. Review and edit the current values again.'; return;
      }
      const changes = {};
      for (const [key, { input, field }] of result.fields) {
        if (!result.dirty.has(key) || input.disabled) continue;
        changes[key] = field.type === 'number' ? Number(input.value) : input.value.trim();
      }
      if (!Object.keys(changes).length) return;
      const scope = requestKey(charger), submitted = new Map(result.drafts);
      return mutate(path, { scope: 'session', association: charger.association,
        sessionId: charger.request.sessionId, revision: charger.request.revision, changes }, message,
      'Saved for this session. Configured defaults are unchanged.', () => {
        if (result.currentSession !== scope) return;
        for (const [key, draft] of submitted) if (result.drafts.get(key) === draft) {
          result.dirty.delete(key); result.drafts.delete(key);
        }
      });
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
    const state = make('span', '', 'equipment-device-status', `${id}-state`);
    const actions = make('div', '', 'charging-actions');
    const chargeNow = make('button', '', 'charging-charge-now secondary-button', `${id}-charge-now`); chargeNow.type = 'button';
    chargeNow.setAttribute('aria-label', 'Charge now'); chargeNow.setAttribute('aria-pressed', 'false');
    const chargeNowState = make('span', 'OFF', 'charging-charge-now-state', `${id}-charge-now-state`);
    chargeNowState.setAttribute('aria-hidden', 'true');
    chargeNow.append(make('span', 'Charge now'), chargeNowState);
    const resume = make('button', 'Use automatic', 'charging-use-automatic secondary-button', `${id}-resume`); resume.type = 'button';
    actions.append(chargeNow); heading.append(identity, actions); summary.append(heading);
    const controlMessage = make('p', '', 'temporary-status charging-control-message', `${id}-control-message`); controlMessage.setAttribute('role', 'status');
    const overview = make('div', '', 'charging-overview', `${id}-overview`), metrics = {};
    const charge = make('div', '', 'equipment-value charging-charge');
    const current = make('strong', 'Unknown', '', `${id}-soc`), target = make('strong', 'Unknown', 'charging-target-value', `${id}-minimum`);
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
    summary.append(timing, overview);
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
    summary.append(facts, notice, footer, controlMessage);
    const readingTime = make('p', '', 'charging-reading-time', `${id}-reading-time`);
    const scheduleHeading = make('div', '', 'charging-schedule-heading');
    const scheduleInfo = make('span', '', '', `${id}-schedule-info`), periodCount = make('span', '', 'charging-period-count', `${id}-period-count`);
    scheduleHeading.append(scheduleInfo, periodCount);
    const readings = make('dl', '', 'equipment-readings charging-facts', `${id}-readings`), notes = make('ul', '', 'charging-notes', `${id}-notes`);
    const periods = make('dl', '', 'equipment-readings charging-periods', `${id}-periods`);
    const session = make('section', '', 'charging-detail-section');
    const sessionStatus = make('p', '', 'charging-session-status', `${id}-session-status`);
    session.append(make('h5', 'Schedule & readings'), state, sessionStatus, problem, priority, readiness, readingTime, scheduleHeading, periods, readings, notes);
    body.append(session);
    const master = make('div', '', 'charging-master'), masterLabel = make('span', 'Automatic charging', '', `${id}-enabled-label`);
    const enabledValue = make('button', 'OFF', '', `${id}-enabled`); enabledValue.type = 'button';
    enabledValue.setAttribute('role', 'switch'); enabledValue.setAttribute('aria-checked', 'false');
    enabledValue.setAttribute('aria-labelledby', masterLabel.id); master.append(masterLabel, enabledValue);
    const controlDetail = make('p', '', 'muted charging-form-help', `${id}-control-detail`);
    const preferences = make('section', '', 'charging-detail-section', `${id}-charging-controls`);
    const scopeNote = make('p', 'Changes apply until unplugging. General and vehicle defaults are changed only in configuration.', 'charging-form-help');
    const identificationSection = make('section', '', 'charging-identification', `${id}-identification`);
    const identificationHeading = make('div', '', 'charging-identification-heading');
    const identificationTitle = make('h6', 'Identification', '', `${id}-identification-title`);
    const identificationState = make('span', '', 'charging-identification-state', `${id}-identification-state`);
    identificationHeading.append(identificationTitle, identificationState);
    identificationSection.setAttribute('aria-labelledby', identificationTitle.id);
    const identify = make('button', 'Identify', 'secondary-button', `${id}-identify`); identify.type = 'button';
    const identificationStatus = make('p', '', 'charging-form-help', `${id}-identification-status`);
    identificationStatus.setAttribute('role', 'status'); identify.setAttribute('aria-describedby', identificationStatus.id);
    const identificationMessage = make('p', '', 'temporary-status', `${id}-identification-message`); identificationMessage.setAttribute('role', 'status');
    identificationSection.append(identificationHeading, identificationStatus, identify, identificationMessage);
    preferences.append(make('h5', 'Charging controls'), master, controlDetail, resume, sharedPriority.createEntry(id), identificationSection);
    const sessionPreferences = make('section', '', 'charging-detail-section', `${id}-session-settings`);
    sessionPreferences.append(make('h5', 'Session settings'), scopeNote); body.append(sessionPreferences);
    const form = make('form', '', 'charging-settings-form', `${id}-settings-form`), primaryFields = make('div', '', 'charging-fields');
    const save = make('button', 'Save for this session', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, save); sessionPreferences.append(form, message);
    for (const control of [chargeNow, resume, identify, enabledValue, form]) control.setAttribute('data-write-control', '');
    const settings = group(id, chargingFields, () => primaryFields, form, save, message, `${prefix}/settings`);
    body.append(preferences);
    const explanationFold = make('details', '', 'equipment-fold charging-explanations', `${id}-explanation-details`);
    explanationFold.append(make('summary', 'How charging works'));
    const explanations = make('dl', '', 'equipment-readings', `${id}-explanations`); explanationFold.append(explanations); body.append(explanationFold);
    section.append(summary, body); $('charging-devices')?.append(section);
    const device = { id, chargeNow, chargeNowState, controlMessage, identify, identificationSection, identificationState, identificationStatus, identificationMessage, section, title, vehicle, state, event, eventLabel, eventValue, overview, sources, metrics, chargeLabel, targetLabel, targetSource, completionLabel, completion, readiness, priority, readingTime, deadline, deadlineGroup, facts, deliveredLabel, deliveredValue, remaining, energyLabel, energyValue, costLabel, cost, costMetric, scheduleInfo, scheduleHeading, periodCount, periods, problem, explanations, readings, notes, settings, enabledValue, resume, controlDetail, charger, notice, footerHint, sessionStatus };
    bind(identify, 'click', () => {
      if (identify.disabled) return;
      const current = device.charger;
      return mutate(`${prefix}/identify`, { association: current.association,
        sessionId: current.request.sessionId, revision: current.request.revision }, identificationMessage);
    });
    bind(enabledValue, 'click', () => {
      if (enabledValue.disabled) return;
      const current = device.charger;
      return mutate(`${prefix}/control`, { association: current.association, revision: current.controls.revision,
        enabled: !current.settings.enabled }, controlMessage, 'Automatic charging preference saved. It stays in effect until changed.');
    });
    bind(chargeNow, 'click', event => {
      event.preventDefault(); event.stopPropagation();
      if (chargeNow.disabled) return;
      const current = device.charger;
      if (current.request?.chargeNow === true) return resumeAutomatic();
      return mutate(`${prefix}/charge-now`, { association: current.association,
        sessionId: current.request.sessionId, revision: current.request.revision }, controlMessage);
    });
    bind(resume, 'click', event => {
      event.preventDefault(); event.stopPropagation();
      if (resume.disabled) return;
      return resumeAutomatic();
    });
    function resumeAutomatic() {
      const current = device.charger;
      return current.settings.enabled
        ? mutate(`${prefix}/resume`, {}, controlMessage)
        : mutate(`${prefix}/control`, { association: current.association, revision: current.controls.revision, enabled: true },
          controlMessage, '', undefined, async () => {
            const latest = device.charger;
            if (devices.get(id) !== device || latest.association !== current.association
              || latest.request?.sessionId !== current.request?.sessionId || !latest.settings.enabled)
              throw new Error('The charging connection or preference changed. Review it before trying again.');
            if (!writable() || latest.readOnly) throw new Error('Control authority changed before automatic handover. Review the current status.');
            try { return await request(`${prefix}/resume`, {}); }
            catch (error) { throw new Error(`Automatic charging is on, but handover could not be completed. ${error.message ?? 'Try again.'}`); }
          });
    }
    devices.set(id, device); return device;
  }
  async function mutate(path, payload, message, success = '', saved = () => {}, followup) {
    if (busy || !writable()) return false;
    actionMessages.delete(message);
    busy = true; actionMessage(message, success ? 'Saving…' : '', { pending: true }); refreshControls();
    try {
      beforeRequest(); const result = await request(path, payload); saved(); update(result); onStatus(result);
      if (followup) { const next = await followup(); update(next); onStatus(next); }
      actionMessage(message, typeof success === 'function' ? success() : success);
      return true;
    } catch (error) { actionMessage(message, error.message ?? 'Could not save charging settings.', { error: true }); return false; }
    finally { actionMessages.set(message, status?.now ?? Date.now()); busy = false; refreshControls(); afterRequest(); }
  }
  function updateFields(group, settings, charger) {
    const session = requestKey(charger);
    if (group.currentSession !== session) {
      if (group.dirty.size) group.message.textContent = 'The session changed. Review and edit the current values again.';
      group.dirty.clear(); group.drafts.clear(); group.draftSession = null;
    }
    group.currentSession = session;
    for (const [key, { field, input, help }] of group.fields) {
      const reading = charger?.values?.[field.reading ?? key], live = field.automatic && automaticFor(charger, reading);
      input.value = (group.dirty.has(key) ? group.drafts.get(key) : live ? reading.value : get(settings, key)) ?? '';
      const unsupported = field.scheduling && !charger?.capabilities?.scheduling;
      const configured = get(charger.defaults ?? settings, key);
      const configuredDetail = configured == null ? '' : `Configured default: ${configured}${key === 'capacityKwh' ? ' kWh' : key === 'readyBy' ? '' : '%'}. `;
      help.textContent = unsupported ? 'Scheduling is unavailable with this integration.'
        : `${live ? `${sourceLabel(reading, charger.vehicle)} supplies the current value. ` : ''}${configuredDetail}${field.help ?? ''}`;
      help.hidden = !help.textContent;
    }
  }
  function refreshControls() {
    const locked = busy || !writable();
    sharedPriority.update(status?.charging, { busy, writable: writable() });
    for (const device of devices.values()) {
      const { charger, settings } = device, supported = charger.capabilities?.scheduling === true;
      for (const [key, { field, input, label }] of settings.fields) {
        const unsupported = field.scheduling && !supported;
        input.disabled = Boolean(locked || charger.readOnly || !connectedSession(charger) || unsupported);
        if (field.type === 'time') timePicker.update(input, settings.currentSession);
        label.hidden = unsupported; label.classList.toggle('charging-field-disabled', Boolean(unsupported));
      }
      settings.save.disabled = locked || !connectedSession(charger) || settings.draftSession !== settings.currentSession
        || ![...settings.fields].some(([key, { input }]) => settings.dirty.has(key) && !input.disabled);
      device.enabledValue.parentElement.hidden = !supported;
      device.enabledValue.disabled = locked || charger.readOnly === true || !supported || !charger.controls;
      const chargeNowActive = charger.request?.chargeNow === true, view = chargerDisplay(charger);
      device.chargeNow.hidden = !supported;
      device.chargeNowState.textContent = chargeNowActive ? 'ON' : 'OFF';
      device.chargeNow.setAttribute('aria-pressed', String(chargeNowActive));
      device.chargeNow.disabled = locked || charger.readOnly === true || !supported
        || !connectedSession(charger);
      device.chargeNow.title = !supported ? 'Monitoring only' : !writable() || charger.readOnly ? 'View only'
        : !connectedSession(charger) ? 'Connect a vehicle'
          : chargeNowActive ? 'Charge now is on until unplugging. Turn off to use automatic charging.' : 'Turn on immediate charging until unplugging.';
      const identification = identificationPresentation(charger);
      const connected = charger.values?.connected?.value, pauseOutstanding = charger.identification?.pauseOutstanding === true;
      device.identify.disabled = locked || charger.readOnly === true || !connectedSession(charger)
        || charger.identification?.available !== true || charger.identification?.active === true || pauseOutstanding;
      device.identify.title = !writable() || charger.readOnly ? 'View only'
        : identification?.recovery ? 'Waiting for the identification pause to be released'
          : connected === false ? 'Connect a vehicle' : !connectedSession(charger) ? 'Waiting for charger readings'
          : charger.identification?.active ? 'Identification is already in progress'
            : charger.identification?.available !== true ? 'Identification is currently unavailable' : 'Check which vehicle is connected. This may briefly pause charging.';
      device.identificationState.textContent = identification?.state ?? (connected === false ? 'Not connected'
        : !connectedSession(charger) || charger.identification?.available !== true ? 'Unavailable' : 'Ready');
      device.identificationSection.dataset.state = identification?.recovery ? 'attention' : charger.identification?.phase === 'inconclusive' ? 'inconclusive' : 'normal';
      device.identificationStatus.textContent = identification?.detail
        ?? (connected === false ? 'Connect a vehicle to identify it.' : !connectedSession(charger) ? 'Waiting for current charger readings before identification is available.'
          : charger.identification?.available !== true ? 'Identification is currently unavailable. Live vehicle matching continues.'
            : 'A short charging test can check this connection again and may briefly pause charging. Works with Automatic charging off and Charge now; Manual Stop keeps priority.');
      device.resume.hidden = !supported || !view.yielded && charger.control?.reason !== 'identification-resume-required';
      device.resume.disabled = locked || charger.readOnly === true || device.resume.hidden;
    }
  }
  function update(next) {
    for (const [node, at] of actionMessages) if (!actionReceiptRecent(at, next?.now ?? Date.now())) {
      actionMessage(node, ''); actionMessages.delete(node);
    }
    if (Number.isSafeInteger(next?.charging?.revision) && Number.isSafeInteger(status?.charging?.revision) && next.charging.revision < status.charging.revision
      && isReadOnlyReplica(next) === isReadOnlyReplica(status) && next.charging.readOnly === status.charging.readOnly
      && replicaSnapshotKey(next) === replicaSnapshotKey(status)) return;
    status = next;
    const charging = next?.charging;
    const globalError = ({ 'charging-planning-unavailable': 'The charging plan could not be updated. The last charger instructions remain in effect.',
      'charging-reconciliation-unavailable': 'The current charging instructions could not be confirmed.' })[charging?.error] ?? (charging?.error ? human(charging.error) : '');
    const globalStatus = $('charging-status');
    const globalTrigger = setStatusDetail(globalStatus, { label: globalError ? 'Charging needs attention' : '',
      title: 'Charging status', detail: globalError, key: 'charging-status' });
    if (globalTrigger) globalTrigger.setAttribute('aria-label', `${globalError} Show details`);
    if (globalStatus) globalStatus.hidden = !globalError;
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
        title: 'Charging activity', detail: [presentation.activity, view.identification?.detail, view.controlDetail].filter(Boolean).join('\n\n'), key: `${charger.id}:activity` });
      device.event.dataset.state = view.risk ? 'attention' : 'normal';
      device.overview.hidden = false;
      device.metrics.soc.value.textContent = view.showMetrics ? view.soc : '—'; device.metrics.minimum.value.textContent = view.showMetrics ? view.minimum : '—';
      device.sources.textContent = !view.showMetrics ? 'Awaiting data' : view.soc.startsWith('≈') ? 'Estimated charge' : view.sources;
      device.metrics.minimum.value.dataset.state = view.showMetrics && view.targetHeld ? 'attention' : 'normal';
      device.targetSource.textContent = view.showMetrics && view.targetHeld ? 'Held BMW target' : '';
      device.targetSource.hidden = !device.targetSource.textContent;
      device.completion.textContent = presentation.completion.value;
      const sourceDetail = !view.showMetrics ? 'A confirmed vehicle connection is needed before a remembered charge reading can be shown as current.'
        : [view.soc.startsWith('≈') ? `${view.socSource}, allowing for charging losses. The battery estimate advances from the latest charge reference; Added energy covers the whole connection.` : view.socSource, view.readingTime].filter(Boolean).join('\n');
      metricDetail(device.chargeLabel, { label: 'Charge', title: 'Current charge', detail: sourceDetail, key: `${charger.id}:source` });
      metricDetail(device.targetLabel, { label: 'Target', title: 'Target charge', detail: !view.showMetrics ? 'The target will be shown for the connected vehicle. Configured defaults are shown in Session settings.' : [`${view.minimumSource}. Estimates cover reaching this charge, which is not a command to stop the vehicle.`, view.targetDetail].filter(Boolean).join('\n\n'), key: `${charger.id}:target` });
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
      const deliveredEnergy = charger.sessionCost?.recordedGridKwh;
      energyText(device.deliveredValue, view.showMetrics && finite(deliveredEnergy) ? number(deliveredEnergy, 'kWh') : '—');
      metricDetail(device.deliveredLabel, { label: 'Added energy', title: 'Energy added since plugging in',
        detail: view.showMetrics && finite(deliveredEnergy) ? 'Recorded grid energy since plugging in, including charging losses. It remains after charging ends and after the ready-by time, until the vehicle disconnects. New battery readings do not reset it; missing measurements are not estimated.' : 'No recorded energy total is available for this connection.', key: `${charger.id}:delivered` });
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
        if (label === 'Charging limit') return [label, text, 'The reported maximum current per phase. Actual current can be lower when supply is shared or the vehicle limits its draw.'];
        return [label, text, detail];
      });
      if (charger.control?.limiter) rows.push(['Current policy', charger.capabilities?.currentControl
        ? `${human(charger.control.reason)} · ${number(charger.control.limiter.currentA, 'A')} offered ceiling`
        : 'Native charger current settings'], ['Command confirmation', human(charger.control.executionStage ?? 'unconfirmed')]);
      if (charger.telemetry?.commissioning) rows.push(['EVSE readiness', !charger.telemetry.commissioning.controlReady ? 'Control unavailable'
        : charger.capabilities?.currentControl && charger.telemetry.commissioning.currentControlReady !== true
          ? 'Current limiter unavailable' : 'Start/stop available'], ['Controller loss', 'Autonomous fallback unverified']);
      if (charger.values?.vehicleNotBefore?.available) rows.push(['Vehicle may accept from', chargingTime(charger.values.vehicleNotBefore.value, charging.timezone, next.now)]);
      if (charger.values?.vehicleCurrentA?.available) rows.push(['Vehicle current ceiling', number(charger.values.vehicleCurrentA.value, 'A')]);
      if (charger.sessionCost) rows.push(['Connection delivered', number(charger.sessionCost.deliveredGridKwh, 'kWh')]);
      list(device.readings, rows); device.readings.hidden = !rows.length;
      device.notes.replaceChildren(...view.notes.map(note => make('li', note))); device.notes.hidden = !view.notes.length;
      device.controlDetail.textContent = presentation.roleState === 'uncertain' && !view.identification?.recovery ? presentation.roleDetail : view.controlDetail;
      device.enabledValue.textContent = charger.settings.enabled === true ? 'ON' : 'OFF';
      device.enabledValue.setAttribute('aria-checked', String(charger.settings.enabled === true));
      updateFields(device.settings, charger.settings, charger);
    }
    for (const [id, device] of devices) if (!currentIds.has(id)) {
      timePicker.remove(device.settings.fields.get('readyBy').input);
      device.section.remove(); devices.delete(id); sharedPriority.removeEntry(id);
    }
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { sharedPriority.close(); timePicker.close(); for (const remove of listeners) remove(); } };
}
