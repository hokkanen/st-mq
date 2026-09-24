import test from 'node:test';
import assert from 'node:assert/strict';
import { floorPreheatView, renderFloorPreheat } from '../chart/floor-preheat.js';

const ready = extra => ({ preheatValves: { enabled: true, commissioned: true,
  connected: true, available: true, active: false, restorationPending: false,
  brokerMismatch: false, renewSeconds: 300, leaseSeconds: 900, ...extra } });

test('missing floor status remains unknown and does not inherit commissioning or timing defaults', () => {
  for (const status of [undefined, null, {}, { preheatValves: null }, { preheatValves: {} }]) {
    const view = floorPreheatView(status);
    assert.equal(view.label, 'Status unavailable');
    assert.equal(view.state, 'pending');
    assert.equal(view.commissioning, 'Unknown');
    assert.match(view.detail, /unknown/);
    assert.match(view.renewal, /timing unavailable/);
    assert.doesNotMatch(view.renewal, /5 minutes|15 minutes/);
  }
});

test('explicit disablement and the commissioning record remain distinct from relay feedback', () => {
  const disabled = floorPreheatView(ready({ enabled: false, commissioned: false }));
  assert.equal(disabled.label, 'Not enabled');
  assert.equal(disabled.commissioning, 'Not recorded');
  const uncommissioned = floorPreheatView(ready({ commissioned: false, active: true }));
  assert.equal(uncommissioned.label, 'Commissioning required');
  assert.equal(uncommissioned.state, 'attention');
  assert.match(uncommissioned.detail, /Relay feedback alone does not complete commissioning/);
  const recorded = floorPreheatView(ready({ available: false, connected: false }));
  assert.equal(recorded.commissioning, 'Recorded in configuration');
  assert.equal(recorded.label, 'Floor feedback unavailable');
  const unknown = floorPreheatView(ready({ commissioned: undefined }));
  assert.equal(unknown.commissioning, 'Unknown');
  assert.equal(unknown.label, 'Commissioning status unavailable');
});

test('pending release and broker mismatch stay visible when commissioning or enablement changes', () => {
  for (const extra of [
    { restorationPending: true },
    { brokerMismatch: true },
    { restorationPending: true, brokerMismatch: true },
  ]) {
    const view = floorPreheatView(ready({ enabled: false, commissioned: false, ...extra }));
    assert.equal(view.label, 'Release pending');
    assert.equal(view.state, 'attention');
    assert.equal(view.commissioning, 'Not recorded');
    assert.doesNotMatch(view.detail, /thermostats restored|thermostat control restored/i);
    if (extra.brokerMismatch) assert.match(view.detail, /cannot confirm release on the original devices/);
    else assert.match(view.detail, /waiting for confirmation/);
  }
});

test('floor readiness does not grant heating control or establish thermostat restoration', () => {
  const view = floorPreheatView({ ...ready(), liveWrites: false,
    pairing: { canControl: false }, settings: { controlEnabled: false } });
  assert.equal(view.label, 'Ready for preheating');
  assert.equal(view.state, 'available');
  assert.match(view.detail, /floor devices report ready for an override/);
  assert.match(view.detail, /Heating control permissions and the plan determine/);
  assert.doesNotMatch(view.detail, /thermostats restored|thermostat control restored|control authorized/i);
});

test('active floor status describes reported contacts without claiming water flow', () => {
  const view = floorPreheatView(ready({ active: true }));
  assert.equal(view.label, 'Floor override active');
  assert.match(view.detail, /four override contacts report ON/);
  assert.match(view.detail, /valve movement and water flow are not measured/);
  for (const extra of [{ available: false }, { connected: false }, { available: undefined }]) {
    assert.notEqual(floorPreheatView(ready({ active: true, ...extra })).label, 'Floor override active');
  }
  assert.equal(floorPreheatView(ready({ active: undefined })).label, 'Status unavailable');
  assert.equal(floorPreheatView({ preheatValves: { enabled: true, commissioned: true } }).label, 'Status unavailable');
});

test('renewal copy follows reported configuration and describes both local expiry mechanisms', () => {
  const standard = floorPreheatView(ready()).renewal;
  assert.match(standard, /every 5 minutes/);
  assert.match(standard, /planned deadline or within 15 minutes without renewal/);
  const custom = floorPreheatView(ready({ renewSeconds: 45, leaseSeconds: 180 })).renewal;
  assert.match(custom, /every 45 seconds/);
  assert.match(custom, /planned deadline or within 3 minutes without renewal/);
  assert.match(custom, /local script and native switch timer/);
  assert.doesNotMatch(custom, /5 minutes|15 minutes/);
  assert.match(floorPreheatView(ready({ renewSeconds: 60, leaseSeconds: 120 })).renewal, /every 1 minute\./);
  for (const extra of [{ renewSeconds: undefined }, { leaseSeconds: null }, { renewSeconds: '300' }, { leaseSeconds: NaN }])
    assert.match(floorPreheatView(ready(extra)).renewal, /timing unavailable/);
});

test('renderer replaces prior confirmed state with unavailable status and tolerates absent sections', () => {
  const elements = new Map(['floor-preheat-state', 'floor-preheat-status',
    'floor-preheat-commissioning-status', 'floor-preheat-renewal'].map(id => [id, { textContent: '', dataset: {} }]));
  const document = { getElementById: id => elements.get(id) ?? null };
  renderFloorPreheat(document, ready({ active: true }));
  assert.equal(elements.get('floor-preheat-state').textContent, 'Floor override active');
  const view = renderFloorPreheat(document, {});
  assert.equal(elements.get('floor-preheat-state').textContent, view.label);
  assert.equal(elements.get('floor-preheat-state').dataset.state, 'pending');
  assert.equal(elements.get('floor-preheat-status').textContent, view.detail);
  assert.equal(elements.get('floor-preheat-commissioning-status').textContent, 'Unknown');
  assert.match(elements.get('floor-preheat-renewal').textContent, /timing unavailable/);
  assert.doesNotThrow(() => renderFloorPreheat({ getElementById: () => null }, ready()));
});
