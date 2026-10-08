import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDatabaseVerification } from '../chart/database-verification.js';

const idle = { state: 'idle', intervalMs: 0, activity: { active: null, queued: [] } };
const admin = { webAccess: { role: 'admin' } };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const elements = new Map(), requests = [], timers = new Map();
  let timerId = 0;
  const element = id => {
    if (!elements.has(id)) {
      let text = '', disabled = false;
      elements.set(id, { open: false, writes: [], listeners: {},
        get textContent() { return text; },
        set textContent(value) { text = value; this.writes.push(['text', value]); },
        get disabled() { return disabled; },
        set disabled(value) { disabled = value; this.writes.push(['disabled', value]); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
      });
    }
    return elements.get(id);
  };
  element('database-verification-details').open = true;
  const panel = bindDatabaseVerification({ document: { getElementById: element }, formatTime: String,
    request: (path, body) => new Promise((resolve, reject) => { requests.push({ path, body, resolve, reject }); }),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  return { panel, element, requests, timers,
    button: element('database-verification-start'),
    writes: () => [...elements.values()].flatMap(value => value.writes),
    poll: () => {
      const entry = timers.entries().next().value;
      assert(entry, 'A visible or running check keeps one status poll scheduled');
      timers.delete(entry[0]);
      return entry[1]();
    },
  };
}

test('background verification polls do not flash the action or rewrite unchanged live status', async () => {
  const view = fixture();
  view.panel.update(admin);
  assert.equal(view.button.disabled, true, 'Initial status must load before the first action');
  view.requests[0].resolve(idle);
  await settle();
  assert.equal(view.button.disabled, false);
  const writes = view.writes().length;
  const poll = view.poll();
  assert.equal(view.button.disabled, false, 'An ordinary status request leaves the action available');
  view.panel.update(admin);
  assert.equal(view.writes().length, writes, 'Dashboard polling does not disturb unchanged controls or live regions');
  view.requests[1].resolve(structuredClone(idle));
  await poll;
  assert.equal(view.writes().length, writes, 'The unchanged response does not mutate the visible status');
  assert.equal(view.timers.size, 1);
  view.panel.close();
});

for (const response of ['saved idle status', 'failed poll']) {
  test(`a late ${response} cannot replace an explicitly started verification`, async () => {
    const view = fixture();
    view.panel.update(admin);
    view.requests[0].resolve(idle);
    await settle();
    const poll = view.poll();
    const start = view.button.listeners.click();
    assert.equal(view.button.disabled, true, 'Only starting a check changes action availability');
    assert.deepEqual(view.requests[2].body, {});
    await view.button.listeners.click();
    assert.equal(view.requests.length, 3, 'A second click cannot submit another check');
    view.requests[2].resolve({ ...idle, state: 'running', progress: { processed: 20 } });
    await start;
    if (response === 'failed poll') view.requests[1].reject(new Error('Synthetic network failure'));
    else view.requests[1].resolve(idle);
    await poll;
    assert.equal(view.button.disabled, true);
    assert.match(view.element('database-verification-status').textContent, /running.*20 records checked/);
    const completion = view.poll();
    view.requests[3].resolve({ ...idle, state: 'complete', lastResult: { verifiedAt: 123, checkpoint: { sequence: 42 } } });
    await completion;
    assert.equal(view.button.disabled, false);
    assert.match(view.element('database-verification-status').textContent, /Verified 123 at transaction 42.*Newer transactions are outside this check/);
    view.panel.close();
  });
}

test('verification poll failures remain visible and recover on the next response', async () => {
  const view = fixture();
  view.panel.update(admin);
  view.requests[0].resolve(idle);
  await settle();
  const failed = view.poll();
  view.requests[1].reject(new Error('Synthetic network failure'));
  await failed;
  assert.match(view.element('database-verification-status').textContent, /status is unavailable/);
  const recovered = view.poll();
  view.requests[2].resolve(idle);
  await recovered;
  assert.match(view.element('database-verification-status').textContent, /No full verification completed/);
  view.element('database-verification-details').open = false;
  view.element('database-verification-details').listeners.toggle();
  assert.equal(view.timers.size, 0, 'Closing an idle section stops polling');
  view.panel.close();
});

test('losing access or closing a verification panel fences in-flight status responses', async () => {
  const view = fixture();
  view.panel.update(admin);
  view.requests[0].resolve(idle);
  await settle();
  const poll = view.poll();
  view.panel.update({ webAccess: { role: 'family' } });
  view.requests[1].resolve({ ...idle, state: 'running', progress: { processed: 100 } });
  await poll;
  assert.equal(view.button.disabled, true);
  assert.match(view.element('database-verification-status').textContent, /No full verification completed/);
  assert.equal(view.timers.size, 0);
  view.panel.update(admin);
  view.panel.close();
  const writes = view.writes().length;
  view.requests[2].resolve(idle);
  await settle();
  assert.equal(view.writes().length, writes);
  assert.equal(view.timers.size, 0);
});
