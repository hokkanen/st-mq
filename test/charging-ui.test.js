import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chargingDisplay, chargingContext, chargingFields, chargingTime, createChargingPanel } from '../chart/charging.js';
import { DEFAULT_CHARGING_SETTINGS } from '../src/charging/settings.js';

const now = Date.parse('2026-09-15T18:00:00Z'), startAt = now + 2 * 3600_000, deadlineAt = now + 9 * 3600_000;
const status = patch => ({ role: 'primary', now, charging: { settings: structuredClone(DEFAULT_CHARGING_SETTINGS),
  soc: { soc: 0, source: 'assumed', assumed: true }, ...patch } });

test('garage keeps one compact charger pair below cold budgets and charger equipment first', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="home-heat-pump-title">Home<\/h3>/);
  assert.match(html, /id="garage-title">Garage<\/h3>/);
  assert.equal((html.match(/<span>Heating mode<\/span>/g) ?? []).length, 2);
  assert(!html.includes('home-tariff-status')); assert(!html.includes('garage-freezing-protection'));
  assert(html.indexOf('id="garage-budget-rear"') < html.indexOf('id="garage-budget-front"'));
  assert(html.indexOf('id="garage-budget-front"') < html.indexOf('id="charger1-summary"'));
  assert(html.indexOf('id="charger1-summary"') < html.indexOf('id="charger2-summary"'));
  const equipment = html.slice(html.indexOf('id="garage-equipment-section"'));
  assert(equipment.indexOf('id="charger1-device"') < equipment.indexOf('id="charger2-device"'));
  assert(equipment.indexOf('id="charger2-device"') < equipment.indexOf('id="garage-controller-details"'));
});

test('every persisted charging preference has a UI field or dedicated control with matching first-use defaults', () => {
  const settings = DEFAULT_CHARGING_SETTINGS, descriptors = new Map(chargingFields.map(field => [field.key, field]));
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'enabled' || key === 'manualSoc') continue;
    for (const [path, expected] of key === 'installation' ? Object.entries(value).map(([name, v]) => [`installation.${name}`, v]) : [[key, value]]) {
      assert(descriptors.has(path), `UI exposes ${path}`); assert.equal(descriptors.get(path).value, expected);
    }
  }
  assert(!chargingFields.some(field => /selected.*current/i.test(field.label)));
});

test('missing SoC stays unknown; an old MQTT reading keeps its measurement date without delivery substitution', () => {
  const missing = Object.fromEntries(chargingDisplay(status().charging, now).rows1);
  assert.equal(missing['Current charge'], 'Unknown · planning assumes 0%');
  const oldAt = now - 120 * 86400_000;
  const mqtt = Object.fromEntries(chargingDisplay(status({ soc: { soc: 35, source: 'mqtt', measuredAt: oldAt, receivedAt: now } }).charging, now).rows1);
  assert.equal(mqtt['Current charge'], '35 % · MQTT'); assert.equal(mqtt.Measured, chargingTime(oldAt));
  assert.match(mqtt['MQTT reading policy'], /regardless of age/);
  const unknownTime = Object.fromEntries(chargingDisplay(status({ soc: { soc: 35, source: 'mqtt', measuredAt: null, receivedAt: now } }).charging, now).rows1);
  assert.equal(unknownTime.Measured, 'Time unknown');
});

test('manual percentage, original MQTT reading and fixed expiration remain distinct', () => {
  const state = status({ soc: { soc: 40, source: 'manual', enteredAt: now, expiresAt: deadlineAt },
    automaticSoc: { soc: 63, measuredAt: now - 86400_000 } }).charging;
  const rows = Object.fromEntries(chargingDisplay(state, now).rows1);
  assert.equal(rows['Current charge'], '40 % · manual');
  assert.equal(rows['Manual value expires'], chargingTime(deadlineAt));
  assert.match(rows['Latest MQTT charge'], /^63 % · measured/);
});

