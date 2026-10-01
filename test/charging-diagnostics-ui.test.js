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

const flush = () => new Promise(resolve => setImmediate(resolve));
const textOf = node => [node.textContent, ...descendants(node).map(child => child.textContent)].join('\n');
function setup() {
  const document = fixture(), calls = [];
  const current = { id: 'current', startedAt: now, observedFrom: now, endedAt: null, evaluatedAt: now, chargerId: 'charger1', saved: false,
    behavior: 'expected', outcome: { state: 'in-progress' }, coverage: { initialRelease: { state: 'verified' } }, findings: [], counts: { events: 1, findings: 0, plans: 0 } };
  const previous = { ...structuredClone(current), id: 'previous', startedAt: now - 86400_000, endedAt: now - 1 };
  const reports = new Map([[current.id, current], [previous.id, previous]]);
  const records = new Map([[current.id, [{ id: 1, at: now, kind: 'physical', code: 'charging-observed', powerKw: 7, source: 'easee', measuredAt: now, receivedAt: now }]], [previous.id, []]]);
  const state = { now, webAccess: { role: 'admin' }, charging: { timezone: 'Europe/Helsinki', chargers: [{ id: 'charger1', label: 'Charger 1' }, { id: 'charger2', label: 'Charger 2' }],
    diagnostics: { version: 2, retention: { days: 30 }, chargers: [{ id: 'charger1', current, recent: [previous] }, { id: 'charger2', current: null, recent: [] }] },
    physicalTests: { runs: [{ id: 'test1', vehicleId: 'bmw', chargerId: 'charger1', program: 'immediate', phase: 'observing', report: { id: 'current' } }] } } };
  const request = async (path, body) => {
    calls.push({ path, body }); const url = new URL(path, 'http://local');
    const id = decodeURIComponent(url.pathname.split('/')[4] ?? ''), report = reports.get(id);
    if (url.pathname === '/api/charging/reports') {
      const all = [...reports.values()].filter(row => row.chargerId === url.searchParams.get('chargerId') && (url.searchParams.get('savedOnly') !== 'true' || row.saved));
      return { reports: structuredClone(all), nextBefore: null, readOnly: false };
    }
    if (!report || report.chargerId !== url.searchParams.get('chargerId')) throw Object.assign(new Error('Report not found'), { status: 404 });
    if (url.pathname.endsWith('/events')) {
      const filter = url.searchParams.get('filter');
      const kinds = { findings: ['finding', 'finding-update', 'recovery'], plans: ['plan'], charging: ['physical', 'charger-status'], control: ['control'], vehicle: ['identification'], evidence: ['evidence', 'session'] };
      const events = (records.get(id) ?? []).filter(row => filter === 'all' || kinds[filter]?.includes(row.kind)).filter(row => !url.searchParams.has('before') || row.id < Number(url.searchParams.get('before'))).sort((a, b) => b.id - a.id);
      const limit = Number(url.searchParams.get('limit'));
      return { events: structuredClone(events.slice(0, limit)), nextBefore: events.length > limit ? String(events[limit - 1].id) : null, readOnly: false };
    }
    if (url.pathname.endsWith('/save')) { report.saved = body.saved; return structuredClone(report); }
    if (url.pathname.endsWith('/delete')) { reports.delete(id); return { deleted: true }; }
    return structuredClone(report);
  };
  const panel = createChargingDiagnosticsPanel({ document, request }); panel.update(state);
  return { document, calls, state, current, previous, reports, records, request, panel,
    dialog: document.getElementById('charging-report-dialog'), async open(id = 'current') { panel.open('charger1', id); await flush(); } };
}

test('one event section contains full plan details exactly once and filtering replaces its rows', async () => {
  const f = setup(), changes = [{ field: 'target', before: 70, after: 80 }];
  f.records.set('current', [{ id: 1, at: now, kind: 'plan', code: 'target-update', changes,
    plan: { at: now, reason: 'target-update', changes, automatic: false, scheduleState: 'none', periods: [],
      inputs: { soc: { value: 20, source: 'manual-fallback' }, target: { value: 80, source: 'session-request' } } } },
  { id: 2, at: now + 1, kind: 'control', code: 'paused' }]);
  await f.open();
  assert.equal(f.dialog.querySelector('.charging-report-findings'), null);
  assert.equal(f.dialog.querySelector('.charging-report-plans'), null);
  const timeline = f.dialog.querySelector('.charging-report-timeline');
  assert.equal(timeline.children.length, 2);
  assert.equal(textOf(timeline).match(/Requested target: 70% → 80%/g).length, 1);
  assert.match(textOf(timeline), /configured assumption/);
  const filter = f.document.getElementById('charging-report-filter'); filter.value = 'control'; filter.dispatch('change'); await flush();
  assert.equal(timeline.children.length, 1); assert.match(textOf(timeline), /Controller pause/);
});

