import test from 'node:test';
import assert from 'node:assert/strict';
import { chargerSummary, chargingCost, chargingNotice } from '../chart/charging-summary.js';
import { chargerDisplay, chargingTime } from '../chart/charging.js';

const now = Date.parse('2026-09-15T18:00:00Z'), hour = 3_600_000;
const startAt = now + 2 * hour, finishAt = now + 7 * hour, deadlineAt = now + 9 * hour;
const reading = value => ({ value, available: value !== null, source: 'mqtt' });
function charger(patch = {}) {
  return { id: 'charger1', label: 'Charger 1', capabilities: { scheduling: true }, settings: { enabled: true },
    values: { connected: reading(true), soc: reading(40), minimumSoc: reading(85), scheduledStartAt: reading(startAt) },
    requiredGridKwh: 30, control: { phase: 'waiting', owned: { startAt } },
    plan: { state: 'waiting', startAt, finishAt, deadlineAt, feasible: true }, ...patch };
}
function summary(item) {
  return chargerSummary(item, chargerDisplay(item, { now }), { now, formatTime: value => chargingTime(value, 'Europe/Helsinki', now) });
}
const notice = item => chargingNotice(item, chargerDisplay(item, { now }), summary(item));

test('missing vehicle feeds leave both chargers planned with configured inputs', () => {
  for (const id of ['charger1', 'charger2']) {
    const item = charger({ id, vehicle: { state: 'identifying', id: null },
      identification: { phase: 'waiting', active: true, available: false, reason: 'vehicle-feed-stale' },
      plan: { state: 'waiting', startAt, finishAt, deadlineAt, feasible: true,
        periods: [{ startAt, endAt: null }] } });
    const display = chargerDisplay(item, { now }), result = summary(item);
    assert.equal(display.periodRows.length, 1);
    assert.equal(result.roleLabel, 'Controlled');
    assert.equal(result.completion.at, finishAt);
    assert.match(result.activity, /Starts/);
    assert.equal(item.vehicle.id, null, 'A plan never establishes vehicle identity');
    assert.match(notice(item).label, /Identification/);
  }
});

test('OCPP approval pending shows proposed periods without claiming applied control or completion', () => {
  const item = charger({ control: { phase: 'unavailable', errorCode: 'transaction-unconfirmed',
    reason: 'Waiting for a current transaction confirmed on this connection.',
    snapshot: { transport: 'ocpp', transactionConfirmed: false } },
    identification: { phase: 'waiting', active: true, available: false },
    plan: { state: 'waiting', startAt, finishAt, deadlineAt, feasible: true,
      periods: [{ startAt, endAt: null }] } });
  const display = chargerDisplay(item, { now }), result = summary(item);
  assert.equal(display.periodRows.length, 1);
  assert.equal(display.eventKind, 'proposed');
  assert.match(display.event, /Planned start.*approval pending/);
  assert.equal(result.roleLabel, 'Approval pending');
  assert.match(result.roleDetail, /start approval waits until the plan/);
  assert.equal(result.roleState, 'uncertain');
  assert.equal(result.completion.at, null);
  assert.notEqual(display.readiness, 'Expected on time');
  assert.notEqual(summary({ ...item, plan: null }).roleLabel, 'Approval pending', 'A missing plan is not advertised as available');
  for (const errorCode of ['status-stale', 'read-failed']) {
    const unavailable = chargerDisplay({ ...item, control: { ...item.control, errorCode } }, { now });
    assert.equal(unavailable.periodRows.length, 0);
    assert.equal(unavailable.state, 'Control unavailable');
  }
});

test('a summary warning explains uncertainty without claiming a stale healthy forecast', () => {
  const result = notice(charger({ control: { phase: 'unconfirmed', reason: 'Waiting for a fresh charger reading.' } }));
  assert.equal(result.state, 'attention'); assert.equal(result.label, 'Charger needs attention');
  assert.match(result.detail, /fresh charger reading/); assert.doesNotMatch(result.detail, /Expected on time/);
});

