import test from 'node:test';
import assert from 'node:assert/strict';
import { floorPreheatView, renderFloorPreheat, floorChannels, floorManualAllowed, floorManualMessage, floorReceiptText, floorRequestId } from '../chart/floor-preheat.js';
import { createEquipmentActions } from '../chart/equipment.js';

const now = Date.parse('2026-10-15T12:00:00Z');
const current = extra => ({ now, role: 'master', preheatValves: { enabled: true, commissioned: true,
  integrationSupported: true, configured: true, connected: true, available: true, manualAvailable: true,
  commandScope: 'synthetic-device-connection-scope', active: false, mode: null, restorationPending: false,
  renewSeconds: 300, leaseSeconds: 900,
  devices: [{ group: 'groundfloor', available: true, at: now,
    channels: [1, 2, 3, 4].map(id => ({ id, output: false, outputEvidence: 'gpio_output_readback', at: now, quality: [], manualSelected: false })) }], ...extra } });

test('missing or unsupported status cannot establish readiness or inherit commissioning', () => {
  for (const status of [undefined, null, {}, { preheatValves: null }, { preheatValves: {} },
    { preheatValves: { enabled: true, commissioned: true, available: true, active: true } }]) {
    const view = floorPreheatView(status);
    assert.equal(view.label, 'Status unavailable');
    assert.equal(view.state, 'pending');
    assert.match(view.detail, /unknown/);
  }
});

test('configuration, commissioning, live GPIO feedback and automatic permission have distinct presentation', () => {
  assert.equal(floorPreheatView(current()).label, 'Ready');
  assert.equal(floorPreheatView(current({ configured: false })).label, 'Not configured');
  assert.equal(floorPreheatView(current({ commissioned: false })).label, 'Not commissioned');
  assert.equal(floorPreheatView(current({ enabled: false })).label, 'Manual control ready');
  assert.equal(floorPreheatView(current({ devices: [] })).label, 'Needs attention');
  assert.match(floorPreheatView(current()).renewal, /every 5 minutes.*within 15 minutes/);
  assert.equal(floorPreheatView(current()).commissioning, 'Recorded in configuration');
  assert.equal(floorPreheatView({ ...current(), readOnly: true }).label, 'Recorded snapshot');
});

test('pending physical release remains visible while the new device is unavailable', () => {
  for (const extra of [{ restorationPending: true }, { brokerMismatch: true }]) {
    const view = floorPreheatView(current(extra));
    assert.equal(view.label, 'Release pending');
    assert.equal(view.state, 'attention');
    assert.match(view.detail, /fresh OFF feedback/);
    assert.doesNotMatch(view.detail, /thermostats restored|thermostat control restored/i);
  }
});

test('renderer clears stale status and tolerates absent sections', () => {
  const elements = new Map(['floor-preheat-state', 'floor-preheat-status',
    'floor-preheat-commissioning-status', 'floor-preheat-renewal'].map(id => [id, { textContent: '', dataset: {} }]));
  const document = { getElementById: id => elements.get(id) ?? null };
  renderFloorPreheat(document, current());
  assert.equal(elements.get('floor-preheat-state').textContent, 'Ready');
  const view = renderFloorPreheat(document, {});
  assert.equal(elements.get('floor-preheat-state').textContent, view.label);
  assert.equal(elements.get('floor-preheat-state').dataset.state, 'pending');
  assert.equal(elements.get('floor-preheat-status').textContent, view.detail);
  assert.equal(elements.get('floor-preheat-commissioning-status').textContent, 'Unknown');
  assert.doesNotThrow(() => renderFloorPreheat({ getElementById: () => null }, current()));
});

test('each circuit retains its identity and rejects unsupported, stale, future or partial output evidence', () => {
  const status = current();
  assert.deepEqual(floorChannels(status).map(row => [row.label, row.lengthM, row.stateLabel]),
    [['Living', 106, 'Override off'], ['Living', 62, 'Override off'], ['Storage', 38, 'Override off'], ['Storage', 80, 'Override off']]);
  const channels = status.preheatValves.devices[0].channels;
  channels[0].output = true; channels[0].quality = ['floor-feedback-stale'];
  channels[1].at = now + 1; delete channels[2].outputEvidence;
  const views = floorChannels(status);
  assert.deepEqual(views.map(row => row.stateLabel), ['Unknown', 'Unknown', 'Unknown', 'Override off']);
  assert.match(views[0].detail, /Last report/);
  assert.equal(floorManualAllowed(status, 1, true), false);
  assert.equal(floorManualAllowed(status, 4, true), true, 'Fresh individual output stays labelled independently');
});

