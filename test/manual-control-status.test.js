import test from 'node:test';
import { isReadOnlyReplica } from '../chart/replica-status.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heatingRequestResult, h66RequestResult, circulationStopPending } from '../chart/manual-control-status.js';

const at = Date.parse('2026-09-16T10:48:00Z');
function heating(command = 'preheat', paused = true) {
  const expiresAt = at + (paused ? 3600_000 : 60_000);
  return { now: at + 1000, heatingTests: { lastResult: { command, at, status: 'mqtt', sent: true,
    expiresAt, holdUntil: paused ? expiresAt : null } },
  override: paused ? { id: 'pause-one', createdAt: at - 1000, expiresAt } : null,
  decision: { manualHold: paused ? { phase: command, until: expiresAt } : null },
  h66: { manualPreheat: command === 'preheat' ? { at } : null },
  observations: { actual: { requestedPhase: command } } };
}
function native() {
  const status = heating();
  status.h66 = { phase: 'normal', expiresAt: null, pauseId: null, requested: {},
    lastManual: { register: '0203', value: 25, previousValue: 20, scope: 'native-setting',
      at, sent: true, confirmed: true, status: 'confirmed' } };
  return status;
}

test('heating request notices expire even when the saved result never changes', () => {
  for (const paused of [false, true]) {
    for (const command of ['preheat', 'normal', 'reduction']) {
      const status = heating(command, paused), saved = structuredClone(status.heatingTests.lastResult);
      assert.ok(heatingRequestResult(status));
      status.now = saved.expiresAt;
      assert.equal(heatingRequestResult(status), null);
      status.now += 5 * 86400_000;
      assert.equal(heatingRequestResult(status), null);
      assert.deepEqual(status.heatingTests.lastResult, saved, 'History is preserved');
    }
  }
});

test('Resume, a replacement pause, superseding ROOM changes and restoration remove old heating success', () => {
  for (const patch of [s => { s.override = null; s.decision.manualHold = null; },
    s => { s.override.createdAt = at + 500; },
    s => { s.decision.manualHold.phase = 'normal'; },
    s => { s.h66.manualPreheat = null; },
    s => { s.h66.restorationPending = true; },
    s => { s.execution = { restorationPending: true }; },
    s => { s.preheatValves = { restorationPending: true }; }]) {
    const status = heating(); patch(status);
    assert.equal(heatingRequestResult(status), null);
  }
  const temporary = heating('reduction', false);
  temporary.observations.actual.requestedPhase = 'normal';
  assert.equal(heatingRequestResult(temporary), null);
});

test('native command receipts are recent readback-aware notices independent of Heat control pauses', () => {
  const status = native();
  assert.equal(h66RequestResult(status), status.h66.lastManual);
  status.override = null;
  assert.equal(h66RequestResult(status), status.h66.lastManual, 'Pause ownership does not own the native setting');
  for (const patch of [s => { s.now = at + 60_000; },
    s => { s.h66.readings = { '0203': { available: true, stale: false, value: 20 } }; },
    s => { s.h66.restorationPending = true; },
    s => { s.h66.lastManual.scope = 'heat-control'; }]) {
    const changed = native(); patch(changed);
    assert.equal(h66RequestResult(changed), null);
  }
  assert.equal(h66RequestResult({ now: at + 5 * 86400_000, h66: { lastManual: status.h66.lastManual } }), null);
});

test('unchanged permanent native edits still show their confirmation without a temporary owner', () => {
  const status = native();
  status.override = null;
  Object.assign(status.h66.lastManual, { sent: false, previousValue: 25 });
  assert.ok(h66RequestResult(status));
  status.h66.lastManual.scope = 'heat-control';
  assert.equal(h66RequestResult(status), null);
});

test('circulation notices follow its independent run and latest confirmation', () => {
  const status = heating('circulation');
  status.override = null; status.decision.manualHold = null;
  status.dhwr = { active: true, requestedAt: at - 100, confirmed: false };
  assert.equal(heatingRequestResult(status).confirmed, false);
  status.dhwr.confirmed = true;
  assert.equal(heatingRequestResult(status).confirmed, true);
  status.dhwr.active = false;
  assert.equal(heatingRequestResult(status), null);
  status.dhwr.active = true; status.dhwr.requestedAt = at + 500;
  assert.equal(heatingRequestResult(status), null, 'A later run cannot revive an old receipt');
});

test('stop receipts clear after OFF confirmation, supersession or the acknowledgement window', () => {
  const status = { now: at + 1000, dhwr: { active: false, requestedAt: at, confirmed: false } };
  assert.equal(circulationStopPending(status, at), true);
  status.dhwr.confirmed = true;
  assert.equal(circulationStopPending(status, at), false);
  status.dhwr.confirmed = false; status.now = at + 60_000;
  assert.equal(circulationStopPending(status, at), false);
  status.dhwr.restorationPending = true;
  assert.equal(circulationStopPending(status, at), true);
  status.dhwr.active = true;
  assert.equal(circulationStopPending(status, at), false);
});