test('both charger cards use concise activity labels while retaining complete instruction details', () => {
  for (const [id, provider] of [['charger1', 'easee'], ['charger2', 'shelly-evse']]) {
    for (const [kind, label] of [['stop', 'Stop instruction active'], ['schedule', 'Charger schedule active'],
      ['release', 'Charging release active']]) {
      const reason = 'The charger reported a separate instruction. It remains active until changed.';
      const item = charger({ id, provider, control: { phase: 'manual', manual: { kind, reason } } });
      const display = chargerDisplay(item, { now }), result = summary(item);
      assert.equal(result.activity, label);
      assert.equal(display.controlReason, reason, 'The compact activity must not discard the detailed provider explanation');
      assert.doesNotMatch(result.activity, /[.!?]$/);
      assert.doesNotMatch(result.roleLabel, /[.!?]$/);
    }
    for (const control of [{ phase: 'unavailable', reason: 'read-failed' }, { phase: 'off', handoverConfirmed: false }]) {
      const item = charger({ id, provider, settings: { enabled: control.phase !== 'off' }, control });
      const result = summary(item);
      assert.match(result.activity, /^Waiting for (?:charger|handover) confirmation$/);
      assert.doesNotMatch(result.activity, /[.!?]$/);
      assert.match(result.roleDetail, /[.]$/);
    }
  }
});

test('confirmed controller-held and native pauses share activity and completion while unconfirmed pauses stay distinct', () => {
  const periods = [{ startAt: now - 2 * hour, endAt: now - hour }, { startAt, endAt: null }];
  const execution = { planId: 'accepted', periods, finalStartAt: startAt };
  const states = [
    { provider: 'easee', control: { phase: 'paused', confirmed: true, ownsInstruction: true,
      pauseConfirmed: true, owned: { startAt }, execution } },
    { provider: 'shelly-evse', control: { phase: 'waiting', reason: 'economic-wait', confirmed: true,
      executionStage: 'physical-effect', nativeExpiry: false, ownsInstruction: true, pauseConfirmed: true,
      owned: null, pending: null, manual: null, execution } },
  ];
  for (const state of states) {
    const item = charger({ ...state, values: { connected: reading(true), charging: reading(false), minimumSoc: reading(80) },
      plan: { id: 'accepted', state: 'waiting', periods, startAt, finishAt, deadlineAt, feasible: true } });
    const display = chargerDisplay(item, { now }), result = summary(item);
    assert.equal(display.state, 'Paused between periods', state.provider);
    assert.equal(result.activity, 'Paused between periods · Resumes 23:00', state.provider);
    assert.equal(result.roleLabel, 'Controlled', state.provider);
    assert.equal(result.completion.at, finishAt, state.provider);
    for (const evidence of [{ pauseConfirmed: false }, { ownsInstruction: false }, { confirmed: false }]) {
      const unconfirmed = { ...item, control: { ...item.control, ...evidence } };
      assert.equal(summary(unconfirmed).roleState, 'uncertain', `${state.provider}: ${JSON.stringify(evidence)}`);
      assert.equal(summary(unconfirmed).completion.at, null);
      assert.notEqual(chargerDisplay(unconfirmed, { now }).state, 'Paused between periods');
    }
  }
  const held = charger({ ...states[1], plan: { id: 'accepted', periods, startAt, finishAt, deadlineAt, feasible: true } });
  for (const control of [
    { ...held.control, pending: { stage: 'dispatched' } },
    { ...held.control, phase: 'active' },
    { ...held.control, nativeExpiry: true },
  ]) assert.equal(chargerDisplay({ ...held, control }, { now }).state, 'Pause unconfirmed');
});

test('manual resumption remains daily information while disconnected and OFF is explicit', () => {
  const item = charger(), disconnected = { ...item, values: { ...item.values, connected: reading(false) } };
  const result = notice({ ...disconnected, control: { phase: 'yielded', manual: { kind: 'window',
    startsAt: startAt, resumeAt: deadlineAt, windowEndAt: deadlineAt + hour } } });
  assert.equal(result.label, 'Automatic resumes tomorrow 06:00');
  assert.match(result.detail, /ready-by boundary/);
  assert.equal(notice({ ...disconnected, settings: { enabled: false } }).label, 'Automatic charging is off');
});

test('target reached is equally visible for observed and automatically controlled charging', () => {
  for (const scheduling of [true, false]) {
    const result = notice(charger({ requiredGridKwh: 0, capabilities: { scheduling } }));
    assert.match(result.label, /^Target reached/); assert.match(result.detail, /vehicle may continue/);
  }
  assert.equal(notice(charger({ plan: {}, forecast: null })).label, 'Automatic charging is on');
});

