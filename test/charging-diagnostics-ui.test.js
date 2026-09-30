import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingDiagnosticsPanel, chargingReportFacts, chargingPlanChanges, chargingPlanPresentation } from '../chart/charging-diagnostics.js';

function fixture() {
  const document = { activeElement: null };
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, events: new Map(), className: '', textContent: '', open: false }); }
    append(...children) { for (const node of children) { node.parent = this; this.children.push(node); } }
    insertBefore(node, reference) { if (node === reference) return; node.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, node); node.parent = this; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest(selector) { return this.tagName === selector.toUpperCase() ? this : this.parent?.closest(selector) ?? null; }
    replaceChildren(...children) { for (const node of this.children) node.parent = null; this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(name, listener) { this.events.set(name, listener); }
    dispatch(name, event = {}) { return this.events.get(name)?.(event); }
    focus() { document.activeElement = this; }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
    querySelector(selector) { return descendants(this).find(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector.toUpperCase()) ?? null; }
  }
  document.createElement = tag => new Node(tag);
  document.body = document.createElement('body');
  document.getElementById = id => descendants(document.body).find(node => node.id === id) ?? null;
  document.querySelector = selector => selector === 'dialog[open]'
    ? descendants(document.body).find(node => node.tagName === 'DIALOG' && node.open) ?? null
    : document.body.querySelector(selector);
  for (const id of ['charger1', 'charger2']) {
    const summary = document.createElement('summary'); summary.id = `${id}-device-summary`;
    const footer = document.createElement('div'); footer.className = 'charging-disclosure';
    summary.append(footer); document.body.append(summary);
  }
  return document;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const now = Date.parse('2026-09-28T18:00:00Z');
function status() {
  const report = { id: 'current', startedAt: now, endedAt: null, evaluatedAt: now, chargerId: 'charger1',
    behavior: 'expected', outcome: { state: 'in-progress' }, coverage: { initialRelease: { state: 'verified' } }, findings: [],
    timeline: [{ at: now, kind: 'physical', code: 'charging-started' }], plans: [], truncated: { plans: 0, findings: 0, timeline: 0 } };
  return { now, charging: { timezone: 'Europe/Helsinki', chargers: [{ id: 'charger1', label: 'Charger 1' }, { id: 'charger2', label: 'Charger 2' }],
    diagnostics: { version: 1, chargers: [{ id: 'charger1', current: report, recent: [{ ...report, id: 'previous', endedAt: now - 1 }] }] },
    physicalTests: { runs: [{ vehicleId: 'bmw', chargerId: 'charger1', program: 'immediate', phase: 'observing', report: { id: 'current' } }] } } };
}

test('report shortcut preserves focus across refreshes and opens without disclosure or control actions', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  panel.update(state);
  const button = document.getElementById('charger1-session-report'); button.focus();
  panel.update(structuredClone(state));
  assert.equal(document.getElementById('charger1-session-report'), button);
  assert.equal(document.activeElement, button);
  assert.equal(button.textContent, 'Report · Checks passed');
  let prevented = 0, stopped = 0;
  button.dispatch('click', { preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(dialog.open, true); assert.equal(button.getAttribute('aria-expanded'), 'true');
  panel.close();
  assert.equal(dialog.open, false); assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, button);
});

test('opens the requested retained report and does not substitute a different physical session after expiry', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }); panel.update(status());
  panel.open('charger1', 'previous');
  assert.equal(document.getElementById('charging-report-session').value, 'previous');
  panel.close(); panel.open('charger1', 'expired-session');
  const result = document.getElementById('charging-report-dialog').querySelector('.charging-report-result');
  assert.equal(result.children[0].textContent, 'This session report is no longer retained');
  assert.notEqual(document.getElementById('charging-report-session').value, 'current');
});

test('guided assessment link opens the selected vehicle without issuing charger actions', () => {
  const document = fixture(), calls = [], panel = createChargingDiagnosticsPanel({ document, onOpenTest: id => calls.push(id) });
  panel.update(status()); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog'), guided = dialog.querySelector('.charging-report-guided');
  assert.equal(guided.hidden, false);
  guided.children[1].dispatch('click');
  assert.deepEqual(calls, ['bmw']); assert.equal(dialog.open, false);
});

