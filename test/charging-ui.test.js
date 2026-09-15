import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chargerDisplay, chargingDisplay, chargingContext, chargingFields, chargingTime, createChargingPanel } from '../chart/charging.js';
import { DEFAULT_CHARGING_SETTINGS } from '../src/charging/settings.js';

const now = Date.parse('2026-09-15T18:00:00Z'), startAt = now + 2 * 3600_000, deadlineAt = now + 9 * 3600_000;
const reading = (value, source = 'teslamate', extra = {}) => ({ value, source, available: value != null, ...extra });
function charger(id = 'charger1', patch = {}) {
  return { id, label: id === 'charger1' ? 'Charger 1' : 'Charger 2',
    settings: structuredClone(DEFAULT_CHARGING_SETTINGS.chargers[id]), capabilities: { scheduling: id === 'charger1', currentControl: false },
    values: { soc: reading(40, 'manual-fallback'), minimumSoc: reading(80, 'manual-fallback'),
      capacityKwh: reading(id === 'charger1' ? 74 : 57, 'manual-fallback'), connected: reading(null) },
    requiredGridKwh: 32.888, ...patch };
}
const status = (...chargers) => ({ role: 'primary', now, charging: { settings: structuredClone(DEFAULT_CHARGING_SETTINGS),
  timezone: 'Europe/Helsinki', chargers: chargers.length ? chargers : [charger(), charger('charger2')] } });
const view = item => chargerDisplay(item, { now });
const active = () => { const item = charger(); return { ...item, settings: { ...item.settings, enabled: true },
  values: { ...item.values, connected: reading(true) }, plan: { startAt, finishAt: deadlineAt, deadlineAt } }; };

test('garage preserves cold budgets and renders shared charger cards without installation settings', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="home-heat-pump-title">Home<\/h3>/);
  assert.match(html, /id="garage-title">Garage<\/h3>/);
  assert.equal((html.match(/<span>Heating mode<\/span>/g) ?? []).length, 2);
  assert(!html.includes('home-tariff-status'));
  assert(html.indexOf('id="garage-budget-front"') < html.indexOf('id="charger1-summary"'));
  assert(html.indexOf('id="charging-devices"') < html.indexOf('id="garage-controller-details"'));
  assert(!html.includes('id="charger1-settings-form"'), 'Per-charger forms come from the same renderer');
  assert(!html.includes('charging-installation'));
});

test('only local charger preferences are editable, with SoC following the same fallback field pattern', () => {
  assert.deepEqual(chargingFields.map(field => field.key), ['manualSoc', 'minimumSoc', 'readyBy', 'capacityKwh']);
  assert.equal(chargingFields.find(field => field.key === 'manualSoc').reading, 'soc');
  assert(chargingFields.find(field => field.key === 'manualSoc').automatic);
});

test('both chargers use the same compact model and retain useful energy information with control off', () => {
  const original = charger(), renamed = { ...original, id: 'another-charger', label: 'Another charger' };
  const first = view(original), second = view(renamed);
  assert.deepEqual({ ...first, id: second.id, label: second.label }, second);
  assert.equal(first.soc, '40 %'); assert.equal(first.socSource, 'Manual fallback'); assert.equal(first.gridEnergy, '32.9 kWh');
  assert.equal(chargingDisplay(status().charging, now).chargers.length, 2);
  assert.equal(view(charger('charger2')).event, 'Monitoring');
  assert(!first.rows.some(([label]) => ['Current charge', 'Minimum charge', 'Grid energy to minimum'].includes(label)), 'Do not repeat overview metrics');
});

test('times use the application timezone with concise calendar dates across DST', () => {
  assert.equal(chargingTime(startAt, 'Europe/Helsinki', now), '23:00');
  assert.equal(chargingTime(deadlineAt, 'Europe/Helsinki', now), 'tomorrow 06:00');
  assert.equal(chargingTime(now + 3 * 86400_000, 'Europe/Helsinki', now), '18 Sept 21:00');
  const autumn = Date.parse('2026-10-24T22:30:00Z');
  assert.equal(chargingTime(Date.parse('2026-10-25T22:15:00Z'), 'Europe/Helsinki', autumn), 'tomorrow 00:15');
  const item = active(), input = status(item).charging; input.timezone = 'UTC';
  assert.match(chargingDisplay(input, now).chargers[0].event, /20:00/);
});

