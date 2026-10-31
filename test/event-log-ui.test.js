import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLog, eventLogTime } from '../chart/event-log.js';

const NOW = Date.parse('2026-10-25T10:10:01Z');
const id = (n, source = 'event') => `${source}:${String(n).padStart(16, '0')}`;
const row = (n, extra = {}) => ({ id: id(n), at: NOW + n * 1000, area: 'home', severity: 'info',
  title: `Heating choice ${n}`, summary: 'Automatic heating paused.', evidence: 'Saved dashboard instruction',
  details: [{ label: 'Scope', value: 'Until Automatic resumes.' }], ...extra });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const listeners = new Map();
  const document = { activeElement: null, hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name), dispatch: name => listeners.get(name)?.() };
  const windowListeners = new Map();
  document.defaultView = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: name => windowListeners.delete(name),
    dispatch: name => windowListeners.get(name)?.(),
  };
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: new Map(),
      className: '', textContent: '', open: false, hidden: false, disabled: false, value: '', scrollTop: 0, clientHeight: 340 }); }
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
    insertBefore(child, reference) { if (child === reference) return; child.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; child.parent = this; this.children.splice(index, 0, child); }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    dispatch(name, event = {}) { return this.listeners.get(name)?.(event); }
    focus() { document.activeElement = this; }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    get scrollHeight() { return this.children.length * 100; }
    getBoundingClientRect() {
      const top = this.parent?.id === 'events' ? 100 + this.parent.children.indexOf(this) * 100 - this.parent.scrollTop : 100;
      return { top, bottom: top + (this.id === 'events' ? 340 : 100), height: this.id === 'events' ? 340 : 100 };
    }
    querySelector(selector) { return descendants(this).find(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector.toUpperCase()) ?? null; }
  }
  document.createElement = tag => new Node(tag);
  document.body = document.createElement('body');
  const elements = new Map();
  for (const name of ['events', 'event-log-status', 'event-log-message', 'event-log-view', 'event-log-area',
    'event-log-refresh', 'event-log-older', 'event-log-new', 'event-log-coverage', 'event-log-range', 'event-log-panel']) {
    const node = document.createElement(name === 'events' ? 'ol' : name.includes('view') || name.includes('area') ? 'select' : 'div');
    node.id = name; elements.set(name, node); document.body.append(node);
  }
  const $ = name => elements.get(name);
  $('event-log-view').value = 'important'; $('event-log-area').value = 'all';
  document.getElementById = $;
  const requests = [], reports = [];
  const panel = createEventLog({ document, request: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    onOpenReport: (...args) => reports.push(args), ...options });
  const answer = async (events, extra = {}, index = requests.length - 1) => {
    const request = requests[index], query = new URL(request.path, 'http://fixture').searchParams;
    request.resolve({ context: 'current-history', checkedAt: NOW, scope: 'live', snapshotAt: null, events,
      retainedIds: (query.get('visible') ?? '').split(',').filter(Boolean), nextBefore: null,
      coverage: 'Recorded history is incomplete where evidence was unavailable.', ...extra });
    await settle();
  };
  const refresh = async (events, extra) => { const done = panel.refresh(); await settle(); await answer(events, extra); await done; };
  return { panel, document, $, requests, reports, answer, refresh, list: $('events') };
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const textOf = node => [node.textContent, ...descendants(node).map(child => child.textContent)].join('\n');

test('offscreen and hidden event logs do no automatic reads, abort unused work and resume without losing evidence', async () => {
  let visibility, disconnected = false;
  class Observer {
    constructor(callback) { visibility = visible => callback([{ target: f.$('event-log-panel'), isIntersecting: visible }]); }
    observe() {} disconnect() { disconnected = true; }
  }
  const f = fixture({ IntersectionObserverClass: Observer });
  await f.panel.refresh(); assert.equal(f.requests.length, 0);
  visibility(true); await settle(); assert.equal(f.requests.length, 1);
  await f.answer([row(3)]);
  const checked = f.$('event-log-status').textContent, node = f.list.children[0]; node.querySelector('details').open = true;
  const pending = f.panel.refresh(); await settle(); visibility(false); await pending;
  assert.equal(f.requests[1].options.signal.aborted, true);
  await f.panel.refresh(); assert.equal(f.requests.length, 2);
  f.document.hidden = true; visibility(true); await f.panel.refresh(); assert.equal(f.requests.length, 2);
  assert.equal(f.$('event-log-status').textContent, checked); assert.equal(f.list.children[0], node);
  f.document.hidden = false; f.document.dispatch('visibilitychange'); await settle();
  assert.equal(f.requests.length, 3); await f.answer([row(3)]);
  assert.equal(node.querySelector('details').open, true);
  f.panel.clear(); visibility(false); visibility(true); await settle(); assert.equal(f.requests.length, 3);
  const reopened = f.panel.refresh(); await settle(); await f.answer([row(4)]); await reopened;
  f.panel.close(); assert.equal(disconnected, true);
});

