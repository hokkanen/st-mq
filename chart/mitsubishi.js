import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';

export const mitsubishiSettings = Object.freeze({
  power: { label: 'Power', description: 'Native pump power setting.' },
  mode: { label: 'Operating mode', description: 'Mode selected on the heat pump.' },
  targetC: { label: 'Room setting', unit: '°C', description: 'Pump thermostat setting; separate from measured room temperature.' },
  fan: { label: 'Fan setting', description: 'Requested indoor fan setting; actual fan operation may differ.' },
  vane: { label: 'Vertical vane', description: 'Up/down airflow setting.' },
  wideVane: { label: 'Horizontal vane', description: 'Left/right airflow setting.' },
});
const telemetryMetadata = {
  indoorTemperature: ['Pump control temperature', 'Temperatures', '°C', 'Temperature used by the pump’s thermostat.', 'The pump may use its internal sensor or a supplied external temperature, including an offset. This is not necessarily measured room air.'],
  outdoorTemperature: ['Pump outdoor temperature', 'Temperatures', '°C', 'Temperature reported by the outdoor unit.'],
  power: ['Electrical input', 'Electricity', 'W', 'Native electrical input; accuracy remains unverified unless checked.'],
  energy: ['Cumulative energy', 'Electricity', 'kWh', 'Decoded native cumulative electricity reading.'],
  energyCounterRaw: ['Raw energy counter', 'Electricity', '', 'Raw counter; no energy unit or consumption is inferred.'],
  compressorActive: ['Compressor state', 'Operation', '', 'Reported compressor activity; separate from the power setting.'],
  compressorFrequency: ['Compressor frequency', 'Operation', 'Hz', 'Reported compressor frequency; not measured electrical power.'],
  defrost: ['Defrost', 'Operation', '', 'Native defrost indication.'],
  actualFan: ['Actual fan', 'Operation', '', 'Reported fan operation; separate from the selected fan setting.'],
  preheat: ['Preheat', 'Operation', '', 'Native preheat indication.'],
  standby: ['Standby', 'Operation', '', 'Native standby indication.'],
  faultRaw: ['Raw fault bytes', 'Operation', '', 'Uninterpreted native diagnostic bytes; this is not a fault diagnosis.'],
};
const aliases = {
  garage_native_indoor_temperature: 'indoorTemperature', garage_native_outdoor_temperature: 'outdoorTemperature',
  garage_power: 'power', garage_native_energy: 'energy', garage_compressor_frequency: 'compressorFrequency',
  garage_compressor_active: 'compressorActive', garage_native_defrost: 'defrost',
  garage_native_energy_raw: 'energyCounterRaw', garage_native_actual_fan: 'actualFan',
  garage_native_preheat: 'preheat', garage_native_standby: 'standby', garage_native_fault_raw: 'faultRaw',
};
const words = value => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());
const clock = at => Number.isFinite(at) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at) : null;
const scalar = value => typeof value === 'boolean' || typeof value === 'string' && value.length > 0 || Number.isFinite(value);
export function mitsubishiValue(setting, value, unit = mitsubishiSettings[setting]?.unit ?? '') {
  if (setting === 'compressorActive') return typeof value === 'boolean' ? value ? 'Running' : 'Idle' : 'Unavailable';
  if (!scalar(value)) return 'Unavailable';
  const formatted = typeof value === 'boolean' ? value ? 'Yes' : 'No'
    : Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value) : words(value);
  return `${formatted}${unit && unit !== 'boolean' && unit !== 'raw' ? ` ${unit === 'degC' ? '°C' : unit}` : ''}`;
}

