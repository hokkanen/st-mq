import test from 'node:test';
import assert from 'node:assert/strict';
import { chargerDisplay } from '../chart/charging.js';
import { chargerSummary, chargingNotice } from '../chart/charging-summary.js';
import { chargingSessionPause } from '../chart/charging-status.js';

const now = Date.parse('2026-10-19T06:00:00Z');

test('lost current Pause confirmation does not claim the charger never confirmed stopping', () => {
  const item = { ...connected('charger2'), request: { pause: { requestedAt: now - 60_000 } },
    control: { phase: 'waiting', sessionPause: { active: true, requestedAt: now - 60_000,
      confirmed: false, reason: 'session-pause-unconfirmed' } } };
  const pause = chargingSessionPause(item);
  assert.equal(pause.confirmed, false);
  assert.equal(pause.unconfirmed, true);
  assert.equal(pause.label, 'Pause unconfirmed');
  assert.match(pause.detail, /current stopping confirmation is unavailable/);
  assert.match(pause.detail, /physical readings and their original times/);
  assert.doesNotMatch(pause.detail, /has not confirmed/);
});
const reading = (value, source = 'shelly-evse') => ({ value, source, available: value !== null, measuredAt: now });
function connected(id) {
  return { id, provider: id === 'charger1' ? 'easee' : 'shelly-evse', capabilities: { scheduling: true },
    settings: { enabled: true }, request: { sessionId: 'synthetic-status-session', revision: 1 },
    values: { connected: reading(true), charging: reading(false), powerKw: reading(0),
      soc: reading(90.2, 'bmw-cardata'), minimumSoc: reading(90, 'bmw-target-filter') },
    requiredGridKwh: 0, progress: { remainingGridKwh: 0 },
    control: id === 'charger1' ? { phase: 'released', confirmed: true, reason: 'within-limit' }
      : { phase: 'waiting', confirmed: false, reason: 'device-permission-held', devicePermissionHeld: true,
        deviceHold: { eventAt: now - 15_000 }, snapshot: { online: true } } };
}
function present(item) {
  const before = structuredClone(item), view = chargerDisplay(item, { now });
  const summary = chargerSummary(item, view, { now }), notice = chargingNotice(item, view, summary);
  assert.deepEqual(item, before, 'Presentation cannot change command confirmation, native holds or session intent');
  return { view, summary, notice };
}

test('normal completion has identical activity, role and completion on both integrations', () => {
  for (const id of ['charger1', 'charger2']) {
    const { view, summary, notice } = present(connected(id));
    assert.equal(view.state, 'Target reached');
    assert.equal(summary.activity, 'Target reached');
    assert.equal(summary.roleLabel, 'Controlled');
    assert.equal(summary.completion.value, 'Reached');
    assert.equal(notice.label, 'Target reached'); assert.equal(notice.state, 'good');
    assert.equal(view.problem, ''); assert.equal(view.risk, false);
    assert.match(notice.detail, /reported vehicle charge.*charging has stopped/);
    assert.doesNotMatch(view.controlReason, /Waiting for it to restore|Waiting for the next/);
    if (id === 'charger2') assert.match(notice.detail, /permission is off.*No replacement Start/);
  }
});

test('a recorded completion needs no invented live native health and retains its dated scope', () => {
  const item = connected('charger2');
  Object.assign(item, { readOnly: true, recorded: true, snapshotAt: now }); item.control.snapshot = null;
  const { view, summary, notice } = present(item);
  assert.equal(view.problem, ''); assert.equal(summary.activity, 'Target reached');
  assert.equal(notice.label, 'Target reached');
  assert.match(notice.detail, /Recorded master status.*live charger health is unavailable/);
  assert.equal(item.control.confirmed, false); assert.equal(item.control.snapshot, null);
  for (const patch of [{ readOnly: false }, { recorded: false }, { snapshotAt: null }])
    assert.equal(present({ ...item, ...patch }).notice.state, 'attention');
  item.control.snapshot = { online: false };
  assert.equal(present(item).notice.state, 'attention');
  item.control.snapshot = null;
  item.control.pending = { stage: 'dispatched', role: 'start_charging', value: true };
  assert.equal(present(item).notice.state, 'attention');
});

test('completion stays visible with Automatic off or Charge now still selected', () => {
  for (const id of ['charger1', 'charger2']) for (const chargeNow of [false, true]) {
    const item = connected(id); item.settings.enabled = false; item.request.chargeNow = chargeNow;
    const { summary, notice } = present(item);
    assert.equal(notice.label, 'Target reached');
    assert.equal(summary.roleLabel, chargeNow ? 'Charge now' : 'Observed');
  }
});

