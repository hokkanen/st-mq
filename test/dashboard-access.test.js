import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyControls } from '../chart/dashboard-access.js';

function fixture() {
  const listeners = new Map(), scopes = [];
  const make = () => ({ disabled: false, isConnected: true, attributes: new Map(),
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    matches: () => true, closest() { return scopes.includes(this) ? this : null; } });
  const apply = make(), unsupported = make(), navigate = make(), download = make();
  unsupported.disabled = true; scopes.push(apply, unsupported);
  let render;
  class Observer { constructor(callback) { render = callback; } observe() {} disconnect() {} }
  const document = { body: {}, querySelectorAll: () => scopes, getElementById: () => null,
    addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type) };
  return { document, Observer, apply, unsupported, navigate, download, rerender: () => render(),
    event(type, target) {
      let stopped = false, prevented = false;
      listeners.get(type)?.({ target, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
      return { stopped, prevented };
    } };
}

test('read-only permissions survive renderer updates and synthetic events while keeping navigation and download usable', () => {
  const view = fixture(), access = createReadOnlyControls(view);
  access.update({ role: 'replica' });
  assert.equal(view.apply.disabled, true);
  assert.equal(view.navigate.disabled, false);
  assert.equal(view.download.disabled, false);
  view.apply.disabled = false; view.rerender();
  assert.equal(view.apply.disabled, true, 'late panel rendering cannot enable a write');
  for (const type of ['click', 'submit', 'change', 'input']) {
    assert.deepEqual(view.event(type, view.apply), { stopped: true, prevented: true });
    assert.deepEqual(view.event(type, view.navigate), { stopped: false, prevented: false });
  }
  access.update({ pairing: { enabled: true, role: 'primary', canControl: false } });
  assert.equal(view.apply.disabled, true, 'a role label alone never grants mutation access');
  access.update({ role: 'replica', pairing: { enabled: true, role: 'primary', canControl: true } });
  assert.equal(view.apply.disabled, true, 'a stale replica status stays locked during promotion');
  access.update({ role: 'primary', pairing: { enabled: true, role: 'primary', canControl: true } });
  assert.equal(view.apply.disabled, false);
  assert.equal(view.unsupported.disabled, true, 'native capability checks still apply after promotion');
  assert.deepEqual(view.event('submit', view.apply), { stopped: false, prevented: false });
  access.close();
});
