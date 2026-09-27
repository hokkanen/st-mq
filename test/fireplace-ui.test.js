import test from 'node:test';
import assert from 'node:assert/strict';
import { createFireplaceActions, createFireplacePanel, fireplaceTime, fireplaceView, fireplaceRemovalAllowed } from '../chart/fireplace.js';

const now = Date.parse('2026-09-09T15:00:00Z');
const entry = (id = 1, at = now, kg = 8) => ({ id, at, kg, removedAt: null, requiresRebuild: false, canRemove: true });
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

function panelFixture(request = async () => view(), storage) {
  const ids = ['fireplace-kg', 'fireplace-amount', 'fireplace-form', 'fireplace-submit', 'fireplace-content',
    'fireplace-message', 'fireplace-retry', 'fireplace-model-status', 'fireplace-overview', 'fireplace-total',
    'fireplace-empty', 'fireplace-entries', 'fireplace-dialog', 'fireplace-close', 'fireplace-shortcut'];
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: () => new Element() };
  class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.events = new Map(); this.value = ''; this.classes = new Set();
      this.open = false; this.disabled = false; this.hidden = false; this.isConnected = true; this.dataset = {};
      this.classList = { toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    dispatch(name) {
      const event = { target: this, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
      this.events.get(name)?.(event); return event;
    }
    click() { if (!this.disabled) return this.dispatch('click'); }
    showModal() { assert.equal(this.open, false); this.open = true; }
    close() { if (this.open) { this.open = false; this.dispatch('close'); } }
    escape() { if (!this.dispatch('cancel').defaultPrevented) this.close(); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child, sibling) { child.remove(); child.parent = this; const at = sibling ? this.children.indexOf(sibling) : this.children.length; this.children.splice(at, 0, child); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    focus() { document.activeElement = this; }
  }
  for (const id of ids) nodes.set(id, new Element());
  nodes.get('fireplace-kg').value = '8';
  const panel = createFireplacePanel({ document, request, storage });
  return { panel, document, $: id => nodes.get(id) };
}

test('the fireplace shortcut opens independently and Close or Escape returns focus', () => {
  const { panel, document, $ } = panelFixture();
  panel.update(view(), now);
  assert.equal($('fireplace-dialog').open, false);
  $('fireplace-shortcut').focus();
  const event = $('fireplace-shortcut').click();
  assert.equal(event.defaultPrevented, true, 'the Home summary does not toggle');
  assert.equal(event.propagationStopped, true);
  assert.equal($('fireplace-dialog').open, true);
  assert.equal($('fireplace-shortcut').getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, $('fireplace-kg'));
  $('fireplace-close').click();
  assert.equal($('fireplace-dialog').open, false);
  assert.equal($('fireplace-shortcut').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, $('fireplace-shortcut'));
  $('fireplace-shortcut').click(); $('fireplace-dialog').escape();
  assert.equal($('fireplace-dialog').open, false);
  assert.equal(document.activeElement, $('fireplace-shortcut'));
});

test('refreshes and reopening preserve selected kilograms, focus, and existing row controls', () => {
  const { panel, document, $ } = panelFixture();
  panel.update(view(1, [entry()]), now);
  $('fireplace-shortcut').click();
  $('fireplace-kg').value = '6'; $('fireplace-kg').events.get('input')(); $('fireplace-kg').focus();
  const firstRow = $('fireplace-entries').children[0];
  panel.update(view(1, [entry()]), now);
  assert.equal($('fireplace-kg').value, '6'); assert.equal($('fireplace-amount').textContent, '6 kg');
  assert.equal($('fireplace-dialog').open, true); assert.equal(document.activeElement, $('fireplace-kg'));
  assert.equal($('fireplace-entries').children[0], firstRow);
  const remove = firstRow.children[1]; remove.focus();
  panel.update(view(2, [entry(2), entry()]), now);
  assert.equal(document.activeElement, remove);
  assert.equal($('fireplace-entries').children[1], firstRow);
  panel.update(view(3, [entry(2)]), now);
  assert.equal(document.activeElement, $('fireplace-submit'), 'removing a focused row leaves focus at a useful control');
  $('fireplace-close').click(); panel.update(view(3, [entry(2)]), now);
  assert.equal($('fireplace-dialog').open, false, 'background updates leave the dialog closed');
  $('fireplace-shortcut').click();
  assert.equal($('fireplace-kg').value, '6');
  assert.equal($('fireplace-amount').textContent, '6 kg');
  assert.equal(document.activeElement, $('fireplace-kg'));
});

test('restored unconfirmed saves open once after availability and retry the original entry', async () => {
  const storage = memoryStorage(), calls = [];
  const pending = { path: '/api/fireplace', body: { requestId: 'recovered-request', kg: 4 } };
  storage.setItem('stmq-fireplace-pending', JSON.stringify(pending));
  const { panel, document, $ } = panelFixture(async (path, body) => {
    calls.push({ path, body }); return view(1, [entry(1, now, 4)]);
  }, storage);
  assert.equal($('fireplace-dialog').open, false, 'initial status has not established availability');
  panel.update({ ...view(), available: false }, now);
  assert.equal($('fireplace-dialog').open, false);
  panel.update(view(), now);
  assert.equal($('fireplace-dialog').open, true);
  assert.equal(document.activeElement, $('fireplace-retry'));
  assert.equal($('fireplace-kg').value, '4');
  assert.equal($('fireplace-submit').disabled, true);
  assert.equal(calls.length, 0, 'recovering the dialog does not silently retry the write');
  $('fireplace-close').click(); panel.update(view(), now);
  assert.equal($('fireplace-dialog').open, false, 'a dismissed recovery stays closed on later polls');
  $('fireplace-shortcut').click();
  assert.equal(document.activeElement, $('fireplace-retry'));
  $('fireplace-retry').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [pending]);
  assert.equal(storage.getItem('stmq-fireplace-pending'), null);
  assert.equal($('fireplace-retry').hidden, true);
  assert.equal($('fireplace-submit').disabled, false);
  assert.equal($('fireplace-entries').children.length, 1);
});

