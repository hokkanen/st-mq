import test from 'node:test';
import assert from 'node:assert/strict';
import { automationView, createAutomationControls } from '../chart/automation-controls.js';

const status = () => ({ input: 'providers', automation: {
  home: { enabled: false, available: true, activity: 'paused' },
} });

test('Home automation remains independent of the manual Garage selection', () => {
  const value = status();
  assert.equal(automationView(value, 'home').enabled, false);
  for (const patch of [{ input: 'offline' }, { role: 'slave' }]) {
    assert.equal(automationView({ ...value, ...patch }, 'home').available, false);
    assert.match(automationView({ ...value, ...patch }, 'home').activity, /Recorded/);
  }
});

function fixture(request) {
  const nodes = new Map();
  for (const feature of ['home']) for (const suffix of ['pause', 'automatic', 'activity', 'message']) {
    nodes.set(`${feature}-automation-${suffix}`, { disabled: false, textContent: '', attrs: {},
      classList: { add() {}, remove() {} }, setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, handler) { this[name] = handler; } });
  }
  const panel = createAutomationControls({ document: { getElementById: id => nodes.get(id) }, request,
    onStatus() {} });
  panel.update(status());
  return { panel, node: id => nodes.get(id) };
}

test('Home automation sends only its own persistent permission', async () => {
  const calls = [];
  const f = fixture(async (path, body) => {
    calls.push([path, body]); const next = status(); next.automation.home.enabled = true; return next;
  });
  await f.node('home-automation-automatic').click();
  assert.deepEqual(calls, [['/api/automation', { feature: 'home', enabled: true }]]);
  assert.equal(f.node('home-automation-automatic').attrs['aria-pressed'], 'true');
  assert.match(f.node('home-automation-message').textContent, /resumed/);
});

test('failed saves do not change selected permission and replica changes never submit', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Equipment identity changed'); });
  await f.node('home-automation-automatic').click();
  assert.equal(f.node('home-automation-pause').attrs['aria-pressed'], 'true');
  assert.match(f.node('home-automation-message').textContent, /identity changed/);
  f.panel.update({ ...status(), role: 'slave' });
  await f.node('home-automation-automatic').click();
  assert.equal(calls, 1);
  assert.equal(f.node('home-automation-automatic').disabled, true);
});


test('a later authoritative mode save resolves an uncertain HTTP response', async () => {
  const f = fixture(async () => { throw new Error('Response lost'); });
  const initial = status(); initial.automation.home.revision = 3; f.panel.update(initial);
  await f.node('home-automation-automatic').click();
  assert.match(f.node('home-automation-message').textContent, /Response lost/);
  f.panel.update(initial);
  assert.match(f.node('home-automation-message').textContent, /Response lost/);
  const confirmed = status(); confirmed.automation.home = { enabled: true, available: true, activity: 'automatic', revision: 4 };
  f.panel.update(confirmed);
  assert.match(f.node('home-automation-message').textContent, /Automatic heating is saved/);
});
