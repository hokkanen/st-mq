import test from 'node:test';
import assert from 'node:assert/strict';
import { createFireplaceActions, createFireplacePanel, fireplaceTime, fireplaceView } from '../chart/fireplace.js';

const now = Date.parse('2026-09-09T15:00:00Z');
const entry = (id = 1, at = now, kg = 8) => ({ id, at, kg, removedAt: null, requiresRebuild: false });
const view = (revision = 0, entries = []) => ({ available: true, revision, entries, lastAt: entries[0]?.at ?? null, rebuild: { status: 'idle' } });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('firewood submissions accept whole kilograms only, block double-clicks, and allow a new load immediately after saving', async () => {
  let resolve, nextId = 0;
  const requests = [];
  const actions = createFireplaceActions({ makeRequestId: () => `request-${++nextId}`, request: (path, body) => {
    requests.push({ path, body }); return new Promise(done => { resolve = done; });
  } });
  actions.update(view());
  for (const kg of [1, 11, 2.5, '8', null]) assert.equal(await actions.add(kg), false);
  const first = actions.add(8);
  assert.equal(await actions.add(8), false);
  assert.equal(requests.length, 1);
  resolve(view(1, [entry()])); assert.equal(await first, true);
  const second = actions.add(8);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].body.requestId, requests[1].body.requestId);
  resolve(view(2, [entry(2), entry()])); await second;
  assert.equal(actions.snapshot().view.entries.length, 2);
  assert.equal(actions.snapshot().pending, null);
});

test('an unconfirmed save survives a page reload and retries the same kilograms and identifier', async () => {
  const storage = memoryStorage(), requests = [];
  const original = createFireplaceActions({ storage, makeRequestId: () => 'original-id', request: async (path, body) => {
    requests.push({ path, body }); throw new TypeError('Network disconnected');
  } });
  original.update(view());
  assert.equal(await original.add(8), false);
  assert.match(original.snapshot().message, /without adding a duplicate/);
  assert.equal(await original.add(2), false, 'a changed amount cannot silently replace an uncertain submission');
  const restored = createFireplaceActions({ storage, makeRequestId: () => 'must-not-be-used', request: async (path, body) => {
    requests.push({ path, body }); return view(1, [entry()]);
  } });
  restored.update(view(1, [entry()])); // The first request might already have committed.
  assert.equal(restored.snapshot().pending.body.kg, 8);
  assert.equal(await restored.retry(), true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(restored.snapshot().pending, null);
  assert.equal(createFireplaceActions({ storage, request: async () => {} }).snapshot().pending, null);
});

test('definite request rejection permits a fresh entry, without displaying backend error details', async () => {
  let calls = 0;
  const actions = createFireplaceActions({ request: async () => {
    if (!calls++) throw Object.assign(new Error('private server details'), { status: 400 });
    return view(1, [entry(1, now, 2)]);
  } });
  actions.update(view());
  assert.equal(await actions.add(8), false);
  assert.equal(actions.snapshot().pending, null);
  assert(!actions.snapshot().message.includes('private'));
  assert.equal(await actions.add(2), true);
});

test('uncertain removal can be retried even when a refresh no longer lists the removed entry', async () => {
  const bodies = []; let attempts = 0;
  const actions = createFireplaceActions({ request: async (path, body) => {
    bodies.push({ path, body }); if (!attempts++) throw new Error('connection lost after commit');
    return { ...view(2), rebuild: { status: 'running' } };
  } });
  actions.update(view(1, [entry()]));
  await actions.remove(1);
  actions.update(view(2));
  assert.equal(await actions.add(8), false);
  assert.equal(await actions.retry(), true);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.match(actions.snapshot().message, /updating model in background/);
  actions.update(view(2));
  assert.equal(actions.snapshot().message, 'Entry removed · model updated.');
});

test('old status responses cannot overwrite a mutation or roll back its history revision', async () => {
  let complete;
  const actions = createFireplaceActions({ request: () => new Promise(resolve => { complete = resolve; }) });
  actions.update(view(1));
  const mutation = actions.add(10);
  actions.update(view(2, [entry(2)]));
  assert.equal(actions.snapshot().view.revision, 1, 'periodic snapshots are ignored while saving');
  complete(view(3, [entry(3)])); await mutation;
  actions.update(view(2));
  assert.equal(actions.snapshot().view.revision, 3);
  assert.equal(actions.snapshot().view.entries[0].id, 3);
});

test('recent history uses Finnish time, preserves close entries, excludes removed/outside-window entries, and reports rebuilding honestly', () => {
  const history = [entry(1, now - 49 * 3600_000), entry(2, now), entry(3, now),
    { ...entry(4), removedAt: now }, entry(5, now + 60_000), entry(6, now - 47 * 3600_000, 2)];
  const summary = fireplaceView(view(1, history), now);
  assert.deepEqual(summary.entries.map(row => row.id), [3, 2, 6]);
  assert.equal(summary.total, '3 entries · 18 kg');
  assert.equal(fireplaceTime(now, now), 'Today, 18:00:00');
  assert.equal(fireplaceTime(Date.parse('2026-01-09T15:00:00Z'), Date.parse('2026-01-09T15:00:00Z')), 'Today, 17:00:00');
  assert.equal(fireplaceView({ ...view(), rebuild: { status: 'running' } }, now).modelStatus, 'Updating model · heating control continues');
  const failed = fireplaceView({ ...view(), rebuild: { status: 'failed', error: 'private details' } }, now);
  assert.match(failed.modelStatus, /correction remains saved/);
  assert(!failed.modelStatus.includes('private'));
});

function panelFixture(request = async () => view()) {
  const ids = ['fireplace-kg', 'fireplace-amount', 'fireplace-form', 'fireplace-submit', 'fireplace-content',
    'fireplace-message', 'fireplace-retry', 'fireplace-model-status', 'fireplace-overview', 'fireplace-total',
    'fireplace-empty', 'fireplace-entries', 'fireplace-details'];
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: () => new Element() };
  class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.events = new Map(); this.value = ''; this.classes = new Set();
      this.classList = { toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child, sibling) { child.remove(); child.parent = this; const at = sibling ? this.children.indexOf(sibling) : this.children.length; this.children.splice(at, 0, child); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    focus() { document.activeElement = this; }
  }
  for (const id of ids) nodes.set(id, new Element());
  nodes.get('fireplace-kg').value = '8';
  const panel = createFireplacePanel({ document, request });
  return { panel, document, $: id => nodes.get(id) };
}