test('closing during recording keeps the pending save and its eventual result', async () => {
  let finish;
  const storage = memoryStorage(), calls = [];
  const { panel, document, $ } = panelFixture((path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  }, storage);
  panel.update(view(), now); $('fireplace-shortcut').click();
  $('fireplace-form').dispatch('submit');
  assert.equal($('fireplace-content').getAttribute('aria-busy'), 'true');
  assert.equal(calls.length, 1);
  assert(storage.getItem('stmq-fireplace-pending'));
  $('fireplace-close').click();
  assert.equal($('fireplace-dialog').open, false);
  assert.equal(document.activeElement, $('fireplace-shortcut'));
  finish(view(1, [entry()]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($('fireplace-dialog').open, false);
  assert.equal($('fireplace-content').getAttribute('aria-busy'), 'false');
  assert.equal(storage.getItem('stmq-fireplace-pending'), null);
  $('fireplace-shortcut').click();
  assert.match($('fireplace-message').textContent, /8 kg recorded/);
  assert.equal($('fireplace-entries').children.length, 1);
  assert.equal(calls.length, 1);
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

test('family removal expires after fifteen minutes even when a status response still permits it', async () => {
  const removalUntil = now + 15 * 60_000;
  const recent = { ...entry(), canRemove: true, removalUntil };
  assert.equal(fireplaceRemovalAllowed(recent, removalUntil - 1), true);
  assert.equal(fireplaceRemovalAllowed(recent, removalUntil), true);
  assert.equal(fireplaceRemovalAllowed(recent, removalUntil + 1), false);
  assert.equal(fireplaceRemovalAllowed({ ...recent, canRemove: false }, now), false);
  assert.equal(fireplaceRemovalAllowed({ ...recent, canRemove: undefined }, now), false);
  assert.equal(fireplaceRemovalAllowed(entry(2, now - 24 * 3600_000), now), true, 'admin entries have no removal deadline');
  let current = removalUntil + 1, called = false;
  const actions = createFireplaceActions({ clock: () => current, request: async () => { called = true; return view(2); } });
  actions.update(view(1, [recent]));
  assert.equal(await actions.remove(recent.id), false);
  assert.equal(called, false);
  current = removalUntil - 1;
  assert.equal(await actions.remove(recent.id), true);
});

test('family firewood history remains readable while old removal buttons explain admin access', () => {
  const { panel, $ } = panelFixture();
  panel.update(view(1, [{ ...entry(), canRemove: false, removalUntil: now }]), now);
  const row = $('fireplace-entries').children[0];
  assert.equal(row.children[1].disabled, true);
  assert.equal(row.children[1].textContent, 'Remove mistaken entry');
  assert.equal(row.children[0].children[2].textContent, 'Admin required after 15 minutes.');
  assert.equal(row.children[1].getAttribute('aria-describedby'), row.children[0].children[2].id);
  assert.equal($('fireplace-submit').disabled, false);
});


test('firewood action labels and note identities stay stable as permissions and explanations change', () => {
  const { panel, $ } = panelFixture();
  panel.update(view(1, [entry()]), now);
  const row = $('fireplace-entries').children[0], button = row.children[1], note = row.children[0].children[2];
  const noteId = note.id;
  assert(noteId);
  assert.equal(button.getAttribute('aria-describedby'), null);
  assert.equal(button.textContent, 'Remove mistaken entry');
  panel.update(view(1, [{ ...entry(), canRemove: false, removalUntil: now }]), now);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Remove mistaken entry');
  assert.equal(note.id, noteId);
  assert.equal(button.getAttribute('aria-describedby'), noteId);
  panel.update(view(1, [{ ...entry(), requiresRebuild: true }]), now);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-describedby'), noteId);
  assert.match(note.textContent, /background/);
  panel.update(view(1, [entry()]), now);
  assert.equal(button.getAttribute('aria-describedby'), null);
  assert.equal(note.hidden, true);
});

test('a lower-revision read-only snapshot replaces former primary firewood state and cannot write', async () => {
  const calls = [], actions = createFireplaceActions({ request: async (...args) => calls.push(args) });
  actions.update(view(20, [entry(2)]));
  actions.update({ ...view(1, [entry(1)]), available: false, readOnly: true });
  assert.equal(actions.snapshot().view.revision, 1);
  assert.equal(actions.snapshot().view.entries[0].id, 1);
  assert.equal(await actions.add(8), false);
  assert.deepEqual(calls, []);
  actions.update({ ...view(0), available: false, readOnly: true });
  assert.equal(actions.snapshot().view.entries.length, 0, 'a replacement snapshot owns its own history revision');
});
