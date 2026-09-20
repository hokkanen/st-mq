import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, createEquipmentPanel, equipmentReadingRows, equipmentTestAllowed, equipmentSource, equipmentControlAllowed, equipmentCheckText, dhwrReadingSummary } from '../chart/equipment.js';
import { historyDatasets, historyValueLabel } from '../chart/history-model.js';
import { providerName } from '../chart/provider-status.js';

const now = Date.parse('2026-09-13T12:00:00Z');
const plug = { id: 'caravan', label: 'Caravan', area: 'garage', kind: 'metered_switch', source: 'MQTT-shelly',
  connection: 'shelly:invented-caravan', available: true, controls: { switch: true },
  readings: { caravan_active: { value: 1, unit: 'state', label: 'Switch', observedAt: now, stale: false },
    caravan_current: { value: 1.2, unit: 'A', label: 'Current', estimated: true, observedAt: now },
    caravan_power: { value: 0.28, unit: 'kW', label: 'Power', observedAt: now } },
  energy: { dailyKwh: 1.23, partial: true, observedAt: now } };
const status = (overrides = {}) => ({ role: 'primary', now, equipment: { configured: true, devices: [structuredClone(plug)] },
  equipmentTests: { available: true, busy: false }, ...overrides });

test('monitoring keeps physically named probes independent and only renders configured channels', () => {
  const device = { kind: 'temperature', available: true, readings: {
    garage_temperature: { value: 18.25, unit: 'degC', label: 'By the entrance', observedAt: now },
    garage_temperature_2: { value: 16.5, unit: 'degC', label: 'By the back wall', observedAt: now },
  } };
  const rows = equipmentReadingRows(device);
  assert.deepEqual(rows.map(row => [row.label, row.value]), [['By the entrance', '18.3 °C'], ['By the back wall', '16.5 °C']]);
  device.available = false;
  device.readings.garage_temperature.stale = true;
  device.readings.garage_temperature_2.stale = false;
  assert.deepEqual(equipmentReadingRows(device).map(row => row.value), ['Unavailable', '16.5 °C'], 'A missing probe does not hide its healthy neighbour');
  delete device.readings.garage_temperature_2;
  assert.equal(equipmentReadingRows(device).length, 1);
});

test('a quiet door keeps its reported state while unhealthy and retained-only state remain explicitly unknown', () => {
  const door = { kind: 'door', available: true, readings: {
    garage_door1_open: { value: 0, unit: 'state', label: 'Door 1', observedAt: now - 7 * 86400000, stale: false },
  } };
  assert.equal(equipmentReadingRows(door)[0].value, 'Closed', 'The UI does not invent a report age timeout');
  door.available = false;
  door.readings.garage_door1_open.stale = true;
  let row = equipmentReadingRows(door)[0];
  assert.equal(row.value, 'Unknown'); assert.match(row.detail, /Last reported Closed.*Sept/);
  door.readings.garage_door1_open.observedAt = null;
  row = equipmentReadingRows(door)[0]; assert.match(row.detail, /Last reported Closed.*time unavailable/);
  door.readings.garage_door1_open.value = null;
  assert.equal(equipmentReadingRows(door)[0].detail, 'No usable reading received');
});

test('Caravan and future heat-pump monitoring preserve estimation, coverage and relay meaning', () => {
  const rows = equipmentReadingRows(plug);
  assert.equal(rows.find(row => row.signal === 'caravan_current').label, 'Current (estimate)');
  assert.equal(rows.find(row => row.signal === 'daily_energy').value, '1.230 kWh');
  assert.match(rows.find(row => row.signal === 'daily_energy').detail, /Finnish day.*partial coverage/);
  const heatPump = equipmentReadingRows({ kind: 'heat_pump', available: true,
    readings: { garage_heat_pump_active: { value: true, unit: 'state', label: 'Compressor', observedAt: now } } });
  assert.equal(heatPump[0].label, 'Power enabled'); assert.equal(heatPump[0].value, 'On');
});

test('transport labels match throughout equipment, providers and chart tooltips', () => {
  assert.equal(equipmentSource(plug), 'Shelly');
  assert.equal(equipmentSource({ source: 'MQTT' }), 'MQTT');
  assert.equal(equipmentSource({ source: 'TeslaMate' }), 'TeslaMate');
  assert.equal(providerName('mqtt-temperature'), 'MQTT'); assert.equal(providerName('shelly-mqtt'), 'Shelly');
  assert.equal(historyValueLabel('garage_door1_open', 1, 'state'), 'Open');
  assert.equal(historyValueLabel('garage_door2_open', 0, 'state'), 'Closed');
  for (const key of ['garage_temperature', 'garage_temperature_2']) {
    const dataset = historyDatasets({}, 'temperatures').find(row => row.key === key);
    assert.equal(dataset.cubicInterpolationMode, 'monotone'); assert.equal(dataset.stepped, false);
  }
});

