import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garageDisplay, garageReleaseAvailable, createGarageControls } from '../chart/garage-status.js';
import { heatingScopeDisplay } from '../chart/heating-scope.js';
import { heatingDisplay } from '../chart/heating-benefit.js';
import { timingDisplay } from '../chart/timing-model.js';
import { buildHeatingSavings } from '../src/app/garage-reporting.js';

const range = { from: Date.parse('2026-09-08T00:00:00+03:00'), to: Date.parse('2026-09-09T00:00:00+03:00') }, now = range.to;

test('Home remains default and preserves existing model/timing values without mutating payload', () => {
  const payload = { range, now, heatingBenefit: { status: 'estimated', valueEuro: 4.5, counts: { assessed: 3 } },
    timingBenefit: { heatPump: { value: -0.25, coverage: 0.1 } } };
  const before = structuredClone(payload);
  const home = heatingScopeDisplay(payload);
  assert.equal(home.amount, heatingDisplay(payload.heatingBenefit, payload).amount);
  assert.equal(heatingScopeDisplay(payload, 'home', 'timing').amount, timingDisplay('heatPump', payload.timingBenefit.heatPump, payload).amount);
  assert.equal(heatingScopeDisplay(payload, 'garage').available, false);
  assert.deepEqual(payload, before);
});

test('Garage and Total presentation keeps provisional missing coverage and counterfactual boundaries explicit', () => {
  const heatingSavings = buildHeatingSavings({ range, now,
    homeModel: { status: 'estimated', valueEuro: 2, counts: { assessed: 1 } }, garageModel: { status: 'unavailable', valueEuro: null },
    homeTiming: { value: -0.1 }, garageTiming: { value: null } });
  const payload = { heatingSavings, range, now };
  const total = heatingScopeDisplay(payload, 'total');
  assert.equal(total.amount, '€2.00'); assert.match(total.qualification, /Partial total · Garage unavailable/);
  assert.match(total.breakdown.join(' '), /Home: €2.00.*Garage: unavailable/);
  assert.match(total.explanations.join(' '), /frozen normal-heating reference.*recovery.*provisional.*never added/);
  const timing = heatingScopeDisplay(payload, 'total', 'timing');
  assert.equal(timing.amount, '-€0.10'); assert.match(timing.coverageExplanation, /missing evidence is never zero/);
});

test('Garage monitoring shows independent budgets and actual adapter readbacks, health and unresolved recovery', () => {
  const omittedCredential = randomUUID();
  const status = { settings: { baselineC: 10, aggressiveness: 50, frontRequired: true, protection: { approved: true, budgetDegreeMinutes: 120 } },
    observations: { rear: { value: 5.7 }, front: { value: 6.2, stale: true } },
    protection: { limitingLocation: 'front', locations: { rear: { remainingDegreeMinutes: 80 }, front: { remainingDegreeMinutes: 12, uncertain: true } } },
    adapter: { contractVersion: 'stmq-garage-fixture/v1', contractStatus: 'provisional-fixture-only', liveControlSupported: false,
      native: { power: 'on' }, health: { deviceOnline: true, driverProgressing: false, pumpCommunicating: false }, restorePending: true,
      telemetry: { garage_native_indoor_temperature: { value: 0, supported: true, usable: true },
        garage_native_outdoor_temperature: { value: -7, supported: true, usable: false, quality: ['stale'] },
        garage_power: { value: 500, supported: false, usable: false } },
      episode: { leaseExpiresAt: now + 120_000 }, password: omittedCredential, topics: ['hidden-example'] },
    learning: { trainedIntervals: 0, heldOut: { rear: { n: 0, mae: null, bias: null } },
      coefficients: { rear: [{ name: 'lossPerHour', value: 0.022, unit: '1/h', basis: 'prior', evidence: 0 }] } } };
  const display = garageDisplay(status, now), rows = Object.fromEntries(display.rows);
  assert.match(rows['Rear exposure remaining'], /80 \/ 120/); assert.match(rows['Front exposure remaining'], /12 \/ 120.*uncertain/);
  assert.equal(rows['Limiting protection location'], 'front'); assert.match(rows['Front · pipe / door'], /stale/);
  assert.equal(rows['Pump indoor temperature'], '0 °C · provisional'); assert.equal(rows['Pump outdoor temperature'], '-7 °C · stale');
  assert.equal(rows['Electrical power'], 'Unavailable'); assert.equal(rows['Device online'], 'Yes'); assert.equal(rows['Driver progressing'], 'No');
  assert.equal(rows['Local lease remaining'], '2 min'); assert.match(rows.Recovery, /Restoration pending/);
  assert.match(display.coefficients[0][1], /prior · 0 intervals/);
  assert(!JSON.stringify(display).includes(omittedCredential));
  assert(!JSON.stringify(display).includes('hidden-example')); assert(!JSON.stringify(display).includes('%'));
});

