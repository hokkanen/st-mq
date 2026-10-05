import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTracks, activityIntervals, activityIntervalLabel, historyCursorGeometry, createChartOverlays } from '../chart/chart-overlays.js';

const range = { from: 0, to: 1000 };
const mode = activityTracks.find(track => track.key === 'operatingMode');

test('state rows preserve exact occupancy summaries instead of converting fractions into continuous activity', () => {
  const intervals = [{ start: 0, end: 200, value: 1, aggregated: true, fraction: 0.25 }];
  assert.equal(activityIntervals(mode, { operatingModes: intervals }), intervals);
  assert.match(activityIntervalLabel(mode, intervals[0]), /Auto \(1\).*25% of this display interval/);
  const compressor = activityTracks.find(track => track.key === 'compressorGarage');
  assert.equal(activityIntervals(compressor, { shading: { compressorGarage: intervals } }), intervals);
});

test('arbitrary state rows retain zero, missing breaks and explicit intervals without inventing a final tail', () => {
  const descriptor = { key: 'door', signal: 'garage_door1_open', values: { 0: 'Closed', 1: 'Open' } };
  const payload = { range, now: 950, series: { garage_door1_open: [
    { x: 0, y: 0 }, { x: 100, y: 1 }, { x: 150, y: null },
    { x: 200, y: 0 }, { x: 250, y: null }, { x: 900, y: 1 },
  ] } };
  assert.deepEqual(activityIntervals(descriptor, payload).map(({ start, end, value, sampled, pointOnly }) => ({ start, end, value, sampled, pointOnly })), [
    { start: 0, end: 100, value: 0, sampled: true, pointOnly: undefined },
    { start: 100, end: 150, value: 1, sampled: true, pointOnly: undefined },
    { start: 200, end: 250, value: 0, sampled: true, pointOnly: undefined },
    { start: 900, end: 900, value: 1, sampled: undefined, pointOnly: true },
  ]);
  assert.match(activityIntervalLabel(descriptor, activityIntervals(descriptor, payload)[0]), /Closed \(0\).*intermediate changes may be omitted/);
  payload.series.garage_door1_open = [
    { x: 400, y: 0, intervalStart: 400, intervalEnd: 500 },
    { x: 500, y: 0, intervalStart: 400, intervalEnd: 500 },
    { x: 900, y: 1, intervalStart: 900, intervalEnd: 1000 },
  ];
  const exact = activityIntervals(descriptor, payload);
  assert.deepEqual(exact.map(({ start, end, sampled }) => ({ start, end, sampled })), [
    { start: 400, end: 500, sampled: false }, { start: 900, end: 950, sampled: false },
  ]);
  assert.doesNotMatch(activityIntervalLabel(descriptor, exact[0]), /intermediate changes/);
});

test('an isolated zero state remains an inspectable point without an invented interval', () => {
  const descriptor = { key: 'contact', signal: 'contact', values: { 0: 'Closed', 1: 'Open' } };
  const payload = { range, now: 900, series: { contact: [{ x: 500, y: 0 }] } };
  const intervals = activityIntervals(descriptor, payload);
  assert.deepEqual(intervals, [{ x: 500, y: 0, start: 500, end: 500, value: 0, pointOnly: true }]);
  assert.match(activityIntervalLabel(descriptor, intervals[0]), /Closed \(0\).*recorded sample; duration unknown/);
  for (const excluded of [{ x: 901, y: 1 }, { x: 500, y: null }, { x: 500, y: 1, carriedForward: true },
    { x: 500, y: 1, displayBoundary: true }]) {
    payload.series.contact = [excluded];
    assert.deepEqual(activityIntervals(descriptor, payload), []);
  }
});

