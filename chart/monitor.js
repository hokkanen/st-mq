import { createReadOnlyControls, assertDashboardWrite } from './dashboard-access.js';
import { createSelectPickers } from './select-picker.js';
import { createDatePicker } from './date-picker.js';
import { createDashboardReset } from './dashboard-reset.js';
import { confirmAction } from './confirmation.js';
import { renderLearningRows } from './learning-rows.js';
import { renderGarage, createGarageControls } from './garage-status.js';
import { createMitsubishiControls } from './mitsubishi.js';
import { createChargingPanel } from './charging.js';
import { createHistoryChart } from './history-chart.js';
import { dashboardProviders, outdoorSourceLabel, providerName, providerSeries, temperatureReadingStatus } from './provider-status.js';
import { activeRates, rateRows, temporaryValues, priceControlState, renderHomePolicy, renderHomeRoomReferences } from './home-controls.js';
import { learningDisplay, h66Control, h66HomeSummary, h66EquipmentSummary, h66ReadingStatus, h66ReadingValue, h66Registers, h66ReadingGroups, renderModelInputs } from './learning-status.js';
import { renderRecording, renderEnergyAudits, recordingOverviewRefresh } from './recording.js';
import { bindDatabaseExport } from './database-export.js';
import { learningOverview, garageLearningOverview, settingsReloadScope } from './dashboard-status.js';
import { createFireplacePanel } from './fireplace.js';
import { createSensorChangePanel } from './sensor-changes.js';
import { applicationUrl, usesHomeAssistantLogin, authenticationMessage, createPollingRequest,
  fetchJsonResponse, createEventStream, createCommunicationWatch } from './network.js';
import { isReadOnlyReplica, renderReplicaStatus, replicaSnapshotKey, renderInstanceRole, pairPanelView } from './replica-status.js';
import { createPairPanel } from './pair-status.js';
import { createEquipmentPanel, dhwrReadingSummary } from './equipment.js';
import { createGarageDoorPanel } from './garage-doors.js';
import { renderFloorPreheat } from './floor-preheat.js';
import { assertWebRequest, createWebSession, createAccessControls, bindPasswordVisibility } from './web-access.js';
import { setStatusDetail, closeStatusDetails } from './status-details.js';
import { priceStatuses, renderCurrentPrice } from './current-price.js';
import { homeHeatingConfirmation, setHeatingStatusDetail } from './heating-status.js';
import { renderHomePlannedChange } from './heating-plan.js';
import { homeHeatingWarning, garageHeatingWarning } from './heating-warning.js';
import { createOcppSetupAction, ocppSetupRevision } from './ocpp-setup.js';
import { createDashboardLayout } from './dashboard-layout.js';
import { createPageFullscreen } from './page-fullscreen.js';
import { heatingRequestResult, h66RequestResult, circulationStopPending } from './manual-control-status.js';

const $ = id => document.getElementById(id);
const selectPickers = createSelectPickers(document);
const temporaryDatePickers = [];
for (const input of document.querySelectorAll('[data-date-picker="datetime-local"]')) {
  temporaryDatePickers.push(createDatePicker(input, { mode: 'datetime-local', label: input.labels?.[0]?.textContent.trim() || 'Choose date and time' }));
}
createDashboardReset({ document, button: $('dashboard-reset') });
createPageFullscreen({ document, button: $('fullscreen-toggle') });
createDashboardLayout(document.querySelector('.controller-panels'));
for (const summary of document.querySelectorAll('.zone-summary')) {
  summary.addEventListener('click', event => {
    if (event.target.closest('button, a, input, select, textarea')) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
// Strategy and model references open their disclosure and place keyboard focus on it.
for (const link of document.querySelectorAll('[data-policy-model-link]')) {
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = $(link.dataset.policyModelLink);
    if (!target || target.tagName !== 'DETAILS') return;
    event.preventDefault();
    for (let fold = target; fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    const summary = target.querySelector(':scope > summary');
    summary?.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  });
}
const ingress = usesHomeAssistantLogin();
const session = createWebSession({ storage: sessionStorage, ingress });
const accessControls = createAccessControls({ document });
const readOnlyControls = createReadOnlyControls({ document });
const passwordVisibility = bindPasswordVisibility({ input: $('token'), button: $('password-visibility') });
let webAccess;
let lastStatus;
let historyChart;
let temporaryBusy = false;
let heatingTestBusy = false;
let h66TestBusy = false;
let settingsReloadBusy = false;
let equipmentBusy = false;
let circulationStopAt;
let dismissedH66Request;
const controlErrors = new Map();
const heatingResults = new Map();
let refreshSequence = 0;
let lastReplicaSnapshot;
const dirtyTemporary = new Set();
const temporaryFields = { awayUntilLocal: 'away-until', pauseUntilLocal: 'pause-until' };
const heatingCommandLabel = command => ({ reduction: 'Reduced heating', normal: 'Normal heating', preheat: 'Preheat', circulation: 'Circulation' })[command] ?? 'Heating request';
const heatingTestButtons = [...document.querySelectorAll('[data-heating-command]')];
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = value => dateFormat.format(new Date(value));
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric' });
const day = value => dayFormat.format(new Date(value));
const decimal = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 5 }).format(value) : '—';
const label = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const tariffNames = { 'day-night': 'Day / night', seasonal: 'Seasonal' };
const weatherStatuses = { simulated: 'Synthetic weather', available: 'Forecast available', 'partial-forecast-coverage': 'Forecast has missing intervals', 'missing-forecast': 'Waiting for a forecast', 'stale-forecast': 'Forecast is stale' };
const reasons = {
  'unvalidated-thermal-model': 'Learning how the house holds and recovers heat',
  'unvalidated-heating-energy-model': 'Heating electricity use is not yet reliable enough to optimize',
  'thermal-state-reconciliation': 'Checking thermal reserve after startup',
  'reconciling-thermal-reserve': 'Allowing time to establish the current heat reserve',
  'learning-normal-comfort-reference': 'Learning the temperature achieved with normal heating',
  'awaiting-tariff-response-evidence': 'Learning how the heat pump responds to tariff control',
  'timed-normal-override': 'Price control is paused',
  'missing-or-stale-observations': 'Waiting for fresh temperature observations',
  'room-comfort-limit': 'A room has reached its permitted temperature drop',
  'sensor-measurement-changed': 'Re-establishing temperature learning after a sensor change',
  'continuous-normal-preferred': 'Continuous normal operation is preferred',
};
function lockScreen({ authenticationFailed = false } = {}) {
  selectPickers.dismiss();
  for (const picker of temporaryDatePickers) picker.dismiss();
  const hadPassword = Boolean(session.token), hadStatus = Boolean(lastStatus);
  session.logout(); ++refreshSequence; lastStatus = undefined; webAccess = undefined;
  document.body.dataset.authenticated = 'false';
  closeStatusDetails(document);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('auth').hidden = ingress; $('connection').textContent = 'Signed out';
  $('token').value = ''; passwordVisibility.hide();
  $('token').removeAttribute('aria-invalid');
  $('auth-error').textContent = '';
  $('auth-error').hidden = true;
  $('error').hidden = true;
  if (authenticationFailed && ingress) showError(new Error(authenticationMessage(true)));
  else if (authenticationFailed && hadPassword) {
    $('auth-error').textContent = hadStatus ? 'Your session ended. Sign in again.' : 'Password not recognised. Try again.';
    $('auth-error').hidden = false;
    if (!hadStatus) $('token').setAttribute('aria-invalid', 'true');
  }
  if (!ingress) $('token').focus();
}
async function api(path, data, options = {}) {
  if (session.locked) throw Object.assign(new Error(authenticationMessage(ingress)), { status: 401 });
  assertWebRequest(webAccess, path, data, lastStatus);
  assertDashboardWrite(path, data, lastStatus);
  const { response,result } = await session.run(({ headers, signal }) => fetchJsonResponse(applicationUrl(path), {
    signal, method: data === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), options);
  if (response.status === 401) {
    lockScreen({ authenticationFailed: true });
    const error = new Error(authenticationMessage(ingress)); error.status = response.status; throw error;
  }
  if (!response.ok) { const error = new Error(result.error ?? 'Request failed'); error.status = response.status; throw error; }
  return result;
}
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; $('connection').textContent = 'Connection needs attention'; }
const fireplacePanel = createFireplacePanel({ document, request: api, storage: sessionStorage,
  beforeMutation: () => { ++refreshSequence; }, afterMutation: () => refresh() });