test('estimated completion and missing energy coverage never become confirmed vehicle completion', () => {
  for (const id of ['charger1', 'charger2']) for (const patch of [
    { value: 40 }, { available: false }, { retained: true }, { assumed: true }, { source: 'manual-fallback' },
  ]) {
    const item = connected(id); Object.assign(item.values.soc, patch);
    item.progress = { remainingGridKwh: 0, estimatedSoc: 90, hasEnergyEstimate: true,
      basis: { energyCoverageIncomplete: true } };
    const { summary, notice } = present(item);
    assert.equal(summary.completion.value, 'Estimated reached');
    assert.equal(notice.label, 'Estimated target reached'); assert.equal(notice.state, 'attention');
    assert.match(notice.detail, /estimated.*rather than confirmed.*Energy measurements have gaps/s);
  }
});

test('observed completion keeps energy gaps secondary without losing their explanation', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = connected(id); item.progress.basis = { energyCoverageIncomplete: true };
    const { notice } = present(item);
    assert.equal(notice.label, 'Target reached'); assert.equal(notice.state, 'good');
    assert.match(notice.detail, /Energy measurements have gaps/);
  }
});

test('target attainment never implies that the vehicle has stopped charging', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = connected(id);
    item.control = { phase: 'released', confirmed: true };
    item.values.charging = reading(true); item.values.powerKw = reading(7.2);
    const { view, summary, notice } = present(item);
    assert.equal(view.state, 'Charging'); assert.match(summary.activity, /^Charging.*7.2 kW/);
    assert.match(summary.compactSummary, /Target reached/);
    assert.match(notice.detail, /still charging.*own charge limit/);
    item.values.powerKw.available = false;
    assert.equal(present(item).summary.activity, 'Charging now');
  }
});

test('zero draw alone cannot prove completion or the cause of stopping', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = connected(id); item.requiredGridKwh = 10; item.progress.remainingGridKwh = 10;
    item.values.soc = reading(40, 'teslamate'); item.control = { phase: 'released', confirmed: true };
    const { summary, notice } = present(item);
    assert.equal(summary.activity, 'Connected · not charging');
    assert.doesNotMatch(notice.label, /reached|full|Stopped by charger/);
    item.values.charging.available = false;
    assert.equal(present(item).summary.activity, 'Charging status unavailable');
  }
});

test('an evidenced device hold remains a visible charging blocker below target', () => {
  const item = connected('charger2'); item.requiredGridKwh = 10; item.progress.remainingGridKwh = 10;
  item.values.soc = reading(40, 'bmw-cardata');
  const { view, summary, notice } = present(item);
  assert.equal(view.state, 'Stopped by charger'); assert.equal(summary.activity, 'Stopped by charger');
  assert.equal(notice.label, 'Stopped by charger'); assert.equal(notice.state, 'attention');
  assert.match(notice.detail, /withdrew charging permission.*no replacement Start/);
});

test('faults, uncertain instructions and recovery remain visible after either target is reached', () => {
  for (const id of ['charger1', 'charger2']) for (const enabled of [true, false]) for (const patch of [
    { errorCode: 'charger-fault', confirmed: false },
    { pending: { role: 'start_charging', stage: 'dispatched', value: true }, confirmed: false },
    { phase: 'uncertain', confirmed: false, reason: 'evse-command-unconfirmed' },
    { handoverConfirmed: false },
    { currentTest: { phase: 'restoring', restoreCurrentA: 16 } },
    { takeover: { state: 'blocked', reason: 'evse-native-schedule-unconfirmed' } },
  ]) {
    const item = connected(id); item.settings.enabled = enabled; Object.assign(item.control, patch);
    const { notice } = present(item);
    assert.equal(notice.state, 'attention', `${id}: ${JSON.stringify(patch)}`);
    assert.notEqual(notice.label, 'Target reached');
  }
});

test('loss of connection or physical readings cannot turn a cached device hold into healthy completion', () => {
  for (const patch of ['offline', 'unknown-charging', 'unknown-connection']) {
    const item = connected('charger2');
    if (patch === 'offline') item.control.snapshot.online = false;
    if (patch === 'unknown-charging') item.values.charging.available = false;
    if (patch === 'unknown-connection') item.values.connected.available = false;
    assert.equal(present(item).notice.state, 'attention');
  }
});

test('a missing selected target cannot become completion from cached zero remaining energy', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = connected(id); item.values.minimumSoc = reading(null);
    const { summary, notice } = present(item);
    assert.notEqual(summary.completion.value, 'Reached');
    assert.notEqual(summary.completion.value, 'Estimated reached');
    assert.doesNotMatch(notice.label, /target reached/i);
  }
});

test('an earlier zero-energy forecast cannot substitute for missing current progress', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = connected(id); delete item.progress; delete item.requiredGridKwh;
    item.plan = { requiredGridKwh: 0 }; item.forecast = null;
    const { notice } = present(item);
    assert.doesNotMatch(notice.label, /target reached/i);
  }
});
