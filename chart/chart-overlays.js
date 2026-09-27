const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });

/** Categorical evidence occupies its own time-aligned rows. Requests, native
 * reports and model windows remain separate even when their intervals overlap. */
export const activityTracks = Object.freeze([
  { key: 'operatingMode', id: 'operating-modes', label: 'Pump mode', color: 'outdoor',
    detail: 'Configured operating mode from H66 readback; independent of compressor activity',
    caption: 'Pump mode · readback · blank intervals are unknown',
    values: { 0: 'Off', 1: 'Auto', 2: 'Compressor only', 3: 'Auxiliary only', 4: 'Hot water only' } },
  { key: 'compressorSpace', label: 'Compressor · house', color: 'compressorSpace',
    detail: 'Compressor reported on, valve routed to house heating; blank intervals include stopped or unavailable readings' },
  { key: 'compressorDhw', label: 'Compressor · hot water', color: 'compressorDhw',
    detail: 'Compressor reported on, valve routed to hot water; blank intervals include stopped or unavailable readings' },
  { key: 'compressorGarage', label: 'Compressor · garage', color: 'garage',
    detail: 'Garage compressor reported running; blank intervals include stopped or unavailable readings' },
  { key: 'heatOff', label: 'Tariff reduction request', color: 'heatOff',
    detail: 'Requested tariff reduction; this does not establish whether the compressor was running' },
  { key: 'dhwr', id: 'dhwr-history', label: 'DHWR', color: 'dhwr',
    caption: 'DHWR · requested circulation · recorded duration',
    detail: 'Timed hot-water circulation request. MQTT acknowledgement is not physical pump feedback.' },
  { key: 'fireplace', id: 'fireplace-history', label: 'Fireplace', color: 'fireplace',
    caption: 'Fireplace · model burn window',
    detail: 'Model burn window after manually recorded firewood additions; stored heat continues afterward' },
]);

/** Scalar display envelopes are not occupancy summaries. Retain missing breaks
 * and explicit interval evidence, and label ordinary steps as displayed samples
 * instead of claiming that decimation preserved every categorical transition. */
