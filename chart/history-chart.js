import Chart from 'chart.js/auto';
import { Interaction } from 'chart.js';
import { color } from 'chart.js/helpers';
import { calendarTicks, chartQuery, createChartLoader, defaultPalette, finnishDate, historySeriesAt, selectedRange, shiftDate, dateSelection, visible } from './history-model.js';
import { createDatePicker } from './date-picker.js';
import { historyTooltipCallbacks, historyTooltipsEnabled, historyTooltipInteraction, historyTooltipDismissPlugin } from './history-tooltips.js';
export { historyTooltipLabel, historyTooltipTitle } from './history-tooltips.js';
import { createComparisonRange } from './comparison-range.js';
import { selectedChartView, chartSelectionKey, readChartPreferences, chartViewPreferences, setChartVisibility, chartSubjectAvailability, CHART_PREFERENCES_KEY } from './chart-views.js';
import { EXPLORER_SERIES_BY_KEY, explorerActivityTrack } from './series-explorer.js';
import { createSeriesPicker } from './series-picker.js';
import { createChartOverlays, activityTracks } from './chart-overlays.js';
import { chartObservationTime, replicaSnapshotKey } from './replica-status.js';
import { createChartNavigation } from './chart-navigation.js';
import { createDetailLoader, viewportTicks } from './chart-viewport.js';
import { chartBucketWidth, chartDetailRequest, selectChartResolution } from './chart-resolution.js';
import { powerFillPlugin } from './power-fill.js';
import { createChartGeometryCache } from './chart-geometry-cache.js';
import { styleChartGeometry } from './chart-geometry.js';
import { chartLoadingLabel } from './chart-stream.js';
import { ENERGY_SIGNALS } from '../src/domain/history-series.js';
import { createElectricityForecastLoader, withElectricityForecast } from './electricity-forecast.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
Interaction.modes.historyPoint = historyTooltipInteraction;
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const datedYear = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric' });
const paletteVariables = {
  text: '--text', muted: '--muted', border: '--border', grid: '--grid',
  property: '--chart-property', ev: '--chart-ev', ev2: '--chart-ev2', phase1: '--chart-phase-1', phase2: '--chart-phase-2', phase3: '--chart-phase-3',
  indoor: '--chart-indoor', upstairs: '--chart-upstairs', downstairs: '--chart-downstairs', bedroom: '--chart-bedroom', garage: '--chart-garage', caravan: '--chart-caravan', outdoor: '--chart-outdoor', integral: '--chart-integral', price: '--chart-price', spot: '--chart-spot',
  heatOff: '--chart-heat-off', auxiliary: '--chart-auxiliary', compressorSpace: '--chart-compressor-space', compressorDhw: '--chart-compressor-dhw', dhwr: '--chart-dhwr', learning: '--chart-learning', solar: '--chart-solar',
  firewood: '--chart-firewood', fireplace: '--chart-fireplace',
  reference: '--chart-reference', garageFront: '--chart-garage-front', garagePump: '--chart-garage-pump', supply: '--chart-supply', return: '--chart-return', brineIn: '--chart-brine-in', brineOut: '--chart-brine-out',
  garagePipeRear: '--chart-garage-pipe-rear', garagePipeFront: '--chart-garage-pipe-front',
};
export function historyRenderFingerprint(overview, selection) {
  const { elapsedMs, cacheHit, workerElapsedMs, serializedBytes, ...meaning } = overview.meta ?? {};
  // Production responses have a worker-computed digest. The fallback serves
  // direct current-format data callers without treating diagnostics as history.
  const content = overview.meta?.contentRevision ?? JSON.stringify({ range: overview.range, input: overview.input,
    series: overview.series, shading: overview.shading, operatingModes: overview.operatingModes, meta: meaning });
  return JSON.stringify([content, chartSelectionKey(selection),
    overview.now >= overview.range.from && overview.now < overview.range.to ? overview.now : null]);
}
export function historyLegendLabel(axis, view, datasets) {
  if (axis === 'activity') return 'Activity rows';
  // Hidden series remain selectable in the legend, so they still belong to its group.
  const members = datasets.filter(dataset => dataset.yAxisID === axis);
  const temperatures = members.some(dataset => dataset.unit?.split(' · ')[0] === '°C') && !(axis === 'left' && view.unit === 'Δ°C');
  const prices = members.some(dataset => ['spot_price', 'all_in_price'].includes(dataset.key));
  return temperatures && prices ? 'Temperature & price' : temperatures ? 'Temperature' : prices ? 'Price' : view.unit || 'Values';
}
export function historyValueScales(view, datasets, palette = defaultPalette) {
  const hasLeft = datasets.some(dataset => dataset.yAxisID === 'left' && !dataset.hidden);
  const right = datasets.filter(dataset => dataset.yAxisID === 'right' && !dataset.hidden);
  const temperatures = right.some(dataset => !['spot_price', 'all_in_price'].includes(dataset.key));
  const prices = right.some(dataset => ['spot_price', 'all_in_price'].includes(dataset.key));
  const shared = { type: 'linear', border: { color: palette.border }, ticks: { color: palette.muted, maxTicksLimit: 7 } };
  return {
    left: { ...shared, position: 'left', display: hasLeft,
      beginAtZero: ['kW', 'A', 'W/m²', '%', 'fraction'].includes(view.unit), grid: { color: palette.grid },
      title: { display: true, text: view.unit, color: palette.muted } },
    right: { ...shared, position: 'right', display: right.length > 0,
      grid: { color: palette.grid, drawOnChartArea: !hasLeft },
      title: { display: true, text: [temperatures ? 'Temperature · °C' : '', prices ? 'Price · c/kWh' : ''].filter(Boolean).join(' / '), color: palette.muted } },
  };
}