test('tagged sample-gap boundaries leave inspectable points without changing real short intervals', () => {
  const descriptor = { key: 'pause', signal: 'pause', values: { 0: 'Normal', 1: 'Paused' } };
  const gap = { x: 501, y: null, displayBoundary: true, sampleBoundary: true };
  const payload = { range, now: 900, series: { pause: [{ x: 500, y: 1 }, gap] } };
  const [point] = activityIntervals(descriptor, payload);
  assert.deepEqual(point, { x: 500, y: 1, start: 500, end: 500, value: 1, pointOnly: true });
  assert.match(activityIntervalLabel(descriptor, point), /Paused \(1\).*recorded sample; duration unknown/);
  payload.series.pause[1] = { x: 501, y: null };
  assert.deepEqual(activityIntervals(descriptor, payload), [
    { x: 500, y: 1, start: 500, end: 501, value: 1, sampled: true },
  ], 'An untagged one-millisecond state interval retains its original duration');
  payload.series.pause = [{ x: 500, y: 1, intervalStart: 500, intervalEnd: 501 }, gap];
  assert.equal(activityIntervals(descriptor, payload)[0].end, 501, 'Explicit interval evidence takes precedence');
  assert.equal(activityIntervals(descriptor, payload)[0].pointOnly, undefined);
  for (const marker of [{ displayBoundary: true }, { carriedForward: true }]) {
    payload.series.pause = [{ x: 500, y: 1, ...marker }, gap];
    assert.deepEqual(activityIntervals(descriptor, payload), [], 'Synthetic display points never become observations');
  }
});

test('cursor geometry scales CSS pixels and only activates on visible bands', () => {
  const input = { chart: { width: 800, height: 400, chartArea: { left: 50, right: 750, top: 20, bottom: 340 } },
    canvasRect: { left: 100, top: 100, width: 400, height: 200 }, panelRect: { left: 80, top: 60 },
    trackRects: [{ width: 350, height: 20, top: 330, bottom: 350 },
      { width: 350, height: 20, top: 390, bottom: 410 }, { width: 0, height: 0, top: 700, bottom: 700 }],
    clientX: 300, clientY: 340 };
  assert.deepEqual(historyCursorGeometry(input), { x: 400, left: 220, plotLeft: 45, plotRight: 395, plotBottom: 210,
    segments: [{ top: 270, height: 20 }, { top: 330, height: 20 }] });
  for (const point of [{ clientX: 124 }, { clientX: 476 }, { clientY: 150 }, { clientY: 320 },
    { clientY: 370 }, { clientY: 411 }])
    assert.equal(historyCursorGeometry({ ...input, ...point }), null);
  assert.equal(historyCursorGeometry({ ...input, trackRects: [] }), null);
  assert.equal(historyCursorGeometry({ ...input, clientX: 900, clampX: true }).x, 750,
    'Captured scrubbing stops at the time-axis boundary');
});

