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

test('Garage Heat control badge follows its own pause and configuration', () => {
  const badge = { textContent: '', parentElement: { dataset: {} } };
  const document = { getElementById: id => id === 'garage-control-price' ? badge : null };
  for (const [garage, expected, state] of [
    [undefined, '—', 'muted'],
    [{ settings: { enabled: false } }, 'Disabled', 'muted'],
    [{ settings: { enabled: true } }, 'Active', 'active'],
    [{ settings: { enabled: true }, temporary: { pauseActive: true } }, 'Paused', 'paused'],
    [{ settings: { enabled: true }, temporary: { pauseActive: false } }, 'Active', 'active'],
  ]) {
    renderGarage(document, { now, garage, override: { expiresAt: now + 60_000 } });
    assert.equal(badge.textContent, expected);
    assert.equal(badge.parentElement.dataset.state, state);
  }
});

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

test('Garage heating, equipment and learning have independent closed disclosures', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const id of ['garage-heating-details', 'garage-equipment-details', 'garage-controller-details', 'garage-settings-details', 'garage-learning-details']) {
    const tag = html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert(!/\sopen(?:\s|>|=)/.test(tag));
  }
  assert.match(html, /Learning outcomes<\/span><small[^>]*> · Calculated/); assert.match(html, /Garage settings/);
  assert.match(html, /To change these values, edit Configuration, then select Apply configuration/);
});

test('heat-pump metric rows stay visible once in their summaries while controls and explanations stay inside', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const [id, metrics, info] of [
    ['home-pump-device', ['home-pump-state', 'home-pump-dhw', 'home-pump-room'], 'home-pump-reading-info'],
    ['garage-controller-details', ['garage-native-power', 'garage-native-mode', 'garage-native-target'], 'garage-pump-reading-info'],
  ]) {
    const equipment = html.slice(html.indexOf(`<details id="${id}"`)), summary = equipment.slice(0, equipment.indexOf('</summary>'));
    assert.match(summary, /class="[^"]*pump-native-overview/);
    for (const metric of metrics) {
      assert(summary.includes(`id="${metric}"`), `${metric} remains visible when folded`);
      assert.equal(html.split(`id="${metric}"`).length - 1, 1, `${metric} has one permanent value`);
      assert(summary.includes(`id="${metric}" class="muted">—</strong>`), 'Unknown compact values use a quiet dash instead of breaking a long word');
    }
    assert(!summary.includes('-preview') && !summary.includes('<button'));
    assert(equipment.indexOf(`id="${info}"`) > equipment.indexOf('</summary>'));
  }
  assert.match(html, /id="home-pump-state-age" hidden/);
  assert(!html.includes('home-pump-preview') && !html.includes('garage-pump-preview'));
});

test('Away and Pause use the same disclosure style as Garage settings inside heating configuration', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const [id, configuration, equipment] of [
    ['temporary-details', 'home-manual-controls', 'home-equipment-section'],
    ['garage-pause-details', 'garage-manual-controls', 'garage-equipment-section'],
  ]) {
    const tag = html.match(new RegExp(`<details id="${id}"[^>]*>`))[0];
    assert.match(tag, /class="equipment-fold /); assert(!tag.includes('section-fold'));
    assert(!/\sopen(?:\s|>|=)/.test(tag));
    assert(html.indexOf(`id="${configuration}"`) < html.indexOf(`id="${id}"`));
    assert(html.indexOf(`id="${id}"`) < html.indexOf(`id="${equipment}"`));
  }
  assert(!html.includes('zone-availability-fold'));
  const overview = html.slice(html.indexOf('<details id="garage-heating-details"'), html.indexOf('id="garage-manual-controls"'));
  assert(overview.includes('id="garage-door-summary"'));
  assert(!overview.includes('Cold allowance'));
  assert(!html.includes('id="garage-budget-rear"') && !html.includes('id="garage-budget-front"'));
  for (const location of ['rear', 'front']) assert(html.includes(`id="garage-settings-budget-${location}"`));
});

