import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyControls, assertDashboardWrite } from '../chart/dashboard-access.js';

function fixture() {
  const listeners = new Map(), scopes = [];
  const make = () => ({ disabled: false, isConnected: true, attributes: new Map(),
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    matches: () => true, closest(selector) { return selector === '[data-live-door-control]'
      ? this.attributes.has('data-live-door-control') ? this : null : scopes.includes(this) ? this : null; } });
  const apply = make(), unsupported = make(), navigate = make(), download = make(), door = make();
  door.setAttribute('data-live-door-control', '');
  unsupported.disabled = true; scopes.push(apply, unsupported, door);
  let render;
  class Observer { constructor(callback) { render = callback; } observe() {} disconnect() {} }
  const document = { body: {}, querySelectorAll: () => scopes, getElementById: () => null,
    addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type) };
  return { document, Observer, apply, unsupported, navigate, download, door, rerender: () => render(),
    event(type, target) {
      let stopped = false, prevented = false;
      listeners.get(type)?.({ target, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
      return { stopped, prevented };
    } };
}

test('read-only permissions survive renderer updates and synthetic events while keeping navigation and download usable', () => {
  const view = fixture(), access = createReadOnlyControls(view);
  access.update({ role: 'slave' });
  assert.equal(view.apply.disabled, true);
  assert.equal(view.navigate.disabled, false);
  assert.equal(view.download.disabled, false);
  view.apply.disabled = false; view.rerender();
  assert.equal(view.apply.disabled, true, 'late panel rendering cannot enable a write');
  for (const type of ['click', 'submit', 'change', 'input']) {
    assert.deepEqual(view.event(type, view.apply), { stopped: true, prevented: true });
    assert.deepEqual(view.event(type, view.navigate), { stopped: false, prevented: false });
  }
  access.update({ topology: 'pair', pair: { role: 'master', canControl: false } });
  assert.equal(view.apply.disabled, true, 'a role label alone never grants mutation access');
  access.update({ role: 'slave', topology: 'pair', pair: { role: 'master', canControl: true } });
  assert.equal(view.apply.disabled, true, 'a stale replica status stays locked during promotion');
  access.update({ role: 'master', topology: 'pair', pair: { role: 'master', canControl: true } });
  assert.equal(view.apply.disabled, false);
  assert.equal(view.unsupported.disabled, true, 'native capability checks still apply after promotion');
  assert.deepEqual(view.event('submit', view.apply), { stopped: false, prevented: false });
  access.close();
});

test('only live door controls bypass writer loss while replica, context and native locks remain binding', () => {
  const view = fixture(), access = createReadOnlyControls(view);
  access.update({ ...writerStatus('unavailable'), role: 'slave' });
  assert.equal(view.door.disabled, true);
  for (const state of ['confirming', 'unavailable', 'stopped']) {
    const status = writerStatus(state);
    access.update(status);
    assert.equal(view.door.disabled, false); assert.equal(view.apply.disabled, true);
    assert.deepEqual(view.event('click', view.door), { prevented: false, stopped: false });
    assert.doesNotThrow(() => assertDashboardWrite('/api/equipment/cover', { deviceId: 'door', action: 'open' }, status));
    assert.throws(() => assertDashboardWrite('/api/charging/chargers/charger1/charge-now', {}, status), { status: 503 });
    assert.throws(() => assertDashboardWrite('/api/garage/heating', {}, status), { status: 503 });
    access.update({ ...status, storageContextPending: true });
    assert.equal(view.door.disabled, true);
    assert.deepEqual(view.event('click', view.door), { prevented: true, stopped: true });
    assert.throws(() => assertDashboardWrite('/api/equipment/cover', {}, { ...status, storageContextPending: true }), { status: 503 });
    access.update(status); assert.equal(view.door.disabled, false);
  }
  view.door.disabled = true; access.update(writerStatus('unavailable')); view.rerender();
  assert.equal(view.door.disabled, true, 'Storage independence cannot enable an unavailable native door');
  for (const status of [null, { ...writerStatus('unavailable'), role: 'slave' },
    { ...writerStatus('unavailable'), topology: 'pair', pair: { role: 'master', canControl: false } }]) {
    assert.throws(() => assertDashboardWrite('/api/equipment/cover', {}, status), { status: 403 });
  }
  access.close();
});

test('saved-copy verification is an explicit read-only inspection with a bounded source identifier', () => {
  const status = { role: 'slave' };
  assert.doesNotThrow(() => assertDashboardWrite('/api/recording-backups/verify', { sourceId: 'a'.repeat(64) }, status));
  for (const input of [{}, { sourceId: '/private/path' }, { sourceId: 'a'.repeat(64), path: '/private/path' }])
    assert.throws(() => assertDashboardWrite('/api/recording-backups/verify', input, status), { status: 403 });
  assert.throws(() => assertDashboardWrite('/api/recording-backups/verify', { sourceId: 'a'.repeat(64) }, null), { status: 403 });
});

test('instance-local verification actions work on a slave without granting main-database write authority', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  for (const status of [{ role: 'slave' }, writerStatus('unavailable')]) {
    for (const action of ['verify', 'pause', 'resume', 'cancel', 'discard'])
      assert.doesNotThrow(() => assertDashboardWrite('/api/model-reconstruction/action', { action, requestId }, status));
    assert.throws(() => assertDashboardWrite('/api/automation', { enabled: true }, status));
    for (const body of [{ action: 'verify' }, { action: 'build', requestId }, { action: 'verify', requestId, includeHistory: true },
      { action: 'discard', requestId, path: '/private/path' }, { action: 'set-enabled', requestId, enabled: true }])
      assert.throws(() => assertDashboardWrite('/api/model-reconstruction/action', body, status));
  }
  assert.throws(() => assertDashboardWrite('/api/model-reconstruction/action', { action: 'verify', requestId }, null), { status: 403 });
});

