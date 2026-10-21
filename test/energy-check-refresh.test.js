import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyChecksRefresh } from '../chart/energy-check-refresh.js';

function fixture() {
  const requests = [], rendered = [], jobs = [], root = { replaceChildren() { rendered.length = 0; },
    setAttribute() {}, removeAttribute() {} };
  const parent = { open: true }, details = { open: true }, button = {}, message = { classList: { add() {} } };
  let now = 0, visible = true;
  const refresh = createEnergyChecksRefresh({ root, parent, details, button, message, cancel: {}, progress: {}, detail: {},
    isVisible: () => visible, clock: () => now, render: view => rendered.push(view), renderJob: view => jobs.push(view),
    request: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })) });
  return { refresh, requests, rendered, jobs, parent, details, message,
    advance(ms) { now += ms; }, hide() { visible = false; } };
}
const view = (state, result = null) => ({ latest: null, result, job: { state } });

test('energy polling is lazy, coalesced and faster only while a server job is running', async () => {
  const f = fixture(); f.details.open = false;
  await f.refresh(); assert.equal(f.requests.length, 0);
  f.details.open = true;
  const first = f.refresh(); await f.refresh(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(view('running')); await first;
  f.advance(1999); await f.refresh(); assert.equal(f.requests.length, 1);
  f.advance(1); const next = f.refresh(); f.requests[1].resolve(view('completed', [])); await next;
  f.advance(2000); await f.refresh(); assert.equal(f.requests.length, 2);
  f.advance(58000); const last = f.refresh(); f.requests[2].resolve(view('completed', [])); await last;
});

test('closing or resetting cancels only HTTP and fences late data from the previous scope', async () => {
  const f = fixture(), pending = f.refresh();
  f.hide(); f.refresh.visibilityChanged();
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.requests.length, 1, 'leaving sends no cancel action to the server');
  f.requests[0].resolve(view('completed', [{ oldScope: true }])); await pending;
  assert.equal(f.rendered.length, 0);
  const g = fixture(), previous = g.refresh(); g.refresh.reset();
  const current = g.refresh();
  g.requests[0].resolve(view('completed', [{ oldScope: true }])); await previous;
  g.requests[1].resolve(view('running')); await current;
  assert.equal(g.rendered.length, 1); assert.equal(g.rendered[0].job.state, 'running');
});

test('cancel clicked during a status read is delivered after that read and never lost', async () => {
  const f = fixture(), pending = f.refresh();
  await f.refresh.cancel(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(view('running'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { action: 'cancel' });
  f.requests[1].resolve(view('cancelled')); await pending;
  assert.equal(f.rendered.at(-1).job.state, 'cancelled');
});

test('a failed status request preserves completed results and offers a retry reason', async () => {
  const f = fixture(), initial = f.refresh();
  f.requests[0].resolve(view('completed', [{ comparison: true }])); await initial;
  const retry = f.refresh.measure();
  f.requests[1].reject(new Error('/synthetic/private/history.sqlite could not be opened')); await retry;
  assert.equal(f.rendered.length, 1);
  assert.match(f.message.textContent, /last completed checks.*Refresh checks to retry/);
  assert.doesNotMatch(f.message.textContent, /private|sqlite/);
});