// Mount the static input guide before restoring a possibly pending sensor change.
renderModelInputs($('model-inputs-content'), undefined, { sensorChanges: $('sensor-change-details'),
  outdoorSensorChanges: $('outdoor-sensor-change-details') });
const sensorChangePanel = createSensorChangePanel({ document, request: api, storage: sessionStorage,
  beforeMutation: () => { ++refreshSequence; }, afterMutation: () => refresh({ forceChart: true }) });
const pairPanel = createPairPanel({ document, request: api, storage: sessionStorage, formatTime: time,
  afterMutation: () => refresh({ forceChart: true }) });
const garageDoors = createGarageDoorPanel({ document,
  onAction: (deviceId, action) => equipmentPanel.actions.cover(deviceId, action),
  blocked: () => !lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy });
const equipmentPanel = createEquipmentPanel({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  onBusy: busy => { equipmentBusy = busy; updateTemporaryButtons(false); },
  onChange: snapshot => garageDoors.update(snapshot),
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy });
const garageControls = createGarageControls({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  onBusy: busy => { equipmentBusy = busy; updateTemporaryButtons(false); },
  afterRequest: () => refresh(),
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy });
const mitsubishiControls = createMitsubishiControls({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  onBusy: busy => { equipmentBusy = busy; updateTemporaryButtons(false); },
  afterRequest: () => refresh(),
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy });
const chargingPanel = createChargingPanel({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  afterRequest: () => refresh() });
const adoptOcppSetup = createOcppSetupAction({ document, request: api, getStatus: () => lastStatus,
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy,
  beforeRequest: () => { ++refreshSequence; }, afterRequest: () => refresh(),
  onBusy: busy => {
    equipmentBusy = busy; updateTemporaryButtons();
    const button = document.querySelector('[data-provider=electricity] .provider-local-adopt');
    if (button) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); }
  },
  onMessage: (text, error) => {
    const message = document.querySelector('[data-provider=electricity] .provider-local-message');
    if (message) { message.textContent = text; message.classList.toggle('form-error', error); }
  } });
