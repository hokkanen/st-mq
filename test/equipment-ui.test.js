import { CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, createEquipmentPanel, equipmentReadingRows, equipmentTestAllowed, equipmentSource, equipmentControlAllowed, equipmentCheckText, dhwrReadingSummary } from '../chart/equipment.js';
import { historyDatasets, historyValueLabel } from '../chart/history-model.js';
import { providerName } from '../chart/provider-status.js';
import { DEHUMIDIFIER_OPTIONS, dehumidifierControlAllowed, dehumidifierResult } from '../chart/caravan.js';

const now = Date.parse('2026-09-13T12:00:00Z');

test('dehumidifier receipts preserve delivery and feedback causes until confirmation or expiry', () => {
  const device = { dehumidifier: { operation: { setting: 'power', value: 'on', requestedAt: now, status: 'unconfirmed' } } };
  for (const cause of ['Dehumidifier command delivery is unconfirmed. Check its live state before trying again.',
    'Control connection changed. Check the dehumidifier live state.',
    'The requested setting has not been reported. Check the dehumidifier live state.']) {
    device.dehumidifier.operation.error = cause;
    assert.equal(dehumidifierResult(device, now + 1000), `Power: On requested · ${cause}`);
  }
  device.dehumidifier.operation.status = 'observed'; delete device.dehumidifier.operation.error;
  assert.match(dehumidifierResult(device, now + 2000), /device reported/);
  assert.equal(dehumidifierResult(device, now + 86400_000), '');
});
const plug = { id: 'caravan', label: 'Caravan', area: 'garage', kind: 'metered_switch', source: 'MQTT-shelly',
  connection: 'shelly:invented-caravan', available: true, controls: { switch: true },
  readings: { caravan_active: { value: 1, unit: 'state', label: 'Switch', observedAt: now, stale: false },
    caravan_current: { value: 1.2, unit: 'A', label: 'Current', estimated: true, observedAt: now },
    caravan_power: { value: 0.28, unit: 'kW', label: 'Power', observedAt: now } },
  energy: { dailyKwh: 1.23, partial: true, observedAt: now } };
const status = (overrides = {}) => ({ role: 'master', now, equipment: { configured: true, devices: [structuredClone(plug)] },
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
  for (const next of [status({ role: 'slave' }), status({ equipmentTests: { available: false } }),
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
  actions.update(status({ role: 'slave' }));
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
  for (const next of [{ ...current, role: 'slave' }, { ...current, equipmentControls: { available: true, busy: true } }])
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
  assert.equal(summary.summaryValue, 'Off');
  assert.equal(summary.summaryNote, 'Needs attention');
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
  assert.equal(summary.summaryValue, 'On');
  assert.equal(summary.summaryNote, 'Power reported');
  assert.equal(summary.feedbackLabel, 'Available');
  assert.equal(summary.feedbackState, 'available');
  assert.match(summary.feedbackRecent, /^Reported 13 Sept.*GMT\+3/);
  assert.equal(summary.request, 'No circulation requested');
  status.dhwr.restorationPending = true;
  summary = dhwrReadingSummary(status);
  assert.equal(summary.summaryValue, 'Stop pending');
  assert.equal(summary.summaryNote, 'On · power reported');
  const requested = dhwrReadingSummary({ dhwr: { active: true } });
  assert.equal(requested.summaryValue, 'On requested');
  assert.equal(requested.summaryNote, 'Not confirmed');
  assert.equal(dhwrReadingSummary({}).summaryValue, 'Unknown');
});

test('Shelly circulation health shows standard availability and the original report time', () => {
  const status = { dhwr: { feedback: { configured: true, available: false,
    stateConfigured: true, powerConfigured: true, basis: 'power' } } };
  let summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, 'Unavailable');
  assert.match(summary.power.detail, /Waiting for a live Shelly report/);
  assert.equal(summary.feedbackLabel, 'Waiting for report');
  assert.equal(summary.feedbackRecent, 'No live report yet');
  status.dhwr.feedback.available = true;
  status.dhwr.feedback.power = { value: 0, unit: 'W', stale: false, observedAt: now };
  status.dhwr.feedback.state = { ...status.dhwr.feedback.power, unit: 'state' };
  summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, '0 W');
  assert.equal(summary.powerLabel, 'Live power');
  assert.match(summary.feedbackRecent, /Reported 13 Sept.*GMT\+3/);
  assert.equal(summary.feedbackLabel, 'Available');
  assert.equal(summary.feedbackState, 'available');
  status.dhwr.feedback.available = false;
  status.dhwr.feedback.power.stale = true;
  status.dhwr.feedback.state.stale = true;
  summary = dhwrReadingSummary(status);
  assert.equal(summary.power.value, 'Unavailable');
  assert.equal(summary.feedbackLabel, 'Needs attention');
  assert.equal(summary.feedbackState, 'attention');
  assert.match(summary.feedbackRecent, /Reported 13 Sept.*GMT\+3/);
  assert.match(summary.power.detail, /Last reported 0 W/);
  assert.equal(summary.state.value, 'Unknown');
});

