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
    homeTiming: { value: -0.1,coverageDetails:{elapsedMs:86400000,includedMs:3600000,powerMs:3600000},
      evidence:{energyBasis:'reconstructed-equipment',sources:[{key:'observed',durationMs:3600000,share:1}]} }, garageTiming: { value: null } });
  const payload = { heatingSavings, range, now };
  const total = heatingScopeDisplay(payload, 'total');
  assert.equal(total.amount, '€2.00'); assert.match(total.qualification, /Partial total · Garage unavailable/);
  assert.match(total.breakdown.join(' '), /Home: €2.00.*Garage: unavailable/);
  assert.match(total.explanations.join(' '), /frozen normal-heating reference.*recovery.*provisional.*never added/);
  const timing = heatingScopeDisplay(payload, 'total', 'timing');
  assert.equal(timing.key,'heatPump','Changing scope must keep the mounted Heating card identity');
  assert.equal(timing.amount, '-€0.10'); assert.match(timing.coverageExplanation, /missing evidence is never zero/);
});

test('current qualified Garage intervals remain available while the Home renderer rejects that different evidence scope',()=>{
  const result={value:.5,sourceQuality:'verified-electrical',coverageDetails:{elapsedMs:86400000,includedMs:3600000},
    evidence:{energyBasis:'recorded-intervals',timeBasis:'recorded-interval-time',sources:[{key:'measured',durationMs:3600000,share:1}]}};
  const payload={range,now,heatingSavings:{garage:{timing:result}}};
  const garage=heatingScopeDisplay(payload,'garage','timing');
  assert.equal(garage.key,'heatPump');
  assert.equal(garage.available,true);assert.equal(garage.amount,'€0.50');assert.equal(garage.basis,'Verified electrical intervals');
  assert.match(garage.sources[0].explanation,/Dedicated garage electrical intervals/);
  assert.equal(timingDisplay('heatPump',result,payload).available,false);
});

test('Garage automatic details show independent budgets, health and unresolved recovery without duplicate native readings', () => {
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
      coefficients: { rear: [{ name: 'coolingPerHour', value: 0.022, unit: '1/h', basis: 'prior', evidence: 0 }] } } };
  const display = garageDisplay(status, now), rows = Object.fromEntries(display.rows);
  assert.equal(rows['Rear allowance remaining'], '6.3 kJ/m'); assert.match(rows['Front allowance remaining'], /2\.1 kJ\/m.*uncertain/);
  assert.equal(rows['Rear reference estimate'], '5.5 °C');
  assert.equal(rows['Limiting protection location'], 'front'); assert.match(rows['Front air · near door'], /stale/);
  assert.equal(rows['Pump indoor temperature'], undefined); assert.equal(rows['Pump outdoor temperature'], undefined);
  assert.equal(rows['Electrical power'], undefined); assert.equal(rows['Device online'], 'Yes'); assert.equal(rows['Driver progressing'], 'No');
  assert.equal(rows['Local lease remaining'], '2 min'); assert.match(rows.Recovery, /Restoration pending/);
  assert.match(display.coefficients[0][1], /0\.022 1\/h · Initial estimate.*0 h clean cooling observations/);
  assert(!JSON.stringify(display).includes(omittedCredential));
  assert(!JSON.stringify(display).includes('hidden-example')); assert(!JSON.stringify(display).includes('Estimated building warmth'));
});

test('Garage heating, equipment and learning have independent closed disclosures', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const id of ['garage-heating-details', 'garage-equipment-details', 'garage-controller-details', 'garage-settings-details', 'garage-learning-details']) {
    const tag = html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert(!/\sopen(?:\s|>|=)/.test(tag));
  }
  assert.match(html, /Learning outcomes<\/span><small[^>]*> · Calculated/); assert.match(html, /Savings &amp; protection/);
  assert.match(html, /Edit permanent preferences in configuration, then use Apply configuration/);
});

