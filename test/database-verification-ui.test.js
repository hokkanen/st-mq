import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDatabaseVerification } from '../chart/database-verification.js';

const idle = { state: 'idle', intervalMs: 0, activity: { active: null, queued: [] } };
const admin = { webAccess: { role: 'admin' } };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('family access and unfetched verification schedules remain explicit unknowns', async () => {
  const view = fixture();
  view.panel.update({ webAccess: { role: 'family' } });
  assert.equal(view.requests.length, 0);
  assert.match(view.element('database-verification-status').textContent, /Admin access is required/);
  assert.doesNotMatch(view.element('database-verification-status').textContent, /Loading/);
  assert.doesNotMatch(view.element('database-verification-schedule').textContent, /disabled/);
  view.panel.update(admin);
  assert.match(view.element('database-verification-schedule').textContent, /not known/);
  view.requests[0].resolve({ ...idle, intervalMs: 86400000 }); await settle();
  assert.match(view.element('database-verification-schedule').textContent, /every 24 hours/);
  view.panel.update({ webAccess: { role: 'family' } });
  assert.equal(view.element('database-verification-activity').textContent, '');
  view.panel.update(admin);
  assert.match(view.element('database-verification-schedule').textContent, /not known/);
  view.requests[1].resolve(idle); await settle();
  assert.match(view.element('database-verification-schedule').textContent, /disabled/);
  view.panel.close();
});