test('controlled and observed roles share start activity and estimated target semantics', () => {
  const controlled = summary(charger());
  assert.equal(controlled.roleLabel, 'Controlled'); assert.equal(controlled.roleState, 'controlled');
  assert.equal(controlled.activity, 'Starts 23:00'); assert.equal(controlled.compactSummary, 'Controlled · Starts 23:00');
  assert.deepEqual(controlled.completion, { value: 'tomorrow 04:00', detail: 'Expected on time', at: finishAt });
  const observed = summary(charger({ capabilities: { scheduling: false }, plan: { state: 'observing' },
    forecast: { state: 'forecast', reason: 'automatic-current-forecast', finishAt } }));
  assert.equal(observed.roleLabel, 'Observed'); assert.equal(observed.activity, 'Scheduled start 23:00');
  assert.equal(observed.compactSummary, 'Observed · Scheduled start 23:00');
  assert.equal(observed.completion.value, controlled.completion.value);
});

test('turning automatic charging off changes the role and discards its old estimate', () => {
  const off = summary(charger({ settings: { enabled: false } }));
  assert.equal(off.roleLabel, 'Observed'); assert.match(off.roleDetail, /off/);
  assert.equal(off.completion.value, 'No estimate');
  const staleForecast = summary(charger({ settings: { enabled: false }, forecast: { state: 'planned', controlled: true, finishAt } }));
  assert.equal(staleForecast.completion.at, null);
  const currentNativeForecast = summary(charger({ settings: { enabled: false },
    forecast: { state: 'forecast', controlled: false, finishAt } }));
  assert.equal(currentNativeForecast.completion.at, finishAt);
});

test('identification keeps progress visible with automatic OFF without reviving stale forecasts or hiding manual Stop', () => {
  const identification = { phase: 'waiting', active: true, available: false, reason: 'manual-stop' };
  const item = charger({ settings: { enabled: false }, identification,
    control: { phase: 'yielded', manual: { kind: 'stop', reason: 'Manual Stop is active.' } } });
  const stopped = summary(item);
  assert.equal(stopped.roleLabel, 'Manual override'); assert.equal(stopped.activity, 'Stop instruction active');
  assert.equal(stopped.completion.at, null);
  const testing = { ...item, settings: { enabled: true }, identification: { ...identification, phase: 'pausing', reason: 'awaiting-stop-confirmation' }, control: { phase: 'identifying' } };
  const result = summary(testing);
  assert.equal(result.roleLabel, 'Identifying'); assert.equal(result.completion.value, 'Checking');
  assert.equal(result.completion.at, null); assert.deepEqual(chargerDisplay(testing, { now }).periodRows, []);
  assert.doesNotMatch(chargerDisplay(testing, { now }).readiness, /Expected on time/);
  const unconfirmed = summary({ ...testing, settings: { enabled: false }, control: { phase: 'pause-unconfirmed' } });
  assert.equal(unconfirmed.roleLabel, 'Control unconfirmed');
});

test('identification activity distinguishes requested pauses, observed stops and outstanding recovery without stale completion', () => {
  const item = charger({ provider: 'shelly-evse', settings: { enabled: false }, control: { phase: 'identifying' },
    identification: { phase: 'pausing', reason: 'awaiting-stop-confirmation', active: true, pauseOutstanding: true, pauseRecovery: 'controller' } });
  assert.equal(summary({ ...item, values: { ...item.values, charging: reading(true) } }).activity, 'Charging · Pause requested');
  assert.equal(summary({ ...item, values: { ...item.values, charging: reading(false) } }).activity, 'Confirming vehicle');
  const completed = { ...item, vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' },
    identification: { ...item.identification, phase: 'completed', active: false } };
  const result = summary(completed);
  assert.equal(result.activity, 'Pause recovery pending'); assert.equal(result.roleState, 'uncertain');
  assert.equal(result.completion.at, null); assert.equal(notice(completed).label, 'Pause recovery pending');
  assert.doesNotMatch(result.roleDetail, /has resumed|now applies/);
});

test('live activity keeps charging and pause status while the ETA moves to its own column', () => {
  const item = charger(), values = { ...item.values, charging: reading(true), powerKw: reading(8.2) };
  const charging = summary({ ...item, values, control: { phase: 'released' }, forecast: { finishAt } });
  assert.equal(charging.activity, 'Charging · 8.2 kW now');
  assert.equal(charging.completion.at, finishAt); assert(!charging.compactSummary.includes('estimated'));
  const periods = [{ startAt: now - hour, endAt: now + hour }, { startAt, endAt: null }];
  const paused = summary({ ...item, values, plan: { ...item.plan, periods }, control: { phase: 'waiting', owned: { periods } } });
  assert.equal(paused.activity, 'Charging · 8.2 kW now · pauses 22:00');
  const between = summary({ ...item, plan: { ...item.plan, periods: [{ startAt: now - 2 * hour, endAt: now - hour }, periods[1]] },
    control: { phase: 'paused', owned: { startAt, periods: [{ startAt: now - 2 * hour, endAt: now - hour }, periods[1]] } } });
  assert.equal(between.activity, 'Paused between periods · Resumes 23:00');
});