test('recorded circulation shows saved operation without inventing raw power, live availability or a request', () => {
  const status = { role: 'slave', readOnly: true, dhwr: { active: false, feedback: {
    configured: true, available: false, recorded: true, basis: 'power',
    state: { value: 0, unit: 'state', stale: true, observedAt: now, readOnly: true },
  } } };
  const summary = dhwrReadingSummary(status);
  assert.equal(summary.state.value, 'Off');
  assert.equal(summary.state.stale, true);
  assert.equal(summary.power.value, 'Not recorded');
  assert.equal(summary.feedbackLabel, 'Recorded snapshot');
  assert.equal(summary.feedbackState, 'pending');
  assert.equal(summary.available, false);
  assert.equal(summary.summary, 'Off · recorded operation');
  assert.equal(summary.summaryValue, 'Off');
  assert.equal(summary.summaryNote, 'Recorded snapshot');
  assert.match(summary.feedbackRecent, /Reported 13 Sept.*GMT\+3/);
  assert.match(summary.request, /controls are available on the master/);
  delete status.dhwr.feedback.state;
  const missing = dhwrReadingSummary(status);
  assert.equal(missing.feedbackLabel, 'No recorded report');
  assert.equal(missing.state.value, 'Unknown');
  assert.equal(missing.power.value, 'Not recorded');
  assert.doesNotMatch(JSON.stringify(missing), /Feedback not configured|No circulation requested|live report yet/);
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
    capabilities: Object.fromEntries(Object.entries(DEHUMIDIFIER_OPTIONS).map(([setting, options]) => [setting, options.map(([value]) => value)])),
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
  assert.match(appliance.textContent, /Dehumidifier.*Awaiting first device report/);
  assert(descendants(appliance).filter(node => ['SELECT', 'BUTTON'].includes(node.tagName)).every(node => node.disabled));
  assert.deepEqual(DEHUMIDIFIER_OPTIONS.targetHumidity.map(option => option[0]), [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]);
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
  liveDevice.dehumidifier.temperatureControl = { enabled: true, qualified: false, reason: 'air-unavailable' };
  panel.update({ ...next, role: 'slave' }); assert.equal(fan.disabled, true);
  assert.equal(fan.value, 'high', 'Read-only authority cannot hide healthy reported settings');
  assert.match(appliance.querySelector('.caravan-control-help').textContent, /master computer/);
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
  for (const unavailable of [{ ...initial, role: 'slave' }, { ...initial, role: 'protected' }, { ...initial, role: 'transition' },
    { ...initial, topology: 'pair', pair: { role: 'master', canControl: false } }]) {
    actions.update(unavailable); assert.equal(await actions.dehumidifier(device.id, 'power', 'on'), false);
  }
  assert.equal(dehumidifierControlAllowed(initial, dehumidifier()), false);
  assert.equal(dehumidifierControlAllowed(initial, { ...device, controls: {} }), false);
  assert.equal(dehumidifierControlAllowed(initial, { ...device, enabled: false }), false);
  device.dehumidifier.operation = { setting: 'power', value: 'on', requestedAt: now, status: 'unconfirmed' };
  assert.match(dehumidifierResult(device, now), /no confirming device report/);
  assert.match(dehumidifierResult(device, now + 60_000), /no confirming device report/);
  assert.equal(dehumidifierResult(device, now + 86400_000), '');
});

