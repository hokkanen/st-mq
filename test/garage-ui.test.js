import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garageDisplay, createGarageControls } from '../chart/garage-status.js';
import { garageHeatingWarning } from '../chart/heating-warning.js';
import { heatingScopeDisplay } from '../chart/heating-scope.js';
import { heatingDisplay } from '../chart/heating-benefit.js';
import { timingDisplay } from '../chart/timing-model.js';
import { buildHeatingSavings } from '../src/app/garage-reporting.js';

const now = Date.parse('2026-09-29T12:00:00Z'), day = 86400_000;
const range = { from: now - day, to: now };
function fixture() {
  const ids = ['garage-mode-normal', 'garage-mode-away', 'garage-mode-normal-target', 'garage-mode-away-target',
    'garage-target-form', 'garage-normal-target', 'garage-target-submit', 'garage-heating-message', 'garage-warming-warning',
    'garage-control-mode', 'garage-current-room', 'garage-target-confirmation', 'garage-heating-operation', 'garage-current-mode',
    'garage-regulation-temperature', 'garage-regulation-reading', 'garage-readings-details', 'garage-protection-summary',
    'garage-heating-status', 'garage-control-detail', 'garage-protection-status', 'garage-protection-detail',
    'garage-protection-rear', 'garage-protection-front', 'garage-pipe-rear', 'garage-pipe-front', 'garage-reserve-rear',
    'garage-reserve-front', 'garage-pipe-rear-status', 'garage-pipe-front-status',
    'garage-protection-configured-label', 'garage-protection-reported-label', 'garage-protection-settings-status',
    ...['approved', 'marginC', 'pipeOutsideDiameterMm', 'pipeWallMm', 'heatTransferWPerM2K']
      .flatMap(key => [`garage-protection-configured-${key}`, `garage-protection-reported-${key}`])];
  const document = { addEventListener() {}, documentElement: { clientWidth: 390, clientHeight: 640 },
    defaultView: { addEventListener() {}, innerWidth: 390, innerHeight: 640 } };
  class Node {
    constructor() {
      Object.assign(this, { ownerDocument: document, ownText: '', value: '', checked: false, hidden: false,
        dataset: {}, style: {}, className: '', children: [], isConnected: true,
        attributes: new Map(), listeners: new Map(), classes: new Set() });
      this.classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key),
        toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) };
    }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.ownText = ''; this.children = children; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector === `#${child.id}` || child.className.split(' ').some(name => selector === `.${name}`)) return child;
        const nested = child.querySelector(selector); if (nested) return nested;
      }
      return null;
    }
    addEventListener(key, handler) { this.listeners.set(key, handler); }
    removeEventListener(key) { this.listeners.delete(key); }
    getBoundingClientRect() { return { left: 20, top: 20, right: 300, bottom: 50, width: 280, height: 30 }; }
    focus() { document.activeElement = this; }
  }
  const nodes = new Map(ids.map(id => [id, new Node()]));
  document.getElementById = id => nodes.get(id);
  document.createElement = () => new Node();
  document.body = new Node();
  for (const id of ['garage-mode-normal', 'garage-mode-away']) {
    const marker = new Node(); marker.className = 'heating-button-state'; nodes.get(id).append(marker);
  }
  const initial = { now, input: 'providers', garage: { mode: 'normal', normalTargetC: 10, awayTargetC: 5,
    requestedTargetC: 10, effectiveTargetC: 10, targetConfirmed: true, controlAvailable: true,
    protection: { available: false, active: false, status: 'unavailable' } } };
  const requests = [], busy = []; let response = initial;
  const panel = createGarageControls({ document, onBusy: value => busy.push(value),
    request: async (path, payload) => { requests.push([path, payload]); if (response instanceof Error) throw response; return response; } });
  panel.update(initial);
  return { nodes, initial, panel, requests, busy, reply(value) { response = value; },
    detailText(id) {
      nodes.get(id).querySelector('.status-detail-trigger').listeners.get('click')();
      return document.body.querySelector('.status-detail-body').textContent;
    },
    async trigger(id, kind = 'click') { nodes.get(id).listeners.get(kind)?.({ preventDefault() {} }); await new Promise(setImmediate); } };
}

