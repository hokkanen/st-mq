import Chart from 'chart.js/auto';
import { color } from 'chart.js/helpers';
import { calendarTicks, createChartLoader, defaultPalette, finnishDate, historyDatasets, selectedRange, visible } from './history-model.js';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const visibilityStorage = 'home-energy-chart-visibility';
const paletteVariables = {
  text: '--text', muted: '--muted', border: '--border', grid: '--grid',
  property: '--chart-property', ev: '--chart-ev', phase1: '--chart-phase-1', phase2: '--chart-phase-2', phase3: '--chart-phase-3',
  indoor: '--chart-indoor', garage: '--chart-garage', outdoor: '--chart-outdoor', integral: '--chart-integral', price: '--chart-price', spot: '--chart-spot',
  heatOff: '--chart-heat-off', auxHeat: '--chart-aux-heat', dhwr: '--chart-dhwr',
};
const shades = [
  { key: 'heatOff', label: 'Heat Off', detail: 'Requested heating reduction; observed state where available' },
  { key: 'auxHeat', label: 'Aux Heat', detail: 'Timestamped auxiliary-heating output' },
  { key: 'dhwr', label: 'DHWR', detail: 'Requested 10-minute hot-water recirculation pulses' },
];

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(visibilityStorage) ?? '{}');
    return Object.fromEntries(Object.entries(saved ?? {}).filter(([key, value]) => /^[a-zA-Z0-9_]{1,40}$/.test(key) && typeof value === 'boolean'));
  } catch { return {}; }
}

