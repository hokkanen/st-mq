import { createAutomationControls } from './automation-controls.js';
import { createReadOnlyControls, assertDashboardWrite } from './dashboard-access.js';
import { createSelectPickers } from './select-picker.js';
import { createDatePicker } from './date-picker.js';
import { createDashboardReset } from './dashboard-reset.js';
import { createDashboardOverviewLayout } from './dashboard-layout.js';
import { confirmAction } from './confirmation.js';
import { createConfigurationReview } from './configuration-review.js';
import { renderLearningRows } from './learning-rows.js';
import { renderGarage, createGarageControls } from './garage-status.js';
import { createMitsubishiControls } from './mitsubishi.js';
import { createChargingPanel } from './charging.js';
import { createChargingDiagnosticsPanel } from './charging-diagnostics.js';
import { createChargingTestsPanel } from './charging-tests.js';
import { initializeChargingSetup } from './charging-setup.js';
import './charging-diagnostics.css';
import './charging-tests.css';
import './charging-setup.css';
import { createHistoryChart } from './history-chart.js';
import { dashboardProviders, outdoorSourceLabel, providerName, providerSeries, temperatureReadingStatus } from './provider-status.js';
import { activeRates, rateRows, temporaryValues, priceControlState, renderHomePolicy, renderHomeRoomReferences } from './home-controls.js';
import { learningDisplay, h66Control, h66HomeSummary, h66EquipmentSummary, h66ReadingStatus, h66ReadingValue, h66Registers, h66ReadingGroups, renderModelInputs } from './learning-status.js';
import { renderRecording, renderEnergyAudits, recordingOverviewRefresh } from './recording.js';
import { bindDatabaseExport } from './database-export.js';
import { learningOverview, settingsReloadScope } from './dashboard-status.js';
import { createFireplacePanel } from './fireplace.js';
import { createSensorChangePanel } from './sensor-changes.js';
import { applicationUrl, usesHomeAssistantLogin, authenticationMessage, createPollingRequest,
  fetchJsonResponse, createEventStream, createCommunicationWatch } from './network.js';
import { isReadOnlyReplica, renderReplicaStatus, replicaSnapshotKey, renderInstanceRole, pairPanelView } from './replica-status.js';
import { createPairPanel } from './pair-status.js';
import { createHistoryRecoveryPanel } from './history-recovery.js';
import { createEquipmentPanel, dhwrReadingSummary } from './equipment.js';
import { createGarageDoorPanel } from './garage-doors.js';
import { renderFloorPreheat } from './floor-preheat.js';
import { assertWebRequest, createWebSession, createAccessControls, bindPasswordVisibility } from './web-access.js';
import { setStatusDetail, closeStatusDetails } from './status-details.js';
import { priceStatuses, renderCurrentPrice } from './current-price.js';
import { homeHeatingConfirmation, setHeatingStatusDetail } from './heating-status.js';
import { renderHomePlannedChange } from './heating-plan.js';
import { createHeatingExplorerPanel } from './heating-explorer.js';
import './heating-explorer.css';
import { homeHeatingWarning } from './heating-warning.js';
import { createOcppSetupAction, ocppSetupRevision } from './ocpp-setup.js';
import { createPageFullscreen } from './page-fullscreen.js';
import { ACTION_RECEIPT_MS, actionReceiptRecent, createReceiptTracker } from './action-receipts.js';
import { heatingRequestResult, heatingModeSelection, h66RequestResult, circulationStopPending } from './manual-control-status.js';

