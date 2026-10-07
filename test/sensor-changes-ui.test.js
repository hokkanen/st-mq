import test from 'node:test';
import assert from 'node:assert/strict';
import { createSensorChangeActions as makeActions, createSensorChangePanel } from '../chart/sensor-changes.js';
import { renderModelInputs } from '../chart/learning-status.js';

const createSensorChangeActions = options => makeActions({ confirm: () => true, ...options });

const now = Date.parse('2026-09-10T12:00:00Z');
const event = (id = 1) => ({ id, at: now, signal: 'indoor_temperature', reason: 'replacement', revertedAt: null, canRevert: true, affectsLearning: true });
const view = (revision = 0, events = []) => ({ available: true, revision, events, sensors: [
  { signal: 'indoor_temperature', label: 'Upstairs', configured: true, affectsLearning: true },
  { signal: 'downstairs_temperature', label: 'Downstairs', configured: true, affectsLearning: true },
  { signal: 'bedroom_temperature', label: 'Bedroom', configured: false },
] });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('recording accepts a configured sensor and known reason, blocks duplicate clicks, and does not send client timestamps', async () => {
  let complete;
  const requests = [];
  const actions = createSensorChangeActions({ makeRequestId: () => 'new-request', request: (path, body) => {
    requests.push({ path, body }); return new Promise(resolve => { complete = resolve; });
  } });
  actions.update(view());
  for (const [signal, reason] of [['bedroom_temperature', 'replacement'], ['constructor', 'replacement'],
    ['indoor_temperature', 'unknown'], ['indoor_temperature', 'constructor']]) assert.equal(await actions.add(signal, reason), false);
  const first = actions.add('indoor_temperature', 'replacement');
  assert.equal(await actions.add('downstairs_temperature', 'moved'), false);
  await Promise.resolve();
  assert.deepEqual(requests, [{ path: '/api/sensor-changes', body: { signal: 'indoor_temperature', reason: 'replacement', requestId: 'new-request' } }]);
  complete(view(1, [event()]));
  assert.equal(await first, true);
  assert.equal(actions.snapshot().pending, null);
  assert.match(actions.snapshot().message, /Upstairs change recorded/);
});

test('an uncertain sensor change survives reload and retries exactly the original request', async () => {
  const storage = memoryStorage(), requests = [];
  const first = createSensorChangeActions({ storage, makeRequestId: () => 'original-request', request: async (path, body) => {
    requests.push({ path, body }); throw new Error('disconnected after commit');
  } });
  first.update(view());
  assert.equal(await first.add('indoor_temperature', 'replacement'), false);
  assert.match(first.snapshot().message, /without adding a duplicate/);
  assert.equal(await first.add('downstairs_temperature', 'moved'), false);
  const restored = createSensorChangeActions({ storage, request: async (path, body) => {
    requests.push({ path, body }); return view(1, [event()]);
  } });
  restored.update({ ...view(1, [event()]), sensors: [] });
  assert.equal(await restored.retry(), true, 'a confirmed save can be recovered even after the selected sensor is removed from configuration');
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(createSensorChangeActions({ storage, request: async () => {} }).snapshot().pending, null);
});

test('definite rejection clears the retry while transient failures preserve it without exposing server details', async () => {
  for (const status of [400, 401, 403, 408, 429, 500]) {
    const actions = createSensorChangeActions({ request: async () => { throw Object.assign(new Error('private response body'), { status }); } });
    actions.update(view());
    assert.equal(await actions.add('indoor_temperature', 'moved'), false);
    assert.equal(!!actions.snapshot().pending, [408, 429, 500].includes(status));
    assert.doesNotMatch(actions.snapshot().message, /private/);
  }
});

test('read-only and unavailable installations cannot submit or retry changes', async () => {
  let calls = 0;
  const actions = createSensorChangeActions({ request: async () => { calls++; return view(); } });
  for (const next of [undefined, { ...view(), readOnly: true }, { ...view(), available: false }]) {
    actions.update(next);
    assert.equal(await actions.add('indoor_temperature', 'replacement'), false);
  }
  assert.equal(calls, 0);
});

test('stale list responses cannot overwrite a new sensor change', async () => {
  let completeRead, completeWrite;
  const actions = createSensorChangeActions({ request: (path, body) => new Promise(resolve => {
    if (body) completeWrite = resolve; else completeRead = resolve;
  }) });
  actions.update(view(1));
  const loading = actions.refresh();
  const saving = actions.add('indoor_temperature', 'replacement');
  await Promise.resolve();
  completeWrite(view(3, [event(3)])); await saving;
  completeRead(view(2, [event(2)])); await loading;
  actions.update(view(1));
  assert.equal(actions.snapshot().view.revision, 3);
  assert.equal(actions.snapshot().view.events[0].id, 3);
  assert.equal(actions.snapshot().loading, false);
});