test('permanent Mitsubishi summary values remain plain text and stop claiming stale readings', () => {
  const nodes = new Map(['power', 'mode', 'target'].map(field => [`garage-native-${field}`, {
    textContent: '', stale: false, classList: { toggle(name, value) { nodes.get(`garage-native-${field}`)[name] = value; } },
  }]));
  const document = { getElementById: id => nodes.get(id) };
  const garage = { settings: { maxSensorAgeMs: 120_000 }, adapter: { connected: true, health: { deviceOnline: true, pumpCommunicating: true },
    native: { power: 'on', mode: 'heat', targetC: 10, readbacks: Object.fromEntries(['power', 'mode', 'targetC'].map(field => [field, { measuredAt: now }])) } } };
  renderGarage(document, { garage, now });
  assert.deepEqual([...nodes.values()].map(node => node.textContent), ['on', 'heat', '10 °C']);
  assert([...nodes.values()].every(node => !node.stale));
  renderGarage(document, { garage, now: now + 120_000 });
  assert([...nodes.values()].every(node => node.textContent === '—' && node.stale && node.muted));
  renderGarage(document, { garage: { ...garage, adapter: { ...garage.adapter, connected: false } }, now });
  assert([...nodes.values()].every(node => node.textContent === '—' && node.stale && node.muted));
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

function garageControlFixture() {
  const ids = ['garage-release', 'garage-release-message', 'garage-pause-form', 'garage-pause-until',
    'garage-heating-message', 'garage-pause-message', 'garage-mode-normal', 'garage-mode-off', 'garage-resume-now'];
  const nodes = new Map(ids.map(id => [id, {
    textContent: '', value: '', listeners: new Map(), classes: new Set(),
    classList: { add(name) { nodes.get(id).classes.add(name); }, remove(name) { nodes.get(id).classes.delete(name); } },
    setAttribute() {}, removeAttribute() {}, querySelector() { return { textContent: '' }; },
    addEventListener(event, handler) { this.listeners.set(event, handler); }, removeEventListener(event) { this.listeners.delete(event); },
  }]));
  const initial = { now, garage: { adapter: { restorePending: false, simulation: true },
    heatingControls: { available: true, normalAvailable: true, offAvailable: true, requestedMode: null },
    temporary: { available: true, pauseActive: false } } };
  let response = initial;
  const panel = createGarageControls({ document: { getElementById: id => nodes.get(id), defaultView: { confirm: () => true } },
    request: async () => { if (response instanceof Error) throw response; return response; } });
  panel.update(initial);
  return { panel, nodes, initial, reply(value) { response = value; },
    async trigger(id, event = 'click') { nodes.get(id).listeners.get(event)({ preventDefault() {} }); await new Promise(setImmediate); } };
}

test('garage manual feedback follows confirmation and clears after hold expiry and restoration', async () => {
  const f = garageControlFixture(), deadline = now + 3600_000;
  const paused = { ...f.initial, garage: { ...f.initial.garage,
    temporary: { available: true, pauseActive: true, pauseUntil: deadline } } };
  const held = { ...paused, garage: { ...paused.garage, adapter: { restorePending: true, simulation: true },
    heatingControls: { ...paused.garage.heatingControls, requestedMode: 'off', holdUntil: deadline, paused: true, confirmed: false } } };
  f.panel.update(paused); f.reply(held); await f.trigger('garage-mode-off');
  const message = f.nodes.get('garage-heating-message');
  assert.match(message.textContent, /Held until.*Check the reported pump state/);
  const confirmed = { ...held, garage: { ...held.garage, heatingControls: { ...held.garage.heatingControls, confirmed: true } } };
  f.panel.update(confirmed); assert.match(message.textContent, /Device confirmed/);
  const restoring = { ...f.initial, now: deadline, garage: { ...f.initial.garage,
    adapter: { restorePending: true, simulation: true } } };
  f.panel.update(restoring);
  assert.match(message.textContent, /Waiting for normal heating confirmation/);
  assert.doesNotMatch(message.textContent, /Held until|Device confirmed/);
  f.panel.update({ ...f.initial, now: deadline + 60_000 }); assert.equal(message.textContent, '');
  f.panel.update(restoring); assert.equal(message.textContent, '', 'Completed feedback cannot return with a later restoration');
  f.panel.close();
});

test('garage manual feedback clears on the controller update or a replacement manual request', async () => {
  for (const superseded of [false, true]) {
    const f = garageControlFixture();
    const requested = { ...f.initial, garage: { ...f.initial.garage,
      heatingControls: { ...f.initial.garage.heatingControls, requestedMode: 'normal', holdUntil: now + 60_000, confirmed: true } } };
    f.reply(requested); await f.trigger('garage-mode-normal');
    assert.match(f.nodes.get('garage-heating-message').textContent, /next update/);
    f.panel.update(superseded ? { ...requested, now: now + 1000, garage: { ...requested.garage,
      adapter: { restorePending: true, simulation: true },
      heatingControls: { ...requested.garage.heatingControls, requestedMode: 'off' } } } : { ...f.initial, now: now + 1000 });
    assert.equal(f.nodes.get('garage-heating-message').textContent, '');
    f.panel.close();
  }
});

test('garage pause and resume feedback drops obsolete heating claims and ends with restoration', async () => {
  const f = garageControlFixture(), deadline = now + 3600_000;
  const paused = { ...f.initial, garage: { ...f.initial.garage,
    temporary: { available: true, pauseActive: true, pauseUntil: deadline } } };
  f.nodes.get('garage-pause-until').value = '2026-09-09T04:00';
  await f.trigger('garage-pause-until', 'input'); f.reply(paused); await f.trigger('garage-pause-form', 'submit');
  const message = f.nodes.get('garage-pause-message'); assert.match(message.textContent, /Pause saved/);
  f.panel.update({ ...paused, garage: { ...paused.garage,
    heatingControls: { ...paused.garage.heatingControls, requestedMode: 'off', holdUntil: deadline, paused: true } } });
  assert.match(message.textContent, /Price control paused until/); assert.doesNotMatch(message.textContent, /Normal heating is requested/);
  const restoring = { ...f.initial, garage: { ...f.initial.garage, adapter: { restorePending: true, simulation: true } } };
  f.reply(restoring); await f.trigger('garage-resume-now');
  f.panel.update(restoring); assert.match(message.textContent, /Waiting for normal heating confirmation/);
  f.panel.update(f.initial); assert.equal(message.textContent, '');
  f.panel.close();
});

test('garage release keeps unresolved and failed requests visible but clears completed feedback', async () => {
  const f = garageControlFixture(), pending = { ...f.initial, garage: { ...f.initial.garage,
    adapter: { restorePending: true, simulation: true } } };
  const message = f.nodes.get('garage-release-message');
  f.panel.update(pending); f.reply(pending); await f.trigger('garage-release');
  f.panel.update(pending); assert.match(message.textContent, /Waiting for heating confirmation/);
  f.panel.update(f.initial); assert.equal(message.textContent, '');
  f.panel.update(pending); assert.equal(message.textContent, '');
  f.reply(new Error('Heating restoration could not be confirmed.')); await f.trigger('garage-release');
  f.panel.update(pending);
  assert.equal(message.textContent, 'Heating restoration could not be confirmed.');
  assert(message.classes.has('form-error'));
  f.panel.close();
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