test('an idle vehicle in an active period keeps permission separate from its target warning', () => {
  const at = clock => Date.parse(`2026-09-26T${clock}+03:00`), currentTime = at('02:15');
  const periods = [{ startAt: at('01:00'), endAt: at('02:30') }, { startAt: at('03:30'), endAt: at('04:00') },
    { startAt: at('04:20'), endAt: null }];
  const item = charger({ control: { phase: 'active', owned: { startAt: periods[0].startAt }, execution: { planId: 'accepted', periods } },
    values: { connected: reading(true), charging: reading(false), soc: reading(45), minimumSoc: reading(100) },
    plan: { id: 'accepted', periods, deadlineAt: at('06:00') },
    forecast: { finishAt: null, feasible: false, reason: 'insufficient-time' } });
  const display = chargerDisplay(item, { now: currentTime }), result = chargerSummary(item, display, { now: currentTime });
  assert.equal(result.activity, 'Charging is allowed');
  assert.equal(result.compactSummary, 'Controlled · Charging is allowed');
  assert.equal(result.completion.detail, 'Target at risk');
  assert.equal(chargingNotice(item, display, result).label, 'Target may be late');
});

test('a planned gap without a confirmed pause stays uncertain throughout the summary', () => {
  const periods = [{ startAt: now - 2 * hour, endAt: now - hour }, { startAt, endAt: null }];
  const item = charger({ control: { phase: 'active', reason: 'The current planned charging period is open.',
    owned: { startAt: periods[0].startAt }, execution: { planId: 'accepted', periods } },
    plan: { id: 'accepted', periods, startAt: periods[0].startAt, deadlineAt, finishAt, feasible: true } });
  const result = summary(item), display = chargerDisplay(item, { now });
  assert.equal(result.activity, 'Next period 23:00 · pause awaiting confirmation');
  assert.equal(result.roleLabel, 'Control unconfirmed'); assert.equal(result.roleState, 'uncertain');
  assert.match(result.roleDetail, /pause between charging periods has not been confirmed/);
  assert.doesNotMatch(result.roleDetail, /period is open/);
  assert.equal(result.completion.value, 'Checking'); assert.equal(result.completion.at, null);
  assert.equal(chargingNotice(item, display, result).label, 'Charger needs attention');
  for (const patch of [{ phase: 'unconfirmed' }, { phase: 'paused', confirmed: false }]) {
    const pending = summary({ ...item, control: { ...item.control, owned: { startAt }, ...patch } });
    assert.equal(pending.roleState, 'uncertain');
    assert.doesNotMatch(pending.activity, /^Paused|^Resumes/);
  }
});

test('native confirmation cleared during reconciliation invalidates a retained paused summary', () => {
  const periods = [{ startAt: now - 2 * hour, endAt: now - hour }, { startAt, endAt: null }];
  const item = charger({ control: { phase: 'paused', reason: 'The pause is confirmed.', ownsInstruction: false, pauseConfirmed: false,
    owned: { startAt }, execution: { planId: 'accepted', periods } },
    plan: { id: 'accepted', periods, startAt: periods[0].startAt, deadlineAt, finishAt, feasible: true } });
  const result = summary(item), display = chargerDisplay(item, { now });
  assert.equal(result.roleState, 'uncertain'); assert.equal(result.completion.at, null);
  assert.equal(result.activity, 'Next period 23:00 · pause awaiting confirmation');
  assert.match(result.roleDetail, /pause between charging periods has not been confirmed/);
  const warning = chargingNotice(item, display, result);
  assert.equal(warning.label, 'Charger needs attention');
  assert.doesNotMatch(warning.detail, /The pause is confirmed/);
});