function fixture(t) {
  class Element extends EventTarget {
    constructor() { super(); this.children = []; this.style = {}; this.dataset = {}; this.hidden = false; this.attributes = new Map(); this.offsetWidth = 260; this.offsetHeight = 65; this.captured = new Set(); }
    get offsetWidth() { return this.className === 'mode-history' ? (container.rect?.width ?? 800) / (container.cssScale ?? 1) - (container.scrollbarWidth ?? 0) : this.width; }
    set offsetWidth(value) { this.width = value; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    closest() { return panel; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.captured.add(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    getBoundingClientRect() {
      if (this.className === 'mode-history') {
        if (this.hidden) return { left: 100, right: 900, top: 0, bottom: 0, width: 0, height: 0 };
        const top = 520 + container.children.filter(child => !child.hidden).indexOf(this) * 60;
        const left = container.rect?.left ?? 100, width = this.offsetWidth * (container.cssScale ?? 1);
        return { left, right: left + width, top, bottom: top + 52, width, height: 52 };
      }
      if (this.className === 'mode-track') {
        const row = this.parentElement.parentElement, root = row.getBoundingClientRect(), top = root.top + 28;
        const scale = container.cssScale ?? 1;
        const left = root.left + (parseFloat(row.style.paddingLeft) || 0) * scale;
        const right = root.right - (parseFloat(row.style.paddingRight) || 0) * scale;
        return { left, right, top, bottom: top + 22, width: root.width ? right - left : 0, height: root.height ? 22 : 0 };
      }
      return this.rect;
    }
  }
  const panel = new Element(), canvas = new Element(), container = new Element(), window = new EventTarget();
  let resizeObserver;
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObserver = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  panel.rect = { left: 80, top: 60, width: 840, height: 900 }; panel.clientLeft = 1; panel.clientTop = 1;
  canvas.rect = { left: 100, top: 100, width: 800, height: 400 };
  panel.append(canvas, container);
  const document = Object.assign(new EventTarget(), { defaultView: window,
    createElement: () => new Element(), getElementById: id => id === 'chart-activity' ? container : undefined });
  canvas.ownerDocument = document;
  const commands = [], ctx = Object.fromEntries(['save', 'beginPath', 'rect', 'clip', 'setLineDash', 'moveTo', 'lineTo', 'stroke', 'restore']
    .map(name => [name, (...args) => commands.push([name, ...args])]));
  let chart, overlays, tracks = activityTracks, moving = false, hidden = new Set();
  const payload = { range, now: 500, operatingModes: [{ start: 0, end: 1000, value: 1 }],
    shading: { dhwr: [{ start: 400, end: 700 }], fireplace: [{ start: 200, end: 600 }] } };
  const palette = Object.fromEntries(['muted', 'indoor', 'outdoor', 'auxiliary', 'compressorDhw', 'compressorSpace', 'garage', 'heatOff', 'dhwr', 'fireplace'].map(key => [key, key]));
  chart = { width: 800, height: 400, ctx, chartArea: { left: 50, right: 750, top: 20, bottom: 340, width: 700, height: 320 },
    scales: { x: { getValueForPixel: x => (x - 50) / 700 * 1000, getPixelForValue: x => 50 + x / 1000 * 700 } },
    drawCount: 0, draw() { chart.drawCount++; overlays.plugin.beforeDatasetsDraw(chart); overlays.plugin.afterDatasetsDraw(chart); } };
  overlays = createChartOverlays({ canvas, getChart: () => chart, getPayload: () => payload, getView: () => range,
    getPalette: () => palette, getTracks: () => tracks, isVisible: key => !hidden.has(key), isMoving: () => moving });
  overlays.render();
  t.after(() => overlays.close());
  function pointer(type, values = {}, target = panel) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0, clientX: 450, clientY: 550, ...values });
    target.dispatchEvent(event); return event;
  }
  return { panel, canvas, container, document, window, overlays, chart, commands, pointer, payload, resizeObserver,
    setTracks(value) { tracks = value; overlays.render(); }, hide(key) { hidden.add(key); overlays.render(); },
    setMoving(value) { moving = value; },
    get extension() { return panel.children.find(child => child.className === 'chart-crosshair-extension'); },
    get readout() { return panel.children.find(child => child.className === 'chart-crosshair-readout'); } };
}

test('scrollbars consume the row axis gutter while time bounds and cursor remain aligned', t => {
  const f = fixture(t), row = f.container.children[0], track = row.children[1].children[0];
  assert.equal(f.resizeObserver.target, f.container);
  for (const scrollbarWidth of [0, 16, 0, 6]) {
    f.container.scrollbarWidth = scrollbarWidth;
    f.resizeObserver.callback();
    assert.equal(row.style.paddingLeft, '50px');
    assert.equal(row.style.paddingRight, `${50 - scrollbarWidth}px`);
    const rect = track.getBoundingClientRect();
    assert.deepEqual([rect.left, rect.right, rect.width], [150, 850, 700]);
    for (const [clientX, chartX, cursorLeft] of [[150, 50, '69px'], [850, 750, '768px']]) {
      f.pointer('pointermove', { clientX });
      assert.equal(f.extension.hidden, false);
      assert.equal(f.extension.children[0].style.left, cursorLeft);
      assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['moveTo', chartX, 20])));
    }
  }
  f.overlays.close();
  assert.equal(f.resizeObserver.disconnected, true);
});