test('current recorded reports show their snapshot scope and incomplete live evidence', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  Object.assign(state.charging.diagnostics.chargers[0].current, { recorded: true, evidenceStale: true });
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(document.getElementById('charger1-session-report').dataset.state, 'unknown');
  assert(descendants(dialog).some(node => /Recorded master report.*Connected at snapshot/.test(node.textContent)));
  assert.equal(dialog.querySelector('.charging-report-result').children[1].textContent, 'Observation is no longer current');
});

test('automatic off, absent schedule and unknown actual battery are explicit despite fallback inputs', () => {
  const report = { startedAt: now, current: { automaticEnabled: false, chargeNow: false, scheduleState: 'none',
    vehicleId: null, vehicleSoc: false, soc: { value: 20, source: 'manual-fallback', assumed: true },
    power: { value: 0, measuredAt: now + 3000 }, powerKw: 0, physicalFresh: true, charging: false, reportedCharging: true },
    timeline: [{ kind: 'session', code: 'observation-started', at: now + 25 * 60_000 }] };
  const facts = Object.fromEntries(chargingReportFacts(report));
  assert.match(facts['Control at last assessment'], /Automatic charging off.*No controller charging schedule/);
  assert.match(facts.Vehicle, /Unidentified.*Actual vehicle battery charge is unconfirmed/);
  assert.equal(facts['Battery input'], '20% · configured assumption');
  assert.match(facts['Measured draw / status'], /0 kW measured.*Charger status reports charging/);
  assert.match(facts['Observation coverage'], /Connection recorded.*monitoring began.*Earlier charging is not covered/);
});

test('snapshot history does not claim changed settings or prices from an opaque reason alone', () => {
  for (const reason of ['price-update', 'session-settings', 'planner-reassessment']) {
    const snapshot = chargingPlanPresentation({ reason, automatic: false, scheduleState: 'none', changes: [],
      inputs: { soc: { value: 20, source: 'manual-fallback' }, target: { value: 80, source: 'session-request' },
        capacity: { value: 74, source: 'manual-fallback', assumed: true } }, vehicleId: null });
    assert.equal(snapshot.title, 'Planning snapshot recorded');
    assert.equal(snapshot.periodLabel, 'No controller charging schedule');
    assert.match(snapshot.inputs, /20% · configured assumption.*80% · session entry.*74 kWh · configured assumption/);
    assert.match(snapshot.vehicle, /Unidentified.*do not establish.*actual battery charge/);
    assert.doesNotMatch(JSON.stringify(snapshot), /prices changed|settings changed|Plan updated/);
  }
});

test('specific semantic deltas show actual values while unchanged, unknown and private fields are omitted', () => {
  const changes = chargingPlanChanges([
    { field: 'startingSoc', before: 20, after: 55 }, { field: 'target', before: 80, after: 80 },
    { field: 'capacity', before: 74, after: 57 }, { field: 'automatic', before: false, after: true },
    { field: 'readyBy', before: now, after: now + 3_600_000 },
    { field: 'periods', before: [], after: [{ startAt: now, endAt: null }] },
    { field: 'prices', before: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 3.5 }],
      after: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 5.2 }] },
    { field: 'priceAvailability', before: [], after: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 5.2 }] },
    { field: 'private-id', before: 'secret-fixture', after: '<img src=x>' },
  ]);
  assert.deepEqual(changes[0], { field: 'startingSoc', label: 'Starting-charge input', before: '20%', after: '55%', complex: false });
  assert.equal(changes.length, 7);
  assert.equal(changes.find(row => row.field === 'periods').before, 'No charging periods');
  assert.match(changes.find(row => row.field === 'periods').after, /open release/);
  assert.match(changes.find(row => row.field === 'prices').before, /3.5 c\/kWh/);
  assert.match(changes.find(row => row.field === 'prices').after, /5.2 c\/kWh/);
  assert.doesNotMatch(JSON.stringify(changes), /secret-fixture|<img/);
});

test('report timeline separates zero measured draw from charger status and preserves original clocks', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.timeline = [{ kind: 'physical', code: 'not-charging-observed', at: now + 20_000, powerKw: 0,
    source: 'easee', measuredAt: now + 3000, receivedAt: now + 5000 },
  { kind: 'charger-status', code: 'charger-reports-charging', at: now + 20_000, powerKw: 0,
    source: 'easee', measuredAt: now + 1000, receivedAt: now + 2000, powerMeasuredAt: now + 3000, powerReceivedAt: now + 5000 }];
  panel.update(state); panel.open('charger1');
  const timeline = document.getElementById('charging-report-dialog').querySelector('.charging-report-timeline');
  const text = descendants(timeline).map(node => node.textContent).join('\n');
  assert.match(text, /No draw measured/);
  assert.match(text, /Charger status reports charging/);
  assert.match(text, /Measured draw 0 kW/);
  assert.match(text, /Measured 28 Sept, 21:00:03 · Received 28 Sept, 21:00:05/);
  assert.doesNotMatch(text, /charging stopped|Physical charging observed|top.up/i);
});