test('heat-pump metric rows stay visible once in their summaries while controls and explanations stay inside', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const [id, metrics, info] of [
    ['home-pump-device', ['home-pump-state', 'home-pump-dhw', 'home-pump-room'], 'home-pump-reading-info'],
    ['garage-controller-details', ['garage-native-power', 'garage-native-target'], 'garage-pump-reading-info'],
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
  const mitsubishi=html.slice(html.indexOf('<details id="garage-controller-details"'));
  assert.match(mitsubishi.slice(0,mitsubishi.indexOf('</summary>')), /id="garage-native-compressor" class="muted">Unknown<\/strong>/);
  assert.equal(html.split('id="garage-native-compressor"').length-1,1);
  assert(!html.includes('id="garage-native-mode"'), 'Mode is available in details rather than the compact summary');
});

test('Mitsubishi summary preserves compressor state through running, idle and lost telemetry', () => {
  const node={textContent:'',classList:{toggle(){}}};
  const document={getElementById:id=>id==='garage-native-compressor'?node:undefined};
  const garage={adapter:{connected:true,telemetry:{}}};
  for(const [value,expected] of [[true,'Running'],[false,'Idle'],[null,'Unknown']]){
    garage.adapter.telemetry.compressorActive={value,supported:true,sourceTime:now};
    renderGarage(document,{now,garage});
    assert.equal(node.textContent,expected);
  }
  renderGarage(document,{now,garage:{}});
  assert.equal(node.textContent,'Unknown');
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
  assert.deepEqual([...nodes.values()].map(node => node.textContent), ['On', 'Heat', '10 °C']);
  assert([...nodes.values()].every(node => !node.stale));
  renderGarage(document, { garage, now: now + 120_000 });
  assert([...nodes.values()].every(node => node.textContent === '—' && node.stale && node.muted));
  renderGarage(document, { garage: { ...garage, adapter: { ...garage.adapter, connected: false } }, now });
  assert([...nodes.values()].every(node => node.textContent === '—' && node.stale && node.muted));
});

