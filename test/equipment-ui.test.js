import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, createEquipmentPanel, equipmentReadingRows, equipmentTestAllowed, equipmentSource, equipmentControlAllowed, equipmentCheckText, dhwrReadingSummary } from '../chart/equipment.js';
import { historyDatasets, historyValueLabel } from '../chart/history-model.js';
import { providerName } from '../chart/provider-status.js';
import { DEHUMIDIFIER_OPTIONS, dehumidifierControlAllowed, dehumidifierResult } from '../chart/caravan.js';

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
    const dataset = historyDatasets({}, CHART_VIEW_BY_KEY.temperatures).find(row => row.key === key);
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
    removeAttribute(name) { this.attributes.delete(name); }
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

test('temperature and tariff equipment expose readings without an empty fold and update existing rows in place', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const upstairs = { id: 'upstairs', label: 'Upstairs', area: 'home', kind: 'temperature', source: 'MQTT', available: false,
    readings: { indoor_temperature: { label: 'Temperature', unit: 'degC', value: null, stale: true } } };
  const tariff = { id: 'tariff', label: 'Tariff control', area: 'home', kind: 'switch', source: 'Shelly', available: true,
    controls: { switch: true, tariff: true },
    readings: { tariff_active: { label: 'Switch', unit: 'state', value: 0, stale: false, observedAt: now } } };
  const initial = status({ equipment: { devices: [upstairs, plug, tariff] } }); panel.update(initial);
  const tariffRow = deviceNode(document, 'home-equipment-readings', 'tariff');
  assert.equal(tariffRow.tagName, 'SECTION'); assert.equal(tariffRow.querySelector('summary'), null);
  assert.equal(tariffRow.querySelector('.status-detail-label').textContent, 'Off');
  assert.equal(tariffRow.querySelector('.equipment-inline-controls'), null);
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

test('temperature groups show all probes directly without a duplicate Mitsubishi temperature card', () => {
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
  assert.equal(native, undefined);
});

test('MQTT groups vehicle connection cards and preserves expanded diagnostics across updates', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const initial = status({ charging: { vehicleFeeds: [
    { id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: 'fixture/vehicle/teslamate', reception: {} },
    { id: 'bmw', label: 'Vehicle', provider: null, topic: 'fixture/vehicles/bmw', reception: {} },
  ] }, equipment: { devices: [], topicGroups: [
    { id: 'vehicle:tesla', vehicleFeedId: 'tesla', topics: [{ role: 'Vehicle subscription', topic: 'fixture/vehicle/teslamate', direction: 'subscribe' }] },
    { id: 'vehicle:bmw', vehicleFeedId: 'bmw', label: 'BMW vehicle', source: 'MQTT',
      topics: [{ role: 'Timestamped vehicle readings', topic: 'fixture/vehicles/bmw', direction: 'subscribe' }] },
  ] } });
  panel.update(initial);
  const connections = descendants(document.getElementById('equipment-connections'));
  const tesla = connections.find(node => node.dataset.deviceId === 'connection:vehicle:tesla:other');
  assert.equal(tesla.querySelector('.equipment-connection-name').textContent, 'Tesla');
  assert.equal(tesla.querySelector('.equipment-connection-meta').textContent, 'Vehicle · TeslaMate');
  const generic = connections.find(node => node.dataset.deviceId === 'connection:vehicle:bmw:other');
  assert.equal(generic.querySelector('.equipment-connection-name').textContent, 'Vehicle');
  assert.equal(generic.querySelector('.equipment-connection-meta').textContent, 'Vehicle · MQTT');
  assert.equal(generic.tagName, 'DETAILS', 'Connection folds still reveal their configured MQTT topics');
  generic.open = true; generic.querySelector('.equipment-packet-details').open = true;
  panel.update({ ...initial, charging: { vehicleFeeds: [initial.charging.vehicleFeeds[0], {
    ...initial.charging.vehicleFeeds[1], label: 'BMW', provider: 'bmw-cardata', reception: {
      brokerConnected: true, subscriptionStatus: 'subscribed', lastMessageAt: now, lastLiveAt: now,
    },
  }] } });
  assert.equal(generic.querySelector('.equipment-connection-meta').textContent, 'Vehicle · BMW CarData');
  assert.equal(generic.querySelector('.equipment-connection-name').textContent, 'BMW');
  assert.equal(generic.querySelector('.equipment-device-status').textContent, 'Connected');
  assert.match(generic.querySelector('.equipment-connection-recent').textContent, /^Reported /);
  assert.match(generic.textContent, /fixture\/vehicles\/bmw/);
  assert.equal(generic.open, true);
  assert.equal(generic.querySelector('.equipment-packet-details').open, true);
  assert.equal(generic.parentElement.parentElement.dataset.connectionArea, 'vehicles');
  assert.equal(generic.querySelector('.equipment-connection-body').children[0], generic.querySelector('.equipment-connection-intro'));
  assert.match(generic.querySelector('.equipment-connection-intro').textContent, /BMW CarData sends vehicle reports through this MQTT subscription/);
  assert.equal(descendants(document.getElementById('equipment-connections'))
    .filter(node => node.dataset.deviceId === 'connection:vehicle:bmw:other').length, 1);
});