function renderContract(s) {
  const current = activeRates(s);
  const period = current ?? s.configuredPrices;
  $('contract-context').textContent = s.input === 'simulated'
    ? 'Configured charges are shown below. The simulation’s example price outlook stays synthetic.'
    : current ? `Rates in use · from ${day(current.from)}.`
      : period ? 'Configured charges. No dated rate period covers the current time.'
        : 'No configured charges are available. All-in prices need dated contract rates.';
  const list = $('contract-periods');
  list.replaceChildren();
  if (!period) return;
  const heading = document.createElement('h3'); heading.className = 'tariff-heading';
  heading.textContent = `${tariffNames[period.tariff] ?? 'Transfer tariff'} · VAT ${decimal(period.vatRate * 100)}%`;
  const tariff = document.createElement('p'); tariff.className = 'muted';
  tariff.textContent = period.tariff === 'seasonal'
    ? 'Winter day: November–March, Monday–Saturday, 07:00–22:00. Other rate at all other times.'
    : 'Day: 07:00–22:00. Night: 22:00–07:00. Finnish local time.';
  const table = document.createElement('table'); table.className = 'rate-table';
  const caption = document.createElement('caption'); caption.textContent = 'Variable charges · c/kWh';
  const header = document.createElement('thead'); const headerRow = document.createElement('tr');
  for (const text of ['Charge', 'Excl. VAT', 'Incl. VAT']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; headerRow.append(cell);
  }
  header.append(headerRow);
  const body = document.createElement('tbody');
  for (const { name, excludingVat, includingVat } of rateRows(period)) {
    const row = document.createElement('tr');
    const title = document.createElement('th'); title.scope = 'row'; title.textContent = name; row.append(title);
    for (const amount of [excludingVat, includingVat]) {
      const cell = document.createElement('td'); cell.textContent = decimal(amount); row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, header, body);
  list.append(heading, table, tariff);
}
function updateTemporaryButtons(updateEquipment = true) {
  const busy = !lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || Boolean(lastStatus?.equipmentTests?.active || lastStatus?.equipmentTests?.busy || lastStatus?.equipmentControls?.busy);
  $('temporary-submit').disabled = busy || dirtyTemporary.size === 0;
  const saved = lastStatus ? temporaryValues(lastStatus) : {};
  $('home-now').disabled = busy || !($('away-until').value || saved.awayUntilLocal);
  $('resume-now').disabled = busy || !($('pause-until').value || saved.pauseUntilLocal);
  for (const button of heatingTestButtons) button.disabled = busy || !lastStatus?.heatingTests?.available;
  $('test-preheat').disabled ||= lastStatus?.heatingTests?.preheatAvailable !== true;
  $('test-circulation').disabled ||= Boolean(lastStatus?.dhwr?.restorationPending);
  $('dhwr-stop').disabled = busy || !lastStatus?.heatingTests?.available || !(lastStatus?.dhwr?.active || lastStatus?.dhwr?.restorationPending || lastStatus?.dhwr?.actualOn === true);
  $('h66-test-submit').disabled = busy || !h66Control(lastStatus?.h66, $('h66-test-register').value).available;
  $('settings-reload').disabled = busy || !settingsReloadScope(lastStatus).available;
  const localSetup = document.querySelector('[data-provider=electricity] .provider-local-adopt');
  if (localSetup) localSetup.disabled = busy || ocppSetupRevision(lastStatus) === null;
  if (updateEquipment) equipmentPanel.refreshControls();
  garageControls.refreshControls();
  mitsubishiControls.refreshControls();
}
function renderTemporary(s) {
  const saved = temporaryValues(s);
  for (const [field, id] of Object.entries(temporaryFields)) {
    if (!dirtyTemporary.has(field)) $(id).value = saved[field];
  }
  $('away-status').textContent = saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}.` : 'At home.';
  $('override-status').textContent = saved.pauseUntilLocal
    ? `Price control paused until ${time(s.override.expiresAt)}.` : 'Price control is not paused.';
  $('temporary-overview').textContent = (isReadOnlyReplica(s) ? 'Recorded · ' : '') + [saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}` : 'At home',
    saved.pauseUntilLocal ? `Paused until ${time(s.override.expiresAt)}`
      : s.input === 'offline' ? 'Unavailable offline'
        : s.mode === 'active' ? 'Not paused' : s.mode ? `${priceControlState(s).label} mode` : 'Status unavailable'].join(' · ');
  $('override-scope').textContent = isReadOnlyReplica(s) ? 'Saved settings for inspection. Away and pause changes are disabled in this read-only view.' : s.input === 'simulated'
    ? 'These changes apply to the simulation only.'
    : s.liveWrites ? 'Away and pause update the active heating plan. Starting a pause requests Normal heating, then holds any changes you make until the pause ends.'
      : 'Away and pause update the controller’s plan. This operating mode sends no automatic commands.';
  updateTemporaryButtons();
}
function showHeatingTestResult(result) {
  heatingResults.set(result.command === 'circulation' ? 'dhwr-message' : 'heating-test-message', result);
  const failed = result.status === 'failed' || !result.sent;
  const message = $(result.command === 'circulation' ? 'dhwr-message' : 'heating-test-message');
  const confirmation = result.command === 'circulation' && lastStatus?.dhwr?.feedback?.stateConfigured === false
    ? 'Circulation feedback is not configured.' : 'Waiting for a new device report to verify the request.';
  message.classList.toggle('form-error', failed);
  message.textContent = failed
    ? `${heatingCommandLabel(result.command)} · ${result.error ?? 'The MQTT command could not be confirmed as sent.'}`
    : `${heatingCommandLabel(result.command)} sent at ${time(result.at)}. ${result.confirmed === true ? 'Device confirmed.' : confirmation}`;
  if (!failed && result.command !== 'circulation') {
    const holdUntil = result.holdUntil;
    message.textContent += holdUntil
      ? ` This setting is held until ${time(holdUntil)} or Resume now, then the previous settings are restored. Automatic price control then resumes if enabled.`
      : ' If not paused, the previous settings return on the controller’s next update, normally within 1 minute. Automatic price control then resumes if enabled.';
  }
  if (!failed && result.command === 'circulation') message.textContent += ` Circulation runs for ${lastStatus?.dhwr?.durationMinutes ?? 10} minutes from this click, including while price control is paused. Stop ends it immediately.`;
}
function showControlError(id, text) {
  controlErrors.set(id, Date.now() + 60_000);
  $(id).classList.add('form-error');
  $(id).textContent = text;
}
function clearControlMessage(id) {
  if (controlErrors.get(id) > Date.now()) return false;
  controlErrors.delete(id);
  $(id).textContent = '';
  $(id).classList.remove('form-error');
  return true;
}
function renderHeatingTests(s) {
  const capability = s.heatingTests;
  const actual = s.observations?.actual;
  const phase = actual?.requestedPhase ?? actual?.phase ?? actual?.mode;
  const current = actual?.requestedPhase || actual?.stale !== true && (actual?.verified === true || actual?.source === 'mqtt-request');
  const selected = current ? ({ normal: 'test-normal', recovery: 'test-normal',
    preheat: 'test-preheat', reduction: 'test-reduction' })[phase] : null;
  for (const [id, name] of [['test-normal', 'Normal heating'], ['test-preheat', 'Preheat'], ['test-reduction', 'Reduced heating']]) {
    const button = $(id), state = id === selected ? actual.stale !== true && actual.verified === true && (actual.phase ?? actual.mode) === phase ? 'Active' : 'Requested' : '';
    button.setAttribute('aria-pressed', String(id === selected));
    button.setAttribute('aria-label', `${name}${state ? ` · ${state}${state === 'Requested' ? ', awaiting device confirmation' : ''}` : ''}`);
    button.dataset.modeState = state.toLowerCase();
    button.querySelector('.heating-button-state').textContent = state ? '✓' : '';
  }
  $('heating-test-help').textContent = isReadOnlyReplica(s) ? 'Device commands are disabled. Recorded history cannot confirm the current heating state.' : s.override?.expiresAt > s.now
    ? `Changes are held until ${time(s.override.expiresAt)} or Resume now, then the previous settings return.`
    : 'Changes reset on the next controller update, normally within 1 minute. Pause price control to hold them longer.';
  $('heating-preheat-help').hidden = true;
  $('heating-preheat-help').textContent = capability?.preheatAvailable === true ? ''
    : capability?.preheatReason || 'Preheating needs a connected heat pump, a fresh writable ROOM setting and qualified floor-valve control when configured.';
  $('test-preheat').title = capability?.preheatAvailable === true
    ? `Request ROOM ${decimal(capability.preheatTargetC)} °C, ${decimal(capability.preheatRoomBoostC)} °C above the saved normal setting${s.preheatValves?.enabled ? ', with the pooled floor override' : ''}. Native limits bound the increase; repeated commands do not stack it. Normal recirculation keeps its own schedule.`
    : $('heating-preheat-help').textContent;
  const warning = homeHeatingWarning(s, time);
  $('home-hold-warning').hidden = !warning;
  $('home-hold-warning').textContent = warning;
  const garageWarning = garageHeatingWarning(s, time);
  const held = [warning && `Home settings held until ${time(s.decision.manualHold.until)}`,
    garageWarning && `Garage heating ${s.garage.heatingControls.requestedMode === 'off' ? 'held off' : 'held'} until ${time(s.garage.heatingControls.holdUntil)}`].filter(Boolean);
  $('heating-held-summary').hidden = !held.length;
  $('heating-held-summary').textContent = `${held.join(' · ')}. Price control is paused; review the held settings below or select Resume now.`;
  setStatusDetail($('heating-test-status'), { key: 'manual-heating-availability', title: 'Heating control',
    label: capability?.available ? 'Control available' : 'Control unavailable', detail: capability?.available
      ? 'Requests are sent over MQTT. The reported state updates when device feedback arrives.'
      : capability?.reason || 'Manual heating control is unavailable in this installation.' });
  if (!heatingTestBusy) {
    if (capability?.lastResult) heatingResults.set(capability.lastResult.command === 'circulation'
      ? 'dhwr-message' : 'heating-test-message', capability.lastResult);
    for (const id of ['heating-test-message', 'dhwr-message']) {
      clearControlMessage(id);
      const result = heatingResults.has(id) ? heatingRequestResult(s, heatingResults.get(id)) : null;
      if (result && !controlErrors.has(id)) showHeatingTestResult(result);
      if (!result) heatingResults.delete(id);
    }
    if (!controlErrors.has('heating-test-message') && (s.execution?.restorationPending
      || s.preheatValves?.restorationPending)) $('heating-test-message').textContent = 'Restoring previous heating settings. Waiting for device confirmation.';
    if (!controlErrors.has('dhwr-message')) {
      if (s.dhwr?.restorationPending) $('dhwr-message').textContent = 'Stopping circulation. Restoration is still pending.';
      else if (circulationStopPending(s, circulationStopAt)) $('dhwr-message').textContent = 'Stop sent. Waiting for a new device report to verify the request.';
      else circulationStopAt = undefined;
    }
  }
}
function renderProviderSeries(root, rows, { datasets = false } = {}) {
  let list = root.querySelector('.provider-series');
  if (!list) { list = document.createElement('ul'); root.append(list); }
  list.className = `provider-series${rows.some(row => row.state) ? ' provider-series-live' : ''}`;
  const keys = new Set(rows.map(row => row.signals.join(',')));
  for (const item of [...list.children]) if (!keys.has(item.dataset.series)) item.remove();
  for (const [index, row] of rows.entries()) {
    const key = row.signals.join(',');
    let item = [...list.children].find(item => item.dataset.series === key);
    if (!item) {
      item = document.createElement('li'); item.dataset.series = key;
      item.append(document.createElement('strong'), document.createElement('span'), document.createElement('small'), document.createElement('p'));
    }
    if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
    item.dataset.state = row.tone ?? 'pending';
    if (row.state) item.setAttribute('aria-label', `${row.label}: ${row.value ?? row.state}${row.value ? `, ${row.state}` : ''}`);
    const title = item.children[0], value = item.children[1], source = item.children[2], description = item.children[3];
    title.textContent = `${row.label}${!datasets && row.unit ? ` · ${row.unit}` : ''}`;
    if (row.state) {
      value.className = 'provider-series-value';
      setStatusDetail(value, { key: `${datasets ? 'dataset' : 'provider-series'}-${key}`,
        label: datasets && row.value && row.value !== row.state ? `${row.value} · ${row.state}` : row.value ?? row.state,
        title: row.label, detail: `${row.state}. ${row.statusDetail ? `${row.statusDetail} ` : ''}${row.detail}${row.source ? ` Source: ${row.source}.` : ''}` });
      source.className = 'provider-series-source';
      source.textContent = datasets ? [row.source, row.unit && !row.value ? row.unit : '', row.reported].filter(Boolean).join(' · ') : row.source ?? '';
      source.hidden = !source.textContent;
    } else {
      value.className = 'provider-series-description';
      value.textContent = `${row.detail}${row.source ? ` Source: ${row.source}.` : ''}`;
      source.hidden = true;
    }
    description.className = 'provider-series-description';
    description.textContent = row.description ?? '';
    description.hidden = !description.textContent;
  }
}
function renderProviders(s) {
  const marketSource = providerName(s.providers?.market?.source), weatherSource = providerName(s.providers?.weather?.source);
  $('price-status').textContent = `${priceStatuses[s.priceStatus] ?? 'Price status unavailable'}${marketSource ? ` · ${marketSource}` : ''}`;
  $('weather-status').textContent = `${weatherStatuses[s.weatherStatus] ?? 'Weather status unavailable'}${weatherSource ? ` · ${weatherSource}` : ''}`;
  const entries = dashboardProviders(s, { now: s.now, formatTime: time });
  const list = $('providers'), retained = new Set(entries.map(({ key }) => key));
  for (const row of [...list.children]) if (!retained.has(row.dataset.provider)) row.remove();
  let attentionCount = 0, backupCount = 0;
  for (const [index, entry] of entries.entries()) {
    const { key, display, backup, overviewTitle, source: sourceLabel, sourceStates } = entry;
    if (display.attention) attentionCount++;
    if (backup) backupCount++;
    let row = [...list.children].find(row => row.dataset.provider === key);
    if (!row) {
      row = document.createElement('li'); row.className = 'source-overview';
      row.dataset.provider = key; row.dataset.sourceKey = key;
      const fold = document.createElement('details'); fold.className = 'provider-fold';
      const summary = document.createElement('summary');
      const heading = document.createElement('span'); heading.className = 'provider-heading';
      const title = document.createElement('strong'); title.className = 'provider-category-title';
      const state = document.createElement('span'); state.className = 'provider-category-state';
      const meta = document.createElement('small'); meta.className = 'provider-category-meta';
      heading.append(title, state, meta); summary.append(heading);
      const body = document.createElement('div'); body.className = 'provider-body';
      const introduction = document.createElement('p'); introduction.className = 'muted provider-introduction';
      const detail = document.createElement('p'); detail.className = 'muted provider-health';
      const local = document.createElement('details'); local.className = 'provider-local-connection provider-detail-fold';
      const localTitle = document.createElement('summary'); localTitle.textContent = 'Local connection & charging control';
      const localRows = document.createElement('dl');
      for (const [name, label] of [['setup', 'Charger setup'], ['readings', 'Local readings']]) {
        const term = document.createElement('dt'), value = document.createElement('dd');
        term.textContent = label; value.dataset.localConnection = name; localRows.append(term, value);
      }
      const endpoint = document.createElement('p'); endpoint.className = 'provider-local-endpoint';
      const localHelp = document.createElement('p'); localHelp.className = 'provider-local-help';
      const localBackup = document.createElement('p'); localBackup.className = 'provider-local-backup';
      const localOutage = document.createElement('p'); localOutage.className = 'provider-local-outage';
      const adopt = document.createElement('button'); adopt.type = 'button'; adopt.setAttribute('data-admin-only', ''); adopt.className = 'secondary-button provider-local-adopt';
      adopt.textContent = 'Set up local connection'; adopt.addEventListener('click', adoptOcppSetup);
      const accessNote = document.createElement('p'); accessNote.className = 'family-access-note';
      accessNote.textContent = 'Admin access is required to set up the local connection.';
      const localMessage = document.createElement('p'); localMessage.className = 'provider-local-message';
      localMessage.setAttribute('role', 'status'); localMessage.setAttribute('aria-live', 'polite');
      local.append(localTitle, localRows, endpoint, localHelp, localBackup, localOutage, adopt, accessNote, localMessage);
      const readings = document.createElement('div'); readings.className = 'provider-series-content';
      const sections = document.createElement('div'); sections.className = 'provider-source-sections';
      body.append(introduction, detail, sections);
      if (key === 'electricity') body.append(local);
      body.append(readings); fold.append(summary, body); row.append(fold);
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    row.dataset.state = display.attention ? 'attention' : backup ? 'backup'
      : display.state === 'Available' ? 'available' : 'pending';
    row.querySelector('.provider-category-title').textContent = overviewTitle;
    const state = row.querySelector('.provider-category-state');
    state.dataset.state = row.dataset.state;
    setStatusDetail(state, { key: `provider-overview-${key}`, label: display.state, title: overviewTitle, detail: display.detail });
    const source = row.querySelector('.provider-category-meta');
    source.replaceChildren();
    for (const [sourceIndex, sourceEntry] of (sourceStates?.length ? sourceStates : [{ label: sourceLabel, tone: row.dataset.state, state: display.state }]).entries()) {
      if (sourceIndex) source.append(document.createTextNode(', '));
      const name = document.createElement('span'); name.className = 'provider-name'; name.dataset.state = sourceEntry.tone;
      name.textContent = sourceEntry.label; name.title = `${sourceEntry.label}: ${sourceEntry.state}`;
      name.setAttribute('aria-label', name.title); source.append(name);
    }
    row.querySelector('.provider-introduction').textContent = entry.introduction;
    const health = row.querySelector('.provider-health');
    health.hidden = key === 'vehicle-telemetry';
    setStatusDetail(health, { key: `provider-health-${key}`,
      label: 'Source details', title: overviewTitle, detail: `${display.state}. ${display.detail}` });
    const local = row.querySelector('.provider-local-connection');
    if (local) local.hidden = !entry.localConnection;
    if (entry.localConnection) {
      const connection = entry.localConnection;
      for (const name of ['setup', 'readings']) {
        const value = local.querySelector(`[data-local-connection=${name}]`), status = connection[name];
        value.dataset.state = status.tone;
        setStatusDetail(value, { key: `easee-local-${name}`, label: status.label,
          title: name === 'setup' ? 'Charger setup' : 'Local readings', detail: status.detail });
      }
      local.querySelector('.provider-local-endpoint').textContent = `${connection.endpoint}. ${connection.setup.detail}`;
      local.querySelector('.provider-local-help').textContent = connection.detail;
      const backup = local.querySelector('.provider-local-backup');
      const backupTitle = document.createElement('strong'); backupTitle.textContent = 'Cloud backup. ';
      backup.replaceChildren(backupTitle, document.createTextNode('Available cloud readings can replace missing local readings. Charging authorization stays with OCPP until cloud control is restored.'));
      const outage = local.querySelector('.provider-local-outage');
      const outageTitle = document.createElement('strong'); outageTitle.textContent = 'If the controller stops. ';
      outage.replaceChildren(outageTitle, document.createTextNode(connection.outage));
      if (s.providers?.easee?.localOcpp?.setup?.state === 'ready') {
        const message = local.querySelector('.provider-local-message');
        message.textContent = ''; message.classList.remove('form-error');
      }
      const adopt = local.querySelector('.provider-local-adopt');
      adopt.hidden = ocppSetupRevision(s) === null;
      local.querySelector('.family-access-note').hidden = adopt.hidden;
      adopt.disabled = adopt.hidden || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy;
    }
    const sections = row.querySelector('.provider-source-sections');
    for (const existing of [...sections.children]) if (!entry.sections?.some(section => section.key === existing.dataset.sourceSection)) existing.remove();
    for (const [sectionIndex, section] of (entry.sections ?? []).entries()) {
      let content = [...sections.children].find(node => node.dataset.sourceSection === section.key);
      if (!content) {
        content = document.createElement('section'); content.className = 'provider-source-section'; content.dataset.sourceSection = section.key;
        const heading = document.createElement('h4'); heading.className = 'provider-source-title';
        const description = document.createElement('p'); description.className = 'muted provider-source-description';
        const readings = document.createElement('div'); readings.className = 'provider-source-readings';
        content.append(heading, description, readings); sections.append(content);
      }
      if (sections.children[sectionIndex] !== content) sections.insertBefore(content, sections.children[sectionIndex] ?? null);
      content.querySelector('.provider-source-title').textContent = section.title;
      content.querySelector('.provider-source-description').textContent = section.description;
      const sectionReadings = content.querySelector('.provider-source-readings');
      renderProviderSeries(sectionReadings, section.datasets, { datasets: true });
      if (section.key === 'easee-ocpp' && local.nextElementSibling !== sectionReadings) content.insertBefore(local, sectionReadings);
    }
    const readings = row.querySelector('.provider-series-content');
    readings.hidden = Boolean(entry.sections?.length);
    renderProviderSeries(readings, entry.sections?.length ? [] : entry.datasets ?? entry.series, { datasets: true });
  }
  $('provider-overview-state').textContent = isReadOnlyReplica(s) ? 'Recorded data · view only' : attentionCount ? `${attentionCount} ${attentionCount === 1 ? 'needs' : 'need'} attention`
    : backupCount ? `${backupCount} using backup` : entries.length ? `${entries.length} data feeds`
      : s.input === 'simulated' ? 'Simulation' : 'No live sources';
  $('provider-overview-state').classList.toggle('stale', attentionCount > 0 || backupCount > 0);
  const note = $('provider-context');
  note.textContent = isReadOnlyReplica(s) ? 'Recorded provider information. Live connections are not opened by this computer.' : s.input === 'simulated' ? 'Example prices and weather are in use. Live providers are not polled.'
    : s.input === 'offline' ? 'Recorded history is available. Live providers are not polled.' : entries.length ? '' : 'Waiting for provider status.';
  note.hidden = !note.textContent;
}
function renderLearning(s) {
  const display = learningDisplay(s.learning, { settings: s.settings, preheatValves: s.preheatValves });
  const overview = learningOverview(s.learning);
  const garageOverview = garageLearningOverview(s.garage?.learning);
  for (const [prefix, model, metrics] of [
    ['learning', overview, [[overview.usableSamples, 'usable temperature intervals'], [overview.acceptedFits, 'accepted model updates']]],
    ['garage-learning', garageOverview, [[garageOverview.completedEpisodes, 'completed cooling / recovery episodes'], [garageOverview.validatedOffHours, 'OFF hours covered by validation']]],
  ]) {
    $(`${prefix}-title`).textContent = model.title;
    $(`${prefix}-overview`).textContent = model.summary;
    const progress = $(`${prefix}-progress`); progress.replaceChildren();
    for (const [value, label] of metrics) {
      const item = document.createElement('p'), count = document.createElement('strong'), caption = document.createElement('span');
      count.textContent = decimal(value); caption.textContent = label;
      item.append(count, document.createTextNode(' '), caption); progress.append(item);
    }
  }
  $('learning-detail').textContent = display.message;
  $('learning-process').textContent = display.process;
  renderLearningRows($('learning-metrics'), display.metrics);
  renderLearningRows($('learning-evidence'), display.evidenceRows);
  $('learning-history').textContent = display.history;
  $('coefficient-context').textContent = display.coefficientHistory;
  renderLearningRows($('model-coefficients-content'), display.coefficients.length ? display.coefficients : [{
    key: 'unavailable', title: 'Thermal coefficients', value: 'Unavailable', available: false,
    detail: 'Current model coefficients have not been received yet.',
  }]);
  renderLearningRows($('coefficient-evidence'), display.coefficientEvidenceRows);
  renderLearningRows($('home-policy-content'), display.policyRows);
  $('savings').textContent = s.savings?.explanation ?? 'Cycle profit is a model comparison after recovery; electricity bills alone cannot isolate what normal heating would have cost.';
}
function updateH66Selector({ useReadback = false } = {}) {
  const register = $('h66-test-register').value, control = h66Control(lastStatus?.h66, register), mode = register === '2201';
  $('h66-test-temperature-field').hidden = mode;
  $('h66-test-mode-field').hidden = !mode;
  $('h66-test-value').hidden = mode; $('h66-test-value').disabled = mode;
  $('h66-test-mode').hidden = !mode; $('h66-test-mode').disabled = !mode;
  $('h66-test-value').min = control.min ?? 10; $('h66-test-value').max = control.max ?? 65;
  if (useReadback) {
    const current = lastStatus?.h66?.readings?.[register]?.value;
    if (mode) $('h66-test-mode').value = [1, 2, 4].includes(current) ? current : 1;
    else $('h66-test-value').value = Number.isFinite(current) ? current : register === '0208' ? 50 : register === '0212' ? 40 : 20;
  }
  const reading = lastStatus?.h66?.readings?.[register];
  const health = h66ReadingStatus(lastStatus?.h66 ?? {}, reading, { now: lastStatus?.now });
  setStatusDetail($('h66-manual-state'), { key: 'h66-manual-state', title: control.label ?? 'Heat-pump setting',
    label: health.usable ? h66ReadingValue(register, reading) : 'Unavailable', detail: health.detail });
  $('h66-manual-state').classList.toggle('stale', !health.usable);
  $('h66-test-status').textContent = control.available
    ? `${control.label}. Remains as the pump’s setting until changed again. Automatic heating adjustments return to this setting when they end.`
    : control.reason;
  updateTemporaryButtons();
}
function showH66Test(result) {
  const failure = ['failed', 'unconfirmed'].includes(result?.status) || result?.error;
  $('h66-test-message').classList.toggle('form-error', Boolean(failure));
  const register = result?.register;
  $('h66-test-message').textContent = result ? [h66Registers[register]?.label ?? register,
    label(result.status ?? 'requested'), result.value != null ? `requested ${result.value}` : '',
    result.readback != null ? `readback ${result.readback}` : '',
    result.previousValue != null ? `previously ${result.previousValue}` : '',
    result.confirmed === true ? 'device confirmed' : result.sent ? 'awaiting device confirmation' : '', result.error ?? result.reason ?? label(result.code ?? '')].filter(Boolean).join(' · ') : '';
  if (result?.sent && !failure) $('h66-test-message').textContent += ' · Remains as the pump’s setting until changed again.';
}
function renderH66TestResult(s) {
  if (h66TestBusy || !clearControlMessage('h66-test-message')) return;
  const result = h66RequestResult(s), last = s.h66?.lastManual;
  const key = last && JSON.stringify([last.at, last.register, last.value, last.pauseId]);
  if (last?.status === 'confirmed' && !result) dismissedH66Request = key;
  showH66Test(key === dismissedH66Request ? null : result);
}
function renderH66(s) {
  const h66 = s.h66 ?? {}, summary = h66HomeSummary(s), root = $('home-h66-summary');
  const tariff = summary.find(row => row.key === 'tariff');
  setStatusDetail($('tariff-control-state'), { key: 'home-tariff-control', label: tariff.value,
    title: tariff.title, detail: tariff.detail });
  for (const key of ['mode']) {
    const row = summary.find(row => row.key === key);
    let detail = root.querySelector(`[data-h66-summary=${key}]`);
    if (!detail) {
      detail = document.createElement('div'); detail.className = 'home-state-reading'; detail.dataset.h66Summary = key;
      detail.append(document.createElement('span'), document.createElement('strong')); root.append(detail);
    }
    const [title, value] = detail.children;
    title.textContent = 'Heat-pump mode';
    value.classList.toggle('muted', !row.available);
    setStatusDetail(value, { key: `home-h66-${key}`, label: row.available ? row.value : 'Unavailable',
      title: title.textContent, detail: row.detail });
  }
  const pumpReadings = h66EquipmentSummary(s);
  for (const row of pumpReadings) {
    const equipmentValue = $(`home-pump-${row.key}`);
    const state = row.key === 'state' && row.available ? row.value.match(/^(Running|Idle)(?: (for .+))?$/) : null;
    equipmentValue.classList.toggle('muted', !row.available);
    equipmentValue.textContent = row.available ? state?.[1] ?? row.value : '—';
    if (row.key === 'state') {
      const age = $('home-pump-state-age'); age.textContent = state?.[2] ?? ''; age.hidden = !age.textContent;
    }
  }
  setStatusDetail($('home-pump-reading-info'), { key: 'home-pump-readings', label: 'Reading details', title: 'Ground-source heat-pump readings',
    detail: [h66.reason, ...pumpReadings.map(row => `${row.title}: ${row.detail}`)].filter(Boolean).join('\n\n') });
  let notice = root.querySelector('.equipment-alarm');
  const alarm = summary.find(row => row.key === 'alarm');
  if (alarm?.available && alarm.value === 'Alarm active') {
    if (!notice) { notice = document.createElement('p'); notice.className = 'equipment-alarm'; root.append(notice); }
    notice.textContent = 'Heat-pump alarm active';
  } else notice?.remove();
  $('home-pump-health').textContent = isReadOnlyReplica(s) ? 'Recorded snapshot' : h66.connected ? 'Connected' : h66.brokerConnected ? 'Awaiting readings' : 'Not connected';
  $('home-pump-health').dataset.state = isReadOnlyReplica(s) ? 'pending' : h66.connected ? 'available' : 'attention';
  $('h66-context').hidden = !h66.restorationPending;
  $('h66-context').textContent = h66.restorationPending
    ? 'Restoring previous H66 settings. Waiting for fresh values from the pump to confirm restoration.' : '';
  const readings = h66.readings ?? {};
  const groups = [...h66ReadingGroups, { label: 'Other readings', readings: Object.keys(readings)
    .filter(register => !Object.hasOwn(h66Registers, register)).map(register => [register, {
      label: label(readings[register]?.signal ?? `Register ${register}`), description: 'Additional reading reported by the heat pump.',
    }]) }].filter(group => group.readings.length);
  const readingsRoot = $('h66-readings');
  for (const table of [...readingsRoot.children]) if (!groups.some(group => group.label === table.dataset.group)) table.remove();
  for (const group of groups) {
    let table = [...readingsRoot.children].find(table => table.dataset.group === group.label);
    if (!table) {
      table = document.createElement('table'); table.className = 'h66-table'; table.dataset.group = group.label;
      const caption = document.createElement('caption'); caption.textContent = group.label;
      table.append(caption, document.createElement('tbody')); readingsRoot.append(table);
    }
    const body = table.querySelector('tbody');
    for (const row of [...body.children]) if (!group.readings.some(([register]) => register === row.dataset.register)) row.remove();
    for (const [index, [register, metadata]] of group.readings.entries()) {
      const reading = readings[register];
      let row = [...body.children].find(row => row.dataset.register === register);
      if (!row) {
        row = document.createElement('tr'); row.dataset.register = register;
        const title = document.createElement('th'); title.scope = 'row';
        const description = document.createElement('small'); description.className = 'h66-reading-description';
        title.append(document.createElement('span'), description);
        row.append(title, document.createElement('td'));
      }
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] ?? null);
      const [title, value] = row.children;
      title.children[0].textContent = metadata.label;
      title.children[1].textContent = metadata.description;
      const availability = h66ReadingStatus(h66, reading, { now: s.now });
      const recorded = isReadOnlyReplica(s) && Number.isFinite(reading?.value)
        && !(reading.quality ?? []).some(flag => /invalid|unknown|unsupported|sentinel/i.test(flag));
      const valueLabel = availability.usable ? h66ReadingValue(register, reading) : recorded ? `${h66ReadingValue(register, reading)} · recorded` : 'Unavailable';
      value.classList.toggle('stale', !availability.usable);
      const settingDetails = [];
      if (Number.isFinite(reading?.requested)) settingDetails.push(`Requested by this controller: ${h66ReadingValue(register, { ...reading, value: reading.requested })}.`);
      if (Number.isFinite(reading?.baseline)) settingDetails.push(`Original setting: ${h66ReadingValue(register, { ...reading, value: reading.baseline })}.`);
      const timestamp = reading?.receivedAt ?? reading?.at;
      const received = timestamp != null && Number.isFinite(new Date(timestamp).getTime()) ? time(timestamp) : null;
      setStatusDetail(value, { key: `h66-reading-${register}`, label: valueLabel, title: metadata.label,
        detail: [metadata.description, `${availability.detail}${!availability.usable && Number.isFinite(reading?.value)
          ? ` Last reported value: ${h66ReadingValue(register, reading)}.` : ''}${received ? ` Received ${received}.` : ''}`,
        ...settingDetails].join('\n\n') });
    }
  }
  updateH66Selector();
  renderH66TestResult(s);
}
function render(s) {
  if (session.locked) return;
  webAccess = s.webAccess ?? webAccess;
  accessControls.update(webAccess);
  document.body.dataset.authenticated = 'true';
  $('auth').hidden = true;
  $('fireplace-family-help').hidden = webAccess?.role !== 'family';
  lastStatus = s;
  readOnlyControls.update(s);
  garageControls.update(s);
  mitsubishiControls.update(s);
  chargingPanel.update(s);
  $('error').hidden = true;
  pairPanel.update(pairPanelView(s));
  const replica = renderReplicaStatus(document, s, { formatTime: time });
  renderHomePlannedChange(document, s);
  sensorChangePanel.update(isReadOnlyReplica(s) ? { ...s.sensorChanges, available: false, readOnly: true } : s.sensorChanges);
  $('connection').textContent = `${s.input === 'simulated' ? 'SIMULATION' : s.liveWrites ? 'LIVE CONTROL' : s.input !== 'offline' ? 'LIVE OBSERVATION' : 'READ-ONLY'} · ${(s.mode ?? 'monitoring').toUpperCase()}`;
  $('context').textContent = s.input === 'simulated' ? 'Simulated devices and example prices. This workspace sends no commands to your home.'
    : s.input === 'offline' ? 'Imported household history. No live device connection is open.'
      : s.liveWrites ? 'Learning from the house and controlling heating through preheating, reduction and recovery.'
        : 'Observing the house and planning heating. This operating mode sends no automatic commands.';
  for (const key of ['indoor', 'outdoor']) {
    const obs = s.observations?.[key] ?? {};
    const readingStatus = temperatureReadingStatus(obs, { now: s.now, formatTime: time, outdoor: key === 'outdoor' });
    const title = key === 'indoor' ? 'Indoor average' : 'Outdoor temperature';
    const source = key === 'outdoor' ? outdoorSourceLabel(obs.source) : providerName(obs.source);
    setStatusDetail($(key), { key: `metric-${key}`, label: readingStatus.usable ? `${obs.value.toFixed(1)} °C` : 'Unavailable',
      title, detail: [source, readingStatus.detail].filter(Boolean).join('. ') });
    $(key).classList.toggle('stale', !readingStatus.usable || readingStatus.attention);
    $(key).classList.toggle('metric-unavailable', !readingStatus.usable);
    const note = $(`${key}-age`);
    note.hidden = readingStatus.usable && !readingStatus.attention;
    note.textContent = note.hidden ? '' : readingStatus.attention ? 'Needs attention'
      : obs.configured === false ? 'Not configured' : 'No current reading';
  }
  const manualHold = s.decision.manualHold?.until > s.now ? s.decision.manualHold : null;
  const requested = label(manualHold?.phase ?? s.observations?.actual?.requestedPhase ?? s.decision.phase ?? (s.decision.action === 'normal' ? 'Normal' : 'Reduction')).replace(/^./, value => value.toUpperCase())
    + (manualHold ? ' · held' : '');
  const controlMode = replica ? 'Recorded controller decision · current control state unavailable' : s.mode === 'monitoring' ? 'Monitoring · no automatic commands'
    : s.input === 'simulated' && s.mode === 'active' ? 'Simulation · applying this plan'
      : s.input === 'simulated' ? 'Simulation · shadow plan' : s.liveWrites
        ? manualHold ? 'Active · holding manual heating settings' : 'Active · applying the heating plan'
        : 'Shadow plan · no automatic commands';
  const decisionTitle = manualHold
    ? 'Manual heating selection held'
    : ({ normal: 'Normal heating is available', preheat: 'Building heat reserve before the reduction', reduction: 'Reducing heating during the selected interval', recovery: 'Recovering the house’s heat reserve' })[s.decision.phase ?? s.decision.action] ?? 'Heating plan';
  const heldMode = ({ normal: 'Normal heating', preheat: 'Preheat', reduction: 'Reduced heating', recovery: 'Recovery heating' })[manualHold?.phase] ?? 'Your selected heating mode';
  const decisionReasons = manualHold
    ? `Price control is paused. ${heldMode} is held until ${time(manualHold.until)} or Resume now, then temporary heating changes are restored. Heat-pump parameter edits remain in effect. Automatic price control then resumes if enabled.`
    : (s.decision.reasons ?? []).map(r => (reasons[r] ?? label(typeof r === 'string' ? r : r.message ?? r.code))
      .trim().replace(/^./, value => value.toUpperCase())).join('. ');
  const recoveryDetail = !manualHold && s.decision.phase === 'recovery'
    ? `${s.decision.recoveryCompressorOnly ? 'Compressor-only recovery is requested' : 'Native recovery settings apply'}${s.decision.recoveryFallbackReason ? ` · ${label(s.decision.recoveryFallbackReason)}` : ''}.` : '';
  setHeatingStatusDetail($('requested'), { key: 'home-heating-request', label: requested, title: 'Home heating request',
    confirmation: homeHeatingConfirmation(s),
    detail: [controlMode, decisionTitle, decisionReasons, recoveryDetail].filter(Boolean).join('\n\n') });
  renderCurrentPrice(document, s);
  renderContract(s); renderProviders(s); renderH66(s); equipmentPanel.update(s); renderFloorPreheat(document, s); renderGarage(document, s);
  if ($('recording-details')?.open) renderRecording(s,$('recording-content'));
  const temporary = temporaryValues(s);
  const controlPrice = priceControlState(s, { paused: Boolean(temporary.pauseUntilLocal), away: Boolean(temporary.awayUntilLocal) });
  $('control-price').textContent = controlPrice.label;
  $('control-price').parentElement.dataset.state = controlPrice.state;
  const dhwr = dhwrReadingSummary(s);
  $('dhwr').textContent = dhwr.summary;
  $('dhwr').classList.toggle('stale', dhwr.attention);
  const reference = s.decision.comfort?.targetC ?? s.settings?.comfort?.targetC;
  const referenceSource = s.decision.comfort?.source === 'explicit-setting' || s.settings?.comfort?.targetC != null ? 'configured' : 'learned';
  $('reference').textContent = s.demoComfortTargetC ? `${s.demoComfortTargetC} °C` : Number.isFinite(reference) ? `${Number(reference).toFixed(1)} °C` : replica ? 'Unavailable' : 'Learning';
  $('reference').dataset.empty = !s.demoComfortTargetC && !Number.isFinite(reference);
  $('reference-source').textContent = s.demoComfortTargetC ? 'Demo reference only' : Number.isFinite(reference) ? `${referenceSource === 'learned' ? 'Learned' : 'Configured'} normal temperature` : replica ? 'No recorded normal temperature' : 'Normal temperature not established';
  renderHomePolicy(document, s);
  $('home-policy-current-title').textContent = `${replica ? 'Recorded plan' : manualHold ? 'Held request' : 'Current plan'} · ${label(manualHold?.phase ?? s.decision.phase ?? s.decision.action ?? 'Unavailable')}`;
  $('home-policy-current-detail').textContent = [controlMode, decisionReasons, recoveryDetail].filter(Boolean).join(' · ');
  $('drop').textContent = `${s.settings?.comfort?.maxDropC} °C`;
  $('drop-note').textContent = s.decision.comfort?.maxDropApplies === false ? 'Inactive while you are away' : 'When you are home';
  $('rise-note').textContent = $('drop-note').textContent;
  renderHomeRoomReferences(document, s);
  renderLearning(s);
  const scope = settingsReloadScope(s);
  $('settings-reload-help').textContent = replica ? 'Applying configuration is disabled in this read-only view.' : scope.message;
  $('settings-read-only-source').hidden = !replica;
  $('settings-read-only-source').textContent = s.readView?.configurationMessage ?? 'Settings are shown for inspection. Changes are disabled until this computer becomes master.';
  $('settings-location-title').textContent = scope.location.title;
  $('settings-location').replaceChildren();
  for (const { label, value } of scope.location.rows) {
    const term = document.createElement('dt'), description = document.createElement('dd'), path = document.createElement('code');
    term.textContent = label; path.textContent = value; description.append(path); $('settings-location').append(term, description);
  }
  $('settings-location-message').textContent = scope.location.message;
  $('settings-location-message').hidden = !scope.location.message;
  $('settings-configuration-steps').replaceChildren();
  for (const text of scope.instructions) {
    const item = document.createElement('li'); item.textContent = text; $('settings-configuration-steps').append(item);
  }
  $('settings-access').textContent = scope.access.join(' ');
  const cleanupPending = s.settingsReload?.result?.cleanupPending === true;
  $('settings-import-warning').hidden = !cleanupPending;
  $('settings-import-warning').textContent = cleanupPending
    ? 'Configuration applied, but the uploaded secrets.json could not be removed. Delete it from the upload location shown above.' : '';
  $('settings-reload-scope').replaceChildren();
  for (const [title, items] of [['Applies without restart', scope.reloadable], ['Requires restart', scope.restartRequired]]) {
    const group = document.createElement('div'), heading = document.createElement('h3'), list = document.createElement('ul');
    heading.textContent = title;
    for (const text of items) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
    group.append(heading, list); $('settings-reload-scope').append(group);
  }
  renderTemporary(s); renderHeatingTests(s);
  fireplacePanel.update(replica ? { ...s.fireplace, available: false, readOnly: true } : s.fireplace, s.now);
  $('updated').textContent = `Updated ${time(s.now)}`;
  readOnlyControls.refresh();
  accessControls.refresh();
  return renderReplicaStatus(document, s, { formatTime: time });
}
const eventStream = createEventStream({ request: (after,options) => api(`/api/events?after=${after}&limit=50`,undefined,options),
  reset: () => $('events').replaceChildren(), append: rows => {
  for (const event of rows) {
    const li = document.createElement('li');
    const timestamp = document.createElement('time');
    timestamp.textContent = time(event.at);
    li.append(timestamp, document.createTextNode(`${label(event.type)} · ${JSON.stringify(event.payload)}`));
    $('events').prepend(li);
  }
  while ($('events').children.length > 100) $('events').lastChild.remove();
} });
const events = () => eventStream.poll();
const communication = createCommunicationWatch();
const requestStatus = createPollingRequest(options => api('/api/status',undefined,options));
function checkCommunication() {
  if (session.locked) return;
  const state = communication.status();
  $('connection').title = `Last successful status response: ${state.available ? `${Math.floor(state.ageMs/1000)} seconds ago` : 'not yet received'}.`;
  if (state.stale) $('connection').textContent = 'Monitoring is stale. Waiting for an installation status response.';
}
async function refresh({ forceChart = false, background = false } = {}) {
  if (session.locked) return;
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy) return;
  const request = requestStatus({ background });
  if (!request) return;
  const sequence = ++refreshSequence;
  try {
    const s = await request;
    if (sequence !== refreshSequence) return;
    communication.received();
    const replica = render(s);
    const snapshot = replica ? replicaSnapshotKey(s) ?? 'replica-unavailable' : 'master';
    const replaced = snapshot !== lastReplicaSnapshot;
    if (replaced) {
      eventStream.reset(snapshot); auditFetchedAt = 0;
      void refreshRecordingOverview({ force: true });
    }
    lastReplicaSnapshot = snapshot;
    if (replica && !replica.available) return;
    await Promise.all([historyChart.refresh(s, { force: forceChart || replaced }), events()]);
  } catch (error) { if (sequence === refreshSequence) { pairPanel.unavailable(); showError(error); } }
}
let pairPollBusy = false;
async function refreshPairing() {
  if (lastStatus?.topology !== 'pair' || pairPollBusy) return;
  pairPollBusy = true;
  try {
    const pair = await api('/api/pair');
    const previous = lastStatus.pair ?? {};
    const changed = pair.role !== previous.role || pair.canControl !== previous.canControl || Boolean(pair.transition) !== Boolean(previous.transition);
    lastStatus = { ...lastStatus, pair };
    readOnlyControls.update(lastStatus);
    garageDoors.update({ ...equipmentPanel.actions.snapshot(), status: lastStatus });
    pairPanel.update(pairPanelView(lastStatus));
    renderInstanceRole(document, lastStatus);
    if (isReadOnlyReplica(lastStatus)) {
      garageDoors.close(); fireplacePanel.close();
      renderReplicaStatus(document, lastStatus, { formatTime: time });
    }
    if (changed) await refresh({ forceChart: true });
  } catch { pairPanel.unavailable(); }
  finally { pairPollBusy = false; }
}
$('settings-reload').addEventListener('click', async () => {
  if (isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || !settingsReloadScope(lastStatus).available) return;
  settingsReloadBusy = true; ++refreshSequence;
  updateTemporaryButtons();
  $('settings-reload').setAttribute('aria-busy', 'true');
  $('settings-reload-message').classList.remove('form-error');
  $('settings-reload-message').textContent = 'Applying configuration and reconnecting providers…';
  try {
    const result = await api('/api/settings/reload', {});
    render(result);
    $('settings-reload-message').textContent = 'Configuration applied.';
  } catch (error) {
    $('settings-reload-message').classList.add('form-error');
    $('settings-reload-message').textContent = error.message;
  } finally {
    settingsReloadBusy = false;
    $('settings-reload').removeAttribute('aria-busy');
    updateTemporaryButtons();
  }
  await refresh({ forceChart: true });
});
$('auth').addEventListener('submit', event => {
  event.preventDefault();
  $('auth').setAttribute('aria-busy', 'true');
  $('auth').querySelector('[type="submit"]').disabled = true;
  session.login($('token').value); $('token').value = ''; passwordVisibility.hide();
  // A fresh document discards any previous login's pending forms and responses.
  window.location.reload();
});
$('token').addEventListener('input', () => {
  $('token').removeAttribute('aria-invalid');
  $('auth-error').textContent = '';
  $('auth-error').hidden = true;
});
$('web-logout').addEventListener('click', () => {
  lockScreen();
  window.location.reload();
});
for (const [field, id] of Object.entries(temporaryFields)) {
  const changed = () => {
    if ($(id).value === (lastStatus ? temporaryValues(lastStatus)[field] : '')) dirtyTemporary.delete(field);
    else dirtyTemporary.add(field);
    $('temporary-message').classList.remove('form-error');
    $('temporary-message').textContent = dirtyTemporary.size ? 'Changes are not applied yet.' : '';
    updateTemporaryButtons();
  };
  $(id).addEventListener('input', changed);
  $(id).addEventListener('change', changed);
}
async function applyTemporary(values) {
  if (!lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy) return;
  temporaryBusy = true;
  ++refreshSequence;
  updateTemporaryButtons();
  for (const id of Object.values(temporaryFields)) $(id).disabled = true;
  $('temporary-message').classList.remove('form-error');
  $('temporary-message').textContent = 'Applying…';
  try {
    const result = await api('/api/temporary', values);
    for (const field of Object.keys(values)) dirtyTemporary.delete(field);
    render(result);
    $('temporary-message').textContent = dirtyTemporary.size ? 'Applied. Other changes are not applied yet.' : 'Changes applied.';
    await events();
  } catch (error) {
    $('temporary-message').classList.add('form-error');
    $('temporary-message').textContent = error.message;
  } finally {
    temporaryBusy = false;
    for (const id of Object.values(temporaryFields)) $(id).disabled = false;
    updateTemporaryButtons();
  }
}
$('temporary-form').addEventListener('submit', event => {
  event.preventDefault();
  // Send only edited fields. An existing ambiguous autumn clock time may have
  // been set through the offset-aware API and must survive an unrelated edit.
  const values = Object.fromEntries([...dirtyTemporary].map(field => [field, $(temporaryFields[field]).value || null]));
  if (Object.keys(values).length) applyTemporary(values);
});
$('home-now').addEventListener('click', () => applyTemporary({ awayUntilLocal: null }));
$('resume-now').addEventListener('click', () => applyTemporary({ pauseUntilLocal: null }));
async function testHeating(command) {
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || !lastStatus?.heatingTests?.available) return;
  if (command === 'preheat' && lastStatus.heatingTests.preheatAvailable !== true) return;
  if (command !== 'circulation' && lastStatus.override?.expiresAt > lastStatus.now
    && !await confirmAction({ document, title: 'Change heating while price control is paused?',
      message: `${heatingCommandLabel(command)} will stay until ${time(lastStatus.override.expiresAt)} or Resume now. Room temperatures may change while automatic price control is paused. Previous settings return when the pause ends.`,
      action: `Apply ${heatingCommandLabel(command).toLowerCase()}` })) return;
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || isReadOnlyReplica(lastStatus)) return;
  heatingTestBusy = true;
  ++refreshSequence;
  updateTemporaryButtons();
  $('heating-test-buttons').setAttribute('aria-busy', 'true');
  const message = $(command === 'circulation' ? 'dhwr-message' : 'heating-test-message');
  controlErrors.delete(message.id);
  if (command === 'circulation') circulationStopAt = undefined;
  message.classList.remove('form-error');
  message.textContent = `Sending ${heatingCommandLabel(command)}…`;
  try {
    const result = await api('/api/heating-test', { command });
    showHeatingTestResult(result);
    // Keep the success visible even if the subsequent status refresh fails.
    if (lastStatus.heatingTests) lastStatus.heatingTests.lastResult = result;
  } catch (error) {
    showControlError(message.id, error.message);
  } finally {
    heatingTestBusy = false;
    $('heating-test-buttons').removeAttribute('aria-busy');
    updateTemporaryButtons();
  }
  await refresh();
}
for (const button of heatingTestButtons) button.addEventListener('click', () => testHeating(button.dataset.heatingCommand));
$('dhwr-stop').addEventListener('click', async () => {
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || isReadOnlyReplica(lastStatus) || !lastStatus?.heatingTests?.available) return;
  heatingTestBusy = true; ++refreshSequence; updateTemporaryButtons();
  controlErrors.delete('dhwr-message');
  $('dhwr-message').classList.remove('form-error');
  $('dhwr-message').textContent = 'Requesting circulation stop…';
  try {
    render(await api('/api/dhwr/stop', {}));
    circulationStopAt = lastStatus?.dhwr?.requestedAt ?? lastStatus.now;
    $('dhwr-message').textContent = lastStatus?.dhwr?.feedback?.stateConfigured === false
      ? 'Stop sent. Circulation feedback is not configured.' : 'Stop sent. Waiting for a new device report to verify the request.';
  }
  catch { showControlError('dhwr-message', 'Could not confirm the circulation stop request.'); }
  finally { heatingTestBusy = false; updateTemporaryButtons(); }
});
$('h66-test-register').addEventListener('change', () => updateH66Selector({ useReadback: true }));
$('h66-test-form').addEventListener('submit', async event => {
  event.preventDefault();
  const register = $('h66-test-register').value;
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy
    || isReadOnlyReplica(lastStatus) || !h66Control(lastStatus?.h66, register).available) return;
  h66TestBusy = true; ++refreshSequence; updateTemporaryButtons();
  controlErrors.delete('h66-test-message');
  $('h66-test-form').setAttribute('aria-busy', 'true');
  $('h66-test-message').classList.remove('form-error');
  $('h66-test-message').textContent = 'Applying heat-pump setting…';
  try {
    const result = await api('/api/equipment/h66', { register,
      value: Number($(register === '2201' ? 'h66-test-mode' : 'h66-test-value').value) });
    render(result);
    showH66Test(result.h66?.lastManual);
  } catch (error) {
    showControlError('h66-test-message', error.message);
  } finally {
    h66TestBusy = false; $('h66-test-form').removeAttribute('aria-busy'); updateTemporaryButtons();
  }
  await refresh();
});
const refreshRecordingOverview=recordingOverviewRefresh({request:api,root:$('recording-overview-content'),
  details:$('recording-overview-details'),parent:$('recording-details'),message:$('recording-overview-message'),button:$('recording-overview-refresh')});
