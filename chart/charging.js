import { isReadOnlyReplica } from './replica-status.js';

const finite = Number.isFinite;
const number = (value, unit = '') => finite(value) ? `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}` : 'Unknown';
const human = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const validTime = value => value != null && value !== '' && finite(new Date(value).getTime());
export function chargingTime(value, timezone = 'Europe/Helsinki') {
  if (!validTime(value)) return 'Time unknown';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
  } catch { return new Date(value).toISOString(); }
}
const shortTime = (value, timezone) => !validTime(value) ? 'time unknown' : new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone || 'Europe/Helsinki', weekday: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));

// These first-use values are UI defaults. Saved settings supplied by the server
// remain authoritative, and editing one field only submits that field.
export const chargingFields = [
  { key: 'minimumSoc', root: 'charger1-readiness-fields', label: 'Minimum charge · %', type: 'number', min: 0, max: 100, step: 1, value: 80, scheduling: true },
  { key: 'readyBy', root: 'charger1-readiness-fields', label: 'Ready-by time · local', type: 'time', value: '06:00', scheduling: true },
  { key: 'capacity1Kwh', root: 'charger1-readiness-fields', label: 'Vehicle usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, value: 74 },
  { key: 'readinessMarginMinutes', root: 'charger1-readiness-fields', label: 'Readiness margin · minutes', type: 'number', min: 0, max: 180, step: 1, value: 15, scheduling: true },
  { key: 'timezone', label: 'Local timezone', value: 'Europe/Helsinki', help: 'IANA timezone, for example Europe/Helsinki.' },
  { key: 'mqttTopic', label: 'Charger 1 MQTT topic', value: 'stmq/garage/charger1/vehicle' },
  { key: 'vehicleId', label: 'Charger 1 vehicle identity', value: 'charger1-vehicle', help: 'Must match vehicleId in incoming readings.' },
  { key: 'sourceId', label: 'Charger 1 telemetry source identity', value: 'vehicle-telemetry', help: 'Must match sourceId in incoming readings.' },
  { key: 'efficiency1', label: 'Charger 1 charging efficiency', type: 'number', min: 0.5, max: 1, step: 0.01, value: 0.9, help: 'Fraction reaching the battery: 0.90 means 90%.' },
  { key: 'installation.mainFuseA', label: 'Main fuse per phase · A', type: 'number', min: 6, max: 200, step: 0.1, value: null, nullable: true,
    placeholder: 'Enter installation value', help: 'Enter the actual household main-fuse rating for reliable forecasting. Easee does not supply a verified value.' },
  { key: 'installation.chargingAllocationA', label: 'Overall charging allocation per phase · A', type: 'number', min: 6, max: 200, step: 0.1, value: null, nullable: true },
  { key: 'installation.circuitA', label: 'Charging circuit per phase · A', type: 'number', min: 6, max: 200, step: 0.1, value: null, nullable: true },
  { key: 'installation.charger1MaxA', label: 'Charger 1 maximum current per phase · A', type: 'number', min: 6, max: 80, step: 1, value: 16, help: 'Use the lowest applicable charger, cable and vehicle limit.' },
  { key: 'installation.minChargingA', label: 'Minimum charging current per phase · A', type: 'number', min: 6, max: 32, step: 0.1, value: 6 },
  { key: 'installation.voltageV', label: 'Phase-to-neutral voltage · V', type: 'number', min: 200, max: 250, step: 1, value: 230 },
  { key: 'installation.reserveA', label: 'Planning reserve per phase · A', type: 'number', min: 0, max: 50, step: 0.1, value: 2 },
  { key: 'installation.otherLoadA', label: 'Fallback non-charger load per phase · A', type: 'number', min: 0, max: 100, step: 0.1, value: 6, help: 'Conservative household load when suitable history is missing.' },
  { key: 'capacity2Kwh', root: 'charger2-settings-fields', label: 'Vehicle usable battery capacity · kWh', type: 'number', min: 1, max: 300, step: 0.1, value: 57 },
  { key: 'efficiency2', root: 'charger2-settings-fields', label: 'Charger 2 charging efficiency', type: 'number', min: 0.5, max: 1, step: 0.01, value: 0.9 },
  { key: 'installation.charger2MaxA', root: 'charger2-settings-fields', label: 'Charger 2 installation maximum per phase · A', type: 'number', min: 6, max: 80, step: 0.1, value: 16, help: 'An installation constraint. The selected charging current comes from TeslaMate.' },
].map(field => ({ root: 'charger1-planning-fields', type: 'text', ...field }));

const fieldId = key => `charging-setting-${key.replaceAll('.', '-')}`;
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function assign(object, path, value) {
  const keys = path.split('.'), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
}
const warnings = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => human(item?.message ?? item?.reason ?? item));