test('confirmation of an expired earlier gap cannot give the current gap a healthy summary', () => {
  const periods = [{ startAt: now - 4 * hour, endAt: now - 3 * hour },
    { startAt: now - 2 * hour, endAt: now - hour }, { startAt, endAt: null }];
  const item = charger({ control: { phase: 'paused', reason: 'The pause is confirmed.', ownsInstruction: true, pauseConfirmed: true,
    owned: { startAt: periods[1].startAt }, execution: { planId: 'accepted', periods } },
    plan: { id: 'accepted', periods, deadlineAt, finishAt, feasible: true } });
  const result = summary(item), display = chargerDisplay(item, { now });
  assert.equal(result.roleState, 'uncertain'); assert.equal(result.completion.at, null);
  assert.equal(result.activity, 'Next period 23:00 · pause awaiting confirmation');
  assert.match(result.roleDetail, /pause between charging periods has not been confirmed/);
  assert.equal(chargingNotice(item, display, result).label, 'Charger needs attention');
});

test('manual priority preserves its window and uses only a current native estimate inside that window', () => {
  const control = { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, windowEndAt: deadlineAt, resumeAt: deadlineAt } };
  const manual = summary(charger({ control }));
  assert.equal(manual.roleLabel, 'Manual override'); assert.equal(manual.roleState, 'manual');
  assert.match(manual.activity, /^Manual window 23:00–tomorrow 06:00$/);
  assert.equal(manual.completion.at, null, 'The old automatic plan is inactive');
  const current = summary(charger({ control, forecast: { state: 'forecast', reason: 'automatic-current-forecast', controlled: true, finishAt } }));
  assert.equal(current.completion.at, finishAt);
  const tooLate = summary(charger({ control, forecast: { state: 'forecast', finishAt: deadlineAt + hour } }));
  assert.equal(tooLate.completion.at, null); assert.equal(tooLate.completion.detail, 'Scheduled stop before target');
});

test('manual expiry, unknown ownership and handover failures never claim confirmed control', () => {
  for (const phase of ['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed', 'unconfirmed']) {
    const result = summary(charger({ control: { phase, owned: { startAt } } }));
    assert.equal(result.roleLabel, 'Control unconfirmed'); assert.equal(result.completion.value, 'Checking');
  }
  const unknown = summary(charger({ control: { phase: 'yielded', manual: { kind: 'unknown' } } }));
  assert.equal(unknown.roleLabel, 'Control unconfirmed');
  const expired = summary(charger({ control: { phase: 'yielded', manual: { kind: 'window', resumeAt: now - 1 } } }));
  assert.equal(expired.roleLabel, 'Handover pending'); assert.equal(expired.completion.at, null);
  const handover = summary(charger({ settings: { enabled: false }, control: { phase: 'off', handoverConfirmed: false } }));
  assert.equal(handover.roleLabel, 'Handover unconfirmed'); assert.equal(handover.roleState, 'uncertain');
});

test('an interrupted automatic handover is uncertainty, not an external manual override', () => {
  for (const id of ['charger1', 'charger2']) {
    for (const charging of [false, true]) {
      const item = charger({ id, control: { phase: 'manual', confirmed: true,
        manual: { kind: 'takeover-unconfirmed', detectedAt: now }, reason: 'evse-native-schedule-unconfirmed' } });
      item.values.charging = reading(charging);
      const view = chargerDisplay(item, { now }), result = summary(item);
      assert.equal(view.yielded, false);
      assert.equal(view.state, charging ? 'Charging' : 'Handover unconfirmed');
      assert.equal(view.event, 'Handover unconfirmed');
      assert.match(view.problem, /has not confirmed.*previous schedule/);
      assert.equal(result.roleLabel, 'Handover unconfirmed');
      assert.equal(result.roleState, 'uncertain');
      assert.equal(result.completion.value, 'Checking');
      assert.match(result.activity, /Handover unconfirmed/);
      assert.doesNotMatch(JSON.stringify(result), /Manual override|takeover-unconfirmed|evse-native/);
    }
  }
});

test('a pending revision retains the confirmed start without using the proposed completion', () => {
  const item = charger({ plan: { startAt: startAt + hour, finishAt, deadlineAt } }), result = summary(item);
  assert.equal(result.roleLabel, 'Control unconfirmed');
  assert.equal(result.activity, 'Starts 23:00 · update awaiting confirmation');
  assert.equal(result.completion.at, null);
  const proposal = summary(charger({ control: { phase: 'unconfirmed' } }));
  assert.equal(proposal.activity, 'Proposed start 23:00'); assert.equal(proposal.completion.at, null);
});