/** A saved room target and its current control basis are separate from pump readback. */
export function mitsubishiRoomTemperature(garage = {}) {
  const control = garage.roomTemperature;
  if (!Number.isFinite(control?.targetC)) return null;
  const active = control.phase === 'active' && control.acknowledged === true;
  const basis = active ? 'Garage rear · active'
    : control.phase === 'preparing' || control.phase === 'active' ? 'External sensor · preparing'
      : control.phase === 'clearing' ? 'External sensor · clearing' : 'External sensor · fallback';
  const nativeTarget = mitsubishiValue('targetC', control.nativeTargetC ?? 17);
  const progress = active ? 'Garage rear control is active.'
    : control.phase === 'preparing' || control.phase === 'active' ? 'Waiting for the pump to confirm Garage rear control.'
      : control.phase === 'clearing' ? 'Returning to the pump’s internal sensor.'
        : 'External temperature control is unavailable.';
  const detail = [`Saved room setting: ${mitsubishiValue('targetC', control.targetC)}. ${progress}`,
    `Garage rear is the room sensor. External control uses a native pump target of ${nativeTarget}; the controller adds ${mitsubishiValue('targetC', control.offsetC)} to the rear reading to obtain the lower room setting.`,
    `Garage rear: ${mitsubishiValue('targetC', control.sourceC)}.${clock(control.measuredAt) ? ` Measured ${clock(control.measuredAt)}.` : ''} Supplied temperature: ${mitsubishiValue('targetC', control.suppliedC)}.`,
    control.reason ? `Control status: ${words(control.reason)}.` : '',
    control.phase === 'clearing' ? 'Waiting for internal-sensor acknowledgement before the next control step.'
      : !active && control.phase !== 'preparing' && control.phase !== 'active' ? 'The driver returns to its internal temperature sensor when the current permission expires.' : '',
    `Before enabling or renewing external control, the controller confirms fresh pump readings show ON, HEAT and ${nativeTarget}. If that check fails, renewals stop and the current permission expires. Internal temperature control then uses the pump's current settings.`,
    `Missing or stale sensor readings also stop external control. A room setting of 16 °C or higher, or another heat-pump setting change, ends external temperature control.`].filter(Boolean).join('\n\n');
  return { value: mitsubishiValue('targetC', control.targetC), basis, detail, active, progress };
}

export const mitsubishiTemperatureControlHelp = 'Below 16 °C, Garage rear is the room sensor. The pump stays set to 17 °C, and an offset is added to the supplied temperature to maintain your lower room setting. Settings of 16 °C or higher use normal pump control.\n\nExternal control requires fresh sensor readings and confirmed pump settings: power on, heating mode and 17 °C. If these checks fail, renewals stop; the pump returns to its internal sensor when the current permission expires. Changing another pump setting also ends external temperature control.';

/** Present reported settings and diagnostic measurements without promoting
 * provisional telemetry to control evidence or interpreting raw units. */
