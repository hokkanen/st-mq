import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { assertWebRequest, webRequestAllowed, createWebSession, bindPasswordVisibility, createAccessControls } from '../chart/web-access.js';
import { createPollingRequest, fetchJsonResponse } from '../chart/network.js';

const admin = { role: 'admin', source: 'password' }, family = { role: 'family', source: 'password' };
const status = { equipment: { devices: [{ id: 'door', kind: 'door', area: 'garage', controls: { cover: { open: true, close: true, stop: false } } },
  { id: 'gate', kind: 'door', area: 'other', controls: { cover: { open: true } } }] } };

test('family requests allow household controls and reads while all other writes and downloads require admin', () => {
  for (const [path, data] of [
    ['/api/status'], ['/api/events?after=0'], ['/api/energy-audits'], ['/api/sensor-changes'], ['/api/pair'],
    ['/api/fireplace', { kg: 6 }], ['/api/fireplace/remove', { id: 3 }], ['/api/temporary', { awayUntil: null, pauseUntil: null }],
    ['/api/dhwr/stop', {}], ['/api/heating-test', { command: 'circulation' }], ['/api/heating-test', { command: 'preheat' }],
    ['/api/garage/heating', { mode: 'off' }], ['/api/garage/temporary', { pauseUntil: null }], ['/api/garage/release', {}],
    ['/api/equipment/cover', { deviceId: 'door', action: 'open' }], ['/api/charging/settings', { priority: [] }],
    ...['settings', 'control', 'charge-now', 'resume', 'target', 'identify'].map(action => [`/api/charging/chargers/test/${action}`, {}]),
  ]) assert.equal(webRequestAllowed(family, path, data, status), true, path);
  for (const [path, data] of [
    ['/api/database-export'], ['/api/database-export', {}], ['/api/downloads/floor-lease-script'],
    ['/api/settings/reload', {}], ['/api/sensor-changes', {}], ['/api/sensor-changes/retry-rebuild', {}],
    ['/api/equipment/switch', { deviceId: 'door', on: true }], ['/api/equipment/test', {}], ['/api/equipment/dehumidifier', {}],
    ['/api/equipment/h66', {}], ['/api/garage/native', {}], ['/api/pair/action', {}], ['/api/charging/ocpp-setup', {}],
    ['/api/heating-test', { command: 'commission' }], ['/api/garage/heating', { mode: 'power' }],
    ['/api/equipment/cover', { deviceId: 'gate', action: 'open' }], ['/api/equipment/cover', { deviceId: 'door', action: 'stop' }],
    ['/api/new-control', {}], ['/api/charging/chargers/test/new-control', {}],
  ]) {
    assert.equal(webRequestAllowed(family, path, data, status), false, path);
    assert.equal(webRequestAllowed(admin, path, data, status), true, path);
    assert.throws(() => assertWebRequest(family, path, data, status), { status: 403 });
  }
  assert.equal(webRequestAllowed(undefined, '/api/status'), true);
  assert.equal(webRequestAllowed(undefined, '/api/fireplace', {}), false);
});

