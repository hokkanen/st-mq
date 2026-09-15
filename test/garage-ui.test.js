import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garageDisplay, garageReleaseAvailable, createGarageControls, renderGarage } from '../chart/garage-status.js';
import { heatingScopeDisplay } from '../chart/heating-scope.js';
import { heatingDisplay } from '../chart/heating-benefit.js';
import { timingDisplay } from '../chart/timing-model.js';
import { buildHeatingSavings } from '../src/app/garage-reporting.js';
import { createGarageModel, garageModelSummary, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';

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
  const status = { settings: { baselineC: 10, aggressiveness: 50, frontRequired: true, protection: { approved: true, marginC: 1 } },
    observations: { rear: { value: 5.7 }, front: { value: 6.2, stale: true } },
    protection: { limitingLocation: 'front', locations: { rear: { remainingKjPerM: 6.3, estimatedC: 5.5 }, front: { remainingKjPerM: 2.1, estimatedC: 2.5, uncertain: true } } },
    adapter: { contractVersion: 'stmq-garage-fixture/v1', contractStatus: 'provisional-fixture-only', liveControlSupported: false,
      native: { power: 'on' }, health: { deviceOnline: true, driverProgressing: false, pumpCommunicating: false }, restorePending: true,
      telemetry: { garage_native_indoor_temperature: { value: 0, supported: true, usable: true },
        garage_native_outdoor_temperature: { value: -7, supported: true, usable: false, quality: ['stale'] },
        garage_power: { value: 500, supported: false, usable: false } },
      episode: { leaseExpiresAt: now + 120_000 }, password: omittedCredential, topics: ['hidden-example'] },
    learning: { trainedIntervals: 0, heldOut: { rear: { n: 0, mae: null, bias: null } },
      coefficients: { rear: [{ name: 'lossPerHour', value: 0.022, unit: '1/h', basis: 'prior', evidence: 0 }] } } };
  const display = garageDisplay(status, now), rows = Object.fromEntries(display.rows);
  assert.equal(rows['Rear allowance remaining'], '6.3 kJ/m'); assert.match(rows['Front allowance remaining'], /2\.1 kJ\/m.*uncertain/);
  assert.equal(rows['Rear reference estimate'], '5.5 °C');
  assert.equal(rows['Limiting protection location'], 'front'); assert.match(rows['Front air · near door'], /stale/);
  assert.equal(rows['Pump indoor temperature'], '0 °C · provisional'); assert.equal(rows['Pump outdoor temperature'], '-7 °C · stale');
  assert.equal(rows['Electrical power'], 'Unavailable'); assert.equal(rows['Device online'], 'Yes'); assert.equal(rows['Driver progressing'], 'No');
  assert.equal(rows['Local lease remaining'], '2 min'); assert.match(rows.Recovery, /Restoration pending/);
  assert.match(display.coefficients[0][1], /0\.022 1\/h · Initial estimate — not validated.*0 intervals with input present/);
  assert(!JSON.stringify(display).includes(omittedCredential));
  assert(!JSON.stringify(display).includes('hidden-example')); assert(!JSON.stringify(display).includes('%'));
});

test('Garage equipment and learning are closed disclosures inside the existing interface', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const id of ['garage-equipment-details', 'garage-controller-details', 'garage-settings-details', 'garage-learning-details']) {
    const tag = html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert(!/\sopen(?:\s|>|=)/.test(tag));
  }
  assert.match(html, /Learning outcomes<\/span><small[^>]*> · Calculated/); assert.match(html, /Garage settings/);
  assert.match(html, /To change these values, edit Configuration, then select Apply configuration/);
});