function mitsubishiReadingCandidates(garage = {}, now = Date.now()) {
  const adapter = garage.adapter ?? {}, native = adapter.native ?? {}, readbacks = native.readbacks ?? {};
  const connected = adapter.connected === true && adapter.health?.deviceOnline !== false && adapter.health?.pumpCommunicating !== false;
  const rows = [];
  const add = (key, label, group, unit, description, reading, value, nativeSetting) => {
    const at = reading?.measuredAt ?? reading?.sourceTime ?? (key === 'power' && nativeSetting ? native.powerAt : null);
    const quality = Array.isArray(reading?.quality) ? reading.quality : reading?.quality ? [reading.quality] : [];
    const supported = reading?.supported !== false;
    const fresh = connected && Number.isFinite(at) && at <= now && now - at < 120_000
      && reading?.stale !== true && !quality.some(value => /stale|invalid|unavailable|unsupported|unknown|sentinel/i.test(value));
    const valid = scalar(value) && (key !== 'compressorActive' || typeof value === 'boolean');
    const observed = supported && valid && Number.isFinite(at) && at <= now
      && !quality.some(flag => /unknown|unsupported|invalid|sentinel|units-unverified/i.test(flag));
    const available = observed && fresh && !quality.includes('retained')
      && reading?.available !== false && (!nativeSetting || reading?.usable !== false);
    const last = mitsubishiValue(key, value, unit);
    const qualifier = !supported ? 'Unsupported' : !scalar(value) ? 'No reading' : !valid ? 'Invalid reading'
      : !fresh ? 'Stale or unavailable' : !available ? 'Unavailable' : nativeSetting ? 'Native readback'
        : reading?.accuracyVerified === true ? 'Verified' : 'Provisional';
    const detail = [description, !supported ? 'This reading is unsupported or its meaning is not established.' : '',
      !valid ? 'No usable value has been reported.' : !available ? `Current value unavailable. Last reported: ${last}.`
        : `Reported: ${last}.`, at != null && clock(at) ? `Measured ${clock(at)}.` : 'Measurement time unavailable.',
    Number.isFinite(reading?.receivedAt) ? `Received ${clock(reading.receivedAt)}.` : '',
    quality.length ? `Quality: ${quality.map(words).join(', ')}.` : '',
    !nativeSetting && scalar(value) ? reading?.accuracyVerified === true ? 'Measurement accuracy verified.'
      : 'Measurement accuracy has not been verified.' : '',
    reading?.usable === false ? 'Not qualified as control or metering evidence.' : ''].filter(Boolean).join('\n\n');
    rows.push({ key: `${nativeSetting ? 'native' : 'telemetry'}-${key}`, label, group, description,
      value: available ? last : 'Unavailable', available, observed, qualifier, detail });
  };
  for (const key of new Set([...Object.keys(mitsubishiSettings), ...Object.keys(readbacks)])) {
    const meta = mitsubishiSettings[key] ?? { label: words(key), description: 'Additional setting reported by the heat pump.' };
    const reading = readbacks[key] ?? (native[key] && typeof native[key] === 'object' ? native[key] : {});
    const value = reading.value ?? native[key];
    add(key, meta.label, 'Pump settings', meta.unit, meta.description, reading, value, true);
  }
  const telemetry = adapter.telemetry ?? {}, fields = new Map();
  for (const [signal, reading] of Object.entries(telemetry)) {
    const key = aliases[signal] ?? signal;
    if (!fields.get(key) || Object.hasOwn(telemetryMetadata, signal)) fields.set(key, reading);
  }
  for (const key of new Set([...Object.keys(telemetryMetadata), ...fields.keys()])) {
    const reading = fields.get(key);
    const [label, group, unit, description, explanation] = telemetryMetadata[key] ?? [words(key), 'Other readings', reading?.unit ?? '', 'Additional diagnostic reported by the heat pump.'];
    add(key, label, group, unit, description, reading ? { ...reading, supported: reading.supported === true } : undefined, reading?.value, false);
    if (explanation) rows.at(-1).detail = `${explanation}\n\n${rows.at(-1).detail}`;
  }
  const groups = ['Operation', 'Temperatures', 'Electricity', 'Pump settings', 'Other readings'];
  return rows.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
}

export function mitsubishiReadings(garage = {}, now = Date.now()) {
  return mitsubishiReadingCandidates(garage, now).filter(row => row.observed);
}

/** Remember which fields this view has actually seen, not assumed capabilities.
 * Old values are only used in explanations; they never become current readings. */
export function createMitsubishiReadingView() {
  const seen = new Map();
  return (garage, now = Date.now()) => {
    const candidates = mitsubishiReadingCandidates(garage, now);
    const current = new Map(candidates.map(row => [row.key, row]));
    for (const row of candidates) if (row.observed) seen.set(row.key, row);
    const groups = ['Operation', 'Temperatures', 'Electricity', 'Pump settings', 'Other readings'];
    return [...seen.values()].map(previous => {
      const row = current.get(previous.key);
      if (row?.observed) return row;
      return { ...previous, ...row, value: 'Unavailable', available: false,
        qualifier: row?.qualifier ?? 'No reading',
        detail: `${row?.detail ?? 'No current report received.'}\n\nLast valid report:\n${previous.detail}` };
    }).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
  };
}