test('test availability requires switch capability, fresh readback, authority and no concurrent test', () => {
  assert(equipmentTestAllowed(status(), plug));
  for (const next of [status({ role: 'replica' }), status({ equipmentTests: { available: false } }),
    status({ equipmentTests: { available: true, busy: true } }), status({ equipmentTests: { available: true, active: { deviceId: 'caravan' } } })])
    assert.equal(equipmentTestAllowed(next, plug), false);
  for (const device of [{ ...plug, available: false }, { ...plug, controls: { switch: false } },
    { ...plug, controls: { switch: true, tariff: true } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: false } } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: false, observedAt: now + 1 } } },
    { ...plug, readings: { caravan_active: plug.readings.caravan_active, extra_active: plug.readings.caravan_active } },
    { ...plug, readings: { caravan_active: { value: 1, unit: 'state', stale: true } } }])
    assert.equal(equipmentTestAllowed(status(), device), false);
});

test('recheck posts only the explicit device identity, prevents repeated clicks and applies the returned status', async () => {
  let finish; const calls = [], received = [];
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  }, onStatus: result => received.push(result) });
  actions.update(status());
  assert.equal(await actions.recheck('unknown-device'), false);
  const pending = actions.recheck('caravan'); assert.equal(await actions.recheck(), false);
  assert.deepEqual(calls, [{ path: '/api/equipment/recheck', body: { deviceId: 'caravan' } }]);
  assert.equal(actions.snapshot().actionKind, 'recheck');
  const next = status({ now: now + 1000 }); finish(next); assert.equal(await pending, true);
  assert.equal(received[0], next);
  const all = actions.recheck(); assert.deepEqual(calls[1], { path: '/api/equipment/recheck', body: {} });
  finish(next); await all;
});

test('timed tests use exact values, preserve an active test through polling and expose explicit restoration', async () => {
  let finish; const calls = [];
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  } });
  actions.update(status());
  for (const duration of [0, 16, 1.5, '5']) assert.equal(await actions.test('caravan', false, duration), false);
  assert.equal(await actions.test('caravan', 'off', 5), false);
  const pending = actions.test('caravan', false, 5);
  assert.deepEqual(calls[0], { path: '/api/equipment/test', body: { deviceId: 'caravan', on: false, durationMinutes: 5 } });
  assert.equal(actions.snapshot().actionKind, 'test'); assert.equal(actions.snapshot().actionDeviceId, 'caravan');
  actions.update(status({ now: now - 1000 }));
  const active = status({ equipmentTests: { available: true, active: { deviceId: 'caravan', on: false, previousOn: true, until: now + 300000 } } });
  finish(active); await pending;
  assert.equal(await actions.test('caravan', true, 5), false);
  const restore = actions.restore(); assert.deepEqual(calls[1], { path: '/api/equipment/test/restore', body: {} });
  assert.equal(actions.snapshot().actionDeviceId, 'caravan', 'Restoration feedback remains scoped to its device after active state clears');
  finish(status()); await restore;
  assert.equal(actions.snapshot().status.equipmentTests.active, undefined);
});

test('failed requests retain monitoring, hide transport error details and replicas cannot recheck or operate', async () => {
  let count = 0;
  const actions = createEquipmentActions({ request: async () => { count++; throw new Error('invented-private-broker-detail'); } });
  const initial = status(); actions.update(initial);
  assert.equal(await actions.recheck(), false); assert.equal(actions.snapshot().status, initial);
  assert.doesNotMatch(actions.snapshot().message, /invented-private/);
  assert.equal(actions.snapshot().busy, false);
  actions.update(status({ role: 'replica' }));
  assert.equal(await actions.recheck(), false); assert.equal(await actions.test('caravan', true, 5), false);
  assert.equal(count, 1);
});