test('refreshes preserve the open fold, selected kilograms, focus, and existing row controls', () => {
  const { panel, document, $ } = panelFixture();
  panel.update(view(1, [entry()]), now);
  $('fireplace-details').open = true;
  $('fireplace-kg').value = '6'; $('fireplace-kg').events.get('input')(); $('fireplace-kg').focus();
  const firstRow = $('fireplace-entries').children[0];
  panel.update(view(1, [entry()]), now);
  assert.equal($('fireplace-kg').value, '6'); assert.equal($('fireplace-amount').textContent, '6 kg');
  assert.equal($('fireplace-details').open, true); assert.equal(document.activeElement, $('fireplace-kg'));
  assert.equal($('fireplace-entries').children[0], firstRow);
  const remove = firstRow.children[1]; remove.focus();
  panel.update(view(2, [entry(2), entry()]), now);
  assert.equal(document.activeElement, remove);
  assert.equal($('fireplace-entries').children[1], firstRow);
  panel.update(view(3, [entry(2)]), now);
  assert.equal(document.activeElement, $('fireplace-submit'), 'removing a focused row leaves focus at a useful control');
});

test('rebuild requirement is shown on the affected row and recording works while the model rebuilds', () => {
  const { panel, $ } = panelFixture();
  panel.update({ ...view(1, [{ ...entry(), requiresRebuild: true }]), rebuild: { status: 'running' } }, now);
  assert.equal($('fireplace-submit').disabled, false);
  assert.equal($('fireplace-kg').disabled, false);
  assert.match($('fireplace-entries').children[0].children[0].children[2].textContent, /background/);
  panel.update({ ...view(2), available: false }, now);
  assert.equal($('fireplace-submit').disabled, true);
});