test('explicit null forecasts and past finishes cannot revive old automatic estimates', () => {
  for (const forecast of [null, { finishAt: null }, { finishAt: now - 1 }, { state: 'unavailable', finishAt }]) {
    const result = summary(charger({ forecast }));
    assert.equal(result.completion.at, null); assert.equal(result.completion.value, 'Checking');
  }
  assert.equal(summary(charger({ plan: { startAt, finishAt, deadlineAt: now - 1 } })).completion.at, null);
});

test('expanded charger readiness and activity cannot revive an absent or expired completion forecast', () => {
  const item = charger();
  for (const forecast of [null, { finishAt: null, feasible: true }, { finishAt: now - 1, feasible: true }]) {
    const current = { ...item, forecast, values: { ...item.values, charging: reading(true), powerKw: reading(8) } };
    const display = chargerDisplay(current, { now });
    assert.equal(summary(current).completion.at, null);
    assert.equal(display.readiness, 'Readiness being checked');
    assert.equal(display.event, '8 kW now');
    assert.equal(display.risk, false);
  }
  const oldRisk = { ...item, forecast: null, plan: { ...item.plan, feasible: false, reason: 'insufficient-time',
    warnings: ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] } };
  const display = chargerDisplay(oldRisk, { now });
  assert.equal(display.risk, false);
  assert.equal(display.readiness, 'Readiness being checked');
  assert(!display.notes.some(note => /cannot deliver/.test(note)));
});

test('late and awaiting-confirmation forecasts cannot contradict the charger summary with healthy readiness', () => {
  const item = charger();
  const late = { ...item, forecast: { finishAt: deadlineAt + hour, feasible: true } };
  assert.equal(summary(late).completion.detail, 'Target at risk');
  assert.equal(chargerDisplay(late, { now }).risk, true);
  assert.match(chargerDisplay(late, { now }).readiness, /at risk/);
  assert.equal(notice(late).label, 'Target may be late');
  for (const current of [
    { ...item, plan: { ...item.plan, startAt: startAt + hour } },
    { ...item, control: { ...item.control, phase: 'unavailable' } },
  ]) {
    assert.equal(summary(current).roleState, 'uncertain');
    assert.equal(chargerDisplay(current, { now }).readiness, 'Readiness being checked');
  }
});

test('native stop times are not target estimates and an early stop invalidates the forecast finish', () => {
  const item = charger({ capabilities: { scheduling: false }, plan: { state: 'observing' } });
  const values = { ...item.values, scheduledEndAt: reading(deadlineAt) };
  assert.equal(summary({ ...item, values, telemetry: { scheduledEndKind: 'scheduled-stop' } }).completion.at, null);
  const earlyStop = summary({ ...item, values: { ...values, scheduledEndAt: reading(startAt + hour) },
    telemetry: { scheduledEndKind: 'scheduled-stop' }, forecast: { state: 'forecast', finishAt } });
  assert.equal(earlyStop.completion.at, null); assert.equal(earlyStop.completion.detail, 'Scheduled stop before target');
  const informational = summary({ ...item, values: { ...values, scheduledEndAt: reading(startAt + hour) },
    telemetry: { scheduledEndKind: 'informational' }, forecast: { state: 'forecast', finishAt } });
  assert.equal(informational.completion.at, finishAt);
});

test('zero remaining energy wins over missing forecasts and preserves live charging status', () => {
  const item = charger(), result = summary({ ...item, forecast: { finishAt: null }, progress: { remainingGridKwh: 0 },
    values: { ...item.values, charging: reading(true), powerKw: reading(8) } });
  assert.equal(result.completion.value, 'Reached'); assert.equal(result.completion.at, null);
  assert.equal(result.activity, 'Charging · 8 kW now');
  assert.equal(result.compactSummary, 'Controlled · Charging · 8 kW now · Target reached');
});

test('reached target takes priority over an earlier late or infeasible forecast throughout the charger card', () => {
  const item = charger();
  for (const forecast of [{ finishAt: deadlineAt + hour, feasible: true },
    { finishAt: deadlineAt + hour, feasible: false, reason: 'insufficient-time' },
    { finishAt: null, feasible: false, reason: 'insufficient-time' }]) {
    const warnings = ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'];
    const current = { ...item, plan: { ...item.plan, warnings }, forecast: { ...forecast, warnings },
      progress: { remainingGridKwh: 0 } };
    const display = chargerDisplay(current, { now });
    assert.equal(display.readiness, 'Target reached');
    assert.equal(display.risk, false);
    assert.deepEqual(display.notes, []);
    assert.equal(summary(current).completion.value, 'Reached');
    assert.equal(notice(current).label, 'Target reached · vehicle decides when to stop');
    assert.equal(notice(current).state, 'good');
  }
});

