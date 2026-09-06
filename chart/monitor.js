import Chart from 'chart.js/auto';
import { intervalPoints } from './interval-points.js';

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('stmq-token') ?? '';
let lastStatus;
let lastEvent = 0;
let graph;
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
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  if (response.status === 401) { $('auth').hidden = false; throw new Error('Enter your access token to view this installation.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  $('auth').hidden = true;
  return result;
}
function showError(error) { $('error').textContent = error.message; $('error').hidden = false; $('connection').textContent = 'Connection needs attention'; }
function renderContract(s) {
  const periods = s.contract?.periods ?? [];
  $('contract-context').textContent = s.input === 'simulated'
    ? 'Rates saved here belong to this simulation. The example price outlook stays synthetic.'
    : 'Enter the rates and effective date shown on your contract or bill. Rates apply only from their configured date.';
  const list = $('contract-periods');
  list.replaceChildren();
  if (!periods.length) {
    const empty = document.createElement('p'); empty.className = 'muted';
    empty.textContent = 'No contract rates entered. All-in household prices need your dated charges.';
    list.append(empty);
  }
  for (const period of [...periods].reverse()) {
    const item = document.createElement('article'); item.className = 'contract-period';
    const heading = document.createElement('h3');
    const status = period.from > s.now ? 'Scheduled' : period.to != null && period.to <= s.now ? 'Past rates' : 'Current rates';
    heading.textContent = `${status} · from ${day(period.from)}`;
    const tariff = document.createElement('p'); tariff.className = 'muted';
    tariff.textContent = `${tariffNames[period.tariff] ?? 'Transfer tariff'}${period.to != null ? ` · until ${day(period.to)} (exclusive)` : ''}`;
    const charges = document.createElement('dl'); charges.className = 'rate-values';
    for (const [name, value] of [['Margin, ex VAT', `${decimal(period.marginCtPerKwh)} c/kWh`], ['Tax, ex VAT', `${decimal(period.taxCtPerKwh)} c/kWh`], ['VAT', `${decimal(period.vatRate * 100)}%`]]) {
      const field = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value; field.append(dt, dd); charges.append(field);
    }
    item.append(heading, tariff, charges); list.append(item);
  }
}
function renderProviders(s) {
  $('price-status').textContent = priceStatuses[s.priceStatus] ?? 'Price status unavailable';
  $('weather-status').textContent = weatherStatuses[s.weatherStatus] ?? 'Weather status unavailable';
  $('provider-context').textContent = s.input === 'simulated' ? 'Simulation uses example data; household providers are not polled.'
    : s.input === 'offline' ? 'Offline history mode does not poll household providers.' : 'Read-only provider downloads. Equipment commands remain disabled.';
  const names = { temperatures: 'SmartThings temperatures', smartthings: 'SmartThings temperatures', easee: 'Easee currents', market: 'Electricity market', weather: 'Weather forecast' };
  const entries = Object.entries(s.providers ?? {});
  $('providers').replaceChildren();
  for (const [name, health] of entries) {
    if (!health || typeof health !== 'object') continue;
    const row = document.createElement('li');
    const heading = document.createElement('div'); heading.className = 'provider-heading';
    const title = document.createElement('strong'); title.textContent = names[name] ?? 'Data provider';
    const state = document.createElement('span');
    const statuses = { ok: 'Available', healthy: 'Available', available: 'Available', success: 'Available', running: 'Updating', fetching: 'Updating', error: 'Needs attention', degraded: 'Needs attention', disabled: 'Not enabled', unconfigured: 'Not configured', 'not-configured': 'Not configured', waiting: 'Waiting', pending: 'Waiting' };
    state.textContent = statuses[health.status] ?? 'Status pending';
    state.className = ['error', 'degraded'].includes(health.status) ? 'stale' : 'muted';
    heading.append(title, state);
    const detail = document.createElement('p'); detail.className = 'muted';
    const success = health.lastSuccessAt ?? health.lastSuccess;
    detail.textContent = Number.isFinite(success) ? `Last successful download ${time(success)}.` : 'No successful download recorded.';
    const failure = health.lastError ?? health.error;
    if (failure) {
      // Only a small status/code vocabulary enters the page; raw response text does not.
      const code = typeof failure === 'object' ? failure.code : failure;
      const status = typeof failure === 'object' ? failure.status : health.httpStatus;
      const safeCode = typeof code === 'string' && /^HTTP-[1-5][0-9]{2}$/.test(code) ? code.replace('-', ' ')
        : typeof code === 'string' && /^(?:provider|missing|invalid|unconfigured|partial|no|http|credentials|token)[a-z0-9_-]{0,70}$/.test(code) ? label(code) : 'Download failed';
      const at = health.lastErrorAt ?? (typeof failure === 'object' ? failure.at : null) ?? health.lastAttemptAt;
      detail.textContent += ` Last error: ${safeCode}${Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : ''}${Number.isFinite(at) ? ` · ${time(at)}` : ''}.`;
      if (Number.isFinite(health.nextAttemptAt)) detail.textContent += ` Retry ${time(health.nextAttemptAt)}.`;
    }
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
    $(`${key}-age`).textContent = obs.stale ? 'Missing or stale reading' : `Observed ${time(obs.observedAt)}`;
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
  if (!$('settings-form').contains(document.activeElement)) {
    $('mode').value = s.mode;
    $('mode').querySelector('[value="active"]').disabled = s.input !== 'simulated';
    $('max-drop').value = s.settings.comfort.maxDropC;
    $('occupancy').value = s.settings.occupancy.mode;
  }
  $('override-status').textContent = s.override && s.override.expiresAt > s.now ? `Normal heating requested until ${time(s.override.expiresAt)}.` : 'No override.';
  $('override-scope').textContent = s.mode === 'active' ? 'This override applies to the simulated plant only.' : 'This mode records the request without sending equipment commands.';
  $('updated').textContent = `Updated ${time(s.now)}`;
}
async function plot(s) {
  const signal = $('signal').value;
  const rows = await api(`/api/history?signal=${encodeURIComponent(signal)}&from=${s.now - 86_400_000}&to=${s.now}&limit=2000`);
  const benignFlags = new Set(['historical', 'simulated', 'good', 'gap_before', 'requested_not_observed', 'current_snapshot_not_energy', 'corrected_historical_price', 'excludes_vat_and_other_charges', 'converted_fahrenheit']);
  const history = [];
  for (const row of rows.sort((a, b) => a.sourceTime - b.sourceTime)) {
    if (!Number.isFinite(row.sourceTime)) continue;
    const previous = history.at(-1);
    const gapMs = signal.includes('current') ? 1800_000 : 3 * 3600_000;
    if (previous && row.sourceTime - previous.x > gapMs) history.push({ x: previous.x + 1, y: null });
    history.push({ x: row.sourceTime, y: row.quality.every(flag => benignFlags.has(flag)) ? row.value : null });
  }
  const prices = intervalPoints(s.prices, 'allInCentsPerKWh', { limit: 96 });
  const weather = intervalPoints(s.forecast, 'outdoorC', { limit: 24 });
  const spot = intervalPoints(s.spot ?? [], 'spotCtPerKwh', { limit: 192 });
  const data = { datasets: [
    { label: $('signal').selectedOptions[0].text, data: history, borderColor: '#377455', pointRadius: 1, borderWidth: 2, spanGaps: false },
    { label: `${s.input === 'simulated' ? 'Example all-in' : 'All-in'} price (c/kWh)`, data: prices, borderColor: '#b58a45', yAxisID: 'price', pointRadius: 0, borderWidth: 1.5, stepped: 'before', spanGaps: false },
    { label: `${s.input === 'simulated' ? 'Example outdoor' : 'Outdoor'} forecast (°C)`, data: weather, borderColor: '#7c9ab2', borderDash: [4, 4], pointRadius: 0, stepped: 'before', spanGaps: false, hidden: true },
    { label: 'Spot price, ex VAT and charges (c/kWh)', data: spot, borderColor: '#9f7d9c', yAxisID: 'price', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.5, stepped: 'before', spanGaps: false, hidden: prices.length > 0 },
  ] };
  if (graph) { data.datasets.forEach((d, i) => { d.hidden = !graph.isDatasetVisible(i); }); graph.data = data; graph.update('none'); return; }
  graph = new Chart($('history'), { type: 'line', data, options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false, scales: { x: { type: 'linear', ticks: { maxTicksLimit: 7, callback: value => time(value) }, grid: { color: '#eff2ed' } }, y: { grid: { color: '#eff2ed' } }, price: { position: 'right', grid: { drawOnChartArea: false } } }, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { title: items => time(items[0].parsed.x) } } } } });
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
async function refresh() { try { const s = await api('/api/status'); render(s); await Promise.all([plot(s), events()]); } catch (error) { showError(error); } }
$('auth').addEventListener('submit', event => { event.preventDefault(); token = $('token').value; sessionStorage.setItem('stmq-token', token); $('token').value = ''; refresh(); });
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); try { const occupancy = { mode: $('occupancy').value }; if ($('return-at').value) occupancy.returnAt = new Date($('return-at').value).toISOString(); render(await api('/api/settings', { mode: $('mode').value, comfort: { targetC: lastStatus.settings.comfort.targetC, maxDropC: Number($('max-drop').value) }, occupancy })); } catch (error) { showError(error); } });
$('override-form').addEventListener('submit', async event => { event.preventDefault(); try { render(await api('/api/override', { minutes: Number($('duration').value) })); } catch (error) { showError(error); } });
$('contract-tariff').addEventListener('change', () => {
  $('tariff-detail').textContent = $('contract-tariff').value === 'day-night'
    ? 'Transfer including VAT: 3.34 c/kWh at 07:00–22:00; 1.96 c/kWh overnight. All times are Finnish local time.'
    : 'Transfer including VAT: 4.17 c/kWh in November–March, Monday–Saturday, 07:00–22:00; 2.07 c/kWh otherwise. All times are Finnish local time.';
});
$('contract-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('contract-submit').disabled = true; $('contract-message').textContent = '';
  try {
    await api('/api/contract', { effectiveDate: $('contract-date').value,
      marginCtPerKwh: $('contract-margin').valueAsNumber, taxCtPerKwh: $('contract-tax').valueAsNumber,
      vatRate: $('contract-vat').valueAsNumber / 100, tariff: $('contract-tariff').value });
    $('contract-form').reset();
    $('tariff-detail').textContent = 'Transfer charges include VAT. Choose the tariff on your contract.';
    $('contract-message').textContent = 'Dated rates saved. Earlier rate periods are preserved.';
    await refresh();
  } catch (error) { $('contract-message').textContent = error.message; }
  finally { $('contract-submit').disabled = false; }
});
$('signal').addEventListener('change', () => { if (lastStatus) plot(lastStatus).catch(showError); });
await refresh();
setInterval(refresh, 15_000);