export function mitsubishiCompressor(garage = {}, now = Date.now()) {
  const reading = mitsubishiReadingCandidates(garage, now).find(row => row.key === 'telemetry-compressorActive');
  return { ...reading, value: reading.available ? reading.value : 'Unknown' };
}

const readingViews = new WeakMap();
export function renderMitsubishiReadings(document, status) {
  const root = document.getElementById('garage-native-readings');
  if (!root) return;
  if (!readingViews.has(root)) readingViews.set(root, createMitsubishiReadingView());
  const rows = readingViews.get(root)(status?.garage, status?.now), groups = [...new Set(rows.map(row => row.group))];
  const fold = document.getElementById('garage-readings-details');
  if (fold) fold.hidden = !rows.length;
  for (const table of [...root.children]) if (!groups.includes(table.dataset.group)) table.remove();
  for (const [groupIndex, group] of groups.entries()) {
    let table = [...root.children].find(node => node.dataset.group === group);
    if (!table) {
      table = document.createElement('table'); table.className = 'h66-table mitsubishi-table'; table.dataset.group = group;
      const caption = document.createElement('caption'); caption.textContent = group;
      table.append(caption, document.createElement('tbody')); root.append(table);
    }
    if (root.children[groupIndex] !== table) root.insertBefore(table, root.children[groupIndex] ?? null);
    const body = table.querySelector('tbody'), readings = rows.filter(row => row.group === group);
    for (const row of [...body.children]) if (!readings.some(reading => reading.key === row.dataset.reading)) row.remove();
    for (const [index, reading] of readings.entries()) {
      let row = [...body.children].find(node => node.dataset.reading === reading.key);
      if (!row) {
        row = document.createElement('tr'); row.dataset.reading = reading.key;
        const title = document.createElement('th'); title.scope = 'row';
        const description = document.createElement('small'); description.className = 'h66-reading-description';
        title.append(document.createElement('span'), description); row.append(title, document.createElement('td'));
      }
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] ?? null);
      row.children[0].children[0].textContent = reading.label;
      row.children[0].children[1].textContent = reading.description;
      const cell = row.children[1]; cell.classList.toggle('stale', !reading.available);
      let value = cell.querySelector('strong'), qualifier = cell.querySelector('small');
      if (!value) { value = document.createElement('strong'); qualifier = document.createElement('small');
        qualifier.className = 'equipment-reading-qualifier'; cell.append(value, qualifier); }
      qualifier.textContent = reading.qualifier;
      setStatusDetail(value, { key: `mitsubishi-${reading.key}`, label: reading.value, title: reading.label, detail: reading.detail });
    }
  }
}

export function mitsubishiControl(status, setting) {
  const controls = status?.garage?.nativeControls ?? {}, selected = controls.settings?.[setting] ?? {};
  const writable = Boolean(status && status.readOnly !== true && !isReadOnlyReplica(status));
  return { ...selected, available: writable && controls.available === true && selected.available === true
    && selected.supported === true && scalar(selected.value) && !controls.busy && !controls.pending,
  reason: !writable ? 'This view is read-only. Use the primary controller to change settings.'
    : selected.reason ?? controls.reason ?? 'Waiting for a supported native control connection.' };
}
export function mitsubishiResult(result) {
  if (!result) return '';
  const setting = mitsubishiSettings[result.setting]?.label ?? 'Heat-pump setting';
  const request = `${setting}: ${mitsubishiValue(result.setting, result.value)}.`;
  if (result.status === 'saved') return `${request} Saved; preparing external temperature control.`;
  if (result.status === 'acknowledged') return `${request} External temperature acknowledged by the driver.`;
  if (result.status === 'native-confirmed') return `${request} Confirmed by the pump${clock(result.nativeConfirmedAt) ? ` at ${clock(result.nativeConfirmedAt)}` : ''}.`;
  if (['pending', 'published', 'accepted'].includes(result.status)) return `${request} Requested; waiting for fresh pump confirmation.`;
  if (result.status === 'uncertain') return `${request} Outcome uncertain. Check the reported pump setting before retrying.`;
  if (result.status === 'superseded') return `${request} Request superseded.${result.reason ? ` ${words(result.reason)}.` : ''}`;
  return `${request} ${words(result.status ?? 'unconfirmed')}.${result.reason ? ` ${words(result.reason)}.` : ''}`;
}