const $ = id => document.getElementById(id);
const selectPickers = createSelectPickers(document);
const temporaryDatePickers = [];
for (const input of document.querySelectorAll('[data-date-picker="datetime-local"]')) {
  temporaryDatePickers.push(createDatePicker(input, { mode: 'datetime-local', label: input.labels?.[0]?.textContent.trim() || 'Choose date and time' }));
}
createDashboardReset({ document, button: $('dashboard-reset') });
createPageFullscreen({ document, button: $('fullscreen-toggle') });
const dashboardOverviewLayout = createDashboardOverviewLayout({ document });
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
const h66Receipt = createReceiptTracker();
const heatingReceipts = new Map(['heating-test-message', 'dhwr-message'].map(id => [id, createReceiptTracker()]));
let circulationStopConfirmed = false;
let h66ErrorRequest;
let temporaryReceiptUntil = 0;
const controlErrors = new Map();
const heatingResults = new Map();
const heatingErrorRequests = new Map();
let refreshSequence = 0;
let pairStatusRevision = 0;
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
  heatingExplorer.clear();
  selectPickers.dismiss();
  for (const picker of temporaryDatePickers) picker.dismiss();
  const hadPassword = Boolean(session.token), hadStatus = Boolean(lastStatus);
  session.logout(); ++refreshSequence; lastStatus = undefined; webAccess = undefined;
  configurationReview.clear(); configurationReview.update();
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
    headers: { ...headers, ...(data === undefined ? {} : { 'Content-Type': options.binary ? 'application/vnd.sqlite3' : 'application/json' }) },
    ...(data === undefined ? {} : { body: options.binary ? data : JSON.stringify(data) }),
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
const heatingExplorer = createHeatingExplorerPanel({ document, request: api,
  afterMutation: () => { ++refreshSequence; return refresh(); } });
const configurationReview = createConfigurationReview({ document, request: api,
  getStatus: () => lastStatus && { ...lastStatus, webAccess },
  blocked: () => !lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy
    || settingsReloadBusy || equipmentBusy || Boolean(lastStatus?.equipmentTests?.active || lastStatus?.equipmentTests?.busy || lastStatus?.equipmentControls?.busy)
    || !settingsReloadScope(lastStatus).available,
  onBusy: busy => { settingsReloadBusy = busy; ++refreshSequence; updateTemporaryButtons(); },
  onStatus: render, afterApply: () => refresh({ forceChart: true }) });
// Mount the static input guide before restoring a possibly pending sensor change.
renderModelInputs($('model-inputs-content'), undefined, { sensorChanges: $('sensor-change-details'),
  outdoorSensorChanges: $('outdoor-sensor-change-details') });
const sensorChangePanel = createSensorChangePanel({ document, request: api, storage: sessionStorage,
  beforeMutation: () => { ++refreshSequence; }, afterMutation: () => refresh({ forceChart: true }) });
const pairPanel = createPairPanel({ document, request: api, storage: sessionStorage, formatTime: time,
  afterMutation: () => refresh({ forceChart: true }), onRecovery: options => historyRecovery.open(options) });
const historyRecovery = createHistoryRecoveryPanel({ document, request: api, storage: sessionStorage, formatTime: time,
  upload: file => api('/api/history-recovery/upload', file, { binary: true }),
  afterMutation: () => refresh({ forceChart: true }) });
const garageDoors = createGarageDoorPanel({ document,
  onAction: (deviceId, action) => equipmentPanel.actions.cover(deviceId, action),
  blocked: () => !lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy });
const equipmentPanel = createEquipmentPanel({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  onBusy: busy => { equipmentBusy = busy; updateTemporaryButtons(false); },
  onChange: snapshot => garageDoors.update(snapshot),
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy });
const automationControls = createAutomationControls({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  onBusy: busy => { equipmentBusy = busy; updateTemporaryButtons(false); },
  afterRequest: () => refresh(),
  blocked: () => temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy });
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
const chargingDiagnostics = createChargingDiagnosticsPanel({ document, request: api, afterMutation: () => refresh(), onOpenTest: (vehicleId, runId) => chargingTests.open(vehicleId, runId) });
const chargingTests = createChargingTestsPanel({ document, request: api,
  beforeRequest: () => { ++refreshSequence; }, onStatus: result => render(result),
  afterRequest: () => refresh(), openReport: (id, reportId) => chargingDiagnostics.open(id, reportId) });