export function chargingDisplay(charging, now = Date.now()) {
  const settings = charging?.settings ?? {}, control = charging?.control ?? {}, plan = charging?.plan ?? {};
  const timezone = settings.timezone ?? 'Europe/Helsinki', time = value => chargingTime(value, timezone);
  const compact = value => shortTime(value, timezone), soc = charging?.soc ?? {}, forecast = charging?.charger2 ?? {};
  const controlState = control.phase ?? control.state ?? control.status ?? '';
  const yielded = ['yielded', 'manual', 'uncertain', 'manual-override', 'ownership-uncertain'].includes(controlState)
    || Boolean(control.manualOverride ?? control.manual);
  const released = ['released', 'charging'].includes(controlState);
  const ownedStartAt = control.owned?.startAt;
  const hasConfirmedStart = ['scheduled', 'waiting', 'confirmed'].includes(controlState)
    && control.confirmed !== false && validTime(ownedStartAt);
  const confirmed = hasConfirmedStart && validTime(plan.startAt)
    && new Date(ownedStartAt).getTime() === new Date(plan.startAt).getTime();
  const revisionPending = hasConfirmedStart && validTime(plan.startAt) && !confirmed;
  const handoverUnconfirmed = control.handoverConfirmed === false || control.handoverUnconfirmed === true
    || controlState === 'handover-unconfirmed';
  const resumeAt = control.resumeAt ?? control.manualOverride?.resumeAt ?? control.manual?.resumeAt;
  let summary1 = settings.enabled ? 'Awaiting charging plan' : 'Control OFF';
  if (!settings.enabled && handoverUnconfirmed) summary1 += ' · handover unconfirmed';
  else if (settings.enabled && yielded) summary1 = `${['uncertain', 'ownership-uncertain'].includes(controlState) || control.manual?.kind === 'unknown' ? 'Ownership uncertain' : 'Manual control'}${validTime(resumeAt) ? ` · resumes ${compact(resumeAt)}` : ' · automatic control yielded'}`;
  else if (settings.enabled && released) summary1 = 'Charging released · may continue';
  else if (settings.enabled && hasConfirmedStart) summary1 = `Starts ${compact(ownedStartAt)}${revisionPending ? ' · revision pending' : soc.assumed ? ' · assumes 0%' : ''}`;
  else if (settings.enabled && validTime(plan.startAt)) summary1 = `${confirmed ? 'Starts' : 'Proposed start'} ${compact(plan.startAt)}${soc.assumed ? ' · assumes 0%' : ''}`;
  if (settings.enabled && plan.feasible === false && !yielded) summary1 += ' · minimum at risk';
  let summary2 = forecast.state === 'none' ? 'No home charging expected · read-only' : 'Forecast uncertain · read-only';
  if (forecast.state === 'forecast') summary2 = `${forecast.startAt <= now && forecast.endAt > now ? 'Expected now' : `Expected ${compact(forecast.startAt)}`} · ${number(forecast.currentA, 'A')} · read-only`;
  const primarySoc = soc.assumed ? 'Unknown · planning assumes 0%' : finite(soc.soc) ? `${number(soc.soc, '%')} · ${soc.source === 'manual' ? 'manual' : 'MQTT'}` : 'Unknown · planning assumes 0%';
  const rows1 = [['Current charge', primarySoc]];
  if (charging?.mqtt) {
    const mqtt = charging.mqtt;
    rows1.push(['Vehicle MQTT', typeof mqtt.connected !== 'boolean' ? 'Live MQTT status unavailable in this snapshot'
      : `${mqtt.connected ? 'Connected' : 'Disconnected'} · ${mqtt.subscribed ? 'subscribed' : 'not subscribed'}`]);
    const mqttReasons = { 'awaiting-mqtt': 'Waiting for the MQTT connection', 'awaiting-subscription': 'Waiting for topic subscription',
      'mqtt-subscription-failed': 'Topic subscription failed', 'mqtt-disconnected': 'MQTT connection lost',
      'malformed-json': 'Reading rejected: malformed JSON', 'invalid-payload': 'Reading rejected: invalid payload',
      'invalid-soc': 'Reading rejected: charge must be between 0% and 100%', 'identity-mismatch': 'Reading rejected: vehicle or source identity does not match',
      'missing-reading-id': 'Reading rejected: reading identifier missing', 'invalid-measurement-time': 'Reading rejected: invalid measurement time',
      'invalid-sequence': 'Reading rejected: invalid sequence number' };
    if (mqtt.reason) rows1.push(['MQTT status', mqttReasons[mqtt.reason] ?? human(mqtt.reason)]);
  }
  if (charging?.error) {
    const errors = { 'charging-adapter-unavailable': 'Easee connection is unavailable',
      'charging-reconciliation-unavailable': 'Could not reconcile the current Easee schedule',
      'charging-planning-unavailable': 'Could not update the charging forecast' };
    rows1.push(['Charging error', errors[charging.error] ?? human(charging.error)]);
  }
  if (finite(control.snapshot?.powerKw)) rows1.push(['Live charging power', number(control.snapshot.powerKw, 'kW')]);
  if (typeof control.snapshot?.pluggedIn === 'boolean') rows1.push(['Vehicle connected', control.snapshot.pluggedIn ? 'Yes' : 'No']);
  if (validTime(control.lastReadAt)) rows1.push(['Easee state checked', time(control.lastReadAt)]);
  if (soc.source === 'manual') rows1.push(['Manual value entered', time(soc.enteredAt ?? soc.measuredAt)], ['Manual value expires', time(soc.expiresAt)]);
  else if (!soc.assumed && finite(soc.soc)) rows1.push(['Measured', time(soc.measuredAt)]);
  const automatic = charging?.automaticSoc;
  if (automatic && soc.source === 'manual') rows1.push(['Latest MQTT charge', `${number(automatic.soc, '%')} · measured ${time(automatic.measuredAt)}`]);
  if (automatic || soc.source === 'mqtt') rows1.push(['MQTT reading policy', 'Valid readings remain usable regardless of age. Measurement time is preserved.']);
  if (settings.enabled || plan.deadlineAt) {
    rows1.push(['Minimum requested charge', `${number(settings.minimumSoc ?? 80, '%')} by ${validTime(plan.deadlineAt) ? time(plan.deadlineAt) : `${settings.readyBy ?? '06:00'} · ${timezone}`}`]);
    if (hasConfirmedStart) rows1.push(['Confirmed start', time(ownedStartAt)]);
    if (validTime(plan.startAt) && !confirmed) rows1.push([released ? 'Plan start' : 'Proposed start', `${time(plan.startAt)}${revisionPending ? ' · pending Easee confirmation' : ''}`]);
    if (validTime(plan.finishAt)) rows1.push([revisionPending ? 'Proposed minimum estimate' : 'Estimated minimum reached', `${time(plan.finishAt)} · charging may continue`]);
    if (finite(plan.requiredGridKwh)) rows1.push(['Grid energy to minimum', number(plan.requiredGridKwh, 'kWh')]);
    if (finite(plan.costCents)) rows1.push(['Estimated cost to minimum', `€${(plan.costCents / 100).toFixed(2)} · excludes later charging`]);
  }
  const manual = control.manualOverride ?? control.manual;
  if (manual?.startsAt ?? manual?.startAt) rows1.push(['Manual window begins', time(manual.startsAt ?? manual.startAt)]);
  if (manual?.endAt ?? (manual?.kind === 'window' && resumeAt)) rows1.push(['Manual stopping time', time(manual.endAt ?? resumeAt)]);
  if (resumeAt) rows1.push(['Automatic control resumes', `${time(resumeAt)} · after checking the current Easee instruction`]);
  if (manual?.repeating) rows1.push(['Repeating Easee window', 'The current or next occurrence is a temporary override. Turn ST-MQ charging control OFF for permanent recurring app control.']);
  const cautions1 = warnings(plan.warnings);
  if (plan.feasible === false) cautions1.unshift('The minimum may not be reached by the deadline.');
  const planReasons = { 'automatic-control-disabled': 'Automatic control is OFF', 'minimum-already-satisfied': 'Minimum already met; charging may still start at a cheap slot',
    'cheapest-feasible-start': 'Economical start expected to meet the minimum', 'insufficient-time': 'Insufficient charging time',
    'installation-limits-unavailable': 'Installation limits need verification', 'price-coverage-unavailable': 'Electricity prices are incomplete' };
  if (plan.reason) rows1.push(['Planning status', planReasons[plan.reason] ?? human(plan.reason)]);
  const selectedCurrent = forecast.metadata?.charge_current_request?.value;
  const rows2 = [['Forecast', summary2], ['Selected charging current', number(selectedCurrent, 'A per phase')],
    ['Current used in forecast', number(forecast.currentA, 'A per phase')],
    ['Phases used in forecast', Array.isArray(forecast.phaseCurrentA) ? `${forecast.phaseCurrentA.filter(value => value > 0).length} · ${forecast.phaseCurrentA.map(value => number(value, 'A')).join(' / ')}` : 'Unknown']];
  const uncertainInterval = forecast.reason === 'conservative-load-reservation';
  if (validTime(forecast.startAt)) rows2.push([uncertainInterval ? 'Possible load from' : 'Expected start', time(forecast.startAt)]);
  if (validTime(forecast.endAt)) rows2.push([uncertainInterval ? 'Possible load until' : 'Estimated end', `${time(forecast.endAt)} · forecast only`]);
  if (finite(forecast.powerKw)) rows2.push(['Expected charging power', number(forecast.powerKw, 'kW')]);
  if (finite(forecast.gridEnergyKwh)) rows2.push(['Estimated grid energy', number(forecast.gridEnergyKwh, 'kWh')]);
  const telemetryLabels = { battery_level: 'Current charge', charge_limit_soc: 'Vehicle charge limit', charge_current_request: 'Selected current reported',
    charge_current_request_max: 'Vehicle current maximum', charger_phases: 'Reported phases', charger_voltage: 'Reported voltage',
    charger_power: 'Measured charging power', scheduled_charging_start_time: 'Vehicle scheduled start', plugged_in: 'Vehicle plugged in',
    geofence: 'Vehicle location', charging_state: 'Vehicle charging state', state: 'Vehicle state' };
  const telemetryUnits = { battery_level: '%', charge_limit_soc: '%', charge_current_request: 'A', charge_current_request_max: 'A', charger_voltage: 'V', charger_power: 'kW' };
  for (const [key, observation] of Object.entries(forecast.metadata ?? {})) {
    if (!observation || typeof observation !== 'object') continue;
    const value = observation.value == null ? 'Unknown' : key === 'scheduled_charging_start_time' ? time(observation.value)
      : finite(observation.value) ? number(observation.value, telemetryUnits[key]) : human(observation.value);
    const measuredAt = observation.measuredAt ?? observation.sourceTime;
    rows2.push([telemetryLabels[key] ?? human(key), `${value} · ${validTime(measuredAt) ? `measured ${time(measuredAt)}`
      : `received ${time(observation.receivedAt ?? observation.at)} · measurement time unknown`}${observation.retained ? ' · retained' : ''}`]);
  }
  const detail = control.reason === 'easee-unavailable' ? 'Easee charging control is unavailable.' : control.reason ?? control.message ?? (settings.enabled
    ? 'ST-MQ plans a delayed start. An estimated finishing time never stops automatic charging.'
    : handoverUnconfirmed ? 'Control is OFF. Charger handover has not been confirmed.' : 'Control is OFF. Charging telemetry remains available.');
  return { summary1, summary2, rows1, rows2, notes1: [...new Set(cautions1)], notes2: warnings(forecast.warnings),
    controlDetail: detail, yielded, handoverUnconfirmed };
}