function storageFixture() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('session requests work in appliance browsers without AbortSignal.any', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, 'any', descriptor));

  await t.test('status polling loads and retries through the dashboard request chain', async () => {
    const session = createWebSession({ storage: storageFixture() });
    session.login('invented-browser-password');
    let calls = 0;
    const poll = createPollingRequest(options => session.run(({ headers, signal }) =>
      fetchJsonResponse('/api/status', { headers, signal }, { fetchImpl: async (_url, request) => {
        calls++;
        assert.equal(request.headers.Authorization, 'Bearer invented-browser-password');
        assert.equal(request.signal.aborted, false);
        return { json: async () => ({ ready: true }) };
      } }), options));
    assert.deepEqual((await poll()).result, { ready: true });
    assert.deepEqual((await poll({ background: true })).result, { ready: true });
    assert.equal(calls, 2);
  });

  await t.test('caller cancellation before or during a request preserves its reason', async () => {
    for (const timing of ['before', 'queued', 'running']) {
      const session = createWebSession({ storage: storageFixture() });
      const caller = new AbortController(), reason = new Error('fixture cancellation');
      let calls = 0, requestSignal;
      if (timing === 'before') caller.abort(reason);
      const pending = session.run(({ signal }) => {
        calls++; requestSignal = signal;
        return new Promise(() => {});
      }, { signal: caller.signal });
      if (timing === 'running') await Promise.resolve();
      caller.abort(reason);
      await assert.rejects(pending, error => error === reason);
      assert.equal(calls, timing === 'running' ? 1 : 0);
      if (requestSignal) assert.equal(requestSignal.aborted, true);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    }
  });

  await t.test('logout and replacement login cancel caller-bound requests and fence late results', async () => {
    for (const action of ['logout', 'login']) {
      const session = createWebSession({ storage: storageFixture() });
      const caller = new AbortController();
      let complete, requestSignal;
      const pending = session.run(({ signal }) => {
        requestSignal = signal;
        return new Promise(resolve => { complete = resolve; });
      }, { signal: caller.signal });
      await Promise.resolve();
      session[action]('invented-next-browser-password');
      await assert.rejects(pending, { status: 401 });
      assert.equal(requestSignal.aborted, true);
      assert.equal(caller.signal.aborted, false);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
      complete('obsolete');
      await assert.rejects(pending, { status: 401 });
    }
  });

  await t.test('success, failure and cancellation release all source listeners', async t => {
    const observed = new Set(), add = AbortSignal.prototype.addEventListener;
    t.mock.method(AbortSignal.prototype, 'addEventListener', function (...args) {
      observed.add(this);
      return add.apply(this, args);
    });
    const session = createWebSession({ storage: storageFixture() });
    const caller = new AbortController();
    assert.equal(await session.run(() => 12, { signal: caller.signal }), 12);
    for (const signal of observed) assert.equal(getEventListeners(signal, 'abort').length, 0);
    await assert.rejects(session.run(() => { throw Error('fixture failure'); }, { signal: caller.signal }), /fixture failure/);
    for (const signal of observed) assert.equal(getEventListeners(signal, 'abort').length, 0);
    const pending = session.run(() => new Promise(() => {}), { signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(observed.size, 2);
    for (const signal of observed) assert.equal(getEventListeners(signal, 'abort').length, 0);
  });
});

test('logout removes credentials and pending actions, aborts requests, and prevents late responses and automatic reconnection', async () => {
  const storage = storageFixture(), session = createWebSession({ storage });
  session.login('invented-family-browser-password');
  for (const key of ['stmq-fireplace-pending', 'stmq-sensor-change-pending', 'stmq-pair-pending-v1']) storage.setItem(key, '{}');
  let finish, signal, calls = 0;
  const pending = session.run(options => {
    calls++; signal = options.signal;
    assert.equal(options.headers.Authorization, 'Bearer invented-family-browser-password');
    return new Promise(resolve => { finish = resolve; });
  });
  await Promise.resolve();
  session.logout();
  assert.equal(signal.aborted, true);
  assert.equal(session.token, '');
  assert.deepEqual([...storage.values], [['stmq-logged-out', 'true']]);
  await assert.rejects(pending, { status: 401 });
  finish({ private: 'late result' });
  await assert.rejects(session.run(() => { calls++; }), { status: 401 });
  const reloaded = createWebSession({ storage });
  assert.equal(reloaded.locked, true);
  await assert.rejects(reloaded.run(() => { calls++; }), { status: 401 });
  assert.equal(calls, 1);
  reloaded.login('invented-admin-browser-password');
  assert.equal(reloaded.locked, false);
  assert.equal(storage.getItem('stmq-logged-out'), null);
  assert.equal(await reloaded.run(({ headers }) => headers.Authorization), 'Bearer invented-admin-browser-password');
});

test('ingress ignores stored credentials and a direct-login logout marker', async () => {
  const storage = storageFixture();
  storage.setItem('stmq-token', 'invented-saved-browser-password'); storage.setItem('stmq-logged-out', 'true');
  const session = createWebSession({ storage, ingress: true });
  assert.equal(session.locked, false);
  assert.deepEqual(await session.run(({ headers }) => headers), {});
});