test('one charge reading row distinguishes original measurements from receipt time', () => {
  const state = charger(), measuredAt = now - 120 * 86400_000;
  const measured = view({ ...state, values: { ...state.values, soc: reading(35, 'mqtt', { measuredAt, receivedAt: now }) } });
  assert.equal(Object.fromEntries(measured.rows)['Charge reading'], `Measured ${chargingTime(measuredAt, 'Europe/Helsinki', now)}`);
  const received = view({ ...state, values: { ...state.values, soc: reading(35, 'teslamate', { measuredAt: null, receivedAt: now }) },
    telemetry: { fields: { geofence: { value: 'Not user-facing metadata' }, charge_current_request: { value: 13 } } } });
  assert.match(Object.fromEntries(received.rows)['Charge reading'], /Received 21:00 · measurement time unknown/);
  assert(!JSON.stringify(received).includes('Not user-facing metadata'));
});

test('confirmed and proposed starts are distinguished without repeating schedule rows', () => {
  const state = active();
  assert.equal(view({ ...state, control: { phase: 'unconfirmed' } }).event, 'Proposed start 23:00');
  assert.equal(view({ ...state, control: { phase: 'waiting', owned: { startAt } } }).event, 'Starts 23:00');
  const revised = view({ ...state, plan: { ...state.plan, startAt: startAt + 3600_000 }, control: { phase: 'waiting', owned: { startAt } } });
  assert.equal(revised.event, 'Starts 23:00 · update awaiting confirmation');
  assert(!revised.rows.some(([label]) => /start/i.test(label)));
  assert.equal(Object.fromEntries(revised.rows)['Ready by'], 'tomorrow 06:00');
});

