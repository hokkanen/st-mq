import { isReadOnlyReplica } from './replica-status.js';

const finite = Number.isFinite;
const number = (value, unit = '') => finite(value) ? `${Number(value.toFixed(1))}${unit ? ` ${unit}` : ''}` : 'Unknown';
const human = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const validTime = value => value != null && value !== '' && finite(new Date(value).getTime());
export function chargingTime(value, timezone = 'Europe/Helsinki') {
  if (!validTime(value)) return 'Time unknown';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
  } catch { return new Date(value).toISOString(); }
}
const shortTime = (value, timezone) => {
  if (!validTime(value)) return 'time unknown';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
};
const automatic = field => field?.available === true && !['manual', 'manual-fallback', 'assumed'].includes(field.source);
const sourceLabel = field => {
  if (field?.source === 'manual') return 'Temporary manual value';
  if (field?.source === 'manual-fallback') return 'Manual fallback';
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
  { key: 'minimumSoc', label: 'Minimum charge · %', type: 'number', min: 0, max: 100, step: 1, automatic: true,
    help: 'The vehicle charge target takes priority when available.' },
  { key: 'readyBy', label: 'Ready-by time · local', type: 'time', scheduling: true,
    help: 'ST-MQ plans to reach the minimum by this time. Charging may continue afterwards.' },
  { key: 'capacityKwh', label: 'Usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, automatic: true,
    help: 'Manual fallback when the vehicle does not report usable capacity.' },
  { key: 'efficiency', label: 'Charging efficiency', type: 'number', min: 0.5, max: 1, step: 0.01, advanced: true,
    help: 'Fraction reaching the battery: 0.90 means 90%.' },
  { key: 'mqtt.topic', label: 'Vehicle MQTT topic', nullable: true, advanced: true,
    help: 'Optional additional vehicle telemetry. Leave blank to use the existing integration.' },
  { key: 'mqtt.vehicleId', label: 'Vehicle identity', advanced: true },
  { key: 'mqtt.sourceId', label: 'Telemetry source identity', advanced: true,
    help: 'Identities must match incoming vehicle MQTT readings.' },
].map(field => ({ type: 'text', ...field }));
export const sharedChargingFields = [
  { key: 'timezone', label: 'Local timezone', help: 'For both chargers, for example Europe/Helsinki.' },
  { key: 'readinessMarginMinutes', label: 'Readiness margin · minutes', type: 'number', min: 0, max: 180, step: 1 },
  { key: 'installation.mainFuseA', label: 'Main fuse per phase · A', type: 'number', min: 6, max: 200, step: 0.1, nullable: true,
    help: 'The household fuse rating is needed for reliable planning.' },
  { key: 'installation.chargingAllocationA', label: 'Overall charging allocation per phase · A', type: 'number', min: 6, max: 200, step: 0.1, nullable: true,
    help: 'Optional shared installation limit. Verified provider limits also apply.' },
  { key: 'installation.reserveA', label: 'Planning reserve per phase · A', type: 'number', min: 0, max: 50, step: 0.1 },
  { key: 'installation.otherLoadA', label: 'Fallback household load per phase · A', type: 'number', min: 0, max: 100, step: 0.1,
    help: 'Used when suitable non-charging consumption history is missing.' },
  { key: 'installation.voltageV', label: 'Fallback phase voltage · V', type: 'number', min: 200, max: 250, step: 1 },
].map(field => ({ type: 'text', ...field }));