test('manual Normal and Away send durable selections without lease, expiry, or native power commands', async () => {
  const f = fixture();
  assert.equal(f.nodes.get('garage-mode-normal').attributes.get('aria-pressed'), 'true');
  const away = { ...f.initial, garage: { ...f.initial.garage, mode: 'away', requestedTargetC: 5, targetConfirmed: false } };
  f.reply(away); await f.trigger('garage-mode-away');
  assert.deepEqual(f.requests, [['/api/garage/heating', { mode: 'away' }]]);
  assert.equal(f.nodes.get('garage-mode-away').attributes.get('aria-pressed'), 'true');
  assert.match(f.nodes.get('garage-heating-message').textContent, /Away selected.*Waiting for heat-pump controller confirmation/);
  f.panel.update({ ...away, now: now + 2 * day });
  assert.equal(f.nodes.get('garage-mode-away').attributes.get('aria-pressed'), 'true');
  assert.equal(f.nodes.get('garage-heating-message').textContent, '', 'The receipt expires without ending the durable selection');
  assert.deepEqual(f.busy, [true, false]);
  f.panel.close(); assert.equal(f.nodes.get('garage-mode-normal').listeners.has('click'), false);
});

test('selection feedback follows polled confirmation and marks recorded confirmation unavailable', async () => {
  const f = fixture(), message = f.nodes.get('garage-heating-message');
  const away = { ...f.initial, garage: { ...f.initial.garage, mode: 'away', requestedTargetC: 5, targetConfirmed: false } };
  f.reply(away); await f.trigger('garage-mode-away');
  assert.equal(message.textContent, 'Away selected · 5 °C. Waiting for heat-pump controller confirmation.');
  const confirmed = { ...away, garage: { ...away.garage, targetConfirmed: true } };
  f.panel.update(confirmed);
  assert.equal(message.textContent, 'Away selected · 5 °C. Confirmed by the heat-pump controller.');
  assert.equal(f.nodes.get('garage-target-confirmation').textContent, 'Confirmed by the heat-pump controller');
  f.panel.update(away);
  assert.equal(message.textContent, 'Away selected · 5 °C. Confirmed by the heat-pump controller.', 'A lost reading does not erase the receipt confirmation');
  f.panel.update({ ...confirmed, readOnly: true });
  assert.equal(message.textContent, 'Away selected · 5 °C. Recorded selection · live confirmation unavailable.');
  assert.equal(f.requests.length, 1, 'Status updates must not resend the selection');
});

test('polling preserves target validation and request errors after a successful selection', async () => {
  const f = fixture(), message = f.nodes.get('garage-heating-message');
  await f.trigger('garage-mode-normal');
  assert.match(message.textContent, /Confirmed by the heat-pump controller/);
  f.nodes.get('garage-normal-target').value = '8.1';
  await f.trigger('garage-normal-target', 'input'); await f.trigger('garage-target-form', 'submit');
  f.panel.update(f.initial);
  assert.equal(message.textContent, 'Choose a Normal target from 0 to 31 °C in 0.5 °C steps.');
  f.reply(new Error('The heat-pump controller is unavailable.'));
  await f.trigger('garage-mode-away');
  f.panel.update(f.initial);
  assert.equal(message.textContent, 'The heat-pump controller is unavailable.');
});

test('target edits preserve drafts during polling, select Normal explicitly, and validate half-degree bounds', async () => {
  const f = fixture(), input = f.nodes.get('garage-normal-target');
  input.value = '8.5'; await f.trigger('garage-normal-target', 'input');
  f.panel.update({ ...f.initial, garage: { ...f.initial.garage, normalTargetC: 9 } });
  assert.equal(input.value, '8.5');
  f.reply({ ...f.initial, garage: { ...f.initial.garage, normalTargetC: 8.5, requestedTargetC: 8.5 } });
  await f.trigger('garage-target-form', 'submit');
  assert.deepEqual(f.requests, [['/api/garage/heating', { mode: 'normal', targetC: 8.5 }]]);
  assert.equal(f.nodes.get('garage-target-submit').disabled, true);
  for (const invalid of ['', '-0.5', '31.5', '8.1']) {
    input.value = invalid; await f.trigger('garage-normal-target', 'input'); await f.trigger('garage-target-form', 'submit');
  }
  assert.equal(f.requests.length, 1); assert.match(f.nodes.get('garage-heating-message').textContent, /0 to 31/);
});

test('unavailable and read-only views cannot send a mode or target change', async () => {
  const f = fixture();
  for (const patch of [{ input: 'offline' }, { role: 'slave' }, { readOnly: true },
    { garage: { ...f.initial.garage, controlAvailable: false } }]) {
    f.panel.update({ ...f.initial, ...patch });
    assert.equal(f.nodes.get('garage-mode-away').disabled, true);
    await f.trigger('garage-mode-away');
  }
  assert.equal(f.requests.length, 0);
});