/** The chart owns only its controls and fetches; the monitor owns authentication. */
export function createHistoryChart({ api, getTheme = () => document.documentElement.dataset.theme }) {
  const $ = id => document.getElementById(id);
  const canvas = $('history');
  const loader = createChartLoader({ api });
  const preferences = loadPreferences();
  const listeners = [];
  let graph, payload, plottedSelection, fingerprint, status, initialized = false, closed = false;
  let palette = { ...defaultPalette }, lastContract, lastLiveRevision, selectionGeneration = 0;
  let selection = { ...selectedRange('today', Date.now()), left: 'power', points: 800 };
  let activePreset = 'today', previousToday;

  function listen(node, event, handler) { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); }
  function updateControls() {
    $('date-start').value = selection.startDate; $('date-end').value = selection.endDate; $('left-axis').value = selection.left;
    for (const preset of ['today', 'yesterday', 'tomorrow']) $(`range-${preset}`).setAttribute('aria-pressed', String(activePreset === preset));
  }
  function readPalette() {
    const styles = getComputedStyle(document.documentElement);
    palette = Object.fromEntries(Object.entries(paletteVariables).map(([key, variable]) => [key, styles.getPropertyValue(variable).trim() || defaultPalette[key]]));
  }
  function savePreferences() { try { localStorage.setItem(visibilityStorage, JSON.stringify(preferences)); } catch { /* Charts remain usable when storage is unavailable. */ } }
  function paintShading(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !payload) return;
    ctx.save(); ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
    for (const shade of shades) {
      if (!visible(shade.key, preferences)) continue;
      ctx.fillStyle = palette[shade.key];
      for (const interval of payload.shading?.[shade.key] ?? []) {
        const from = Math.max(interval.start, payload.range.from), to = Math.min(interval.end, payload.range.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) continue;
        // Dense historical ranges carry duty fractions instead of inventing continuous activity.
        ctx.globalAlpha = 0.18 * (interval.aggregated ? Math.min(1, Math.max(0, interval.fraction ?? 0)) : 1);
        const left = scales.x.getPixelForValue(from), right = scales.x.getPixelForValue(to);
        ctx.fillRect(left, chartArea.top, right - left, chartArea.height);
      }
    }
    if (payload.now > payload.range.from && payload.now < payload.range.to) {
      const x = scales.x.getPixelForValue(payload.now);
      ctx.globalAlpha = 0.65; ctx.strokeStyle = palette.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
    }
    ctx.restore();
  }
  function renderLegend(datasets) {
    const groups = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
    groups.forEach(group => { group.className = 'chart-legend-group'; });
    groups[0].setAttribute('aria-label', 'Activity shading'); groups[1].setAttribute('aria-label', 'Left axis'); groups[2].setAttribute('aria-label', 'Right axis');
    function add(group, key, label, detail, swatchColor, kind) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-legend-button';
      button.dataset.chartKey = key; button.setAttribute('aria-pressed', String(visible(key, preferences))); button.title = detail;
      const swatch = document.createElement('span'); swatch.className = 'chart-legend-swatch'; swatch.dataset.kind = kind;
      swatch.style.backgroundColor = kind === 'fill' ? color(swatchColor).alpha(0.4).rgbString() : swatchColor;
      swatch.style.borderColor = swatchColor; swatch.setAttribute('aria-hidden', 'true');
      button.append(swatch, document.createTextNode(label));
      button.addEventListener('click', () => {
        preferences[key] = !visible(key, preferences); savePreferences();
        for (const dataset of graph.data.datasets) if (dataset.visibilityKey === key) dataset.hidden = !preferences[key];
        button.setAttribute('aria-pressed', String(preferences[key])); graph.update('none');
      });
      group.append(button);
    }
    for (const shade of shades) add(groups[0], shade.key, shade.label, shade.detail, palette[shade.key], 'fill');
    for (const dataset of datasets) {
      if (dataset.key === 'outdoor_forecast') continue;
      add(groups[dataset.yAxisID === 'left' ? 1 : 2], dataset.visibilityKey, dataset.label, dataset.unit, dataset.borderColor, dataset.kind);
    }
    $('chart-legend').replaceChildren(...groups);
  }
  function renderChart() {
    if (!payload) return;
    // A theme or legend change can occur during a request. Keep the previous
    // graph's labels and axes attached to its own data until the new data arrives.
    const plot = plottedSelection;
    const datasets = historyDatasets(payload.series, plot.left, preferences, palette);
    for (const dataset of datasets) if (dataset.kind === 'fill') dataset.backgroundColor = color(dataset.backgroundColor).alpha(0.25).rgbString();
    const leftTitle = { power: 'Estimated power · kW', phases: 'Current · A', integral: 'Heating integral · °min' }[plot.left];
    const scales = {
      x: {
        type: 'linear', min: payload.range.from, max: payload.range.to,
        afterBuildTicks: scale => { scale.ticks = calendarTicks(payload.range, canvas.clientWidth < 600 ? 5 : 9); },
        grid: { color: palette.grid }, border: { color: palette.border },
        ticks: { color: palette.muted, autoSkip: false, maxTicksLimit: canvas.clientWidth < 600 ? 5 : 9, maxRotation: 0, callback: value => {
          if (value === payload.range.to && plot.startDate === plot.endDate) return '24:00';
          return plot.startDate === plot.endDate ? clock.format(value) : payload.range.to - payload.range.from > 3 * 86_400_000 ? shortDate.format(value) : [shortDate.format(value), clock.format(value)];
        } },
      },
      left: { type: 'linear', position: 'left', beginAtZero: plot.left !== 'integral', grid: { color: palette.grid }, border: { color: palette.border }, ticks: { color: palette.muted, maxTicksLimit: 7 }, title: { display: true, text: leftTitle, color: palette.muted } },
      right: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, border: { color: palette.border }, ticks: { color: palette.muted, maxTicksLimit: 7 }, title: { display: true, text: 'Temperature · °C / Price · c/kWh', color: palette.muted } },
    };
    if (graph) {
      graph.data.datasets = datasets; graph.options.scales = scales;
      graph.options.plugins.tooltip.backgroundColor = getTheme() === 'light' ? '#f4faf6' : '#142b20';
      graph.options.plugins.tooltip.titleColor = palette.text; graph.options.plugins.tooltip.bodyColor = palette.text;
      graph.update('none');
    } else {
      graph = new Chart(canvas, {
        type: 'line', data: { datasets }, plugins: [{ id: 'activityShading', beforeDatasetsDraw: paintShading }],
        options: {
          animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false }, scales,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: getTheme() === 'light' ? '#f4faf6' : '#142b20', titleColor: palette.text, bodyColor: palette.text,
              borderColor: palette.border, borderWidth: 1,
              callbacks: {
                title: items => items.length ? `${dateTime.format(items[0].parsed.x)} · Finland` : '',
                label: item => `${item.dataset.label}: ${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(item.parsed.y)} ${item.dataset.unit.split(' · ')[0]}`,
              },
            },
          },
        },
      });
    }
    renderLegend(datasets);
    const loading = selection.startDate !== plot.startDate || selection.endDate !== plot.endDate || selection.left !== plot.left;
    canvas.dataset.rangeStart = plot.startDate; canvas.dataset.rangeEnd = plot.endDate; canvas.dataset.left = plot.left; canvas.dataset.ready = String(!loading);
    const hasValues = datasets.some(dataset => !dataset.hidden && dataset.data.some(point => Number.isFinite(point.y)));
    const simulated = payload.input === 'simulated' ? ' · simulated data' : '';
    $('chart-status').textContent = loading ? 'Loading selected dates…' : `${plot.startDate === plot.endDate ? plot.startDate : `${plot.startDate} – ${plot.endDate}`} · Finnish time${simulated}${hasValues ? '' : ' · No visible readings for these dates'}`;
    const notes = ['Dashed outdoor line: forecast. All values stay within the selected dates.'];
    if (plot.left === 'power') notes.push('Power is estimated at 230 V from all three phase currents; it is not measured active power.');
    if (!(payload.series.all_in_price ?? []).some(point => Number.isFinite(point.y))) notes.push('All-in prices are unavailable for these dates. Spot price can be enabled in the legend.');
    if (Object.values(payload.shading ?? {}).some(intervals => intervals.some(interval => interval.aggregated))) notes.push('Shading on this long range is lighter in proportion to recorded activity within each time bucket.');
    for (const warning of payload.meta?.warnings ?? []) if (typeof warning === 'string') notes.push(warning.replaceAll('_', ' '));
    $('chart-notes').textContent = [...new Set(notes)].join(' ');
  }
  async function refresh(nextStatus = status, { force = false } = {}) {
    if (closed) return;
    status = nextStatus ?? { now: Date.now() };
    const today = finnishDate(status.now);
    if (!initialized || previousToday && today !== previousToday && activePreset) {
      selection = { ...selection, ...selectedRange(activePreset ?? 'today', status.now) };
      updateControls(); initialized = true;
    }
    previousToday = today;
    const contract = JSON.stringify(status.contract ?? null);
    const liveRevision = JSON.stringify({ input: status.input, observations: status.observations, providers: Object.fromEntries(Object.entries(status.providers ?? {}).map(([key, value]) => [key, value?.lastSuccessAt ?? value?.lastSuccess])) });
    if (lastContract !== undefined && contract !== lastContract) { loader.invalidate(); force = true; }
    if (lastLiveRevision !== undefined && liveRevision !== lastLiveRevision && selection.endDate >= today) force = true;
    lastContract = contract; lastLiveRevision = liveRevision;
    const generation = ++selectionGeneration;
    if (!payload || payload.range.startDate !== selection.startDate || payload.range.endDate !== selection.endDate || canvas.dataset.left !== selection.left) {
      $('chart-status').textContent = 'Loading selected dates…'; canvas.dataset.ready = 'false';
    }
    try {
      const result = await loader.load(selection, { force, today });
      if (generation !== selectionGeneration || closed) return;
      const nextFingerprint = JSON.stringify({ range: result.range, input: result.input, series: result.series, shading: result.shading, meta: result.meta, left: selection.left });
      payload = result; plottedSelection = { ...selection };
      if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; renderChart(); }
      else if (canvas.dataset.ready !== 'true') renderChart();
    } catch (error) {
      if (error.name === 'AbortError' || generation !== selectionGeneration || closed) return;
      $('chart-status').textContent = `Unable to load selected dates: ${error.message}`; canvas.dataset.ready = 'false';
    }
  }
  function choosePreset(preset) {
    activePreset = preset; selection = { ...selection, ...selectedRange(preset, status?.now ?? Date.now()) }; updateControls(); return refresh();
  }
  listen($('chart-range-form'), 'submit', event => {
    event.preventDefault(); activePreset = null;
    selection = { ...selection, startDate: $('date-start').value, endDate: $('date-end').value };
    updateControls(); refresh();
  });
  listen($('left-axis'), 'change', () => { selection = { ...selection, left: $('left-axis').value }; refresh(); });
  for (const preset of ['today', 'yesterday', 'tomorrow']) listen($(`range-${preset}`), 'click', () => choosePreset(preset));
  function updateTheme() { readPalette(); renderChart(); }
  readPalette(); updateControls();
  return { refresh, updateTheme, close() { closed = true; loader.close(); listeners.forEach(remove => remove()); graph?.destroy(); } };
}