export function chargerDisplay(charger, { now = Date.now(), timezone = 'Europe/Helsinki' } = {}) {
  const values = charger.values ?? {}, settings = charger.settings ?? {}, control = charger.control ?? {};
  const plan = charger.plan ?? {}, forecast = charger.forecast ?? {}, soc = values.soc ?? {}, manual = control.manual ?? control.manualOverride;
  const time = value => chargingTime(value, timezone), compact = value => shortTime(value, timezone);
  const connected = values.connected?.value, charging = connected === true && values.charging?.value === true;
  const supported = charger.capabilities?.scheduling === true, enabled = supported && settings.enabled === true;
  const phase = control.phase ?? '', yielded = ['yielded', 'manual', 'uncertain', 'ownership-uncertain'].includes(phase) || Boolean(manual);
  const uncertain = ['uncertain', 'ownership-uncertain'].includes(phase) || manual?.kind === 'unknown';
  const handoverUnconfirmed = control.handoverConfirmed === false;
  const released = phase === 'released' || phase === 'charging';
  const finishAt = charging || released ? forecast.finishAt : plan.finishAt ?? forecast.finishAt;
  const ownedStart = ['scheduled', 'waiting', 'confirmed'].includes(phase) && control.confirmed !== false && validTime(control.owned?.startAt)
    ? control.owned.startAt : null;
  const revisionPending = validTime(ownedStart) && validTime(plan.startAt) && new Date(ownedStart).getTime() !== new Date(plan.startAt).getTime();
  const resumeAt = manual?.resumeAt ?? control.resumeAt;
  const nativeStart = values.scheduledStartAt?.value, nativeEnd = values.scheduledEndAt?.value;
  const endKind = charger.scheduledEndKind ?? charger.telemetry?.scheduledEndKind ?? values.scheduledEndAt?.kind;
  const requiredGridKwh = charger.requiredGridKwh ?? plan.requiredGridKwh ?? forecast.requiredGridKwh ?? forecast.gridEnergyKwh;
  const minimum = values.minimumSoc?.value, capacity = values.capacityKwh?.value;
  const socKnown = finite(soc.value) && (soc.available || soc.source === 'manual-fallback');
  let state = connected === false ? 'Not connected' : connected === true ? 'Connected' : 'Connection unknown';
  let event = '', eventAt = null, eventKind = null;
  if (charging) {
    state = 'Charging';
    event = finite(values.powerKw?.value) ? `${number(values.powerKw.value, 'kW')} now` : 'Charging now';
    if (validTime(finishAt)) event += ` · minimum estimated ${compact(finishAt)}`;
  } else if (enabled && yielded) {
    state = uncertain ? 'Ownership uncertain' : 'Manual control';
    event = validTime(resumeAt) ? `ST-MQ resumes ${compact(resumeAt)}` : 'Resume ST-MQ when you are ready';
    eventAt = validTime(resumeAt) ? resumeAt : null; eventKind = 'resume';
  } else if (!enabled && handoverUnconfirmed) {
    state = 'Handover unconfirmed'; event = 'Control is OFF; the previous charger restriction has not been confirmed cleared.';
  } else if (enabled && released) {
    event = 'Charging released · may continue';
  } else if (enabled && validTime(ownedStart ?? plan.startAt)) {
    eventAt = ownedStart ?? plan.startAt; eventKind = ownedStart ? 'confirmed' : 'proposed';
    event = `${ownedStart ? 'Starts' : 'Proposed start'} ${compact(eventAt)}${revisionPending ? ' · revision pending' : ''}`;
  } else if ((connected === true || supported) && validTime(nativeStart) && new Date(nativeStart).getTime() > now) {
    eventAt = nativeStart; eventKind = 'vehicle'; event = `Scheduled ${compact(nativeStart)}`;
  } else if (forecast.state === 'forecast' && validTime(forecast.startAt) && forecast.startAt > now) {
    eventAt = forecast.startAt; eventKind = 'forecast'; event = `Expected ${compact(eventAt)}`;
  } else if (enabled) event = plan.reason === 'installation-limits-unavailable' ? 'Complete the shared charging setup to plan a start' : 'Waiting for a charging plan';
  else event = supported ? 'ST-MQ control OFF' : 'Monitoring · scheduling unavailable';
  const risk = enabled && plan.feasible === false && !yielded;
  if (risk) event += ' · minimum at risk';
  const rows = [
    ['Vehicle connected', connected === true ? 'Yes' : connected === false ? 'No' : 'Unknown'],
    ['Current charge', `${socKnown ? number(soc.value, '%') : 'Unknown'} · ${sourceLabel(soc)}`],
    ['Minimum charge', `${number(minimum, '%')} · ${sourceLabel(values.minimumSoc)}`],
    ['Usable battery capacity', `${number(capacity, 'kWh')} · ${sourceLabel(values.capacityKwh)}`],
    ['Grid energy to minimum', `${number(requiredGridKwh, 'kWh')}${soc.source === 'manual-fallback' ? ' · estimated from manual charge' : soc.assumed ? ' · estimated from assumed charge' : ''}`],
  ];
  if (soc.source === 'manual') {
    rows.push(['Manual value expires', time(soc.expiresAt)]);
    const underlying = charger.automatic?.soc;
    if (underlying?.available) rows.push(['Automatic charge underneath', `${number(underlying.value, '%')} · ${sourceLabel(underlying)} · ${validTime(underlying.measuredAt)
      ? `measured ${time(underlying.measuredAt)}` : `received ${time(underlying.receivedAt)} · measurement time unknown`}`]);
  }
  if (automatic(soc)) {
    if (validTime(soc.measuredAt)) rows.push(['Charge measured', time(soc.measuredAt)]);
    else if (validTime(soc.receivedAt)) rows.push(['Charge received', `${time(soc.receivedAt)} · measurement time unknown`]);
    else rows.push(['Charge measured', 'Time unknown']);
  }
  if (finite(values.currentA?.value)) rows.push(['Available current estimate', `${number(values.currentA.value, 'A per phase')}${charger.capabilities?.externalLoadBalancing ? ' · externally balanced' : ''}`]);
  if (connected !== false && finite(values.actualCurrentA?.value)) rows.push(['Measured charging current', number(values.actualCurrentA.value, 'A per phase')]);
  if (connected !== false && finite(values.powerKw?.value)) rows.push(['Measured charging power', number(values.powerKw.value, 'kW')]);
  if (enabled) rows.push(['Ready by', validTime(plan.deadlineAt ?? charger.deadlineAt) ? time(plan.deadlineAt ?? charger.deadlineAt) : `${settings.readyBy} · ${timezone}`]);
  if (ownedStart) rows.push(['Confirmed start', time(ownedStart)]);
  if (enabled && validTime(plan.startAt) && (!ownedStart || revisionPending)) rows.push([released ? 'Plan start' : 'Proposed start', `${time(plan.startAt)}${revisionPending ? ' · awaiting confirmation' : ''}`]);
  if (validTime(finishAt)) rows.push([revisionPending ? 'Proposed minimum estimate' : 'Estimated minimum reached', `${time(finishAt)} · charging may continue`]);
  if (finite(plan.costCents)) rows.push(['Estimated cost to minimum', `€${(plan.costCents / 100).toFixed(2)} · excludes later charging`]);
  if (validTime(nativeStart)) rows.push(['Charger / vehicle scheduled start', time(nativeStart)]);
  if (validTime(nativeEnd)) rows.push([['enforced', 'scheduled-stop'].includes(endKind) ? 'Scheduled stopping time' : 'Estimated charging end', `${time(nativeEnd)}${['enforced', 'scheduled-stop'].includes(endKind) ? '' : ' · estimate only'}`]);
  if (validTime(manual?.startsAt ?? manual?.startAt)) rows.push(['Manual window begins', time(manual.startsAt ?? manual.startAt)]);
  if (manual?.kind === 'window' && validTime(manual.endAt ?? resumeAt)) rows.push(['Manual stopping time', time(manual.endAt ?? resumeAt)]);
  if (validTime(resumeAt)) rows.push(['Automatic control resumes', `${time(resumeAt)} · after checking the current charger instruction`]);
  if (manual?.repeating) rows.push(['Repeating charger schedule', 'This occurrence is a temporary override. Turn ST-MQ control OFF to keep recurring app control.']);
  if (control.reason && (yielded || phase === 'unavailable' || handoverUnconfirmed)) rows.push(['Control status', human(control.reason)]);
  const notes = [...notices(plan.warnings), ...notices(forecast.warnings)];
  if (soc.source === 'assumed') notes.unshift('No charge reading is available. Planning assumes 0%.');
  if (charger.error) notes.push(({ 'charging-adapter-unavailable': 'The charger connection is unavailable.',
    'charging-reconciliation-unavailable': 'The charger schedule could not be confirmed.',
    'charging-planning-unavailable': 'The charging forecast could not be updated.' })[charger.error] ?? human(charger.error));
  if (charger.mqtt?.reason && !['awaiting-mqtt', 'awaiting-subscription'].includes(charger.mqtt.reason)) notes.push(`Vehicle MQTT: ${human(charger.mqtt.reason)}.`);
  const controlDetail = !supported ? 'This integration supplies readings. Scheduling is not supported.'
    : enabled ? 'ST-MQ chooses a start to meet the minimum. Manual charger actions take temporary priority; charging can continue beyond the minimum.'
      : 'Enable ST-MQ to plan starts around prices, household demand and both chargers.';
  return { id: charger.id, label: charger.label, state, event, eventAt, eventKind, summary: `${state} · ${event}`, risk,
    soc: socKnown ? number(soc.value, '%') : 'Unknown', socSource: sourceLabel(soc), minimum: number(minimum, '%'),
    minimumSource: sourceLabel(values.minimumSoc), gridEnergy: number(requiredGridKwh, 'kWh'),
    energyNote: requiredGridKwh === 0 ? 'Minimum already met' : soc.source === 'manual-fallback' ? 'Based on manual charge' : soc.assumed ? 'Based on assumed charge' : 'Includes charging losses',
    rows, notes: [...new Set(notes)], yielded, supported, controlDetail };
}

