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

test('cursor geometry stays inside time bounds, scales CSS pixels, and ends at the last visible band', () => {
  const input = { chart: { width: 800, height: 400, chartArea: { left: 50, right: 750, top: 20, bottom: 340 } },
    canvasRect: { left: 100, top: 100, width: 400, height: 200 }, panelRect: { left: 80, top: 60 },
    trackRects: [{ width: 400, height: 30, bottom: 370 }, { width: 0, height: 0, bottom: 700 }], clientX: 300, clientY: 350 };
  assert.deepEqual(historyCursorGeometry(input), { x: 400, left: 220, top: 210, height: 100,
    plotLeft: 45, plotRight: 395, inPlot: false, bottom: 310 });
  for (const point of [{ clientX: 124, clientY: 150 }, { clientX: 476, clientY: 150 },
    { clientX: 300, clientY: 109 }, { clientX: 300, clientY: 371 }])
    assert.equal(historyCursorGeometry({ ...input, ...point }), null);
  const noRows = historyCursorGeometry({ ...input, trackRects: [], clientY: 240 });
  assert.equal(noRows.height, 0);
  assert.equal(historyCursorGeometry({ ...input, trackRects: [] }), null);
});

function fixture(t) {
  class Element extends EventTarget {
    constructor() { super(); this.children = []; this.style = {}; this.dataset = {}; this.hidden = false; this.attributes = new Map(); this.offsetWidth = 260; this.offsetHeight = 65; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    closest() { return panel; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() {
      if (this.className === 'mode-history') {
        if (this.hidden) return { left: 150, right: 850, top: 0, bottom: 0, width: 0, height: 0 };
        const top = 520 + container.children.filter(child => !child.hidden).indexOf(this) * 32;
        return { left: 100, right: 900, top, bottom: top + 28, width: 800, height: 28 };
      }
      return this.rect;
    }
  }
  const panel = new Element(), canvas = new Element(), container = new Element(), window = new EventTarget();
  panel.rect = { left: 80, top: 60, width: 840, height: 700 }; panel.clientLeft = 1; panel.clientTop = 1;
  canvas.rect = { left: 100, top: 100, width: 800, height: 400 };
  panel.append(canvas, container);
  const document = Object.assign(new EventTarget(), { defaultView: window,
    createElement: () => new Element(), getElementById: id => id === 'chart-activity' ? container : undefined });
  canvas.ownerDocument = document;
  const commands = [], ctx = Object.fromEntries(['save', 'beginPath', 'rect', 'clip', 'setLineDash', 'moveTo', 'lineTo', 'stroke', 'restore']
    .map(name => [name, (...args) => commands.push([name, ...args])]));
  let chart, overlays, tracks = activityTracks, moving = false, touchEnabled = false, hidden = new Set();
  const payload = { range, now: 500, operatingModes: [{ start: 0, end: 1000, value: 1 }],
    shading: { dhwr: [{ start: 400, end: 700 }], fireplace: [{ start: 200, end: 600 }] } };
  const palette = Object.fromEntries(['muted', 'indoor', 'outdoor', 'auxiliary', 'compressorDhw', 'compressorSpace', 'garage', 'heatOff', 'dhwr', 'fireplace'].map(key => [key, key]));
  chart = { width: 800, height: 400, ctx, chartArea: { left: 50, right: 750, top: 20, bottom: 340, width: 700, height: 320 },
    scales: { x: { getValueForPixel: x => (x - 50) / 700 * 1000, getPixelForValue: x => 50 + x / 1000 * 700 } },
    drawCount: 0, draw() { chart.drawCount++; overlays.plugin.beforeDatasetsDraw(chart); overlays.plugin.afterDatasetsDraw(chart); } };
  overlays = createChartOverlays({ canvas, getChart: () => chart, getPayload: () => payload, getView: () => range,
    getPalette: () => palette, getTracks: () => tracks, isVisible: key => !hidden.has(key), isMoving: () => moving, isTouchEnabled: () => touchEnabled });
  overlays.render();
  t.after(() => overlays.close());
  function pointer(type, values = {}, target = panel) {
    const event = new Event(type);
    Object.assign(event, { pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 450, clientY: 250, ...values });
    target.dispatchEvent(event);
  }
  return { panel, canvas, container, document, window, overlays, chart, commands, pointer, payload,
    setTracks(value) { tracks = value; overlays.render(); }, hide(key) { hidden.add(key); overlays.render(); },
    setMoving(value) { moving = value; }, enableTouch() { touchEnabled = true; },
    get extension() { return panel.children.find(child => child.className === 'chart-crosshair-extension'); },
    get readout() { return panel.children.find(child => child.className === 'chart-crosshair-readout'); } };
}

test('isolated state ticks paint and expose their actual value and unknown duration on inspection', t => {
  const f = fixture(t);
  f.payload.series = { contact: [{ x: 500, y: 0 }] };
  f.setTracks([{ key: 'contact', signal: 'contact', label: 'Contact', detail: 'Reported state', values: { 0: 'Closed', 1: 'Open' } }]);
  const segment = f.container.children[0].children[1].children[0].children[0];
  assert.equal(segment.dataset.kind, 'point');
  assert.equal(segment.style.width, '2px', 'The sample is a tick, never an invented time interval');
  f.pointer('pointermove', { clientX: 500, clientY: 535 });
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
  assert.equal(caption.children[0].textContent, 'Home compressor');
  assert.deepEqual(caption.children[1].children.map(item => item.children[1].textContent), ['Space heating', 'Hot water']);
  const segments = viewport.children[0].children;
  assert.deepEqual(segments.map(segment => segment.style.backgroundColor),
    ['muted', 'compressorSpace', 'compressorDhw', 'muted', 'compressorSpace', 'compressorDhw']);
  assert.equal(segments[0].style.opacity, '0.28'); assert.equal(segments[1].style.opacity, '0.75');
  assert.equal(segments[3].dataset.pattern, 'unknown');
  assert.match(segments[3].title, /Running · routing unknown/);
  assert.equal(segments[4].style.top, '25%'); assert.equal(segments[5].style.top, '50%');
  assert.match(segments[4].title, /60% of this display interval/);
  f.pointer('pointermove', { clientX: 185, clientY: 535 });
  assert.match(f.readout.textContent, /Stopped \(0\)/);
  f.pointer('pointermove', { clientX: 500, clientY: 535 });
  assert.match(f.readout.textContent, /No known compressor state/);
  assert.doesNotMatch(f.readout.textContent, /Stopped/);
});

test('pump-mode key explains every state, stays accessible and remains expanded across redraws', t => {
  const f = fixture(t); f.setTracks([mode]);
  let key = f.container.children[0].children[0].children[1];
  assert.equal(key.className, 'activity-key'); assert.equal(key.children[0].textContent, 'Mode key');
  const items = key.children[1].children;
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(item => item.children[0].style.backgroundColor), ['muted', 'indoor', 'outdoor', 'auxiliary', 'compressorDhw']);
  assert(items.every(item => item.children[0].attributes.get('aria-hidden') === 'true'));
  assert.match(items[0].children[1].textContent, /Protection or circulation may still operate/);
  assert.match(items[1].children[1].textContent, /as permitted/);
  assert.match(items[2].children[1].textContent, /auxiliary heat is disabled/);
  assert.match(items[3].children[1].textContent, /compressor is disabled/);
  assert.match(items[4].children[1].textContent, /without house heating/);
  f.pointer('pointermove'); assert.equal(f.extension.hidden, false);
  key.open = true; key.dispatchEvent(new Event('toggle'));
  assert.equal(f.extension.hidden, true, 'Expanding the explanation invalidates the old row cursor position');
  key.children[0].focus(); f.overlays.render(); key = f.container.children[0].children[0].children[1];
  assert.equal(key.open, true, 'A routine chart refresh does not close the explanation being read');
  assert.equal(f.document.activeElement, key.children[0], 'Keyboard focus remains on the explanation disclosure after refresh');
  key.open = false; key.dispatchEvent(new Event('toggle')); f.overlays.render();
  assert.equal(f.container.children[0].children[0].children[1].open, false);
});

test('crosshair spans chart and selected rows, stays clipped, and disappears outside the chart', t => {
  const f = fixture(t);
  f.setTracks(activityTracks.filter(track => ['operatingMode', 'dhwr', 'fireplace'].includes(track.key)));
  f.pointer('pointermove');
  assert.equal(f.extension.hidden, false);
  assert.equal(f.extension.style.left, '369px');
  assert.equal(f.extension.style.top, '379px');
  assert.equal(f.extension.style.height, '172px');
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['rect', 50, 20, 700, 320])));
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['moveTo', 350, 20])));
  assert(f.commands.some(command => JSON.stringify(command) === JSON.stringify(['lineTo', 350, 340])));
  assert.equal(f.readout.hidden, true);
  f.pointer('pointermove', { clientY: 560 });
  assert.equal(f.readout.hidden, false);
  assert.match(f.readout.textContent, /DHWR.*\nDHWR/);
  f.hide('fireplace');
  assert.equal(f.extension.style.height, '140px', 'A hidden last band cannot extend the cursor');
  f.pointer('pointermove', { clientX: 900 });
  assert.equal(f.extension.hidden, true);
  assert.equal(f.readout.hidden, true);
  f.pointer('pointermove');
  f.pointer('pointermove', { clientY: 650 });
  assert.equal(f.extension.hidden, true, 'The legend and notes cannot activate the cursor');
  f.pointer('pointermove');
  f.pointer('pointerleave');
  assert.equal(f.extension.hidden, true);
});

