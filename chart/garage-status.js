import { actionReceiptRecent } from './action-receipts.js';
import { isReadOnlyReplica } from './replica-status.js';
import { mitsubishiReadings, mitsubishiCompressor, renderMitsubishiReadings } from './mitsubishi.js';
import { equipmentReadingRows } from './equipment.js';
import { garageDoorControl, garageDoorLayout } from './garage-doors.js';
import { setStatusDetail } from './status-details.js';
import { renderCurrentPrice } from './current-price.js';
import { garageHeatingWarning } from './heating-warning.js';

const finite = Number.isFinite;
const number = value => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)} °C` : 'Unavailable';
const words = value => typeof value === 'string' ? value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()) : '';
const modeName = mode => ({ normal: 'Normal', away: 'Away' })[mode] ?? 'Not selected';
const regulationInputs = new WeakMap();

function protectionDisplay(garage) {
  const protection = garage.protection ?? {};
  const control = garage.adapter?.connected === true ? garage.adapter.control : null;
  const available = protection.available === true, active = available && protection.active === true;
  const fallback = control?.frostConfigured === true && control.status === 'frost-unavailable';
  const temperatureFallback = ['sensor-stale', 'sensor-range'].includes(control?.status);
  const regulating = ['active', 'frost-rescue'].includes(control?.status);
  const rescue = active && control?.frostRescue === true;
  const sender = protection.sender?.available === true ? protection.sender.protection : null;
  const minimum = sender?.available === true && finite(sender.minTargetC) ? sender.minTargetC : null;
  const selected = garage.requestedTargetC, effective = garage.effectiveTargetC;
  const raised = active && regulating && finite(selected) && minimum !== null && minimum > selected && effective === minimum;
  const label = fallback ? 'Fallback heating' : !available ? 'Unavailable' : rescue ? 'Heat/On rescue'
    : temperatureFallback ? 'Fallback heating' : raised ? 'Minimum target active' : active ? 'Protection active' : 'Monitoring';
  let explanation = fallback
    ? 'The configured protection feed is unavailable. The controller requests Heat and power On with its native 16 °C thermostat fallback.'
    : !available ? 'Freeze protection is unavailable. Air temperature alone does not establish pipe protection.'
      : rescue ? 'The controller requests Heat and power On for protection. This enables heating; it does not mean the compressor is running.'
        : active ? 'The controller reports a protection demand. The effective target below is its reported control target.'
          : 'Pipe protection is monitoring in both Normal and Away. It can request Heat and power On, and raise the target when needed.';
  if (temperatureFallback) explanation += ` Room regulation is using the native 16 °C thermostat fallback because ${control.status === 'sensor-stale'
    ? 'its temperature input is stale or missing' : 'its temperature input or calculated control value is outside the supported range'}.`;
  if (available && regulating && garage.targetConfirmed === true && finite(selected) && finite(effective) && minimum !== null) {
    if (effective === selected && minimum <= selected) explanation += ` Your selected ${number(selected)} already meets the ${number(minimum)} protection minimum, so the effective target stays at ${number(effective)}.`;
    else if (effective === minimum && minimum > selected) explanation += ` The ${number(minimum)} protection minimum raises the effective target above your selected ${number(selected)}.`;
    else explanation += ' The reported minimum and effective target do not yet agree; controller confirmation may be pending.';
  }
  explanation += ' Your saved Normal or Away target stays unchanged.';
  const reason = sender ? ({
    'pipe-history-uncertain': 'Pipe temperature history is uncertain, so the sender requests conservative rescue heating. This does not mean the pipes are measured as frozen.',
    'pipe-reserve-low': 'Air temperature or estimated pipe reserve has reached, or is forecast to reach, the protection threshold; the sender requests rescue heating.',
    'recovery-hold': 'Conditions have improved. The sender keeps rescue active until both locations meet the recovery conditions for ten minutes.',
    'pipe-reserve-recovered': 'Both locations have met the recovery conditions. The sender has released rescue.',
    'pipe-reserve-available': 'The sender reports sufficient pipe reserve; no rescue is requested.',
    'probe-stale-or-invalid': 'A required probe is stale or invalid, so the sender cannot establish pipe protection.',
    'policy-not-approved': 'The pipe model has not been approved, so the sender cannot establish pipe protection.',
  })[sender.reason] || 'The sender has not reported a protection reason.'
    : 'The sender’s detailed report is unavailable. Controller protection status is reported separately.';
  return { protection: label, protectionState: !available || active || fallback || temperatureFallback ? 'attention' : 'available',
    protectionDetail: explanation, protectionReason: reason,
    protectionMinimum: minimum === null ? 'Unavailable' : minimum === 0 ? 'No minimum' : number(minimum),
    protectionEffective: fallback || temperatureFallback ? `${number(effective)} · native fallback` : number(effective) };
}

export function garageDisplay(garage = {}) {
  return { mode: modeName(garage.mode), target: number(garage.requestedTargetC),
    effectiveTarget: number(garage.effectiveTargetC), normalTarget: number(garage.normalTargetC), awayTarget: number(garage.awayTargetC),
    confirmation: garage.targetConfirmed === true ? 'Confirmed by the heat-pump controller' : 'Waiting for heat-pump controller confirmation',
    ...protectionDisplay(garage),
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
  const layout = garageDoorLayout(status);
  const doors = layout.map(bay => {
    const view = bay.device ? garageDoorControl(status, bay.device) : { state: 'Unknown', tone: 'unknown' };
    return { name: bay.label, value: view.state, stale: view.tone === 'unknown' };
  });
  const doorSummary = doors[0].value === doors[1].value ? `Both ${doors[0].value.toLowerCase()}`
    : doors.filter(row => row.value !== 'Closed').map(row => `${row.name} ${row.value.toLowerCase()}`).join(' · ');
  set('garage-doors-label', doorSummary);
  document.getElementById('garage-doors-shortcut')?.setAttribute('aria-label', `Garage doors: ${doorSummary}. Show controls`);
  const doorStatus = document.getElementById('garage-door-summary');
  doorStatus?.classList.toggle('stale', doors.some(row => row.stale));
  if (doorStatus) doorStatus.dataset.state = doors.every(row => row.value === 'Closed' && !row.stale)
    ? 'confirmed' : 'attention';

  const readings = mitsubishiReadings(garage, now);
  for (const [field, id, label] of [['power', 'garage-native-power', 'Heat-pump power'],
    ['mode', 'garage-current-mode', 'Heat-pump operating mode'], ['targetC', 'garage-native-target', 'Native thermostat setting']]) {
    const reading = readings.find(row => row.key === `native-${field}`);
    detail(id, reading?.value ?? 'Unavailable', label, reading?.detail ?? 'Waiting for a fresh heat-pump reading.', !reading?.available);
  }
  const compressor = mitsubishiCompressor(garage, now);
  detail('garage-native-compressor', compressor.value, 'Compressor operation', compressor.detail, !compressor.available);
  detail('garage-heating-operation', compressor.value, 'Garage heat-pump operation', compressor.detail, !compressor.available);
  detail('garage-current-room', display.effectiveTarget, 'Effective garage target',
    `${readOnly ? 'Recorded selected' : 'Selected'} target: ${display.target}. ${display.mode}. ${readOnly ? 'Live confirmation is unavailable.' : `${display.confirmation}.`} `
      + `The effective target includes any independent freeze-protection minimum without changing your saved selection. `
      + 'It is a control target, not measured room temperature or proof that the compressor is running.', !finite(garage.effectiveTargetC));
  const sensor = adapter.control;
  const sensorAge = finite(sensor?.sensorAgeMs) && finite(adapter.observedAt)
    ? sensor.sensorAgeMs + Math.max(0, now - adapter.observedAt) : null;
  const sensorAvailable = adapter.connected === true && finite(sensor?.sensorTemperatureC) && finite(sensorAge)
    && sensorAge >= 0 && sensorAge < 180_000;
  const regulationRow = document.getElementById('garage-regulation-reading');
  if (regulationRow && finite(sensor?.sensorTemperatureC)) regulationInputs.set(regulationRow, {
    temperatureC: sensor.sensorTemperatureC, sensorAgeMs: sensor.sensorAgeMs, observedAt: adapter.observedAt,
  });
  const lastSensor = regulationRow ? regulationInputs.get(regulationRow) : null;
  const reportedTemperature = sensor?.sensorTemperatureC ?? lastSensor?.temperatureC;
  const reportedAge = sensorAge ?? (finite(lastSensor?.sensorAgeMs) && finite(lastSensor?.observedAt)
    ? lastSensor.sensorAgeMs + Math.max(0, now - lastSensor.observedAt) : null);
  if (regulationRow) regulationRow.hidden = !lastSensor;
  detail('garage-regulation-temperature', sensorAvailable ? number(sensor.sensorTemperatureC) : 'Unavailable', 'Garage regulation input',
    'Temperature input reported by the heat-pump controller for local room regulation. '
      + 'It can come from a different source than the Garage rear sensor and is not an independent room measurement. '
      + (finite(reportedTemperature) ? `Last reported input: ${number(reportedTemperature)}. ` : 'No temperature input has been reported. ')
      + (finite(reportedAge) && reportedAge >= 0 ? `Reported sensor age including time since the controller report: ${Math.floor(reportedAge / 1000)} seconds. ` : 'Sensor age is unavailable. ')
      + 'The input becomes unavailable after 180 seconds without a fresh report.'
      + (adapter.connected !== true ? ' The heat-pump controller is not connected.' : ''), !sensorAvailable);
  set('garage-target-confirmation', readOnly ? 'Recorded selection · live confirmation unavailable' : display.confirmation);
  set('garage-mode-normal-target', display.normalTarget);
  set('garage-mode-away-target', display.awayTarget);
  set('garage-protection-status', display.protection);
  const protection = document.getElementById('garage-protection-status');
  if (protection) protection.dataset.state = display.protectionState;
  const protectionDetail = `${readOnly ? 'Recorded status; live confirmation is unavailable. ' : ''}${display.protectionDetail}`;
  set('garage-protection-detail', protectionDetail);
  set('garage-protection-reason', display.protectionReason);
  set('garage-protection-selected-target', display.target);
  set('garage-protection-minimum-target', display.protectionMinimum);
  set('garage-protection-effective-target', display.protectionEffective);
  set('garage-protection-summary-note', readOnly ? 'Recorded snapshot' : 'Normal & Away');
  detail('garage-protection-summary', display.protection,
    'Garage freeze protection', protectionDetail, garage.protection?.available !== true);
  const protectionSummary = document.getElementById('garage-protection-summary');
  if (protectionSummary) protectionSummary.dataset.state = display.protectionState;
  const configured = garage.protection?.configuredSettings, reported = garage.protection?.settings;
  const parameterValue = (key, value) => key === 'approved'
    ? typeof value === 'boolean' ? value ? 'Approved' : 'Not approved' : 'Unavailable'
    : finite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(value) : 'Unavailable';
  for (const key of ['approved', 'marginC', 'pipeOutsideDiameterMm', 'pipeWallMm', 'heatTransferWPerM2K']) {
    set(`garage-protection-configured-${key}`, parameterValue(key, configured?.[key]));
    set(`garage-protection-reported-${key}`, parameterValue(key, reported?.[key]));
    const node = document.getElementById(`garage-protection-reported-${key}`);
    node?.classList.toggle('stale', Boolean(configured && reported && configured[key] !== reported[key]));
  }
  set('garage-protection-configured-label', readOnly ? 'Recorded config' : 'Configured');
  set('garage-protection-reported-label', readOnly ? 'Recorded unit' : 'Reported');
  const configuration = garage.protection?.configuration;
  set('garage-protection-settings-status', readOnly ? 'Recorded settings; live confirmation is unavailable.'
    : configuration?.reason || ({ confirmed: 'Configuration confirmed by the local protection unit.',
      pending: 'Configuration sent; waiting for matching device readback.',
      mismatch: 'The local protection unit reports different settings.',
      unknown: 'Waiting for fresh local protection settings.' })[configuration?.status] || 'Waiting for fresh local protection settings.');
  document.getElementById('garage-protection-settings-status')?.classList.toggle('stale', !readOnly && configuration?.status === 'mismatch');
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
    set(`garage-pipe-${location}-status`, !senderFresh ? 'Waiting for a fresh protection report.'
      : pipe?.uncertain ? 'Temperature history is uncertain; reserve is not established.' : words(pipe?.reason));
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
  if (regulationRow && !regulationRow.hidden) {
    const readingsFold = document.getElementById('garage-readings-details');
    if (readingsFold) readingsFold.hidden = false;
  }
  renderCurrentPrice(document, status, 'garage-');
}

export function createGarageControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), input = $('garage-normal-target'), form = $('garage-target-form');
  const message = $('garage-heating-message');
  let status = null, busy = false, closed = false, dirty = false, selectionFeedback = null;
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
  $('garage-mode-normal')?.addEventListener('click', normal); $('garage-mode-away')?.addEventListener('click', away);
  form?.addEventListener('submit', submit); input?.addEventListener('input', edit); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() { closed = true; $('garage-mode-normal')?.removeEventListener('click', normal);
      $('garage-mode-away')?.removeEventListener('click', away); form?.removeEventListener('submit', submit);
      input?.removeEventListener('input', edit);
      refreshControls(); } };
}