test('failed list loading offers refresh and a later successful load enables recording', async () => {
  let count = 0;
  const actions = createSensorChangeActions({ request: async () => {
    if (!count++) throw new Error('private response body');
    return view();
  } });
  assert.equal(await actions.refresh(), false);
  assert.match(actions.snapshot().message, /could not be loaded/);
  assert.equal(await actions.refresh(), true);
  assert.equal(actions.snapshot().view.available, true);
  assert.equal(actions.snapshot().message, '');
});

function panelFixture(options = {}) {
  const ids = ['sensor-change-signal', 'sensor-change-reason', 'sensor-change-submit', 'sensor-change-content',
    'sensor-change-message', 'sensor-change-retry', 'sensor-change-refresh', 'sensor-change-availability',
    'sensor-change-overview', 'sensor-change-empty', 'sensor-change-entries', 'sensor-change-form', 'sensor-change-details',
    'sensor-change-rebuild', 'sensor-change-retry-rebuild', 'sensor-change-more'];
  ids.push(...ids.map(id => `outdoor-${id}`));
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: () => new Element() };
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.events = new Map(); this.attributes = new Map(); this.value = ''; this.classes = new Set();
      this.classList = { toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this.children[0] ?? null; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    insertBefore(child, next) {
      child.remove(); child.parentElement = this;
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child);
    }
    remove() {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    querySelector(selector) {
      const [first, ...rest] = selector.split(' ');
      const matches = node => first.startsWith('.') ? node.className?.split(' ').includes(first.slice(1))
        : node.dataset.modelInput === first.match(/data-model-input="([^"]+)"/)?.[1];
      const visit = node => {
        for (const child of node.children) {
          if (matches(child)) return rest.length ? child.querySelector(rest.join(' ')) : child;
          const nested = visit(child); if (nested) return nested;
        }
        return null;
      };
      return visit(this);
    }
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
    focus() { document.activeElement = this; }
  }
  for (const id of ids) nodes.set(id, new Element());
  nodes.get('sensor-change-reason').value = 'replacement';
  nodes.get('outdoor-sensor-change-reason').value = 'replacement';
  const panel = createSensorChangePanel({ document, confirm: () => true, request: async () => view(), ...options });
  return { panel, document, $: id => nodes.get(id) };
}

test('panel preserves user selection and focus across status updates and displays safe sensor change history', () => {
  const { panel, document, $ } = panelFixture();
  panel.update(view());
  assert.equal($('sensor-change-submit').disabled, false);
  assert.deepEqual($('sensor-change-signal').children.map(option => option.value), ['indoor_temperature', 'downstairs_temperature']);
  $('sensor-change-details').open = true;
  $('sensor-change-signal').value = 'downstairs_temperature'; $('sensor-change-signal').focus();
  $('sensor-change-reason').value = 'moved';
  panel.update(view(1, [event(), { ...event(2), signal: 'private response body' }]));
  assert.equal($('sensor-change-signal').value, 'downstairs_temperature');
  assert.equal($('sensor-change-reason').value, 'moved');
  assert.equal($('sensor-change-details').open, true);
  assert.equal(document.activeElement, $('sensor-change-signal'));
  assert.equal($('sensor-change-entries').children.length, 1);
  const row = $('sensor-change-entries').children[0];
  assert.equal(row.children[0].textContent, 'Upstairs · Replacement');
  assert.match(row.children[1].textContent, /15:00/);
  panel.update({ ...view(2), readOnly: true });
  assert.equal($('sensor-change-submit').disabled, true);
  assert.match($('sensor-change-availability').textContent, /master/);
});

test('add and revert require an impact-specific confirmation, cancellation saves nothing', async () => {
  const confirmations = [], requests = [];
  const actions = createSensorChangeActions({ confirm: message => { confirmations.push(message); return false; },
    request: async (...args) => { requests.push(args); return view(); } });
  actions.update(view(1, [event()]));
  assert.equal(await actions.add('indoor_temperature', 'replacement'), false);
  assert.match(confirmations[0], /Upstairs.*replacement/);
  assert.match(confirmations[0], /normal-temperature reference are kept/);
  assert.match(confirmations[0], /learned coefficients, validation evidence/);
  assert.equal(await actions.revert(1), false);
  assert.match(confirmations[1], /Revert the Upstairs sensor change/);
  assert.match(confirmations[1], /readings excluded while it settled/);
  assert.equal(requests.length, 0);
  assert.equal(actions.snapshot().pending, null);
  assert.equal(actions.snapshot().busy, false);

  actions.update({ ...view(2), sensors: [{ signal: 'garage_temperature', configured: true, affectsLearning: false }] });
  assert.equal(await actions.add('garage_temperature', 'moved'), false);
  assert.match(confirmations[2], /does not reset house learning/);
  assert.doesNotMatch(confirmations[2], /clears the learned/);
});