export function createMitsubishiControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), form = $('garage-native-form'), setting = $('garage-native-setting');
  const select = $('garage-native-value'), input = $('garage-native-temperature'), submit = $('garage-native-submit');
  const message = $('garage-native-message');
  let status = null, busy = false, closed = false, edited = false, optionSignature = null, settingSignature = null, requestError = null, pointerSelection = false;
  const refreshControls = () => {
    if (!form) return;
    const control = mitsubishiControl(status, setting.value), locked = closed || busy || blocked();
    setting.disabled = locked;
    select.disabled = locked || !control.available || setting.value === 'targetC';
    input.disabled = locked || !control.available || setting.value !== 'targetC';
    submit.disabled = locked || !control.available;
    form.setAttribute('aria-busy', String(busy || Boolean(status?.garage?.nativeControls?.busy || status?.garage?.nativeControls?.pending)));
  };
  const render = ({ useReadback = false } = {}) => {
    if (!form) return;
    const known = Object.keys(mitsubishiSettings).filter(key => {
      const capability = status?.garage?.nativeControls?.settings?.[key];
      return capability?.supported === true && scalar(capability.value);
    });
    const fold = $('garage-native-control-details');
    if (fold) fold.hidden = !known.length;
    form.hidden = !known.length;
    const room = mitsubishiRoomTemperature(status?.garage), roomStatus = $('garage-room-temperature-status');
    if (roomStatus) { roomStatus.hidden = !room; roomStatus.textContent = room ? `Room setting ${room.value}. ${room.progress}` : ''; }
    if (settingSignature !== JSON.stringify(known)) {
      const previous = setting.value;
      setting.replaceChildren();
      for (const key of known) { const option = document.createElement('option'); option.value = key;
        option.textContent = mitsubishiSettings[key].label; setting.append(option); }
      setting.value = known.includes(previous) ? previous : known[0] ?? '';
      if (setting.value !== previous) edited = false;
      settingSignature = JSON.stringify(known);
    }
    if (!known.length) { refreshControls(); return; }
    const key = setting.value, control = mitsubishiControl(status, key), numeric = key === 'targetC';
    const temperatureHelp = $('garage-native-temperature-help');
    if (temperatureHelp) temperatureHelp.hidden = !numeric || !(control.min < 16 || room);
    setStatusDetail($('garage-native-temperature-details'), { key: 'mitsubishi-temperature-control',
      label: 'How it works', title: 'Room temperature control',
      detail: room ? room.detail : mitsubishiTemperatureControlHelp });
    const values = (control.values ?? []).filter(scalar), signature = JSON.stringify([key, values]);
    $('garage-native-temperature-field').hidden = !numeric; $('garage-native-value-field').hidden = numeric;
    input.min = control.min ?? ''; input.max = control.max ?? ''; input.step = control.step ?? 'any';
    if (optionSignature !== signature) {
      const previous = select.value; select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Select a value';
      select.append(placeholder);
      for (const value of values) { const option = document.createElement('option'); option.value = JSON.stringify(value);
        option.textContent = mitsubishiValue(key, value); select.append(option); }
      select.value = previous; optionSignature = signature;
    }
    if (!edited || useReadback) {
      input.value = numeric && (control.usable === true || room) && Number.isFinite(control.value) ? String(control.value) : '';
      select.value = control.usable === true && values.some(value => value === control.value) ? JSON.stringify(control.value) : '';
    }
    const reading = mitsubishiReadings(status?.garage, status?.now).find(row => row.key === `native-${key}`);
    setStatusDetail($('garage-native-reported'), { key: `mitsubishi-selected-${key}`, title: mitsubishiSettings[key].label,
      label: reading?.value ?? 'Unavailable', detail: reading?.detail ?? 'Waiting for a current native readback.' });
    $('garage-native-status').textContent = control.available
      ? numeric && control.min < 16 ? 'Saves your room setting. Wait for control confirmation.'
        : room ? 'Changing this setting ends external temperature control.'
          : 'Applies the setting. Wait for pump confirmation.'
      : /\s/.test(control.reason) ? control.reason : words(control.reason);
    if (!busy && !requestError) { message.textContent = mitsubishiResult(status?.garage?.nativeControls?.result);
      message.classList.toggle('form-error', ['rejected', 'uncertain', 'failed'].includes(status?.garage?.nativeControls?.result?.status)); }
    refreshControls();
  };
  const pointerChoice = () => { pointerSelection = true; };
  const keyboardChoice = () => { pointerSelection = false; };
  const change = () => {
    const focusEditor = pointerSelection; pointerSelection = false;
    edited = false; requestError = null; render({ useReadback: true });
    if (focusEditor) {
      // Finish the native picker interaction before editing, including Samsung Internet on DeX.
      const editor = setting.value === 'targetC' ? input : select;
      if (!editor.disabled && !form.hidden) editor.focus({ preventScroll: true });
      else setting.blur();
    }
  };
  const edit = () => { edited = true; requestError = null; };
  const send = async event => {
    event.preventDefault();
    const key = setting.value, control = mitsubishiControl(status, key);
    if (closed || busy || blocked() || !control.available) return;
    requestError = null;
    let value;
    if (key === 'targetC') {
      value = input.value.trim() === '' ? NaN : Number(input.value);
      if (!Number.isFinite(value) || !Number.isFinite(control.min) || !Number.isFinite(control.max)
        || value < control.min || value > control.max || Number.isFinite(control.step) && Math.abs((value - control.min) / control.step - Math.round((value - control.min) / control.step)) > 1e-8) {
        requestError = `Choose a room setting within the reported range${Number.isFinite(control.min) && Number.isFinite(control.max) ? ` ${control.min}–${control.max} °C` : ''}.`;
      }
    } else {
      try { value = JSON.parse(select.value); } catch { value = undefined; }
      if (!control.values?.some(allowed => allowed === value)) requestError = 'Choose one of the values supported by the pump.';
    }
    if (requestError) { message.textContent = requestError; message.classList.add('form-error'); return; }
    busy = true; beforeRequest(); onBusy(true); refreshControls(); message.classList.remove('form-error');
    message.textContent = 'Applying heat-pump setting…';
    try {
      status = await request('/api/garage/native', { setting: key, value }); edited = false; requestError = null;
      onStatus(status);
    } catch (error) { requestError = error.message; message.textContent = requestError; message.classList.add('form-error'); }
    finally { busy = false; onBusy(false); render(); }
    await afterRequest();
  };
  form?.addEventListener('submit', send); setting?.addEventListener('change', change);
  setting?.addEventListener('pointerdown', pointerChoice); setting?.addEventListener('keydown', keyboardChoice);
  setting?.addEventListener('pointercancel', keyboardChoice);
  select?.addEventListener('change', edit); input?.addEventListener('input', edit); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() { closed = true; form?.removeEventListener('submit', send); setting?.removeEventListener('change', change);
      setting?.removeEventListener('pointerdown', pointerChoice); setting?.removeEventListener('keydown', keyboardChoice);
      setting?.removeEventListener('pointercancel', keyboardChoice);
      select?.removeEventListener('change', edit); input?.removeEventListener('input', edit); refreshControls(); } };
}
