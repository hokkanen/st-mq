import { actionReceiptRecent } from './action-receipts.js';
import { isReadOnlyReplica } from './replica-status.js';
import { mitsubishiReadings, mitsubishiCompressor, renderMitsubishiReadings } from './mitsubishi.js';
import { equipmentReadingRows } from './equipment.js';
import { garageDoorDevices } from './garage-doors.js';
import { setStatusDetail } from './status-details.js';
import { renderCurrentPrice } from './current-price.js';
import { garageHeatingWarning } from './heating-warning.js';

const finite = Number.isFinite;
const number = value => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)} °C` : 'Unavailable';
const words = value => typeof value === 'string' ? value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()) : '';
const modeName = mode => ({ normal: 'Normal', away: 'Away' })[mode] ?? 'Not selected';

export function garageDisplay(garage = {}) {
  const protection = garage.protection ?? {};
  const protectionAvailable = protection.available === true;
  const protectionActive = protectionAvailable && protection.active === true;
  const protectionLabel = !protectionAvailable ? 'Unavailable' : protectionActive ? 'Heating override active' : 'Monitoring';
  return { mode: modeName(garage.mode), target: number(garage.requestedTargetC),
    effectiveTarget: number(garage.effectiveTargetC), normalTarget: number(garage.normalTargetC), awayTarget: number(garage.awayTargetC),
    confirmation: garage.targetConfirmed === true ? 'Confirmed by the heat-pump controller' : 'Waiting for heat-pump controller confirmation',
    protection: protectionLabel, protectionState: !protectionAvailable || protectionActive ? 'attention' : 'available',
    protectionDetail: !protectionAvailable
      ? 'Frost protection is unavailable. A temperature reading alone does not establish pipe protection.'
      : protectionActive ? 'Freeze protection is overriding the selected target. Your Normal or Away choice remains saved.'
        : 'Independent pipe protection is monitoring. It can start the heat pump and raise its target when needed.',
    reason: garage.regulationReason || (garage.controlReason ? words(garage.controlReason) : garage.controlAvailable === true
      ? 'The selected mode stays until you change it, including across restarts.' : 'Waiting for the garage heating connection.') };
}

export function renderGarage(document, status = {}) {
  const garage = status.garage ?? {}, adapter = garage.adapter ?? {}, now = status.now ?? Date.now();
  const display = garageDisplay(garage);
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const detail = (id, label, title, description, stale = false) => {
    const node = document.getElementById(id); if (!node) return;
    node.classList.toggle('stale', stale);
    setStatusDetail(node, { label, title, detail: description, key: id });
  };
  const readOnly = status.readOnly === true || status.input === 'offline' || isReadOnlyReplica(status);
  set('garage-control-mode', display.mode);
  set('garage-requested-label', readOnly ? 'Recorded room target' : 'Room target');
  detail('garage-requested', display.target, 'Garage room target',
    `${display.mode}. ${display.confirmation}. The saved selection has no expiry. A target is a request, not measured room temperature.`, garage.targetConfirmed !== true);
  const devices = status.equipment?.devices ?? [];
  const temperatureDevice = devices.find(device => device.enabled !== false && device.readings?.garage_temperature);
  const rear = garage.observations?.rear;
  const main = finite(rear?.value) ? equipmentReadingRows({ kind: 'temperature', available: rear.stale === false,
    readings: { garage_temperature: { ...rear, unit: 'degC', label: 'Garage rear temperature' } } })[0]
    : temperatureDevice ? equipmentReadingRows(temperatureDevice).find(row => row.signal === 'garage_temperature') : null;
  detail('garage-temperature', main?.value ?? 'Unavailable', 'Garage temperature', main?.detail ?? 'Waiting for a usable garage temperature.', main?.stale ?? true);
  document.getElementById('garage-temperature')?.classList.toggle('metric-unavailable', !main || main.stale);
  set('garage-temperature-age', !main || main.stale ? 'Waiting for current readings' : main.qualifier ?? 'Readings current');
  const temperatureNote = document.getElementById('garage-temperature-age');
  if (temperatureNote) temperatureNote.hidden = Boolean(main && !main.stale && !main.qualifier);
  const doors = garageDoorDevices(status).flatMap(device => {
    const rows = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
    return rows.length ? rows.map(row => ({ ...row, name: device.label ?? row.label }))
      : [{ name: device.label ?? 'Door', value: 'Unknown', stale: true, detail: 'No usable reading received' }];
  });
  const openDoors = doors.filter(row => row.value === 'Open'), closedDoors = doors.filter(row => row.value === 'Closed');
  const movingDoors = doors.filter(row => ['Opening', 'Closing'].includes(row.value));
  const unknownDoors = doors.filter(row => !['Open', 'Closed'].includes(row.value));
  const doorName = row => /^garage_door(\d+)_open$/.test(row.signal)
    ? `Door ${row.signal.match(/^garage_door(\d+)_open$/)[1]}` : row.name.replace(/^Garage\s+/i, '');
  let doorSummary = 'Unknown';
  if (doors.length === 1) doorSummary = doors[0].value;
  else if (movingDoors.length) {
    doorSummary = doors.length === 2 && movingDoors.length === 2 && movingDoors[0].value === movingDoors[1].value
      ? `Both ${movingDoors[0].value.toLowerCase()}`
      : movingDoors.map(row => `${doorName(row)} ${row.value.toLowerCase()}`).join(' · ');
  } else if (doors.length === 2) {
    if (openDoors.length === 2) doorSummary = 'Both open';
    else if (closedDoors.length === 2) doorSummary = 'Both closed';
    else if (openDoors.length === 1) doorSummary = `${doorName(openDoors[0])} open${unknownDoors.length ? ' · other unknown' : ''}`;
    else if (unknownDoors.length === 2) doorSummary = 'Both unknown';
    else doorSummary = `${doorName(unknownDoors[0])} unknown`;
  } else if (doors.length > 2) {
    doorSummary = [[openDoors.length, 'open'], [closedDoors.length, 'closed'], [unknownDoors.length, 'unknown']]
      .filter(([count]) => count).map(([count, state]) => `${count} ${state}`).join(' · ');
  }
  set('garage-doors-label', doorSummary);
  document.getElementById('garage-doors-shortcut')?.setAttribute('aria-label', `Garage doors: ${doorSummary}. Show controls`);
  const doorStatus = document.getElementById('garage-door-summary');
  doorStatus?.classList.toggle('stale', !doors.length || doors.some(row => row.stale));
  if (doorStatus) doorStatus.dataset.state = doors.length && closedDoors.length === doors.length && !doors.some(row => row.stale)
    ? 'confirmed' : 'attention';

  const readings = mitsubishiReadings(garage, now);
  for (const [field, id, label] of [['power', 'garage-native-power', 'Heat-pump power'],
    ['mode', 'garage-current-mode', 'Heat-pump operating mode'], ['targetC', 'garage-native-target', 'Native thermostat setting']]) {
    const reading = readings.find(row => row.key === `native-${field}`);
    detail(id, reading?.value ?? 'Unavailable', label, reading?.detail ?? 'Waiting for a fresh heat-pump reading.', !reading?.available);
  }
  const compressor = mitsubishiCompressor(garage, now);
  detail('garage-native-compressor', compressor.value, 'Compressor operation', compressor.detail, !compressor.available);
  set('garage-current-control', `${display.mode} · ${display.target}`);
  set('garage-current-room', display.effectiveTarget);
  const sensor = adapter.control;
  const sensorAge = finite(sensor?.sensorAgeMs) && finite(adapter.observedAt)
    ? sensor.sensorAgeMs + Math.max(0, now - adapter.observedAt) : null;
  set('garage-bluetooth-temperature', adapter.connected === true && sensor && finite(sensor.sensorTemperatureC) && finite(sensorAge)
    && sensorAge >= 0 && sensorAge < 180_000 ? number(sensor.sensorTemperatureC) : 'Unavailable');
  set('garage-target-confirmation', readOnly ? 'Recorded selection · live confirmation unavailable' : display.confirmation);
  set('garage-mode-normal-target', display.normalTarget);
  set('garage-mode-away-target', display.awayTarget);
  set('garage-protection-status', display.protection);
  const protection = document.getElementById('garage-protection-status');
  if (protection) protection.dataset.state = display.protectionState;
  set('garage-protection-detail', [display.protectionDetail, words(garage.protection?.reason)].filter(Boolean).join(' '));
  for (const location of ['rear', 'front']) {
    const pipe = garage.protection?.locations?.[location];
    const reading = garage.observations?.[location];
    const senderFresh = garage.protection?.sender?.available === true;
    const senderAir = senderFresh && finite(pipe?.airC), air = senderAir ? pipe.airC : reading?.value;
    set(`garage-protection-${location}`, finite(air) ? `${number(air)}${!senderAir && reading?.stale !== false ? ' · stale' : ''}` : 'Unavailable');
    const known = senderFresh && pipe && pipe.uncertain !== true && finite(pipe.estimatedC);
    set(`garage-pipe-${location}`, known ? number(pipe.estimatedC) : 'Unavailable');
    set(`garage-reserve-${location}`, known && finite(pipe.remainingKjPerM) && pipe.remainingKjPerM >= 0
      ? pipe.remainingKjPerM > 0 && pipe.remainingKjPerM < 0.01 ? '<0.01 kJ/m'
        : `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(pipe.remainingKjPerM)} kJ/m` : 'Unavailable');
    set(`garage-pipe-${location}-status`, pipe?.uncertain ? 'Temperature history is uncertain; reserve is not established.'
      : !senderFresh ? 'Waiting for a fresh protection report.' : words(pipe?.reason));
  }
  const warning = garageHeatingWarning(status);
  const warningNode = document.getElementById('garage-warming-warning');
  if (warningNode) { warningNode.hidden = !warning; warningNode.textContent = warning; }
  const connected = adapter.connected === true && adapter.health?.pumpCommunicating === true;
  set('garage-controller-state', readOnly ? 'Recorded snapshot' : connected ? 'Connected' : adapter.connected ? 'Awaiting readings' : 'Not connected');
  const connection = document.getElementById('garage-controller-state');
  if (connection) connection.dataset.state = readOnly ? 'pending' : connected ? 'available' : 'attention';
  set('garage-controller-reason', [garage.error, display.reason].filter(Boolean).join(' '));
  detail('garage-pump-reading-info', 'Reading details', 'Mitsubishi heat-pump readings',
    'Reported pump settings and compressor operation are separate from the selected room target. The pump control temperature can include an offset and is not an independent room measurement. Electrical readings retain their original quality.');
  renderMitsubishiReadings(document, status);
  renderCurrentPrice(document, status, 'garage-');
}

export function createGarageControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), input = $('garage-normal-target'), form = $('garage-target-form');
  const message = $('garage-heating-message');
  let status = null, busy = false, closed = false, dirty = false, protectionDirty = false, selectionFeedback = null;
  let protectionFeedback = null;
  const protectionFields = ['marginC', 'pipeOutsideDiameterMm', 'pipeWallMm', 'heatTransferWPerM2K'];
  const protectionForm = $('garage-protection-form');
  const protectionAvailable = () => status?.garage?.protection?.settingsAvailable === true
    && status?.readOnly !== true && status?.input !== 'offline' && !isReadOnlyReplica(status);
  const available = () => status?.garage?.controlAvailable === true && status?.readOnly !== true
    && status?.input !== 'offline' && !isReadOnlyReplica(status);
  const locked = () => closed || busy || blocked() || !available();
  const refreshControls = () => {
    for (const mode of ['normal', 'away']) {
      const button = $(`garage-mode-${mode}`); if (!button) continue;
      const selected = status?.garage?.mode === mode;
      const target = status?.garage?.[`${mode}TargetC`];
      button.disabled = locked() || !finite(target);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${modeName(mode)} · ${number(target)}${selected ? ' · selected' : ''}`);
      const marker = button.querySelector('.heating-button-state');
      if (marker) marker.textContent = selected ? '✓' : '';
    }
    if (input) input.disabled = locked();
    if ($('garage-target-submit')) $('garage-target-submit').disabled = locked() || !dirty;
    form?.setAttribute('aria-busy', String(busy));
    for (const key of ['approved', ...protectionFields]) {
      const field = $(`garage-protection-${key}`);
      if (field) field.disabled = closed || busy || blocked() || !protectionAvailable();
    }
    if ($('garage-protection-submit')) $('garage-protection-submit').disabled = closed || busy || blocked() || !protectionAvailable() || !protectionDirty;
  };
  const render = () => {
    const garage = status?.garage ?? {};
    if (input && !dirty) input.value = finite(garage.normalTargetC) ? String(garage.normalTargetC) : '';
    const help = $('garage-heating-status');
    if (help) help.textContent = available() ? 'Control available' : 'Control unavailable';
    const reason = $('garage-control-detail');
    if (reason) reason.textContent = status?.readOnly === true || status?.input === 'offline' || isReadOnlyReplica(status)
      ? 'Recorded selection. Change heating on the live controller.' : garageDisplay(garage).reason;
    if (message && selectionFeedback && !busy) {
      const now = status?.now ?? Date.now(), receipt = selectionFeedback;
      if (!actionReceiptRecent(receipt.at, now)) { selectionFeedback = null; message.textContent = ''; message.classList.remove('form-error'); }
      else {
        const matches = garage.mode === receipt.mode && garage.requestedTargetC === receipt.targetC;
        if (!matches && !receipt.error) receipt.superseded = true;
        if (matches && garage.targetConfirmed === true && !receipt.superseded) {
          receipt.confirmed = true;
          if (garage.adapter?.observedAt >= receipt.at) receipt.error = null;
        }
        const confirmation = status?.readOnly === true || status?.input === 'offline' || isReadOnlyReplica(status)
          ? 'Recorded selection · live confirmation unavailable' : receipt.superseded ? 'Selection superseded by a newer choice'
            : receipt.confirmed ? 'Confirmed by the heat-pump controller' : 'Waiting for heat-pump controller confirmation';
        message.textContent = receipt.error ?? `${modeName(receipt.mode)} selected · ${number(receipt.targetC)}. ${confirmation}.`;
        message.classList.toggle('form-error', Boolean(receipt.error));
      }
    }
    const protection = garage.protection ?? {};
    if (!protectionDirty) for (const key of ['approved', ...protectionFields]) {
      const field = $(`garage-protection-${key}`); if (!field) continue;
      if (key === 'approved') field.checked = protection.settings?.approved === true;
      else field.value = finite(protection.settings?.[key]) ? String(protection.settings[key]) : '';
    }
    const result = protection.sender?.result;
    const protectionMessage = $('garage-protection-message');
    if (!busy && protectionMessage && protectionFeedback
      && !actionReceiptRecent(protectionFeedback.at, status?.now ?? Date.now())) {
      protectionFeedback = null; protectionMessage.textContent = ''; protectionMessage.classList.remove('form-error');
    }
    if (!busy && result && protectionMessage && (!protectionFeedback?.error || result.requestedAt >= protectionFeedback.at)) {
      const recent = actionReceiptRecent(result.requestedAt, status?.now ?? Date.now());
      protectionMessage.textContent = !recent ? '' : result.status === 'applied' ? 'Protection settings applied by the local protection unit.'
        : result.status === 'published' ? 'Settings requested. Waiting for protection unit confirmation.'
          : result.reason ?? 'Protection settings were not confirmed. Check the reported values before retrying.';
      protectionMessage.classList.toggle('form-error', recent && ['uncertain', 'rejected', 'failed'].includes(result.status));
    }
    const settingsStatus = $('garage-protection-settings-status');
    if (settingsStatus) settingsStatus.textContent = protectionAvailable()
      ? 'Current settings reported by the local protection unit.' : protection.settingsReason ?? 'Waiting for reported protection settings.';
    renderGarage(document, status ?? {});
    refreshControls();
  };
  const send = async payload => {
    if (locked()) return;
    selectionFeedback = { at: status?.now ?? Date.now(), mode: payload.mode,
      targetC: payload.targetC ?? status?.garage?.[`${payload.mode}TargetC`] };
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    if (message) { message.classList.remove('form-error'); message.textContent = 'Saving garage temperature…'; }
    try {
      status = await request('/api/garage/heating', payload); dirty = false; onStatus(status);
    } catch (error) {
      selectionFeedback.error = error.message;
      if (message) { message.classList.add('form-error'); message.textContent = error.message; }
    } finally { busy = false; onBusy(false); render(); }
    await afterRequest();
  };
  const normal = () => { if (finite(status?.garage?.normalTargetC)) void send({ mode: 'normal' }); };
  const away = () => { if (finite(status?.garage?.awayTargetC)) void send({ mode: 'away' }); };
  const edit = () => { dirty = true; refreshControls(); };
  const submit = event => {
    event.preventDefault();
    if (locked() || !dirty) return;
    const targetC = input?.value?.trim() ? Number(input.value) : NaN;
    if (!finite(targetC) || targetC < 0 || targetC > 31 || !Number.isInteger(targetC * 2)) {
      selectionFeedback = { at: status?.now ?? Date.now(), error: 'Choose a Normal target from 0 to 31 °C in 0.5 °C steps.' };
      if (message) { message.classList.add('form-error'); message.textContent = 'Choose a Normal target from 0 to 31 °C in 0.5 °C steps.'; }
      return;
    }
    void send({ mode: 'normal', targetC });
  };
  const editProtection = () => { protectionDirty = true; refreshControls(); };
  const submitProtection = async event => {
    event.preventDefault();
    if (closed || busy || blocked() || !protectionAvailable() || !protectionDirty) return;
    const payload = { version: 'garage-thermal-reserve-v1', approved: $('garage-protection-approved')?.checked === true };
    for (const key of protectionFields) payload[key] = $(`garage-protection-${key}`)?.value?.trim()
      ? Number($(`garage-protection-${key}`).value) : NaN;
    const bounds = [[payload.marginC, 0.1, 5], [payload.pipeOutsideDiameterMm, 6, 100],
      [payload.pipeWallMm, 0.3, 10], [payload.heatTransferWPerM2K, 1, 100]];
    const notice = $('garage-protection-message');
    if (bounds.some(([value, min, max]) => !finite(value) || value < min || value > max)
      || payload.pipeWallMm * 2 >= payload.pipeOutsideDiameterMm) {
      protectionFeedback = { at: status?.now ?? Date.now(), error: true };
      if (notice) { notice.classList.add('form-error'); notice.textContent = 'Use the stated ranges. The pipe wall must be less than half its outside diameter.'; }
      return;
    }
    protectionFeedback = { at: status?.now ?? Date.now(), error: false };
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    if (notice) { notice.classList.remove('form-error'); notice.textContent = 'Sending protection settings…'; }
    try {
      status = await request('/api/garage/protection', payload); protectionDirty = false;
      if (notice) notice.textContent = 'Settings requested. Wait for the local protection unit to confirm them.';
      onStatus(status);
    } catch (error) { protectionFeedback.error = true; if (notice) { notice.classList.add('form-error'); notice.textContent = error.message; } }
    finally { busy = false; onBusy(false); render(); }
    await afterRequest();
  };
  protectionForm?.addEventListener('submit', submitProtection);
  for (const key of ['approved', ...protectionFields]) $(`garage-protection-${key}`)?.addEventListener('input', editProtection);
  $('garage-mode-normal')?.addEventListener('click', normal); $('garage-mode-away')?.addEventListener('click', away);
  form?.addEventListener('submit', submit); input?.addEventListener('input', edit); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() { closed = true; $('garage-mode-normal')?.removeEventListener('click', normal);
      $('garage-mode-away')?.removeEventListener('click', away); form?.removeEventListener('submit', submit);
      input?.removeEventListener('input', edit); protectionForm?.removeEventListener('submit', submitProtection);
      for (const key of ['approved', ...protectionFields]) $(`garage-protection-${key}`)?.removeEventListener('input', editProtection);
      refreshControls(); } };
}