test('confirmation blocks duplicate clicks and checks current permissions before posting', async () => {
  let completeConfirmation, calls = 0;
  const actions = createSensorChangeActions({ confirm: () => new Promise(resolve => { completeConfirmation = resolve; }),
    request: async () => { calls++; return view(); } });
  actions.update(view(1, [event()]));
  const first = actions.revert(1);
  assert.equal(await actions.revert(1), false);
  assert.equal(await actions.add('indoor_temperature', 'replacement'), false);
  actions.update({ ...view(1, [event()]), readOnly: true });
  completeConfirmation(true);
  assert.equal(await first, false);
  assert.equal(calls, 0);
  assert.equal(actions.snapshot().pending, null);
});

test('uncertain reversal survives reload, retains its ID and retries without asking twice', async () => {
  const storage = memoryStorage(), requests = [];
  let confirmations = 0;
  const first = createSensorChangeActions({ storage, makeRequestId: () => 'original-revert',
    confirm: () => { confirmations++; return true; }, request: async (path, body) => {
      requests.push({ path, body }); throw new Error('disconnected after commit');
    } });
  first.update(view(1, [event()]));
  assert.equal(await first.revert(1), false);
  assert.equal(await first.revert(1), false);
  assert.equal(await first.add('downstairs_temperature', 'moved'), false);
  const restored = createSensorChangeActions({ storage, confirm: () => { throw new Error('must not confirm again'); },
    request: async (path, body) => { requests.push({ path, body }); return { ...view(2, [{ ...event(), revertedAt: now + 1, canRevert: false }]), rebuild: { status: 'pending' } }; } });
  restored.update(view(2, [{ ...event(), revertedAt: now + 1, canRevert: false }]));
  assert.equal(await restored.retry(), true, 'retry recovers a committed reversal even when the event is already reverted');
  assert.deepEqual(requests, Array(2).fill({ path: '/api/sensor-changes/revert', body: { id: 1, requestId: 'original-revert' } }));
  assert.equal(confirmations, 1);
  assert.equal(restored.snapshot().pending, null);
  assert.equal(createSensorChangeActions({ storage, request: async () => {} }).snapshot().pending, null);
});

test('only available active reversible entries can start reversal', async () => {
  let calls = 0;
  const actions = createSensorChangeActions({ request: async () => { calls++; return view(); } });
  for (const next of [view(1, [{ ...event(), canRevert: false }]),
    view(1, [{ ...event(), revertedAt: now + 1 }]), { ...view(1, [event()]), readOnly: true },
    { ...view(1, [event()]), available: false }]) {
    actions.update(next);
    for (const id of [1, 2, -1, '1', null]) assert.equal(await actions.revert(id), false);
  }
  assert.equal(calls, 0);
});

test('relearn failure has a safe retry and does not expose server diagnostics', async () => {
  const requests = [];
  const actions = createSensorChangeActions({ request: async (path, body) => {
    requests.push({ path, body }); return { ...view(2, [event()]), rebuild: { status: 'pending' } };
  } });
  actions.update(view(1, [event()]));
  assert.equal(await actions.retryRebuild(), false);
  actions.update({ ...view(2, [event()]), rebuild: { status: 'failed', error: 'private response body' }, canRetryRebuild: false });
  assert.equal(await actions.retryRebuild(), false);
  actions.update({ ...view(2, [event()]), rebuild: { status: 'failed', error: 'private response body' }, canRetryRebuild: true });
  assert.equal(await actions.retryRebuild(), true);
  assert.deepEqual(requests, [{ path: '/api/sensor-changes/retry-rebuild', body: {} }]);
  assert.equal(actions.snapshot().view.rebuild.status, 'pending');
  assert.doesNotMatch(actions.snapshot().message, /private/);
});

