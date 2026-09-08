import { createHistoryChart } from './history-chart.js';
import { describeProvider, outdoorSourceLabel, providerName } from './provider-status.js';
import { activeRates, rateRows, temporaryValues } from './home-controls.js';
import { balanceControllerColumns } from './panel-layout.js';
import { learningDisplay, h66Control, h66ReadingValue, h66Registers } from './learning-status.js';
import { renderRecording, renderEnergyAudits, recordingOverviewRefresh } from './recording.js';

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('stmq-token') ?? '';
let lastStatus;
let lastEvent = 0;
let historyChart;
let temporaryBusy = false;
let heatingTestBusy = false;
let h66TestBusy = false;
let lastHeatingTestResult;
let refreshSequence = 0;
const dirtyTemporary = new Set();
const temporaryFields = { awayUntilLocal: 'away-until', pauseUntilLocal: 'pause-until' };
const heatingTestButtons = [...document.querySelectorAll('[data-heating-command]')];
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = value => dateFormat.format(new Date(value));
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric' });
const day = value => dayFormat.format(new Date(value));
const decimal = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 5 }).format(value) : '—';
const label = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const tariffNames = { 'day-night': 'Day / night', seasonal: 'Seasonal' };
const priceStatuses = {
  simulated: 'Synthetic example prices', configured: 'All-in outlook available for configured dates',
  'contract-not-configured': 'Spot available · contract rates needed for all-in prices',
  'no-contract-coverage': 'Spot available · rates do not cover these dates',
  'missing-market-data': 'Waiting for market prices', 'stale-market-data': 'Market prices are stale',
  'partial-contract-coverage': 'All-in prices cover part of the outlook',
  'incomplete-market-coverage': 'Market outlook has missing intervals',
};
const weatherStatuses = { simulated: 'Synthetic weather', available: 'Forecast available', 'partial-forecast-coverage': 'Forecast has missing intervals', 'missing-forecast': 'Waiting for a forecast', 'stale-forecast': 'Forecast is stale' };
const reasons = {
  'unvalidated-thermal-model': 'Learning how the house holds and recovers heat',
  'unvalidated-heating-energy-model': 'Heating electricity use is not yet reliable enough to optimize',
  'thermal-state-reconciliation': 'Checking thermal reserve after startup',
  'reconciling-thermal-reserve': 'Allowing time to establish the current heat reserve',
  'learning-normal-comfort-reference': 'Learning the temperature achieved with normal heating',
  'timed-normal-override': 'A timed normal-heating override is in effect',
  'missing-or-stale-observations': 'Waiting for fresh temperature observations',
  'continuous-normal-preferred': 'Continuous normal operation is preferred',
};
async function api(path, data, options = {}) {
  const response = await fetch(path, { signal: options.signal, method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (response.status === 401) { $('auth').hidden = false; throw new Error('Enter your access token to view this installation.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  $('auth').hidden = true;
  return result;
}
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; $('connection').textContent = 'Connection needs attention'; }
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
function updateTemporaryButtons() {
  const busy = temporaryBusy || heatingTestBusy || h66TestBusy;
  $('temporary-submit').disabled = busy || dirtyTemporary.size === 0;
  const saved = lastStatus ? temporaryValues(lastStatus) : {};
  $('home-now').disabled = busy || !($('away-until').value || saved.awayUntilLocal);
  $('resume-now').disabled = busy || !($('pause-until').value || saved.pauseUntilLocal);
  for (const button of heatingTestButtons) button.disabled = busy || !lastStatus?.heatingTests?.available;
  $('h66-test-submit').disabled = busy || !h66Control(lastStatus?.h66, $('h66-test-register').value).available;
}
function renderTemporary(s) {
  const saved = temporaryValues(s);
  for (const [field, id] of Object.entries(temporaryFields)) {
    if (!dirtyTemporary.has(field)) $(id).value = saved[field];
  }
  $('away-status').textContent = saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}.` : 'At home.';
  $('override-status').textContent = saved.pauseUntilLocal
    ? `Price control paused until ${time(s.override.expiresAt)}.` : 'Price control is not paused.';
  $('override-scope').textContent = s.input === 'simulated'
    ? 'These changes apply to the simulation only.'
    : s.liveWrites ? 'Away and pause update the active heating plan. Pause restores normal heating for the selected time.'
      : 'Away and pause update the controller’s plan. This operating mode sends no automatic commands.';
  updateTemporaryButtons();
}
function showHeatingTestResult(result) {
  const failed = result.status === 'failed' || !result.sent;
  $('heating-test-message').classList.toggle('form-error', failed);
  $('heating-test-message').textContent = failed
    ? `${result.command} · ${result.error ?? 'The MQTT command could not be confirmed as sent.'}`
    : `${result.command} sent via MQTT at ${time(result.at)}. Device response is not verified.`;
  lastHeatingTestResult = JSON.stringify(result);
}
function renderHeatingTests(s) {
  const capability = s.heatingTests;
  $('heating-test-status').textContent = capability?.available
    ? 'Manual MQTT heating tests are enabled. These commands do not provide verified device readback.'
    : capability?.reason || 'Live MQTT tests are unavailable in this installation.';
  if (!heatingTestBusy && capability?.lastResult
    && JSON.stringify(capability.lastResult) !== lastHeatingTestResult) showHeatingTestResult(capability.lastResult);
}
function renderProviders(s) {
  const marketSource = providerName(s.providers?.market?.source), weatherSource = providerName(s.providers?.weather?.source);
  $('price-status').textContent = `${priceStatuses[s.priceStatus] ?? 'Price status unavailable'}${marketSource ? ` · ${marketSource}` : ''}`;
  $('weather-status').textContent = `${weatherStatuses[s.weatherStatus] ?? 'Weather status unavailable'}${weatherSource ? ` · ${weatherSource}` : ''}`;
  $('provider-context').textContent = s.input === 'simulated' ? 'Simulation uses example data; household providers are not polled.'
    : s.input === 'offline' ? 'Offline history mode does not poll household providers.' : 'Indoor measurements, electricity prices and weather forecasts are updated independently. Gaps remain visible in the chart.';
  const entries = Object.entries(s.providers ?? {}).filter(([name,health])=>
    !(['temperatures','smartthings'].includes(name)&&['not-configured','disabled'].includes(health?.status)));
  $('providers').replaceChildren();
  for (const [name, health] of entries) {
    if (!health || typeof health !== 'object') continue;
    const display = describeProvider(name, health, { now: s.now, formatTime: time });
    const row = document.createElement('li');
    const heading = document.createElement('div'); heading.className = 'provider-heading';
    const title = document.createElement('strong'); title.textContent = display.title;
    const state = document.createElement('span');
    state.textContent = display.state;
    state.className = display.attention ? 'stale' : 'muted';
    heading.append(title, state);
    const detail = document.createElement('p'); detail.className = 'muted';
    detail.textContent = display.detail;
    row.append(heading, detail); $('providers').append(row);
  }
  if (!entries.length) {
    const empty = document.createElement('li'); empty.className = 'muted';
    empty.textContent = 'No provider downloads recorded in this installation.'; $('providers').append(empty);
  }
}
function renderLearning(s) {
  const display = learningDisplay(s.learning);
  $('learning-title').textContent = display.title;
  $('learning-detail').textContent = display.message;
  $('learning-process').textContent = display.process;
  $('learning-metrics').replaceChildren();
  for (const metric of display.metrics) {
    const card = document.createElement('div'); card.className = 'learning-metric';
    const title = document.createElement('h3'); title.textContent = metric.title;
    const value = document.createElement('strong'); value.textContent = metric.value;
    const detail = document.createElement('p'); detail.textContent = metric.detail;
    const evidence = document.createElement('p'); evidence.className = 'muted'; evidence.textContent = metric.evidence;
    card.append(title, value, detail, evidence); $('learning-metrics').append(card);
  }
  $('learning-evidence').replaceChildren();
  for (const text of [...display.evidence, display.history]) {
    const paragraph = document.createElement('p'); paragraph.textContent = text; $('learning-evidence').append(paragraph);
  }
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
  $('h66-test-status').textContent = control.available
    ? `${control.label}. The current value is saved before the timed test and restored afterward. A sent command is shown separately from its device readback.`
    : control.reason;
  updateTemporaryButtons();
}
function showH66Test(result) {
  const failure = result?.status === 'failed' || result?.error;
  $('h66-test-message').classList.toggle('form-error', Boolean(failure));
  const register = result?.register;
  $('h66-test-message').textContent = result ? [h66Registers[register]?.label ?? register,
    label(result.status ?? 'requested'), result.value != null ? `requested ${result.value}` : '',
    result.readback != null ? `readback ${result.readback}` : '',
    result.originalValue != null ? `restore ${result.originalValue}` : '',
    result.expiresAt ? `until ${time(result.expiresAt)}` : '', result.error ?? result.reason ?? label(result.code ?? '')].filter(Boolean).join(' · ') : '';
}
function renderH66(s) {
  const h66 = s.h66 ?? {};
  $('h66-status').textContent = h66.connected ? 'H66 connected' : h66.reason ?? 'H66 readings unavailable';
  $('h66-context').textContent = h66.restorationPending ? 'Restoring previous H66 settings. Outstanding settings remain pending until fresh device readback confirms their state.' : h66.reason ?? (h66.connected
    ? 'Heat pump readback supplies compressor operation, heating destination and auxiliary output. Electrical power is estimated from configured equipment capacity.'
    : 'Controls become available after the H66 connection and current readbacks are ready.');
  const table = document.createElement('table'); table.className = 'h66-table';
  const caption = document.createElement('caption'); caption.textContent = 'Current heat pump readbacks'; table.append(caption);
  const head = document.createElement('thead'), header = document.createElement('tr');
  for (const text of ['Reading', 'Value', 'Received / observed']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; header.append(cell); }
  head.append(header); table.append(head);
  const body = document.createElement('tbody');
  const readings = h66.readings ?? {};
  const registers = [...new Set([...Object.keys(h66Registers), ...Object.keys(readings)])];
  for (const register of registers) {
    const reading = readings[register], row = document.createElement('tr');
    const title = document.createElement('th'); title.scope = 'row'; title.textContent = h66Registers[register]?.label ?? label(reading?.signal ?? `Register ${register}`);
    const value = document.createElement('td'); value.textContent = h66ReadingValue(register, reading);
    if (Number.isFinite(reading?.requested)) value.textContent += ` · requested ${h66ReadingValue(register, { ...reading, value: reading.requested })}`;
    if (Number.isFinite(reading?.baseline)) value.textContent += ` · original ${h66ReadingValue(register, { ...reading, value: reading.baseline })}`;
    if (reading?.stale || reading?.available === false || reading?.usableForControl === false) { value.className = 'stale'; value.textContent += ' · unavailable for control'; }
    const at = document.createElement('td'), timestamp = reading?.at ?? reading?.receivedAt ?? reading?.sourceTime;
    at.textContent = timestamp && Number.isFinite(new Date(timestamp).getTime()) ? time(timestamp) : '—';
    row.append(title, value, at); body.append(row);
  }
  table.append(body); $('h66-readings').replaceChildren(table);
  updateH66Selector();
  if (!h66TestBusy && h66.lastTest) showH66Test(h66.lastTest.expiresAt <= s.now && h66.lastTest.status !== 'failed'
    ? { ...h66.lastTest, status: h66.restorationPending ? 'restoration pending' : 'expired; no pending overrides' } : h66.lastTest);
}
function render(s) {
  lastStatus = s;
  $('error').hidden = true;
  $('connection').textContent = `${s.input === 'simulated' ? 'SIMULATION' : s.liveWrites ? 'LIVE CONTROL' : s.input !== 'offline' ? 'LIVE OBSERVATION' : 'READ-ONLY'} · ${s.mode.toUpperCase()}`;
  $('context').textContent = s.input === 'simulated' ? 'Simulated devices and example prices. This workspace sends no commands to your home.'
    : s.input === 'offline' ? 'Imported household history. No live device connection is open.'
      : s.liveWrites ? 'Learning from the house and controlling heating through preheating, reduction and recovery.'
        : 'Observing the house and planning heating. This operating mode sends no automatic commands.';
  for (const key of ['indoor', 'outdoor']) {
    const obs = s.observations[key];
    $(key).textContent = Number.isFinite(obs.value) ? `${obs.value.toFixed(1)} °C` : '—';
    $(key).classList.toggle('stale', obs.stale);
    const source = key === 'outdoor' ? outdoorSourceLabel(obs.source) : providerName(obs.source);
    const age = obs.stale ? 'Missing or stale reading' : `${obs.source === 'openmeteo' ? 'Valid at' : 'Observed'} ${time(obs.observedAt)}`;
    $(`${key}-age`).textContent = `${source ? `${source} · ` : ''}${age}`;
  }
  $('requested').textContent = label(s.decision.phase ?? (s.decision.action === 'normal' ? 'Normal' : 'Reduction'));
  $('actual').textContent = `Actual: ${label(s.observations.actual?.mode ?? 'unknown')}${s.input === 'simulated' ? ' · simulated' : ''}`;
  const current = s.prices.find(p => p.start <= s.now && p.end > s.now && Number.isFinite(p.allInCentsPerKWh));
  const spot = (s.spot ?? []).find(p => p.start <= s.now && p.end > s.now && Number.isFinite(p.spotCtPerKwh));
  $('price').textContent = current ? current.allInCentsPerKWh.toFixed(2) : spot ? spot.spotCtPerKwh.toFixed(2) : '—';
  $('price-label').textContent = s.input === 'simulated' ? 'EXAMPLE ALL-IN PRICE' : current ? 'ALL-IN PRICE' : spot ? 'SPOT PRICE' : 'ELECTRICITY PRICE';
  $('price-unit').textContent = s.input === 'simulated' ? 'c/kWh · synthetic simulation data' : current ? 'c/kWh · import, variable charges' : spot ? 'c/kWh · excludes VAT and other charges' : priceStatuses[s.priceStatus] ?? 'Waiting for price data';
  renderContract(s); renderProviders(s); renderH66(s);
  if ($('recording-details')?.open) renderRecording(s,$('recording-content'));
  $('control-mode').textContent = s.mode === 'monitoring' ? 'Monitoring · no automatic commands'
    : s.input === 'simulated' && s.mode === 'active' ? 'Simulation · applying this plan'
      : s.input === 'simulated' ? 'Simulation · shadow plan' : s.liveWrites ? 'Active · applying the heating plan' : 'Shadow plan · no automatic commands';
  $('decision-title').textContent = ({ normal: 'Normal heating is available', preheat: 'Building heat reserve before the reduction', reduction: 'Reducing heating during the selected interval', recovery: 'Recovering the house’s heat reserve' })[s.decision.phase ?? s.decision.action] ?? 'Heating plan';
  $('reasons').textContent = (s.decision.reasons ?? []).map(r => reasons[r] ?? label(typeof r === 'string' ? r : r.message ?? r.code)).join('. ');
  const temporary = temporaryValues(s);
  $('control-price').textContent = temporary.pauseUntilLocal ? 'Paused' : temporary.awayUntilLocal ? 'Away' : 'Active';
  $('dhwr').textContent = s.decision.dhwr?.requested ? '10-minute pulse requested' : 'No pulse requested';
  const reference = s.decision.comfort?.targetC ?? s.settings.comfort.targetC;
  const referenceSource = s.decision.comfort?.source === 'explicit-setting' || s.settings.comfort.targetC != null ? 'configured' : 'learned';
  $('reference').textContent = s.demoComfortTargetC ? `${s.demoComfortTargetC} °C · demo only` : Number.isFinite(reference) ? `${Number(reference).toFixed(1)} °C · ${referenceSource}` : 'Learning normal temperature';
  $('drop').textContent = `${s.settings.comfort.maxDropC} °C${s.decision.comfort?.maxDropApplies === false ? ' · inactive while away' : ''}`;
  renderLearning(s);
  renderTemporary(s); renderHeatingTests(s);
  $('updated').textContent = `Updated ${time(s.now)}`;
}
async function events() {
  const rows = await api(`/api/events?after=${lastEvent}&limit=50`);
  for (const event of rows) {
    lastEvent = Math.max(lastEvent, event.id);
    const li = document.createElement('li');
    const timestamp = document.createElement('time');
    timestamp.textContent = time(event.at);
    li.append(timestamp, document.createTextNode(`${label(event.type)} · ${JSON.stringify(event.payload)}`));
    $('events').prepend(li);
  }
  while ($('events').children.length > 100) $('events').lastChild.remove();
}
async function refresh({ forceChart = false } = {}) {
  if (temporaryBusy || heatingTestBusy || h66TestBusy) return;
  const sequence = ++refreshSequence;
  try {
    const s = await api('/api/status');
    if (sequence !== refreshSequence) return;
    render(s);
    await Promise.all([historyChart.refresh(s, { force: forceChart }), events()]);
  } catch (error) { if (sequence === refreshSequence) showError(error); }
}
$('auth').addEventListener('submit', event => { event.preventDefault(); token = $('token').value; sessionStorage.setItem('stmq-token', token); $('token').value = ''; refresh(); });
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
  if (temporaryBusy || heatingTestBusy || h66TestBusy) return;
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
  if (temporaryBusy || heatingTestBusy || h66TestBusy || !lastStatus?.heatingTests?.available) return;
  heatingTestBusy = true;
  ++refreshSequence;
  updateTemporaryButtons();
  $('heating-test-buttons').setAttribute('aria-busy', 'true');
  $('heating-test-message').classList.remove('form-error');
  $('heating-test-message').textContent = `Sending ${command}…`;
  try {
    const result = await api('/api/heating-test', { command });
    showHeatingTestResult(result);
    // Keep the success visible even if the subsequent status refresh fails.
    if (lastStatus.heatingTests) lastStatus.heatingTests.lastResult = result;
  } catch (error) {
    $('heating-test-message').classList.add('form-error');
    $('heating-test-message').textContent = error.message;
  } finally {
    heatingTestBusy = false;
    $('heating-test-buttons').removeAttribute('aria-busy');
    updateTemporaryButtons();
  }
  await refresh();
}
for (const button of heatingTestButtons) button.addEventListener('click', () => testHeating(button.dataset.heatingCommand));
$('h66-test-register').addEventListener('change', () => updateH66Selector({ useReadback: true }));
$('h66-test-form').addEventListener('submit', async event => {
  event.preventDefault();
  const register = $('h66-test-register').value;
  if (temporaryBusy || heatingTestBusy || h66TestBusy || !h66Control(lastStatus?.h66, register).available) return;
  h66TestBusy = true; ++refreshSequence; updateTemporaryButtons();
  $('h66-test-form').setAttribute('aria-busy', 'true');
  $('h66-test-message').classList.remove('form-error');
  $('h66-test-message').textContent = 'Sending timed test…';
  try {
    const result = await api('/api/test/h66', { register,
      value: Number($(register === '2201' ? 'h66-test-mode' : 'h66-test-value').value),
      durationMinutes: Number($('h66-test-duration').value) });
    showH66Test(result);
    if (lastStatus.h66) lastStatus.h66.lastTest = result;
  } catch (error) {
    $('h66-test-message').classList.add('form-error'); $('h66-test-message').textContent = error.message;
  } finally {
    h66TestBusy = false; $('h66-test-form').removeAttribute('aria-busy'); updateTemporaryButtons();
  }
  await refresh();
});
balanceControllerColumns(document.querySelector('.controller-panels'));
const refreshRecordingOverview=recordingOverviewRefresh({request:api,root:$('recording-overview-content'),
  details:$('recording-overview-details'),parent:$('recording-details'),message:$('recording-overview-message'),button:$('recording-overview-refresh')});
$('recording-overview-details').addEventListener('toggle',()=>void refreshRecordingOverview());
$('recording-overview-refresh').addEventListener('click',()=>void refreshRecordingOverview({force:true}));
setInterval(refreshRecordingOverview,60_000);
let auditFetchedAt = 0, auditBusy = false;
async function refreshAudits() {
  if (!$('recording-details').open || !$('energy-audit-details').open || auditBusy || Date.now()-auditFetchedAt<60_000) return;
  auditBusy = true;
  try { renderEnergyAudits(await api('/api/energy-audits'),$('energy-audit-content')); auditFetchedAt=Date.now(); }
  catch (error) { $('energy-audit-content').textContent=error.message; }
  finally { auditBusy=false; }
}
$('recording-details').addEventListener('toggle',()=>{
  if ($('recording-details').open) { renderRecording(lastStatus,$('recording-content')); void refreshRecordingOverview(); void refreshAudits(); }
});
$('energy-audit-details').addEventListener('toggle',refreshAudits);
setInterval(refreshAudits,60_000);
historyChart = createHistoryChart({ api: (path, options) => api(path, undefined, options) });
document.addEventListener('themechange', event => historyChart.updateTheme(event.detail.theme));
await refresh();
setInterval(refresh, 15_000);
