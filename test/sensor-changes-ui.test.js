import test from 'node:test';
import assert from 'node:assert/strict';
import { createSensorChangeActions, createSensorChangePanel } from '../chart/sensor-changes.js';

const now = Date.parse('2026-09-10T12:00:00Z');
const event = (id = 1) => ({ id, at: now, signal: 'indoor_temperature', reason: 'replacement' });
const view = (revision = 0, events = []) => ({ available: true, revision, events, sensors: [
  { signal: 'indoor_temperature', label: 'Upstairs Hallway', configured: true },
  { signal: 'downstairs_temperature', label: 'Downstairs', configured: true },
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
  assert.deepEqual(requests, [{ path: '/api/sensor-changes', body: { signal: 'indoor_temperature', reason: 'replacement', requestId: 'new-request' } }]);
  complete(view(1, [event()]));
  assert.equal(await first, true);
  assert.equal(actions.snapshot().pending, null);
  assert.match(actions.snapshot().message, /Upstairs Hallway change recorded/);
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

function panelFixture() {
  const ids = ['sensor-change-signal', 'sensor-change-reason', 'sensor-change-submit', 'sensor-change-content',
    'sensor-change-message', 'sensor-change-retry', 'sensor-change-refresh', 'sensor-change-availability',
    'sensor-change-overview', 'sensor-change-empty', 'sensor-change-entries', 'sensor-change-form', 'sensor-change-details'];
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: () => new Element() };
  class Element {
    constructor() { this.children = []; this.events = new Map(); this.attributes = new Map(); this.value = ''; this.classes = new Set();
      this.classList = { toggle: (name, state) => state ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value ?? ''; }
    focus() { document.activeElement = this; }
  }
  for (const id of ids) nodes.set(id, new Element());
  nodes.get('sensor-change-reason').value = 'replacement';
  const panel = createSensorChangePanel({ document, request: async () => view() });
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
  assert.equal(row.children[0].textContent, 'Upstairs Hallway · Replacement');
  assert.match(row.children[1].textContent, /15:00/);
  panel.update({ ...view(2), readOnly: true });
  assert.equal($('sensor-change-submit').disabled, true);
  assert.match($('sensor-change-availability').textContent, /primary/);
});