test('Garage settings keep configured values separate from descriptions and live exposure', () => {
  const settings = garageSettings({ aggressiveness: 0, baselineC: 16 });
  const garage = { settings, protection: { locations: { rear: { remainingKjPerM: 0 }, front: { remainingKjPerM: 12 } } } };
  const before = structuredClone(garage), display = garageDisplay(garage);
  const groups = Object.fromEntries(Object.entries(display.settingGroups).map(([key, rows]) => [key, Object.fromEntries(rows)]));
  assert.deepEqual(groups.heating, { 'Normal room setting': '16 °C', 'Savings selection': 'Normal heating' });
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


test('Garage exposes two learned cooling rates and four explicit electricity and recovery assumptions', () => {
  const model = createGarageModel(), initial = garageDisplay({ learning: garageModelSummary(model) });
  const rows = Object.fromEntries(initial.coefficientDetails.map(row => [row.key, row]));
  assert.equal(initial.coefficients.length, 6);
  assert.equal(rows['rear-cooling-rate'].value, '0.03 1/h');
  assert.equal(rows['front-cooling-rate'].value, '0.04 1/h');
  assert.equal(rows['rear-cooling-rate'].provenance, 'Initial estimate');
  assert.match(rows['rear-cooling-rate'].calculation.equations[0].expression, /exp/);
  assert.equal(rows['charger-heat-fraction'].value, '7.5 %');
  assert.equal(rows['normal-pump-power'].value, '0.5 kW');
  assert.equal(rows['normal-pump-power'].provenance, 'Assumed');
  assert.equal(rows['recovery-time'].value, '3 h');
  assert.equal(rows['recovery-energy-factor'].value, '1.25 ×');
  assert(!initial.inputDetails.some(row => /building warmth|memory|core/.test(row.title)));
  model.rear.active[0] = true; model.rear.fitted[0] = true; model.rear.evidence[0] = 8;
  model.native.active[0] = true; model.native.hours = 6; model.native.values[0] = .42;
  const summary = garageModelSummary(model), before = structuredClone(summary);
  const learned = garageDisplay({ learning: summary }).coefficientDetails;
  assert.equal(learned.find(row => row.key === 'rear-cooling-rate').provenance, 'Learned');
  assert.match(learned.find(row => row.key === 'rear-cooling-rate').evidence, /8 h clean cooling observations/);
  assert.equal(learned.find(row => row.key === 'normal-pump-power').provenance, 'Recorded average');
  assert.equal(learned.find(row => row.key === 'normal-pump-power').value, '0.42 kW');
  assert.deepEqual(summary, before);
});

test('Garage separates validation, sources and planning with honest missing and zero inputs', () => {
  const model = createGarageModel();
  const garage = { observations: { rear: { value: 0, stale: false }, front: { value: 1, stale: true },
      charging: { ev1: { known: true, powerKw: 0, heatKw: 0 }, ev2: { known: false } } },
    settings: garageSettings(), roomTemperature: { targetC: 5, phase: 'active', acknowledged: true, offsetC: 12 }, learning: garageModelSummary(model) };
  const before = structuredClone(garage), display = garageDisplay(garage);
  const inputs = Object.fromEntries(display.inputDetails.map(row => [row.key, row]));
  assert.equal(inputs['rear-air-temperature'].value, '0 °C');
  assert.equal(inputs['front-air-temperature'].value, '1 °C · stale');
  assert.equal(inputs['outdoor-temperature'].value, 'Unavailable');
  assert.equal(inputs['outdoor-temperature'].available, false);
  assert.equal(inputs['charger-1-input'].value, '0 kW estimated heat');
  assert.equal(inputs['charger-2-input'].value, 'Unavailable');
  assert.match(inputs['charger-2-input'].evidence, /Unknown is not treated as zero/);
  assert.equal(inputs['local-allowance-recovery'].value, 'Rear and front independently');
  assert(display.evidenceDetails.some(row => row.key === 'rear-cooling-error'));
  assert(!display.outcomeDetails.some(row => row.key === 'rear-cooling-error'));
  assert(display.planningDetails.some(row => row.key === 'daily-pause-limit' && row.value === '1'));
  assert.match(Object.fromEntries(display.rows)['Normal heating setting basis'], /5 °C saved · Garage rear · Active/);
  for (const rows of [display.outcomeDetails, display.evidenceDetails, display.inputDetails, display.coefficientDetails, display.planningDetails]) {
    assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
    assert(rows.every(row => row.title && row.value && row.provenance && row.detail));
    assert(rows.every(row => row.calculation?.paragraphs?.length >= 1), 'Every Garage entry offers methodology and limits');
  }
  assert.deepEqual(garage, before);
  for (const [source, provenance] of [['fmi', 'Recorded'], ['husdata-h66', 'Recorded'], ['openmeteo', 'Modeled']])
    assert.equal(garageDisplay({ observations: { outdoor: { value: 0, source } } }).inputDetails.find(row => row.key === 'outdoor-temperature').provenance, provenance);
  const missing = garageDisplay();
  for (const key of ['temperature-prediction', 'thermal-pause-duration', 'electricity-prediction'])
    assert.equal(missing.outcomeDetails.find(row => row.key === key).value, 'Unavailable');
});

test('future and active pause windows use their selected endpoints, with no preheating', () => {
  for (const plan of [{ pauseFrom: now + 3600_000, plannedPauseUntil: now + 7200_000, pauseUntil: null },
    { pauseFrom: now, pauseUntil: now + 3600_000 }]) {
    const display = garageDisplay({ plan: { ...plan, reason: 'prepare-for-later-price-opportunity' } });
    const window = display.planningDetails.find(row => row.key === 'pause-window');
    assert.notEqual(window.value, 'None');
    assert.match(window.detail, /no preheating/);
    assert.notEqual(Object.fromEntries(display.rows)['Planned pause endpoint'], 'No pause planned');
  }
});

test('validated OFF evidence is distinct from the planned minimum and has no pause ceiling', () => {
  const display = garageDisplay({ settings: garageSettings(), learning: {
    ...garageModelSummary(createGarageModel()), thermalReady: true, validatedOffHours: 1.5,
  }, plan: { pauseFrom: now, pauseUntil: now + 30 * 3600_000 } });
  const evidence = display.outcomeDetails.find(row => row.key === 'thermal-pause-duration');
  assert.equal(evidence.title, 'Validated OFF evidence');
  assert.equal(evidence.value, '1.5 h');
  assert.match(evidence.detail, /does not impose a maximum pause/);
  const minimum = display.planningDetails.find(row => row.key === 'pause-duration-limits');
  assert.equal(minimum.title, 'Minimum planned OFF time');
  assert.equal(minimum.value, '1 h');
  assert.match(minimum.detail, /no fixed maximum pause/);
  assert.match(minimum.detail, /Protection can always end a pause before the planned minimum/);
  assert.notEqual(display.planningDetails.find(row => row.key === 'pause-window').value, 'None');
  assert.match(display.planningDetails.find(row => row.key === 'restore-policy').detail, /does not cap its total length/);
});

test('Garage rendering fills the learning contexts and keeps reconstruction inside evidence', () => {
  const nodes = new Map(['garage-learning-context', 'garage-input-context', 'garage-coefficient-context'].map(id => [id, { textContent: '' }]));
  renderGarage({ getElementById: id => nodes.get(id) }, { garage: { learning: garageModelSummary(createGarageModel()) }, now });
  assert.match(nodes.get('garage-learning-context').textContent, /cooling and recovery checks/);
  assert.match(nodes.get('garage-input-context').textContent, /Missing readings remain unknown/);
  assert.match(nodes.get('garage-coefficient-context').textContent, /Only the rear and front cooling rates are fitted/);
  assert.equal(garageDisplay({ learning: { reconstruction: 'snapshot' } }).evidenceDetails.find(row => row.key === 'recorded-history-reconstruction').value, 'Recorded primary snapshot');
});

test('saved external room setting identifies active and fallback control while native 17°C remains unchanged', () => {
  const nodes = new Map(['garage-native-target', 'garage-native-target-basis'].map(id => [id,
    { textContent: '', hidden: true, classList: { toggle() {} } }]));
  const garage = { settings: {}, roomTemperature: { targetC: 5, phase: 'active', acknowledged: true, offsetC: 12 },
    adapter: { connected: true, health: { deviceOnline: true, pumpCommunicating: true }, baselineVerified: false, baselineAccepted: true,
      native: { targetC: 17, readbacks: { targetC: { measuredAt: now } } } } };
  const document = { getElementById: id => nodes.get(id) };
  renderGarage(document, { now, garage });
  assert.equal(nodes.get('garage-native-target').textContent, '5 °C');
  assert.equal(nodes.get('garage-native-target-basis').textContent, 'Garage rear · Active');
  assert.equal(nodes.get('garage-native-target-basis').hidden, false);
  assert.equal(garage.adapter.native.targetC, 17);
  const rows = Object.fromEntries(garageDisplay(garage).rows);
  assert.equal(rows['Native baseline independently verified'], 'No');
  assert.equal(rows['Native baseline accepted for control'], 'Yes');
  garage.roomTemperature.phase = 'waiting'; garage.roomTemperature.acknowledged = false;
  renderGarage(document, { now, garage: { roomTemperature: garage.roomTemperature } });
  assert.equal(nodes.get('garage-native-target').textContent, '5 °C', 'The saved target stays visible while waiting for an input');
  assert.equal(nodes.get('garage-native-target-basis').textContent, 'External sensor · Fallback');
  garage.roomTemperature = { targetC: null, phase: 'disabled' };
  renderGarage(document, { now, garage });
  assert.equal(nodes.get('garage-native-target').textContent, '17 °C');
  assert.equal(nodes.get('garage-native-target-basis').hidden, true);
});

test('automatic garage details omit absent native diagnostics instead of unavailable placeholders', () => {
  const rows=Object.fromEntries(garageDisplay({},now).rows);
  for(const label of ['Native power','Native mode','Native target','Pump indoor temperature','Pump outdoor temperature',
    'Electrical power','Native cumulative energy','Compressor frequency','Compressor / fan / defrost'])
    assert.equal(Object.hasOwn(rows,label),false,label);
});