test('polling preserves expanded event, nested rates, focused node and scroll', async () => {
  const f = setup(); await f.open();
  const timeline = f.dialog.querySelector('.charging-report-timeline'), item = timeline.children[0], details = item.querySelector('details'), summary = details.querySelector('summary');
  details.open = true; summary.focus(); f.dialog.scrollTop = 380;
  f.current.evaluatedAt += 5000; f.panel.update(structuredClone(f.state)); await flush();
  assert.equal(timeline.children[0], item); assert.equal(f.document.activeElement, summary); assert.equal(details.open, true); assert.equal(f.dialog.scrollTop, 380);
  f.records.get('current').push({ id: 2, at: now + 10_000, kind: 'physical', code: 'charging-stopped', powerKw: 0, source: 'easee' });
  f.current.counts.events++; f.current.evaluatedAt++; f.panel.update(structuredClone(f.state)); await flush();
  assert.equal(timeline.children[1], item); assert.equal(f.document.activeElement, summary); assert.equal(details.open, true); assert.equal(f.dialog.scrollTop, 380);
});

test('expired exact selection is not substituted and charger histories stay separate', async () => {
  const f = setup(); await f.open('missing');
  assert.match(textOf(f.dialog.querySelector('.charging-report-result')), /no longer retained/);
  assert.equal(f.document.getElementById('charging-report-session').value, 'missing');
  f.panel.open('charger2'); await flush();
  assert.equal(f.document.getElementById('charging-report-session').children.length, 0);
  assert.match(textOf(f.dialog.querySelector('.charging-report-result')), /No session report for Charger 2/);
});

test('original source and receipt clocks distinguish zero draw and charger status', async () => {
  const f = setup(); f.records.set('current', [{ id: 1, kind: 'physical', code: 'not-charging-observed', at: now + 20_000, powerKw: 0,
    source: 'easee', measuredAt: now + 3000, receivedAt: now + 5000 },
  { id: 2, kind: 'charger-status', code: 'charger-reports-charging', at: now + 20_000, powerKw: 0, source: 'easee', measuredAt: now + 1000, receivedAt: now + 2000 }]);
  await f.open(); const text = textOf(f.dialog.querySelector('.charging-report-timeline'));
  assert.match(text, /No draw measured/); assert.match(text, /Charger status reports charging/);
  assert.match(text, /Measured 28 Sept, 21:00:03 · Received 28 Sept, 21:00:05/);
});

test('recurring findings show unique issues and total episodes with a scoped filter', async () => {
  const f = setup(); f.current.findings = [{ code: 'control-unconfirmed', count: 22, firstAt: now, lastAt: now + 40, resolvedAt: null, severity: 'attention' }];
  f.records.set('current', [{ id: 1, at: now, kind: 'finding', code: 'control-unconfirmed', episode: 1 },
    { id: 2, at: now + 1, kind: 'recovery', code: 'control-unconfirmed', episode: 1 },
    { id: 3, at: now + 2, kind: 'finding', code: 'control-unconfirmed', episode: 2 }]);
  await f.open();
  const link = f.dialog.querySelector('.charging-report-current-findings');
  assert.match(link.textContent, /1 unresolved finding · 1 issue, 22 recorded episodes/);
  link.dispatch('click'); await flush();
  assert.equal(f.dialog.querySelector('.charging-report-timeline').children.length, 1);
  assert.match(textOf(f.dialog.querySelector('.charging-report-timeline')), /2 episodes/);
  assert.match(textOf(f.dialog), /Separate recorded occurrences in the loaded events/);
});

test('save active report protects future events and cannot delete active report', async () => {
  const f = setup(); await f.open();
  assert.equal(f.document.getElementById('charging-report-delete').disabled, true);
  f.document.getElementById('charging-report-save').dispatch('click'); await flush();
  assert.equal(f.current.saved, true);
  assert.equal(f.document.getElementById('charging-report-save').textContent, 'Remove from saved');
  assert.match(f.dialog.querySelector('.charging-report-message').textContent, /including future events/);
  f.panel.update(structuredClone(f.state)); await flush();
  assert.match(f.dialog.querySelector('.charging-report-message').textContent, /Report saved permanently/);
});

test('removing an expired saved report warns using its own retention before mutation', async () => {
  const f = setup(); Object.assign(f.previous, { saved: true, endedAt: now - 3 * 86400_000, retention: { days: 2 } });
  await f.open('previous'); f.document.getElementById('charging-report-save').dispatch('click');
  const confirmation = f.dialog.querySelector('.charging-report-confirm');
  assert.equal(confirmation.hidden, false); assert.match(textOf(confirmation), /delete it and its events immediately/);
  assert.equal(f.calls.filter(row => row.body).length, 0);
  confirmation.children[2].dispatch('click'); assert.equal(confirmation.hidden, true);
});