test('empty plans explain missing schedule and exact deltas appear in both timeline and planning snapshots', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.current = { automaticEnabled: false, scheduleState: 'none' };
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(dialog.querySelector('.charging-report-plans').children[0].textContent, 'No controller charging schedule was recorded.');
  const changes = [{ field: 'target', before: 70, after: 80 }];
  report.plans = [{ at: now, reason: 'target-update', changes, automatic: false, scheduleState: 'none', periods: [],
    inputs: { soc: { value: 20, source: 'manual-fallback' }, target: { value: 80, source: 'session-request' } } }];
  report.timeline.push({ kind: 'plan', code: 'target-update', at: now, changes });
  panel.update(state);
  for (const selector of ['.charging-report-timeline', '.charging-report-plans']) {
    const text = descendants(dialog.querySelector(selector)).map(node => node.textContent).join('\n');
    assert.match(text, /Requested target: 70% → 80%/);
    assert.doesNotMatch(text, /Plan updated/);
  }
});

test('a recorded charging code with contradictory zero power is shown as unconfirmed without rewriting it', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.timeline = [{ kind: 'physical', code: 'charging-started', at: now, powerKw: 0, measuredAt: now - 10_000 },
    { kind: 'physical', code: 'charging-stopped', at: now + 1000, powerKw: 0, measuredAt: now - 9000 }];
  const original = structuredClone(report.timeline);
  panel.update(state); panel.open('charger1');
  const timeline = document.getElementById('charging-report-dialog').querySelector('.charging-report-timeline');
  const text = descendants(timeline).map(node => node.textContent).join('\n');
  assert.match(text, /Brief charger-status change/);
  assert.match(text, /No draw measured/);
  assert.doesNotMatch(text, /Draw rose above|Draw fell/);
  assert.deepEqual(report.timeline, original);
});

test('stale measured power is labeled as a last reading and never current draw', () => {
  const facts = Object.fromEntries(chargingReportFacts({ current: { physicalFresh: false, powerKw: null,
    power: { value: 11, measuredAt: now - 3_600_000 }, reportedCharging: true } }));
  assert.match(facts['Measured draw / status'], /Last reading 11 kW.*current draw unavailable/);
});

test('controller execution plans do not imply every future pause is installed in the charger', () => {
  const view = chargingPlanPresentation({ automatic: true, scheduleState: 'installed', state: 'released' });
  assert.match(view.control, /Controller execution plan/);
  assert.match(view.periodLabel, /physical execution is checked separately/);
  assert.doesNotMatch(JSON.stringify(view), /Installed charging instruction/);
  const changes = chargingPlanChanges([{ field: 'soc', before: 20, after: 55 },
    { field: 'feasible', before: true, after: false }, { field: 'provisional', before: false, after: true },
    { field: 'prices', before: [], after: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 5.2 }], omitted: 2 }]);
  assert.equal(changes[0].label, 'Battery input');
  assert.equal(changes[1].after, 'Shortfall forecast');
  assert.equal(changes[2].after, 'Requested');
  assert.equal(changes[3].omitted, 2);
});

test('revised prices with unchanged periods state explicitly that the charging schedule did not move', () => {
  const delta = { field: 'prices', before: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 3.5 }],
    after: [{ startAt: now, endAt: now + 3_600_000, priceCtPerKwh: 4.2 }] };
  const view = chargingPlanPresentation({ reason: 'price-update', scheduleState: 'proposed', changes: [delta] });
  assert.equal(view.periodsUnchanged, true);
  assert.equal(chargingPlanPresentation({ reason: 'initial-plan', changes: [] }).periodsUnchanged, false);
  assert.equal(chargingPlanPresentation({ reason: 'price-update', changes: [] }).periodsUnchanged, false);
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.plans = [{ at: now, reason: 'price-update', changes: [delta], periods: [{ startAt: now + 600_000, endAt: null }] }];
  report.timeline = [{ kind: 'plan', code: 'price-update', at: now, changes: [delta] }];
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  for (const selector of ['.charging-report-timeline', '.charging-report-plans']) {
    const text = descendants(dialog.querySelector(selector)).map(node => node.textContent).join('\n');
    assert.match(text, /Charging periods unchanged/);
    assert.match(text, /3.5 c\/kWh/); assert.match(text, /4.2 c\/kWh/);
  }
});