test('Garage settings keep configured values separate from descriptions and live exposure', () => {
  const settings = garageSettings({ aggressiveness: 0 });
  const garage = { settings, protection: { locations: { rear: { remainingKjPerM: 0 }, front: { remainingKjPerM: 12 } } } };
  const before = structuredClone(garage), display = garageDisplay(garage);
  const groups = Object.fromEntries(Object.entries(display.settingGroups).map(([key, rows]) => [key, Object.fromEntries(rows)]));
  assert.deepEqual(groups.heating, { 'Normal Mitsubishi setting': '10 °C', 'Savings aggressiveness': '0 / 100' });
  assert.deepEqual(groups.protection, { 'Protection margin': '1 °C', 'Reference pipe diameter': '21 mm', 'Assumed wall thickness': '1 mm', 'Heat transfer': '20 W/m²K', 'Safety factor': '2×' });
  assert.deepEqual(groups.recovery, { 'Cold allowance': 'Calculated · kJ/m', 'Recovery': 'Continuous' });
  for (const rows of Object.values(display.settingGroups)) for (const [, value, description] of rows) {
    assert(description.length > 30); assert(value.length < 30);
  }
  assert.deepEqual(garage, before);
  assert.deepEqual(garageDisplay({ settings, protection: {} }).settingGroups, display.settingGroups);
  const missing = garageDisplay().settingGroups;
  assert(missing.heating.every(([, value]) => value === 'Unavailable'));
  assert(missing.protection.filter(([label]) => label !== 'Safety factor').every(([, value]) => value === 'Unavailable'));
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.match(html, /pipes and stored liquids.*water-filled copper pipe/);
  assert(!html.includes('garage-settings-budget-rear-meter'));
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


test('Garage outcomes retain electrical error evidence and omit temperature step diagnostics', () => {
  const rows = Object.fromEntries(garageDisplay({ learning: { heldOut: {
    native: { hours: 2, n: 3, mae: .1, bias: -.02 },
    ...Object.fromEntries(['rear', 'front', 'advanceRear', 'advanceFront', 'offRear', 'offFront'].map(key => [key, { hours: 3, n: 4, mae: .2, bias: .05 }])),
  } } }).outcomeRows);
  assert.match(rows['Electrical short-step error'], /^2 h checked · 3 predictions · MAE 0.1 kW · bias -0.02 kW/);
  assert.equal(Object.keys(rows).filter(label => /error|diagnostic/.test(label)).length, 1);
  assert(!JSON.stringify(rows).includes('0.2 °C'));
});

test('Garage real model summary separates adjustable estimates, fitted responses and structural assumptions', () => {
  const model = createGarageModel(), initial = garageDisplay({ learning: garageModelSummary(model) });
  const initialCoefficients = Object.fromEntries(initial.coefficients);
  assert.equal(initial.coefficients.length, 22);
  assert.match(initialCoefficients['Rear air · Heat loss'], /^0\.022 1\/h · Initial estimate — not validated/);
  assert.match(initialCoefficients['Front–rear difference · Local heat loss'], /^0\.012 1\/h · Initial estimate — not validated/);
  assert.match(initialCoefficients['Rear air · Stored-heat exchange'], /^0\.11 1\/h · Fixed assumption/);
  assert.match(initialCoefficients['Pump electricity · Demand electricity'], /Initial estimate — not validated.*requires recovery evidence/);
  assert.match(initialCoefficients['Pump electricity · Restart electricity'], /Fixed assumption/);
  assert.match(initialCoefficients['Building warmth · Memory time'], /^18 h · Fixed assumption/);
  assert.match(initialCoefficients['Normal rear warmth · Weather response'], /^0\.03 °C\/°C · Fixed assumption/);
  const fittingMethod = initial.coefficientDetails.find(row => row.key === 'coefficient-fitting-method');
  assert.match(fittingMethod.detail, /fit five responses, plus a sixth recovery-demand response/);
  assert.match(fittingMethod.detail, /electricity and compressor activity are alternative/);
  assert.match(Object.fromEntries(initial.outcomeRows)['Fitted responses'], /^0 fitted in current model · 0 retained/);

  // Represent a fit that selected electrical heating after an earlier activity
  // fit. Structural terms remain assumptions even with extensive input coverage.
  for (const [group, indices] of [['rear', [0, 2]], ['front', [1]], ['native', [0, 1]]])
    for (const index of indices) { model[group].active[index] = true; model[group].fitted[index] = true; model[group].evidence[index] = 8; }
  model.rear.fitted[3] = true; model.rear.evidence[3] = 6;
  model.rear.evidence[1] = 120;
  const summary = garageModelSummary(model), before = structuredClone(summary);
  const fitted = garageDisplay({ learning: summary }), rows = Object.fromEntries(fitted.coefficients);
  assert.match(Object.fromEntries(fitted.outcomeRows)['Fitted responses'], /^5 fitted in current model · 1 retained/);
  assert.match(rows['Rear air · Electrical heat response'], /Fitted in current model.*8 h with input present/);
  assert.match(rows['Rear air · Activity heat response'], /Retained from an earlier fit.*6 h with input present/);
  assert.match(rows['Rear air · Stored-heat exchange'], /Fixed assumption.*120 h with input present/);
  assert.match(Object.fromEntries(fitted.outcomeRows)['Temperature prediction'], /Awaiting complete episode validation/);
  assert(!JSON.stringify(fitted).includes('lossPerHour'));
  assert(!JSON.stringify(fitted).includes('fitted-effective-response'));
  assert(!JSON.stringify(fitted).includes(GARAGE_ALGORITHM_VERSION));
  assert.deepEqual(summary, before);
});

test('Garage learning distinguishes thermal duration, electrical qualification and a bounded trial', () => {
  const display = garageDisplay({ learning: { thermalReady: true, electricalReady: false, maxPauseHours: 2,
    validation: { completedEpisodes: 5, trainingEpisodes: 3, validationEpisodes: 1, recoveryEpisodes: 0,
      horizonHours: 4, rearRmse: .3, rearBias: -.1, offRearRmse: .2 } },
    plan: { learningTrial: true, evidence: { trialEligible: true, trialHours: 2.5 } } });
  const rows = Object.fromEntries(display.outcomeRows);
  assert.equal(rows['Validated thermal pause duration'], '2 h');
  assert.match(rows['Temperature prediction'], /Validated on complete cooling and recovery episodes/);
  assert.match(rows['Electricity prediction'], /Awaiting electrical and recovery evidence/);
  assert.match(rows['Economic pause support'], /Not yet qualified/);
  assert.match(rows['Learning trial support'], /^2\.5 h maximum.*protection and recovery still apply/);
  assert.match(rows['Current opportunity'], /Bounded learning trial/);
  assert.match(rows['Complete clean episodes'], /5 in retained history.*latest 24 ended episodes/);
  assert.match(rows['Episode error coverage'], /4 h longest.*including failed recovery/);
  assert.match(rows['Rear whole-episode error'], /RMSE 0\.3 °C · bias -0\.1 °C/);
  assert.equal(rows['Front whole-episode error'], 'Not available yet');
  const validationMethod = display.evidenceDetails.find(row => row.key === 'validation-method');
  assert.match(validationMethod.detail, /model frozen before the pause/);
  assert.match(validationMethod.detail, /do not measure weather-forecast accuracy/);
  assert.match(validationMethod.evidence, /positive bias means the prediction was too cold or too low/);
  assert.equal(Object.fromEntries(garageDisplay({ learning: { thermalReady: true, electricalReady: true, maxPauseHours: 2 } }).outcomeRows)['Economic pause support'], '2 h');
});

test('Garage absent learning evidence remains unknown and air measurements remain distinct from modeled states', () => {
  const display = garageDisplay({ settings: { frontRequired: false, protection: { marginC: 1 } },
    observations: { rear: { value: 5 }, front: { value: 4 } },
    learning: { normalReference: { rearC: 10 }, nativeActivity: { mean: .4 }, state: { coreC: 6 } } });
  const outcomes = Object.fromEntries(display.outcomeRows), inputs = Object.fromEntries(display.inputRows);
  for (const name of ['Temperature prediction', 'Electricity prediction', 'Validated thermal pause duration', 'Economic pause support'])
    assert.equal(outcomes[name], 'Unavailable');
  assert.equal(outcomes['Learning trial support'], 'Not assessed in the current plan');
  assert.match(outcomes['Normal rear warmth'], /Unknown reference provenance.*Unavailable qualified reference observations/);
  assert.match(outcomes['Normal activity baseline'], /0\.4 on a 0–1 scale.*Unknown activity provenance.*adjusts this baseline/);
  assert.match(inputs['Front air temperature · °C'], /Both locations need fresh readings for every automatic pause/);
  assert.match(inputs['Estimated building warmth · °C'], /^6 °C.*not measured pipe temperature or stored kWh/);
  assert.match(inputs['Local allowance recovery'], /recovers continuously.*temperature.*rate.*independently/);
  assert.equal(Object.fromEntries(display.rows)['Rear air · near pipe'], '5 °C');
  assert.equal(Object.fromEntries(display.rows)['Front air · near door'], '4 °C');
});

test('Garage rendering fills each existing learning fold context without requiring equipment cards', () => {
  const nodes = new Map(['garage-learning-context', 'garage-input-context', 'garage-coefficient-context'].map(id => [id, { textContent: '' }]));
  renderGarage({ getElementById: id => nodes.get(id) }, { garage: { learning: garageModelSummary(createGarageModel()) }, now });
  assert.match(nodes.get('garage-learning-context').textContent, /complete cooling and recovery checks/);
  assert.match(nodes.get('garage-input-context').textContent, /Missing readings remain unknown/);
  assert.match(nodes.get('garage-coefficient-context').textContent, /Fitted responses, initial estimates and fixed assumptions/);
  assert.equal(Object.fromEntries(garageDisplay({ learning: { reconstruction: 'snapshot' } }).outcomeRows)['Recorded history reconstruction'], 'Recorded primary snapshot');
});

test('Garage learning rows separate model values, provenance, episode evidence and protection context', () => {
  const model = createGarageModel();
  model.rear.active[0] = true; model.rear.fitted[0] = true; model.rear.evidence[0] = 8;
  model.rear.fitted[3] = true; model.rear.evidence[3] = 6;
  model.state.differenceC = -1.25;
  const garage = { observations: { rear: { value: 0, stale: false }, front: { value: 1, stale: true } },
    settings: { protection: { marginC: 1 } },
    learning: garageModelSummary(model) };
  const before = structuredClone(garage), display = garageDisplay(garage);
  const inputs = Object.fromEntries(display.inputDetails.map(row => [row.key, row]));
  assert.equal(inputs['rear-air-temperature'].value, '0 °C');
  assert.equal(inputs['rear-air-temperature'].available, true);
  assert.equal(inputs['rear-air-temperature'].provenance, 'Recorded');
  assert.equal(inputs['front-air-temperature'].value, '1 °C · stale');
  assert.equal(inputs['outdoor-temperature'].value, 'Unavailable');
  assert.equal(inputs['outdoor-temperature'].available, false);
  assert.equal(inputs['outdoor-temperature'].provenance, 'Source varies');
  assert.equal(inputs['front-rear-difference'].value, '-1.25 °C');
  assert.equal(inputs['front-rear-difference'].provenance, 'Calculated');
  assert.match(inputs['front-rear-difference'].detail, /last calculated.*carried between qualified front readings/);
  assert.equal(inputs['estimated-building-warmth'].provenance, 'Modeled');
  assert.equal(inputs['local-allowance-recovery'].group, 'Protection context');
  assert.equal(inputs['local-allowance-recovery'].value, 'Continuous');
  assert.match(inputs['local-allowance-recovery'].detail, /water-filled copper reference.*separate from learned building coefficients/);
  const coefficient = (group, title) => display.coefficientDetails.find(row => row.group === group && row.title === title);
  assert.equal(coefficient('Rear air', 'Heat loss').value, '0.022 1/h');
  assert.equal(coefficient('Rear air', 'Heat loss').provenance, 'Fitted');
  assert.match(coefficient('Rear air', 'Heat loss').evidence, /8 h with input present.*does not establish/);
  assert.equal(coefficient('Rear air', 'Activity heat response').provenance, 'Retained fit');
  assert.equal(coefficient('Rear air', 'Stored-heat exchange').provenance, 'Fixed assumption');
  assert.equal(coefficient('Pump electricity', 'Demand electricity').provenance, 'Initial estimate');
  assert.equal(coefficient('Building assumptions', 'Building warmth memory').value, '18 h');
  assert(display.evidenceDetails.some(row => row.key === 'rear-whole-episode-error'));
  assert(!display.outcomeDetails.some(row => row.key === 'rear-whole-episode-error'));
  for (const rows of [display.outcomeDetails, display.evidenceDetails, display.inputDetails, display.coefficientDetails]) {
    assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
    assert(rows.every(row => row.title && row.value && row.provenance && row.detail));
  }
  assert.deepEqual(garage, before);
  for (const [source, provenance] of [['fmi', 'Recorded'], ['husdata-h66', 'Recorded'], ['openmeteo', 'Modeled']]) {
    const outdoor = garageDisplay({ observations: { outdoor: { value: 0, source } } }).inputDetails.find(row => row.key === 'outdoor-temperature');
    assert.equal(outdoor.provenance, provenance);
    assert.equal(outdoor.value, '0 °C');
  }
});