test('charging shows live power and remaining completion estimate without stale planned timestamps', () => {
  const item = active(), earlierFinish = deadlineAt - 3600_000;
  const displayed = view({ ...item, values: { ...item.values, charging: reading(true), powerKw: reading(8.2),
    scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) }, control: { phase: 'released' }, forecast: { finishAt: earlierFinish } });
  assert.equal(displayed.state, 'Charging'); assert.equal(displayed.event, '8.2 kW now · minimum estimated tomorrow 05:00');
  assert(!displayed.rows.some(([label]) => /start|minimum reached|ready by|end|stopping|power/i.test(label)));
  assert(!JSON.stringify(displayed.rows).includes('23:00'));
  const met = view({ ...item, requiredGridKwh: 0, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.match(met.event, /minimum reached$/);
});

test('a manual window is shown once, suppressing native duplicates and inactive automatic plans', () => {
  const item = active(), control = { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, resumeAt: deadlineAt, repeating: true } };
  const displayed = view({ ...item, control, values: { ...item.values, scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) },
    telemetry: { scheduledEndKind: 'scheduled-stop' } });
  assert.equal(displayed.state, 'Manual control');
  assert.equal(displayed.event, 'Easee window 23:00–tomorrow 06:00 · ST-MQ resumes afterwards');
  assert.equal(displayed.eventKind, 'manual');
  assert(!displayed.rows.some(([label]) => /start|ready|window|end|resume/i.test(label)));
  assert.match(displayed.controlDetail, /recurring Easee schedule/);
  const charging = view({ ...item, control, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.equal(charging.event, '8.2 kW now · Easee window ends tomorrow 06:00 · ST-MQ resumes afterwards');
});

test('faults and failed confirmation show actionable control status without claiming manual takeover', () => {
  const item = active();
  for (const phase of ['unavailable', 'unconfirmed']) {
    const result = view({ ...item, control: { phase, errorCode: 'read-failed', reason: 'Easee did not respond. The last schedule is unchanged.' } });
    assert.equal(result.state, 'Control unavailable'); assert.match(result.event, /^Easee did not respond/);
    assert.equal(result.yielded, false); assert(!result.event.includes('Proposed')); assert.equal(result.eventAt, null);
  }
  assert.equal(view({ ...charger(), control: { phase: 'off', handoverConfirmed: false } }).state, 'Handover unconfirmed');
});

test('off and disconnected cards omit stale automatic plans and manual priority', () => {
  const item = active(), manual = { kind: 'window', startsAt: startAt, resumeAt: deadlineAt };
  for (const patch of [{ settings: { ...item.settings, enabled: false } }, { values: { ...item.values, connected: reading(false) } }]) {
    const result = view({ ...item, control: { phase: 'yielded', manual }, ...patch });
    assert(!result.event.includes('Proposed')); assert(!result.event.includes('resumes')); assert.equal(result.eventAt, null);
    assert.equal(result.yielded, false); assert(!result.rows.some(([label]) => /ready|start|window/i.test(label)));
  }
});

test('a read-only charger shows one verified native window while connected', () => {
  const item = charger('charger2'), scheduled = { ...item, values: { ...item.values, connected: reading(true),
    scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) }, telemetry: { scheduledEndKind: 'scheduled-stop' } };
  assert.equal(view(scheduled).event, 'Scheduled 23:00–tomorrow 06:00');
  assert.equal(chargingContext(status(scheduled).charging, now), 'Charger 2: Scheduled 23:00–tomorrow 06:00.');
  const away = { ...scheduled, values: { ...scheduled.values, connected: reading(false), charging: reading(true), powerKw: reading(8.2) } };
  assert.equal(view(away).state, 'Not connected'); assert.equal(view(away).event, 'Monitoring');
  assert.equal(chargingContext(status(away).charging, now), '');
  const tomorrow = { ...scheduled, values: { ...scheduled.values, scheduledStartAt: reading(deadlineAt), scheduledEndAt: reading(deadlineAt + 3600_000) } };
  assert.equal(view(tomorrow).event, 'Scheduled tomorrow 06:00–07:00');
  const charging = { ...scheduled, values: { ...scheduled.values, charging: reading(true), powerKw: reading(8.2) } };
  assert.equal(view(charging).event, '8.2 kW now · scheduled until tomorrow 06:00');
});

test('automatic source hints replace repeated fallback assumptions in the fold', () => {
  const item = active(), result = view({ ...item, plan: { ...item.plan, warnings: [
    'Charger 1: usable battery capacity uses the manual fallback.',
    'Charger 1: the remembered manual battery percentage is used until vehicle telemetry is available.',
    'Electricity prices are unavailable.',
  ] } });
  assert.deepEqual(result.notes, ['Electricity prices are unavailable.']);
});

class Node {
  constructor(document) { this.document = document; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.disabled = false;
    this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(key, value) { this.listeners.set(key, value); }
  removeEventListener(key) { this.listeners.delete(key); }
  reportValidity() { return true; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
}
function documentFixture() {
  const document = { nodes: new Map(), createElement: () => new Node(document), createDocumentFragment: () => new Node(document), getElementById(id) { return this.nodes.get(id); } };
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/id="((?:charging|charger)[^"]+)"/g)) { const node = document.createElement(); node.id = match[1]; }
  return document;
}
const submit = node => node.listeners.get('submit')({ preventDefault() {} });

