import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardConnectionView, dashboardWriterState, observeDashboardHealth, observeDashboardStatus, retainDashboardHealth,
  retainNewerDashboardObservations } from '../chart/dashboard-storage.js';

const status = (state, extra = {}) => ({ now: 1000, input: 'providers', role: 'master',
  recordingHealth: { version: 3, scope: 'live', checkedAt: 2000, recording: { writer: { state } } }, ...extra });

test('responsive committed views preserve their scope and disclose pending state without renewing source time', () => {
  for (const input of ['providers', 'simulated']) {
    const value = status('saving', { input, storagePending: true });
    const view = dashboardConnectionView(value);
    assert.equal(view.scope, input === 'simulated' ? 'Simulation' : 'Live');
    assert.match(view.context, /Showing saved readings alongside live door reports/);
    assert.equal(value.now, 1000);
  }
  assert.match(dashboardConnectionView(status('confirming')).context, /Confirming the last save/);
  assert.match(dashboardConnectionView(status('unavailable')).context, /Displayed readings keep their original timestamps/);
  assert.doesNotMatch(dashboardConnectionView(status('ready')).context, /last saved|Saving/);
  assert.equal(dashboardWriterState({}), 'unknown');
  assert.equal(dashboardWriterState(status('invented')), 'unknown');
  assert.equal(dashboardWriterState(status('ready', { recordingHealth: { version: 3, scope: 'snapshot' } })), 'unknown');
});

test('replica dashboard context describes recorded evidence regardless of its original input', () => {
  for (const input of ['providers', 'simulated', 'offline']) {
    const result = dashboardConnectionView(status('ready', { input, role: 'slave', readOnly: true }));
    assert.equal(result.scope, 'History viewer');
    assert.match(result.context, /Recorded snapshot view.*original timestamps.*readiness is unavailable/);
    assert.doesNotMatch(result.context, /Live observations|Simulated devices|Imported household/);
  }
  assert.match(dashboardConnectionView(status('ready', { input: 'offline' })).context, /Imported household history/);
});

test('action responses retain independently dated health while explicit scope changes discard it', () => {
  const previous = status('unavailable');
  const action = { now: 3000, input: 'providers', role: 'master' };
  const retained = retainDashboardHealth(previous, action);
  assert.equal(retained.recordingHealth, previous.recordingHealth);
  assert.equal(retained.recordingHealth.checkedAt, 2000);
  assert.equal(Object.hasOwn(action, 'recordingHealth'), false);
  for (const invalid of [null, { version: 99 }]) {
    const retainedInvalid = retainDashboardHealth(previous, { ...action, recordingHealth: invalid });
    assert.equal(retainedInvalid.recordingHealth, previous.recordingHealth);
    assert.equal(dashboardWriterState(retainedInvalid), 'unavailable', 'Invalid health cannot clear a known writer failure');
  }
  const fresh = status('ready');
  assert.equal(retainDashboardHealth(previous, fresh), fresh);
  assert.equal(retainDashboardHealth(previous, { ...action, role: 'slave' }).recordingHealth, undefined);
  assert.equal(retainDashboardHealth(previous, { ...action, input: 'offline' }).recordingHealth, undefined);
});

test('observing status during an action updates health and authority without replacing forms or evidence clocks', () => {
  const equipment = { devices: [{ id: 'synthetic-switch', value: 0 }] };
  const displayed = status('saving', { equipment, settings: { draftReference: 1 }, webAccess: { role: 'admin' } });
  const observed = status('unavailable', { now: 4000, equipment: { devices: [] }, settings: { draftReference: 2 },
    readOnly: true, role: 'slave', webAccess: { role: 'family' }, storagePending: true });
  const result = observeDashboardStatus(displayed, observed);
  assert.equal(result.equipment, equipment);
  assert.equal(result.settings, displayed.settings);
  assert.equal(result.now, displayed.now);
  assert.equal(result.recordingHealth, observed.recordingHealth);
  assert.equal(result.role, 'slave');
  assert.equal(result.readOnly, true);
  assert.equal(result.webAccess.role, 'family');
  assert.equal(result.storagePending, true);
  assert.equal(observeDashboardStatus(null, observed), null, 'health cannot bootstrap dashboard control authority');
});