test('direct controls use no duration, require current state and serialize requests', async () => {
  let finish; const calls = [];
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  } });
  const current = status({ equipmentControls: { available: true } });
  actions.update(current);
  assert.equal(equipmentControlAllowed(current, plug), true);
  assert.equal(equipmentControlAllowed(status(), plug), false);
  for (const next of [{ ...current, role: 'replica' }, { ...current, equipmentControls: { available: true, busy: true } }])
    assert.equal(equipmentControlAllowed(next, plug), false);
  assert.equal(await actions.switch('unknown', false), false);
  assert.equal(await actions.switch('caravan', 'off'), false);
  const pending = actions.switch('caravan', false);
  assert.equal(await actions.switch('caravan', false), false);
  assert.equal(await actions.recheck(), false);
  assert.deepEqual(calls, [{ path: '/api/equipment/switch', body: { deviceId: 'caravan', on: false } }]);
  const next = status({ equipmentControls: { available: true, lastResult: { deviceId: 'caravan', on: false, confirmed: true } } });
  finish(next); await pending;
  assert.equal(actions.snapshot().status, next);
  assert.equal(actions.snapshot().actionKind, 'control');
});

test('MQTT check explanations distinguish request results from current availability and later reports', () => {
  const previous = { available: true, check: { status: 'timeout', checkedAt: now }, mqttStatus: { lastLiveAt: now - 1 } };
  assert.match(equipmentCheckText(previous), /Last check:.*no complete live response/);
  assert.doesNotMatch(equipmentCheckText(previous), /received since/);
  assert.match(equipmentCheckText({ ...previous, mqttStatus: { lastLiveAt: now + 1 } }), /received since/);
  assert.match(equipmentCheckText({ available: false, check: { status: 'last-reported' } }), /Last check:.*were still usable/);
  assert.match(equipmentCheckText({ available: true, check: { status: 'unavailable' } }), /Last check:/);
  assert.match(equipmentCheckText({ check: { status: 'retained-only' } }), /live state unconfirmed/);
  assert.match(equipmentCheckText({ check: { status: 'listening' } }), /subscriptions confirmed/);
});

test('circulation requested state never replaces independent switch and live power feedback', () => {
  const missing = dhwrReadingSummary({ dhwr: { active: true, durationMinutes: 12 } });
  assert.equal(missing.state.value, 'Unknown'); assert.equal(missing.power.value, 'Unavailable');
  assert.equal(missing.request, 'Circulation requested'); assert.equal(missing.duration, 12);
  const live = { dhwr: { active: false, feedback: { configured: true, available: true,
    state: { value: 1, unit: 'state', stale: false, observedAt: now },
    power: { value: 38, unit: 'W', stale: false, observedAt: now } } } };
  assert.equal(dhwrReadingSummary(live).state.value, 'On');
  assert.equal(dhwrReadingSummary(live).power.value, '38 W');
  assert.equal(dhwrReadingSummary(live).request, 'No circulation requested');
  live.dhwr.feedback.power.stale = true;
  assert.equal(dhwrReadingSummary(live).state.value, 'On');
  assert.equal(dhwrReadingSummary(live).power.value, 'Unavailable');
});

test('compact circulation state preserves pending stop delivery alongside independent device feedback', () => {
  for (const actualOn of [true, false, null]) {
    const status = { dhwr: { actualOn, active: false, restorationPending: true } };
    const summary = dhwrReadingSummary(status);
    assert.match(summary.summary, /^Stop delivery pending/);
    assert.equal(summary.request, 'Stop requested · delivery pending');
    if (actualOn === null) assert.equal(summary.summary, 'Stop delivery pending');
    else assert.match(summary.summary, new RegExp(`${actualOn ? 'On' : 'Off'} · device reported$`));
    status.dhwr.restorationPending = false;
    assert.equal(dhwrReadingSummary(status).summary, actualOn === null ? 'No request · state unknown'
      : `${actualOn ? 'On' : 'Off'} · device reported`);
  }
  assert.equal(dhwrReadingSummary({ dhwr: { active: true } }).summary, 'On requested · state unknown');
});