test('touch inspection requires fullscreen and a single stationary tap; gestures and navigation clear it', t => {
  const f = fixture(t), touch = { pointerType: 'touch', pointerId: 4 };
  f.pointer('pointerdown', touch); f.pointer('pointerup', touch);
  assert.equal(f.extension, undefined, 'Ordinary page scrolling must not create a cursor');
  f.enableTouch();
  f.pointer('pointerdown', touch); f.pointer('pointerup', touch);
  assert.equal(f.extension.hidden, false);
  f.pointer('pointerleave', touch);
  assert.equal(f.extension.hidden, false, 'A tap remains inspectable after the finger leaves');
  f.pointer('pointerdown', touch); f.pointer('pointermove', { ...touch, clientX: 500 }); f.pointer('pointerup', touch);
  assert.equal(f.extension.hidden, true);
  f.pointer('pointerdown', touch); f.pointer('pointerdown', { ...touch, pointerId: 5 });
  f.pointer('pointerup', { ...touch, pointerId: 5 }); f.pointer('pointerup', touch);
  assert.equal(f.extension.hidden, true, 'A two-finger gesture must not leave a tap marker');
  f.pointer('pointermove'); f.setMoving(true); f.pointer('pointermove');
  assert.equal(f.extension.hidden, true);
  assert.equal(f.overlays.plugin.beforeEvent(), false);
  f.setMoving(false); f.pointer('pointermove'); f.overlays.clear();
  assert.equal(f.extension.hidden, true);
});