const writerStatus = state => ({ role: 'master', input: 'simulated', recordingHealth: { version: 3, scope: 'simulated', checkedAt: 100,
  recording: { writer: { state } } } });

test('writer confirmation and loss restrict mutations while saving and read-only inspections remain usable', () => {
  const view = fixture(), access = createReadOnlyControls(view);
  for (const state of ['ready', 'saving', 'unknown']) {
    access.update(writerStatus(state));
    assert.equal(view.apply.disabled, false, state);
    assert.doesNotThrow(() => assertDashboardWrite('/api/automation', { enabled: true }, writerStatus(state)));
  }
  for (const state of ['confirming', 'unavailable', 'stopped']) {
    access.update(writerStatus(state));
    assert.equal(view.apply.disabled, true, state);
    assert.equal(view.navigate.disabled, false);
    assert.equal(view.download.disabled, false);
    assert.deepEqual(view.event('click', view.apply), { stopped: true, prevented: true });
    assert.throws(() => assertDashboardWrite('/api/automation', { enabled: true }, writerStatus(state)), { status: 503 });
    assert.doesNotThrow(() => assertDashboardWrite('/api/status', undefined, writerStatus(state)));
    assert.doesNotThrow(() => assertDashboardWrite('/api/database-verification', {}, writerStatus(state)));
    assert.doesNotThrow(() => assertDashboardWrite('/api/recording-backups/verify', { sourceId: 'a'.repeat(64) }, writerStatus(state)));
    view.apply.disabled = false; view.rerender();
    assert.equal(view.apply.disabled, true, 'a later panel render cannot unlock an unavailable writer');
  }
  access.update({ role: 'master', input: 'simulated' });
  assert.equal(view.apply.disabled, true, 'action replies without health cannot dismiss writer loss');
  access.update(writerStatus('ready'));
  assert.equal(view.apply.disabled, false);
  assert.equal(view.unsupported.disabled, true);
  access.update({ ...writerStatus('ready'), role: 'slave' });
  assert.equal(view.apply.disabled, true, 'writer readiness cannot grant replica authority');
  access.close();
});
