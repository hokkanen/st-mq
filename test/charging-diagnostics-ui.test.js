import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingDiagnosticsPanel, chargingReportFacts, chargingPlanChanges, chargingPlanPresentation } from '../chart/charging-diagnostics.js';

test('flexibility report evidence distinguishes approval, cancellation, and consumed permission', () => {
  const baseline = Date.parse('2026-10-09T03:00:00Z'), later = Date.parse('2026-10-10T03:00:00Z');
  const approval = { action: 'allow', normalReadyByAt: baseline, checkpointAt: baseline, effectiveReadyByAt: later };
  const approved = chargingPlanChanges([{ field: 'flexibility', before: null, after: approval }])[0];
  assert.equal(approved.label, 'One-day flexibility'); assert.match(approved.after, /One extra day approved.*10 Oct.*marker until.*9 Oct/);
  const consumed = chargingPlanChanges([{ field: 'flexibility', before: approval, after: { action: 'consume', effectiveReadyByAt: later } }])[0];
  assert.match(consumed.after, /Approved deadline is now normal/); assert.doesNotMatch(consumed.after, /marker|approved.*extra day/i);
  const canceled = chargingPlanChanges([{ field: 'flexibility', before: approval, after: { action: 'cancel', effectiveReadyByAt: baseline } }])[0];
  assert.match(canceled.after, /Allowance canceled.*9 Oct/);
});

test('shared identification observation wording does not identify the vehicle as BMW', () => {
  for (const vehicleId of ['tesla', 'bmw']) {
    const facts = Object.fromEntries(chargingReportFacts({ current: { vehicleId,
      identification: 'charging', identificationReason: 'observing-charge' } }));
    assert.match(facts.Identification, /Observing charging for matching vehicle evidence/);
    assert.doesNotMatch(facts.Identification, /BMW/);
  }
});

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
    const footer = document.createElement('div'); footer.className = 'charging-footer';
    summary.append(footer); document.body.append(summary);
  }
  return document;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const now = Date.parse('2026-09-28T18:00:00Z');

