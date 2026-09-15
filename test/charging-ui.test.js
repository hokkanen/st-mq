import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chargerDisplay, chargingDisplay, chargingContext, chargingFields, sharedChargingFields, chargingTime, createChargingPanel } from '../chart/charging.js';
import { DEFAULT_CHARGING_SETTINGS } from '../src/charging/settings.js';

const now = Date.parse('2026-09-15T18:00:00Z'), startAt = now + 2 * 3600_000, deadlineAt = now + 9 * 3600_000;
const reading = (value, source = 'teslamate', extra = {}) => ({ value, source, available: value != null, ...extra });
function charger(id = 'charger1', patch = {}) {
  return { id, label: id === 'charger1' ? 'Charger 1' : 'Charger 2',
    settings: structuredClone(DEFAULT_CHARGING_SETTINGS.chargers[id]), capabilities: { scheduling: id === 'charger1', currentControl: false },
    values: { soc: reading(40, 'manual-fallback', { assumed: true }), minimumSoc: reading(80, 'manual-fallback'),
      capacityKwh: reading(id === 'charger1' ? 74 : 57, 'manual-fallback'), connected: reading(null) },
    requiredGridKwh: 32.888, ...patch };
}
const status = (...chargers) => ({ role: 'primary', now, charging: { settings: structuredClone(DEFAULT_CHARGING_SETTINGS),
  chargers: chargers.length ? chargers : [charger(), charger('charger2')] } });
const view = item => chargerDisplay(item, { now });

test('garage preserves cold budgets and renders charger objects before the heating equipment', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="home-heat-pump-title">Home<\/h3>/);
  assert.match(html, /id="garage-title">Garage<\/h3>/);
  assert.equal((html.match(/<span>Heating mode<\/span>/g) ?? []).length, 2);
  assert(!html.includes('home-tariff-status'));
  assert(html.indexOf('id="garage-budget-front"') < html.indexOf('id="charger1-summary"'));
  assert(html.indexOf('id="charging-devices"') < html.indexOf('id="garage-controller-details"'));
  assert(!html.includes('id="charger1-settings-form"'), 'Per-charger forms come from the same renderer');
});

test('settings expose the common preferences, with current, connection and schedules automatic only', () => {
  const keys = chargingFields.map(field => field.key);
  assert.deepEqual(keys, ['minimumSoc', 'readyBy', 'capacityKwh', 'efficiency', 'mqtt.topic', 'mqtt.vehicleId', 'mqtt.sourceId']);
  const shared = sharedChargingFields.map(field => field.key);
  for (const key of Object.keys(DEFAULT_CHARGING_SETTINGS.installation)) assert(shared.includes(`installation.${key}`));
  assert(!keys.some(key => /current|connected|scheduled/i.test(key)));
});

test('both chargers use the same display model, including energy while control is off', () => {
  const original = charger(), renamed = { ...original, id: 'another-charger', label: 'Another charger' };
  const first = view(original), second = view(renamed);
  assert.deepEqual({ ...first, id: second.id, label: second.label }, second);
  assert.equal(first.soc, '40 %'); assert.equal(first.socSource, 'Manual fallback'); assert.equal(first.gridEnergy, '32.9 kWh');
  assert.equal(chargingDisplay(status().charging, now).chargers.length, 2);
  assert.equal(view(charger('charger2')).event, 'Monitoring · scheduling unavailable');
});

test('old measured SoC and receipt-only SoC remain visibly distinct without telemetry field dumps', () => {
  const state = charger(), measuredAt = now - 120 * 86400_000;
  const measured = view({ ...state, values: { ...state.values, soc: reading(35, 'mqtt', { measuredAt, receivedAt: now }) } });
  assert.equal(Object.fromEntries(measured.rows)['Charge measured'], chargingTime(measuredAt));
  const received = view({ ...state, values: { ...state.values, soc: reading(35, 'teslamate', { measuredAt: null, receivedAt: now }) },
    telemetry: { fields: { geofence: { value: 'Not user-facing metadata' }, charge_current_request: { value: 13 } } } });
  assert.match(Object.fromEntries(received.rows)['Charge received'], /measurement time unknown/);
  assert(!JSON.stringify(received).includes('Not user-facing metadata'));
});

test('manual override expiration and unavailable charge are honest in the compact and detailed views', () => {
  const item = charger(), manual = view({ ...item, values: { ...item.values, soc: reading(43, 'manual', { expiresAt: deadlineAt }) } });
  assert.equal(manual.socSource, 'Temporary manual value');
  assert.equal(Object.fromEntries(manual.rows)['Manual value expires'], chargingTime(deadlineAt));
  const missing = view({ ...item, values: { ...item.values, soc: reading(0, 'assumed', { available: false, assumed: true }) } });
  assert.equal(missing.soc, 'Unknown'); assert.match(missing.socSource, /Assumes 0%/);
});