test('a cancelled request cannot begin later with the previous password', async () => {
  const storage = storageFixture(), session = createWebSession({ storage });
  session.login('invented-first-browser-password');
  let called = false;
  const request = session.run(() => { called = true; });
  session.logout(); session.login('invented-next-browser-password');
  await assert.rejects(request, { status: 401 });
  assert.equal(called, false);
});

test('password visibility is explicit and resets to hidden', () => {
  const events = {}, attributes = {};
  const input = { type: 'password', value: 'invented-browser-password' };
  const button = { textContent: 'eye icon', addEventListener: (event, handler) => { events[event] = handler; }, setAttribute: (name, value) => { attributes[name] = value; } };
  const toggle = bindPasswordVisibility({ input, button });
  assert.equal(attributes['aria-label'], 'Show password');
  events.click(); assert.equal(input.type, 'text'); assert.equal(attributes['aria-label'], 'Hide password'); assert.equal(attributes['aria-pressed'], 'true');
  events.click(); assert.equal(input.type, 'password');
  events.click(); toggle.hide(); assert.equal(input.type, 'password'); assert.equal(attributes['aria-pressed'], 'false');
  assert.equal(attributes['aria-label'], 'Show password'); assert.equal(attributes.title, 'Show password');
  assert.equal(button.textContent, 'eye icon', 'toggling keeps the SVG content intact');
  assert.equal(input.value, 'invented-browser-password');
});

function accessFixture() {
  const listeners = new Map(), nodes = new Map();
  class Element {
    constructor(id) { this.id = id; this.dataset = {}; this.attributes = new Map(); this.disabled = false; this.isConnected = true; this.hidden = false; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches() { return true; }
    closest() { return scopes.includes(this) ? this : null; }
  }
  for (const id of ['web-access-role', 'web-logout', 'export', 'native-write', 'native-read']) nodes.set(id, new Element(id));
  const scopes = [nodes.get('export'), nodes.get('native-write')];
  nodes.get('native-write').disabled = true;
  let observe;
  const document = { body: { dataset: {} }, getElementById: id => nodes.get(id), querySelectorAll: () => scopes,
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  class Observer { constructor(callback) { observe = callback; } observe() {} disconnect() {} }
  return { document, Observer, nodes, listeners, scopes, rerender: () => observe() };
}

test('family restrictions survive rerenders and preserve read navigation; ingress shows admin without logout', () => {
  const fixture = accessFixture(), { nodes } = fixture;
  const controls = createAccessControls(fixture);
  controls.update(family);
  assert.equal(nodes.get('export').disabled, true);
  assert.equal(nodes.get('native-read').disabled, false);
  assert.equal(nodes.get('web-access-role').textContent, 'Signed in as Family');
  assert.equal(nodes.get('web-logout').hidden, false);
  nodes.get('export').disabled = false; fixture.rerender();
  assert.equal(nodes.get('export').disabled, true);
  let stopped = false;
  fixture.listeners.get('click')({ target: { closest: () => nodes.get('export') }, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true);
  controls.update({ role: 'admin', source: 'ingress' });
  assert.equal(nodes.get('export').disabled, false);
  assert.equal(nodes.get('native-write').disabled, true, 'native availability remains separate from access permission');
  assert.equal(nodes.get('web-access-role').textContent, 'Admin via Home Assistant');
  assert.equal(nodes.get('web-logout').hidden, true);
  controls.close();
});


test('a configured control moving into the family scope loses stale admin restriction metadata', () => {
  const fixture = accessFixture(), control = fixture.nodes.get('export');
  const controls = createAccessControls(fixture);
  controls.update(family);
  assert.equal(control.disabled, true);
  fixture.scopes.splice(fixture.scopes.indexOf(control), 1);
  control.disabled = false; // The equipment renderer recalculates native availability.
  fixture.rerender();
  assert.equal(control.disabled, false);
  assert.equal(control.getAttribute('aria-disabled'), null);
  assert.equal(control.getAttribute('title'), null);
  fixture.scopes.push(control); fixture.rerender();
  assert.equal(control.disabled, true);
  controls.close();
});