test('each charger opens only its own reports, including empty and missing selections', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  panel.update(state); panel.open('charger2');
  const dialog = document.getElementById('charging-report-dialog'), select = document.getElementById('charging-report-session');
  assert.equal(document.getElementById('charging-report-title').textContent, 'Charger 2 · Session report');
  assert.equal(select.children.length, 0);
  assert.match(dialog.querySelector('.charging-report-result').children[0].textContent, /No session report for Charger 2/);
  const second = structuredClone(state.charging.diagnostics.chargers[0].current);
  Object.assign(second, { id: 'second-current', chargerId: 'charger2', vehicleId: 'tesla' });
  state.charging.diagnostics.chargers.push({ id: 'charger2', current: second, recent: [{ ...second, id: 'second-old', endedAt: now }] });
  panel.update(state);
  assert.deepEqual(select.children.map(node => node.value), ['second-current', 'second-old']);
  assert.equal(select.value, 'second-current');
  panel.open('charger1');
  assert.deepEqual(select.children.map(node => node.value), ['current', 'previous']);
  panel.open('charger1', 'second-current');
  assert.equal(dialog.querySelector('.charging-report-result').children[0].textContent, 'This session report is no longer retained');
  assert.equal(select.value, 'second-current');
  assert.equal(dialog.querySelector('.charging-report-facts').hidden, true);
});

test('polling preserves expanded history, focused evidence and scroll while adding new events', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.timeline = [{ at: now, kind: 'physical', code: 'charging-observed', powerKw: 7, measuredAt: now, receivedAt: now, source: 'easee' }];
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog'), timeline = dialog.querySelector('.charging-report-timeline');
  const entry = timeline.children[0], evidence = entry.querySelector('details'), summary = evidence.querySelector('summary');
  assert.deepEqual(entry.children, [evidence]); assert.equal(evidence.open, false);
  assert.match(descendants(summary).map(node => node.textContent).join(''), /Draw above 0.1 kW observed/);
  evidence.open = true; summary.focus(); dialog.scrollTop = 380;
  report.observedAt = report.evaluatedAt = now + 5000; panel.update(structuredClone(state));
  assert.equal(timeline.children[0], entry); assert.equal(document.activeElement, summary);
  assert.equal(evidence.open, true); assert.equal(dialog.scrollTop, 380);
  report.timeline.push({ at: now + 10_000, kind: 'physical', code: 'charging-stopped', powerKw: 0, source: 'easee' });
  panel.update(state);
  assert.equal(timeline.children[1], entry); assert.equal(document.activeElement, summary); assert.equal(evidence.open, true);
  assert.equal(dialog.scrollTop, 380);
});

test('unchanged planning snapshots leave one baseline and keep extra records folded for inspection', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  const baseline = { at: now, reason: 'initial-plan', periods: [], inputs: { soc: { value: 20, source: 'manual-fallback' }, target: { value: 80, source: 'manual-fallback' } }, automatic: false, scheduleState: 'none' };
  report.plans = [baseline, { ...structuredClone(baseline), at: now + 15 * 60_000, reason: 'price-update' }, { ...structuredClone(baseline), at: now + 30 * 60_000, reason: 'session-settings' }];
  report.timeline = report.plans.map(p => ({ kind: 'plan', code: p.reason, at: p.at }));
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog'), plans = dialog.querySelector('.charging-report-plans');
  assert.equal(plans.children.length, 1);
  const routine = dialog.querySelector('.charging-report-routine');
  assert.equal(routine.hidden, false); assert.equal(routine.open, false);
  assert.match(routine.querySelector('summary').textContent, /2 routine planning records/);
  assert.equal(routine.querySelector('ol').children.length, 2);
  assert.equal(dialog.querySelector('.charging-report-timeline').children.length, 1);
});