test('proposed and confirmed starts remain separate through a schedule revision', () => {
  const item = charger(), state = { ...item, settings: { ...item.settings, enabled: true },
    plan: { startAt, finishAt: deadlineAt, deadlineAt }, control: { phase: 'unconfirmed' } };
  assert.match(view(state).event, /^Proposed start/);
  assert.match(view({ ...state, control: { phase: 'waiting', owned: { startAt } } }).event, /^Starts/);
  const revised = view({ ...state, plan: { ...state.plan, startAt: startAt + 3600_000 }, control: { phase: 'waiting', owned: { startAt } } });
  assert.match(revised.event, /^Starts .*23:00.*revision pending$/);
  assert.equal(Object.fromEntries(revised.rows)['Confirmed start'], chargingTime(startAt));
  assert.match(Object.fromEntries(revised.rows)['Proposed start'], /awaiting confirmation$/);
});

test('charging emphasizes live power; planned minimum never appears as an enforced stopping time', () => {
  const item = charger('charger2');
  const displayed = view({ ...item, values: { ...item.values, connected: reading(true), charging: reading(true), powerKw: reading(8.2),
    scheduledEndAt: reading(deadlineAt) }, telemetry: { scheduledEndKind: 'estimated' }, forecast: { finishAt: deadlineAt } });
  assert.equal(displayed.state, 'Charging'); assert.match(displayed.event, /^8.2 kW now/);
  const rows = Object.fromEntries(displayed.rows);
  assert.match(rows['Estimated minimum reached'], /charging may continue/);
  assert.match(rows['Estimated charging end'], /estimate only/); assert(!rows['Scheduled stopping time']);
  const enforced = view({ ...item, values: { ...item.values, scheduledEndAt: reading(deadlineAt) }, telemetry: { scheduledEndKind: 'scheduled-stop' } });
  assert.equal(Object.fromEntries(enforced.rows)['Scheduled stopping time'], chargingTime(deadlineAt));
});

test('released charging uses the live remaining forecast while retaining its original plan start', () => {
  const item = charger(), earlierFinish = deadlineAt - 3600_000;
  const displayed = view({ ...item, settings: { ...item.settings, enabled: true },
    values: { ...item.values, connected: reading(true), charging: reading(true), powerKw: reading(8.2) },
    control: { phase: 'released' }, plan: { startAt, finishAt: deadlineAt }, forecast: { finishAt: earlierFinish } });
  const rows = Object.fromEntries(displayed.rows);
  assert.equal(rows['Plan start'], chargingTime(startAt));
  assert.equal(rows['Estimated minimum reached'], `${chargingTime(earlierFinish)} · charging may continue`);
});

test('manual priority, uncertain ownership, and unconfirmed handover have distinct summaries', () => {
  const item = charger(), state = { ...item, settings: { ...item.settings, enabled: true }, plan: { startAt, finishAt: deadlineAt } };
  const manual = view({ ...state, control: { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, resumeAt: deadlineAt, repeating: true } } });
  assert.equal(manual.state, 'Manual control'); assert.match(manual.event, /^ST-MQ resumes/);
  assert.equal(Object.fromEntries(manual.rows)['Manual stopping time'], chargingTime(deadlineAt));
  assert.match(Object.fromEntries(manual.rows)['Repeating charger schedule'], /temporary override/);
  const uncertain = view({ ...state, control: { phase: 'uncertain', reason: 'The charger schedule could not be identified.' } });
  assert.equal(uncertain.state, 'Ownership uncertain');
  assert.equal(Object.fromEntries(uncertain.rows)['Control status'], 'The charger schedule could not be identified.');
  assert.equal(view({ ...item, control: { phase: 'off', handoverConfirmed: false } }).state, 'Handover unconfirmed');
  assert.equal(view({ ...state, control: { phase: 'released' } }).event, 'Charging released · may continue');
});

test('a vehicle charging away is not shown as charging at the property', () => {
  const item = charger('charger2'), away = { ...item, values: { ...item.values, connected: reading(false),
    charging: reading(true), powerKw: reading(8.2), scheduledStartAt: reading(startAt) } };
  const displayed = view(away);
  assert.equal(displayed.state, 'Not connected'); assert.equal(displayed.event, 'Monitoring · scheduling unavailable');
  assert(!Object.fromEntries(displayed.rows)['Measured charging power']);
  assert.equal(chargingContext(status(away).charging, now), '');
});

