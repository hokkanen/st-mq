import test from 'node:test';
import assert from 'node:assert/strict';
import { floorPreheatView, renderFloorPreheat } from '../chart/floor-preheat.js';

const planned = extra => ({ preheatValves: { enabled: false, commissioned: false,
  integrationSupported: false, available: false, active: false, restorationPending: false, ...extra } });

test('missing or unsupported status cannot establish readiness or inherit commissioning', () => {
  for (const status of [undefined, null, {}, { preheatValves: null }, { preheatValves: {} },
    { preheatValves: { enabled: true, commissioned: true, available: true, active: true } }]) {
    const view = floorPreheatView(status);
    assert.equal(view.label, 'Status unavailable');
    assert.equal(view.state, 'pending');
    assert.equal(view.commissioning, 'Unknown');
    assert.match(view.detail, /unknown/);
  }
});

test('unsupported floor integration cannot be resolved by configuration or imply a live timer', () => {
  const view = floorPreheatView(planned());
  assert.equal(view.label, 'Integration unavailable');
  assert.equal(view.commissioning, 'Not recorded');
  assert.match(view.detail, /no supported device integration.*Configuration cannot enable it/);
  assert.match(view.detail, /implemented and verified/);
  assert.match(view.renewal, /will need a verified release deadline/);
  assert.doesNotMatch(view.renewal, /local script|native switch timer|every 5 minutes/);
  assert.equal(floorPreheatView(planned({ enabled: true, commissioned: true, active: true })).label, 'Integration unavailable');
});

test('pending physical release remains visible while the new device is unavailable', () => {
  for (const extra of [{ restorationPending: true }, { brokerMismatch: true }]) {
    const view = floorPreheatView(planned(extra));
    assert.equal(view.label, 'Release pending');
    assert.equal(view.state, 'attention');
    assert.match(view.detail, /physical release verification/);
    assert.doesNotMatch(view.detail, /thermostats restored|thermostat control restored/i);
  }
});

test('renderer clears stale status and tolerates absent sections', () => {
  const elements = new Map(['floor-preheat-state', 'floor-preheat-status',
    'floor-preheat-commissioning-status', 'floor-preheat-renewal'].map(id => [id, { textContent: '', dataset: {} }]));
  const document = { getElementById: id => elements.get(id) ?? null };
  renderFloorPreheat(document, planned());
  assert.equal(elements.get('floor-preheat-state').textContent, 'Integration unavailable');
  const view = renderFloorPreheat(document, {});
  assert.equal(elements.get('floor-preheat-state').textContent, view.label);
  assert.equal(elements.get('floor-preheat-state').dataset.state, 'pending');
  assert.equal(elements.get('floor-preheat-status').textContent, view.detail);
  assert.equal(elements.get('floor-preheat-commissioning-status').textContent, 'Unknown');
  assert.doesNotThrow(() => renderFloorPreheat({ getElementById: () => null }, planned()));
});

test('the lease outcome remains a small 24-hour receipt while restoration status keeps its own lifetime', () => {
  const at = 1_000_000, classes = new Map();
  const report = { textContent: '', hidden: true, classList: { toggle: (name, value) => classes.set(name, value) } };
  const document = { getElementById: id => id === 'heating-preheat-report' ? report : null };
  const status = { ...planned(), now: at, heatingTests: { manualPreheatReport: { at, floorOutcome: 'device-local',
    roomOutcome: 'restored', message: 'Local floor lease ended automatically. ROOM returned to its previous setting.' } } };
  renderFloorPreheat(document, status);
  assert.equal(report.hidden, false);
  assert.match(report.textContent, /ended automatically/);
  status.now = at + 86399_999; renderFloorPreheat(document, status); assert.equal(report.hidden, false);
  status.heatingTests.manualPreheatReport.roomOutcome = 'pending'; renderFloorPreheat(document, status);
  assert.equal(classes.get('form-error'), true);
  status.preheatValves.restorationPending = true;
  status.now = at + 86400_000;
  const view = renderFloorPreheat(document, status);
  assert.equal(report.hidden, true); assert.equal(report.textContent, '');
  assert.equal(view.label, 'Release pending');
});