test('health-only refreshes preserve authentication, replica authority and dataset identity', () => {
  const displayed = status('unavailable');
  displayed.recordingHealth.contextId = 'synthetic-current';
  const health = { ...status('ready').recordingHealth, contextId: 'synthetic-current', checkedAt: 5000 };
  assert.equal(observeDashboardHealth(displayed, health).recordingHealth, health);
  assert.equal(observeDashboardHealth(null, health), null);
  for (const changed of [{ ...health, scope: 'snapshot' }, { ...health, contextId: 'synthetic-replacement' }]) {
    const pending = observeDashboardHealth(displayed, changed);
    assert.equal(pending.storageContextPending, true);
    assert.equal(pending.recordingHealth, displayed.recordingHealth);
    assert.equal(observeDashboardHealth(pending, health), pending, 'Only a full status can resolve a changed context');
    assert.equal(observeDashboardStatus(pending, status('ready')).storageContextPending, true,
      'Observation-only polling cannot replace displayed equipment after its dataset changed');
    assert.equal(retainDashboardHealth(pending, status('ready')).storageContextPending, undefined,
      'A normal complete dashboard render resolves the context restriction');
  }
  const replica = { ...displayed, role: 'slave', readOnly: true };
  assert.equal(observeDashboardHealth(replica, health).readOnly, true);
  const recorded = observeDashboardHealth(replica, { ...health, scope: 'snapshot' });
  assert.equal(recorded.role, 'slave');
  assert.equal(recorded.readOnly, true);
  assert.equal(recorded.now, displayed.now);
});

test('late action replies cannot undo authority or writer restrictions observed during the action', () => {
  const before = status('ready', { topology: 'pair', readOnly: false, pair: { role: 'master', canControl: true } });
  const newer = observeDashboardStatus(before, status('unavailable', { topology: 'pair', role: 'slave', readOnly: true,
    pair: { role: 'slave', canControl: false }, webAccess: { role: 'family' } }));
  const action = { now: 3000, input: 'providers', role: 'master', readOnly: false,
    topology: 'pair', pair: { role: 'master', canControl: true }, webAccess: { role: 'admin' }, automation: { home: { enabled: true } } };
  const result = retainNewerDashboardObservations(action, before, newer);
  assert.equal(result.role, 'slave');
  assert.equal(result.readOnly, true);
  assert.equal(result.pair.canControl, false);
  assert.equal(result.webAccess.role, 'family');
  assert.equal(dashboardWriterState(result), 'unavailable');
  assert.equal(result.automation, action.automation, 'The explicit action outcome remains available');
  assert.equal(retainNewerDashboardObservations(status('ready'), newer, newer).role, 'master',
    'A later full status can establish new authority normally');
});

test('newer standalone health fences an older status response without renewing unaffected evidence', () => {
  const before = status('ready');
  const newer = observeDashboardHealth(before, status('unavailable').recordingHealth);
  const lateStatus = status('ready', { now: 3000 });
  const result = retainNewerDashboardObservations(lateStatus, before, newer);
  assert.equal(result.recordingHealth, newer.recordingHealth);
  assert.equal(result.recordingHealth.checkedAt, 2000);
  const paired = { ...before, pair: { role: 'master', canControl: true } };
  const pairedResult = retainNewerDashboardObservations(lateStatus, before, paired);
  assert.equal(pairedResult.recordingHealth, lateStatus.recordingHealth, 'A pairing observation does not supersede health');
});

test('a changed dataset during an action cannot grant control over the still displayed equipment', () => {
  const before = status('ready'); before.recordingHealth.contextId = 'synthetic-before';
  const changed = status('ready', { input: 'simulated' });
  changed.recordingHealth.contextId = 'synthetic-after'; changed.recordingHealth.scope = 'simulated';
  const observed = observeDashboardStatus(before, changed);
  assert.equal(observed.input, before.input);
  assert.equal(observed.storageContextPending, true);
  const lateAction = retainNewerDashboardObservations({ now: 3000, input: 'providers', role: 'master' }, before, observed);
  assert.equal(lateAction.storageContextPending, true);
  assert.equal(lateAction.recordingHealth.contextId, 'synthetic-after');
  assert.equal(retainDashboardHealth(lateAction, changed).storageContextPending, undefined);
});

test('a late action cannot replace a newer complete dataset with its old equipment payload', () => {
  const before = status('ready', { equipment: { devices: [{ id: 'synthetic-old-switch' }] } });
  before.recordingHealth.contextId = 'synthetic-before';
  const latest = status('ready', { equipment: { devices: [{ id: 'synthetic-new-switch' }] } });
  latest.recordingHealth.contextId = 'synthetic-after';
  const action = { ...before, now: 3000, equipment: { devices: [{ id: 'synthetic-old-switch', enabled: true }] } };
  assert.equal(retainNewerDashboardObservations(action, before, latest), latest);
  assert.equal(retainNewerDashboardObservations(action, before, { ...latest, input: 'simulated' }).input, 'simulated');
});