test('DHWR operation follows power feedback and requests still need new reports', () => {
  const status = { dhwr: { active: true, actualOn: false, confirmed: false, attention: true,
    reason: 'Waiting for a new power report after the circulation request.',
    feedback: { configured: true, available: true, basis: 'power',
    stateConfigured: true, powerConfigured: true, state: { value: 0, unit: 'state', stale: false, observedAt: now },
    power: { value: 0, unit: 'W', stale: false, observedAt: now } } } };
  let summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, '0 W');
  assert.equal(summary.power.stale, false);
  assert.equal(summary.state.value, 'Off');
  assert.equal(summary.state.stale, false);
  assert.match(summary.state.detail, /Positive power means circulation is on; zero power means it is off/);
  assert.equal(summary.feedbackLabel, 'Needs attention');
  assert.equal(summary.attention, true);
  assert.match(summary.summary, /Off · power reported · needs attention/);
  assert.match(summary.request, /Waiting for a new power report/);
  status.dhwr.active = false;
  status.dhwr.actualOn = true;
  status.dhwr.attention = false;
  status.dhwr.confirmed = true;
  status.dhwr.reason = null;
  status.dhwr.feedback.state.value = 1;
  status.dhwr.feedback.power.value = 38.25;
  summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, '38.25 W');
  assert.equal(summary.state.value, 'On');
  assert.equal(summary.summary, 'On · power reported');
  assert.equal(summary.feedbackLabel, 'Power available');
  assert.equal(summary.request, 'No circulation requested');
});

test('change-only DHWR power identifies the last report and stays distinct from missing or invalidated readings', () => {
  const status = { dhwr: { feedback: { configured: true, available: false,
    stateConfigured: true, powerConfigured: true, basis: 'power' } } };
  let summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, 'Unavailable');
  assert.match(summary.power.detail, /Waiting for a live MQTT report/);
  assert.equal(summary.feedbackLabel, 'Waiting for power');
  status.dhwr.feedback.available = true;
  status.dhwr.feedback.power = { value: 0, unit: 'W', stale: false, eventOnly: true, observedAt: now - 7 * 86400000 };
  status.dhwr.feedback.state = { ...status.dhwr.feedback.power, unit: 'state' };
  summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, '0 W', 'The UI follows source health instead of imposing periodic-report semantics');
  assert.equal(summary.powerLabel, 'Last reported power');
  assert.match(summary.powerReportedAt, /Reported 6 Sept.*GMT\+3/);
  assert.equal(summary.feedbackLabel, 'Power reported');
  assert.match(summary.power.detail, /Last reported.*Sept.*Updated when power changes/);
  status.dhwr.feedback.available = false;
  status.dhwr.feedback.power.stale = true;
  status.dhwr.feedback.state.stale = true;
  summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, 'Unavailable');
  assert.equal(summary.feedbackLabel, 'Power unavailable');
  assert.match(summary.power.detail, /Last reported 0 W/);
  assert.equal(summary.state.value, 'Unknown');
});

test('monitoring-only power devices never gain ordinary switch or timed-test controls', () => {
  const device = { id: 'dhwr', kind: 'power', available: true, controls: { switch: false },
    readings: { dhwr_power: { value: 38, unit: 'W', stale: false, observedAt: now } } };
  assert.equal(equipmentTestAllowed(status(), device), false);
  assert.equal(equipmentControlAllowed(status({ equipmentControls: { available: true } }), device), false);
  assert.deepEqual(equipmentReadingRows(device).map(row => row.value), ['38 W']);
});

