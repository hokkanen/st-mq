import Chart from 'chart.js/auto';

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('stmq-token') ?? '';
let lastStatus;
let lastEvent = 0;
let graph;
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = value => dateFormat.format(new Date(value));
const label = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
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
  const current = s.prices.find(p => p.start <= s.now && p.end > s.now);
  $('price').textContent = current ? Number(current.allInCentsPerKWh).toFixed(2) : '—';
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
  const benignFlags = new Set(['historical', 'simulated', 'good', 'gap_before', 'requested_not_observed', 'current_snapshot_not_energy', 'corrected_historical_price', 'excludes_vat_and_other_charges']);
  const history = [];
  for (const row of rows.sort((a, b) => a.sourceTime - b.sourceTime)) {
    const previous = history.at(-1);
    const gapMs = signal.includes('current') ? 1800_000 : 3 * 3600_000;
    if (previous && row.sourceTime - previous.x > gapMs) history.push({ x: previous.x + 1, y: null });
    history.push({ x: row.sourceTime, y: row.quality.every(flag => benignFlags.has(flag)) ? row.value : null });
  }
  const prices = s.prices.slice(0, 96).map(p => ({ x: p.start, y: p.allInCentsPerKWh }));
  const weather = s.forecast.slice(0, 24).map(p => ({ x: p.start, y: p.outdoorC }));
  const data = { datasets: [
    { label: $('signal').selectedOptions[0].text, data: history, borderColor: '#377455', pointRadius: 1, borderWidth: 2, spanGaps: false },
    { label: 'All-in price (c/kWh)', data: prices, borderColor: '#b58a45', yAxisID: 'price', pointRadius: 0, borderWidth: 1.5, stepped: 'before' },
    { label: 'Outdoor forecast (°C)', data: weather, borderColor: '#7c9ab2', borderDash: [4, 4], pointRadius: 0, hidden: true },
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
$('signal').addEventListener('change', () => { if (lastStatus) plot(lastStatus).catch(showError); });
await refresh();
setInterval(refresh, 15_000);