test('condensation warning is visible after warming and disappears only after the advisory period', () => {
  const f = fixture(), warmingWarning = { since: now, until: now + day, message: 'Avoid wet or snowy vehicles for roughly 24 hours, and longer while contents remain cold.' };
  const status = { ...f.initial, garage: { ...f.initial.garage, warmingWarning } };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-warming-warning').hidden, false);
  assert.match(f.nodes.get('garage-warming-warning').textContent, /wet or snowy/);
  assert.equal(garageHeatingWarning({ ...status, now: now + day }), '');
  assert.equal(garageHeatingWarning({ ...status, now: now - 1 }), '');
  f.panel.update({ ...status, now: now + day });
  assert.equal(f.nodes.get('garage-warming-warning').hidden, true);
  assert.equal(f.nodes.get('garage-mode-normal').disabled, false, 'An advisory is not a confirmation gate');
});

test('missing frost demand is unavailable and confirmed override leaves selected target distinct', () => {
  assert.equal(garageDisplay({ protection: { active: true } }).protection, 'Unavailable');
  const display = garageDisplay({ mode: 'away', requestedTargetC: 5, effectiveTargetC: 10,
    protection: { available: true, active: true } });
  assert.equal(display.mode, 'Away'); assert.equal(display.target, '5 °C'); assert.equal(display.effectiveTarget, '10 °C');
  assert.equal(display.protection, 'Heating override active');
  assert.match(display.protectionDetail, /choice remains saved/);
});

test('heating summary separates reported operation, effective target and independent protection', () => {
  const f = fixture();
  assert.equal(f.nodes.get('garage-heating-operation').textContent, 'Unknown');
  assert.equal(f.nodes.get('garage-protection-summary').textContent, 'Unavailable');
  const garage = { ...f.initial.garage, mode: 'away', requestedTargetC: 5, effectiveTargetC: 8,
    adapter: { connected: true, native: { readbacks: { mode: { value: 'heat', measuredAt: now } } },
      telemetry: { compressorActive: { value: false, sourceTime: now, supported: true, quality: [] } } },
    protection: { available: true, active: true } };
  f.panel.update({ ...f.initial, garage });
  assert.equal(f.nodes.get('garage-heating-operation').textContent, 'Idle', 'A reported idle compressor differs from an unknown one');
  assert.equal(f.nodes.get('garage-current-mode').textContent, 'Heat');
  assert.equal(f.nodes.get('garage-current-room').textContent, '8 °C');
  assert.equal(f.nodes.get('garage-protection-summary').textContent, 'Override active');
  assert.equal(f.nodes.get('garage-protection-status').textContent, 'Heating override active');
  assert.match(f.detailText('garage-current-room'), /Selected target: 5 °C.*freeze-protection minimum.*not measured room temperature/);
  assert.match(f.detailText('garage-protection-summary'), /choice remains saved/);
  f.panel.update({ ...f.initial, now: now + 120_000, garage: { ...garage, effectiveTargetC: null,
    protection: { available: true, active: false } } });
  assert.equal(f.nodes.get('garage-heating-operation').textContent, 'Unknown');
  assert.equal(f.nodes.get('garage-current-room').textContent, 'Unavailable');
  assert.equal(f.nodes.get('garage-protection-summary').textContent, 'Monitoring');
});

test('pipe estimates require fresh certain sender evidence and retain valid zero reserve', () => {
  const f = fixture(), protection = { available: true, active: true, sender: { available: true },
    locations: { rear: { airC: 0, estimatedC: 1, remainingKjPerM: 0 }, front: { airC: 2, estimatedC: 2, remainingKjPerM: 0.001 } } };
  const status = { ...f.initial, garage: { ...f.initial.garage, protection } };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-protection-rear').textContent, '0 °C');
  assert.equal(f.nodes.get('garage-reserve-rear').textContent, '0 kJ/m');
  assert.equal(f.nodes.get('garage-reserve-front').textContent, '<0.01 kJ/m');
  protection.locations.front.uncertain = true; f.panel.update(status);
  assert.equal(f.nodes.get('garage-pipe-front').textContent, 'Unavailable');
  protection.sender.available = false; f.panel.update(status);
  assert.equal(f.nodes.get('garage-reserve-rear').textContent, 'Unavailable');
});