test('Garage equipment and learning are closed disclosures inside the existing interface', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const id of ['garage-equipment-details', 'garage-technical-details', 'garage-learning-details']) {
    const tag = html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert(!/\sopen(?:\s|>|=)/.test(tag));
  }
  assert.match(html, /Learning outcomes · Calculated/); assert.match(html, /Garage settings/);
  assert.match(html, /Change the garage protection policy, savings aggressiveness and normal Mitsubishi setting in Configuration/);
});


test('End garage pause requires an owned restoration obligation, supported capability and writable role', () => {
  const status = { garage: { adapter: { restorePending: true, simulation: true } } };
  assert.equal(garageReleaseAvailable(status), true);
  assert.equal(garageReleaseAvailable({ garage: { adapter: { restorePending: true, liveControlSupported: true } } }), true);
  for (const value of [undefined, {}, { garage: { adapter: { simulation: true } } },
    { garage: { adapter: { restorePending: true, liveControlSupported: false } } },
    { ...status, role: 'replica' }, { ...status, role: 'protected' }, { ...status, readOnly: true },
    { ...status, pairing: { enabled: true, role: 'primary', canControl: false } }])
    assert.equal(garageReleaseAvailable(value), false);
});

test('garage release uses the empty safe request, rejects double clicks and awaits native recovery evidence', async () => {
  const nodes = new Map(['garage-release', 'garage-release-message'].map(id => [id, {
    disabled: true, textContent: '', attributes: new Map(), listeners: new Map(),
    classList: { add() {}, remove() {} },
    setAttribute(key, value) { this.attributes.set(key, value); }, removeAttribute(key) { this.attributes.delete(key); },
    addEventListener(key, value) { this.listeners.set(key, value); }, removeEventListener(key) { this.listeners.delete(key); },
  }]));
  const button = nodes.get('garage-release'), message = nodes.get('garage-release-message');
  const calls = [], busy = []; let resolve, returned;
  const status = { garage: { adapter: { restorePending: true, simulation: true } } };
  const panel = createGarageControls({ document: { getElementById: id => nodes.get(id) },
    request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); },
    onBusy: value => busy.push(value), onStatus: value => { returned = value; } });
  assert.equal(button.disabled, true);
  panel.update(status); assert.equal(button.disabled, false);
  const pending = button.listeners.get('click')();
  assert.equal(button.disabled, true); assert.equal(button.attributes.get('aria-busy'), 'true');
  await button.listeners.get('click')(); assert.deepEqual(calls, [['/api/garage/release', {}]]);
  resolve(status); await pending;
  assert.equal(returned, status); assert.match(message.textContent, /Waiting for heating confirmation/);
  assert.deepEqual(busy, [true, false]); assert.equal(button.disabled, false);
  panel.update({ ...status, role: 'replica' }); await button.listeners.get('click')();
  assert.equal(calls.length, 1); assert.equal(button.disabled, true);
  panel.close(); assert.equal(button.listeners.has('click'), false);
});


test('Garage held-out electrical response keeps kW distinct from temperature prediction errors', () => {
  const rows = Object.fromEntries(garageDisplay({ learning: { heldOut: {
    native: { n: 3, mae: .1, bias: -.02 }, advanceRear: { n: 4, mae: .2, bias: .05 },
  } } }).outcomeRows);
  assert.match(rows['Electrical response'], /MAE 0.1 kW · bias -0.02 kW/);
  assert.match(rows['Rear advance prediction'], /MAE 0.2 °C · bias 0.05 °C/);
});