test('event history distinguishes loading, empty filters and snapshot time from its own successful check', async () => {
  const f = fixture(), pending = f.panel.refresh(); await settle();
  assert.match(f.$('event-log-message').textContent, /Loading/);
  assert.equal(f.list.getAttribute('aria-busy'), 'true');
  assert.equal(new URL(f.requests[0].path, 'http://fixture').searchParams.get('view'), 'important');
  await f.answer([], { scope: 'snapshot', snapshotAt: NOW - 3600000 }); await pending;
  assert.match(f.$('event-log-status').textContent, /Snapshot.*11:10.*Checked.*12:10/);
  assert.match(f.$('event-log-message').textContent, /No important events.*All events/);
  assert.match(f.$('event-log-coverage').textContent, /incomplete/);
  assert.equal(f.list.getAttribute('aria-busy'), 'false');
  f.$('event-log-view').value = 'all'; f.$('event-log-view').dispatch('change'); await settle();
  assert.equal(f.list.children.length, 0);
  await f.answer([]);
  assert.equal(f.$('event-log-message').textContent, 'No recorded events in this view.');
  f.panel.close();
});

test('normal refresh retains row identity, expanded evidence, focused report and reading position', async () => {
  const f = fixture(), report = { kind: 'charging-report', chargerId: 'charger2', reportId: 'synthetic-report' };
  await f.refresh([row(3), row(2, { area: 'charging', related: report }), row(1)]);
  const node = f.list.children[1], disclosure = node.querySelector('details'), button = node.querySelector('button');
  disclosure.open = true; button.focus(); f.list.scrollTop = 100;
  await f.refresh([row(3), row(2, { area: 'charging', related: report, details: [{ label: 'Evidence', value: 'Native readback confirmed.' }] }), row(1)]);
  assert.equal(f.list.children[1], node); assert.equal(disclosure.open, true);
  assert.equal(f.document.activeElement, button); assert.equal(f.list.scrollTop, 100);
  assert.match(textOf(node), /Native readback confirmed/);
  button.dispatch('click'); assert.deepEqual(f.reports, [['charger2', 'synthetic-report']]);
  f.panel.close();
});

test('new head waits behind a notice while held old rows reconcile deletion independently of page limits', async () => {
  const f = fixture(); await f.refresh([row(3), row(2), row(1)]);
  const anchor = f.list.children[1]; f.list.scrollTop = 100;
  await f.refresh([row(5), row(4), row(3)], { retainedIds: [id(3), id(2)] });
  assert.deepEqual(f.list.children.map(node => node.dataset.eventId), [id(3), id(2)], 'Only verified existing rows remain; an old row beyond the page remains readable');
  assert.equal(f.list.children[1], anchor); assert.equal(f.list.scrollTop, 100);
  assert.equal(f.$('event-log-new').hidden, false);
  assert.match(f.$('event-log-new').textContent, /New events/);
  f.$('event-log-new').dispatch('click'); await settle();
  assert.equal(f.requests.length, 3, 'Opening latest rechecks rather than displaying a possibly expired held page');
  await f.answer([row(4), row(3)], { retainedIds: [id(3), id(2)] });
  assert.deepEqual(f.list.children.map(node => node.dataset.eventId), [id(4), id(3)]);
  assert.equal(f.list.scrollTop, 0); assert.equal(f.$('event-log-new').hidden, true);
  assert.equal(f.document.activeElement, f.list);
  await f.refresh([], { retainedIds: [] });
  assert.equal(f.list.children.length, 0); assert.equal(f.$('event-log-older').hidden, true);
  assert.equal(f.$('event-log-new').hidden, true, 'Deleting the whole loaded window cannot leave a stale new-events notice');
  f.panel.close();
});