bindDatabaseExport({ saveButton: $('database-export-save'), downloadButton: $('database-export-download'),
  message: $('database-export-message'), window, document,
  request: method => {
    assertWebRequest(webAccess, '/api/database-export', method === 'POST' ? {} : undefined, lastStatus);
    assertDashboardWrite('/api/database-export', method === 'POST' ? {} : undefined, lastStatus);
    return session.run(async ({ headers, signal }) => {
      const response = await fetch(applicationUrl('/api/database-export'), { method, signal,
        headers: { ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}) });
      if (response.status === 401) { lockScreen({ authenticationFailed: true }); throw new Error(authenticationMessage(ingress)); }
      return response;
    });
  } });
for (const [id, path, filename] of [
  ['floor-preheat-guide', '/api/downloads/floor-preheat-guide', 'floor-preheat.md'],
  ['floor-preheat-script', '/api/downloads/floor-lease-script', 'floor-lease.js'],
]) $(id).addEventListener('click', async () => {
  try {
    assertWebRequest(webAccess, path, undefined, lastStatus);
    const blob = await session.run(async ({ headers, signal }) => {
      const response = await fetch(applicationUrl(path), { headers, signal });
      if (response.status === 401) { lockScreen({ authenticationFailed: true }); throw new Error(authenticationMessage(ingress)); }
      if (!response.ok) throw new Error(response.status === 403 ? 'Admin required for downloads.' : 'Download failed. Please try again.');
      return response.blob();
    });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $('floor-download-message').textContent = 'Download ready.';
  } catch (error) { $('floor-download-message').textContent = error.message; }
});
$('recording-overview-details').addEventListener('toggle',()=>void refreshRecordingOverview());
$('recording-overview-refresh').addEventListener('click',()=>void refreshRecordingOverview({force:true}));
setInterval(refreshRecordingOverview,60_000);
let auditFetchedAt = 0, auditBusy = false, auditLoaded = false;
async function refreshAudits() {
  if (!$('recording-details').open || !$('energy-audit-details').open || auditBusy || Date.now()-auditFetchedAt<60_000) return;
  auditBusy = true;
  try {
    renderEnergyAudits(await api('/api/energy-audits'),$('energy-audit-content'));
    auditFetchedAt=Date.now();auditLoaded=true;$('energy-audit-message').hidden=true;
  }
  catch {
    $('energy-audit-message').hidden=false;
    $('energy-audit-message').textContent=auditLoaded
      ? 'Could not refresh the checks. The last successful results are still shown.'
      : 'Recorded energy checks could not be loaded. They will retry while this section is open.';
  }
  finally { auditBusy=false; }
}
$('recording-details').addEventListener('toggle',()=>{
  if ($('recording-details').open) { renderRecording(lastStatus,$('recording-content')); void refreshRecordingOverview(); void refreshAudits(); }
});
$('energy-audit-details').addEventListener('toggle',refreshAudits);
setInterval(refreshAudits,60_000);
historyChart = createHistoryChart({ api: (path, options) => api(path, undefined, options) });
document.addEventListener('themechange', event => historyChart.updateTheme(event.detail.theme));
setInterval(() => refresh({ background: true }), 15_000);
setInterval(refreshPairing, 3_000);
setInterval(() => { checkCommunication(); if (!session.locked) fireplacePanel.tick(); }, 1000);
window.addEventListener('online', () => void refresh());
document.addEventListener('visibilitychange', () => { checkCommunication(); if (!document.hidden) void refresh(); });
if (session.locked) { $('auth').hidden = ingress; $('connection').textContent = 'Signed out'; if (!ingress) $('token').focus(); }
else void refresh();
