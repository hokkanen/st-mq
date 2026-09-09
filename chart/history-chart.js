import Chart from 'chart.js/auto';
import { color } from 'chart.js/helpers';
import { calendarTicks, createChartLoader, defaultPalette, finnishDate, historyDatasets, historySeriesAt, selectedRange, visible, leftTitles, operationModes, leftAxisAvailability, historyValueLabel, coefficientStatusLabel, firewoodPointDetail } from './history-model.js';
import { outdoorSourceLabel, providerName } from './provider-status.js';
import { createTimingBenefit } from './timing-benefit.js';
import { populateHistoryAxes } from './recording.js';

const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const visibilityStorage = 'home-energy-chart-visibility';
const paletteVariables = {
  text: '--text', muted: '--muted', border: '--border', grid: '--grid',
  property: '--chart-property', ev: '--chart-ev', ev2: '--chart-ev2', phase1: '--chart-phase-1', phase2: '--chart-phase-2', phase3: '--chart-phase-3',
  indoor: '--chart-indoor', garage: '--chart-garage', outdoor: '--chart-outdoor', integral: '--chart-integral', price: '--chart-price', spot: '--chart-spot',
  heatOff: '--chart-heat-off', auxiliary: '--chart-auxiliary', compressorSpace: '--chart-compressor-space', compressorDhw: '--chart-compressor-dhw', dhwr: '--chart-dhwr', learning: '--chart-learning', solar: '--chart-solar',
  firewood: '--chart-firewood', fireplace: '--chart-fireplace',
};
const shades = [
  { key: 'heatOff', label: 'Tariff reduction requested', detail: 'Requested tariff reduction; compressor activity is shown separately' },
  { key: 'compressorSpace', label: 'Compressor · house', detail: 'Compressor reported on, valve routed to house heating' },
  { key: 'compressorDhw', label: 'Compressor · hot water', detail: 'Compressor reported on, valve routed to hot water' },
];
const activityTracks = [
  { key: 'operatingMode', id: 'operating-modes', label: 'Pump mode', detail: 'Configured operating mode from H66 readback; independent of compressor activity', color: 'outdoor' },
  { key: 'dhwr', label: 'DHWR', detail: 'Requested 10-minute hot-water recirculation pulses' },
  { key: 'fireplace', label: 'Fireplace', detail: 'Model burn window after manually recorded firewood additions; stored heat continues afterward' },
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
  populateHistoryAxes($('left-axis'));
  const loader = createChartLoader({ api });
  const timing = createTimingBenefit($('timing-benefit'));
  const preferences = loadPreferences();
  const listeners = [];
  let graph, payload, plottedSelection, fingerprint, status, initialized = false, closed = false;
  let palette = { ...defaultPalette }, lastContract, lastLiveRevision, lastFirewoodRevision, selectionGeneration = 0;
  let selection = { ...selectedRange('today', Date.now()), left: 'power', points: 800 };
  let activePreset = 'today', previousToday, rangeEnabled = false;

  function listen(node, event, handler) { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); }
  function updateControls() {
    $('date-start').value = selection.startDate; $('date-end').value = selection.endDate; $('left-axis').value = selection.left;
    $('date-range-enabled').checked = rangeEnabled;
    $('date-end').disabled = !rangeEnabled;
    $('date-end').min = selection.startDate;
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
        if (shade.key === 'heatOff') {
          ctx.save(); ctx.beginPath(); ctx.rect(left, chartArea.top, right - left, chartArea.height); ctx.clip();
          ctx.globalAlpha = 0.22 * (interval.aggregated ? interval.fraction : 1); ctx.strokeStyle = palette.heatOff; ctx.lineWidth = 0.6;
          ctx.beginPath();
          for (let x = Math.floor((left - chartArea.height) / 14) * 14; x < right + chartArea.height; x += 14) {
            ctx.moveTo(x, chartArea.top); ctx.lineTo(x + chartArea.height, chartArea.bottom);
            ctx.moveTo(x, chartArea.top); ctx.lineTo(x - chartArea.height, chartArea.bottom);
          }
          ctx.stroke(); ctx.restore();
        } else ctx.fillRect(left, chartArea.top, right - left, chartArea.height);
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
    groups[0].setAttribute('aria-label', 'Activity shading and strips'); groups[1].setAttribute('aria-label', 'Left axis'); groups[2].setAttribute('aria-label', 'Right axis');
    function add(group, key, label, detail, swatchColor, kind) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-legend-button';
      button.dataset.chartKey = key; button.setAttribute('aria-pressed', String(visible(key, preferences))); button.title = detail;
      const swatch = document.createElement('span'); swatch.className = 'chart-legend-swatch'; swatch.dataset.kind = kind;
      swatch.style.backgroundColor = kind === 'fill' ? color(swatchColor).alpha(0.4).rgbString() : swatchColor;
      swatch.style.borderColor = swatchColor; swatch.setAttribute('aria-hidden', 'true');
      button.append(swatch, document.createTextNode(label));
      button.addEventListener('click', () => {
        preferences[key] = !visible(key, preferences); savePreferences();
        const focused = document.activeElement === button;
        renderChart();
        if (focused) $('chart-legend').querySelector(`[data-chart-key="${key}"]`)?.focus({ preventScroll: true });
      });
      group.append(button);
    }
    for (const shade of shades) add(groups[0], shade.key, shade.label, shade.detail, palette[shade.key], shade.key === 'heatOff' ? 'pattern' : 'fill');
    for (const track of activityTracks) add(groups[0], track.key, track.label, `${track.detail} · Striped activity below the chart`, palette[track.color ?? track.key], 'strip');
    for (const dataset of datasets) {
      if (dataset.key === 'outdoor_forecast' && dataset.yAxisID !== 'left') continue;
      add(groups[dataset.yAxisID === 'left' ? 1 : 2], dataset.visibilityKey, dataset.label, dataset.unit, dataset.borderColor, dataset.kind);
    }
    $('chart-legend').replaceChildren(...groups);
  }
  function alignActivityTracks(chart) {
    const { width, chartArea } = chart;
    if (!chartArea || !width) return;
    for (const descriptor of activityTracks) {
      const root = $(descriptor.id ?? `${descriptor.key}-history`);
      if (!root) continue;
      root.style.paddingLeft = `${chartArea.left}px`; root.style.paddingRight = `${width - chartArea.right}px`;
    }
  }
  function renderModes() {
    for (const descriptor of activityTracks) {
      const root = $(descriptor.id ?? `${descriptor.key}-history`); if (!root) continue;
      root.replaceChildren(); root.hidden = !visible(descriptor.key, preferences);
      const isMode = descriptor.key === 'operatingMode';
      const intervals = (isMode ? payload?.operatingModes : payload?.shading?.[descriptor.key]) ?? [];
      const title = document.createElement('p');
      title.textContent = isMode ? 'Pump mode · readback (blank intervals: unknown)'
        : descriptor.key === 'dhwr' ? 'DHWR · requested recirculation'
          : `Fireplace · model burn window${Number.isFinite(payload.meta?.fireplaceInputs?.burnHours) ? ` · ${payload.meta.fireplaceInputs.burnHours} h after each addition` : ''}`;
      root.title = descriptor.detail;
      const track = document.createElement('div'); track.className = 'mode-track';
      for (const interval of intervals) {
        const from = Math.max(interval.start, payload.range.from), to = Math.min(interval.end, payload.range.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) continue;
        const item = document.createElement('span'); item.className = 'mode-segment';
        const name = isMode ? operationModes[interval.value] ?? 'Unknown' : descriptor.label;
        const fraction = interval.aggregated ? Math.min(1, Math.max(0, interval.fraction ?? 0)) : 1;
        item.style.left = `${100 * (from - payload.range.from) / (payload.range.to - payload.range.from)}%`;
        item.style.width = `${100 * (to - from) / (payload.range.to - payload.range.from)}%`;
        item.style.opacity = String(fraction * 0.7);
        if (isMode && interval.aggregated) { item.style.top = `${interval.value * 20}%`; item.style.height = '20%'; }
        item.style.backgroundColor = isMode
          ? [palette.muted, palette.indoor, palette.outdoor, palette.auxiliary, palette.compressorDhw][interval.value]
          : palette[descriptor.color ?? descriptor.key];
        item.title = `${name} · ${dateTime.format(from)} – ${dateTime.format(to)}${interval.aggregated ? ` · ${Math.round(fraction * 100)}% of this display interval` : ''}`;
        item.setAttribute('aria-label', item.title); track.append(item);
      }
      if (!track.children.length) title.textContent += isMode ? ' · no H66 readback in this period'
        : descriptor.key === 'dhwr' ? ' · no requests recorded in this period' : ' · no burn windows from recorded additions in this period';
      root.append(title, track);
    }
    alignActivityTracks(graph);
  }
  function renderTiming() {
    timing.render(payload);
  }
  function renderStatus(datasets) {
    const plot = plottedSelection;
    const loading = selection.startDate !== plot.startDate || selection.endDate !== plot.endDate || selection.left !== plot.left;
    const availability = leftAxisAvailability(datasets);
    const simulated = payload.input === 'simulated' ? ' · simulated data' : '';
    $('chart-status').textContent = loading ? 'Loading selected dates…' : `${plot.startDate === plot.endDate ? plot.startDate : `${plot.startDate} – ${plot.endDate}`} · Finnish time${simulated}${availability ? ` · ${availability}` : ''}`;
  }
  function renderChart() {
    if (!payload) return;
    // A theme or legend change can occur during a request. Keep the previous
    // graph's labels and axes attached to its own data until the new data arrives.
    const plot = plottedSelection;
    const datasets = historyDatasets(payload.series, plot.left, preferences, palette);
    for (const dataset of datasets) if (dataset.kind === 'fill') dataset.backgroundColor = color(dataset.backgroundColor).alpha(0.25).rgbString();
    const leftTitle = leftTitles[plot.left];
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
      left: { type: 'linear', position: 'left', beginAtZero: ['power', 'phases', 'solar_radiation', 'learning_recovery_error'].includes(plot.left), grid: { color: palette.grid }, border: { color: palette.border }, ticks: { color: palette.muted, maxTicksLimit: 7 }, title: { display: true, text: leftTitle, color: palette.muted } },
      right: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, border: { color: palette.border }, ticks: { color: palette.muted, maxTicksLimit: 7 }, title: { display: true, text: 'Temperature · °C / Price · c/kWh', color: palette.muted } },
    };
    if (graph) {
      graph.data.datasets = datasets; graph.options.scales = scales;
      graph.options.plugins.tooltip.backgroundColor = getTheme() === 'light' ? '#f4faf6' : '#142b20';
      graph.options.plugins.tooltip.titleColor = palette.text; graph.options.plugins.tooltip.bodyColor = palette.text;
      graph.update('none');
    } else {
      graph = new Chart(canvas, {
        type: 'line', data: { datasets }, plugins: [{ id: 'activityShading', beforeDatasetsDraw: paintShading, afterLayout: alignActivityTracks }],
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
                label: item => {
                  const source = item.dataset.key === 'outdoor_temperature' ? outdoorSourceLabel(item.raw?.source) : providerName(item.raw?.source);
                  const interval = Number.isFinite(item.raw?.intervalStart) && Number.isFinite(item.raw?.intervalEnd) ? ` · ${dateTime.format(item.raw.intervalStart)} – ${dateTime.format(item.raw.intervalEnd)}` : '';
                  const reconstructed=item.dataset.key==='heat_pump_power'?' · reconstructed estimate':'';
                  const value = historyValueLabel(item.dataset.key, item.raw?.componentValue ?? item.parsed.y, item.dataset.unit);
                  const coefficient = item.raw?.modelCoefficient ? ` · ${coefficientStatusLabel(item.raw.coefficientStatus)}${item.raw.inputSource ? ` · ${item.raw.inputSource}` : ''}${Number.isFinite(item.raw.modelUpdatedAt) ? ` · model updated ${dateTime.format(item.raw.modelUpdatedAt)}` : ''}` : '';
                  const firewood = firewoodPointDetail(item.dataset.key, item.raw);
                  return `${item.dataset.label}: ${value}${source ? ` · ${source}` : ''}${interval}${reconstructed}${coefficient}${firewood ? ` · ${firewood}` : item.raw?.modelInput ? ` · ${item.raw.inputSource ?? 'Recorded history'} · saved learning input` : ''}${item.raw?.equivalentCurrent?' · equivalent at 230 V':''}${item.raw?.auditOnly?' · meter check only':''}${item.raw?.carriedForward ? ` · last recorded ${dateTime.format(item.raw.observedAt)}` : ''}`;
                },
              },
            },
          },
        },
      });
    }
    renderLegend(datasets);
    renderModes(); renderTiming();
    const loading = selection.startDate !== plot.startDate || selection.endDate !== plot.endDate || selection.left !== plot.left;
    canvas.dataset.rangeStart = plot.startDate; canvas.dataset.rangeEnd = plot.endDate; canvas.dataset.left = plot.left; canvas.dataset.ready = String(!loading);
    renderStatus(datasets);
    const notes = ['Outdoor readings use H66, FMI stations or Open-Meteo model estimates. Dashed outdoor line: forecast. All values stay within the selected dates.'];
    if (datasets.some(dataset => dataset.data.some(point => point.carriedForward))) notes.push('Lines carry the last recorded readings forward to now; these extensions are not new measurements.');
    if (plot.left === 'power') notes.push(payload.meta?.powerEstimate ?? 'Power is an interval average derived from estimated energy.');
    if (plot.left === 'phases') notes.push('New currents are equivalent interval averages derived from phase energy at 230 V and unity power factor. Older current-only history retains the original snapshots.');
    if (plot.left === 'phase_energy') notes.push('Each point is estimated energy over its recorded interval. Recording intervals may have different durations.');
    if (plot.left === 'heat_pump_power') notes.push('Heat-pump electricity is reconstructed from saved equipment states and dated nominal power assumptions. It is an estimate; missing, stale or unverified source periods appear as gaps.');
    if (plot.left.startsWith('model_coefficient_')) {
      notes.push('Coefficients are reconstructed from the saved learning journal and applicable corrected firewood history without additional stored history. Stepped lines retain each value until the reconstructed model changes. Tooltips distinguish initial estimates, fitted values and retained values awaiting evidence. Unavailable replay history remains blank.');
    } else if (plot.left === 'model_fireplace_release') {
      notes.push('Fireplace release is calculated from corrected firewood additions using the delayed masonry response. Its kg/h unit is fuel equivalent, not a burn-rate measurement or delivered kW. Heat from additions before these dates can continue into the selection; periods before logging began remain unknown.');
    } else if (plot.left.startsWith('model_')) {
      notes.push('Model inputs are the values saved with completed learning intervals. They are not recalculated using today’s model or settings. Missing or rejected intervals appear as gaps; the indoor endpoint is the observed prediction target.');
      if (payload.meta?.modelInputs?.rejectedIntervals) notes.push(`${payload.meta.modelInputs.rejectedIntervals} input segments were excluded by recorded quality checks.`);
    }
    if (plot.left === 'firewood_load') notes.push('Triangles show manually added kilograms. Additions with exactly the same timestamp are combined and counted in the tooltip. Corrections exclude mistaken additions. The empty space between points does not describe fireplace heat release.');
    if (['firewood_savings', 'firewood_electricity_avoided'].includes(plot.left)) notes.push('Each diamond is a Finnish-day total over supported elapsed intervals. Hollow points are provisional model estimates; filled points use validated response evidence. These retrospective estimates compare heating electricity with and without logged firewood, with wood cost set to €0. They are separate from the Heating and Charging timing comparisons; missing evidence remains a gap.');
    if (plot.left === 'outdoor_forecast') notes.push('This view shows the forecast from now onward. It does not reconstruct past outdoor forecasts.');
    if (payload.meta?.historyBasis === 'original-recorded-history') notes.push('Charts read the original saved history. Point reduction for display and cached chart responses stay in memory; they create no additional database history. Energy and cost calculations use the original recorded intervals.');
    if (plot.left.endsWith('_energy_counter')) notes.push('Meter counters are diagnostic references only. They do not correct recorded energy or train the model.');
    if (plot.left === 'power') {
      notes.push('Auxiliary fill uses verified heater output and configured electrical capacity.');
      const charger = datasets.find(dataset => dataset.key === 'charger_power');
      if (charger.powerStacked) notes.push('Charger power is stacked above auxiliary power; tooltips show each load’s own kW. Missing auxiliary readings leave gaps in the combined fill; hiding auxiliary shows charger power from zero.');
      else if (!charger.hidden) notes.push(visible('auxiliary_power', preferences)
        ? 'No overlapping auxiliary and charger readings are available to stack. Charger power is shown from zero.'
        : 'Charger power is shown from zero while auxiliary power is hidden.');
    }
    if (plot.left.startsWith('learning_')) {
      const metadata = payload.meta?.learning?.[plot.left];
      if (metadata) notes.push(`Latest assessment: ${dateTime.format(metadata.at)}${Number.isFinite(metadata.count) ? ` · ${metadata.count} contributing cycles/observations` : ''}${metadata.basis ? ` · ${metadata.basis}` : ''}.`);
    }
    if (!(payload.series.all_in_price ?? []).some(point => Number.isFinite(point.y))) notes.push('All-in prices are unavailable for these dates. Spot price can be enabled in the legend.');
    if (Object.values(payload.shading ?? {}).some(intervals => intervals.some(interval => interval.aggregated))) notes.push('Shading is lighter in proportion to recorded activity within each display interval. These display intervals are combined in memory.');
    for (const warning of payload.meta?.warnings ?? []) if (typeof warning === 'string') notes.push(warning.replaceAll('_', ' '));
    $('chart-notes').textContent = [...new Set(notes)].join(' ');
  }
  async function refresh(nextStatus = status, { force = false } = {}) {
    if (closed) return;
    status = nextStatus ?? { now: Date.now() };
    const today = finnishDate(status.now);
    if (!initialized || previousToday && today !== previousToday && activePreset) {
      if (activePreset) selection = { ...selection, ...selectedRange(activePreset, status.now) };
      updateControls(); initialized = true;
    }
    previousToday = today;
    const contract = JSON.stringify(status.contract ?? null);
    const firewoodRevision = JSON.stringify({ revision: status.fireplace?.revision, rebuilding: status.fireplace?.rebuild?.status,
      model: status.learning?.adaptive?.model?.trainedAt });
    if (lastFirewoodRevision !== undefined && firewoodRevision !== lastFirewoodRevision) { loader.invalidate(); force = true; }
    lastFirewoodRevision = firewoodRevision;
    const liveRevision = status.recording?.historyRevision ?? JSON.stringify({ input: status.input, observations: status.observations,
      metrics: status.learning?.metrics, h66Readings: status.h66?.readings,
      providers: Object.fromEntries(Object.entries(status.providers ?? {}).map(([key, value]) => [key, value?.lastSuccessAt ?? value?.lastSuccess])) });
    if (lastContract !== undefined && contract !== lastContract) { loader.invalidate(); force = true; }
    const longRange=Date.parse(selection.endDate)-Date.parse(selection.startDate)>=7*86400000;
    if (!longRange && lastLiveRevision !== undefined && liveRevision !== lastLiveRevision && selection.endDate >= today) force = true;
    lastContract = contract; lastLiveRevision = liveRevision;
    const generation = ++selectionGeneration;
    if (!payload || payload.range.startDate !== selection.startDate || payload.range.endDate !== selection.endDate || canvas.dataset.left !== selection.left) {
      $('chart-status').textContent = 'Loading selected dates…'; canvas.dataset.ready = 'false';
    }
    try {
      const result = await loader.load(selection, { force, today });
      if (generation !== selectionGeneration || closed) return;
      // The response cache may contain unchanged measurements. Advance their
      // display tails and the now marker using each fresh server-status clock.
      const plotNow = Number.isFinite(status.now) ? status.now : result.now;
      payload = { ...result, now: plotNow, series: historySeriesAt(result, plotNow) };
      const nextFingerprint = JSON.stringify({ range: payload.range, input: payload.input, series: payload.series, shading: payload.shading, meta: payload.meta, timingBenefit: payload.timingBenefit, heatingBenefit: payload.heatingBenefit, firewoodBenefit: payload.firewoodBenefit, left: selection.left,
        now: plotNow >= payload.range.from && plotNow < payload.range.to ? plotNow : null });
      plottedSelection = { ...selection };
      if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; renderChart(); }
      else if (canvas.dataset.ready !== 'true') renderChart();
    } catch (error) {
      if (error.name === 'AbortError' || generation !== selectionGeneration || closed) return;
      $('chart-status').textContent = `Unable to load selected dates: ${error.message}`; canvas.dataset.ready = 'false';
    }
  }
  function choosePreset(preset) {
    rangeEnabled = preset !== 'today';
    activePreset = preset; selection = { ...selection, ...selectedRange(preset, status?.now ?? Date.now()) }; updateControls(); return refresh();
  }
  function applyDates() {
    if (!$('chart-range-form').checkValidity()) return;
    activePreset = null;
    selection = { ...selection, startDate: $('date-start').value, endDate: rangeEnabled ? $('date-end').value : $('date-start').value };
    updateControls(); refresh();
  }
  listen($('date-start'), 'change', () => {
    const start = $('date-start');
    if (!start.checkValidity()) return;
    const end = $('date-end');
    end.min = start.value;
    if (!rangeEnabled || !end.value || end.value < start.value) end.value = start.value;
    applyDates();
  });
  listen($('date-end'), 'change', applyDates);
  listen($('date-range-enabled'), 'change', () => {
    rangeEnabled = $('date-range-enabled').checked;
    $('date-end').disabled = !rangeEnabled;
    $('date-end').min = $('date-start').value;
    if (!rangeEnabled || !$('date-end').value || $('date-end').value < $('date-start').value) $('date-end').value = $('date-start').value;
    if (rangeEnabled) $('date-end').focus();
    else applyDates();
  });
  listen($('chart-range-form'), 'submit', event => {
    event.preventDefault(); applyDates();
  });
  listen($('left-axis'), 'change', () => { selection = { ...selection, left: $('left-axis').value }; refresh(); });
  for (const preset of ['today', 'yesterday', 'tomorrow']) listen($(`range-${preset}`), 'click', () => choosePreset(preset));
  function updateTheme() { readPalette(); renderChart(); }
  readPalette(); updateControls();
  return { refresh, updateTheme, close() { closed = true; loader.close(); timing.close(); listeners.forEach(remove => remove()); graph?.destroy(); } };
}
