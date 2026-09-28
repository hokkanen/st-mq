import test from 'node:test';
import assert from 'node:assert/strict';
import { automationView, createAutomationControls } from '../chart/automation-controls.js';

const status = () => ({ input: 'providers', automation: {
  home: { enabled: false, available: true, activity: 'Plan only' },
  garage: { enabled: true, available: true, activity: 'Waiting for cheaper electricity' },
} });

test('mixed automation renders each permission without assigning global authority', () => {
  const value = status();
  assert.equal(automationView(value, 'home').enabled, false);
  assert.equal(automationView(value, 'garage').enabled, true);
  assert.equal(automationView(value, 'garage').activity, 'Waiting for cheaper electricity');
  for (const patch of [{ input: 'offline' }, { role: 'slave' }]) {
    assert.equal(automationView({ ...value, ...patch }, 'garage').available, false);
    assert.match(automationView({ ...value, ...patch }, 'garage').activity, /Recorded/);
  }
});

function fixture(request) {
  const nodes = new Map();
  for (const feature of ['home', 'garage']) for (const suffix of ['plan', 'automatic', 'activity', 'message']) {
    nodes.set(`${feature}-automation-${suffix}`, { disabled: false, textContent: '', attrs: {},
      classList: { add() {}, remove() {} }, setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, handler) { this[name] = handler; } });
  }
  const panel = createAutomationControls({ document: { getElementById: id => nodes.get(id) }, request,
    onStatus() {} });
  panel.update(status());
  return { panel, node: id => nodes.get(id) };
}

test('one feature change sends only its permission and leaves the other selection intact', async () => {
  const calls = [];
  const f = fixture(async (path, body) => {
    calls.push([path, body]); const next = status(); next.automation.home.enabled = true; return next;
  });
  await f.node('home-automation-automatic').click();
  assert.deepEqual(calls, [['/api/automation', { feature: 'home', enabled: true }]]);
  assert.equal(f.node('home-automation-automatic').attrs['aria-pressed'], 'true');
  assert.equal(f.node('garage-automation-automatic').attrs['aria-pressed'], 'true');
  assert.match(f.node('home-automation-message').textContent, /saved/);
});

test('failed saves do not change selected permission and replica changes never submit', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Equipment identity changed'); });
  await f.node('home-automation-automatic').click();
  assert.equal(f.node('home-automation-plan').attrs['aria-pressed'], 'true');
  assert.match(f.node('home-automation-message').textContent, /identity changed/);
  f.panel.update({ ...status(), role: 'slave' });
  await f.node('home-automation-automatic').click();
  assert.equal(calls, 1);
  assert.equal(f.node('home-automation-automatic').disabled, true);
});