test('Shelly Charger 2 stays in MQTT with the same disclosure structure and actual packet diagnostics', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const initial = status({ providers: { 'shelly-evse': { enabled: true, status: 'ok', connected: true,
    mqttStatus: { brokerConnected: true, subscriptionStatus: 'subscribed', lastLiveAt: now },
    topics: [{ role: 'Charger status', topic: 'fixture/charger/events/rpc', direction: 'subscribe' },
      { role: 'RPC requests', topic: 'fixture/charger/rpc', direction: 'publish' }] } } });
  panel.update(initial);
  const card = descendants(document.getElementById('equipment-connections'))
    .find(node => node.dataset.deviceId === 'connection:shelly-evse:garage');
  assert.equal(card.parentElement.parentElement.dataset.connectionArea, 'garage');
  assert.equal(card.tagName, 'DETAILS');
  assert.equal(card.querySelector('.equipment-connection-name').textContent, 'Charger 2');
  assert.equal(card.querySelector('.equipment-connection-meta').textContent, 'Charger · Shelly EVSE');
  assert.match(card.querySelector('.equipment-connection-intro').textContent, /local Shelly MQTT/);
  assert.match(card.querySelector('.equipment-packet-status').textContent, /Subscription: subscribed.*Last live packet:.*Broker connection: connected/);
  assert.match(card.querySelector('.equipment-topic-groups').textContent, /Incoming.*Charger status.*fixture\/charger\/events\/rpc.*Requests & commands.*RPC requests/);
  assert.equal(card.querySelector('.equipment-connection-check').hidden, true);
  card.open = true;
  panel.update({ ...initial, providers: { 'shelly-evse': { ...initial.providers['shelly-evse'], connected: false,
    status: 'waiting', mqttStatus: { brokerConnected: false, subscriptionStatus: 'disconnected', lastLiveAt: now } } } });
  assert.equal(card.open, true);
  assert.equal(card.querySelector('.equipment-device-status').textContent, 'Disconnected');
  assert.match(card.querySelector('.equipment-connection-recent').textContent, /^Reported /);
});

const caravanAir = () => ({ id: 'blu_ht', label: 'Caravan air', area: 'garage', kind: 'temperature', available: true,
  readings: { caravan_temperature: { label: 'Temperature', value: 14.1, unit: 'degC', observedAt: now, stale: false },
    caravan_humidity: { label: 'Relative humidity', value: 63, unit: '%', observedAt: now, stale: false },
    blu_ht_battery: { label: 'Battery', value: 100, unit: '%', observedAt: now, stale: false },
    blu_ht_rssi: { label: 'Bluetooth signal', value: -81, unit: 'dBm', observedAt: now, stale: false } } });
const dehumidifier = (live = false) => ({ id: 'caravan_dehumidifier', label: 'Caravan dehumidifier', area: 'garage',
  kind: 'dehumidifier', available: live, controls: { dehumidifier: true }, readings: {},
  dehumidifier: { available: live, state: live ? { power: 'off', mode: 'auto', targetHumidity: 55, fanSpeed: 'low', swing: 'fixed_90' } : {},
    runningState: live ? 'off' : null, operation: null } });