test('verification failures distinguish incompatible data, integrity damage, differing checkpoints and interruption', async () => {
  for (const [state, error, expected] of [
    ['error', 'database_schema_mismatch', /schema does not match/],
    ['error', 'database_algorithm_mismatch', /different learning algorithm/],
    ['error', 'database_state_incompatible', /saved application state/],
    ['error', 'database_integrity_failed', /failed its integrity checks/],
    ['error', 'database_journal_invalid', /could not verify.*journal.*Preserve the database/],
    ['error', 'full_verification_checkpoint_mismatch', /not evidence of damage/],
    ['error', 'full_verification_content_mismatch', /different data.*same transaction/],
    ['error', 'full_verification_busy', /queue is full/],
    ['error', '/private/error', /cause was not identified/],
    ['interrupted', 'full_verification_failed', /interrupted.*interruption alone does not show.*damage/],
  ]) {
    const view = fixture(); view.panel.update(admin);
    view.requests[0].resolve({ ...idle, state, error }); await settle();
    const text = view.element('database-verification-status').textContent;
    assert.match(text, expected); assert.doesNotMatch(text, /private/);
    assert.equal(view.button.disabled, false, 'A terminal result allows a new explicit verification');
    view.panel.close();
  }
});

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
  element('recording-details').open = true;
  element('database-verification-details').open = true;
  const document = { getElementById: element, visibilityState: 'visible', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }, removeEventListener(type) { delete this.listeners[type]; } };
  const panel = bindDatabaseVerification({ document, formatTime: String,
    request: (path, body) => new Promise((resolve, reject) => { requests.push({ path, body, resolve, reject }); }),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  return { panel, document, element, requests, timers,
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

test('closed parent and hidden tabs stop verification polling while server work remains independent', async () => {
  const view = fixture(); view.panel.update(admin);
  view.requests[0].resolve({ ...idle, state: 'running', progress: { processed: 12 } }); await settle();
  view.element('recording-details').open = false;
  view.element('recording-details').listeners.toggle();
  assert.equal(view.timers.size, 0);
  assert.equal(view.requests.length, 1, 'Closing the view sends no cancellation or mutation');
  view.element('recording-details').open = true;
  view.element('recording-details').listeners.toggle();
  assert.equal(view.requests.length, 2, 'Reopening reads the accepted job');
  view.requests[1].resolve({ ...idle, state: 'complete', lastResult: { verifiedAt: 123, checkpoint: { sequence: 42 } } }); await settle();
  view.document.visibilityState = 'hidden'; view.document.listeners.visibilitychange();
  assert.equal(view.timers.size, 0);
  view.document.visibilityState = 'visible'; view.document.listeners.visibilitychange();
  assert.equal(view.requests.length, 3);
  view.requests[2].resolve(idle); await settle();
  assert.equal(view.timers.size, 1);
  view.panel.close();
});

test('verification stays lazy while folded and clears old source results across resets and logout', async () => {
  const view = fixture(); view.element('recording-details').open = false; view.panel.update(admin);
  assert.equal(view.requests.length, 0);
  view.element('recording-details').open = true; view.element('recording-details').listeners.toggle();
  view.panel.reset();
  assert.equal(view.requests.length, 2);
  view.requests[0].resolve({ ...idle, state: 'error', error: 'database_integrity_failed' }); await settle();
  assert.doesNotMatch(view.element('database-verification-status').textContent, /failed its integrity/);
  view.requests[1].resolve(idle); await settle();
  const poll = view.poll(); view.panel.clear();
  view.requests[2].resolve({ ...idle, state: 'error', error: 'database_integrity_failed' }); await poll;
  assert.equal(view.timers.size, 0); assert.equal(view.button.disabled, true);
  assert.doesNotMatch(view.element('database-verification-status').textContent, /failed its integrity/);
  view.panel.close();
});

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

test('known start refusals survive a successful status refresh and preserve the previous verified result', async () => {
  for (const [failure, expected] of [
    [{ status: 403 }, /not started.*Admin access/],
    [{ status: 409, code: 'full_verification_unavailable' }, /not started.*database is not available/],
    [{ status: 409, code: 'full_verification_busy' }, /not started.*Another database check is still running/],
  ]) {
    const view = fixture(), complete = { ...idle, state: 'complete', lastResult: { verifiedAt: 123, checkpoint: { sequence: 42 } } };
    view.panel.update(admin); view.requests[0].resolve(complete); await settle();
    const start = view.button.listeners.click();
    view.requests[1].reject(Object.assign(new Error('/private/native-failure'), failure)); await start;
    view.requests[2].resolve(complete); await settle();
    const text = view.element('database-verification-status').textContent;
    assert.match(text, expected); assert.match(text, /Verified 123 at transaction 42/);
    assert.doesNotMatch(text, /private|Reconnect|damage/);
    view.panel.close();
  }
});

test('a lost start reply prompts a status check without replay and a failed read retains dated evidence', async () => {
  const view = fixture(), complete = { ...idle, state: 'complete', lastResult: { verifiedAt: 123, checkpoint: { sequence: 42 } } };
  view.panel.update(admin); view.requests[0].resolve(complete); await settle();
  const start = view.button.listeners.click();
  view.requests[1].reject(new TypeError('Response lost')); await start;
  assert.match(view.element('database-verification-status').textContent, /start was not confirmed.*Verified 123/);
  assert.equal(view.requests[2].body, undefined, 'The follow-up reads status, not another start');
  view.requests[2].reject(Object.assign(new Error('Private failure'), { status: 403 })); await settle();
  assert.match(view.element('database-verification-status').textContent, /Admin access.*Last received status: Verified 123/);
  const poll = view.poll();
  view.requests[3].resolve({ ...idle, state: 'running', progress: { processed: 12 } }); await poll;
  assert.match(view.element('database-verification-status').textContent, /running.*12 records/);
  assert.doesNotMatch(view.element('database-verification-status').textContent, /unconfirmed|not confirmed|Last received|Private/);
  assert.equal(view.requests.filter(request => request.body !== undefined).length, 1);
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
  assert.match(view.element('database-verification-status').textContent, /Admin access is required/);
  assert.equal(view.timers.size, 0);
  view.panel.update(admin);
  view.panel.close();
  const writes = view.writes().length;
  view.requests[2].resolve(idle);
  await settle();
  assert.equal(view.writes().length, writes);
  assert.equal(view.timers.size, 0);
});