export function chargingDisplay(charging, now = Date.now()) {
  return { chargers: (charging?.chargers ?? []).map(charger => chargerDisplay(charger, { now, timezone: charging.settings?.timezone ?? 'Europe/Helsinki' })) };
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
  const shared = $('charging-installation-fields') ? group('charging', sharedChargingFields, () => $('charging-installation-fields'),
    $('charging-installation-form'), $('charging-installation-save'), $('charging-installation-message'), '/api/charging/settings') : null;
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
    const advanced = make('details', '', 'equipment-fold charging-secondary'); advanced.append(make('summary', 'Vehicle connection & assumptions'));
    const advancedFields = make('div', '', 'charging-fields'); advanced.append(advancedFields);
    const save = make('button', 'Save settings', 'secondary-button', `${id}-settings-save`); save.type = 'submit';
    const message = make('p', '', 'temporary-status', `${id}-settings-message`); message.setAttribute('role', 'status');
    form.append(primaryFields, advanced, save); fold.append(form, message);
    const settings = group(id, chargingFields, field => field.advanced ? advancedFields : primaryFields, form, save, message, `${prefix}/settings`);
    const socForm = make('form', '', 'charging-soc-form', `${id}-soc-form`), socLabel = make('label', 'Current charge · manual %');
    const socInput = make('input', '', '', `${id}-manual-soc`); socInput.type = 'number'; socInput.min = 0; socInput.max = 100; socInput.step = 0.1; socInput.required = true;
    socLabel.htmlFor = socInput.id; socLabel.append(socInput);
    const apply = make('button', 'Use manual charge', 'secondary-button', `${id}-soc-apply`); apply.type = 'submit';
    const restore = make('button', 'Use automatic charge', 'secondary-button', `${id}-soc-automatic`); restore.type = 'button';
    const socHelp = make('p', '', 'muted charging-form-help', `${id}-soc-help`); socInput.setAttribute('aria-describedby', socHelp.id);
    socForm.append(socLabel, apply, restore, socHelp);
    const socMessage = make('p', '', 'temporary-status', `${id}-soc-message`); socMessage.setAttribute('role', 'status'); fold.append(socForm, socMessage);
    section.append(fold); $('charging-devices')?.append(section);
    const device = { id, section, title, state, event, metrics, readings, notes, settings, toggle, resume, controlDetail, socInput, apply, restore, socHelp, manualDirty: false, charger };
    bind(toggle, 'click', () => mutate(`${prefix}/settings`, { enabled: !device.charger.settings.enabled }, controlMessage, 'Control preference saved.'));
    bind(resume, 'click', () => mutate(`${prefix}/resume`, {}, controlMessage, 'Automatic control requested.'));
    bind(socInput, 'input', () => { device.manualDirty = true; });
    bind(socForm, 'submit', event => {
      event.preventDefault(); if (socForm.reportValidity && !socForm.reportValidity()) return;
      return mutate(`${prefix}/soc`, { soc: Number(socInput.value) }, socMessage, 'Manual charge saved.', () => { device.manualDirty = false; });
    });
    bind(restore, 'click', () => mutate(`${prefix}/soc`, { action: 'automatic' }, socMessage, 'Automatic charge selected.', () => { device.manualDirty = false; }));
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
      const reading = charger?.values?.[key], live = field.automatic && automatic(reading);
      input.value = (live ? reading.value : group.dirty.has(key) ? group.drafts.get(key) : get(settings, key)) ?? '';
      help.textContent = live ? `${sourceLabel(reading)} supplies this value. Saved fallback: ${get(settings, key)}${key === 'minimumSoc' ? '%' : ' kWh'}.`
        : field.scheduling && !charger?.capabilities?.scheduling ? 'Scheduling is unavailable with this integration.' : field.help ?? '';
      help.hidden = !help.textContent;
    }
  }
  function refreshControls() {
    const locked = busy || !writable();
    for (const device of devices.values()) {
      const { charger, settings } = device, supported = charger.capabilities?.scheduling === true;
      for (const [key, { field, input, label }] of settings.fields) {
        const unsupported = field.scheduling && !supported, live = field.automatic && automatic(charger.values?.[key]);
        input.disabled = locked || unsupported || live; label.classList.toggle('charging-field-disabled', Boolean(unsupported || live));
      }
      settings.save.disabled = locked || ![...settings.fields].some(([key, { input }]) => settings.dirty.has(key) && !input.disabled);
      device.toggle.disabled = locked || !supported;
      device.socInput.disabled = device.apply.disabled = locked;
      device.restore.disabled = locked || charger.values?.soc?.source !== 'manual';
      device.restore.textContent = charger.automatic?.soc?.available ? 'Use automatic charge' : 'End temporary override';
      const view = chargerDisplay(charger);
      device.resume.hidden = !supported || !charger.settings.enabled || !view.yielded;
      device.resume.disabled = locked || device.resume.hidden;
    }
    if (shared) {
      for (const { input } of shared.fields.values()) input.disabled = locked;
      shared.save.disabled = locked || !shared.dirty.size;
    }
  }
  function update(next) {
    status = next;
    const charging = next?.charging;
    const globalError = ({ 'charging-planning-unavailable': 'The shared charging plan could not be updated. The last charger instructions remain in effect.',
      'charging-reconciliation-unavailable': 'The current charging instructions could not be confirmed.' })[charging?.error] ?? (charging?.error ? human(charging.error) : '');
    set('charging-status', globalError); if ($('charging-status')) $('charging-status').hidden = !globalError;
    if (shared) updateFields(shared, charging?.settings ?? {});
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
      list(device.readings, view.rows); device.notes.replaceChildren(...view.notes.map(note => make('li', note))); device.notes.hidden = !view.notes.length;
      device.controlDetail.textContent = view.controlDetail;
      const enabled = charger.settings.enabled === true; device.toggle.textContent = enabled ? 'ON' : 'OFF'; device.toggle.setAttribute('aria-checked', String(enabled));
      updateFields(device.settings, charger.settings, charger);
      if (!device.manualDirty) device.socInput.value = charger.settings.manualSoc ?? 40;
      device.socHelp.textContent = charger.values?.soc?.source === 'manual'
        ? `Manual charge is active until ${chargingTime(charger.values.soc.expiresAt, charging.settings.timezone)}. New automatic readings continue underneath it.`
        : `A manual value overrides automatic readings until the next ${charger.settings.readyBy} ready-by time. When automatic charge is unavailable, a saved manual fallback is used.`;
      set(`${charger.id}-summary`, view.summary); if ($(`${charger.id}-summary`)) $(`${charger.id}-summary`).title = view.summary;
    }
    for (const [id, device] of devices) if (!currentIds.has(id)) { device.section.remove(); devices.delete(id); }
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { for (const remove of listeners) remove(); } };
}