test('Caravan groups air and pending dehumidifier with energy, preserving disclosure and showing only reported values', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const initial = status({ equipment: { devices: [caravanAir(), { ...plug, label: 'Caravan energy' }, dehumidifier()] } });
  panel.update(initial);
  const caravan = deviceNode(document, 'garage-equipment-readings', 'caravan');
  assert.equal(caravan.children[0].querySelector('h4').textContent, 'Caravan');
  assert.match(caravan.querySelector('.equipment-device-preview').textContent, /14.1 °C · 63 % · 0.28 kW/);
  assert.equal(deviceNode(document, 'garage-equipment-readings', 'blu_ht'), undefined);
  assert.equal(deviceNode(document, 'home-equipment-readings', 'blu_ht'), undefined);
  const air = caravan.querySelector('.caravan-air');
  assert.equal(air.querySelector('.caravan-air-metrics').textContent, 'Temperature14.1 °CRelative humidity63 %');
  assert.match(air.querySelector('.caravan-sensor-details').textContent, /Battery100 %Bluetooth signal-81 dBm/);
  const appliance = caravan.querySelector('.caravan-dehumidifier');
  assert.match(appliance.textContent, /electriQ DESD8LW.*Awaiting first MQTT report/);
  assert(descendants(appliance).filter(node => ['SELECT', 'BUTTON'].includes(node.tagName)).every(node => node.disabled));
  assert.deepEqual(DEHUMIDIFIER_OPTIONS.targetHumidity.map(option => option[0]), [35, 40, 45, 50, 55, 60, 65, 70, 75, 80]);
  caravan.open = true;
  const next = structuredClone(initial); next.equipment.devices[2] = dehumidifier(true); panel.update(next);
  assert.equal(deviceNode(document, 'garage-equipment-readings', 'caravan'), caravan); assert.equal(caravan.open, true);
  const fan = descendants(appliance).find(node => node.dataset.setting === 'fanSpeed');
  assert.equal(fan.disabled, false); assert.equal(fan.value, 'low');
  const liveDevice = next.equipment.devices[2];
  liveDevice.dehumidifier.operation = { setting: 'fanSpeed', value: 'high', requestedAt: now, status: 'published' };
  panel.update(next);
  assert.equal(fan.value, 'low', 'Publishing a command cannot overwrite a reported setting');
  assert.equal(fan.disabled, true, 'Pending delivery prevents conflicting requests');
  assert.match(appliance.querySelector('.equipment-control-result').textContent, /High requested.*awaiting device report/);
  liveDevice.dehumidifier.state.fanSpeed = 'high'; liveDevice.dehumidifier.operation.status = 'observed'; panel.update(next);
  assert.equal(fan.value, 'high'); assert.equal(fan.disabled, false);
  assert.match(appliance.querySelector('.equipment-control-result').textContent, /device reported/);
  liveDevice.dehumidifier.available = false;
  liveDevice.dehumidifier.temperatureControl = { enabled: true, colocated: false, reason: 'air-unavailable' };
  panel.update({ ...next, role: 'replica' }); assert.equal(fan.disabled, true);
  assert.equal(fan.value, 'high', 'Read-only authority cannot hide healthy reported settings');
  assert.match(appliance.querySelector('.caravan-control-help').textContent, /primary computer/);
  next.equipment.devices[0].readings.caravan_temperature.stale = true; next.equipment.devices[0].available = false;
  liveDevice.available = false; liveDevice.dehumidifier.available = false; panel.update(next);
  assert.equal(fan.value, '', 'Stale settings cannot look live');
  assert.match(air.querySelector('.caravan-air-metrics').textContent, /TemperatureUnavailableRelative humidity63 %/);
});

test('Caravan air and dehumidifier remain grouped when the energy device is absent or disabled', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  panel.update(status({ equipment: { devices: [caravanAir(), dehumidifier()] } }));
  const caravan = deviceNode(document, 'garage-equipment-readings', 'caravan');
  assert(caravan); assert.equal(caravan.querySelector('.caravan-air').hidden, false);
  assert.equal(caravan.querySelector('.equipment-inline-controls').hidden, true);
  panel.update(status({ equipment: { devices: [{ ...plug, enabled: false }, caravanAir()] } }));
  assert.equal(deviceNode(document, 'garage-equipment-readings', 'caravan'), caravan);
  assert.equal(caravan.querySelector('.caravan-dehumidifier').hidden, true);
});

test('dehumidifier commands validate allowed values, require live authority and preserve telemetry until a report arrives', async () => {
  const device = dehumidifier(true), calls = []; let resolve;
  const initial = status({ equipment: { devices: [device] } });
  const actions = createEquipmentActions({ request: (path, body) => { calls.push({ path, body }); return new Promise(done => { resolve = done; }); } });
  actions.update(initial);
  for (const [setting, value] of [['power', true], ['targetHumidity', 34], ['targetHumidity', 52], ['fanSpeed', 'off'], ['__proto__', 'off'], ['topic', 'invented/set']])
    assert.equal(await actions.dehumidifier(device.id, setting, value), false);
  assert.equal(await actions.dehumidifier('missing', 'power', 'on'), false);
  const pending = actions.dehumidifier(device.id, 'power', 'on');
  assert.equal(await actions.dehumidifier(device.id, 'mode', 'heater'), false);
  assert.deepEqual(calls, [{ path: '/api/equipment/dehumidifier', body: { deviceId: device.id, setting: 'power', value: 'on' } }]);
  resolve(initial); await pending;
  assert.equal(actions.snapshot().status.equipment.devices[0].dehumidifier.state.power, 'off');
  for (const unavailable of [{ ...initial, role: 'replica' }, { ...initial, role: 'protected' }, { ...initial, role: 'transition' },
    { ...initial, pairing: { enabled: true, role: 'primary', canControl: false } }]) {
    actions.update(unavailable); assert.equal(await actions.dehumidifier(device.id, 'power', 'on'), false);
  }
  assert.equal(dehumidifierControlAllowed(initial, dehumidifier()), false);
  assert.equal(dehumidifierControlAllowed(initial, { ...device, controls: {} }), false);
  assert.equal(dehumidifierControlAllowed(initial, { ...device, enabled: false }), false);
  device.dehumidifier.operation = { setting: 'power', value: 'on', requestedAt: now, status: 'unconfirmed' };
  assert.match(dehumidifierResult(device, now), /no confirming device report/);
  assert.equal(dehumidifierResult(device, now + 60_000), '');
});

