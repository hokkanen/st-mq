import { isReadOnlyReplica } from './replica-status.js';

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
  { key: 'manualSoc', reading: 'soc', label: 'Current charge · %', type: 'number', min: 0, max: 100, step: 0.1, automatic: true,
    help: 'Used until an automatic charge reading is available.' },
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
  const creditedGridKwh = charger.progress?.creditedGridKwh;
  const hasProgress = finite(creditedGridKwh) && creditedGridKwh > 0;
  const requiredGridKwh = charger.progress?.remainingGridKwh ?? charger.requiredGridKwh ?? plan.requiredGridKwh ?? forecast.requiredGridKwh ?? forecast.gridEnergyKwh;
  const minimum = values.minimumSoc?.value, socKnown = finite(soc.value) && (soc.available || soc.source === 'manual-fallback');
  const finishAt = charging || released ? forecast.finishAt : plan.finishAt ?? forecast.finishAt;
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
    else if (validTime(finishAt)) event += ` · target estimated ${time(finishAt)}`;
  } else if (ownedStart != null && nextPeriod) {
    const resuming = periods.some(period => Number(period.startAt) <= now);
    state = uncertain ? 'Update unconfirmed' : resuming ? 'Paused between periods' : 'Scheduled';
    eventAt = nextPeriod.startAt; eventKind = 'confirmed';
    event = `${uncertain ? 'Last confirmed ' : ''}${resuming ? uncertain ? 'resume' : 'Resumes' : uncertain ? 'start' : 'Starts'} ${time(eventAt)}${revisionPending && !uncertain ? ' · update awaiting confirmation' : ''}`;
  } else if (handoverUnconfirmed) {
    state = 'Handover unconfirmed'; event = 'Waiting for the charger to confirm the handover.';
  } else if (uncertain || enabled && manual?.kind === 'unknown') {
    state = 'Control unavailable'; event = 'Waiting for a confirmed charger instruction.';
  } else if (released || (owned || execution) && currentPeriod) {
    event = 'Charging is allowed';
    if (validTime(finishAt) && Number(finishAt) > now && requiredGridKwh > 0) event += ` · target estimated ${time(finishAt)}`;
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
  const risk = showPlan && plan.feasible === false && plan.reason === 'insufficient-time';
  if (risk) event += ' · target at risk';
  const deadline = showMetrics && enabled && !yielded && validTime(plan.deadlineAt ?? charger.deadlineAt) ? `Ready by ${time(plan.deadlineAt ?? charger.deadlineAt)}` : '';
  const readingTime = showMetrics && automatic(soc) ? validTime(soc.measuredAt) ? `Charge measured ${chargingReadingTime(soc.measuredAt, timezone)}`
    : validTime(soc.receivedAt) ? `Charge received ${chargingReadingTime(soc.receivedAt, timezone)} · measurement time unknown` : 'Charge measurement time unknown' : '';
  const rows = [];
  if (activeManual && validTime(manual.detectedAt)) rows.push(['Manual change noticed', chargingReadingTime(manual.detectedAt, timezone)]);
  if (showMetrics && hasProgress) rows.push(['Delivered since charge reading', `${number(creditedGridKwh, 'kWh')} · estimated from measured charging power`]);
  if (showMetrics && finite(values.maximumCurrentA?.value)) rows.push(['Charging limit', number(values.maximumCurrentA.value, 'A per phase')]);
  if (showMetrics && charger.capabilities?.externalLoadBalancing && finite(values.availableCurrentA?.value))
    rows.push(['Last reported Equalizer allowance', `${number(values.availableCurrentA.value, 'A per phase')}${validTime(values.availableCurrentA.measuredAt)
      ? ` · ${time(values.availableCurrentA.measuredAt)}` : validTime(values.availableCurrentA.receivedAt) ? ` · received ${time(values.availableCurrentA.receivedAt)}` : ''}`]);
  else if (showMetrics && !charger.capabilities?.externalLoadBalancing && finite(values.currentA?.value)) rows.push(['Selected charging current', number(values.currentA.value, 'A per phase')]);
  if (charging && finite(values.actualCurrentA?.value)) rows.push(['Drawing now', number(values.actualCurrentA.value, 'A per phase')]);
  if (showPlan && !released && !charging && finite(plan.costCents) && !uncertain && !revisionPending) {
    rows.push(['Estimated cost to target', `€${(plan.costCents / 100).toFixed(2)}`]);
    if (periods.length > 1 && finite(plan.savingsCents) && plan.savingsCents > 0) rows.push(['Saving from pauses', `€${(plan.savingsCents / 100).toFixed(2)} compared with one continuous period`]);
  }
  const periodRows = showPlan && !released ? periods.map((period, index) => [`Period ${index + 1}`, validTime(period.endAt)
    ? window(period.startAt, period.endAt, true) : `${time(period.startAt)} onwards · vehicle finishes naturally`]) : [];
  const periodCount = showPlan && !released && periods.length > 1 ? `${periods.length} charging periods${ownedPeriods.length ? '' : ' proposed'}` : '';
  const fallbackNotice = /manual (?:fallback|battery percentage|minimum)|remembered manual|assumes? (?:0|20)%|phase count is known|preview assumes the vehicle/i;
  const notes = enabled && showMetrics && !yielded && !uncertain
    ? [...notices(plan.warnings), ...notices(forecast.warnings)].filter(note => !fallbackNotice.test(note)) : [];
  let problem = uncertain || handoverUnconfirmed || enabled && manual?.kind === 'unknown' ? control.reason || 'The charger instruction could not be confirmed. Another reading will be requested.' : '';
  if (charger.error) problem ||= ({ 'charging-adapter-unavailable': 'The charger connection is unavailable. Automatic control is waiting for a connection.',
    'charging-reconciliation-unavailable': 'The charger schedule could not be confirmed. The last instruction may still be active; another reading will be requested.',
    'charging-planning-unavailable': 'The charging forecast could not be updated. The last confirmed instruction remains in effect; planning will retry.' })[charger.error] ?? human(charger.error);
  const missed = control.lastMissedTransition;
  if (enabled && showMetrics && !yielded && validTime(missed?.pauseAt) && validTime(missed?.resumeAt))
    notes.push(`Planned pause ${window(missed.pauseAt, missed.resumeAt, true)} was not confirmed; charging may have continued.`);
  if (showMetrics && charger.mqtt?.reason && !['awaiting-mqtt', 'awaiting-subscription'].includes(charger.mqtt.reason)) notes.push(`Vehicle reading unavailable: ${human(charger.mqtt.reason)}.`);
  const controlDetail = !supported ? 'This integration supports monitoring only.'
    : activeManual ? 'Resume automatic charging to end manual priority early. A later manual change takes priority again.'
      : 'Choose economical charging periods to reach the target by the ready-by time.';
  const efficiency = charger.configuration?.efficiency;
  const explanations = [
    ['Readings & fallbacks', 'Automatic charge, target and usable capacity take priority. Saved manual values are used when an automatic value is unavailable. A valid charge reading remains usable as it ages; its original date and time stay visible.'],
    ['Charging progress', 'Measured charging power can reduce the remaining grid energy during this connection. This does not change the vehicle charge reading. Progress resets with a new charge reading or disconnection; missing measurements receive no assumed credit.'],
    ['Energy estimate', `Three-phase charging is assumed; voltage comes from provider readings.${finite(efficiency) ? ` Charging efficiency is ${number(efficiency * 100, '%')}; grid energy includes those losses.` : ''}`],
  ];
  if (supported) explanations.push(
    ['Price planning', 'Charging may pause between cheaper periods. The final period leaves charging enabled until the vehicle finishes, including beyond the target and ready-by time. Estimates cover reaching the target.'],
    ['Period transitions', 'Installing planned pauses and next starts requires this service and the Easee cloud. Easee shows the current instruction; this page shows all planned periods. If contact is lost, the last instruction remains in effect and an open period may continue past a planned pause. Missed or unconfirmed transitions are reported when contact resumes.'],
    ['Household consumption', assumptions.household === 'history' ? 'The forecast averages non-charging household consumption at the same local hour over the last seven days, weighted by measurement duration. Each hour needs at least 15 minutes of usable history.'
      : assumptions.household === 'mixed' ? 'The forecast averages the last seven days at the same local hour, weighted by measurement duration. It assumes zero other load for hours with less than 15 minutes of usable history.'
        : 'Without usable household history, the forecast assumes zero other household load.'],
    ['Other charging', 'Another charger is reserved as a future load only when a charging event is scheduled. Actual consumption is already reflected in property readings.'],
    ['Manual priority', 'A noticed external schedule change has priority until its window ends or the next ready-by time, whichever comes first. Resume automatic charging ends that priority early; a later manual change takes priority again. Changes are observed with automatic charging off too. A fresh charger read is required before handover.'],
    ['Saved priority', 'The first charger reading establishes a baseline; existing schedules alone do not claim priority. Our own changes and normal schedule expiry do not count as manual changes. Priority survives reconnection and restart. Editing ready-by does not move an already recorded expiry.'],
    ['Unavailable data', 'Without a reliable price or power forecast, or with too little time, charging is allowed immediately when control is available. A disabled charger, fault or authorization requirement must be resolved first. An unconfirmed change is shown beside the last known instruction and retried after another charger reading.'],
  );
  if (charger.capabilities?.externalLoadBalancing) explanations.splice(2, 0, ['Current allocation', 'Equalizer controls the current and protects the property supply. Its live allowance can change; the charging limit is a ceiling, not a promise of power throughout the night. Automatic charging does not change Equalizer limits.']);
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk, showMetrics,
    soc: socKnown ? number(soc.value, '%') : 'Unknown', socSource: sourceLabel(soc), minimum: number(minimum, '%'),
    minimumSource: sourceLabel(values.minimumSoc), gridEnergy: number(requiredGridKwh, 'kWh'), deadline, readingTime, periodCount, periodRows,
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
  function list(root, rows) {
    const fragment = document.createDocumentFragment();
    for (const [label, text] of rows) fragment.append(make('dt', label), make('dd', text));
    root.replaceChildren(fragment);
  }
  function createField(group, field, root) {
    const label = make('label', field.label), input = make('input', '', '', settingId(group.id, field.key));
    input.type = field.type; input.disabled = true; input.required = !field.nullable;
    for (const key of ['min', 'max', 'step']) if (field[key] !== undefined) input[key] = field[key];
    if (field.nullable) input.placeholder = 'Not set';
    const help = make('small', field.help ?? '', '', `${input.id}-help`);
    label.htmlFor = input.id; input.setAttribute('aria-describedby', help.id); label.append(input, help); root.append(label);
    group.fields.set(field.key, { field, input, label, help });
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
    const section = make('section', '', 'equipment-device charging-device', `${id}-device`);
    section.setAttribute('aria-labelledby', `${id}-title`);
    const heading = make('div', '', 'equipment-device-heading'), title = make('h4', charger.label, '', `${id}-title`);
    const state = make('span', '', 'equipment-device-status', `${id}-state`); heading.append(title, state); section.append(heading);
    const overview = make('div', '', 'pump-native-overview charging-overview', `${id}-overview`), metrics = {};
    const charge = make('div', '', 'equipment-value'), pair = make('strong', '', 'charging-charge-pair');
    const current = make('span', 'Unknown', '', `${id}-soc`), target = make('span', 'Unknown', '', `${id}-minimum`);
    pair.append(current, make('span', ' / ', 'charging-pair-divider'), target);
    const sources = make('small', '', '', `${id}-sources`);
    charge.append(make('span', 'Current / target'), pair, sources); overview.append(charge);
    metrics.soc = { value: current }; metrics.minimum = { value: target };
    const energy = make('div', '', 'equipment-value'), energyValue = make('strong', 'Unknown', '', `${id}-energy`), energyHint = make('small');
    const energyLabel = make('span', 'Grid to target'); energy.append(energyLabel, energyValue, energyHint); overview.append(energy);
    metrics.energy = { value: energyValue, hint: energyHint, label: energyLabel };
    const readingTime = make('p', '', 'charging-reading-time', `${id}-reading-time`);
    const timing = make('div', '', 'charging-timing'), event = make('p', '', 'charging-event', `${id}-event`);
    const deadline = make('p', '', 'charging-deadline', `${id}-deadline`), periodCount = make('p', '', 'charging-period-count', `${id}-period-count`);
    const priority = make('p', '', 'charging-priority', `${id}-priority`);
    timing.append(event, deadline); section.append(overview, readingTime, timing, periodCount, priority);
    const problem = make('p', '', 'charging-problem', `${id}-problem`); problem.setAttribute('role', 'status'); section.append(problem);
    const fold = make('details', '', 'equipment-fold charging-settings', `${id}-settings-details`);
    fold.append(make('summary', 'Settings & details'));
    const readings = make('dl', '', 'equipment-readings', `${id}-readings`), notes = make('ul', '', 'charging-notes', `${id}-notes`);
    const periods = make('dl', '', 'equipment-readings charging-periods', `${id}-periods`);
    fold.append(periods, readings, notes);
    const master = make('div', '', 'charging-master'), masterLabel = make('span', 'Automatic charging', '', `${id}-enabled-label`);
    const toggle = make('button', 'OFF', '', `${id}-enabled`); toggle.type = 'button'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false'); toggle.setAttribute('aria-labelledby', masterLabel.id); master.append(masterLabel, toggle);
    const controlDetail = make('p', '', 'muted charging-form-help', `${id}-control-detail`);
    const resume = make('button', 'Resume automatic charging', 'secondary-button', `${id}-resume`); resume.type = 'button';
    const controlMessage = make('p', '', 'temporary-status', `${id}-control-message`); controlMessage.setAttribute('role', 'status');
    fold.append(master, controlDetail, resume, controlMessage);
    const form = make('form', '', 'charging-settings-form', `${id}-settings-form`), primaryFields = make('div', '', 'charging-fields');
    const save = make('button', 'Save settings', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, save); fold.append(form, message);
    const settings = group(id, chargingFields, () => primaryFields, form, save, message, `${prefix}/settings`);
    const explanationFold = make('details', '', 'equipment-fold charging-explanations', `${id}-explanation-details`);
    explanationFold.append(make('summary', 'How charging works'));
    const explanations = make('dl', '', 'equipment-readings', `${id}-explanations`); explanationFold.append(explanations); fold.append(explanationFold);
    section.append(fold); $('charging-devices')?.append(section);
    const device = { id, section, title, state, event, overview, sources, metrics, priority, readingTime, deadline, periodCount, periods, problem, explanations, readings, notes, settings, toggle, resume, controlDetail, charger };
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
      help.textContent = live ? `${sourceLabel(reading)} supplies this value. Saved fallback: ${get(settings, key)}${key === 'capacityKwh' ? ' kWh' : '%'}.`
        : field.scheduling && !charger?.capabilities?.scheduling ? 'Scheduling is unavailable with this integration.' : field.help ?? '';
      help.hidden = !help.textContent;
    }
  }
  function refreshControls() {
    const locked = busy || !writable();
    for (const device of devices.values()) {
      const { charger, settings } = device, supported = charger.capabilities?.scheduling === true;
      for (const [key, { field, input, label }] of settings.fields) {
        const unsupported = field.scheduling && !supported, live = field.automatic && automatic(charger.values?.[field.reading ?? key]);
        input.disabled = locked || unsupported || live; label.classList.toggle('charging-field-disabled', Boolean(unsupported || live));
      }
      settings.save.disabled = locked || ![...settings.fields].some(([key, { input }]) => settings.dirty.has(key) && !input.disabled);
      device.toggle.disabled = locked || !supported;
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
      device.charger = charger; device.title.textContent = charger.label; device.state.textContent = view.state;
      device.event.textContent = view.event; device.event.dataset.state = view.risk ? 'attention' : 'normal';
      device.overview.hidden = !view.showMetrics;
      device.metrics.soc.value.textContent = view.soc; device.metrics.minimum.value.textContent = view.minimum;
      device.sources.textContent = view.socSource === view.minimumSource ? `Both: ${view.socSource}` : `Current: ${view.socSource} · target: ${view.minimumSource}`;
      device.readingTime.textContent = view.readingTime; device.readingTime.hidden = !view.readingTime;
      device.deadline.textContent = view.deadline; device.deadline.hidden = !view.deadline;
      device.priority.textContent = view.priority; device.priority.hidden = !view.priority;
      device.periodCount.textContent = view.periodCount; device.periodCount.hidden = !view.periodCount;
      device.problem.textContent = view.problem; device.problem.hidden = !view.problem;
      list(device.periods, view.periodRows); device.periods.hidden = !view.periodRows.length;
      list(device.explanations, view.explanations);
      device.metrics.energy.label.textContent = view.energyLabel; device.metrics.energy.value.textContent = view.gridEnergy; device.metrics.energy.hint.textContent = view.energyNote;
      list(device.readings, view.rows); device.readings.hidden = !view.rows.length;
      device.notes.replaceChildren(...view.notes.map(note => make('li', note))); device.notes.hidden = !view.notes.length;
      device.controlDetail.textContent = view.controlDetail;
      const enabled = charger.settings.enabled === true; device.toggle.textContent = enabled ? 'ON' : 'OFF'; device.toggle.setAttribute('aria-checked', String(enabled));
      updateFields(device.settings, charger.settings, charger);
      set(`${charger.id}-summary`, view.summary); if ($(`${charger.id}-summary`)) $(`${charger.id}-summary`).title = view.summary;
    }
    for (const [id, device] of devices) if (!currentIds.has(id)) { device.section.remove(); devices.delete(id); }
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { for (const remove of listeners) remove(); } };
}