test('operating context mentions only charging or a concrete upcoming event', () => {
  const item = charger('charger2'), scheduled = { ...item, values: { ...item.values, connected: reading(true), scheduledStartAt: reading(startAt) } };
  assert.equal(chargingContext(status().charging, now), '');
  assert.match(chargingContext(status(scheduled).charging, now), /^Charger 2: Scheduled/);
  assert(!chargingContext(status(scheduled).charging, now).includes('read-only'));
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

test('identical forms adapt to capabilities and automatic values, while OFF can be configured before enabling', () => {
  const document = documentFixture(), panel = createChargingPanel({ document, request: async () => {} }), $ = id => document.getElementById(id);
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, minimumSoc: reading(85) } }));
  assert.equal($('charger1-setting-minimumSoc').value, 80); assert(!$('charger1-setting-minimumSoc').disabled);
  assert(!$('charger1-setting-readyBy').disabled); assert($('charger2-setting-readyBy').disabled);
  assert.equal($('charger2-setting-minimumSoc').value, 85); assert($('charger2-setting-minimumSoc').disabled);
  assert.match($('charger2-setting-minimumSoc-help').textContent, /Saved fallback: 80%/);
  assert(!$('charger2-setting-capacityKwh').disabled); assert($('charger2-enabled').disabled);
  assert.equal($('charger1-manual-soc').value, 40); assert.equal($('charger2-manual-soc').value, 40);
  const original = $('charger2-device'); panel.update(status()); assert.equal($('charger2-device'), original);
  assert.equal($('charger2-setting-minimumSoc').value, 80); assert(!$('charger2-setting-minimumSoc').disabled);
  panel.update({ ...status(), role: 'replica' }); assert($('charger1-enabled').disabled); assert($('charger2-manual-soc').disabled);
  panel.close(); assert(!$('charger1-enabled').listeners.has('click'));
});

test('refresh preserves edits and sends only changed nested shared settings, serializing mutations', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let resolve;
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); } });
  panel.update(status()); const field = $('charging-setting-installation-mainFuseA'); field.value = '25'; field.listeners.get('input')();
  panel.update(status()); assert.equal(field.value, '25'); const pending = submit($('charging-installation-form'));
  assert.deepEqual(calls, [['/api/charging/settings', { installation: { mainFuseA: 25 } }]]);
  assert($('charger1-enabled').disabled); await $('charger1-enabled').listeners.get('click')(); assert.equal(calls.length, 1);
  const updated = status(); updated.charging.settings.installation.mainFuseA = 25; resolve(updated); await pending;
  assert.equal(field.value, 25); assert($('charging-installation-save').disabled); panel.close();
});

test('each charger saves its own fallback and SoC actions without changing another charger', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]);
    const two = charger('charger2'); return status(charger(), { ...two, values: { ...two.values,
      soc: reading(payload.action === 'automatic' ? 51 : 42, payload.action === 'automatic' ? 'teslamate' : 'manual', { expiresAt: deadlineAt }) } }); } });
  panel.update(status()); const capacity = $('charger2-setting-capacityKwh'); capacity.value = '59'; capacity.listeners.get('input')();
  await submit($('charger2-settings-form')); $('charger2-manual-soc').value = '42'; await submit($('charger2-soc-form'));
  assert(!$('charger2-soc-automatic').disabled); assert.equal($('charger1-enabled').textContent, 'OFF');
  await $('charger2-soc-automatic').listeners.get('click')();
  assert.deepEqual(calls, [['/api/charging/chargers/charger2/settings', { capacityKwh: 59 }],
    ['/api/charging/chargers/charger2/soc', { soc: 42 }], ['/api/charging/chargers/charger2/soc', { action: 'automatic' }]]);
  panel.close();
});

test('a nested read-only charging snapshot locks all mutations even without a replica role', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  const snapshot = status(); snapshot.charging.readOnly = true; panel.update(snapshot);
  for (const id of ['charger1-enabled', 'charger1-manual-soc', 'charger2-manual-soc', 'charger1-setting-capacityKwh',
    'charger2-setting-capacityKwh', 'charging-setting-installation-mainFuseA']) assert($(id).disabled, id);
  await $('charger1-enabled').listeners.get('click')(); await submit($('charger1-soc-form'));
  assert.deepEqual(calls, []);
  assert(![...document.nodes.keys()].some(id => /-setting-.*(?:current|connected|scheduled)/i.test(id)));
  panel.close();
});

test('a shared planning error stays visible and clears on recovery', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const failed = status(); failed.charging.error = 'charging-planning-unavailable'; panel.update(failed);
  assert(!$('charging-status').hidden); assert.match($('charging-status').textContent, /shared charging plan could not be updated/);
  panel.update(status()); assert($('charging-status').hidden); assert.equal($('charging-status').textContent, '');
  panel.close();
});

test('new automatic values take display priority while preserving an unfinished fallback edit', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  panel.update(status()); const field = $('charger2-setting-minimumSoc'); field.value = '75'; field.listeners.get('input')();
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, minimumSoc: reading(85) } }));
  assert.equal(field.value, 85); assert(field.disabled);
  panel.update(status()); assert.equal(field.value, '75'); assert(!field.disabled); assert(!$('charger2-settings-save').disabled);
  panel.close();
});