test('equipment readings honor categorical state labels and never coerce unknown running states to Off', () => {
  const device = { kind: 'dehumidifier', available: true, readings: { caravan_dehumidifier_running_state: {
    label: 'Running state', unit: 'state', observedAt: now, stale: false,
    stateLabels: { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Auto' },
  } } };
  const reading = device.readings.caravan_dehumidifier_running_state;
  for (const [value, expected] of [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High'], [4, 'Auto'],
    [5, 'Unknown'], [null, 'Unknown'], [false, 'Unknown'], ['0', 'Unknown']]) {
    reading.value = value; assert.equal(equipmentReadingRows(device)[0].value, expected);
  }
  reading.value = 2; reading.stale = true;
  assert.equal(equipmentReadingRows(device)[0].value, 'Unknown');
  assert.match(equipmentReadingRows(device)[0].detail, /Last reported Medium/);
});


test('permission explanations stay outside equipment control rows and follow a door changing area', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const door = { id: 'door', label: 'Door', kind: 'door', area: 'home', available: true,
    controls: { cover: { open: true, close: true } }, cover: { available: true, state: 'closed' },
    readings: { door_open: { value: 0, unit: 'state', observedAt: now, stale: false } } };
  const current = status({ equipment: { devices: [structuredClone(plug), caravanAir(), dehumidifier(true), door] } });
  panel.update(current);
  const caravan = deviceNode(document, 'garage-equipment-readings', 'caravan');
  const switches = caravan.querySelector('.equipment-switch-buttons');
  assert.deepEqual(switches.children.map(node => node.tagName), ['BUTTON', 'BUTTON']);
  const switchNote = switches.parentElement.querySelector('.family-access-note');
  assert.equal(switchNote.parentElement, switches.parentElement);
  assert.equal(switches.children[0].getAttribute('aria-describedby'), null);
  const appliance = caravan.querySelector('.caravan-dehumidifier');
  const controls = appliance.querySelector('.caravan-dehumidifier-controls');
  const applianceNote = appliance.querySelector('.family-access-note');
  assert.equal(applianceNote.parentElement, controls.parentElement);
  assert.equal(controls.children.length, 5, 'permission text does not occupy a dehumidifier grid cell');
  const homeDoor = deviceNode(document, 'home-equipment-readings', 'door');
  const coverNote = homeDoor.querySelector('.equipment-cover-controls').querySelector('.family-access-note');
  const coverButtons = homeDoor.querySelector('.equipment-cover-buttons');
  assert.equal(coverNote.hidden, false);
  assert.equal(coverNote.parentElement, coverButtons.parentElement);
  assert(coverButtons.children.every(button => button.getAttribute('aria-describedby') === 'equipment-cover-door-help'));
  door.area = 'garage'; panel.update(current);
  assert.equal(deviceNode(document, 'garage-equipment-readings', 'door'), homeDoor);
  assert.equal(coverNote.hidden, true);
  assert(coverButtons.children.every(button => button.getAttribute('aria-describedby') === 'equipment-cover-door-help'));
});

test('recorded equipment values stay visible with provenance while live device authority remains unavailable', () => {
  const device = { kind: 'metered_switch', readOnly: true, available: false, readings: {
    synthetic_active: { value: 0, unit: 'state', observedAt: now - 60000, readOnly: true, stale: true },
    synthetic_power: { value: 0, unit: 'W', observedAt: now - 60000, readOnly: true, stale: true },
    synthetic_invalid: { value: 999, unit: 'W', observedAt: now - 60000, readOnly: true, stale: true, quality: ['invalid'] },
  } };
  const rows = equipmentReadingRows(device);
  assert.equal(rows[0].value, 'Off');
  assert.equal(rows[1].value, '0 W');
  assert(rows.slice(0, 2).every(row => row.qualifier === 'Recorded' && row.stale));
  assert.equal(rows[2].value, 'Unavailable');
  assert.equal(equipmentControlAllowed({ role: 'replica' }, device, false), false);
});