test('disconnection and missing native activity suppress old vehicle forecasts', () => {
  const item = charger({ capabilities: { scheduling: false }, plan: { state: 'observing' }, forecast: { state: 'forecast', finishAt } });
  const disconnected = summary({ ...item, values: { ...item.values, connected: reading(false) } });
  assert.equal(disconnected.completion.detail, 'Not connected'); assert.match(disconnected.activity, /^Not connected/);
  const expiredSchedule = summary({ ...item, values: { ...item.values, scheduledStartAt: reading(now - hour) } });
  assert.equal(expiredSchedule.completion.at, null);
});

test('a valid late estimate remains explicitly at risk', () => {
  const late = summary(charger({ forecast: { finishAt: deadlineAt + hour, feasible: false, reason: 'insufficient-time' } }));
  assert.equal(late.completion.at, deadlineAt + hour); assert.equal(late.completion.detail, 'Target at risk');
});

function observed(patch = {}) {
  return charger({ capabilities: { scheduling: false }, plan: { state: 'observing' },
    forecast: { state: 'forecast', reason: 'automatic-current-forecast', startAt, finishAt }, ...patch });
}
const rate = (start, end, price) => ({ start, end, allInCentsPerKWh: price });
function cost(item, prices = []) {
  const view = chargerDisplay(item, { now });
  return chargingCost(item, view, summary(item), { now, prices });
}

test('observed target cost integrates remaining grid energy across actual rate boundaries', () => {
  const item = observed({ progress: { remainingGridKwh: 20 } });
  const prices = [rate(startAt + hour, finishAt + hour, 25), rate(now - hour, startAt + hour, 10)];
  assert.equal(cost(item, prices).value, '€4.40', '4 kWh at 10 c/kWh plus 16 kWh at 25 c/kWh; rates outside charging are excluded');
  assert.match(cost(item, prices).detail, /including charging losses/);
  const projectedRates = prices.map(({ allInCentsPerKWh, ...interval }) => ({ ...interval, totalCtPerKwh: allInCentsPerKWh }));
  assert.equal(cost(item, projectedRates).value, '€4.40');
});

test('native cost clips an already-running forecast to now and prices only energy still needed', () => {
  const item = observed(), active = { ...item, values: { ...item.values, charging: reading(true) },
    progress: { remainingGridKwh: 8 }, forecast: { ...item.forecast, startAt: now - hour, finishAt: now + 2 * hour } };
  const prices = [rate(now - hour, now, 100), rate(now, now + hour, 10), rate(now + hour, now + 2 * hour, 30)];
  assert.equal(cost(active, prices).value, '€1.60', 'The earlier expensive charging is excluded from the remaining cost');
});

test('negative and zero electricity prices retain their actual arithmetic', () => {
  const item = observed({ requiredGridKwh: 10 });
  assert.equal(cost(item, [rate(startAt, finishAt, -15)]).value, '€-1.50');
  assert.equal(cost(item, [rate(startAt, finishAt, 0)]).value, '€0.00');
  assert.equal(cost(item, [rate(startAt, startAt + hour, -20), rate(startAt + hour, finishAt, 5)]).value, '€0.00');
});

test('missing or invalid rates never become a partial target cost', () => {
  const item = observed();
  const missing = [null, {}, [], [rate(startAt + 1, finishAt, 10)], [rate(startAt, finishAt - 1, 10)],
    [rate(startAt, startAt + hour, 10), rate(startAt + hour + 1, finishAt, 20)],
    [rate(startAt, finishAt, null)], [rate(startAt, finishAt, NaN)], [rate(startAt, finishAt, Infinity)],
    [rate(startAt, startAt, 10)], [rate('invalid', finishAt, 10)]];
  for (const prices of missing) assert.equal(cost(item, prices).value, 'No estimate');
});

test('native cost rejects stale, absent and inapplicable forecasts even when rates are available', () => {
  const item = observed(), prices = [rate(now - hour, finishAt + hour, 10)];
  const cases = [
    { ...item, forecast: null },
    { ...item, forecast: { ...item.forecast, finishAt: null } },
    { ...item, forecast: { ...item.forecast, finishAt: now - 1 } },
    { ...item, forecast: { ...item.forecast, startAt: null } },
    { ...item, forecast: { ...item.forecast, startAt: finishAt } },
    { ...item, forecast: { ...item.forecast, state: 'unavailable' } },
    { ...item, forecast: { ...item.forecast, state: 'planned', controlled: true } },
    { ...item, values: { ...item.values, connected: reading(false) } },
    { ...item, values: { ...item.values, scheduledStartAt: reading(now - hour) } },
    { ...item, requiredGridKwh: null },
  ];
  for (const candidate of cases) assert.equal(cost(candidate, prices).value, 'No estimate');
});