test('unconfirmed plans, released charging and uncertain ownership are never claimed as a manual schedule', () => {
  const state = status({ settings: { ...DEFAULT_CHARGING_SETTINGS, enabled: true }, plan: { startAt, deadlineAt, finishAt: deadlineAt - 1000, feasible: true },
    control: { phase: 'unconfirmed' } }).charging;
  assert.match(chargingDisplay(state, now).summary1, /^Proposed start/);
  assert.match(chargingDisplay({ ...state, control: { phase: 'waiting', owned: { startAt } } }, now).summary1, /^Starts/);
  assert.equal(chargingDisplay({ ...state, control: { phase: 'released' } }, now).summary1, 'Charging released · may continue');
  const uncertain = chargingDisplay({ ...state, control: { phase: 'uncertain' } }, now);
  assert.match(uncertain.summary1, /^Ownership uncertain/); assert(!uncertain.summary1.includes('Manual'));
  assert.match(chargingDisplay({ ...state, settings: { ...state.settings, enabled: false }, control: { phase: 'off', handoverConfirmed: false } }, now).summary1, /OFF · handover unconfirmed/);
});

test('a revised plan never inherits confirmation from the previously installed Easee start', () => {
  const revisedStart = startAt + 3600_000;
  const state = status({ settings: { ...DEFAULT_CHARGING_SETTINGS, enabled: true },
    control: { phase: 'waiting', owned: { startAt, confirmedAt: now } },
    plan: { startAt: revisedStart, finishAt: deadlineAt - 1000, deadlineAt } }).charging;
  const view = chargingDisplay(state, now), rows = Object.fromEntries(view.rows1);
  assert.match(view.summary1, /^Starts .*23:00.*revision pending$/);
  assert(!view.summary1.includes('00:00'));
  assert.equal(rows['Confirmed start'], chargingTime(startAt));
  assert.equal(rows['Proposed start'], `${chargingTime(revisedStart)} · pending Easee confirmation`);
  assert.match(rows['Proposed minimum estimate'], /charging may continue/);
  const reconciled = chargingDisplay({ ...state, control: { phase: 'waiting', owned: { startAt: revisedStart } } }, now);
  assert(!reconciled.summary1.includes('revision pending'));
  assert.equal(Object.fromEntries(reconciled.rows1)['Confirmed start'], chargingTime(revisedStart));
  assert(!Object.fromEntries(reconciled.rows1)['Proposed start']);
  assert.match(chargingDisplay({ ...state, control: { phase: 'waiting' } }, now).summary1, /^Proposed start/);
});

test('MQTT subscription failures, rejected readings and planning errors stay visible beside accepted telemetry', () => {
  const state = status({ soc: { soc: 51, source: 'mqtt', measuredAt: now - 86400_000 },
    mqtt: { connected: true, subscribed: true, reason: 'invalid-soc' }, error: 'charging-planning-unavailable' }).charging;
  const rows = Object.fromEntries(chargingDisplay(state, now).rows1);
  assert.equal(rows['Current charge'], '51 % · MQTT');
  assert.equal(rows['Vehicle MQTT'], 'Connected · subscribed');
  assert.equal(rows['MQTT status'], 'Reading rejected: charge must be between 0% and 100%');
  assert.equal(rows['Charging error'], 'Could not update the charging forecast');
  const failed = Object.fromEntries(chargingDisplay({ ...state,
    mqtt: { connected: true, subscribed: false, reason: 'mqtt-subscription-failed' } }, now).rows1);
  assert.equal(failed['Vehicle MQTT'], 'Connected · not subscribed'); assert.equal(failed['MQTT status'], 'Topic subscription failed');
  assert.equal(Object.fromEntries(chargingDisplay({ ...state, mqtt: { connected: false, subscribed: false } }, now).rows1)['Vehicle MQTT'], 'Disconnected · not subscribed');
});

test('bounded manual stop and resume are distinct from estimates, with recurring policy visible', () => {
  const view = chargingDisplay(status({ settings: { ...DEFAULT_CHARGING_SETTINGS, enabled: true }, plan: { startAt, finishAt: deadlineAt },
    control: { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, resumeAt: deadlineAt, repeating: true } } }).charging, now);
  const rows = Object.fromEntries(view.rows1);
  assert.match(rows['Estimated minimum reached'], /charging may continue/);
  assert.equal(rows['Manual stopping time'], chargingTime(deadlineAt));
  assert.match(rows['Automatic control resumes'], /checking the current Easee instruction/);
  assert.match(rows['Repeating Easee window'], /temporary override.*OFF/);
});