test('row gutters use actual container offsets and CSS scaling independently of canvas logical pixels', t => {
  const f = fixture(t);
  f.canvas.rect = { left: 100, top: 100, width: 400, height: 200 };
  f.container.rect = { left: 110, right: 510, top: 500, bottom: 2000, width: 400, height: 1500 };
  f.container.cssScale = .5;
  f.container.scrollbarWidth = 16;
  f.resizeObserver.callback();
  const row = f.container.children[0], rect = row.children[1].children[0].getBoundingClientRect();
  assert.equal(row.style.paddingLeft, '30px');
  assert.equal(row.style.paddingRight, '54px');
  assert.deepEqual([rect.left, rect.right, rect.width], [125, 475, 350]);
  f.pointer('pointermove', { clientX: rect.left });
  assert.equal(f.extension.children[0].style.left, '44px');
  f.pointer('pointermove', { clientX: rect.right });
  assert.equal(f.extension.children[0].style.left, '393px');
});

test('isolated state ticks paint and expose their actual value and unknown duration on inspection', t => {
  const f = fixture(t);
  f.payload.series = { contact: [{ x: 500, y: 0 }] };
  f.setTracks([{ key: 'contact', signal: 'contact', label: 'Contact', detail: 'Reported state', values: { 0: 'Closed', 1: 'Open' } }]);
  const segment = f.container.children[0].children[1].children[0].children[0];
  assert.equal(segment.dataset.kind, 'point');
  assert.equal(segment.style.width, '2px', 'The sample is a tick, never an invented time interval');
  f.pointer('pointermove', { clientX: 500, clientY: 550 });
  assert.match(f.readout.textContent, /Closed \(0\).*duration unknown/);
});

test('one home compressor row distinguishes heating, hot water, stopped and unknown routing without filling missing evidence', t => {
  const f = fixture(t), compressor = activityTracks.find(track => track.key === 'compressorHome');
  assert(!activityTracks.some(track => ['compressorSpace', 'compressorDhw'].includes(track.key)));
  const intervals = [
    { start: 0, end: 100, value: 0 }, { start: 100, end: 300, value: 1 },
    { start: 300, end: 400, value: 2 }, { start: 400, end: 450, value: 3 },
    { start: 600, end: 800, value: 1, aggregated: true, fraction: .6 },
    { start: 600, end: 800, value: 2, aggregated: true, fraction: .4 },
  ];
  f.payload.shading.compressorHome = intervals; f.setTracks([compressor]);
  assert.equal(activityIntervals(compressor, f.payload), intervals);
  const [caption, viewport] = f.container.children[0].children;
  assert.equal(caption.children[0].children[0].textContent, 'Home compressor');
  assert.deepEqual(caption.children[0].children[1].children.map(item => item.children[1].textContent),
    ['Space heating', 'Hot water', 'Stopped', 'Routing unknown', 'Unknown']);
  const segments = viewport.children[0].children;
  assert.deepEqual(segments.map(segment => segment.style.backgroundColor),
    ['muted', 'compressorSpace', 'compressorDhw', 'muted', 'compressorSpace', 'compressorDhw']);
  assert.equal(segments[0].style.opacity, '0.28'); assert.equal(segments[1].style.opacity, '0.75');
  assert.equal(segments[3].dataset.pattern, 'unknown');
  assert.match(segments[3].title, /Running · routing unknown/);
  assert.equal(segments[4].style.top, '25%'); assert.equal(segments[5].style.top, '50%');
  assert.match(segments[4].title, /60% of this display interval/);
  f.pointer('pointermove', { clientX: 185, clientY: 550 });
  assert.match(f.readout.textContent, /Stopped \(0\)/);
  f.pointer('pointermove', { clientX: 500, clientY: 550 });
  assert.match(f.readout.textContent, /No known compressor state/);
  assert.doesNotMatch(f.readout.textContent, /Stopped/);
});