test('older history remains pageable while the DOM stays bounded and current membership is sent', async () => {
  const f = fixture();
  await f.refresh(Array.from({ length: 40 }, (_, n) => row(400 - n)), { nextBefore: 'cursor-1' });
  for (let page = 1; page <= 6; page++) {
    f.$('event-log-older').dispatch('click'); await settle();
    const query = new URL(f.requests.at(-1).path, 'http://fixture').searchParams;
    assert.equal(query.get('before'), `cursor-${page}`); assert.equal(query.get('limit'), '40');
    assert((query.get('visible') ?? '').split(',').length <= 200);
    await f.answer(Array.from({ length: 40 }, (_, n) => row(400 - page * 40 - n)), { nextBefore: `cursor-${page + 1}` });
  }
  assert.equal(f.list.children.length, 200);
  assert.equal(f.list.children.at(-1).dataset.eventId, id(121));
  assert.equal(f.$('event-log-older').hidden, false, 'The row bound is not a history retention limit');
  assert.match(f.$('event-log-range').textContent, /200 events.*browsing history/);
  assert.match(f.$('event-log-new').textContent, /Back to latest/);
  const current = f.list.children.map(node => row(Number(node.dataset.eventId.split(':')[1])));
  await f.refresh(Array.from({ length: 200 }, (_, n) => row(400 - n)), { retainedIds: current.map(event => event.id) });
  assert.match(f.$('event-log-new').textContent, /Back to latest/, 'Returning head rows are not claimed as newly recorded events while browsing old pages');
  f.panel.close();
});

test('filter changes and logout fence late successes and failures without leaving private content', async () => {
  const f = fixture(); await f.refresh([row(1)]);
  const old = f.panel.refresh(); await settle();
  f.$('event-log-area').value = 'charging'; f.$('event-log-area').dispatch('change'); await settle();
  assert.equal(f.requests[1].options.signal.aborted, true); assert.equal(f.list.children.length, 0);
  await f.answer([row(2, { area: 'charging' })], {}, 2);
  f.requests[1].resolve({ invalid: 'retired result' }); await old; await settle();
  assert.equal(f.list.children[0].dataset.eventId, id(2));
  const last = f.panel.refresh(); await settle(); f.panel.clear();
  f.requests.at(-1).reject(new Error('synthetic-sensitive-error')); await last;
  assert.equal(f.list.children.length, 0); assert.equal(f.$('event-log-message').textContent, '');
  assert.equal(f.$('event-log-status').textContent, 'No event history loaded');
  f.panel.close();
});

test('an obsolete Show latest continuation cannot steal focus after logout or a filter change', async () => {
  for (const action of ['logout', 'filter']) {
    const f = fixture(); await f.refresh([row(3), row(2), row(1)]);
    f.list.scrollTop = 100;
    await f.refresh([row(5), row(4), row(3)]);
    f.$('event-log-new').dispatch('click'); await settle();
    const stale = f.requests.at(-1);
    let focused;
    if (action === 'logout') {
      f.panel.clear(); focused = f.document.createElement('input'); f.document.body.append(focused);
    } else {
      f.$('event-log-area').value = 'charging'; f.$('event-log-area').dispatch('change'); focused = f.$('event-log-area');
    }
    focused.focus();
    stale.resolve({ ignored: 'obsolete latest response' }); await settle();
    assert.equal(f.document.activeElement, focused, `${action}: cancelled latest navigation leaves the new control focused`);
    if (action === 'filter') await f.answer([row(7, { area: 'charging' })]);
    assert.equal(f.document.activeElement, focused);
    f.panel.close();
  }
});

test('a new selected history replaces excluded entries but ordinary snapshots preserve nodes', async () => {
  const f = fixture(); await f.refresh([row(4), row(3)], { scope: 'snapshot', snapshotAt: NOW - 10000 });
  const retained = f.list.children[1]; retained.querySelector('details').open = true;
  await f.refresh([row(4), row(3)], { scope: 'snapshot', snapshotAt: NOW });
  assert.equal(f.list.children[1], retained); assert.equal(retained.querySelector('details').open, true);
  retained.querySelector('summary').focus();
  await f.refresh([row(1)], { context: 'different-selected-history' });
  assert.equal(retained.isConnected, false); assert.equal(f.list.children.length, 1);
  assert.equal(f.document.activeElement, f.list, 'A removed focused event returns keyboard focus to the current history');
  assert.match(f.$('event-log-message').textContent, /selected history changed/);
  f.panel.close();
});

