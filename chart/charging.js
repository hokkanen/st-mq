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
  if (field?.assumed || field?.source === 'assumed') return 'Assumes 0% for planning';
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
  { key: 'minimumSoc', label: 'Minimum charge · %', type: 'number', min: 0, max: 100, step: 1, automatic: true,
    help: 'The vehicle charge target takes priority when available.' },
  { key: 'readyBy', label: 'Ready-by time · local', type: 'time', scheduling: true,
    help: 'ST-MQ plans to reach the minimum by this time. Charging may continue afterwards.' },
  { key: 'capacityKwh', label: 'Usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, automatic: true,
    help: 'Manual fallback when the vehicle does not report usable capacity.' },
].map(field => ({ type: 'text', ...field }));

export function chargerDisplay(charger, { now = Date.now(), timezone = 'Europe/Helsinki', assumptions = {} } = {}) {
  const values = charger.values ?? {}, settings = charger.settings ?? {}, control = charger.control ?? {};
  const plan = charger.plan ?? {}, forecast = charger.forecast ?? {}, soc = values.soc ?? {};
  const time = value => chargingTime(value, timezone, now);
  const connected = values.connected?.value, charging = connected === true && values.charging?.value === true;
  const supported = charger.capabilities?.scheduling === true, enabled = supported && settings.enabled === true;
  const phase = control.phase ?? '', manual = enabled && connected === true ? control.manual ?? control.manualOverride : null;
  const uncertain = enabled && (['uncertain', 'ownership-uncertain', 'unavailable'].includes(phase) || Boolean(control.errorCode));
  const yielded = enabled && connected === true && (['yielded', 'manual'].includes(phase) || Boolean(manual));
  const activeManual = yielded && !uncertain && manual?.kind !== 'unknown';
  const handoverUnconfirmed = !enabled && control.handoverConfirmed === false;
  const released = enabled && ['released', 'charging'].includes(phase);
  const ownedStart = enabled && !yielded && !uncertain && ['scheduled', 'waiting', 'confirmed'].includes(phase)
    && control.confirmed !== false && validTime(control.owned?.startAt) ? control.owned.startAt : null;
  const revisionPending = ownedStart != null && validTime(plan.startAt) && Number(ownedStart) !== Number(plan.startAt);
  const nativeStart = values.scheduledStartAt?.value, nativeEnd = values.scheduledEndAt?.value;
  const endKind = charger.scheduledEndKind ?? charger.telemetry?.scheduledEndKind ?? values.scheduledEndAt?.kind;
  const nativeStops = ['enforced', 'scheduled-stop'].includes(endKind);
  const requiredGridKwh = charger.requiredGridKwh ?? plan.requiredGridKwh ?? forecast.requiredGridKwh ?? forecast.gridEnergyKwh;
  const minimum = values.minimumSoc?.value;
  const socKnown = finite(soc.value) && (soc.available || soc.source === 'manual-fallback');
  const finishAt = charging || released ? forecast.finishAt : plan.finishAt ?? forecast.finishAt;
  const manualStart = manual?.startsAt ?? manual?.startAt ?? nativeStart;
  const resumeAt = manual?.resumeAt ?? manual?.endAt ?? (nativeStops ? nativeEnd : null);
  const hasManualWindow = activeManual && manual?.kind === 'window' && validTime(resumeAt);
  let state = connected === false ? 'Not connected' : connected === true ? 'Connected' : 'Connection unknown';
  let event = '', eventAt = null, eventKind = null;
  const window = (start, end) => {
    if (!validTime(start) || Number(start) <= now) return `until ${time(end)}`;
    const endTime = dateKey(start, timezone) === dateKey(end, timezone) ? time(end).match(/\d{2}:\d{2}$/)?.[0] : time(end);
    return `${time(start)}–${endTime}`;
  };

  if (charging) {
    state = 'Charging';
    event = finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now` : 'Charging now';
    if (hasManualWindow) event += ` · Easee window ends ${time(resumeAt)} · ST-MQ resumes afterwards`;
    else if (!enabled && nativeStops && validTime(nativeEnd) && Number(nativeEnd) > now) event += ` · scheduled until ${time(nativeEnd)}`;
    else if (finite(requiredGridKwh) && requiredGridKwh <= 0) event += ' · minimum reached';
    else if (validTime(finishAt)) event += ` · minimum estimated ${time(finishAt)}`;
  } else if (handoverUnconfirmed) {
    state = 'Handover unconfirmed'; event = control.reason || 'Charger handover is not confirmed. Check the Easee schedule.';
  } else if (uncertain || enabled && manual?.kind === 'unknown') {
    state = 'Control unavailable'; event = control.reason || 'Waiting for a confirmed charger state.';
  } else if (activeManual) {
    state = 'Manual control';
    if (hasManualWindow) {
      event = `Easee window ${window(manualStart, resumeAt)} · ST-MQ resumes afterwards`;
      eventAt = Number(manualStart) > now ? manualStart : resumeAt; eventKind = 'manual';
    } else event = control.reason || manual?.reason || 'Manual charger control is active.';
  } else if (connected !== true) {
    event = enabled ? connected === false ? 'ST-MQ is ready for the next connection' : 'Waiting for charger readings'
      : supported ? 'ST-MQ control OFF' : 'Monitoring';
  } else if (released) {
    event = 'Charging is allowed';
    if (validTime(finishAt) && Number(finishAt) > now && requiredGridKwh > 0) event += ` · minimum estimated ${time(finishAt)}`;
  } else if (enabled && validTime(ownedStart ?? plan.startAt) && Number(ownedStart ?? plan.startAt) > now) {
    eventAt = ownedStart ?? plan.startAt; eventKind = ownedStart != null ? 'confirmed' : 'proposed';
    event = `${ownedStart != null ? 'Starts' : 'Proposed start'} ${time(eventAt)}${revisionPending ? ' · update awaiting confirmation' : ''}`;
  } else if (!enabled && validTime(nativeStart) && Number(nativeStart) > now) {
    eventAt = nativeStart; eventKind = 'vehicle';
    event = nativeStops && validTime(nativeEnd) ? `Scheduled ${window(nativeStart, nativeEnd)}` : `Scheduled start ${time(nativeStart)}`;
  } else if (enabled) event = control.reason || 'Waiting for a charging plan';
  else event = supported ? 'ST-MQ control OFF' : 'Monitoring';

  const risk = enabled && connected === true && plan.feasible === false && plan.reason === 'insufficient-time' && !yielded && !uncertain;
  if (risk) event += ' · minimum at risk';
  const rows = [];
  if (charging && uncertain && control.reason) rows.push(['Control status', control.reason]);
  if (automatic(soc)) {
    if (validTime(soc.measuredAt)) rows.push(['Charge reading', `Measured ${time(soc.measuredAt)}`]);
    else if (validTime(soc.receivedAt)) rows.push(['Charge reading', `Received ${time(soc.receivedAt)} · measurement time unknown`]);
  }
  if (connected === true && finite(values.currentA?.value)) {
    const equalizer = charger.capabilities?.externalLoadBalancing;
    rows.push([equalizer ? 'Equalizer allowance' : 'Charging current estimate',
      `${number(values.currentA.value, 'A per phase')}${equalizer && assumptions.supply === 'equalizer-live' ? ' · used for the forecast' : ''}`]);
  }
  const automaticPlan = enabled && connected === true && !yielded && !uncertain && !released && !charging;
  if (automaticPlan && validTime(plan.deadlineAt ?? charger.deadlineAt)) rows.push(['Ready by', time(plan.deadlineAt ?? charger.deadlineAt)]);
  if (automaticPlan && finite(plan.costCents)) rows.push(['Estimated cost to minimum', `€${(plan.costCents / 100).toFixed(2)}`]);
  if (automaticPlan && assumptions.supply === 'equalizer-adjusted') rows.push(['Forecast',
    assumptions.household === 'history' ? 'Three phases · household consumption history'
      : assumptions.household === 'mixed' ? 'Three phases · history where available; no other load otherwise'
        : 'Three phases · no other household load assumed']);
  // Fallback sources are already visible alongside their values. Repeat neither
  // those assumptions nor inactive plans in the details fold.
  const fallbackNotice = /manual (?:fallback|battery percentage|minimum)|remembered manual|assumes? 0%|phase count is known|preview assumes the vehicle/i;
  const notes = enabled && connected === true && !yielded && !uncertain
    ? [...notices(plan.warnings), ...notices(forecast.warnings)].filter(note => !fallbackNotice.test(note)) : [];
  if (charger.error) notes.push(({ 'charging-adapter-unavailable': 'The charger connection is unavailable.',
    'charging-reconciliation-unavailable': 'The charger schedule could not be confirmed.',
    'charging-planning-unavailable': 'The charging forecast could not be updated.' })[charger.error] ?? human(charger.error));
  if (charger.mqtt?.reason && !['awaiting-mqtt', 'awaiting-subscription'].includes(charger.mqtt.reason)) notes.push(`Vehicle reading unavailable: ${human(charger.mqtt.reason)}.`);
  const controlDetail = !supported ? 'This integration supports monitoring only.'
    : activeManual && manual?.repeating ? 'Turn control off to keep the recurring Easee schedule.'
      : 'ST-MQ chooses the start. Charging may continue beyond the minimum.';
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk,
    soc: socKnown ? number(soc.value, '%') : 'Unknown', socSource: sourceLabel(soc), minimum: number(minimum, '%'),
    minimumSource: sourceLabel(values.minimumSoc), gridEnergy: number(requiredGridKwh, 'kWh'),
    energyNote: requiredGridKwh === 0 ? 'Minimum already met' : 'Includes losses',
    rows, notes: [...new Set(notes)].filter(note => note !== event), yielded: activeManual, supported, controlDetail };
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
    const overview = make('div', '', 'pump-native-overview charging-overview'), metrics = {};
    for (const [key, label] of [['soc', 'Current charge'], ['minimum', 'Minimum'], ['energy', 'Grid to minimum']]) {
      const metric = make('div', '', 'equipment-value'), value = make('strong', 'Unknown', '', `${id}-${key}`), hint = make('small');
      metric.append(make('span', label), value, hint); overview.append(metric); metrics[key] = { value, hint };
    }
    const event = make('p', '', 'charging-event', `${id}-event`); section.append(overview, event);
    const fold = make('details', '', 'equipment-fold charging-settings', `${id}-settings-details`);
    fold.append(make('summary', 'Settings & details'));
    const readings = make('dl', '', 'equipment-readings', `${id}-readings`), notes = make('ul', '', 'charging-notes', `${id}-notes`);
    fold.append(readings, notes);
    const master = make('div', '', 'charging-master'), masterLabel = make('span', 'ST-MQ charging control', '', `${id}-enabled-label`);
    const toggle = make('button', 'OFF', '', `${id}-enabled`); toggle.type = 'button'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false'); toggle.setAttribute('aria-labelledby', masterLabel.id); master.append(masterLabel, toggle);
    const controlDetail = make('p', '', 'muted charging-form-help', `${id}-control-detail`);
    const resume = make('button', 'Resume ST-MQ control', 'secondary-button', `${id}-resume`); resume.type = 'button';
    const controlMessage = make('p', '', 'temporary-status', `${id}-control-message`); controlMessage.setAttribute('role', 'status');
    fold.append(master, controlDetail, resume, controlMessage);
    const form = make('form', '', 'charging-settings-form', `${id}-settings-form`), primaryFields = make('div', '', 'charging-fields');
    const save = make('button', 'Save settings', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, save); fold.append(form, message);
    const settings = group(id, chargingFields, () => primaryFields, form, save, message, `${prefix}/settings`);
    section.append(fold); $('charging-devices')?.append(section);
    const device = { id, section, title, state, event, metrics, readings, notes, settings, toggle, resume, controlDetail, charger };
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
      device.metrics.soc.value.textContent = view.soc; device.metrics.soc.hint.textContent = view.socSource;
      device.metrics.minimum.value.textContent = view.minimum; device.metrics.minimum.hint.textContent = view.minimumSource;
      device.metrics.energy.value.textContent = view.gridEnergy; device.metrics.energy.hint.textContent = view.energyNote;
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