test('foldable pump-mode title explains every state, stays accessible and remains expanded across redraws', t => {
  const f = fixture(t); f.setTracks([mode]);
  let key = f.container.children[0].children[0];
  assert.equal(key.className, 'activity-caption'); assert.equal(key.children[0].children[0].textContent, 'Pump mode');
  const items = key.children[1].children[1].children;
  assert.equal(items.length, 6);
  assert.deepEqual(items.map(item => item.children[0].style.backgroundColor),
    ['muted', 'indoor', 'outdoor', 'auxiliary', 'compressorDhw', 'var(--surface-soft)']);
  assert.equal(items[5].children[0].dataset.pattern, 'blank');
  assert(items.every(item => item.children[0].attributes.get('aria-hidden') === 'true'));
  assert.match(items[0].children[1].textContent, /Protection or circulation may still operate/);
  assert.match(items[1].children[1].textContent, /as permitted/);
  assert.match(items[2].children[1].textContent, /auxiliary heat is disabled/);
  assert.match(items[3].children[1].textContent, /compressor is disabled/);
  assert.match(items[4].children[1].textContent, /without house heating/);
  f.pointer('pointermove'); assert.equal(f.extension.hidden, false);
  key.open = true; key.dispatchEvent(new Event('toggle'));
  assert.equal(f.extension.hidden, true, 'Expanding the explanation invalidates the old row cursor position');
  key.children[0].focus(); f.overlays.render(); key = f.container.children[0].children[0];
  assert.equal(key.open, true, 'A routine chart refresh does not close the explanation being read');
  assert.equal(f.document.activeElement, key.children[0], 'Keyboard focus remains on the explanation disclosure after refresh');
  f.pointer('pointermove'); f.overlays.render(); key = f.container.children[0].children[0];
  key.dispatchEvent(new Event('toggle'));
  assert.equal(f.extension.hidden, false, 'Restoring an open fold during refresh does not clear band inspection');
  key.open = false; key.dispatchEvent(new Event('toggle')); f.overlays.render();
  assert.equal(f.container.children[0].children[0].open, false);
});

test('crosshair only starts in bands and paints the plot and individual bands without bridging captions or gaps', t => {
  const f = fixture(t);
  f.setTracks(activityTracks.filter(track => ['operatingMode', 'dhwr', 'fireplace'].includes(track.key)));
  f.pointer('pointermove', { clientY: 250 });
  assert.equal(f.extension, undefined, 'The main plot leaves inspection to its regular chart tooltip');
  f.pointer('pointermove');
  assert.equal(f.extension.hidden, false);
  assert.deepEqual(f.extension.children.map(segment => ({ ...segment.style })), [
    { top: '487px', height: '22px', left: '369px' },
    { top: '547px', height: '22px', left: '369px' },
    { top: '607px', height: '22px', left: '369px' },
  ]);
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['rect', 50, 20, 700, 320])));
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['moveTo', 350, 20])));
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['lineTo', 350, 340])));
  assert.equal(f.readout.hidden, false);
  f.pointer('pointermove', { clientY: 610 });
  assert.match(f.readout.textContent, new RegExp(activityTracks.find(track => track.key === 'dhwr').label));
  f.hide('fireplace');
  assert.equal(f.extension.children.length, 2, 'Hidden bands have no cursor segment');
  for (const position of [{ clientX: 900 }, { clientY: 250 }, { clientY: 540 }, { clientY: 575 }, { clientY: 650 }]) {
    f.pointer('pointermove'); f.pointer('pointermove', position);
    assert.equal(f.extension.hidden, true, 'Plot, labels, gaps and areas beyond the bands cannot activate the cursor');
    assert.equal(f.readout.hidden, true);
  }
  f.pointer('pointermove'); f.pointer('pointerleave');
  assert.equal(f.extension.hidden, true);
});