test('completed report deletion requires an in-dialog confirmation and retains selection', async () => {
  const f = setup(); await f.open('previous'); f.document.getElementById('charging-report-delete').dispatch('click');
  assert.equal(f.calls.filter(row => row.body).length, 0);
  f.dialog.querySelector('.charging-report-confirm').children[1].dispatch('click'); await flush();
  assert.equal(f.reports.has('previous'), false);
  assert.match(textOf(f.dialog.querySelector('.charging-report-result')), /no longer retained/);
  assert.equal(f.document.getElementById('charging-report-session').value, 'previous');
});

test('family and read-only viewers can inspect but cannot manage reports', async () => {
  for (const restriction of [{ webAccess: { role: 'family' } }, { readOnly: true }, { role: 'slave' }]) {
    const f = setup(); Object.assign(f.state, restriction); f.panel.update(f.state); await f.open('previous');
    assert.equal(f.document.getElementById('charging-report-save').disabled, true); assert.equal(f.document.getElementById('charging-report-delete').disabled, true);
    assert.match(textOf(f.dialog), /View only/);
  }
});

test('saved collection loads its own list without showing unrelated recent reports', async () => {
  const f = setup(); f.previous.saved = true; await f.open();
  const collection = f.document.getElementById('charging-report-collection'); collection.value = 'saved'; collection.dispatch('change'); await flush();
  assert.deepEqual(f.document.getElementById('charging-report-session').children.map(row => row.value), ['previous']);
  assert.equal(f.document.getElementById('charging-report-session').value, 'previous');
});

test('event pagination preserves all records and polling bridges bursts larger than one page', async () => {
  const f = setup(); f.records.set('current', Array.from({ length: 120 }, (_, i) => ({ id: i + 1, at: now + i, kind: 'evidence', code: 'observation-gap' })));
  f.current.counts.events = 120; await f.open();
  const timeline = f.dialog.querySelector('.charging-report-timeline'); assert.equal(timeline.children.length, 50);
  f.document.getElementById('charging-report-more-events').dispatch('click'); await flush(); assert.equal(timeline.children.length, 100);
  f.records.get('current').push(...Array.from({ length: 130 }, (_, i) => ({ id: i + 121, at: now + i + 120, kind: 'evidence', code: 'observation-gap' })));
  f.current.counts.events = 250; f.current.evaluatedAt++; f.panel.update(structuredClone(f.state)); await flush();
  assert.equal(timeline.children.length, 230);
  f.document.getElementById('charging-report-more-events').dispatch('click'); await flush(); assert.equal(timeline.children.length, 250);
  assert.equal(f.document.getElementById('charging-report-more-events').hidden, true);
});

test('late event responses cannot overwrite a different filter or a closed dialog', async () => {
  const f = setup(); let resolveLate;
  const request = (path, body) => path.includes('/events?') && path.includes('filter=all') ? new Promise(resolve => { resolveLate = resolve; }) : f.request(path, body);
  const panel = createChargingDiagnosticsPanel({ document: f.document, request }); panel.update(f.state); panel.open('charger1'); await flush();
  const dialog = f.document.body.children.at(-1), filter = dialog.querySelector('.charging-report-events').querySelector('select');
  filter.value = 'plans'; filter.dispatch('change'); await flush();
  resolveLate({ events: [{ id: 99, at: now, kind: 'control', code: 'unconfirmed' }], nextBefore: null }); await flush();
  assert.equal(dialog.querySelector('.charging-report-timeline').children.length, 0);
  panel.close(); assert.equal(dialog.open, false);
});

test('a metadata read begun before saving cannot undo the saved receipt or summary', async () => {
  const f = setup(); let hold = false, resolveLate;
  const request = (path, body) => hold && /\/current\?/.test(path) ? new Promise(resolve => { resolveLate = resolve; }) : f.request(path, body);
  const panel = createChargingDiagnosticsPanel({ document: f.document, request }); panel.update(f.state); panel.open('charger1'); await flush();
  const dialog = f.document.body.children.at(-1); hold = true; f.current.evaluatedAt++; panel.update(structuredClone(f.state)); await flush();
  const stale = structuredClone(f.current);
  dialog.querySelector('.charging-report-actions').children[0].dispatch('click'); await flush();
  resolveLate(stale); await flush();
  assert.equal(dialog.querySelector('.charging-report-actions').children[0].textContent, 'Remove from saved');
  assert.match(dialog.querySelector('.charging-report-message').textContent, /Report saved permanently/);
});

test('guided link opens the exact assessment attached to the report and restores focus', async () => {
  const f = setup(), calls = []; const panel = createChargingDiagnosticsPanel({ document: f.document, request: f.request, onOpenTest: (...args) => calls.push(args) });
  panel.update(f.state); panel.open('charger1'); await flush();
  const dialog = f.document.body.children.at(-1); dialog.querySelector('.charging-report-guided').children[1].dispatch('click');
  assert.deepEqual(calls, [['bmw', 'test1']]); assert.equal(dialog.open, false);
});

