import { clampView, zoomView, panView, viewportTicks } from './chart-viewport.js';
import { enterPageFullscreen, exitPageFullscreen } from './page-fullscreen.js';

const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'short', day: 'numeric' });
const tickClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Gesture frames only transform a bitmap. Chart.js and data preparation run
 * after movement settles, independently of network refinement. */
export function createChartNavigation({ canvas, getChart, onSettle, onMove }) {
  const $ = id => document.getElementById(id), panel = canvas.closest('.history-panel');
  const shortcuts = ['garage-chart-shortcut'].map($).filter(Boolean);
  const pointers = new Map(), listeners = [], inertNodes = [];
  let bounds, view, zoom = 1, fullscreen = false, closed = false, timer, frame, moving = false;
  let snapshot, preview, originalView, tracks = [], gesture, savedFocus, oldOverflow, oldRole, oldModal, fullscreenView, pageFullscreenAtEntry = false, suppressClick = false;
  const minimum = 60_000;
  function listen(node, type, fn, options) { node.addEventListener(type, fn, options); listeners.push(() => node.removeEventListener(type, fn, options)); }
  function baseSpan() {
    const fraction = fullscreen && innerHeight > innerWidth ? Math.min(1, innerWidth / innerHeight) : 1;
    return Math.max(Math.min(minimum, bounds.to - bounds.from), (bounds.to - bounds.from) * fraction);
  }
  function maxView() { return { from: bounds.from, to: bounds.from + baseSpan() }; }
  function sync() {
    if (!view) return;
    const span = view.to - view.from, available = bounds.to - bounds.from - span;
    canvas.dataset.viewFrom = String(view.from); canvas.dataset.viewTo = String(view.to);
    canvas.dataset.selectedFrom = String(bounds.from); canvas.dataset.selectedTo = String(bounds.to); canvas.dataset.zoom = String(zoom);
    const navigator = $('chart-navigator');
    navigator.disabled = !fullscreen || available <= 1; navigator.value = String(available > 0 ? 1000 * (view.from - bounds.from) / available : 0);
    navigator.setAttribute('aria-valuetext', `${stamp.format(view.from)} to ${stamp.format(view.to)}`);
    const overview = $('chart-overview');
    overview.style.setProperty('--view-start', `${100 * (view.from - bounds.from) / (bounds.to - bounds.from)}%`);
    overview.style.setProperty('--view-width', `${100 * span / (bounds.to - bounds.from)}%`);
    $('chart-selected-start').textContent = day.format(bounds.from);
    $('chart-selected-end').textContent = day.format(bounds.to - 1);
    $('chart-visible-range').textContent = `${stamp.format(view.from)} – ${stamp.format(view.to)}`;
  }
  function clearPreview() {
    preview?.remove(); preview = snapshot = originalView = undefined;
    for (const track of tracks) { track.style.transform = ''; track.style.transformOrigin = ''; }
    tracks = [];
  }
  function capture() {
    if (snapshot || !getChart()?.chartArea) return;
    const graph = getChart();
    originalView = { from: graph.scales.x.min, to: graph.scales.x.max };
    const active = graph.getActiveElements().length || graph.tooltip?.getActiveElements().length;
    graph.setActiveElements([]); graph.tooltip?.setActiveElements([], { x: 0, y: 0 });
    // Most gestures can copy the already painted chart immediately. A redraw
    // is only needed to remove a visible hover highlight or tooltip.
    if (active) graph.draw();
    snapshot = document.createElement('canvas'); snapshot.width = canvas.width; snapshot.height = canvas.height;
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    preview = document.createElement('canvas'); preview.className = 'chart-gesture-preview';
    preview.width = canvas.width; preview.height = canvas.height; preview.setAttribute('aria-hidden', 'true');
    canvas.parentElement.append(preview);
    tracks = [...panel.querySelectorAll('.mode-track')];
  }
  function paintPreview() {
    frame = undefined;
    if (!snapshot || !view || !getChart()) return;
    const graph = getChart(), area = graph.chartArea, ctx = preview.getContext('2d');
    const ratio = canvas.width / graph.width, span = view.to - view.from;
    const factor = (originalView.to - originalView.from) / span;
    const shift = (originalView.from - view.from) / span * area.width;
    const styles = getComputedStyle(panel), background = styles.getPropertyValue('--surface').trim() || '#142b20';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.scale(ratio, ratio);
    ctx.fillStyle = background; ctx.fillRect(area.left, area.top, area.width, graph.height - area.top);
    ctx.fillRect(0, area.bottom + 1, graph.width, graph.height - area.bottom);
    ctx.save(); ctx.beginPath(); ctx.rect(area.left, area.top, area.width, area.height); ctx.clip();
    const from = Math.max(view.from, originalView.from), to = Math.min(view.to, originalView.to);
    if (to > from) {
      // Crop first: even years-to-minutes zoom never asks the canvas to paint
      // a destination rectangle millions of pixels wider than the screen.
      const sourceSpan = originalView.to - originalView.from;
      ctx.drawImage(snapshot, (area.left + (from - originalView.from) / sourceSpan * area.width) * ratio, area.top * ratio,
        (to - from) / sourceSpan * area.width * ratio, area.height * ratio,
        area.left + (from - view.from) / span * area.width, area.top, (to - from) / span * area.width, area.height);
    }
    ctx.restore();
    ctx.fillStyle = styles.getPropertyValue('--muted').trim(); ctx.font = '11px sans-serif'; ctx.textBaseline = 'top';
    const tickLimit = Math.max(2, Math.min(8, Math.floor(area.width / (span > 86400000 ? 110 : 65)) + 1));
    const ticks = viewportTicks(view, tickLimit);
    ticks.forEach(({ value }, index) => {
      const x = area.left + (value - view.from) / span * area.width;
      ctx.textAlign = index === 0 ? 'left' : index === ticks.length - 1 ? 'right' : 'center';
      ctx.fillText(span <= 86400000 ? tickClock.format(value) : day.format(value), x, area.bottom + 8);
    });
    for (const track of tracks) { track.style.transformOrigin = '0 50%'; track.style.transform = `translateX(${shift}px) scaleX(${factor})`; }
  }
  function settle() {
    clearTimeout(timer); timer = undefined;
    if (closed || pointers.size) return;
    moving = false;
    if (frame) cancelAnimationFrame(frame); frame = undefined;
    clearPreview();
    onSettle?.(view && { ...view });
  }
  function move(next) {
    if (!fullscreen || !bounds || closed) return;
    onMove?.();
    capture();
    const limited = clampView(next, bounds, Math.min(minimum, baseSpan()));
    const span = Math.min(limited.to - limited.from, baseSpan());
    view = clampView({ from: limited.from, to: limited.from + span }, bounds, Math.min(minimum, baseSpan()));
    zoom = baseSpan() / (view.to - view.from); moving = true;
    sync();
    if (!frame) frame = requestAnimationFrame(paintPreview);
    clearTimeout(timer); timer = setTimeout(settle, 180);
  }
  function reset() { if (fullscreen && bounds) { zoom = 1; move(maxView()); } }
  function zoomBy(factor, anchor = 0.5) {
    if (!fullscreen || !view) return;
    const targetSpan = Math.min(baseSpan(), (view.to - view.from) / factor);
    move(zoomView(view, bounds, (view.to - view.from) / targetSpan, anchor, Math.min(minimum, baseSpan())));
  }
  function resize() {
    if (!bounds || closed) return;
    onMove?.();
    pointers.clear(); gesture = undefined; clearPreview(); moving = false; clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame); frame = undefined;
    const center = (view.from + view.to) / 2, span = baseSpan() / zoom;
    view = fullscreen ? clampView({ from: center - span / 2, to: center + span / 2 }, bounds, Math.min(minimum, baseSpan())) : { ...bounds };
    zoom = baseSpan() / (view.to - view.from); sync();
    getChart()?.resize(); onSettle?.({ ...view });
  }
  function leave() {
    if (!fullscreen) return;
    if (view) fullscreenView = { ...view, zoom };
    fullscreen = false; panel.dataset.fullscreen = 'false'; document.body.classList.remove('chart-fullscreen-open');
    canvas.removeAttribute('tabindex'); canvas.removeAttribute('aria-describedby');
    suppressClick = false;
    document.body.style.overflow = oldOverflow;
    for (const [node, inert] of inertNodes.splice(0)) node.inert = inert;
    if (oldRole === null) panel.removeAttribute('role'); else panel.setAttribute('role', oldRole);
    if (oldModal === null) panel.removeAttribute('aria-modal'); else panel.setAttribute('aria-modal', oldModal);
    reflectChartButton(false);
    for (const shortcut of shortcuts) shortcut.setAttribute('aria-expanded', 'false');
    // Restore the original page state only while fullscreen is still active.
    // An interruption leaves chart inspection open; re-entry uses this same rule.
    if (!pageFullscreenAtEntry && document.fullscreenElement) exitPageFullscreen(document).catch(() => {});
    resize(); savedFocus?.focus({ preventScroll: true });
  }
  function reflectChartButton(active) {
    const button = $('chart-fullscreen');
    button.dataset.chartView = String(active);
    button.setAttribute('aria-expanded', String(active));
    button.setAttribute('aria-label', active ? 'Exit chart view' : 'Open chart view');
    button.title = active ? 'Exit chart view' : 'Open chart view';
  }
  function enter(event) {
    if (fullscreen) return leave();
    pageFullscreenAtEntry = Boolean(document.fullscreenElement);
    savedFocus = document.activeElement; oldOverflow = document.body.style.overflow;
    oldRole = panel.getAttribute('role'); oldModal = panel.getAttribute('aria-modal');
    fullscreen = true; panel.dataset.fullscreen = 'true'; document.body.classList.add('chart-fullscreen-open'); document.body.style.overflow = 'hidden';
    if (fullscreenView) { view = { from: fullscreenView.from, to: fullscreenView.to }; zoom = fullscreenView.zoom; }
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('aria-describedby', 'chart-gesture-help');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    for (let node = panel; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node) { inertNodes.push([sibling, sibling.inert]); sibling.inert = true; }
    }
    reflectChartButton(true);
    for (const shortcut of shortcuts) shortcut.setAttribute('aria-expanded', 'true');
    $('chart-fullscreen').focus({ preventScroll: true }); resize();
    // CSS fullscreen remains usable in embedded views and on phones without
    // the native API. A denied browser request does not close that layout.
    // Keep one fullscreen element for both modes, so chart Exit cannot pop a
    // nested fullscreen stack or hide the dashboard after leaving inspection.
    const root = document.documentElement;
    if (!pageFullscreenAtEntry && event?.isTrusted && document.fullscreenEnabled && root.requestFullscreen) {
      enterPageFullscreen(document, () => !closed && fullscreen).catch(() => {});
    }
  }
  function pointerBasis() {
    const points = [...pointers.values()];
    return { view: view && { ...view }, x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      distance: points.length > 1 ? Math.max(10, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)) : 0, moved: false };
  }
  listen($('chart-fullscreen'), 'click', enter);
  for (const shortcut of shortcuts) listen(shortcut, 'click', enter);
  listen($('chart-navigator'), 'input', event => {
    if (!fullscreen || !view) return;
    const span = view.to - view.from, from = bounds.from + Number(event.target.value) / 1000 * (bounds.to - bounds.from - span);
    move({ from, to: from + span });
  });
  listen(canvas, 'wheel', event => {
    if (!fullscreen || !view) return;
    event.preventDefault();
    const area = getChart().chartArea, x = event.clientX - canvas.getBoundingClientRect().left;
    zoomBy(Math.exp(-Math.max(-160, Math.min(160, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1))) * 0.004), Math.max(0, Math.min(1, (x - area.left) / area.width)));
  }, { passive: false });
  listen(canvas, 'pointerdown', event => {
    if (!view || !fullscreen || event.pointerType === 'mouse' && event.button !== 0) return;
    const area = getChart()?.chartArea, rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) return;
    suppressClick = false; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic tests may not own a native pointer. */ }
    gesture = pointerBasis();
  });
  listen(canvas, 'pointermove', event => {
    if (!pointers.has(event.pointerId) || !gesture?.view) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = pointerBasis(), delta = current.x - gesture.x;
    if (!gesture.moved && Math.abs(delta) < 4 && Math.abs(current.distance - gesture.distance) < 4) return;
    gesture.moved = true; event.preventDefault();
    const area = getChart().chartArea, rect = canvas.getBoundingClientRect();
    const anchor = Math.max(0, Math.min(1, (gesture.x - rect.left - area.left) / area.width));
    const factor = gesture.distance && current.distance ? current.distance / gesture.distance : 1;
    const span = Math.min(baseSpan(), Math.max(Math.min(minimum, baseSpan()), (gesture.view.to - gesture.view.from) / factor));
    const from = gesture.view.from + anchor * (gesture.view.to - gesture.view.from - span) - delta / area.width * span;
    move({ from, to: from + span });
  }, { passive: false });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    const moved = gesture?.moved; if (moved) suppressClick = true;
    pointers.delete(event.pointerId);
    if (pointers.size) gesture = pointerBasis(); else { gesture = undefined; if (moved || moving) settle(); }
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, name, release);
  listen(canvas, 'click', event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);
  listen(document, 'fullscreenchange', resize);
  listen(window, 'resize', resize);
  listen(document, 'keydown', event => {
    // Native modal dialogs own their focus trap while the chart is fullscreen.
    if (document.activeElement?.closest('dialog[open]')) return;
    if (fullscreen && event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      const index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus(); }
    }
    if (!fullscreen || document.activeElement !== canvas || !view) return;
    if (['ArrowLeft', 'ArrowRight', '+', '=', '-', 'Home'].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowLeft') move(panView(view, bounds, -0.2));
    if (event.key === 'ArrowRight') move(panView(view, bounds, 0.2));
    if (event.key === '+' || event.key === '=') zoomBy(2);
    if (event.key === '-') zoomBy(0.5);
    if (event.key === 'Home') reset();
  });
  return {
    get view() { return view; }, get moving() { return moving; }, get fullscreen() { return fullscreen; },
    setRange(range) {
      const changed = !bounds || bounds.from !== range.from || bounds.to !== range.to;
      bounds = { from: range.from, to: range.to };
      if (changed) { onMove?.(); pointers.clear(); clearTimeout(timer); clearPreview(); fullscreenView = undefined; zoom = 1; view = maxView(); moving = false; }
      sync();
    },
    close() { closed = true; clearTimeout(timer); if (frame) cancelAnimationFrame(frame); pointers.clear(); clearPreview(); leave(); listeners.forEach(remove => remove()); },
  };
}