test('band mouse dragging follows the pointer beyond its band, clamps to time bounds and releases capture', t => {
  const f = fixture(t);
  const down = f.pointer('pointerdown', { buttons: 1 });
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.panel.captured.has(1), true);
  assert.equal(f.extension.children[0].style.left, '369px');
  const move = f.pointer('pointermove', { buttons: 1, clientX: 600, clientY: 250 });
  assert.equal(move.defaultPrevented, true);
  assert.equal(f.extension.children[0].style.left, '519px', 'Dragging continues even outside the originating band');
  assert.match(f.readout.textContent, /Pump mode/);
  f.pointer('pointerleave', { buttons: 1 });
  assert.equal(f.extension.hidden, false, 'Pointer capture keeps scrubbing outside the panel');
  f.pointer('pointermove', { buttons: 1, clientX: 1200, clientY: 200 });
  assert.equal(f.extension.children[0].style.left, '768px');
  f.pointer('pointermove', { buttons: 1, clientX: 0 });
  assert.equal(f.extension.children[0].style.left, '69px');
  f.pointer('pointerup', { clientX: 550 });
  assert.equal(f.extension.children[0].style.left, '469px');
  assert.equal(f.panel.captured.size, 0);
  f.pointer('lostpointercapture');
  assert.equal(f.extension.hidden, false, 'Normal capture release preserves the inspected time');
  f.pointer('pointermove', { clientY: 250 });
  assert.equal(f.extension.hidden, true);
  f.pointer('pointerdown', { clientY: 250, buttons: 1 }); f.pointer('pointermove', { buttons: 1 });
  assert.equal(f.extension.hidden, true, 'Dragging from the main plot into a band never turns chart panning into inspection');
});

test('touch scrubbing works in ordinary page view and extra band fingers cannot navigate or replace it', t => {
  const f = fixture(t), touch = { pointerType: 'touch', pointerId: 4 };
  const pageTouch = f.pointer('pointerdown', { ...touch, clientY: 250 });
  assert.equal(pageTouch.defaultPrevented, false, 'Ordinary page scrolling outside bands remains native');
  assert.equal(f.extension, undefined);
  f.pointer('pointerdown', touch);
  assert.equal(f.extension.hidden, false);
  assert.equal(f.panel.captured.has(4), true);
  f.pointer('pointermove', { ...touch, clientX: 500, clientY: 200 });
  assert.equal(f.extension.children[0].style.left, '419px');
  f.pointer('pointerdown', { ...touch, pointerId: 5 });
  f.pointer('pointermove', { ...touch, pointerId: 5, clientX: 700 });
  assert.equal(f.extension.children[0].style.left, '419px', 'Only the first finger controls the cursor');
  f.pointer('pointerup', { ...touch, pointerId: 5 });
  assert.equal(f.panel.captured.has(4), true);
  f.pointer('pointerup', { ...touch, clientX: 600 });
  f.pointer('pointerleave', touch);
  assert.equal(f.extension.hidden, false, 'The selected time remains after a touch scrub');
  assert.equal(f.extension.children[0].style.left, '519px');
  assert.equal(f.panel.captured.size, 0);
  f.pointer('pointerdown', touch); f.pointer('pointercancel', touch);
  assert.equal(f.extension.hidden, true);
  assert.equal(f.panel.captured.size, 0);
  f.pointer('pointermove'); f.setMoving(true); f.pointer('pointermove');
  assert.equal(f.extension.hidden, true);
  assert.equal(f.overlays.plugin.beforeEvent(), false);
  f.setMoving(false); f.pointer('pointermove'); f.overlays.clear();
  assert.equal(f.extension.hidden, true);
});

test('fullscreen activity scrolling clips each cursor segment and inspection to visible band portions', t => {
  const f = fixture(t);
  f.container.rect = { left: 100, right: 900, top: 555, bottom: 620, width: 800, height: 65 };
  f.pointer('pointermove', { clientY: 560 });
  assert.deepEqual(f.extension.children.map(segment => [segment.style.top, segment.style.height]), [
    ['494px', '15px'], ['547px', '12px'],
  ]);
  f.pointer('pointermove', { clientY: 615 });
  assert.equal(f.readout.hidden, false, 'The visible part of a clipped band can be inspected');
  for (const clientY of [550, 600, 621]) {
    f.pointer('pointermove', { clientY });
    assert.equal(f.extension.hidden, true, 'Clipped bands, headers and offscreen rows cannot start inspection');
  }
  f.pointer('pointerdown', { clientY: 560 }); f.panel.dispatchEvent(new Event('scroll'));
  assert.equal(f.extension.hidden, true, 'Scrolling clears the old band inspection');
  assert.equal(f.panel.captured.size, 0);
});