const flush = () => new Promise(resolve => setImmediate(resolve));
const textOf = node => [node.textContent, ...descendants(node).map(child => child.textContent)].join('\n');
function setup(options = {}) {
  const document = fixture(), calls = [];
  const current = { id: 'current', startedAt: now, observedFrom: now, endedAt: null, evaluatedAt: now, chargerId: 'charger1', saved: false,
    behavior: 'expected', outcome: { state: 'in-progress' }, coverage: { initialRelease: { state: 'verified' } }, findings: [], counts: { events: 1, findings: 0, plans: 0 } };
  const previous = { ...structuredClone(current), id: 'previous', startedAt: now - 86400_000, endedAt: now - 1 };
  const reports = new Map([[current.id, current], [previous.id, previous]]);
  const records = new Map([[current.id, [{ id: 1, at: now, kind: 'physical', code: 'charging-observed', powerKw: 7, source: 'easee', measuredAt: now, receivedAt: now }]], [previous.id, []]]);
  const state = { now, webAccess: { role: 'admin' }, charging: { timezone: 'Europe/Helsinki', chargers: [{ id: 'charger1', label: 'Charger 1' }, { id: 'charger2', label: 'Charger 2' }],
    diagnostics: { version: 3, retention: { days: 30 }, chargers: [{ id: 'charger1', current, recent: [previous] }, { id: 'charger2', current: null, recent: [] }] },
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
  const panel = createChargingDiagnosticsPanel({ document, request, ...options }); panel.update(state);
  return { document, calls, state, current, previous, reports, records, request, panel,
    dialog: document.getElementById('charging-report-dialog'), async open(id = 'current') { panel.open('charger1', id); await flush(); } };
}

test('native SYS incident details use ordinary report entries and include recovery and firmware evidence', async () => {
  const f = setup();
  f.records.set('current', [{ id: 2, at: now, kind: 'evidence', code: 'shelly-recovery-attempt',
    policy: 'startup-retry', origin: 'scheduled', attempt: 2, currentA: 14,
    startAt: now - 1000, acceptedAt: now - 975, sourceAt: now - 500, receivedAt: now - 450,
    firmware: 'synthetic-fw', model: 'synthetic-model' }]);
  await f.open();
  const text = textOf(f.dialog);
  assert.match(text, /SYS startup retry attempted/);
  assert.match(text, /Retry 2 of 3/);
  assert.match(text, /Scheduled charging/);
  assert.match(text, /Current setting 14 A/);
  assert.match(text, /Firmware synthetic-fw/);
  assert.match(text, /Model synthetic-model/);
  assert.match(text, /Start sent/); assert.match(text, /Acknowledged/);
  assert.match(text, /Native event/); assert.match(text, /Received/);
});

test('report buttons retain their label, report state and dialog behavior across refreshes', async () => {
  const f = setup(), button = f.document.getElementById('charger1-session-report');
  const label = button.querySelector('.charging-session-report-label'), statusText = button.querySelector('.charging-session-report-status');
  assert.equal(label.textContent, 'Session report'); assert.equal(statusText.textContent, 'Checks passed');
  assert.equal(button.dataset.state, 'good');
  assert.equal(button.querySelector('.charging-session-report-open').textContent, 'Open');
  assert.match(button.className, /\bcharging-card-link\b/);
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(button.getAttribute('aria-controls'), 'charging-report-dialog');
  assert.equal(button.getAttribute('aria-label'), 'Open Charger 1 session report · Checks passed');
  const empty = f.document.getElementById('charger2-session-report');
  assert.equal(empty.querySelector('.charging-session-report-label').textContent, 'Session report');
  assert.equal(empty.querySelector('.charging-session-report-status').hidden, true);
  assert.equal(empty.getAttribute('aria-label'), 'Open Charger 2 session report');

  button.focus(); f.current.attentionCount = 1; f.panel.update(structuredClone(f.state));
  assert.equal(f.document.getElementById('charger1-session-report'), button); assert.equal(f.document.activeElement, button);
  assert.equal(button.querySelector('.charging-session-report-label'), label);
  assert.equal(label.textContent, 'Session report'); assert.equal(statusText.textContent, '1 issue'); assert.equal(button.dataset.state, 'attention');
  let prevented = false, stopped = false;
  button.dispatch('click', { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); await flush();
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.equal(f.dialog.open, true); assert.equal(button.getAttribute('aria-expanded'), 'true');
  f.panel.close(); assert.equal(f.dialog.open, false); assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, button);

  f.state.charging.diagnostics.available = false; f.panel.update(f.state);
  assert.equal(statusText.textContent, 'Report unavailable'); assert.equal(button.dataset.state, 'unknown');
  assert.equal(label.textContent, 'Session report');
});

test('closing a linked report restores its actual timeline opener', async () => {
  const f = setup(), opener = f.document.createElement('button'); f.document.body.append(opener); opener.focus();
  await f.open('previous');
  assert.equal(f.document.activeElement, f.dialog.querySelector('.charging-report-heading').children[1]);
  f.panel.close(); assert.equal(f.document.activeElement, opener);
});

test('a report button remains its own opener when another charger was previously focused', async () => {
  const f = setup(), opener = f.document.getElementById('charger1-session-report');
  f.document.getElementById('charger2-session-report').focus();
  opener.dispatch('click', { preventDefault() {}, stopPropagation() {} }); await flush();
  f.panel.close(); assert.equal(f.document.activeElement, opener);
});

test('session choices distinguish saved years and repeated daylight-saving hours', async () => {
  const f = setup();
  f.current.startedAt = Date.parse('2026-10-25T00:30:00Z');
  f.previous.startedAt = Date.parse('2026-10-25T01:30:00Z');
  const older = { ...structuredClone(f.previous), id: 'older-year', startedAt: Date.parse('2025-10-25T00:30:00Z') };
  f.reports.set(older.id, older); await f.open();
  const labels = f.document.getElementById('charging-report-session').children.map(row => row.textContent);
  assert.match(labels[0], /2026.*03:30.*GMT\+3/);
  assert.match(labels[1], /2026.*03:30.*GMT\+2/);
  assert.match(labels[2], /2025/);
});

test('a failed empty collection read remains unavailable with an enabled retry selector', async () => {
  let f;
  f = setup({ request: async (path, body) => {
    if (path.startsWith('/api/charging/reports?') && path.includes('savedOnly=true')) throw new Error('Synthetic list failure');
    return f.request(path, body);
  } });
  await f.open();
  const collection = f.document.getElementById('charging-report-collection');
  collection.value = 'saved'; collection.dispatch('change'); await flush();
  assert.match(textOf(f.dialog.querySelector('.charging-report-result')), /Session list unavailable.*selector to retry/s);
  assert.doesNotMatch(textOf(f.dialog.querySelector('.charging-report-result')), /No saved reports/);
  const selector = f.document.getElementById('charging-report-session');
  assert.equal(selector.disabled, false); assert.equal(selector.parent.hidden, false);
});

test('saving while the initial list is pending restarts that read and ignores its late reply', async () => {
  let f, resolveList, listReads = 0;
  f = setup({ request: async (path, body) => {
    if (path.startsWith('/api/charging/reports?') && ++listReads === 1)
      return new Promise(resolve => { resolveList = resolve; });
    return f.request(path, body);
  } });
  await f.open();
  f.document.getElementById('charging-report-save').dispatch('click'); await flush(); await flush();
  assert.equal(listReads, 2, 'The cancelled initial list must be fetched again after saving');
  const selected = f.document.getElementById('charging-report-session').children.find(row => row.value === 'current');
  assert.match(selected.textContent, /Saved/);
  resolveList({ reports: [structuredClone(f.previous)], nextBefore: null, nextAfter: null }); await flush();
  assert.match(selected.textContent, /Saved/);
  assert.equal(f.document.getElementById('charging-report-session').value, 'current');
  assert.equal(f.calls.filter(call => /^\/api\/charging\/reports\/current\?/.test(call.path)).length, 1);
  assert.equal(f.calls.filter(call => call.path.includes('/current/events?')).length, 1);
});

test('a new current session poll preserves the report and list until explicit browsing refresh', async () => {
  const f = setup(); await f.open();
  const selector = f.document.getElementById('charging-report-session'), choices = [...selector.children];
  const next = { ...structuredClone(f.current), id: 'new-current', startedAt: now + 1000 };
  f.reports.set(next.id, next); f.state.charging.diagnostics.chargers[0].current = next;
  const listReads = f.calls.filter(call => call.path.startsWith('/api/charging/reports?')).length;
  f.dialog.scrollTop = 150; f.panel.update(f.state); await flush();
  assert.equal(selector.value, 'current'); assert.deepEqual(selector.children, choices);
  assert.equal(f.dialog.scrollTop, 150);
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/charging/reports?')).length, listReads);
});

test('a queued close event cannot clear a report that has already reopened', async () => {
  const f = setup(); await f.open();
  f.dialog.close = () => { f.dialog.open = false; };
  f.panel.close(); await f.open();
  assert(f.dialog.querySelector('.charging-report-timeline').children.length > 0);
  f.dialog.dispatch('close');
  assert(f.dialog.querySelector('.charging-report-timeline').children.length > 0,
    'An old native close event must not release the reopened report');
  assert.equal(f.document.activeElement, f.dialog.querySelector('.charging-report-heading').children[1]);
});

test('receipt clocks appear once in expanded report evidence', async () => {
  const f = setup(); await f.open();
  const text = textOf(f.dialog.querySelector('.charging-report-raw').children[0]);
  assert.equal((text.match(/Received /g) ?? []).length, 1);
});

test('empty Saved collection and pending collection reads describe the selected collection', async () => {
  const f = setup(); await f.open();
  const collection = f.document.getElementById('charging-report-collection');
  collection.value = 'saved'; collection.dispatch('change');
  assert.match(f.dialog.querySelector('.charging-report-result').children[0].textContent, /Loading saved reports/);
  await flush();
  assert.match(f.dialog.querySelector('.charging-report-result').children[0].textContent, /No saved reports for Charger 1/);
  assert.match(f.dialog.querySelector('.charging-report-result').children[1].textContent, /Recent sessions are listed separately/);
  assert.equal(f.reports.size, 2, 'Filtering cannot discard existing session reports');
});

test('delete cancellation returns focus to Delete and permission loss dismisses a pending confirmation', async () => {
  const f = setup(); await f.open('previous');
  const remove = f.document.getElementById('charging-report-delete'), confirmation = f.dialog.querySelector('.charging-report-confirm');
  remove.dispatch('click'); assert.equal(f.document.activeElement, confirmation.children[2]);
  confirmation.children[2].dispatch('click');
  assert.equal(f.document.activeElement, remove);
  remove.dispatch('click'); f.state.webAccess.role = 'family'; f.panel.update(structuredClone(f.state));
  assert.equal(confirmation.hidden, true); assert.equal(confirmation.children[1].disabled, true);
  assert.equal(f.document.activeElement, f.dialog.querySelector('.charging-report-heading').children[1]);
  confirmation.children[1].dispatch('click'); await flush();
  assert.equal(f.calls.filter(row => row.body).length, 0);
});

test('a successful report save remains successful when the following dashboard read fails', async () => {
  const f = setup({ afterMutation: async () => { throw Error('Synthetic status failure'); } }); await f.open();
  f.document.getElementById('charging-report-save').dispatch('click'); await flush();
  assert.equal(f.current.saved, true);
  const message = f.dialog.querySelector('.charging-report-message');
  assert.match(message.textContent, /Report saved permanently/); assert.match(message.textContent, /dashboard status could not be refreshed/);
  assert.equal(message.dataset.state, 'saved');
});

test('event read failures retain evidence and offer retry without claiming an empty result', async () => {
  const f = setup(); let fail = true;
  const panel = createChargingDiagnosticsPanel({ document: f.document, request: (path, body) =>
    path.includes('/events?') && fail ? Promise.reject(Error('Synthetic event read failure')) : f.request(path, body) });
  panel.update(f.state); panel.open('charger1'); await flush();
  const dialog = f.document.body.children.at(-1), scope = dialog.querySelector('.charging-report-event-scope');
  assert.match(scope.textContent, /Events could not be loaded/); assert.doesNotMatch(scope.textContent, /No events/);
  const refresh = dialog.querySelector('.charging-report-events').children.find(node => node.id === 'charging-report-refresh-events');
  assert.equal(refresh.hidden, false); assert.equal(refresh.textContent, 'Refresh events');
  fail = false; refresh.dispatch('click'); await flush();
  assert.equal(dialog.querySelector('.charging-report-timeline').children.length, 1);
  fail = true; f.current.evaluatedAt++; panel.update(structuredClone(f.state)); await flush();
  const retained = dialog.querySelector('.charging-report-timeline').children[0];
  assert.equal(refresh.hidden, false); assert.match(scope.textContent, /previously loaded/);
  fail = false; refresh.dispatch('click'); await flush();
  assert.equal(dialog.querySelector('.charging-report-timeline').children[0], retained);
});

test('repeated report formatting reuses bounded timezone formatters', t => {
  const Native = Intl.DateTimeFormat; let created = 0;
  t.mock.method(Intl, 'DateTimeFormat', function(...args) { created++; return new Native(...args); });
  for (let i = 0; i < 500; i++) {
    const facts = chargingReportFacts({ startedAt: now, observedFrom: now, current: { deadlineAt: now, power: { measuredAt: now }, physicalFresh: true, powerKw: 0 } }, 'Atlantic/Reykjavik');
    assert.match(Object.fromEntries(facts)['Ready by'], /28 Sept, 18:00/);
  }
  assert(created <= 2, `Repeated identical timezone/options constructed ${created} formatters`);
});

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

test('plan detail shows the actual planning reason and estimated maximum-current basis', async () => {
  const f = setup();
  f.records.set('current', [{ id: 1, at: now, kind: 'plan', code: 'schedule-state',
    plan: { at: now, reason: 'schedule-state', plannerReason: 'cheapest-feasible-start', feasible: true, provisional: false,
      changes: [], automatic: true, scheduleState: 'proposed', periods: [{ startAt: now + 3600_000, endAt: null }],
      assumptions: [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum' }],
      warnings: ['Prices do not yet cover the full ready-by period. The schedule will be reconsidered when more prices arrive.'] } }]);
  await f.open();
  const text = textOf(f.dialog.querySelector('.charging-report-timeline'));
  assert.match(text, /Planning reason: Cheapest feasible charging start/);
  assert.match(text, /up to 16 A per phase within known limits and forecast shared property capacity/);
  assert.match(text, /Uses the configured maximum when current is unknown/);
  assert.match(text, /Completion is estimated/);
  assert.match(text, /Prices do not yet cover the full ready-by period/);
  assert(!text.includes('Provisional release;'));
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
  assert.match(text, /Measured 28 Sept 2026, 21:00:03 GMT\+3 \(2026-09-28T18:00:03.000Z\)/);
  assert.match(text, /Received 28 Sept 2026, 21:00:05 GMT\+3 \(2026-09-28T18:00:05.000Z\)/);
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

test('report facts distinguish a dashboard Pause from a retained native instruction', () => {
  const report = { planning: { plannerReason: 'session-pause' }, current: {
    automaticEnabled: true, reasonCode: 'session-pause', scheduleState: 'unknown', manual: true, pending: true,
  } };
  let facts = Object.fromEntries(chargingReportFacts(report));
  assert.match(facts['Control at last assessment'], /Automatic charging on · Paused here until unplugging/);
  assert.match(facts['Control at last assessment'], /Charger instruction unconfirmed/);
  assert.doesNotMatch(facts['Control at last assessment'], /Schedule state unknown|Manual charger instruction/);
  assert.equal(facts['Planning reason'], 'Paused here until unplugging');
  report.current.reasonCode = 'manual-stop';
  facts = Object.fromEntries(chargingReportFacts(report));
  assert.match(facts['Control at last assessment'], /Manual charger instruction has priority/);
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


test('closing releases paged report nodes, and late reads cannot remount them', async () => {
  const f = setup();
  f.records.set('current', Array.from({ length: 130 }, (_, i) => ({ id: i + 1, at: now + i, kind: 'physical', code: 'charging-observed', powerKw: i + 1, source: 'easee' })));
  await f.open();
  for (let i = 0; i < 2; i++) { f.document.getElementById('charging-report-more-events').dispatch('click'); await flush(); }
  const timeline = f.dialog.querySelector('.charging-report-timeline');
  assert.equal(timeline.children.length, 130);
  f.panel.close(); assert.equal(timeline.children.length, 0);
  f.panel.update(structuredClone(f.state)); await flush(); assert.equal(timeline.children.length, 0);
  await f.open(); assert.equal(timeline.children.length, 50);
  let resolveLate;
  const late = setup({ request: () => new Promise(resolve => { resolveLate = resolve; }) });
  late.panel.open('charger1'); late.panel.close();
  resolveLate({ reports: [late.current], nextBefore: null }); await flush();
  assert.equal(late.dialog.querySelector('.charging-report-timeline').children.length, 0);
});

test('unrecognized enum and plan field names stay neutral instead of inheriting object methods', async () => {
  for (const value of ['constructor', '__proto__', 'toString']) {
    assert.deepEqual(chargingPlanChanges([{ field: value, before: 1, after: 2 }]), []);
    const facts = chargingReportFacts({ outcome: { state: value }, behavior: value, current: { vehicleId: value, identification: value, identificationReason: value, scheduleState: value, soc: { value: 30, source: value } } });
    assert.doesNotMatch(JSON.stringify(facts), /native code|function|\[object/);
    const f = setup();
    f.records.set('current', [{ id: 1, at: now, kind: 'control', code: value, origin: value, policy: value, source: value }]);
    await f.open(); const text = textOf(f.dialog);
    assert.match(text, /Control state recorded/); assert.match(text, /Policy not recognized/); assert.match(text, /Instruction origin not recognized/);
    assert.doesNotMatch(text, /native code|function Object|function toString/);
  }
});

test('session report and main log use the same finding and qualified physical labels', async () => {
  const { presentCharging } = await import('../src/app/event-log-presentation.js');
  const f = setup();
  const cases = [{ kind: 'finding', code: 'deadline-unverified' }, { kind: 'finding-update', code: 'target-conflict' },
    { kind: 'recovery', code: 'deadline-missed', resolution: 'request-changed' },
    { kind: 'recovery', code: 'telemetry-unavailable', resolution: 'evidence-reconciled' },
    ...['charging-started', 'charging-stopped'].flatMap(code => [0, .05, 7, -1, null].map(powerKw => ({ kind: 'physical', code, powerKw })))];
  f.records.set('current', cases.map((row, i) => ({ ...row, id: i + 1, at: now + i * 60000, source: 'easee' })));
  await f.open();
  const text = textOf(f.dialog.querySelector('.charging-report-timeline'));
  for (const row of cases) {
    const view = presentCharging({ namespace: 'charging:mqtt:session-diagnostics', charger_id: 'charger1' }, row);
    assert(text.includes(view.title.replace('Charger 1 · ', '')), view.title);
    if (row.powerKw === -1 || row.powerKw === null) assert.equal(view.evidence, 'Physical evidence unavailable');
  }
  assert.match(text, /request changed/); assert.doesNotMatch(text, /deadline.*recovered/i);
});

test('invalid shared evidence clocks remain unknown without crashing the report', () => {
  return import('../chart/charging-shared.js').then(({ chargingSharedText, chargingSharedSummary }) => {
    const shared = { selectedPriority: 'constructor', execution: { reportedCurrentA: 6, measuredAt: Number.MAX_SAFE_INTEGER }, proposed: { state: 'toString' } };
    assert.match(chargingSharedText(shared), /unknown time/);
    assert.doesNotMatch(chargingSharedText(shared), /native code|function/);
    assert.match(chargingSharedSummary(null), /overlap unconfirmed/);
  });
});