export function chargingContext(charging, now = Date.now()) {
  if (!charging) return '';
  const view = chargingDisplay(charging, now), parts = [];
  if (charging.settings?.enabled && validTime(charging.plan?.startAt)) parts.push(`Charger 1: ${view.summary1}.`);
  if (charging.charger2?.state === 'forecast') parts.push(`Charger 2: ${view.summary2}.`);
  return parts.join(' ');
}

export function createChargingPanel({ document, request, beforeRequest = () => {}, onStatus = () => {}, afterRequest = () => {} }) {
  const $ = id => document.getElementById(id), fields = new Map(), dirty = new Set(), listeners = [];
  let status, busy = false, manualDirty = false;
  const bind = (node, event, action) => { if (!node) return; node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action)); };
  const writable = () => Boolean(status?.charging && status.readOnly !== true && !isReadOnlyReplica(status));
  const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  function list(id, rows) {
    const root = $(id); if (!root) return;
    const fragment = document.createDocumentFragment();
    for (const [title, value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = title; dd.textContent = value; fragment.append(dt, dd);
    }
    root.replaceChildren(fragment);
  }
  function notes(charger, values) {
    const root = $(`charger${charger}-notes`), fold = $(`charger${charger}-notes-details`); if (!root || !fold) return;
    fold.hidden = !values.length; const fragment = document.createDocumentFragment();
    for (const value of values) { const item = document.createElement('li'); item.textContent = value; fragment.append(item); }
    root.replaceChildren(fragment);
  }
  for (const field of chargingFields) {
    const root = $(field.root); if (!root) continue;
    const label = document.createElement('label'), input = document.createElement('input');
    label.textContent = field.label; input.id = fieldId(field.key); input.type = field.type;
    input.value = field.value ?? ''; input.disabled = true; input.required = !field.nullable;
    for (const key of ['min', 'max', 'step']) if (field[key] !== undefined) input[key] = field[key];
    if (field.nullable) input.placeholder = field.placeholder ?? 'Read from Easee';
    label.htmlFor = input.id; label.append(input);
    if (field.help) { const help = document.createElement('small'); help.id = `${input.id}-help`; help.textContent = field.help; label.append(help); input.setAttribute('aria-describedby', help.id); }
    root.append(label); fields.set(field.key, input);
    bind(input, 'input', () => { dirty.add(field.key); refreshControls(); });
  }
  function refreshControls() {
    const locked = busy || !writable(), enabled = status?.charging?.settings?.enabled === true;
    for (const field of chargingFields) {
      const input = fields.get(field.key); if (!input) continue;
      input.disabled = locked || Boolean(field.scheduling && !enabled);
      input.parentElement?.classList.toggle('charging-field-disabled', Boolean(field.scheduling && !enabled));
    }
    for (const id of ['charging-enabled', 'charging-manual-soc', 'charging-soc-apply']) if ($(id)) $(id).disabled = locked;
    const view = chargingDisplay(status?.charging, status?.now);
    if ($('charging-soc-automatic')) $('charging-soc-automatic').disabled = locked || status?.charging?.soc?.source !== 'manual';
    if ($('charging-resume')) { $('charging-resume').hidden = !enabled || !view.yielded; $('charging-resume').disabled = locked || !enabled || !view.yielded; }
    for (const charger of [1, 2]) if ($(`charger${charger}-settings-save`)) $(`charger${charger}-settings-save`).disabled = locked
      || !chargingFields.some(field => (field.root === 'charger2-settings-fields' ? 2 : 1) === charger && dirty.has(field.key) && !fields.get(field.key)?.disabled);
  }
  async function mutate(path, payload, messageId, success, saved = []) {
    if (busy || !writable()) return;
    busy = true; set(messageId, 'Saving…'); $(messageId)?.classList.remove('form-error'); refreshControls();
    try {
      beforeRequest(); const result = await request(path, payload);
      for (const key of saved) dirty.delete(key);
      if (path === '/api/charging/soc') manualDirty = false;
      update(result); onStatus(result); set(messageId, success);
    } catch (error) { set(messageId, error.message ?? 'Could not save charging settings.'); $(messageId)?.classList.add('form-error'); }
    finally { busy = false; refreshControls(); afterRequest(); }
  }
  for (const charger of [1, 2]) bind($(`charger${charger}-settings-form`), 'submit', event => {
    event.preventDefault(); const form = $(`charger${charger}-settings-form`); if (form?.reportValidity && !form.reportValidity()) return;
    const payload = {}, saved = [];
    for (const field of chargingFields) {
      const input = fields.get(field.key);
      if ((field.root === 'charger2-settings-fields' ? 2 : 1) !== charger || !dirty.has(field.key) || !input || input.disabled) continue;
      assign(payload, field.key, field.type === 'number' ? input.value === '' && field.nullable ? null : Number(input.value) : input.value.trim()); saved.push(field.key);
    }
    if (saved.length) return mutate('/api/charging/settings', payload, `charger${charger}-settings-message`, 'Settings saved.', saved);
  });
  bind($('charging-enabled'), 'click', () => mutate('/api/charging/settings', { enabled: !status?.charging?.settings?.enabled }, 'charging-control-message', 'Charging control preference saved. See the current charger status above.'));
  bind($('charging-manual-soc'), 'input', () => { manualDirty = true; });
  bind($('charging-soc-form'), 'submit', event => {
    event.preventDefault(); const form = $('charging-soc-form'); if (form?.reportValidity && !form.reportValidity()) return;
    return mutate('/api/charging/soc', { soc: Number($('charging-manual-soc').value) }, 'charging-soc-message', 'Manual charge saved until the expiration shown above.');
  });
  bind($('charging-soc-automatic'), 'click', () => mutate('/api/charging/soc', { action: 'automatic' }, 'charging-soc-message', 'Returned to MQTT. Without a valid reading, planning assumes 0%.'));
  bind($('charging-resume'), 'click', () => mutate('/api/charging/resume', {}, 'charging-control-message', 'Automatic control requested. Check the current charger status above.'));
  function update(next) {
    status = next;
    const charging = next?.charging, settings = charging?.settings ?? {}, view = chargingDisplay(charging, next?.now);
    for (const field of chargingFields) {
      const input = fields.get(field.key); if (input && !dirty.has(field.key)) input.value = get(settings, field.key) ?? field.value ?? '';
    }
    if (!manualDirty && $('charging-manual-soc')) $('charging-manual-soc').value = settings.manualSoc ?? 40;
    const toggle = $('charging-enabled'); if (toggle) { toggle.setAttribute('aria-checked', String(settings.enabled === true)); toggle.textContent = settings.enabled ? 'ON' : 'OFF'; }
    set('charger1-summary', view.summary1); set('charger2-summary', view.summary2); set('charger1-control-state', view.summary1);
    set('charging-control-detail', view.controlDetail); list('charger1-readings', view.rows1); list('charger2-readings', view.rows2);
    notes(1, view.notes1); notes(2, view.notes2);
    for (const [id, text] of [['charger1-summary', view.summary1], ['charger2-summary', view.summary2]]) if ($(id)) $(id).title = text;
    refreshControls();
  }
  refreshControls();
  return { update, refreshControls, close() { for (const remove of listeners) remove(); } };
}