test('protection configuration is read-only and remains distinct from absent or mismatched readback', () => {
  const f = fixture();
  const configuredSettings = { approved: false, version: 'garage-thermal-reserve-v1', marginC: 1,
    pipeOutsideDiameterMm: 21, pipeWallMm: 1, heatTransferWPerM2K: 20 };
  const protection = { configuredSettings, settings: null, configuration: { status: 'unknown' } };
  const status = { ...f.initial, garage: { ...f.initial.garage, protection } };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-protection-configured-approved').textContent, 'Not approved');
  assert.equal(f.nodes.get('garage-protection-configured-marginC').textContent, '1');
  assert.equal(f.nodes.get('garage-protection-reported-approved').textContent, 'Unavailable');
  assert.match(f.nodes.get('garage-protection-settings-status').textContent, /Waiting for fresh/);
  protection.settings = { ...configuredSettings, approved: true, marginC: 1.5 };
  protection.configuration = { status: 'mismatch', reason: 'The local protection unit reports different settings.' };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-protection-configured-marginC').textContent, '1');
  assert.equal(f.nodes.get('garage-protection-reported-marginC').textContent, '1.5');
  assert.equal(f.nodes.get('garage-protection-reported-approved').textContent, 'Approved');
  assert.equal(f.nodes.get('garage-protection-reported-marginC').classes.has('stale'), true);
  assert.match(f.nodes.get('garage-protection-settings-status').textContent, /different settings/);
  protection.settings = { ...configuredSettings };
  protection.configuration = { status: 'confirmed' };
  f.panel.update(status);
  assert.match(f.nodes.get('garage-protection-settings-status').textContent, /Configuration confirmed/);
  assert.equal(f.nodes.get('garage-protection-reported-marginC').classes.has('stale'), false);
  protection.settings = null; protection.configuration = { status: 'unknown' };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-protection-configured-pipeOutsideDiameterMm').textContent, '21');
  assert.equal(f.nodes.get('garage-protection-reported-pipeOutsideDiameterMm').textContent, 'Unavailable');
  assert.deepEqual(f.requests, [], 'Reading configuration or polling never sends a dashboard command');
});

test('Garage markup has durable controls and independent protection without retired automatic or model controls', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  const garage = html.slice(html.indexOf('<article id="garage-control"'), html.indexOf('id="garage-equipment-readings"'));
  for (const id of ['garage-mode-normal', 'garage-mode-away', 'garage-target-form', 'garage-protection-details', 'garage-protection-parameters'])
    assert(garage.includes(`id="${id}"`));
  assert.doesNotMatch(garage, /garage-(automation|pause|learning|release)|Automatic savings|Savings strategy|Temporary heating override/);
  assert.match(garage, /roughly 24 hours.*longer if contents are still cold/);
  assert.match(garage, /including across restarts/);
  const start = garage.indexOf('id="garage-protection-settings-details"');
  const parameters = garage.slice(start, garage.indexOf('</details>', start));
  assert.doesNotMatch(parameters, /<input|<select|<form|garage-protection-submit|api\/garage\/protection/);
  assert.match(parameters, /garage\.protection.*Apply configuration/);
});

test('Home savings values are unchanged and Garage only presents observed electrical timing', () => {
  const payload = { range, now, heatingBenefit: { status: 'estimated', valueEuro: 4.5, counts: { assessed: 3 } },
    timingBenefit: { heatPump: { value: -0.25, coverage: 0.1 } } };
  assert.equal(heatingScopeDisplay(payload).amount, heatingDisplay(payload.heatingBenefit, payload).amount);
  assert.equal(heatingScopeDisplay(payload, 'home', 'timing').amount, timingDisplay('heatPump', payload.timingBenefit.heatPump, payload).amount);
  const heatingSavings = buildHeatingSavings({ range, now, homeModel: payload.heatingBenefit,
    homeTiming: payload.timingBenefit.heatPump, garageTiming: { value: .5, sourceQuality: 'verified-electrical',
      coverageDetails: { elapsedMs: day, includedMs: 3600_000 }, evidence: { energyBasis: 'recorded-intervals',
        timeBasis: 'recorded-interval-time', sources: [{ key: 'measured', durationMs: 3600_000, share: 1 }] } } });
  assert.equal(heatingSavings.garage.model, undefined); assert.equal(heatingSavings.total.model, undefined);
  const display = heatingScopeDisplay({ range, now, heatingSavings }, 'garage', 'model');
  assert.equal(display.amount, '€0.50'); assert.match(display.energyExplanation, /does not attribute savings to Garage control/);
});