const chargingSetup = initializeChargingSetup(document, { onStartTest: vehicleId => chargingTests.open(vehicleId) });
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
  $('resume-now').disabled = busy || lastStatus?.automation?.home?.enabled !== false || lastStatus?.automation?.home?.available !== true;
  for (const button of heatingTestButtons) button.disabled = busy || !lastStatus?.heatingTests?.available;
  $('test-preheat').disabled ||= lastStatus?.heatingTests?.preheatAvailable !== true;
  $('test-circulation').disabled ||= Boolean(lastStatus?.dhwr?.restorationPending);
  $('dhwr-stop').disabled = busy || !lastStatus?.heatingTests?.available || !(lastStatus?.dhwr?.active || lastStatus?.dhwr?.restorationPending || lastStatus?.dhwr?.actualOn === true);
  $('h66-test-submit').disabled = busy || !h66Control(lastStatus?.h66, $('h66-test-register').value).available;
  configurationReview.update();
  const localSetup = document.querySelector('[data-provider=electricity] .provider-local-adopt');
  if (localSetup) localSetup.disabled = busy || ocppSetupRevision(lastStatus) === null;
  if (updateEquipment) equipmentPanel.refreshControls();
  garageControls.refreshControls();
  automationControls.refreshControls();
  mitsubishiControls.refreshControls();
}
function renderTemporary(s) {
  const saved = temporaryValues(s);
  for (const [field, id] of Object.entries(temporaryFields)) {
    if (!dirtyTemporary.has(field)) $(id).value = saved[field];
  }
  $('away-status').textContent = saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}.` : 'At home.';
  const paused = s.automation?.home?.enabled === false;
  $('override-status').textContent = saved.pauseUntilLocal
    ? `Paused · Automatic resumes at ${time(s.override.expiresAt)}.`
    : paused ? 'Paused until you select Automatic.' : 'Automatic heating is active.';
  $('temporary-overview').textContent = (isReadOnlyReplica(s) ? 'Recorded · ' : '') + [saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}` : 'At home',
    saved.pauseUntilLocal ? `Resume ${time(s.override.expiresAt)}` : paused ? 'No resume time' : 'Automatic'].join(' · ');
  $('override-scope').textContent = isReadOnlyReplica(s) ? 'Saved settings for inspection. Changes are disabled in this read-only view.' : s.input === 'simulated'
    ? 'These changes apply to the simulation only.'
    : 'Away changes the automatic plan; it does not resume paused heating. Dates and times use Finnish local time.';
  if (temporaryReceiptUntil && Date.now() >= temporaryReceiptUntil && !dirtyTemporary.size) {
    $('temporary-message').textContent = ''; $('temporary-message').classList.remove('form-error'); temporaryReceiptUntil = 0;
  }
  updateTemporaryButtons();
}
function showHeatingTestResult(result) {
  const id = result.command === 'circulation' ? 'dhwr-message' : 'heating-test-message';
  heatingResults.set(id, result);
  const failed = !result.confirmed && (['failed', 'unconfirmed'].includes(result.status) || Boolean(result.error) || result.sent === false && !['waiting', 'already-active'].includes(result.status));
  const message = $(id), name = heatingCommandLabel(result.command);
  message.classList.toggle('form-error', failed);
  if (failed) {
    message.textContent = `${name} · ${result.error ?? 'The command could not be confirmed as sent.'}`;
    if (result.observedPhase) message.textContent += ` Latest device report: ${heatingCommandLabel(result.observedPhase)}.`;
    return;
  }
  const ended = result.active === false;
  const feedback = result.confirmed ? 'Device confirmed.' : ended ? 'Device confirmation was not received for this request.'
    : result.command === 'circulation' && lastStatus?.dhwr?.feedback?.stateConfigured === false
      ? 'Circulation feedback is not configured.' : result.status === 'waiting' ? result.reason ?? 'Waiting for the current circulation run to end.' : 'Waiting for device feedback.';
  message.textContent = `${name} requested at ${time(result.at)}. ${feedback}`;
  if (result.confirmed && (result.status === 'unconfirmed' || result.error)) message.textContent += ' The initial delivery was uncertain; a later device report confirmed the requested state.';
  if (result.superseded) message.textContent += ' A later selection or device report has replaced this request.';
  else if (ended) message.textContent += ' This manual action has ended.';
  else if (result.command === 'preheat') message.textContent += Number.isFinite(result.expiresAt)
    ? ` Ends at ${time(result.expiresAt)}; ROOM is restored at the lease deadline. Normal or Reduced ends it sooner.`
    : ' Ends at the floor lease deadline; Normal or Reduced ends it sooner.';
  else if (result.command === 'circulation') message.textContent += ` Runs for ${lastStatus?.dhwr?.durationMinutes ?? 10} minutes from this click. Stop ends it immediately.`;
  else if (result.indefinite || result.holdUntil === null && lastStatus?.automation?.home?.enabled === false)
    message.textContent += ' Held until you select another mode or Automatic.';
  else if (result.holdUntil > (lastStatus?.now ?? Date.now())) message.textContent += ` Held until ${time(result.holdUntil)} or Automatic.`;
  else message.textContent += ' Automatic heating reassesses this choice on the next controller update, normally within 1 minute.';
}
function showControlError(id, text) {
  controlErrors.set(id, Date.now() + ACTION_RECEIPT_MS);
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
  const selection = heatingModeSelection(s), phase = selection.phase;
  const selected = ({ normal: 'test-normal', recovery: 'test-normal',
    preheat: 'test-preheat', reduction: 'test-reduction' })[phase] ?? null;
  for (const [id, name] of [['test-normal', 'Normal heating'], ['test-preheat', 'Preheat'], ['test-reduction', 'Reduced heating']]) {
    const button = $(id), state = id === selected ? selection.confirmed ? 'Active' : 'Requested' : '';
    button.setAttribute('aria-pressed', String(id === selected));
    button.setAttribute('aria-label', `${name}${state ? ` · ${state}${state === 'Requested' ? ', awaiting device confirmation' : ''}` : ''}`);
    button.dataset.modeState = state.toLowerCase();
    button.querySelector('.heating-button-state').textContent = state ? '✓' : '';
  }
  const hold = s.decision?.manualHold;
  const paused = s.automation?.home?.enabled === false;
  $('home-manual-overview').textContent = hold && (hold.until == null || hold.until > s.now)
    ? `${heatingCommandLabel(hold.phase)} · ${selection.confirmed && selection.phase === hold.phase ? 'held' : 'requested'}` : phase ? heatingCommandLabel(phase) : 'Direct equipment controls';
  $('heating-test-help').textContent = isReadOnlyReplica(s) ? 'Device commands are disabled. Recorded history cannot confirm the current heating state.'
    : `${paused ? s.override?.expiresAt > s.now ? `Normal and Reduced stay until ${time(s.override.expiresAt)} or Automatic.` : 'Normal and Reduced stay until you select another mode or Automatic.'
      : 'Normal and Reduced are reassessed on the next controller update, normally within 1 minute.'} Preheat always ends at its lease deadline. These controls use the same equipment actions as automatic heating.`;
  $('heating-preheat-help').hidden = true;
  $('heating-preheat-help').textContent = capability?.preheatAvailable === true ? ''
    : capability?.preheatReason || 'Preheating needs a connected heat pump, a fresh writable ROOM setting and qualified floor-valve control when configured.';
  $('test-preheat').title = capability?.preheatAvailable === true
    ? `Request ROOM ${decimal(capability.preheatTargetC)} °C, ${decimal(capability.preheatRoomBoostC)} °C above the saved normal setting${s.preheatValves?.enabled ? ', with the pooled floor override' : ''}. Native limits bound the increase; repeated commands do not stack it. Normal recirculation keeps its own schedule.`
    : $('heating-preheat-help').textContent;
  const warning = homeHeatingWarning(s, time);
  $('home-hold-warning').hidden = !warning;
  $('home-hold-warning').textContent = warning;
  const held = [warning && (hold.until == null ? 'Manual heating held while paused' : `Manual heating held until ${time(hold.until)}`)].filter(Boolean);
  $('heating-held-summary').hidden = !held.length;
  $('heating-held-summary').textContent = `${held.join(' · ')}. Review Manual heating override below.`;
  setStatusDetail($('heating-test-status'), { key: 'manual-heating-availability', title: 'Heating control',
    label: capability?.available ? 'Control available' : 'Control unavailable', detail: capability?.available
      ? 'Requests are sent over MQTT. The reported state updates when device feedback arrives.'
      : capability?.reason || 'Manual heating control is unavailable in this installation.' });
  if (!heatingTestBusy) {
    if (capability?.lastResult) heatingResults.set(capability.lastResult.command === 'circulation'
      ? 'dhwr-message' : 'heating-test-message', capability.lastResult);
    for (const id of ['heating-test-message', 'dhwr-message']) {
      clearControlMessage(id);
      const raw = heatingResults.get(id);
      const result = heatingReceipts.get(id)(raw && `${raw.at}:${raw.command}`, heatingRequestResult(s, raw), s.now);
      const attempt = heatingErrorRequests.get(id);
      if (result && attempt && result.command === attempt.command && result.at > attempt.previousResultAt
        ) {
        controlErrors.delete(id); heatingErrorRequests.delete(id);
      }
      if (result && !controlErrors.has(id)) showHeatingTestResult(result);
      if (!result) heatingResults.delete(id);
    }
    if (!controlErrors.has('heating-test-message') && (s.execution?.restorationPending
      || s.preheatValves?.restorationPending)) {
      const failure = heatingRequestResult(s, heatingResults.get('heating-test-message'))?.error;
      const restore = 'Restoring previous heating settings. Waiting for device confirmation.';
      $('heating-test-message').textContent = failure ? `${$('heating-test-message').textContent} ${restore}` : restore;
    }
    if (!controlErrors.has('dhwr-message')) {
      if (s.dhwr?.restorationPending) $('dhwr-message').textContent = 'Stopping circulation. Restoration is still pending.';
      else if (circulationStopPending(s, circulationStopAt)) $('dhwr-message').textContent = 'Stop sent. Waiting for a new device report to verify the request.';
      else if (actionReceiptRecent(circulationStopAt, s.now)) {
        circulationStopConfirmed ||= s.dhwr?.confirmed === true && s.dhwr?.actualOn === false;
        $('dhwr-message').textContent = circulationStopConfirmed ? 'Circulation stopped · device confirmed.' : 'Circulation stop requested. The manual run has ended.';
      } else circulationStopAt = undefined;
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
    const sources = sourceStates?.length ? sourceStates : [{ label: sourceLabel, tone: row.dataset.state, state: display.state }];
    const sourceDetail = sources.map(source => `${source.label}: ${source.state}`).join('. ');
    setStatusDetail(state, { key: `provider-overview-${key}`, label: display.state, title: overviewTitle,
      detail: [display.detail, sourceDetail].filter(Boolean).join('\n\n') });
    const source = row.querySelector('.provider-category-meta');
    source.replaceChildren();
    for (const [sourceIndex, sourceEntry] of sources.entries()) {
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
  const replica = isReadOnlyReplica(s);
  const overview = $('provider-overview-state');
  const summary = replica ? 'View only' : attentionCount ? `${attentionCount} ${attentionCount === 1 ? 'needs' : 'need'} attention`
    : backupCount ? `${backupCount} using backup` : entries.length ? `${entries.length} data feeds`
      : s.input === 'simulated' ? 'Simulation' : 'No live sources';
  const context = replica ? 'Recorded provider information. Live connections are not opened by this computer.' : s.input === 'simulated' ? 'Example prices and weather are in use. Live providers are not polled.'
    : s.input === 'offline' ? 'Recorded history is available. Live providers are not polled.' : entries.length ? '' : 'Waiting for provider status.';
  const configuration = replica ? s.readView?.configurationMessage ?? 'Settings are shown for inspection. Changes are disabled until this computer becomes master.' : '';
  setStatusDetail(overview, { key: 'provider-overview', label: summary, title: 'Data & settings',
    detail: [context, configuration, entries.length ? 'Open a data feed for its sources, readings and connection details.' : ''].filter(Boolean).join('\n\n') });
  overview.classList.toggle('stale', attentionCount > 0 || backupCount > 0);
}
function renderLearning(s) {
  const display = learningDisplay(s.learning, { settings: s.settings, preheatValves: s.preheatValves });
  const overview = learningOverview(s.learning);
  for (const [prefix, model, metrics] of [
    ['learning', overview, [[overview.usableSamples, 'usable temperature intervals'], [overview.acceptedFits, 'accepted model updates']]],
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
  const failure = !result?.confirmed && (['failed', 'unconfirmed'].includes(result?.status) || result?.error);
  $('h66-test-message').classList.toggle('form-error', Boolean(failure));
  const register = result?.register;
  $('h66-test-message').textContent = result ? [h66Registers[register]?.label ?? register,
    result.superseded ? 'Previous request' : result.confirmed ? 'Confirmed' : label(result.status ?? 'requested'), result.value != null ? `requested ${result.value}` : '',
    result.readback != null ? `readback ${result.readback}` : '',
    result.previousValue != null ? `previously ${result.previousValue}` : '',
    result.superseded ? `later device reading: ${result.observedValue}` : result.confirmed === true ? 'device confirmed' : result.sent ? 'awaiting device confirmation' : '', result.confirmed ? '' : result.error ?? result.reason ?? label(result.code ?? '')].filter(Boolean).join(' · ') : '';
  if (result?.sent && !failure && !result.superseded) $('h66-test-message').textContent += ' · Remains as the pump’s setting until changed again.';
}
function renderH66TestResult(s) {
  if (h66TestBusy) return;
  const last = s.h66?.lastManual;
  if (h66ErrorRequest && last?.register === h66ErrorRequest.register && last.at > h66ErrorRequest.previousAt) {
    controlErrors.delete('h66-test-message'); h66ErrorRequest = undefined;
  }
  if (!clearControlMessage('h66-test-message')) return;
  const key = last && JSON.stringify([last.at, last.register, last.value]);
  showH66Test(h66Receipt(key, h66RequestResult(s), s.now));
}
function renderH66(s) {
  const h66 = s.h66 ?? {}, summary = h66HomeSummary(s), root = $('home-h66-summary');
  const tariff = summary.find(row => row.key === 'tariff');
  setStatusDetail($('tariff-control-state'), { key: 'home-tariff-control', label: tariff.summaryValue,
    title: tariff.title, detail: `${tariff.value}. ${tariff.detail}` });
  $('tariff-control-state').classList.toggle('stale', !tariff.available);
  $('tariff-control-note').textContent = tariff.summaryNote;
  const mode = summary.find(row => row.key === 'mode');
  setStatusDetail($('home-pump-mode'), { key: 'home-h66-mode', label: mode.available ? `${mode.value} mode` : 'Mode unavailable',
    title: 'Heat-pump mode', detail: mode.detail });
  const pumpReadings = h66EquipmentSummary(s);
  const operation = pumpReadings.find(row => row.key === 'state');
  setStatusDetail($('home-heating-operation'), { key: 'home-heating-operation',
    label: operation.available ? operation.value.replace(/ for .+$/, '') : 'Unknown',
    title: 'Heat-pump compressor', detail: `${operation.value}. ${operation.detail}` });
  $('home-heating-operation').classList.toggle('stale', !operation.available);
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
  automationControls.update(s);
  mitsubishiControls.update(s);
  chargingPanel.update(s);
  chargingDiagnostics.update(s); chargingTests.update(s); chargingSetup.render(s);
  $('error').hidden = true;
  pairPanel.update(pairPanelView(s));
  ++pairStatusRevision;
  historyRecovery.update({ ...s, webAccess });
  const replica = renderReplicaStatus(document, s, { formatTime: time });
  if (replica) garageDoors.close();
  renderHomePlannedChange(document, s);
  heatingExplorer.update({ ...s, webAccess });
  sensorChangePanel.update(isReadOnlyReplica(s) ? { ...s.sensorChanges, available: false, readOnly: true } : s.sensorChanges);
  $('connection').textContent = replica || s.input === 'offline' ? 'History viewer' : s.input === 'simulated' ? 'Simulation' : 'Live';
  $('context').textContent = s.input === 'simulated' ? 'Simulated devices and example prices. This workspace sends no commands to your home.'
    : s.input === 'offline' ? 'Imported household history. No live device connection is open.'
      : 'Live observations. Each feature shows its automation permission and current activity.';
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
  const manualHold = s.decision.manualHold && (s.decision.manualHold.until == null || s.decision.manualHold.until > s.now) ? s.decision.manualHold : null;
  const manualConfirmed = manualHold && heatingModeSelection(s).confirmed && heatingModeSelection(s).phase === manualHold.phase;
  const requested = label(manualHold?.phase ?? s.observations?.actual?.requestedPhase ?? s.decision.phase ?? (s.decision.action === 'normal' ? 'Normal' : 'Reduction')).replace(/^./, value => value.toUpperCase())
    + (manualHold ? manualConfirmed ? ' · held' : ' · requested' : '');
  const controlMode = replica ? 'Recorded controller decision · current control state unavailable'
    : s.input === 'simulated' ? `Simulation · ${s.automation?.home?.enabled ? 'applying this plan' : 'paused'}`
      : manualHold ? 'Holding manual heating settings'
        : s.automation?.home?.available === false ? s.automation.home.reason || 'Automatic heating is unavailable'
          : s.automation?.home?.activity === 'paused' ? 'Automatic heating is paused'
        : s.automation?.home?.enabled ? 'Automatic · applying the heating plan'
          : 'Paused · no automatic heating commands';
  const decisionTitle = manualHold
    ? manualConfirmed ? 'Manual heating selection held' : 'Manual heating selection requested'
    : ({ normal: 'Normal heating is available', preheat: 'Building heat reserve before the reduction', reduction: 'Reducing heating during the selected interval', recovery: 'Recovering the house’s heat reserve' })[s.decision.phase ?? s.decision.action] ?? 'Heating plan';
  const heldMode = ({ normal: 'Normal heating', preheat: 'Preheat', reduction: 'Reduced heating', recovery: 'Recovery heating' })[manualHold?.phase] ?? 'Your selected heating mode';
  const decisionReasons = manualHold
    ? `${heldMode} is ${manualConfirmed ? 'held' : 'requested'} ${manualHold.until == null ? 'until you select another mode or Automatic' : `until ${time(manualHold.until)}`}. ${manualHold.phase === 'preheat' ? 'ROOM is restored at the original lease deadline; Normal or Reduced ends Preheat sooner.' : 'Selecting Automatic restores normal settings and reassesses the heating plan.'} Heat-pump parameter edits remain in effect.`
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
  setStatusDetail($('control-price'), { key: 'home-control-mode', label: controlPrice.label,
    title: 'Heat control', detail: [controlPrice.label, controlMode].join('\n\n') });
  $('control-price').parentElement.dataset.state = controlPrice.state;
  const dhwr = dhwrReadingSummary(s);
  setStatusDetail($('dhwr'), { key: 'home-circulation', label: dhwr.summaryValue,
    title: 'Hot-water circulation', detail: `${dhwr.summary}. ${dhwr.state.detail}\n\n${dhwr.request}. Electrical feedback does not confirm water flow.` });
  $('dhwr-note').textContent = dhwr.summaryNote;
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
  const replicaStatus = renderReplicaStatus(document, s, { formatTime: time });
  dashboardOverviewLayout.refreshLayout();
  return replicaStatus;
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
  const pairRevision = pairStatusRevision;
  let s;
  try {
    s = await request;
  } catch (error) {
    if (sequence === refreshSequence) {
      // The faster pairing poll may already have confirmed this computer while
      // this older status request was pending.
      if (pairRevision === pairStatusRevision) pairPanel.unavailable();
      showError(error);
    }
    return;
  }
  if (sequence !== refreshSequence) return;
  communication.received();
  try {
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
  } catch (error) {
    // Chart, event and rendering failures do not invalidate a received local
    // pairing report or its confirmed MQTT address ownership.
    if (sequence === refreshSequence) showError(error);
  }
}
let pairPollBusy = false;
async function refreshPairing() {
  if (lastStatus?.topology !== 'pair' || pairPollBusy) return;
  pairPollBusy = true;
  const pairRevision = pairStatusRevision;
  let received = false;
  try {
    const pair = await api('/api/pair');
    received = true;
    const previous = lastStatus.pair ?? {};
    const changed = pair.role !== previous.role || pair.canControl !== previous.canControl || Boolean(pair.transition) !== Boolean(previous.transition);
    lastStatus = { ...lastStatus, pair };
    readOnlyControls.update(lastStatus);
    garageDoors.update({ ...equipmentPanel.actions.snapshot(), status: lastStatus });
    pairPanel.update(pairPanelView(lastStatus));
    ++pairStatusRevision;
    historyRecovery.update({ ...lastStatus, webAccess });
    renderInstanceRole(document, lastStatus);
    if (isReadOnlyReplica(lastStatus)) {
      garageDoors.close(); fireplacePanel.close(); heatingExplorer.clear();
      renderReplicaStatus(document, lastStatus, { formatTime: time });
    }
    if (changed) await refresh({ forceChart: true });
  } catch (error) {
    if (session.locked) return;
    if (!received && pairRevision === pairStatusRevision) pairPanel.unavailable();
    if (received) showError(error);
  }
  finally { pairPollBusy = false; }
}
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
async function applyTemporary(values, resume = false) {
  if (!lastStatus || isReadOnlyReplica(lastStatus) || temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy) return;
  temporaryBusy = true;
  ++refreshSequence;
  updateTemporaryButtons();
  for (const id of Object.values(temporaryFields)) $(id).disabled = true;
  $('temporary-message').classList.remove('form-error');
  $('temporary-message').textContent = 'Applying…';
  try {
    const result = await api(resume ? '/api/automation' : '/api/temporary', resume ? { feature: 'home', enabled: true } : values);
    for (const field of Object.keys(values)) dirtyTemporary.delete(field);
    if (resume) dirtyTemporary.delete('pauseUntilLocal');
    render(result);
    temporaryReceiptUntil = Date.now() + ACTION_RECEIPT_MS;
    $('temporary-message').textContent = dirtyTemporary.size ? 'Applied. Other changes are not applied yet.' : 'Changes applied.';
    await events();
  } catch (error) {
    $('temporary-message').classList.add('form-error');
    $('temporary-message').textContent = error.message;
    temporaryReceiptUntil = Date.now() + ACTION_RECEIPT_MS;
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
$('resume-now').addEventListener('click', () => applyTemporary({}, true));
async function testHeating(command) {
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || !lastStatus?.heatingTests?.available) return;
  if (command === 'preheat' && lastStatus.heatingTests.preheatAvailable !== true) return;
  if (temporaryBusy || heatingTestBusy || h66TestBusy || settingsReloadBusy || equipmentBusy || isReadOnlyReplica(lastStatus)) return;
  heatingTestBusy = true;
  ++refreshSequence;
  updateTemporaryButtons();
  $('heating-test-buttons').setAttribute('aria-busy', 'true');
  const message = $(command === 'circulation' ? 'dhwr-message' : 'heating-test-message');
  controlErrors.delete(message.id);
  heatingErrorRequests.delete(message.id);
  const previousResultAt = lastStatus.heatingTests?.lastResult?.at ?? -Infinity;
  if (command === 'circulation') { circulationStopAt = undefined; circulationStopConfirmed = false; }
  message.classList.remove('form-error');
  message.textContent = `Sending ${heatingCommandLabel(command)}…`;
  try {
    const result = await api('/api/heating-test', { command });
    showHeatingTestResult(result);
    // Keep the success visible even if the subsequent status refresh fails.
    if (lastStatus.heatingTests) lastStatus.heatingTests.lastResult = result;
  } catch (error) {
    heatingErrorRequests.set(message.id, { command, previousResultAt, error: error.message });
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
    circulationStopConfirmed = lastStatus?.dhwr?.confirmed === true && lastStatus?.dhwr?.actualOn === false;
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
  const previousH66At = lastStatus?.h66?.lastManual?.at ?? -Infinity;
  h66ErrorRequest = undefined;
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
    h66ErrorRequest = { register, previousAt: previousH66At };
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
setInterval(() => { checkCommunication(); if (!session.locked) { fireplacePanel.tick(); heatingExplorer.tick(); } }, 1000);
setInterval(() => { if (!session.locked) historyRecovery.tick(); }, 2000);
window.addEventListener('online', () => void refresh());
document.addEventListener('visibilitychange', () => { checkCommunication(); if (!document.hidden) void refresh(); });
if (session.locked) { $('auth').hidden = ingress; $('connection').textContent = 'Signed out'; if (!ingress) $('token').focus(); }
else void refresh();