test('a stale older cursor restarts the selected head locally', async () => {
  const f = fixture(); await f.refresh([row(4)], { nextBefore: 'old-cursor' });
  f.$('event-log-older').dispatch('click'); await settle();
  f.requests[1].reject(Object.assign(new Error('History changed'), { code: 'event_log_context_changed', status: 409 }));
  await settle(); assert.equal(f.requests.length, 3);
  assert.equal(new URL(f.requests[2].path, 'http://fixture').searchParams.has('before'), false);
  assert.equal(f.list.children.length, 0);
  await f.answer([row(2)], { context: 'new-history' });
  assert.equal(f.list.children[0].dataset.eventId, id(2));
  assert.match(f.$('event-log-message').textContent, /selected history changed/);
  f.panel.close();
});

test('failures retain the last successful event clock and never reject household callers or expose errors', async () => {
  const f = fixture(); await f.refresh([row(1)]);
  const status = f.$('event-log-status').textContent, pending = f.panel.refresh(); await settle();
  f.requests.at(-1).reject(new Error('synthetic-sensitive-url-password'));
  await assert.doesNotReject(pending);
  assert.equal(f.$('event-log-status').textContent, status);
  assert.match(f.$('event-log-message').textContent, /last successfully fetched/);
  assert.doesNotMatch(textOf(f.document.body), /synthetic-sensitive/);
  await f.refresh([row(2)]); assert.equal(f.$('event-log-message').hidden, true);
  const malformed = f.panel.refresh(); await settle(); f.requests.at(-1).resolve([{ id: 1, payload: 'retired raw API' }]); await malformed;
  assert.equal(f.list.children[0].dataset.eventId, id(2));
  assert.match(f.$('event-log-message').textContent, /could not be refreshed/);
  f.panel.unavailable(); assert.match(f.$('event-log-message').textContent, /verified history snapshot.*previously fetched/);
  f.panel.close();
});

test('event evidence uses literal text and complete DST-distinguishable timestamps', async () => {
  const f = fixture();
  await f.refresh([row(1, { title: '<img src=x onerror=unsafe()>', details: [{ label: 'Observed', value: '0 A · false · unknown' }] })]);
  assert.match(textOf(f.list), /<img src=x onerror=unsafe\(\)>/);
  assert.equal(f.list.querySelector('img'), null);
  assert.match(textOf(f.list), /0 A · false · unknown/);
  const first = eventLogTime(Date.parse('2026-10-25T00:30:00Z'), true);
  const second = eventLogTime(Date.parse('2026-10-25T01:30:00Z'), true);
  assert.notEqual(first, second); assert.match(first, /2026.*03:30:00.*GMT\+3/); assert.match(second, /GMT\+2/);
  assert.match(f.list.querySelector('time').dateTime, /^2026-10-25T/);
  f.panel.close();
});


test('explicit event refresh retries a failed read while the viewport observer still reports offscreen', async () => {
  let visibility;
  class Observer {
    constructor(callback) { visibility = visible => callback([{ target: f.$('event-log-panel'), isIntersecting: visible }]); }
    observe() {} disconnect() {}
  }
  const f = fixture({ IntersectionObserverClass: Observer });
  await f.panel.refresh(); visibility(true); await settle();
  f.requests[0].reject(new Error('fixture-interrupted-background-read')); await settle();
  assert.match(f.$('event-log-message').textContent, /Event history is unavailable/);
  visibility(false);
  await f.panel.refresh(); assert.equal(f.requests.length, 1, 'Automatic offscreen checks stay paused');
  f.$('event-log-refresh').dispatch('click'); await settle();
  assert.equal(f.requests.length, 2, 'An explicit Refresh must make a fresh read even before the viewport observer catches up');
  await f.answer([row(2)], { nextBefore: 'fixture-cursor' });
  assert.equal(f.$('event-log-message').hidden, true);
  assert.equal(f.list.children.length, 1);
  f.$('event-log-older').dispatch('click'); await settle();
  assert.equal(f.requests.length, 3);
  await f.answer([row(1)]);
  f.$('event-log-new').dispatch('click'); await settle();
  assert.equal(f.requests.length, 4);
  await f.answer([row(2)]);
  f.$('event-log-area').value = 'home'; f.$('event-log-area').dispatch('change'); await settle();
  assert.equal(f.requests.length, 5);
  await f.answer([row(2)]);
  f.document.hidden = true; f.document.dispatch('visibilitychange');
  f.$('event-log-refresh').dispatch('click'); await settle();
  assert.equal(f.requests.length, 5, 'A hidden document does not start reads');
  f.panel.unavailable(); f.document.hidden = false;
  f.$('event-log-refresh').dispatch('click'); await settle();
  assert.equal(f.requests.length, 5, 'Explicit refresh does not bypass unavailable history ownership');
  f.panel.close();
});