test('local regulation fallback remains visible while mode commands are still available', async () => {
  const f = fixture(), reason = 'Bluetooth room sensor is stale. The heat-pump controller is using its fallback target.';
  f.panel.update({ ...f.initial, garage: { ...f.initial.garage, regulationReason: reason } });
  assert.equal(f.nodes.get('garage-control-detail').textContent, reason);
  assert.equal(f.nodes.get('garage-mode-away').disabled, false);
  await f.trigger('garage-mode-away');
  assert.equal(f.requests.length, 1);
});


test('regulation input retains its own source and age separately from rear temperature', () => {
  const f = fixture(), garage = { ...f.initial.garage,
    adapter: { connected: true, observedAt: now - 30_000, control: { sensorTemperatureC: 0, sensorAgeMs: 160_000 } },
    observations: { rear: { value: 5, stale: true } },
    protection: { sender: { available: true }, locations: { rear: { airC: null, uncertain: true } } } };
  f.panel.update({ ...f.initial, garage });
  assert.equal(f.nodes.get('garage-regulation-temperature').textContent, 'Unavailable');
  assert.equal(f.nodes.get('garage-protection-rear').textContent, '5 °C · stale');
  assert.match(f.detailText('garage-regulation-temperature'), /different source than the Garage rear sensor.*not an independent room measurement.*190 seconds/);
  garage.adapter.control.sensorAgeMs = 140_000; f.panel.update({ ...f.initial, garage });
  assert.equal(f.nodes.get('garage-regulation-temperature').textContent, '0 °C');
  assert.equal(f.nodes.get('garage-regulation-reading').hidden, false);
  assert.equal(f.nodes.get('garage-readings-details').hidden, false);
  garage.adapter.control.sensorAgeMs = 150_000; f.panel.update({ ...f.initial, garage });
  assert.equal(f.nodes.get('garage-regulation-temperature').textContent, 'Unavailable', 'The 180-second boundary is unavailable');
});

test('never-observed regulation input is hidden and an observed input remains explained through lost readback', () => {
  const f = fixture();
  assert.equal(f.nodes.get('garage-regulation-reading').hidden, true);
  f.panel.update({ ...f.initial, garage: { ...f.initial.garage,
    adapter: { connected: true, observedAt: now, control: { sensorTemperatureC: 6, sensorAgeMs: 1000 } } } });
  f.panel.update({ ...f.initial, now: now + 30_000 });
  assert.equal(f.nodes.get('garage-regulation-reading').hidden, false);
  assert.equal(f.nodes.get('garage-regulation-temperature').textContent, 'Unavailable');
  assert.match(f.detailText('garage-regulation-temperature'), /Last reported input: 6 °C.*31 seconds.*not connected/);
});

test('a garage receipt records its own target and cannot masquerade as a newer selection', async () => {
  const f = fixture(), message = f.nodes.get('garage-heating-message');
  await f.trigger('garage-mode-normal');
  f.panel.update({ ...f.initial, now: now + 1_000, garage: { ...f.initial.garage,
    mode: 'away', requestedTargetC: 5 } });
  assert.match(message.textContent, /Normal selected · 10 °C. Selection superseded/);
  f.panel.update({ ...f.initial, now: now + 2_000 });
  assert.match(message.textContent, /Selection superseded/);
  f.panel.update({ ...f.initial, now: now + day });
  assert.equal(message.textContent, '');
});

test('recorded protection parameters cannot claim fresh confirmation', () => {
  const f = fixture();
  const configuredSettings = { approved: true, version: 'garage-thermal-reserve-v1', marginC: 1,
    pipeOutsideDiameterMm: 21, pipeWallMm: 1, heatTransferWPerM2K: 20 };
  const status = { ...f.initial, readOnly: true, garage: { ...f.initial.garage, protection: {
    configuredSettings, settings: configuredSettings, configuration: { status: 'confirmed' } } } };
  f.panel.update(status);
  assert.equal(f.nodes.get('garage-protection-configured-label').textContent, 'Recorded config');
  assert.equal(f.nodes.get('garage-protection-reported-label').textContent, 'Recorded unit');
  assert.equal(f.nodes.get('garage-protection-configured-approved').textContent, 'Approved');
  assert.match(f.nodes.get('garage-protection-settings-status').textContent, /Recorded settings; live confirmation is unavailable/);
  assert.deepEqual(f.requests, []);
});