/** Report deadlines need prompt renewal even in a cached year view. Ordinary
 * high-frequency measurements retain the longer overview refresh interval. */
export function recordingChangedForSelection(selection,today,previous,current) {
  if (!previous) return false;
  if (selection.startDate<=today && selection.endDate>=today && previous.temperatureReportRevision!==undefined
    && previous.temperatureReportRevision!==current.temperatureReportRevision) return true;
  const longRange=Date.parse(selection.endDate)-Date.parse(selection.startDate)>=7*86400000;
  return !longRange && selection.endDate>=today
    && ['historyRevision','sourceReportRevision'].some(key=>previous[key]!==undefined&&previous[key]!==current[key]);
}

/** The chart owns only its controls and fetches; the monitor owns authentication. */
export function createHistoryChart({ api, getTheme = () => document.documentElement.dataset.theme }) {
  const $ = id => document.getElementById(id);
  const canvas = $('history');
  const mobilePointer = window.matchMedia('(pointer: coarse)');
  const loader = createChartLoader({ api });
  const priceForecastLoader = createElectricityForecastLoader({ api });
  const geometry = createChartGeometryCache();
  const comparisons = createComparisonRange({ api });
  let storage; try { storage = localStorage; } catch { /* Optional browser persistence. */ }
  const preferences = readChartPreferences(storage);
  const listeners = [];
  let graph, payload, overview, detail, plottedSelection, displayedSelection, fingerprint, status, initialized = false, closed = false;
  let palette = { ...defaultPalette }, lastContract, lastRecording, lastFirewoodRevision, lastReplicaSnapshot, selectionGeneration = 0;
  let selection = { ...selectedRange('today', Date.now()), points: 800, ...selectionForView(preferences.view) };
  let suggestedEndDate = selection.endDate, rangeActive = false;
  let activePreset = 'today';
  let detailState = 'idle', pendingFullRender = false, refreshQueued = false, queuedForce = false, lastInput;
  let overlays, renderGeneration = 0, lastLegendKey, lastNotesKey, loadingProgress;
  let priceForecast, forecastSeriesCache, forecastRead, forecastExpiryTimer, statusReceivedAt = Date.now();
  const forecastClock = () => (Number.isFinite(status?.now) ? status.now : statusReceivedAt)
    + Math.max(0, Date.now() - statusReceivedAt);
  function expirePriceForecast() {
    if (!priceForecast) return;
    if (forecastClock() < priceForecast.expiresAt) {
      clearTimeout(forecastExpiryTimer);
      forecastExpiryTimer = setTimeout(expirePriceForecast, Math.max(1, Math.ceil(priceForecast.expiresAt - forecastClock())));
      return;
    }
    priceForecast = null; forecastSeriesCache = undefined;
    clearTimeout(forecastExpiryTimer); forecastExpiryTimer = undefined;
    void renderChart();
  }
  function acceptPriceForecast(next) {
    if (closed) return;
    if (next && !(forecastClock() < next.expiresAt)) next = null;
    clearTimeout(forecastExpiryTimer); forecastExpiryTimer = undefined;
    if (next?.available) forecastExpiryTimer = setTimeout(expirePriceForecast, Math.max(1, next.expiresAt - forecastClock()));
    if (JSON.stringify(priceForecast) === JSON.stringify(next)) return;
    priceForecast = next; forecastSeriesCache = undefined;
    // Optional predictions must never hold up recorded history rendering.
    void renderChart();
  }
  const navigation = createChartNavigation({ canvas, getChart: () => graph, onMove: () => overlays?.clear(), onSettle: () => {
    if (!overview || closed) return;
    renderChart({ viewOnly: navigation.fullscreen && !pendingFullRender }); requestDetail();
    if (refreshQueued) { const force = queuedForce; refreshQueued = queuedForce = false; refresh(status, { force }); }
  } });
  const detailLoader = createDetailLoader({ api, query: chartQuery,
    onData(result, request) {
      if (closed || !navigation.fullscreen || !sameSelection(request, selection) || !sameSelection(request, plottedSelection)) return;
      // Keep a finer covering view even if a coarser request finishes later.
      const selected = selectChartResolution(overview, [detail, { ...result, points: request.points }], navigation.view);
      if (selected !== overview) detail = selected;
      if (!navigation.moving) renderChart({ viewOnly: true });
    },
    onStatus(state) { detailState = state; renderDetailStatus(); },
  });
  overlays = createChartOverlays({ canvas, getChart: () => graph, getPayload: () => payload,
    getView: () => navigation.view ?? payload?.range, getPalette: () => palette,
    getTracks: () => tracksForView(selectedChartView(displayedSelection ?? selection)),
    isVisible: key => visible(key, chartViewPreferences(selectedChartView(displayedSelection ?? selection), preferences)),
    isMoving: () => navigation.moving,
  });
  const seriesPicker = createSeriesPicker({ getSelected: () => preferences, onOpen: () => overlays.clear(),
    onSelect(chosen) {
      preferences.view = chosen.view;
      if (chosen.series) preferences.series = chosen.series;
      savePreferences();
      const { view, left, series, ...range } = selection;
      selection = { ...range, ...selectionForView(preferences.view) };
      overlays.clear(); updateControls(); refresh();
    },
  });
  function selectionForView(key) {
    if (key === 'explorer') return { left: EXPLORER_SERIES_BY_KEY[preferences.series].requestKey, series: preferences.series };
    return { view: key };
  }
  function tracksForView(view) {
    return view.tracks.map(key => activityTracks.find(track => track.key === key) ?? explorerActivityTrack(key));
  }
  function sameSelection(a, b) { return a && b && a.startDate === b.startDate && a.endDate === b.endDate && chartSelectionKey(a) === chartSelectionKey(b); }
  function invalidateDetail() { detail = undefined; detailLoader.invalidate(); }
  function invalidate() { loader.invalidate(); invalidateDetail(); geometry.clear(); ++renderGeneration; }
  function cachedDetails() {
    return detailLoader.entries().filter(entry => sameSelection(entry.selection, plottedSelection))
      .map(entry => ({ ...entry.data, points: entry.selection.points }));
  }
  function renderDetailStatus() {
    const node = $('chart-detail-status');
    node.dataset.state = detailState;
    node.textContent = !sameSelection(selection, plottedSelection) ? 'Loading selected series…' : detailState === 'loading' ? 'Loading detail…'
      : detailState === 'error' ? 'Detail unavailable · existing view retained' : payload?.meta?.detail ? 'Detail loaded' : 'Overview';
  }
  function requestDetail() {
    if (!navigation.fullscreen) { detailLoader.request(null); return; }
    const view = navigation.view;
    if (!view || !overview || !sameSelection(selection, plottedSelection)) return;
    // Expired detail remains a display fallback, but cannot suppress a fresh
    // request indefinitely. The loader owns TTL, invalidation and cache bounds.
    const available = selectChartResolution(overview, cachedDetails(), view);
    let request = chartDetailRequest(plottedSelection, overview.range, view, available);
    const displayed = selectChartResolution(overview, [detail], view);
    if (displayed !== overview && chartBucketWidth(displayed) < chartBucketWidth(available)
      && (!request || (request.viewTo - request.viewFrom) / request.points > chartBucketWidth(displayed))) {
      // Refresh an expired finer level at its existing coverage if the newly
      // quantized window would otherwise replace it with coarser buckets.
      request = { ...plottedSelection, points: displayed.points, viewFrom: displayed.range.from, viewTo: displayed.range.to };
    }
    detailLoader.request(request);
  }

  function listen(node, event, handler) { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); }
  function updateControls() {
    startDatePicker.dismiss(); endDatePicker.dismiss();
    $('date-start').value = selection.startDate; $('date-end').value = suggestedEndDate;
    seriesPicker.update();
    $('date-end').dataset.singleDay = String(!rangeActive);
    $('date-end').min = selection.startDate;
    for (const preset of ['today', 'yesterday', 'tomorrow']) $(`range-${preset}`).setAttribute('aria-pressed', String(activePreset === preset));
  }
  function readPalette() {
    const styles = getComputedStyle(document.documentElement);
    palette = Object.fromEntries(Object.entries(paletteVariables).map(([key, variable]) => [key, styles.getPropertyValue(variable).trim() || defaultPalette[key]]));
  }
  function savePreferences() {
    try {
      if (!storage) return false;
      storage.setItem(CHART_PREFERENCES_KEY, JSON.stringify(preferences));
      return true;
    } catch { return false; /* Charts remain usable when storage is unavailable. */ }
  }
  function renderLegend(datasets, view, visibility) {
    const legend = $('chart-legend');
    const scrollTop = legend.dataset.viewKey === view.key ? legend.scrollTop : 0;
    const groups = ['left', 'right', 'activity'].map(axis => {
      const group = document.createElement('div'); group.className = 'chart-legend-group'; group.dataset.axis = axis;
      const label = document.createElement('span'); label.className = 'chart-legend-axis';
      label.textContent = historyLegendLabel(axis, view, datasets);
      group.setAttribute('aria-label', label.textContent); group.append(label); return group;
    });
    function add(group, key, label, detail, swatchColor, kind, dash = []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-legend-button';
      button.dataset.chartKey = key; button.dataset.axis = group.dataset.axis;
      button.setAttribute('aria-pressed', String(visible(key, visibility))); button.title = detail;
      const swatch = document.createElement('span'); swatch.className = 'chart-legend-swatch'; swatch.dataset.kind = kind;
      swatch.dataset.pattern = dash.length > 2 ? 'dash-dot' : dash[0] === 1 ? 'dotted' : dash.length ? 'dashed' : 'solid';
      swatch.style.color = swatchColor;
      swatch.style.backgroundColor = ['audit', 'session', 'interval-energy'].includes(kind) ? 'transparent'
        : kind === 'fill' ? color(swatchColor).alpha(0.4).rgbString() : swatchColor;
      swatch.style.borderColor = swatchColor; swatch.setAttribute('aria-hidden', 'true');
      button.append(swatch, document.createTextNode(label));
      button.addEventListener('click', () => {
        setChartVisibility(preferences, view, key, !visible(key, visibility)); savePreferences();
        const focused = document.activeElement === button;
        void renderChart().then(() => { if (focused) $('chart-legend').querySelector(`[data-chart-key="${key}"]`)?.focus({ preventScroll: true }); });
      });
      group.append(button);
    }
    for (const dataset of datasets) add(groups[dataset.yAxisID === 'left' ? 0 : 1], dataset.visibilityKey,
      dataset.label, dataset.unit, dataset.borderColor, dataset.kind, dataset.borderDash);
    for (const track of tracksForView(view)) add(groups[2], track.key, track.label, track.detail, palette[track.color ?? track.key], 'strip');
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'chart-legend-reset'; reset.textContent = 'Reset view';
    reset.title = 'Restore this view’s default series and activity rows; keep your price and interpolation choices';
    reset.addEventListener('click', () => { delete preferences.views[view.key]; savePreferences(); void renderChart().then(() => $('chart-legend-actions').querySelector('.chart-legend-reset')?.focus({ preventScroll: true })); });
    const save = document.createElement('button'); save.type = 'button'; save.className = 'chart-legend-save'; save.textContent = 'Save view';
    save.title = 'Save the selected view, series visibility, price and interpolation choices in this browser';
    save.addEventListener('click', () => { save.textContent = savePreferences() ? 'View saved' : 'Save failed'; });
    const interpolation = document.createElement('button'); interpolation.type = 'button'; interpolation.className = 'chart-legend-interpolation';
    interpolation.setAttribute('aria-label', 'Interpolation'); interpolation.setAttribute('aria-pressed', String(preferences.interpolation));
    interpolation.title = preferences.interpolation
      ? 'Interpolation is on. Turn off to draw all connected lines as steps.'
      : 'Interpolation is off. Turn on to restore the usual curves and straight lines.';
    const state = document.createElement('span'); state.className = 'chart-interpolation-state';
    state.textContent = preferences.interpolation ? 'ON' : 'OFF'; state.setAttribute('aria-hidden', 'true');
    interpolation.append(document.createTextNode('Interpolation'), state);
    interpolation.addEventListener('click', () => {
      preferences.interpolation = !preferences.interpolation; savePreferences();
      const focused = document.activeElement === interpolation;
      overlays.clear(); void renderChart().then(() => {
        if (focused) $('chart-legend-actions').querySelector('.chart-legend-interpolation')?.focus({ preventScroll: true });
      });
    });
    legend.replaceChildren(...groups.filter(group => group.children.length > 1));
    $('chart-legend-actions').replaceChildren(interpolation, reset, save);
    // Replacing the scrolling children resets the browser's scroll anchor.
    // Keep the same place for toggles and refreshes; a different view starts at top.
    legend.dataset.viewKey = view.key;
    legend.scrollTop = scrollTop;
  }
  function renderStatus(datasets) {
    const plot = plottedSelection;
    const loading = !sameSelection(selection, plot);
    const view = selectedChartView(plot);
    const availability = chartSubjectAvailability(view, datasets, payload, chartViewPreferences(view, preferences));
    const simulated = payload.input === 'simulated' ? ' · simulated data' : '';
    $('chart-status').textContent = loading ? chartLoadingLabel(loadingProgress) : `${plot.startDate === plot.endDate ? plot.startDate : `${plot.startDate} – ${plot.endDate}`} · Finnish time${simulated}${availability ? ` · ${availability}` : ''}`;
  }
  async function renderChart({ viewOnly = false } = {}) {
    const render = ++renderGeneration;
    try { await drawChart({ viewOnly, render }); }
    catch (error) {
      if (closed || error.name === 'AbortError' || render !== renderGeneration) return;
      $('chart-status').textContent = `Unable to draw chart: ${error.message}`; canvas.dataset.ready = 'false';
    }
  }
  async function drawChart({ viewOnly, render }) {
    if (!overview) return;
    if (navigation.moving) { if (!viewOnly) pendingFullRender = true; return; }
    viewOnly = viewOnly && !pendingFullRender; pendingFullRender = false;
    const view = navigation.view ?? overview.range;
    const exploring = navigation.fullscreen && (view.from > overview.range.from || view.to < overview.range.to);
    const source = exploring ? selectChartResolution(overview, [detail, ...cachedDetails()], view) : overview;
    if (source !== overview) detail = source;
    const plotNow = chartObservationTime(status, source.now);
    let nextPayload = source === overview ? overview : { ...source, now: plotNow, series: historySeriesAt(source, plotNow) };
    const forecastNow = forecastClock();
    const forecastKey = JSON.stringify([priceForecast?.fetchedAt, priceForecast?.expiresAt,
      forecastNow < priceForecast?.expiresAt, Math.floor(forecastNow / 60_000)]);
    if (forecastSeriesCache?.series !== nextPayload.series || forecastSeriesCache.key !== forecastKey || forecastSeriesCache.forecast !== priceForecast)
      forecastSeriesCache = { series: nextPayload.series, key: forecastKey, forecast: priceForecast,
        merged: withElectricityForecast(nextPayload.series, priceForecast, nextPayload.range, forecastNow) };
    if (forecastSeriesCache.merged !== nextPayload.series) nextPayload = { ...nextPayload, series: forecastSeriesCache.merged };
    const started = performance.now();
    // A theme or legend change can occur during a request. Keep the previous
    // graph's labels and axes attached to its own data until the new data arrives.
    const plot = plottedSelection;
    // The server has already bounded the envelope. Zoom must retain all loaded
    // detail until finer buckets arrive, including the first small wheel step.
    const chartView = selectedChartView(plot), visibility = chartViewPreferences(chartView, preferences);
    const prepared = await geometry.prepare({ series: nextPayload.series, descriptor: chartView, visibility,
      interpolation: preferences.interpolation, ...(exploring ? { view } : {}) });
    if (closed || render !== renderGeneration || !sameSelection(plot, plottedSelection)) return;
    if (navigation.moving) { pendingFullRender = true; return; }
    const datasets = styleChartGeometry(prepared, chartView, visibility, palette, preferences.interpolation);
    canvas.dataset.prepareMs = String(Math.round(performance.now() - started));
    // A paint/task boundary presents progress and lets a new date selection
    // cancel this preparation before Chart.js begins its bounded canvas update.
    if (canvas.dataset.ready !== 'true') $('chart-status').textContent = chartLoadingLabel({ stage: 'drawing' });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (closed || render !== renderGeneration || !sameSelection(plot, plottedSelection)) return;
    payload = nextPayload; displayedSelection = plot;
    const drawingStarted = performance.now();
    for (const dataset of datasets) if (dataset.kind === 'fill') dataset.backgroundColor = color(dataset.backgroundColor).alpha(0.25).rgbString();
    const span = view.to - view.from;
    // Reserve space for both value axes and for the widest date format. A
    // phone cannot fit the same number of year-bearing labels as short dates.
    const tickWidth = span > 180 * 86_400_000 ? 110 : span > 3 * 86_400_000 ? 75 : 65;
    const tickLimit = Math.max(2, Math.min(9, Math.floor((canvas.clientWidth - 120) / tickWidth) + 1));
    const scales = {
      x: {
        type: 'linear', min: view.from, max: view.to,
        afterBuildTicks: scale => { scale.ticks = navigation.fullscreen ? viewportTicks(view, tickLimit) : calendarTicks(overview.range, tickLimit); },
        grid: { color: palette.grid }, border: { color: palette.border },
        ticks: { color: palette.muted, autoSkip: false, maxTicksLimit: tickLimit, maxRotation: 0, callback: value => {
          if (value === overview.range.to && plot.startDate === plot.endDate) return '24:00';
          return span > 180 * 86_400_000 ? datedYear.format(value) : span > 3 * 86_400_000 ? shortDate.format(value)
            : finnishDate(view.from) === finnishDate(view.to - 1) ? clock.format(value) : [shortDate.format(value), clock.format(value)];
        } },
      },
      ...historyValueScales(chartView, datasets, palette),
    };
    // Touch devices keep datapoint popups in fullscreen in either orientation.
    const tooltipsEnabled = historyTooltipsEnabled({ fullscreen: navigation.fullscreen, coarsePointer: mobilePointer.matches });
    if (graph) {
      graph.data.datasets = datasets; graph.options.scales = scales;
      graph.options.plugins.tooltip.enabled = tooltipsEnabled;
      if (!tooltipsEnabled) graph.tooltip?.setActiveElements([], { x: 0, y: 0 });
      graph.options.plugins.tooltip.backgroundColor = getTheme() === 'light' ? '#f4faf6' : '#142b20';
      graph.options.plugins.tooltip.titleColor = palette.text; graph.options.plugins.tooltip.bodyColor = palette.text;
      // animation:false already makes this immediate. Chart.js' 'none' mode
      // skips updating shared point options, leaving compact marker colours
      // stale after a theme change when the same dataset objects are reused.
      graph.update();
    } else {
      graph = new Chart(canvas, {
        type: 'line', data: { datasets }, plugins: [powerFillPlugin, overlays.plugin, historyTooltipDismissPlugin],
        options: {
          animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: false,
          interaction: { mode: 'historyPoint', axis: 'x', intersect: false }, scales,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: tooltipsEnabled,
              backgroundColor: getTheme() === 'light' ? '#f4faf6' : '#142b20', titleColor: palette.text, bodyColor: palette.text,
              borderColor: palette.border, borderWidth: 1,
              titleFont: { size: 12 }, bodyFont: { size: 12 },
              callbacks: historyTooltipCallbacks,
            },
          },
        },
      });
    }
    const drawMs = performance.now() - drawingStarted;
    canvas.dataset.drawMs = String(Math.round(drawMs)); canvas.dataset.resolutionMs = String(chartBucketWidth(source));
    canvas.dataset.dataFrom = String(payload.range.from); canvas.dataset.dataTo = String(payload.range.to);
    overlays.render(); renderDetailStatus();
    if (viewOnly) return;
    const legendKey = JSON.stringify([chartView.key, visibility, preferences.interpolation, palette]);
    if (legendKey !== lastLegendKey) { lastLegendKey = legendKey; renderLegend(datasets, chartView, visibility); }
    $('chart-view-description').textContent = chartView.description;
    canvas.setAttribute('aria-label', `${chartView.label} for ${plot.startDate} to ${plot.endDate}. ${chartView.description}`);
    const loading = !sameSelection(selection, plot);
    canvas.dataset.rangeStart = plot.startDate; canvas.dataset.rangeEnd = plot.endDate; canvas.dataset.view = plot.view ?? 'explorer'; canvas.dataset.series = plot.series ?? ''; canvas.dataset.left = plot.left ?? plot.view; canvas.dataset.ready = String(!loading);
    renderStatus(datasets);
    const noteFlags = datasets.map(dataset => [dataset.kind, dataset.chartEvidence?.carriedForward,
      !dataset.hidden && dataset.chartEvidence?.needsAttention]);
    const aggregated = Object.values(payload.shading ?? {}).some(intervals => intervals.some(interval => interval.aggregated));
    const hasPriceForecast = datasets.some(dataset => !dataset.hidden && dataset.data.some(point => point.priceForecast));
    const notesKey = JSON.stringify([chartView.key, preferences.interpolation, noteFlags, aggregated, hasPriceForecast,
      replicaSnapshotKey(status) !== null, payload.meta?.warnings]);
    if (notesKey === lastNotesKey) return;
    lastNotesKey = notesKey;
    const keys = [...chartView.leftSignals, ...chartView.rightSignals];
    const notes = ['Left-axis lines are solid; right-axis temperatures are dashed. Weather forecasts use dash-dot lines; electricity prices are dotted. Toggle any legend item to tailor this view; price choices apply to every view.',
      (preferences.interpolation
        ? 'Temperature curves use cubic interpolation without overshoot, including displayed settings and targets. Recorded values remain unchanged; a curve between settings does not imply gradual control changes. Power and states retain their steps. '
        : 'Interpolation is off: all connected lines use steps. Recorded values and individual observation markers remain unchanged. ')
      + 'Missing evidence remains a gap. Activity rows share the time axis; hover or drag along a bar to inspect the same moment across the chart. Open a row title for its colours and explanation.'];
    if (hasPriceForecast) notes.push('Sparse dots extend published electricity prices with predictions from Energy Price Forecast EU. Forecasts are estimates, available up to 48 hours from download; they are not recorded prices or bills.');
    if (chartView.stackPhases) notes.push('Charger currents form translucent stacks separately for L1, L2 and L3. Each phase keeps its property reference line. Tooltips show each charger’s own current; stacks require overlapping recorded evidence.');
    if (keys.includes('property_current_max')) notes.push('Property highest phase is the maximum of the simultaneous phase-current estimates, calculated before display reduction. It is an interval average, not an instantaneous peak. Its activity row identifies the phase with the phase chart colours; inspection explains ties. Charger allowances show available current, independently of actual draw, native settings and permission to start. Charger 2 includes fallback periods in its allowance line; its activity row explains the allowance basis. Missing evidence stays blank.');
    if (keys.includes('solar_radiation')) notes.push('Solar estimate is the latest valid weather estimate known at each historical time, not a solar sensor reading. Later forecast revisions do not replace it. The future Solar forecast remains separate.');
    if (keys.some(key => ['charger_power', 'charger2_power'].includes(key))) notes.push('Translucent fills show the two chargers, stacked only where their recorded intervals overlap. Tooltips show each charger’s own power. Auxiliary and whole heat-pump estimates are separate lines; the whole estimate includes auxiliary.');
    if (keys.includes('garage_native_indoor_temperature')) notes.push('Pump interpreted indoor temperature is native readback after the pump’s sensing or external-temperature processing; it is not an independent protection probe.');
    if (keys.some(key => key.startsWith('model_'))) notes.push('Saved learning inputs retain the original interval evidence. Quality eligibility does not establish that a model fit used a point. Coefficients replay the supported journal and correction context; they are not a promise of the model’s original operational state.');
    if (chartView.key === 'learning_heat') notes.push('The combined thermal estimate includes compressor and auxiliary heat. The separate saved auxiliary electrical input remains available in All series as Space-heating auxiliary input.');
    if (keys.some(key => ENERGY_SIGNALS.includes(key) || key === 'garage_energy')) notes.push('Energy points describe the original recording intervals, which can have different durations. Do not compare them as equal-period totals.');
    if (keys.includes('caravan_power')) notes.push('Caravan power is measured meter energy divided by its original interval duration. It shows average electrical load, not instantaneous peaks; original energy readings remain in Series explorer.');
    if (datasets.some(dataset => ['audit', 'session', 'interval-energy'].includes(dataset.kind))) notes.push('Hollow circles mark individual recorded readings or interval totals. Hover or tap a point in fullscreen to inspect its value and original time; gaps do not imply a zero reading.');
    if (keys.some(key => key.includes('_current_'))) notes.push('Reconstructed currents use historical per-phase voltage estimates and assume unity power factor; they are interval averages, not instantaneous RMS peaks. Imported current observations retain their original basis.');
    if (datasets.some(dataset => dataset.chartEvidence?.carriedForward)) notes.push(replicaSnapshotKey(status) !== null
      ? 'Display tails carry the last reading to the saved snapshot time; these extensions are not new measurements.'
      : 'Display tails carry the last reading to now; these extensions are not new measurements.');
    if (datasets.some(dataset => !dataset.hidden && dataset.chartEvidence?.needsAttention)) notes.push('Some saved temperatures include last known readings. Inspect the point for source times and excluded learning evidence.');
    if (replicaSnapshotKey(status) !== null) notes.push('Read-only slave: the vertical time marker is the master snapshot time.');
    if (aggregated) notes.push('At long ranges, lighter activity segments indicate the occupied fraction of a display interval, not an exact continuous state.');
    for (const warning of payload.meta?.warnings ?? []) if (typeof warning === 'string') notes.push(warning.replaceAll('_', ' '));
    $('chart-notes').textContent = [...new Set(notes)].join(' ');
  }
  async function refresh(nextStatus = status, { force = false } = {}) {
    if (closed) return;
    // An explicit refresh follows a mutation and must discard earlier queries.
    // Recorder updates discovered below may still coalesce a slow live query.
    if (force) invalidate();
    if (status !== nextStatus) statusReceivedAt = Date.now();
    status = nextStatus ?? { now: Date.now() };
    expirePriceForecast();
    if (navigation.moving && overview && sameSelection(selection, plottedSelection)) { refreshQueued = true; queuedForce ||= force; return; }
    const today = finnishDate(status.now);
    if (!initialized) {
      if (activePreset) {
        selection = { ...selection, ...selectedRange(activePreset, status.now) };
        suggestedEndDate = selection.endDate;
      }
      updateControls(); initialized = true;
    }
    const requestedSelection = { ...selection };
    // Applied dates are fixed even across midnight. A preset changes them only
    // when the user explicitly chooses it again.
    const snapshot = replicaSnapshotKey(status);
    if (lastReplicaSnapshot !== undefined && snapshot !== lastReplicaSnapshot) { invalidate(); force = true; }
    lastReplicaSnapshot = snapshot;
    const contract = JSON.stringify(status.contract ?? null);
    const firewoodRevision = JSON.stringify({ revision: status.fireplace?.revision, rebuilding: status.fireplace?.rebuild?.status,
      model: status.learning?.adaptive?.model?.trainedAt });
    if (lastFirewoodRevision !== undefined && firewoodRevision !== lastFirewoodRevision) { invalidate(); force = true; }
    lastFirewoodRevision = firewoodRevision;
    const liveRevision = status.recording?.historyRevision ?? JSON.stringify({ input: status.input, observations: status.observations,
      metrics: status.learning?.metrics, h66Readings: status.h66?.readings,
      providers: Object.fromEntries(Object.entries(status.providers ?? {}).map(([key, value]) => [key, value?.lastSuccessAt ?? value?.lastSuccess])) });
    if (lastContract !== undefined && contract !== lastContract) { invalidate(); force = true; }
    if (lastInput !== undefined && lastInput !== status.input) { invalidate(); force = true; }
    lastInput = status.input;
    // Ordinary recorder progress expires through the detail TTL. Aborting on
    // every poll would repeatedly kill slow queries for historical viewports.
    const recording={historyRevision:liveRevision,historySelection:status.recording?.historySelection,temperatureReportRevision:status.recording?.temperatureReportRevision,
      sourceReportRevision:status.recording?.sourceReportRevision};
    // Recovery revisions can change any recorded date. Discard pending work and
    // every cached range, including historical overviews and zoomed detail.
    if (lastRecording?.historySelection !== undefined && lastRecording.historySelection !== recording.historySelection) {
      invalidate(); force = true;
    }
    if (recordingChangedForSelection(selection,today,lastRecording,recording)) {
      force = true;
      if (lastRecording?.temperatureReportRevision!==recording.temperatureReportRevision) invalidateDetail();
    }
    lastContract = contract; lastRecording = recording;
    const generation = ++selectionGeneration;
    if (!payload || payload.range.startDate !== selection.startDate || payload.range.endDate !== selection.endDate || chartSelectionKey(plottedSelection ?? {}) !== chartSelectionKey(selection)) {
      invalidateDetail();
      ++renderGeneration; geometry.cancel(); loadingProgress = { stage: 'queued' };
      $('chart-status').textContent = chartLoadingLabel(loadingProgress); canvas.dataset.ready = 'false';
    }
    try {
      const forecastRequest = priceForecastLoader.load(status);
      forecastRead = forecastRequest;
      void forecastRequest.then(nextForecast => {
        if (forecastRead === forecastRequest) acceptPriceForecast(nextForecast);
      });
      const result = await loader.load(requestedSelection, { force, today, onProgress(progress) {
        if (generation !== selectionGeneration || closed || !sameSelection(requestedSelection, selection)) return;
        loadingProgress = progress;
        $('chart-status').textContent = chartLoadingLabel(progress);
      } });
      if (generation !== selectionGeneration || closed || !sameSelection(requestedSelection, selection)) return;
      // The response cache may contain unchanged measurements. Advance their
      // display tails and the now marker using each fresh server-status clock.
      const plotNow = chartObservationTime(status, result.now);
      const nextFingerprint = historyRenderFingerprint({ ...result, now: plotNow }, selection);
      plottedSelection = requestedSelection;
      if (nextFingerprint !== fingerprint) {
        overview = { ...result, points: requestedSelection.points, now: plotNow, series: historySeriesAt(result, plotNow) };
        fingerprint = nextFingerprint;
        navigation.setRange(overview.range);
        await renderChart();
      } else if (canvas.dataset.ready !== 'true') await renderChart();
      else renderStatus(graph?.data.datasets ?? []);
      if (generation !== selectionGeneration || closed || !sameSelection(requestedSelection, selection)) return;
      if (!navigation.moving) requestDetail();
      loader.prefetch(requestedSelection, { today });
    } catch (error) {
      if (error.name === 'AbortError' || generation !== selectionGeneration || closed) return;
      $('chart-status').textContent = `Unable to load selected dates: ${error.message}`; canvas.dataset.ready = 'false';
    }
  }
  function choosePreset(preset) {
    activePreset = preset; selection = { ...selection, ...selectedRange(preset, status?.now ?? Date.now()) };
    suggestedEndDate = selection.endDate; rangeActive = preset !== 'today';
    updateControls(); return refresh();
  }
  function shiftRange(days) {
    // Shift the last valid selected window, preserving its inclusive length.
    selection = { ...selection, startDate: shiftDate(selection.startDate, days), endDate: shiftDate(selection.endDate, days) };
    if (rangeActive) suggestedEndDate = selection.endDate;
    activePreset = null;
    updateControls(); return refresh();
  }
  function applyDate(field) {
    const node = $(field === 'start' ? 'date-start' : 'date-end');
    if (!node.checkValidity()) return;
    const dates = dateSelection(selection, field, node.value);
    if (!dates) return;
    activePreset = null; selection = { ...selection, ...dates };
    rangeActive = field === 'end';
    if (rangeActive) suggestedEndDate = dates.endDate;
    updateControls(); refresh();
  }
  const startDatePicker = createDatePicker($('date-start'), { label: 'Choose start date', onSelect() { applyDate('start'); } });
  const endDatePicker = createDatePicker($('date-end'), { label: 'Choose end date', onSelect() { applyDate('end'); } });
  listen($('date-start'), 'change', () => applyDate('start'));
  listen($('date-end'), 'change', () => applyDate('end'));
  listen($('chart-range-form'), 'submit', event => event.preventDefault());
  listen($('chart-legend-panel'), 'toggle', () => {
    overlays.clear(); graph?.resize();
  });
  listen($('chart-legend-panel'), 'keydown', event => {
    if (event.key !== 'Escape' || !$('chart-legend-panel').open) return;
    event.preventDefault(); event.stopPropagation();
    $('chart-legend-panel').open = false;
    $('chart-legend-toggle').focus({ preventScroll: true });
  });
  for (const preset of ['today', 'yesterday', 'tomorrow']) listen($(`range-${preset}`), 'click', () => choosePreset(preset));
  listen($('range-back'), 'click', () => shiftRange(-1));
  listen($('range-forward'), 'click', () => shiftRange(1));
  listen(mobilePointer, 'change', () => renderChart());
  listen(document, 'visibilitychange', () => { if (document.hidden) loader.cancelPrefetch(); expirePriceForecast(); });
  function updateTheme() { readPalette(); renderChart(); }
  readPalette(); updateControls();
  return { refresh(nextStatus, options) {
    return Promise.all([refresh(nextStatus, options), comparisons.refresh(nextStatus, options)]);
  }, updateTheme, close() { closed = true; clearTimeout(forecastExpiryTimer); startDatePicker.close(); endDatePicker.close(); seriesPicker.close(); overlays.close(); navigation.close(); detailLoader.close(); loader.close(); priceForecastLoader.close(); geometry.close(); comparisons.close(); listeners.forEach(remove => remove()); graph?.destroy(); } };
}