test('dehumidifier controls follow reported capabilities and automatic power rejects manual commands', async () => {
  const device = dehumidifier(true), calls = [], document = equipmentDocument();
  device.dehumidifier.capabilities = { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'], targetHumidity: [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] };
  device.dehumidifier.temperatureControl = { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2,
    recording: false, qualified: false, reason: 'power-test-failed', temperatureC: 14.1, humidity: 63, applianceTemperatureC: 22, applianceHumidity: 35,
    locationTest: { status: 'failed', phase: null, reason: 'power-test-failed', minimumPowerChangeW: 3, powerRiseW: 0, powerFallW: 0 } };
  const current = status({ equipment: { devices: [caravanAir(), device] } });
  const panel = createEquipmentPanel({ document, request: async (path, body) => { calls.push({ path, body }); return current; } }); panel.update(current);
  const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
  assert.equal(appliance.querySelector('.caravan-setting-mode').hidden, true);
  assert.equal(appliance.querySelector('.caravan-setting-swing').hidden, true);
  const fan = descendants(appliance).find(node => node.dataset.setting === 'fanSpeed');
  assert.equal(fan.children.find(option => option.value === 'auto').hidden, true);
  assert(appliance.querySelector('.caravan-power-buttons').children.every(button => button.disabled));
  assert.match(appliance.querySelector('.caravan-recording').textContent, /Recording paused.*power did not confirm both switches/);
  assert.doesNotMatch(appliance.textContent, /inside|outside|located|in caravan/i);
  const actions = createEquipmentActions({ request: async (path, body) => { calls.push({ path, body }); return current; } }); actions.update(current);
  for (const [setting, value] of [['power', 'on'], ['mode', 'heater'], ['fanSpeed', 'auto'], ['swing', 'fixed_45']])
    assert.equal(await actions.dehumidifier(device.id, setting, value), false);
  assert.deepEqual(calls, []);
  assert.equal(await actions.dehumidifier(device.id, 'targetHumidity', 30), true);
  delete device.dehumidifier.capabilities; actions.update(current);
  assert.equal(await actions.dehumidifier(device.id, 'fanSpeed', 'medium'), false, 'Missing capabilities cannot grant controls');
});

test('automatic power edits validate hysteresis, preserve draft through polling and save explicit device intent', async () => {
  const device = dehumidifier(true), calls = [], document = equipmentDocument();
  device.dehumidifier.temperatureControl = { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2,
    recording: true, qualified: true, reason: 'warm', temperatureC: 14, humidity: 60, applianceTemperatureC: 15, applianceHumidity: 58,
    locationTest: { status: 'passed', phase: null, reason: null, minimumPowerChangeW: 3, powerRiseW: 8, powerFallW: 8 } };
  const current = status({ equipment: { devices: [device] } });
  const panel = createEquipmentPanel({ document, request: async (path, body) => {
    calls.push({ path, body }); Object.assign(device.dehumidifier.temperatureControl, body); return current;
  } }); panel.update(current);
  const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
  const policy = appliance.querySelector('.caravan-temperature-control'), save = policy.querySelector('button');
  const input = setting => descendants(policy).find(node => node.dataset.setting === setting);
  assert.equal(input('automaticPower').checked, true); assert.equal(input('offAtC').value, '1'); assert.equal(input('onAtC').value, '2');
  assert.equal(save.disabled, true);
  input('onAtC').value = '1.2'; input('onAtC').listeners.get('input')();
  assert.equal(save.disabled, true); assert.match(policy.querySelector('.caravan-policy-message').textContent, /at least 0.5/);
  assert.equal(input('onAtC').getAttribute('aria-invalid'), 'true');
  assert.match(input('onAtC').getAttribute('aria-describedby'), /caravan-policy-message/);
  input('onAtC').value = '3'; input('onAtC').listeners.get('input')();
  input('automaticPower').checked = false; input('automaticPower').listeners.get('input')();
  panel.update(current); assert.equal(input('onAtC').value, '3', 'Status refresh keeps the draft'); assert.equal(save.disabled, false);
  assert.equal(input('onAtC').getAttribute('aria-invalid'), 'false');
  assert.equal(appliance.querySelector('.caravan-policy-state').textContent, 'Enabled', 'Summary describes saved policy');
  assert.equal(appliance.querySelector('.caravan-power').hidden, true, 'An unsaved draft never enables manual power');
  assert.equal(policy.querySelector('.caravan-policy-draft').textContent, 'Unsaved changes');
  await policy.listeners.get('submit')({ preventDefault() {} });
  assert.deepEqual(calls, [{ path: '/api/equipment/dehumidifier/temperature-control', body: { deviceId: device.id, enabled: false, offAtC: 1, onAtC: 3 } }]);
  assert.equal(save.disabled, true); assert.match(appliance.querySelector('.equipment-control-result').textContent, /settings saved/);
  assert.equal(appliance.querySelector('.caravan-recording').children[0].textContent, 'Recording active', 'Manual power does not remove recording checks');
  assert.equal(appliance.querySelector('.caravan-power-buttons').children[1].disabled, false);
  assert.equal(appliance.querySelector('.caravan-power').hidden, false);
  assert.equal(appliance.querySelector('.caravan-policy-state').textContent, 'Disabled');
  panel.update({ ...current, role: 'slave' });
  assert([input('automaticPower'), input('offAtC'), input('onAtC'), save].every(node => node.disabled));
});

test('manual power off stays available with fresh power evidence when the fan setting is unavailable', async () => {
  const device = dehumidifier(), calls = [], document = equipmentDocument();
  Object.assign(device.dehumidifier, { powerOffAvailable: true, state: { power: 'on' }, observedAt: now });
  const current = status({ equipment: { devices: [device] } });
  const request = async (path, body) => { calls.push({ path, body }); return current; };
  const panel = createEquipmentPanel({ document, request }); panel.update(current);
  const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
  const buttons = appliance.querySelector('.caravan-power-buttons').children;
  assert.equal(buttons[0].disabled, false); assert.equal(buttons[1].disabled, true);
  assert.match(appliance.querySelector('.caravan-section-status').textContent, /On.*Fan setting unavailable/);
  const actions = createEquipmentActions({ request }); actions.update(current);
  assert.equal(await actions.dehumidifier(device.id, 'power', 'on'), false);
  assert.equal(await actions.dehumidifier(device.id, 'fanSpeed', 'low'), false);
  assert.equal(await actions.dehumidifier(device.id, 'power', 'off'), true);
  assert.deepEqual(calls, [{ path: '/api/equipment/dehumidifier', body: { deviceId: device.id, setting: 'power', value: 'off' } }]);
  actions.update({ ...current, role: 'slave' }); assert.equal(await actions.dehumidifier(device.id, 'power', 'off'), false);
  device.dehumidifier.temperatureControl = { enabled: true }; actions.update(current);
  assert.equal(await actions.dehumidifier(device.id, 'power', 'off'), false, 'Automatic power retains sole ownership');
});

test('automatic power actions reject malformed thresholds and remain editable during appliance outages only with authority', async () => {
  const device = dehumidifier(), calls = [];
  device.dehumidifier.temperatureControl = { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2 };
  const current = status({ equipment: { devices: [device] } });
  const actions = createEquipmentActions({ request: async (path, body) => { calls.push({ path, body }); return current; } }); actions.update(current);
  for (const values of [null, undefined, {}, [], { enabled: 'true', offAtC: 1, onAtC: 2 }, { enabled: true, offAtC: 2, onAtC: 1 },
    { enabled: true, offAtC: 1, onAtC: 1.4 }, { enabled: true, offAtC: 1.01, onAtC: 2 },
    { enabled: true, offAtC: -11, onAtC: 2 }, { enabled: true, offAtC: 1, onAtC: Infinity }])
    assert.equal(await actions.dehumidifierTemperatureControl(device.id, values), false);
  assert.equal(await actions.dehumidifierTemperatureControl(device.id, { enabled: false, offAtC: 1, onAtC: 2 }), true);
  assert.equal(calls.length, 1);
  device.dehumidifier.temperatureControl.canEdit = false; actions.update(current);
  assert.equal(await actions.dehumidifierTemperatureControl(device.id, { enabled: true, offAtC: 1, onAtC: 2 }), false);
});

test('recording explains the power check, modest loads and missing evidence independently of humidity', () => {
  const device = dehumidifier(true), document = equipmentDocument();
  device.dehumidifier.temperatureControl = { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2,
    temperatureC: 14, humidity: 60, applianceTemperatureC: null, applianceHumidity: 25,
    recording: false, qualified: false, reason: 'checking-power',
    locationTest: { status: 'testing', phase: 'on', reason: null, minimumPowerChangeW: 3, powerRiseW: 5.2, powerFallW: null } };
  const panel = createEquipmentPanel({ document, request: async () => {} }), current = status({ equipment: { devices: [device] } });
  panel.update(current);
  const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
  assert.match(appliance.querySelector('.caravan-recording').textContent, /Recording paused.*power rises with On and falls with Off/);
  assert.equal(appliance.querySelector('.caravan-recording-details').children[0].textContent, 'Power check');
  const evidence = appliance.querySelector('.caravan-power-check');
  assert.equal(evidence.querySelector('.caravan-power-changes').textContent, 'Rise after On5.2 WFall after OffUnavailable');
  assert.match(evidence.textContent, /Dehumidifier25 %Air sensor60 %/);
  assert.match(evidence.querySelector('.caravan-comparison-rule').textContent, /at least 3 W.*small fan load.*Humidity is not a recording requirement/);
  assert.equal(evidence.querySelector('.caravan-temperature-label').hidden, true, 'Absent appliance temperature has no visible placeholder');
  for (const [reason, expected] of [['appliance-unavailable', /fresh dehumidifier reports/],
    ['air-unavailable', /fresh caravan air temperature for automatic power/], ['power-unavailable', /fresh Caravan power/],
    ['restoring-power', /Restoring.*previous power setting/], ['control-unavailable', /control authority/],
    ['cold', /temperature above the automatic Off threshold before checking power/],
    ['power-test-failed', /power did not confirm both switches/]]) {
    Object.assign(device.dehumidifier.temperatureControl, { reason }); panel.update(current);
    assert.match(appliance.querySelector('.caravan-recording').textContent, expected);
    assert.doesNotMatch(appliance.querySelector('.caravan-recording').textContent, /inside|outside|located|in caravan/i);
  }
  Object.assign(device.dehumidifier.temperatureControl, { recording: true, qualified: true, reason: 'disabled', enabled: false,
    humidity: null, applianceHumidity: null,
    locationTest: { status: 'passed', phase: null, reason: null, minimumPowerChangeW: 3, powerRiseW: 5.2, powerFallW: 5 } }); panel.update(current);
  assert.match(appliance.querySelector('.caravan-recording').textContent, /Recording active.*power followed native On and Off/);
  assert.equal(evidence.querySelector('.caravan-humidity-label').hidden, true, 'Missing humidity does not qualify or block recording');
  assert.equal(evidence.querySelector('.caravan-power-changes').textContent, 'Rise after On5.2 WFall after Off5 W');
  Object.assign(device.dehumidifier.temperatureControl, { reason: 'cold', enabled: true }); panel.update(current);
  assert.match(appliance.querySelector('.caravan-recording').textContent, /Recording active.*power followed native On and Off/);
});

test('power testing and restoration lock native settings and the direct command path', async () => {
  const device = dehumidifier(true), document = equipmentDocument(), calls = [];
  device.dehumidifier.temperatureControl = { configured: true, enabled: false, canEdit: true, offAtC: 1, onAtC: 2,
    recording: false, reason: 'checking-power', locationTest: { status: 'testing', phase: 'on', minimumPowerChangeW: 3 } };
  const current = status({ equipment: { devices: [device] } });
  const request = async (...args) => { calls.push(args); return current; };
  const panel = createEquipmentPanel({ document, request }), actions = createEquipmentActions({ request });
  for (const reason of ['checking-power', 'restoring-power']) {
    device.dehumidifier.probeBusy = true;
    device.dehumidifier.temperatureControl.reason = reason;
    panel.update(current); actions.update(current);
    const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
    const controls = descendants(appliance.querySelector('.caravan-dehumidifier-controls')).filter(node => ['BUTTON', 'SELECT'].includes(node.tagName));
    assert(controls.every(node => node.disabled));
    const policy = appliance.querySelector('.caravan-temperature-control');
    assert(descendants(policy).filter(node => ['BUTTON', 'INPUT'].includes(node.tagName)).every(node => node.disabled));
    assert.match(appliance.querySelector('.caravan-control-help').textContent, /locked while the power check runs/);
    assert.equal(await actions.dehumidifier(device.id, 'power', 'on'), false);
    assert.equal(await actions.dehumidifier(device.id, 'fanSpeed', 'high'), false);
    assert.equal(await actions.dehumidifierTemperatureControl(device.id, { enabled: true, offAtC: 1, onAtC: 2 }), false);
    device.dehumidifier.powerOffAvailable = true;
    assert.equal(await actions.dehumidifier(device.id, 'power', 'off'), false);
  }
  assert.deepEqual(calls, []);
  device.dehumidifier.probeBusy = false; actions.update(current);
  assert.equal(await actions.dehumidifier(device.id, 'fanSpeed', 'high'), true);
});

test('equipment readings honor combined appliance state labels and never coerce unknown state to Off', () => {
  const device = { kind: 'dehumidifier', available: true, readings: { caravan_dehumidifier_state: {
    label: 'Running state', unit: 'state', observedAt: now, stale: false,
    stateLabels: { 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' },
  } } };
  const reading = device.readings.caravan_dehumidifier_state;
  for (const [value, expected] of [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High'], [4, 'Unknown'],
    [5, 'Unknown'], [null, 'Unknown'], [false, 'Unknown'], ['0', 'Unknown']]) {
    reading.value = value; assert.equal(equipmentReadingRows(device)[0].value, expected);
  }
  reading.value = 1; reading.stale = true;
  assert.equal(equipmentReadingRows(device)[0].value, 'Unknown');
  assert.match(equipmentReadingRows(device)[0].detail, /Last reported Low/);
});

test('Caravan live power stays independent from its optional fan setting', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const device = dehumidifier(true), current = status({ equipment: { devices: [device] } });
  Object.assign(device.dehumidifier, { runningState: 'on', state: { power: 'on', fanSpeed: 'high' } }); panel.update(current);
  const summary = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier').querySelector('.caravan-section-status');
  assert.equal(summary.children[0].textContent, 'On');
  assert.match(summary.children[1].textContent, /^High fan/);
  device.dehumidifier.state.fanSpeed = null; panel.update(current);
  assert.equal(summary.children[0].textContent, 'On'); assert.doesNotMatch(summary.textContent, /fan|unknown/i);
  device.dehumidifier.runningState = 'high'; panel.update(current);
  assert.equal(summary.children[0].textContent, 'Power unknown', 'Retired combined state values do not act as current power observations');
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
  assert.equal(equipmentControlAllowed({ role: 'slave' }, device, false), false);
});


test('power policy drafts can be discarded without a request, while open details and focus survive polling', () => {
  const document = equipmentDocument(), calls = [], device = dehumidifier(true);
  device.dehumidifier.temperatureControl = { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2,
    recording: false, qualified: false, reason: 'power-test-failed', locationTest: { status: 'failed', reason: 'power-test-failed' } };
  const current = status({ equipment: { devices: [device] } });
  const panel = createEquipmentPanel({ document, request: (...args) => { calls.push(args); } }); panel.update(current);
  const appliance = deviceNode(document, 'garage-equipment-readings', 'caravan').querySelector('.caravan-dehumidifier');
  const details = appliance.querySelector('.caravan-policy-details'), evidence = appliance.querySelector('.caravan-recording-details');
  const policy = appliance.querySelector('.caravan-temperature-control');
  const inputs = new Map(descendants(policy).filter(node => node.dataset.setting).map(node => [node.dataset.setting, node]));
  const [save, cancel] = policy.querySelector('.caravan-policy-footer').children;
  details.open = true; evidence.open = true;
  inputs.get('onAtC').value = '4'; inputs.get('onAtC').listeners.get('input')(); inputs.get('onAtC').focus();
  panel.update(current);
  assert.equal(details.open, true); assert.equal(evidence.open, true);
  assert.equal(document.activeElement, inputs.get('onAtC')); assert.equal(inputs.get('onAtC').value, '4');
  assert.equal(cancel.hidden, false);
  cancel.listeners.get('click')();
  assert.equal(inputs.get('onAtC').value, '2'); assert.equal(inputs.get('automaticPower').checked, true);
  assert.equal(document.activeElement, inputs.get('automaticPower'));
  assert.equal(save.disabled, true); assert.equal(cancel.hidden, true); assert.deepEqual(calls, []);
  assert.equal(appliance.querySelector('.caravan-power').hidden, true);
});