test('Refresh replaces a stalled transport and fences its late success and failure', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const f = fixture(); t.after(() => f.panel.close());
    const old = f.panel.refresh(); await settle();
    assert.equal(f.$('event-log-refresh').disabled, false);
    f.$('event-log-refresh').dispatch('click'); await settle();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].options.signal.aborted, true);
    await f.answer([row(2)]);
    if (outcome === 'resolve') await f.answer([row(1)], {}, 0);
    else f.requests[0].reject(new TypeError('fixture-suspended-transport'));
    await old; await settle();
    assert.equal(f.list.children[0].dataset.eventId, id(2));
    assert.equal(f.$('event-log-message').hidden, true);
    f.panel.close();
  }
});

test('window suspension cancels unused reads and resume checks again before viewport notifications catch up', async t => {
  let visibility;
  class Observer {
    constructor(callback) { visibility = visible => callback([{ target: f.$('event-log-panel'), isIntersecting: visible }]); }
    observe() {} disconnect() {}
  }
  const f = fixture({ IntersectionObserverClass: Observer }); t.after(() => f.panel.close());
  await f.panel.refresh(); visibility(true); await settle();
  const old = f.requests[0];
  f.document.defaultView.dispatch('blur');
  old.reject(new TypeError('fixture-background-network-failure')); await settle();
  assert.equal(old.options.signal.aborted, true);
  assert.notEqual(f.$('event-log-message').dataset.state, 'error');
  await f.panel.refresh(); assert.equal(f.requests.length, 1);
  visibility(false);
  f.document.defaultView.dispatch('focus'); await settle();
  assert.equal(f.requests.length, 2, 'Focus replaces the transport even with stale offscreen state');
  visibility(true); visibility(false);
  assert.equal(f.requests[1].options.signal.aborted, false, 'Delayed observer delivery cannot cancel the resumed read');
  await f.answer([row(2)]);
  const checked = f.$('event-log-status').textContent;
  f.document.hidden = true; f.document.dispatch('visibilitychange');
  f.document.defaultView.dispatch('focus'); await settle();
  assert.equal(f.requests.length, 2, 'Hidden documents cannot resume reads');
  f.document.hidden = false; f.document.dispatch('visibilitychange'); await settle();
  assert.equal(f.requests.length, 3, 'Tab restoration also handles delayed viewport state');
  await f.answer([row(2)]);
  f.document.defaultView.dispatch('pagehide');
  f.document.defaultView.dispatch('pageshow'); await settle();
  assert.equal(f.requests.length, 4);
  assert.equal(f.$('event-log-status').textContent, checked);
  await f.answer([row(3)]);
  assert.equal(f.$('event-log-message').hidden, true);
  f.panel.unavailable(); f.document.defaultView.dispatch('focus'); await settle();
  assert.equal(f.requests.length, 4, 'Window focus cannot bypass unavailable history');
  f.panel.clear(); f.document.defaultView.dispatch('pageshow'); await settle();
  assert.equal(f.requests.length, 4, 'Window restoration cannot bypass logout');
  f.panel.close();
});

test('a discarded browser connection gets one bounded fresh read without publishing a failure', async t => {
  const f = fixture(); t.after(() => f.panel.close());
  const pending = f.panel.refresh(); await settle();
  f.requests[0].reject(new TypeError('fixture-discarded-connection')); await settle();
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.$('event-log-message').dataset.state, 'error');
  await f.answer([row(1)]); await pending;
  assert.equal(f.$('event-log-message').hidden, true);
  const failed = f.panel.refresh(); await settle();
  f.requests[2].reject(Object.assign(new Error('fixture-gateway'), { status: 502 })); await settle();
  f.requests[3].reject(new TypeError('fixture-network-still-unavailable')); await failed;
  assert.equal(f.requests.length, 4, 'Recovery never becomes an unbounded retry loop');
  assert.match(f.$('event-log-message').textContent, /last successfully fetched/);
  assert.equal(f.list.children[0].dataset.eventId, id(1));
  f.panel.close();
});