test('Charger 2 selected current is independent of clamped forecast load and each receipt retains its own time', () => {
  const state = status({ charger2: { state: 'forecast', startAt, endAt: deadlineAt, currentA: 12, phaseCurrentA: [12, 12, 12],
    powerKw: 8.28, gridEnergyKwh: 25, metadata: {
      charge_current_request: { value: 13, measuredAt: null, receivedAt: now - 3000 },
      scheduled_charging_start_time: { value: startAt, measuredAt: null, receivedAt: now },
    } } }).charging;
  const rows = Object.fromEntries(chargingDisplay(state, now).rows2);
  assert.equal(rows['Selected charging current'], '13 A per phase'); assert.equal(rows['Current used in forecast'], '12 A per phase');
  assert.match(rows['Selected current reported'], /received .*measurement time unknown/);
  assert.match(rows['Vehicle scheduled start'], /Tue, .*received /);
  assert.match(chargingContext(state, now), /^Charger 2: Expected .*read-only/);
});

class Node {
  constructor(document) { this.document = document; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this.disabled = false;
    this.classList = { add() {}, remove() {}, toggle() {} }; }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(key, value) { this.listeners.set(key, value); }
  removeEventListener(key) { this.listeners.delete(key); }
  reportValidity() { return true; }
}
function documentFixture() {
  const document = { nodes: new Map(), createElement: () => new Node(document), createDocumentFragment: () => new Node(document), getElementById(id) { return this.nodes.get(id); } };
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/id="((?:charging|charger)[^"]+)"/g)) { const node = document.createElement(); node.id = match[1]; }
  return document;
}

test('OFF disables readiness controls while preserving editable telemetry preferences and remembered manual value', () => {
  const document = documentFixture(), panel = createChargingPanel({ document, request: async () => {} }), $ = id => document.getElementById(id);
  panel.update(status());
  assert.equal($('charging-setting-minimumSoc').value, 80); assert($('charging-setting-minimumSoc').disabled);
  assert($('charging-setting-readyBy').disabled); assert(!$('charging-setting-capacity1Kwh').disabled);
  assert(!$('charging-manual-soc').disabled); assert.equal($('charging-manual-soc').value, 40);
  panel.update(status({ settings: { ...DEFAULT_CHARGING_SETTINGS, manualSoc: 47 } }));
  assert.equal($('charging-manual-soc').value, 47);
  panel.update({ ...status(), role: 'replica' }); assert($('charging-enabled').disabled); assert($('charging-manual-soc').disabled);
  panel.close(); assert(!$('charging-enabled').listeners.has('click'));
});

test('refresh preserves unfinished edits and saves only changed nested preferences, preventing concurrent writes', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let resolve;
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); } });
  panel.update(status());
  const field = $('charging-setting-installation-mainFuseA'); field.value = '25'; field.listeners.get('input')();
  panel.update(status()); assert.equal(field.value, '25');
  const pending = $('charger1-settings-form').listeners.get('submit')({ preventDefault() {} });
  assert.deepEqual(calls, [['/api/charging/settings', { installation: { mainFuseA: 25 } }]]);
  assert($('charging-enabled').disabled);
  await $('charging-enabled').listeners.get('click')(); assert.equal(calls.length, 1);
  resolve(status({ settings: { ...DEFAULT_CHARGING_SETTINGS, installation: { ...DEFAULT_CHARGING_SETTINGS.installation, mainFuseA: 25 } } })); await pending;
  assert.equal(field.value, 25); assert($('charger1-settings-save').disabled); panel.close();
});

test('manual SoC applies and returns through independent actions without altering the master toggle', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return status({ settings: { ...DEFAULT_CHARGING_SETTINGS, manualSoc: 42 },
    soc: payload.action === 'automatic' ? { soc: 51, source: 'mqtt', measuredAt: now } : { soc: 42, source: 'manual', enteredAt: now, expiresAt: deadlineAt } }); } });
  panel.update(status()); $('charging-manual-soc').value = '42';
  await $('charging-soc-form').listeners.get('submit')({ preventDefault() {} });
  assert(!$('charging-soc-automatic').disabled); assert.equal($('charging-enabled').textContent, 'OFF');
  await $('charging-soc-automatic').listeners.get('click')();
  assert.deepEqual(calls, [['/api/charging/soc', { soc: 42 }], ['/api/charging/soc', { action: 'automatic' }]]); panel.close();
});