test('distinct planning records at the same timestamp retain separate stable nodes during refreshes', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.plans = [
    { at: now, reason: 'initial-plan', inputs: { target: { value: 80 } }, periods: [] },
    { at: now, reason: 'target-update', changes: [{ field: 'target', before: 80, after: 85 }], inputs: { target: { value: 85 } }, periods: [] },
  ];
  panel.update(state); panel.open('charger1');
  const plans = document.getElementById('charging-report-dialog').querySelector('.charging-report-plans');
  const nodes = [...plans.children];
  assert.equal(nodes.length, 2); assert.notEqual(nodes[0], nodes[1]);
  for (const node of nodes) {
    const fold = node.querySelector('details'); assert.deepEqual(node.children, [fold]); assert.equal(fold.open, false);
  }
  assert.match(descendants(nodes[0].querySelector('summary')).map(node => node.textContent).join(''), /Requested target changed/);
  const detail = nodes[1].querySelector('details'); detail.open = true; detail.querySelector('summary').focus();
  for (let i = 0; i < 3; i++) panel.update(structuredClone(state));
  assert.deepEqual(plans.children, nodes); assert.equal(detail.open, true);
  assert.equal(document.activeElement, detail.querySelector('summary'));
  assert.match(descendants(nodes[0]).map(node => node.textContent).join('\n'), /80% → 85%/);
  assert.match(descendants(nodes[1]).map(node => node.textContent).join('\n'), /Initial planning snapshot/);
});

test('an unavailable report has an explicit error while retaining its saved evidence', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  state.charging.diagnostics.available = false;
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(dialog.querySelector('.charging-report-result').children[0].textContent, 'Session diagnostics could not be saved.');
  assert.equal(dialog.querySelector('.charging-report-timeline').children.length, 1);
  assert.equal(document.getElementById('charger1-session-report').dataset.state, 'unknown');
});

test('inactive automatic control remains distinct from lost evidence and preserves the bounded cause', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.current = { automaticEnabled: false, controlAvailability: 'unavailable', scheduleState: 'none' };
  report.timeline = [
    { at: now, kind: 'evidence', code: 'physical-evidence-lost', physicalKnown: false,
      source: 'easee', measuredAt: now - 45_000, receivedAt: now - 30_000 },
    { at: now + 1, kind: 'control', code: 'off', automaticEnabled: false,
      availability: 'unavailable', physicalKnown: false, errorCode: 'read-failed', handoverConfirmed: false },
  ];
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  assert.match(descendants(dialog.querySelector('.charging-report-facts')).map(node => node.textContent).join('\n'), /Automatic charging off.*Charger control unavailable/);
  const text = descendants(dialog.querySelector('.charging-report-timeline')).map(node => node.textContent).join('\n');
  assert.match(text, /Recovery has not been observed/);
  assert.match(text, /Automatic control inactive · control unavailable/);
  assert.match(text, /Charger read failed/);
  assert.match(text, /Control handover unconfirmed/);
  assert.match(text, /Last power sample 28 Sept, 20:59:15/);
  assert.doesNotMatch(text, /temporarily unavailable|Evidence became available again/);
});

test('guided assessment link passes the exact report-linked assessment instead of a newer vehicle run', () => {
  const document = fixture(), calls = [], panel = createChargingDiagnosticsPanel({ document, onOpenTest: (...args) => calls.push(args) }), state = status();
  const linked = state.charging.physicalTests.runs[0]; linked.id = 'original-test'; linked.phase = 'completed';
  state.charging.physicalTests.runs.unshift({ ...linked, id: 'newer-test', phase: 'observing', report: { id: 'different-report' } });
  panel.update(state); panel.open('charger1');
  document.getElementById('charging-report-dialog').querySelector('.charging-report-guided').children[1].dispatch('click');
  assert.deepEqual(calls, [['bmw', 'original-test']]);
});

test('editing a missed deadline closes the old request without claiming charging recovered', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  const report = state.charging.diagnostics.chargers[0].current;
  report.findings = [{ code: 'deadline-missed', firstAt: now, resolvedAt: now + 60_000, resolution: 'request-changed' }];
  report.recoveredCount = 1;
  report.timeline = [{ at: now + 60_000, kind: 'recovery', code: 'deadline-missed', resolution: 'request-changed' }];
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  const findingText = descendants(dialog.querySelector('.charging-report-findings')).map(node => node.textContent).join('\n');
  const eventText = descendants(dialog.querySelector('.charging-report-timeline')).map(node => node.textContent).join('\n');
  assert.match(findingText, /Request changed/); assert.match(eventText, /request changed/);
  assert.doesNotMatch(`${findingText}\n${eventText}`, /recovered/i);
  assert.equal(document.getElementById('charger1-session-report').textContent, 'Report · Past issue');
});