test('identical forms adapt to capabilities and automatic values, with no shared or connection setup', () => {
  const document = documentFixture(), panel = createChargingPanel({ document, request: async () => {} }), $ = id => document.getElementById(id);
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, minimumSoc: reading(85), soc: reading(62) } }));
  assert.equal($('charger1-setting-minimumSoc').value, 80); assert(!$('charger1-setting-minimumSoc').disabled);
  assert(!$('charger1-setting-readyBy').disabled); assert($('charger2-setting-readyBy').disabled);
  assert.equal($('charger2-setting-minimumSoc').value, 85); assert($('charger2-setting-minimumSoc').disabled);
  assert.equal($('charger2-setting-manualSoc').value, 62); assert($('charger2-setting-manualSoc').disabled);
  assert.match($('charger2-setting-minimumSoc-help').textContent, /Saved fallback: 80%/);
  assert.match($('charger2-setting-manualSoc-help').textContent, /Saved fallback: 40%/);
  assert(!$('charger2-setting-capacityKwh').disabled); assert($('charger2-enabled').disabled);
  assert.equal($('charger1-setting-manualSoc').value, 40);
  const original = $('charger2-device'); panel.update(status()); assert.equal($('charger2-device'), original);
  assert.equal($('charger2-setting-manualSoc').value, 40); assert(!$('charger2-setting-manualSoc').disabled);
  panel.update({ ...status(), role: 'replica' }); assert($('charger1-enabled').disabled); assert($('charger2-setting-manualSoc').disabled);
  assert(![...document.nodes.keys()].some(id => /installation|mqtt|efficiency|soc-form|soc-automatic/.test(id)));
  panel.close(); assert(!$('charger1-enabled').listeners.has('click'));
});

test('refresh preserves a fallback edit and serializes mutations', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let resolve;
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); } });
  panel.update(status()); const field = $('charger1-setting-manualSoc'); field.value = '45'; field.listeners.get('input')();
  panel.update(status()); assert.equal(field.value, '45'); const pending = submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', { manualSoc: 45 }]]);
  assert($('charger1-enabled').disabled); await $('charger1-enabled').listeners.get('click')(); assert.equal(calls.length, 1);
  const updated = status(); updated.charging.chargers[0].settings.manualSoc = 45; resolve(updated); await pending;
  assert.equal(field.value, 45); assert($('charger1-settings-save').disabled); panel.close();
});

test('each charger saves its own SoC fallback and capacity through the same settings form', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]);
    const two = charger('charger2'); return status(charger(), { ...two, settings: { ...two.settings, ...payload } }); } });
  panel.update(status());
  for (const [key, value] of [['capacityKwh', '59'], ['manualSoc', '42']]) {
    const field = $(`charger2-setting-${key}`); field.value = value; field.listeners.get('input')();
  }
  await submit($('charger2-settings-form'));
  assert.equal($('charger1-enabled').textContent, 'OFF'); assert.equal($('charger1-setting-manualSoc').value, 40);
  assert.deepEqual(calls, [['/api/charging/chargers/charger2/settings', { manualSoc: 42, capacityKwh: 59 }]]);
  panel.close();
});

test('a nested read-only charging snapshot locks every mutation even without a replica role', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  const snapshot = status(); snapshot.charging.readOnly = true; panel.update(snapshot);
  for (const id of ['charger1-enabled', 'charger1-setting-manualSoc', 'charger2-setting-manualSoc', 'charger1-setting-capacityKwh',
    'charger2-setting-capacityKwh']) assert($(id).disabled, id);
  await $('charger1-enabled').listeners.get('click')(); await submit($('charger1-settings-form'));
  assert.deepEqual(calls, []);
  assert(![...document.nodes.keys()].some(id => /-setting-.*(?:current|connected|scheduled)/i.test(id)));
  panel.close();
});

test('a planning error stays visible and clears on recovery', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const failed = status(); failed.charging.error = 'charging-planning-unavailable'; panel.update(failed);
  assert(!$('charging-status').hidden); assert.match($('charging-status').textContent, /charging plan could not be updated/);
  panel.update(status()); assert($('charging-status').hidden); assert.equal($('charging-status').textContent, '');
  panel.close();
});

test('automatic SoC takes priority while preserving a draft to use when automatic readings are unavailable', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  panel.update(status()); const field = $('charger2-setting-manualSoc'); field.value = '75'; field.listeners.get('input')();
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, soc: reading(85) } }));
  assert.equal(field.value, 85); assert(field.disabled);
  await submit($('charger2-settings-form')); assert.deepEqual(calls, []);
  panel.update(status()); assert.equal(field.value, '75'); assert(!field.disabled); assert(!$('charger2-settings-save').disabled);
  panel.close();
});