test('manual controls require current scope and authority and retain the shared original deadline', () => {
  const status = current();
  assert.equal(floorManualAllowed(status, 1, true), true);
  assert.equal(floorManualAllowed(status, 1, false), false);
  for (const extra of [{ manualAvailable: false }, { commandScope: null }, { restorationPending: true }, { stateUnknown: true }, { mode: 'automatic' }])
    assert.equal(floorManualAllowed(current(extra), 1, true), false);
  for (const role of ['slave', 'standby']) assert.equal(floorManualAllowed({ ...status, role }, 1, true), false);
  assert.equal(floorManualAllowed({ ...status, readOnly: true }, 1, true), false);
  assert.equal(floorManualAllowed(status, 1, true, true), false);
  assert.equal(floorManualAllowed(status, 0, true), false);
  const manual = current({ mode: 'manual', manualUntil: now + 900000 });
  manual.preheatValves.devices[0].channels[0].output = true;
  manual.preheatValves.devices[0].channels[0].manualSelected = true;
  assert.equal(floorManualAllowed(manual, 1, true), false);
  assert.equal(floorManualAllowed(manual, 1, false), true);
  assert.equal(floorManualAllowed(manual, 2, true), true);
  assert.match(floorManualMessage(manual), /15:15.*keeps this deadline/);
  assert.match(floorPreheatView(manual).detail, /1 of 4 outputs reported on/);
});

test('manual actions send a bounded scoped request and block duplicates while awaiting its result', async () => {
  let finish; const calls = [], statuses = [];
  const actions = createEquipmentActions({ request: (path, body) => { calls.push({ path, body }); return new Promise(resolve => { finish = resolve; }); }, onStatus: result => statuses.push(result) });
  actions.update(current());
  const pending = actions.floor(2, true);
  assert.equal(await actions.floor(3, true), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/equipment/floor');
  assert.deepEqual({ ...calls[0].body, requestId: undefined }, { channel: 2, enabled: true, durationSeconds: 900, scope: 'synthetic-device-connection-scope', requestId: undefined });
  assert.match(calls[0].body.requestId, /^[a-f0-9-]{36}$/);
  actions.update(current({ commandScope: 'stale-poll-scope' }));
  finish(current({ mode: 'manual', manualUntil: now + 900000 }));
  assert.equal(await pending, true); assert.equal(statuses.length, 1);
  assert.match(actions.snapshot().message, /Channel 2: override requested/);
  actions.update(current({ now: now + 1000 }));
  assert.match(actions.snapshot().message, /Channel 2/);
});

test('manual failure messages preserve floor evidence without leaking transport errors', async () => {
  const actions = createEquipmentActions({ request: async () => { throw Object.assign(new Error('private-device-and-token'), { code: 'FLOOR_UNCONFIRMED' }); } });
  actions.update(current());
  assert.equal(await actions.floor(3, true), false);
  assert.match(actions.snapshot().message, /no confirming GPIO report/);
  assert.doesNotMatch(actions.snapshot().message, /private-device-and-token/);
  assert.equal(actions.snapshot().status.preheatValves.configured, true);
});

test('a confirmed manual receipt retains its historical meaning when output feedback expires', () => {
  const receipt = { at: now, enabled: true, status: 'confirmed', confirmed: true };
  assert.match(floorReceiptText(receipt, now + 86399999), /Override requested · GPIO confirmed/);
  assert.equal(floorReceiptText(receipt, now + 86400000), '');
  assert.equal(floorReceiptText(receipt, now - 1), '');
  assert.match(floorReceiptText({ ...receipt, enabled: false }, now), /Release requested · GPIO confirmed/);
  const status = current();
  const channel = status.preheatValves.devices[0].channels[0]; channel.lastResult = receipt; channel.quality = ['floor-feedback-stale'];
  assert.equal(floorChannels(status)[0].stateLabel, 'Unknown');
  assert.match(floorReceiptText(floorChannels(status)[0].lastResult, now), /GPIO confirmed/);
});

test('manual requests remain usable on a LAN HTTP browser without randomUUID', () => {
  assert.equal(floorRequestId({ getRandomValues: bytes => bytes.fill(3) }), '03'.repeat(16));
  assert.match(floorRequestId(null), /^[a-f0-9]{32}$/);
});

test('a replica preserves the recorded GPIO value while current outputs and authority stay unknown', () => {
  const status = { ...current(), readOnly: true };
  status.preheatValves.devices[0].channels[0].output = true;
  const channel = floorChannels(status)[0];
  assert.equal(channel.stateLabel, 'Unknown'); assert.equal(channel.output, null);
  assert.match(channel.detail, /Last recorded GPIO: on/);
  assert.equal(floorManualAllowed(status, 1, true), false);
  status.preheatValves.restorationPending = true;
  assert.equal(floorPreheatView(status).label, 'Release pending');
  assert.match(floorPreheatView(status).detail, /Recorded release obligation/);
});

test('the lease outcome remains a small 24-hour receipt while restoration status keeps its own lifetime', () => {
  const at = 1_000_000, classes = new Map();
  const report = { textContent: '', hidden: true, classList: { toggle: (name, value) => classes.set(name, value) } };
  const document = { getElementById: id => id === 'heating-preheat-report' ? report : null };
  const status = { ...current(), now: at, heatingTests: { manualPreheatReport: { at, floorOutcome: 'device-local',
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