test('overlay disposal removes pointer listeners, releases capture and removes overlay nodes', t => {
  const f = fixture(t);
  f.pointer('pointermove');
  f.pointer('pointerdown', {}, f.document);
  assert.equal(f.extension.hidden, true, 'Inspection clears when the user interacts elsewhere');
  f.pointer('pointermove');
  f.window.dispatchEvent(new Event('blur'));
  assert.equal(f.extension.hidden, true);
  f.pointer('pointerdown');
  const draws = f.chart.drawCount;
  f.overlays.close();
  assert.equal(f.extension, undefined); assert.equal(f.readout, undefined);
  assert.equal(f.panel.captured.size, 0);
  f.pointer('pointermove');
  assert.equal(f.chart.drawCount, draws);
});

test('Shelly limiter history keeps exact allowance changes, fallback and unknown spans separate from power', t => {
  const f = fixture(t), descriptor = activityTracks.find(track => track.key === 'shellyLimiter');
  const spans = [
    { start: 0, end: 100, mode: 'unrestricted', allowanceA: 16, reason: 'hardware-restriction', appliedCurrentA: 16, applicationStatus: 'confirmed' },
    { start: 100, end: 200, mode: 'limited', allowanceA: 8, reason: 'priority-allocation', appliedCurrentA: 12, applicationStatus: 'pending' },
    { start: 200, end: 300, mode: 'paused-by-balancing', allowanceA: 0, reason: 'fuse-limit', appliedCurrentA: 6, applicationStatus: 'confirmed' },
    { start: 300, end: 400, mode: 'fallback', allowanceA: 12, reason: 'feed-unavailable', appliedCurrentA: null, applicationStatus: 'unknown' },
    { start: 400, end: 500, mode: 'unknown', allowanceA: null, reason: 'controller-unavailable', appliedCurrentA: null, applicationStatus: 'unknown' },
    { start: 500, end: 600, mode: 'unknown', allowanceA: null, loadAllowanceA: null, reason: 'charger-unavailable', appliedCurrentA: null, applicationStatus: 'unknown' },
  ];
  f.payload.limiterHistory = { spans }; f.setTracks([descriptor]);
  assert.deepEqual(activityIntervals(descriptor, f.payload).map(({ value, ...interval }) => interval), spans);
  assert.match(activityIntervalLabel(descriptor, spans[1]), /Limited · 8 A allowance · Charger priority\nAwaiting charger confirmation · last confirmed setting 12 A/);
  assert.match(activityIntervalLabel(descriptor, spans[2]), /Paused by balancing · 0 A.*\nPause instruction confirmed/);
  assert.match(activityIntervalLabel(descriptor, spans[5]), /Unknown · Charger unavailable\nCharger setting unconfirmed/);
  const track = f.container.children[0].children[1].children[0];
  assert.equal(track.children.at(-1).dataset.pattern, 'unknown');
  assert.equal(track.children[0].dataset.value, 'unrestricted');
  assert.equal(track.tabIndex, 0);
  track.focus(); f.overlays.render();
  assert.equal(f.document.activeElement, f.container.children[0].children[1].children[0], 'Polling retains keyboard focus on the strip');
  f.pointer('keydown', { key: 'Home' }, f.document.activeElement);
  assert.match(f.readout.textContent, /Unrestricted · 16 A/);
  f.pointer('keydown', { key: 'ArrowRight' }, f.document.activeElement);
  assert.match(f.readout.textContent, /Limited · 8 A/);
  f.pointer('keydown', { key: 'End' }, f.document.activeElement);
  assert.match(f.readout.textContent, /Unknown/);
  assert.match(f.readout.textContent, /Charger unavailable/);
  assert.match(f.container.children[0].children[2].textContent, /Unknown/, 'The selected interval is available to screen readers with the title fold closed');
});