export function activityIntervals(descriptor, payload) {
  if (!payload) return [];
  if (descriptor.key === 'operatingMode') return payload.operatingModes ?? [];
  if (!descriptor.signal) return payload.shading?.[descriptor.key] ?? [];
  const points = payload.series?.[descriptor.signal] ?? [], intervals = [], seen = new Set();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const explicit = Number.isFinite(point.intervalStart) && Number.isFinite(point.intervalEnd) && point.intervalEnd > point.intervalStart;
    const start = explicit ? point.intervalStart : point.x;
    // Do not infer freshness for a last sample. Existing server-provided tails
    // and missing markers define coverage; a view change cannot extend it.
    const end = Math.min(explicit ? point.intervalEnd : points[index + 1]?.x ?? point.x,
      payload.range.to, Number.isFinite(payload.now) ? payload.now : payload.range.to);
    if (!(end > start)) {
      // A genuine isolated state report is still evidence. Show its instant
      // without assigning freshness or manufacturing a duration after it.
      if (!explicit && !point.displayBoundary && !point.carriedForward
        && point.x >= payload.range.from && point.x <= Math.min(payload.range.to, payload.now ?? payload.range.to))
        intervals.push({ ...point, start: point.x, end: point.x, value: point.y, pointOnly: true });
      continue;
    }
    const identity = `${start}:${end}:${point.y}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    intervals.push({ ...point, start, end, value: point.y, sampled: !explicit });
  }
  return intervals;
}

export function activityIntervalLabel(descriptor, interval) {
  const state = Number.isFinite(interval.value)
    ? descriptor.values?.[interval.value] ? `${descriptor.values[interval.value]} (${interval.value})` : `Value ${interval.value}` : descriptor.label;
  if (interval.pointOnly) return `${state} · ${dateTime.format(interval.start)} · recorded sample; duration unknown`;
  const occupancy = interval.aggregated ? ` · ${Math.round(Math.min(1, Math.max(0, interval.fraction ?? 0)) * 100)}% of this display interval` : '';
  const sample = interval.sampled ? ' · between displayed samples; intermediate changes may be omitted' : '';
  return `${state} · ${dateTime.format(interval.start)} – ${dateTime.format(interval.end)}${occupancy}${sample}`;
}

/** Convert browser coordinates only once. Chart.js logical pixels can differ
 * from CSS pixels after browser zoom; device-pixel-ratio never enters this math. */
export function historyCursorGeometry({ chart, canvasRect, panelRect, trackRects = [], clientX, clientY }) {
  const area = chart?.chartArea;
  if (!area || !chart.width || !chart.height || !canvasRect.width || !canvasRect.height) return null;
  const scaleX = canvasRect.width / chart.width, scaleY = canvasRect.height / chart.height;
  const left = canvasRect.left + area.left * scaleX, right = canvasRect.left + area.right * scaleX;
  const top = canvasRect.top + area.top * scaleY, plotBottom = canvasRect.top + area.bottom * scaleY;
  const bottom = Math.max(plotBottom, ...trackRects.filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.bottom));
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || clientX < left || clientX > right || clientY < top || clientY > bottom) return null;
  return { x: (clientX - canvasRect.left) / scaleX, left: Math.min(clientX, right - 1) - panelRect.left,
    top: plotBottom - panelRect.top, height: Math.max(0, bottom - plotBottom),
    plotLeft: left - panelRect.left, plotRight: right - panelRect.left,
    inPlot: clientY <= plotBottom, bottom: bottom - panelRect.top };
}

/** The canvas part draws before its tooltip. A separate, pointer-transparent
 * continuation spans the lower rows and stops before the legend and controls. */
export function createChartOverlays({ canvas, getChart, getPayload, getView, getPalette, getTracks,
  isVisible = () => true, isMoving = () => false, isTouchEnabled = () => false }) {
  const document = canvas.ownerDocument ?? globalThis.document, window = document.defaultView ?? globalThis.window;
  const panel = canvas.closest('.history-panel'), listeners = [], touchPointers = new Set();
  let rows = [], cursor, extension, readout, closed = false, touching;
  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    listeners.push(() => node.removeEventListener(type, handler, options));
  }
  function ensureCursor() {
    if (extension) return;
    extension = document.createElement('div'); extension.className = 'chart-crosshair-extension';
    extension.setAttribute('aria-hidden', 'true'); extension.hidden = true;
    readout = document.createElement('div'); readout.className = 'chart-crosshair-readout';
    readout.setAttribute('aria-hidden', 'true'); readout.hidden = true;
    panel.append(extension, readout);
  }
  function clear({ redraw = true } = {}) {
    const active = Boolean(cursor); cursor = undefined;
    if (extension) extension.hidden = true;
    if (readout) readout.hidden = true;
    if (active && redraw && !closed) getChart()?.draw();
  }
  function geometry(point, chart = getChart()) {
    const rect = panel.getBoundingClientRect();
    return historyCursorGeometry({ chart, canvasRect: canvas.getBoundingClientRect(),
      panelRect: { left: rect.left + (panel.clientLeft ?? 0) - (panel.scrollLeft ?? 0),
        top: rect.top + (panel.clientTop ?? 0) - (panel.scrollTop ?? 0) },
      trackRects: rows.map(visibleRowRect).filter(Boolean), ...point });
  }
  function visibleRowRect(row) {
    if (row.root.hidden) return null;
    const rect = row.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // Fullscreen activity can scroll in a bounded container. Offscreen rows
    // must not extend the cursor through the legend or steal hover inspection.
    const viewport = document.getElementById('chart-activity')?.getBoundingClientRect();
    if (!viewport) return rect;
    const top = Math.max(rect.top, viewport.top), bottom = Math.min(rect.bottom, viewport.bottom);
    return bottom > top ? { ...rect, width: rect.width, top, bottom, height: bottom - top } : null;
  }
  function synchronize(chart = getChart()) {
    if (!cursor || isMoving() || closed) return clear({ redraw: false });
    const bounds = geometry(cursor, chart);
    if (!bounds) return clear({ redraw: false });
    cursor.x = bounds.x;
    ensureCursor(); extension.hidden = !bounds.height;
    extension.style.left = `${bounds.left}px`; extension.style.top = `${bounds.top}px`; extension.style.height = `${bounds.height}px`;
    const row = rows.find(item => {
      const rect = visibleRowRect(item);
      if (!rect) return false;
      return cursor.clientY >= rect.top && cursor.clientY <= rect.bottom;
    });
    readout.hidden = !row;
    if (row) {
      const time = chart.scales.x.getValueForPixel(bounds.x);
      const active = row.intervals.filter(interval => interval.pointOnly
        ? Math.abs(chart.scales.x.getPixelForValue(interval.start) - bounds.x) <= 4
        : interval.start <= time && interval.end > time);
      const detail = active.length ? active.map(interval => activityIntervalLabel(row.descriptor, interval)).join('\n')
        : row.descriptor.signal || row.descriptor.key === 'operatingMode' ? 'No known state at this time' : 'No active interval recorded; stopped and unavailable periods may both be blank';
      readout.textContent = `${row.descriptor.label} · ${dateTime.format(time)}\n${detail}`;
      readout.style.maxWidth = `${Math.max(0, bounds.plotRight - bounds.plotLeft)}px`;
      readout.style.left = `${Math.max(bounds.plotLeft, Math.min(bounds.left + 12, bounds.plotRight - readout.offsetWidth))}px`;
      readout.style.top = `${Math.max(0, bounds.top - readout.offsetHeight - 8)}px`;
    }
  }
  function inspect(event) {
    if (closed || isMoving()) return clear();
    const point = { clientX: event.clientX, clientY: event.clientY };
    const bounds = geometry(point);
    if (!bounds) return clear();
    cursor = { ...point, x: bounds.x };
    synchronize(); getChart()?.draw();
  }
  function align(chart = getChart()) {
    if (!chart?.chartArea || !chart.width) return;
    const ratio = canvas.getBoundingClientRect().width / chart.width;
    for (const { root } of rows) {
      root.style.paddingLeft = `${chart.chartArea.left * ratio}px`;
      root.style.paddingRight = `${(chart.width - chart.chartArea.right) * ratio}px`;
    }
    synchronize(chart);
  }
  function render() {
    if (closed) return;
    const container = document.getElementById('chart-activity'), payload = getPayload();
    if (!container || !payload) return;
    const palette = getPalette(), view = getView() ?? payload.range;
    rows = [];
    const roots = [];
    for (const descriptor of getTracks()) {
      const root = document.createElement('div'); root.id = descriptor.id ?? `${descriptor.key}-history`;
      root.className = 'mode-history'; root.dataset.activityKey = descriptor.key;
      root.hidden = !isVisible(descriptor.key); root.title = descriptor.detail;
      root.setAttribute('aria-label', `${descriptor.label} history`);
      const title = document.createElement('p'); title.textContent = descriptor.caption ?? descriptor.label;
      if (descriptor.key === 'fireplace' && Number.isFinite(payload.meta?.fireplaceInputs?.burnHours))
        title.textContent += ` · ${payload.meta.fireplaceInputs.burnHours} h after each addition`;
      const track = document.createElement('div'); track.className = 'mode-track';
      const intervals = activityIntervals(descriptor, payload).filter(interval => interval.pointOnly
        ? interval.start >= view.from && interval.start <= view.to : interval.end > view.from && interval.start < view.to);
      const values = Object.keys(descriptor.values ?? {});
      for (const interval of root.hidden ? [] : intervals) {
        const from = Math.max(interval.start, view.from), to = Math.min(interval.end, view.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || !interval.pointOnly && from >= to) continue;
        const item = document.createElement('span'); item.className = 'mode-segment';
        item.style.left = `${100 * (from - view.from) / (view.to - view.from)}%`;
        item.style.width = interval.pointOnly ? '2px' : `${100 * (to - from) / (view.to - view.from)}%`;
        if (interval.pointOnly) { item.dataset.kind = 'point'; item.style.transform = 'translateX(-1px)'; item.style.borderRight = '0'; }
        item.style.opacity = String((interval.aggregated ? Math.min(1, Math.max(0, interval.fraction ?? 0)) : 1) * 0.75);
        const lane = values.indexOf(String(interval.value));
        if (interval.aggregated && lane >= 0) { item.style.top = `${lane * 100 / values.length}%`; item.style.height = `${100 / values.length}%`; }
        item.style.backgroundColor = descriptor.colors?.[interval.value] ? palette[descriptor.colors[interval.value]] : descriptor.key === 'operatingMode'
          ? [palette.muted, palette.indoor, palette.outdoor, palette.auxiliary, palette.compressorDhw][interval.value] ?? palette.muted
          : Number.isFinite(interval.value) && interval.value === 0 ? palette.muted : palette[descriptor.color ?? descriptor.key] ?? palette.muted;
        item.title = `${activityIntervalLabel(descriptor, interval)}\n${descriptor.detail}`;
        item.setAttribute('aria-label', item.title); track.append(item);
      }
      if (!track.children.length) title.textContent += ' · no recorded intervals';
      const viewport = document.createElement('div'); viewport.className = 'mode-viewport'; viewport.append(track);
      root.append(title, viewport); roots.push(root); rows.push({ root, descriptor, intervals });
    }
    container.replaceChildren(...roots); container.hidden = rows.every(row => row.root.hidden);
    align();
  }
  function paintNow(chart) {
    const payload = getPayload(), view = getView() ?? payload?.range, { ctx, chartArea, scales } = chart;
    if (!chartArea || !view || !payload || !(payload.now > view.from && payload.now < view.to)) return;
    const x = scales.x.getPixelForValue(payload.now);
    ctx.save(); ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = getPalette().muted; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.restore();
  }
  function paintCursor(chart) {
    synchronize(chart);
    if (!cursor) return;
    const { ctx, chartArea } = chart;
    ctx.save(); ctx.beginPath(); ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height); ctx.clip();
    ctx.globalAlpha = 0.75; ctx.strokeStyle = getPalette().muted; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(cursor.x, chartArea.top); ctx.lineTo(cursor.x, chartArea.bottom); ctx.stroke(); ctx.restore();
  }
  listen(panel, 'pointermove', event => {
    if (event.pointerType === 'touch') {
      if (touching && Math.hypot(event.clientX - touching.clientX, event.clientY - touching.clientY) > 4) touching.moved = true;
      return;
    }
    if (event.buttons) clear(); else inspect(event);
  }, { passive: true });
  listen(panel, 'pointerleave', event => { if (event.pointerType !== 'touch') clear(); });
  listen(panel, 'pointerdown', event => {
    clear();
    if (event.pointerType === 'touch') touchPointers.add(event.pointerId);
    touching = event.pointerType === 'touch' && touchPointers.size === 1 && isTouchEnabled()
      ? { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, moved: false } : undefined;
  }, { passive: true });
  listen(panel, 'pointerup', event => {
    if (touching?.pointerId === event.pointerId && !touching.moved && !isMoving()) inspect(event);
    touchPointers.delete(event.pointerId);
    touching = undefined;
  }, { passive: true });
  listen(panel, 'pointercancel', () => { touchPointers.clear(); touching = undefined; clear(); });
  listen(panel, 'wheel', () => clear(), { passive: true });
  listen(panel, 'scroll', () => clear(), { passive: true, capture: true });
  listen(document, 'pointerdown', event => { if (!panel.contains(event.target)) clear(); }, { passive: true });
  listen(document, 'keydown', event => { if (event.key === 'Escape') clear(); });
  listen(window, 'blur', () => clear());
  listen(window, 'resize', () => clear());
  return { render, clear, close() { closed = true; clear({ redraw: false }); touchPointers.clear(); listeners.forEach(remove => remove()); extension?.remove(); readout?.remove(); rows = []; },
    plugin: { id: 'historyOverlays', beforeDatasetsDraw: paintNow, afterDatasetsDraw: paintCursor,
      afterLayout: align, beforeEvent: () => isMoving() ? false : undefined } };
}