test('fullscreen activity scrolling clips the cursor and inspection to the visible container', t => {
  const f = fixture(t);
  f.container.rect = { left: 100, right: 900, top: 520, bottom: 590, width: 800, height: 70 };
  f.pointer('pointermove');
  assert.equal(f.extension.style.height, '150px');
  f.pointer('pointermove', { clientY: 585 });
  assert.equal(f.readout.hidden, false, 'The visible part of a clipped row can be inspected');
  f.pointer('pointermove', { clientY: 591 });
  assert.equal(f.extension.hidden, true, 'Offscreen rows do not make legend space interactive');
  f.pointer('pointermove'); f.panel.dispatchEvent(new Event('scroll'));
  assert.equal(f.extension.hidden, true, 'Scrolling clears the old row inspection');
});

test('overlay disposal removes pointer listeners and overlay nodes', t => {
  const f = fixture(t);
  f.pointer('pointermove');
  f.pointer('pointerdown', {}, f.document);
  assert.equal(f.extension.hidden, true, 'A touch cursor clears when the user interacts elsewhere');
  f.pointer('pointermove');
  f.window.dispatchEvent(new Event('blur'));
  assert.equal(f.extension.hidden, true);
  const draws = f.chart.drawCount;
  f.overlays.close();
  assert.equal(f.extension, undefined); assert.equal(f.readout, undefined);
  f.pointer('pointermove');
  assert.equal(f.chart.drawCount, draws);
});