function equipmentDocument() {
  class Element {
    constructor(document, tag) {
      this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.hidden = false; this.className = '';
      this.classList = { contains: value => this.className.split(' ').includes(value),
        add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
        toggle: (value, present) => { this.className = this.className.split(' ').filter(name => name !== value).join(' ');
          if (present) this.classList.add(value); } };
    }
    set id(value) { this.attributes.set('id', value); this.ownerDocument.nodes.set(value, this); }
    get id() { return this.attributes.get('id'); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, next) { child.remove(); const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, child); child.parentElement = this; }
    remove() { const parent = this.parentElement; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelector(selector) { return descendants(this).find(child => selector.startsWith('.')
      ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase()) ?? null; }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const document = { nodes: new Map(), activeElement: null, addEventListener() {}, querySelectorAll: () => [],
    defaultView: { addEventListener() {} }, createElement(tag) { return new Element(this, tag); },
    createElementNS(namespace, tag) { return this.createElement(tag); },
    getElementById(id) {
      if (!this.nodes.has(id)) { const node = this.createElement('div'); node.id = id; this.body.append(node); }
      return this.nodes.get(id);
    } };
  document.body = document.createElement('body'); return document;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const deviceNode = (document, rootId, id) => document.getElementById(rootId).children.find(node => node.dataset.deviceId === id);

test('temperature-only equipment exposes every reading without an empty fold and updates existing rows in place', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const upstairs = { id: 'upstairs', label: 'Upstairs', area: 'home', kind: 'temperature', source: 'MQTT', available: false,
    readings: { indoor_temperature: { label: 'Temperature', unit: 'degC', value: null, stale: true } } };
  const initial = status({ equipment: { devices: [upstairs, plug] } }); panel.update(initial);
  const row = deviceNode(document, 'home-equipment-readings', 'upstairs');
  assert.equal(row.tagName, 'SECTION'); assert(row.classList.contains('equipment-device-static'));
  assert.equal(row.children[0].tagName, 'DIV');
  assert.equal(row.hasAttribute('tabindex'), false); assert.equal(row.children[0].hasAttribute('tabindex'), false);
  assert.equal(row.querySelector('details'), null); assert.equal(row.querySelector('summary'), null);
  assert.equal(row.querySelector('.equipment-device-preview'), null, 'The direct readings replace the collapsed preview');
  assert.equal(row.querySelector('.equipment-inline-controls'), null);
  const readings = row.querySelector('.equipment-readings'), value = readings.querySelector('.status-detail-label');
  assert.equal(readings.hidden, false); assert.equal(value.textContent, 'Unavailable');
  assert.equal(value.parentElement.tagName, 'BUTTON', 'Reading provenance remains available through its explanation');
  const updated = structuredClone(initial);
  updated.equipment.devices[0].available = true;
  updated.observations = { upstairs: { value: 21.4, observedAt: now, source: 'mqtt-temperature', stale: false } };
  panel.update(updated);
  assert.equal(deviceNode(document, 'home-equipment-readings', 'upstairs'), row);
  assert.equal(row.querySelector('.equipment-readings'), readings); assert.equal(readings.querySelector('.status-detail-label'), value);
  assert.equal(value.textContent, '21.4 °C');
  const caravan = deviceNode(document, 'garage-equipment-readings', 'caravan');
  assert.equal(caravan.tagName, 'DETAILS'); assert.equal(caravan.children[0].tagName, 'SUMMARY');
  assert(caravan.querySelector('.equipment-inline-controls'), 'Equipment with controls remains expandable');
});

test('temperature groups show all probes directly, including Mitsubishi inventory readings', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  panel.update(status({ equipment: { devices: [{ id: 'temperature-group', label: 'Garage temperatures', area: 'garage', kind: 'temperature',
    available: true, readings: Object.fromEntries([8.2, 11.3, 13.4].map((value, index) => [`probe_${index}`,
      { value, label: `Probe ${index + 1}`, unit: 'degC', observedAt: now, stale: false }])) }] },
    garage: { adapter: { telemetry: { garage_native_indoor_temperature: { value: 16.5, sourceTime: now, supported: true, usable: true } } } } }));
  const row = deviceNode(document, 'garage-equipment-readings', 'temperature-group');
  assert.equal(row.tagName, 'SECTION');
  assert.deepEqual(descendants(row).filter(node => node.classList.contains('status-detail-label')).map(node => node.textContent),
    ['8.2 °C', '11.3 °C', '13.4 °C']);
  const native = deviceNode(document, 'garage-equipment-readings', 'inventory:garage-pump-temperatures');
  assert.equal(native.tagName, 'SECTION'); assert.match(native.textContent, /16.5 °C/);
  assert.equal(native.querySelector('summary'), null);
});

test('vehicle connections identify the assigned TeslaMate charger and generic vehicle MQTT route', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  panel.update(status({ equipment: { devices: [], topicGroups: [
    { id: 'teslamate', topics: [{ role: 'Vehicle subscription', topic: 'fixture/vehicle/teslamate', direction: 'subscribe' }] },
    { id: 'charger1-vehicle', label: 'Charger 1 vehicle', source: 'MQTT',
      topics: [{ role: 'Timestamped vehicle readings', topic: 'fixture/charger1/vehicle', direction: 'subscribe' }] },
  ] } }));
  const connections = descendants(document.getElementById('equipment-connections'));
  const tesla = connections.find(node => node.dataset.deviceId === 'connection:teslamate:other');
  assert.equal(tesla.querySelector('.equipment-connection-name').textContent, 'Charger 2 vehicle');
  assert.equal(tesla.querySelector('.equipment-connection-meta').textContent, 'Vehicle · TeslaMate');
  const generic = connections.find(node => node.dataset.deviceId === 'connection:charger1-vehicle:other');
  assert.equal(generic.querySelector('.equipment-connection-name').textContent, 'Charger 1 vehicle');
  assert.equal(generic.querySelector('.equipment-connection-meta').textContent, 'Vehicle · MQTT');
  assert.equal(generic.tagName, 'DETAILS', 'Connection folds still reveal their configured MQTT topics');
});