test('indoor and outdoor history stay separate, older changes remain accessible, and action focus survives status polls', () => {
  const { panel, document, $ } = panelFixture();
  const events = Array.from({ length: 12 }, (_, i) => ({ ...event(i + 1), at: now - i * 1000 }));
  events.push({ ...event(13), signal: 'outdoor_temperature' });
  const next = { ...view(13, events), sensors: [...view().sensors, { signal: 'outdoor_temperature', configured: true, affectsLearning: true }] };
  panel.update(next);
  assert.equal($('sensor-change-entries').children.length, 10);
  assert.equal($('sensor-change-more').hidden, false);
  $('sensor-change-more').events.get('click')();
  assert.equal($('sensor-change-entries').children.length, 12);
  assert.equal($('sensor-change-more').hidden, true);
  assert.equal($('outdoor-sensor-change-entries').children.length, 1);
  assert.deepEqual($('outdoor-sensor-change-signal').children.map(option => option.value), ['outdoor_temperature']);
  assert.ok($('sensor-change-signal').children.every(option => option.value !== 'outdoor_temperature'));
  const button = $('sensor-change-entries').children[0].children[3];
  button.focus();
  panel.update({ ...next, rebuild: { status: 'running', processed: 42 } });
  assert.equal(document.activeElement, button);
  assert.equal($('sensor-change-entries').children[0].children[3], button);
  assert.match($('sensor-change-rebuild').textContent, /42 records processed/);
  assert.equal($('outdoor-sensor-change-rebuild').textContent, $('sensor-change-rebuild').textContent);
  panel.update({ ...next, rebuild: { status: 'idle', current: true } });
  assert.match($('sensor-change-rebuild').textContent, /Relearning complete/);
});

test('history clearly distinguishes reverted and archived changes, and read-only controls stay disabled', () => {
  const { panel, $ } = panelFixture();
  panel.update({ ...view(3, [{ ...event(3), revertedAt: now + 1, canRevert: false },
    { ...event(2), canRevert: false, unsupportedReason: 'Archived learning version' }, event(1)]),
    rebuild: { status: 'failed', error: 'private response body' }, canRetryRebuild: true });
  const entries = $('sensor-change-entries').children;
  assert.match(entries[0].children[2].textContent, /Reverted/);
  assert.equal(entries[0].children.length, 3);
  assert.match(entries[1].children[3].textContent, /Revert unavailable/);
  assert.equal(entries[2].children[3].textContent, 'Revert and relearn');
  assert.equal($('sensor-change-retry-rebuild').hidden, false);
  assert.equal($('sensor-change-retry-rebuild').disabled, false);
  assert.doesNotMatch($('sensor-change-rebuild').textContent, /private/);
  panel.update({ ...view(3, [{ ...event(1), canRevert: false }]), readOnly: true,
    rebuild: { status: 'failed' }, canRetryRebuild: false });
  assert.equal($('sensor-change-submit').disabled, true);
  assert.equal($('sensor-change-entries').children[0].children[3].disabled, true);
  assert.equal($('sensor-change-retry-rebuild').disabled, true);
});

test('model input guide mounts each sensor-change fold in its own temperature input and preserves it on refresh', () => {
  const { document, $ } = panelFixture(), previous = globalThis.document;
  globalThis.document = document;
  try {
    const root = document.createElement('div');
    const indoor = $('sensor-change-details'), outdoor = $('outdoor-sensor-change-details');
    indoor.hidden = true; outdoor.hidden = true;
    renderModelInputs(root, undefined, { sensorChanges: indoor, outdoorSensorChanges: outdoor });
    const indoorInput = root.children.find(node => node.dataset.modelInput === 'model_indoor_temperature');
    const outdoorInput = root.children.find(node => node.dataset.modelInput === 'model_outdoor_temperature');
    assert.equal(indoorInput.querySelector('.learning-entry-body').children.at(-1), indoor);
    assert.equal(outdoorInput.querySelector('.learning-entry-body').children.at(-1), outdoor);
    assert.equal(indoor.hidden, false);
    assert.equal(outdoor.hidden, false);
    indoor.open = true; outdoor.open = true;
    const mounted = [...root.children];
    renderModelInputs(root, undefined, { sensorChanges: indoor, outdoorSensorChanges: outdoor });
    assert.deepEqual(root.children, mounted);
    assert.equal(indoor.open, true);
    assert.equal(outdoor.open, true);
  } finally { globalThis.document = previous; }
});

test('a lower-revision read-only snapshot replaces former primary sensor-change history', () => {
  const actions = createSensorChangeActions({ request: async () => { throw new Error('No mutation allowed'); } });
  actions.update(view(20, [event(2)]));
  actions.update({ ...view(1, [event(1)]), available: false, readOnly: true });
  assert.equal(actions.snapshot().view.revision, 1);
  assert.equal(actions.snapshot().view.events[0].id, 1);
  assert.equal(actions.snapshot().view.available, false);
});
