import { createHistoryChart } from './history-chart.js';
import { describeProvider, outdoorSourceLabel, providerName } from './provider-status.js';
import { activeRates, rateRows, temporaryValues } from './home-controls.js';

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('stmq-token') ?? '';
let lastStatus;
let lastEvent = 0;
let historyChart;
let temporaryBusy = false;
let refreshSequence = 0;
const dirtyTemporary = new Set();
const temporaryFields = { awayUntilLocal: 'away-until', pauseUntilLocal: 'pause-until' };
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
  $('temporary-submit').disabled = temporaryBusy || dirtyTemporary.size === 0;
  const saved = lastStatus ? temporaryValues(lastStatus) : {};
  $('home-now').disabled = temporaryBusy || !($('away-until').value || saved.awayUntilLocal);
  $('resume-now').disabled = temporaryBusy || !($('pause-until').value || saved.pauseUntilLocal);
}
function renderTemporary(s) {
  const saved = temporaryValues(s);
  for (const [field, id] of Object.entries(temporaryFields)) {
    if (!dirtyTemporary.has(field)) $(id).value = saved[field];
  }
  $('away-status').textContent = saved.awayUntilLocal ? `Away until ${time(s.settings.occupancy.returnAt)}.` : 'Home';
  $('override-status').textContent = saved.pauseUntilLocal
    ? `Price control paused until ${time(s.override.expiresAt)}.` : 'Price control is not paused.';
  $('override-scope').textContent = s.input === 'simulated'
    ? 'These changes apply to the simulation only.'
    : 'Read-only operation: these choices are recorded; equipment commands remain disabled.';
  updateTemporaryButtons();
}
function renderProviders(s) {
  const marketSource = providerName(s.providers?.market?.source), weatherSource = providerName(s.providers?.weather?.source);
  $('price-status').textContent = `${priceStatuses[s.priceStatus] ?? 'Price status unavailable'}${marketSource ? ` · ${marketSource}` : ''}`;
  $('weather-status').textContent = `${weatherStatuses[s.weatherStatus] ?? 'Weather status unavailable'}${weatherSource ? ` · ${weatherSource}` : ''}`;
  $('provider-context').textContent = s.input === 'simulated' ? 'Simulation uses example data; household providers are not polled.'
    : s.input === 'offline' ? 'Offline history mode does not poll household providers.' : 'Read-only provider downloads. Equipment commands remain disabled.';
  const entries = Object.entries(s.providers ?? {});
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
function render(s) {
  lastStatus = s;
  $('error').hidden = true;
  $('connection').textContent = `${s.input === 'simulated' ? 'SIMULATION' : 'READ-ONLY'} · ${s.mode.toUpperCase()}`;
  $('context').textContent = s.input === 'simulated' ? 'Simulated devices and example prices. This workspace sends no commands to your home.' : s.input === 'offline' ? 'Imported household history. No live device connection is open.' : 'Read-only observation of the house. Equipment writes await verified integration.';
  for (const key of ['indoor', 'outdoor']) {
    const obs = s.observations[key];
    $(key).textContent = Number.isFinite(obs.value) ? `${obs.value.toFixed(1)} °C` : '—';
    $(key).classList.toggle('stale', obs.stale);
    const source = key === 'outdoor' ? outdoorSourceLabel(obs.source) : providerName(obs.source);
    const age = obs.stale ? 'Missing or stale reading' : `${obs.source === 'openweathermap' ? 'Updated' : 'Observed'} ${time(obs.observedAt)}`;
    $(`${key}-age`).textContent = `${source ? `${source} · ` : ''}${age}`;
  }
  $('requested').textContent = s.decision.action === 'normal' ? 'Normal' : 'Reduction';
  $('actual').textContent = `Actual: ${label(s.observations.actual?.mode ?? 'unknown')}${s.input === 'simulated' ? ' · simulated' : ''}`;
  const current = s.prices.find(p => p.start <= s.now && p.end > s.now && Number.isFinite(p.allInCentsPerKWh));
  const spot = (s.spot ?? []).find(p => p.start <= s.now && p.end > s.now && Number.isFinite(p.spotCtPerKwh));
  $('price').textContent = current ? current.allInCentsPerKWh.toFixed(2) : spot ? spot.spotCtPerKwh.toFixed(2) : '—';
  $('price-label').textContent = s.input === 'simulated' ? 'EXAMPLE ALL-IN PRICE' : current ? 'ALL-IN PRICE' : spot ? 'SPOT PRICE' : 'ELECTRICITY PRICE';
  $('price-unit').textContent = s.input === 'simulated' ? 'c/kWh · synthetic simulation data' : current ? 'c/kWh · import, variable charges' : spot ? 'c/kWh · excludes VAT and other charges' : priceStatuses[s.priceStatus] ?? 'Waiting for price data';
  renderContract(s); renderProviders(s);
  $('decision-title').textContent = s.decision.action === 'normal' ? 'Normal heating is available' : 'A tariff reduction is planned';
  $('reasons').textContent = (s.decision.reasons ?? []).map(r => reasons[r] ?? label(typeof r === 'string' ? r : r.message ?? r.code)).join('. ');
  $('dhwr').textContent = s.decision.dhwr?.requested ? '10-minute pulse requested' : 'No pulse requested';
  const reference = s.decision.comfort?.targetC ?? s.settings.comfort.targetC;
  $('reference').textContent = s.demoComfortTargetC ? `${s.demoComfortTargetC} °C · demo only` : reference ? `${Number(reference).toFixed(1)} °C · learned reference` : 'Learning normal temperature';
  $('drop').textContent = `${s.settings.comfort.maxDropC} °C`;
  $('learning-title').textContent = s.learning?.status === 'collecting' ? 'Collecting observations' : label(s.learning?.status ?? 'Collecting observations');
  $('learning-detail').textContent = s.learning?.message ?? s.learning?.reason ?? 'Conservative normal operation while confidence is established.';
  $('savings').textContent = s.savings.explanation;
  renderTemporary(s);
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
  if (temporaryBusy) return;
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
  if (temporaryBusy) return;
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
historyChart = createHistoryChart({ api: (path, options) => api(path, undefined, options) });
document.addEventListener('themechange', event => historyChart.updateTheme(event.detail.theme));
await refresh();
setInterval(refresh, 15_000);