test('historical failures expire without clearing live restoration flags', () => {
  const status = native();
  status.heatingTests.lastResult.status = 'failed'; status.h66.lastManual.status = 'unconfirmed';
  status.h66.restorationPending = true;
  assert.ok(heatingRequestResult(status)); assert.ok(h66RequestResult(status));
  status.now = at + 60_000;
  assert.equal(heatingRequestResult(status), null); assert.equal(h66RequestResult(status), null);
  assert.equal(status.h66.restorationPending, true);
});

test('a dismissed native receipt cannot return when a contradictory reading becomes unavailable', () => {
  const source = readFileSync(new URL('../chart/monitor.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function showH66Test('), source.indexOf('function renderH66(s)'));
  const message = { textContent: '', classList: { toggle() {} } };
  const render = new Function('$', 'h66RequestResult', `
    let lastStatus, dismissedH66Request, h66TestBusy = false;
    const clearControlMessage = () => true, label = String, time = String, h66Registers = {};
    ${functions}
    return (status, busy = false) => { lastStatus = status; h66TestBusy = busy; renderH66TestResult(status); };
  `)(() => message, h66RequestResult);
  const status = native(); render(status);
  assert.match(message.textContent, /requested 25.*device confirmed/);
  status.h66.readings = { '0203': { value: 20, available: true, stale: false } }; render(status);
  assert.equal(message.textContent, '');
  status.h66.readings['0203'].stale = true; status.h66.readings['0203'].available = false; render(status);
  assert.equal(message.textContent, '', 'Losing telemetry cannot revive an obsolete confirmation');
  status.h66.lastManual.at++; render(status);
  assert.match(message.textContent, /requested 25/, 'A newer request can show its own receipt');
  message.textContent = 'Applying…'; render(status, true);
  assert.equal(message.textContent, 'Applying…');
  status.h66.lastManual = null; render(status);
  assert.equal(message.textContent, '');
});

test('polling removes identical old notices, updates circulation feedback and preserves in-flight text', () => {
  const source = readFileSync(new URL('../chart/monitor.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function showHeatingTestResult('), source.indexOf('function renderProviderSeries('));
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, dataset: {},
      classList: { toggle() {}, remove() {}, add() {} }, setAttribute() {}, querySelector() { return {}; } });
    return nodes.get(id);
  };
  const renderer = new Function('$', 'heatingRequestResult', 'circulationStopPending', 'isReadOnlyReplica', `
    let lastStatus, heatingTestBusy = false, circulationStopAt;
    const controlErrors = new Map(), heatingResults = new Map(), time = value => String(value), decimal = String;
    const heatingCommandLabel = command => command, homeHeatingWarning = () => '', garageHeatingWarning = () => '';
    const setStatusDetail = () => {};
    ${functions}
    return (status, busy = false) => { lastStatus = status; heatingTestBusy = busy; renderHeatingTests(status); };
  `)($, heatingRequestResult, circulationStopPending, isReadOnlyReplica);
  const status = heating();
  renderer(status);
  assert.match($('heating-test-message').textContent, /held until/);
  Object.assign(status.observations.actual, { phase: 'preheat', verified: true, stale: false, observedAt: status.now });
  renderer(status);
  assert.match($('heating-test-message').textContent, /Device confirmed/);
  const original = status.heatingTests.lastResult;
  status.heatingTests.lastResult = { command: 'circulation', at: status.now, sent: true, status: 'mqtt' };
  status.dhwr = { active: true, requestedAt: status.now };
  renderer(status);
  assert.match($('heating-test-message').textContent, /held until/, 'Circulation preserves a concurrent heating hold');
  assert.match($('dhwr-message').textContent, /Circulation runs/);
  status.heatingTests.lastResult = original;
  renderer(status);
  assert.match($('dhwr-message').textContent, /Circulation runs/, 'Heating updates preserve a concurrent circulation run');
  status.dhwr.active = false;
  status.now = status.override.expiresAt;
  renderer(status);
  assert.equal($('heating-test-message').textContent, '');
  assert.equal($('dhwr-message').textContent, '');
  renderer(status);
  assert.equal($('heating-test-message').textContent, '');
  $('heating-test-message').textContent = 'Sending…'; renderer(status, true);
  assert.equal($('heating-test-message').textContent, 'Sending…');
  status.execution = { restorationPending: true }; renderer(status);
  assert.match($('heating-test-message').textContent, /Restoring previous heating settings/);
  delete status.execution;
  const circulation = heating('circulation'); circulation.dhwr = { active: true, requestedAt: at - 100 };
  renderer(circulation); assert.match($('dhwr-message').textContent, /Waiting for a new device report/);
  circulation.dhwr.confirmed = true; renderer(circulation);
  assert.match($('dhwr-message').textContent, /Device confirmed/);
  circulation.dhwr.active = false; renderer(circulation);
  assert.equal($('dhwr-message').textContent, '');
});