test('confirmed controlled cost uses the backend period estimate, while invalidated plans cannot keep an old cost', () => {
  const item = charger(), planned = { ...item, plan: { ...item.plan, costCents: 207 } };
  assert.equal(cost(planned).value, '€2.07', 'The backend estimate already accounts for planned periods and variable power');
  assert.match(cost(planned).detail, /planned charging periods/);
  for (const candidate of [
    { ...planned, forecast: { finishAt: null } },
    { ...planned, forecast: null },
    { ...planned, forecast: { finishAt: now - 1 } },
    { ...planned, control: { phase: 'waiting', owned: { startAt }, confirmed: false } },
    { ...planned, plan: { ...planned.plan, startAt: startAt + hour } },
  ]) assert.equal(cost(candidate).value, 'No estimate');
});

test('a reached target costs zero even with an old nonzero plan or missing rates', () => {
  const item = charger(), planned = { ...item, plan: { ...item.plan, costCents: 207 }, progress: { remainingGridKwh: 0 } };
  assert.equal(cost(planned).value, '€0.00');
  assert.equal(cost(observed({ requiredGridKwh: 0, forecast: null })).value, '€0.00');
  assert.match(cost(planned).detail, /No additional grid energy/);
});

test('an enforced native stop before target invalidates target cost rather than pricing undeliverable energy', () => {
  const item = observed(), prices = [rate(startAt, finishAt, 10)];
  const earlyStop = { ...item, values: { ...item.values, scheduledEndAt: reading(startAt + hour) },
    telemetry: { scheduledEndKind: 'scheduled-stop' } };
  assert.equal(cost(earlyStop, prices).value, 'No estimate');
  const sufficientWindow = { ...earlyStop, values: { ...earlyStop.values, scheduledEndAt: reading(finishAt) } };
  assert.equal(cost(sufficientWindow, prices).value, '€3.00');
});

test('Charge now remains an explicit request while automatic is OFF, with activity and confirmation separate', () => {
  const item = charger({ settings: { enabled: false }, request: { chargeNow: true }, control: { phase: 'released' } });
  const displayed = summary(item);
  assert.equal(displayed.roleLabel, 'Charge now'); assert.equal(displayed.roleState, 'manual');
  assert.match(displayed.roleDetail, /Automatic charging remains off/);
  assert.match(displayed.activity, /Charging requested until unplugging/);
  assert.doesNotMatch(displayed.activity, /^Charging ·/);
  assert.equal(notice(item).label, 'Charge now selected until unplugging');
  const failed = { ...item, control: { phase: 'unconfirmed', confirmed: false, reason: 'Waiting for native confirmation.' } };
  assert.equal(summary(failed).roleState, 'uncertain'); assert.equal(summary(failed).completion.value, 'Checking');
  assert.equal(notice(failed).label, 'Charger needs attention'); assert.match(notice(failed).detail, /native confirmation/);
  const charging = { ...item, values: { ...item.values, charging: reading(true), powerKw: reading(7.4) } };
  assert.match(summary(charging).activity, /^Charging · 7.4 kW/);
});

test('native stop and future manual windows stay visible ahead of a retained Charge now choice', () => {
  for (const manual of [
    { kind: 'stop', reason: 'Charging was stopped at the charger.' },
    { kind: 'window', startsAt: startAt, windowEndAt: finishAt, reason: 'A native charging schedule has priority.' },
  ]) {
    const item = charger({ settings: { enabled: false }, request: { chargeNow: true }, control: { phase: 'yielded', manual } });
    const display = chargerDisplay(item, { now }), result = summary(item);
    assert.equal(display.yielded, true); assert.equal(result.roleLabel, 'Manual override');
    assert.doesNotMatch(result.activity, /Charging requested/);
    assert.match(result.activity, manual.kind === 'stop' ? /^Stop instruction active$/ : /Manual window/);
    assert.equal(notice(item).state, 'manual');
    assert.doesNotMatch(notice(item).detail, /Automatic control resumes/);
  }
});