test('facts retain partial monitoring, stale power and assumed battery meanings', () => {
  const facts = Object.fromEntries(chargingReportFacts({ startedAt: now, observedFrom: now + 60_000,
    current: { automaticEnabled: false, scheduleState: 'none', vehicleSoc: false, soc: { value: 20, source: 'manual-fallback' }, physicalFresh: false,
      power: { value: 11, measuredAt: now }, reportedCharging: true } }));
  assert.match(facts['Observation coverage'], /Earlier charging is not covered/);
  assert.match(facts['Measured draw / status'], /Last reading 11 kW.*current draw unavailable/);
  assert.match(facts.Vehicle, /Actual vehicle battery charge is unconfirmed/);
});

test('plan changes retain exact prices, explicit unchanged periods and execution distinction', () => {
  const changes = [{ field: 'prices', before: [{ startAt: now, endAt: now + 3600_000, priceCtPerKwh: 3.5 }], after: [{ startAt: now, endAt: now + 3600_000, priceCtPerKwh: 4.2 }] }];
  const view = chargingPlanPresentation({ scheduleState: 'installed', changes }); assert.equal(view.periodsUnchanged, true);
  assert.match(view.periodLabel, /physical execution is checked separately/);
  assert.match(chargingPlanChanges(changes)[0].before, /3.5 c\/kWh/); assert.match(chargingPlanChanges(changes)[0].after, /4.2 c\/kWh/);
});

test('large suspended-tab catchup is bounded and explicitly reloadable without losing focused history', async () => {
  const f = setup(); await f.open();
  const timeline = f.dialog.querySelector('.charging-report-timeline'), original = timeline.children[0], summary = original.querySelector('summary'); summary.focus();
  f.records.get('current').push(...Array.from({ length: 400 }, (_, i) => ({ id: i + 2, at: now + i + 1, kind: 'evidence', code: 'observation-gap' })));
  const prior = f.calls.filter(row => row.path.includes('/events?')).length;
  f.current.counts.events = 401; f.current.evaluatedAt++; f.panel.update(structuredClone(f.state)); await flush();
  assert.equal(f.calls.filter(row => row.path.includes('/events?')).length - prior, 5);
  assert.equal(timeline.children.length, 1); assert.equal(timeline.children[0], original); assert.equal(f.document.activeElement, summary);
  const refresh = f.document.getElementById('charging-report-refresh-events'); assert.equal(refresh.hidden, false);
  refresh.dispatch('click'); await flush();
  assert.equal(timeline.children.length, 50); assert.equal(refresh.hidden, true); assert.equal(f.document.getElementById('charging-report-more-events').hidden, false);
});

test('unsaving in Saved removes the list entry while preserving the selected report explicitly', async () => {
  const f = setup(); f.previous.saved = true; await f.open();
  const collection = f.document.getElementById('charging-report-collection'); collection.value = 'saved'; collection.dispatch('change'); await flush();
  f.document.getElementById('charging-report-save').dispatch('click'); await flush();
  const selector = f.document.getElementById('charging-report-session');
  assert.equal(selector.value, 'previous'); assert.equal(selector.children.length, 1);
  assert.equal(selector.children[0].textContent, 'Selected report · no longer saved');
  assert.match(f.dialog.querySelector('.charging-report-message').textContent, /removed from saved/);
});

test('material finding evidence changes stay visible without a new detected episode', async () => {
  const f = setup(); f.records.set('current', [
    { id: 1, at: now, kind: 'finding', code: 'control-unconfirmed', episode: 1, context: { errorCode: 'pause-unconfirmed' } },
    { id: 2, at: now + 1, kind: 'finding-update', code: 'control-unconfirmed', episode: 1, context: { errorCode: 'invalid-plan' } }]);
  await f.open(); const filter = f.document.getElementById('charging-report-filter'); filter.value = 'findings'; filter.dispatch('change'); await flush();
  const timeline = f.dialog.querySelector('.charging-report-timeline');
  assert.equal(timeline.children.length, 2); assert.match(textOf(timeline.children[0]), /Evidence changed/);
  assert.match(textOf(timeline.children[0]), /Charging plan could not be applied/);
  assert.match(textOf(timeline.children[0]), /same episode remains active/);
  assert.doesNotMatch(textOf(timeline), /0 episodes/);
});

test('saved history identifies previous charger equipment separately from its current card label', async () => {
  const f = setup(); f.previous.previousEquipment = true; await f.open('previous');
  assert.match(f.dialog.querySelector('.charging-report-context').textContent, /Previous charger equipment/);
});
