import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonPeriod, createComparisonRange } from '../chart/comparison-range.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Exercise the real calendars and comparison cards with controlled API replies.
function fixture() {
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName; this.children = []; this.listeners = []; this.attributes = {};
      this.dataset = {}; this.value = ''; this.min = ''; this.max = ''; this._text = '';
      this.style = { setProperty(name, value) { this[name] = value; } };
    }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
    removeEventListener(type, listener) { this.listeners = this.listeners.filter(item => item.type !== type || item.listener !== listener); }
    emit(type) {
      const event = { currentTarget: this, target: this, preventDefault() {} };
      for (const item of [...this.listeners]) if (item.type === type) item.listener(event);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === 'fragment') this.append(...node.children);
        else { this.children.push(node); node.parentElement = this; }
      }
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
    closest() { return null; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
    setCustomValidity(message) { this.validationMessage = message; }
    checkValidity() { return !this.validationMessage; }
    getBoundingClientRect() { return { height: 200 }; }
    focus() { document.activeElement = this; }
  }
  const document = Object.assign(new Element(), { defaultView: new Element() });
  document.createElement = tag => Object.assign(new Element(tag), { ownerDocument: document });
  document.createDocumentFragment = () => document.createElement('fragment');
  document.body = document.createElement('body');
  const elements = new Map();
  for (const id of ['comparison-toggle', 'comparison-content', 'timing-benefit', 'comparison-range-form', 'comparison-date-start', 'comparison-date-end',
    'comparison-range-status', 'comparison-range-retry', ...['week', 'month', 'year', 'previous-year'].map(period => `comparison-period-${period}`)]) {
    const element = document.createElement(id.includes('date-') ? 'input' : 'div');
    element.id = id; element.required = true; elements.set(id, element); document.body.append(element);
  }
  document.getElementById = id => elements.get(id);
  const requests = [];
  const api = (path, { signal }) => new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject }));
  const controller = createComparisonRange({ api, document, now: () => NOW });
  const get = id => elements.get(id);
  return { controller, requests, document, get, root: get('timing-benefit'), form: get('comparison-range-form'),
    message: get('comparison-range-status'), retry: get('comparison-range-retry'),
    start: get('comparison-date-start'), end: get('comparison-date-end'),
    change(field, value) { const input = get(`comparison-date-${field}`); input.value = value; input.emit('change'); },
    preset(period) { get(`comparison-period-${period}`).emit('click'); },
  };
}

function reply(request, valueEuro = 1) {
  const query = new URL(request.path, 'http://fixture.invalid').searchParams;
  const startDate = query.get('start'), endDate = query.get('end');
  request.resolve({ now: NOW, range: { startDate, endDate,
    from: Date.parse(`${startDate}T00:00:00+03:00`), to: Date.parse(`${endDate}T00:00:00+03:00`) + 86400000 },
  heatingBenefit: { status: 'estimated', valueEuro, counts: { assessed: 1, completed: 1 } } });
}

test('comparison shortcuts use Finnish calendar dates, inclusive weeks and complete previous periods', () => {
  for (const [preset, at, dates] of [
    ['today', '2026-12-31T22:30:00Z', ['2027-01-01', '2027-01-01']],
    ['year', '2026-12-31T22:30:00Z', ['2027-01-01', '2027-01-01']],
    ['previous-year', '2026-12-31T22:30:00Z', ['2026-01-01', '2026-12-31']],
    ['month', '2024-02-29T22:30:00Z', ['2024-02-01', '2024-02-29']],
    ['month', '2026-01-15T12:00:00Z', ['2025-12-01', '2025-12-31']],
    ['week', '2026-03-29T21:30:00Z', ['2026-03-24', '2026-03-30']],
    ['week', '2026-10-25T22:30:00Z', ['2026-10-20', '2026-10-26']],
  ]) assert.deepEqual(comparisonPeriod(preset, Date.parse(at)), { startDate: dates[0], endDate: dates[1] }, `${preset} at ${at}`);
});

test('the first status sets Finnish dates and later midnight polls preserve the selected period', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: Date.parse('2026-09-27T21:30:00Z') });
  await tick();
  assert.equal(f.start.value, '2026-09-28'); assert.equal(f.end.value, '2026-09-28');
  reply(f.requests[0]); await first;
  await f.controller.refresh({ now: Date.parse('2026-09-28T21:30:00Z') });
  assert.equal(f.requests.length, 1);
  assert.equal(f.start.value, '2026-09-28'); assert.equal(f.end.value, '2026-09-28');
  assert.match(f.message.textContent, /^2026-09-28 · Finnish time$/);

  f.preset('week'); await tick(); reply(f.requests[1]); await tick();
  assert.equal(f.start.value, '2026-09-23'); assert.equal(f.end.value, '2026-09-29');
  await f.controller.refresh({ now: Date.parse('2026-09-29T21:30:00Z') });
  assert.equal(f.start.value, '2026-09-23'); assert.equal(f.end.value, '2026-09-29');
  assert.equal(f.get('comparison-period-week').getAttribute('aria-pressed'), 'true');
});

test('custom starts select one day, retain the end suggestion and reject invalid end dates', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: NOW }); await tick(); reply(f.requests[0]); await first;
  f.preset('month'); await tick(); reply(f.requests[1]); await tick();
  assert.equal(f.end.value, '2026-08-31');
  f.change('start', '2026-08-12'); await tick();
  assert.match(f.requests[2].path, /start=2026-08-12&end=2026-08-12/);
  assert.equal(f.end.value, '2026-08-31'); assert.equal(f.end.min, '2026-08-12');
  assert.equal(f.end.dataset.singleDay, 'true');
  assert.equal(f.get('comparison-period-month').getAttribute('aria-pressed'), 'false');
  reply(f.requests[2]); await tick();
  f.change('end', '2026-08-11'); await tick();
  assert.equal(f.end.checkValidity(), false); assert.equal(f.requests.length, 3);
  f.change('end', '2026-08-31'); await tick();
  assert.match(f.requests[3].path, /start=2026-08-12&end=2026-08-31/);
  assert.equal(f.end.dataset.singleDay, 'false');
  reply(f.requests[3]); await tick();
  assert.equal(f.form.dataset.startDate, '2026-08-12'); assert.equal(f.form.dataset.endDate, '2026-08-31');
  f.change('start', '2026-02-30'); await tick();
  assert.equal(f.start.checkValidity(), false); assert.equal(f.requests.length, 4);
});

test('changing period cancels the old request and a late reply cannot overwrite the newer cards', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: NOW }); await tick();
  f.preset('year'); await tick();
  assert.equal(f.requests[0].signal.aborted, true);
  reply(f.requests[1], 2); await tick();
  assert.match(f.root.textContent, /€2.00/);
  assert.equal(f.form.dataset.startDate, '2026-01-01');
  reply(f.requests[0], 99); await first;
  assert.match(f.root.textContent, /€2.00/); assert.doesNotMatch(f.root.textContent, /€99.00/);
  assert.equal(f.form.dataset.state, 'ready'); assert.equal(f.root.getAttribute('aria-busy'), 'false');
});

test('recorder polling coalesces a pending period and refreshes its readings on the following poll', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: NOW, recording: { historyRevision: 1 } }); await tick();
  const poll = f.controller.refresh({ now: NOW, recording: { historyRevision: 2 } }); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, false);
  reply(f.requests[0], 3); await Promise.all([first, poll]);
  assert.equal(f.form.dataset.state, 'ready'); assert.match(f.root.textContent, /€3.00/);
  const following = f.controller.refresh({ now: NOW, recording: { historyRevision: 2 } }); await tick();
  assert.equal(f.requests.length, 2, 'A coalesced forced refresh must not cache the older readings');
  reply(f.requests[1], 4); await following;
  assert.match(f.root.textContent, /€4.00/);
});

test('a new source report renews live comparisons even when the recorded history revision is unchanged', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const status = sourceReportRevision => ({ now: NOW, recording: { historyRevision: 4, sourceReportRevision } });
  const first = f.controller.refresh(status(1)); await tick(); reply(f.requests[0], 1); await first;
  const report = f.controller.refresh(status(2)); await tick();
  assert.equal(f.requests.length, 2, 'New source freshness must bypass cached comparison results');
  const newerReport = f.controller.refresh(status(3)); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].signal.aborted, false);
  reply(f.requests[1], 2); await Promise.all([report, newerReport]);
  const following = f.controller.refresh(status(3)); await tick();
  assert.equal(f.requests.length, 3, 'Coalesced source reports must be reflected by the next refresh');
  reply(f.requests[2], 3); await following;
  assert.match(f.root.textContent, /€3.00/);
  await f.controller.refresh(status(3));
  assert.equal(f.requests.length, 3, 'Unchanged source and history revisions may reuse the fresh result');
});

test('source corrections and explicit refresh invalidate an identical pending period', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: NOW, fireplace: { revision: 1 } }); await tick();
  const correction = f.controller.refresh({ now: NOW, fireplace: { revision: 2 } }); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, true);
  const forced = f.controller.refresh(undefined, { force: true }); await tick();
  assert.equal(f.requests.length, 3); assert.equal(f.requests[1].signal.aborted, true);
  reply(f.requests[2], 5); await forced;
  reply(f.requests[1], 7); reply(f.requests[0], 9); await Promise.all([first, correction]);
  assert.match(f.root.textContent, /€5.00/); assert.doesNotMatch(f.root.textContent, /€7.00|€9.00/);
});

test('failed period requests identify retained results and retry replaces them only after success', async t => {
  const f = fixture(); t.after(() => f.controller.close());
  const first = f.controller.refresh({ now: NOW }); await tick(); reply(f.requests[0], 1); await first;
  f.preset('month'); await tick();
  assert.match(f.message.textContent, /Loading 2026-08-01 – 2026-08-31.*Showing 2026-09-27 until ready/);
  assert.equal(f.root.dataset.stale, 'true'); assert.equal(f.root.getAttribute('aria-busy'), 'true');
  f.requests[1].reject(new Error('Fixture unavailable')); await tick();
  assert.equal(f.form.dataset.state, 'error'); assert.equal(f.retry.hidden, false);
  assert.match(f.message.textContent, /Unable to load 2026-08-01 – 2026-08-31: Fixture unavailable.*Showing 2026-09-27/);
  assert.match(f.root.textContent, /€1.00/); assert.equal(f.form.dataset.startDate, '2026-09-27');
  f.retry.emit('click'); await tick();
  assert.equal(f.requests.length, 3); assert.equal(f.form.dataset.state, 'loading');
  assert.match(f.message.textContent, /Showing 2026-09-27 until ready/);
  reply(f.requests[2], 6); await tick();
  assert.equal(f.form.dataset.state, 'ready'); assert.equal(f.retry.hidden, true);
  assert.equal(f.root.dataset.stale, 'false'); assert.equal(f.root.getAttribute('aria-busy'), 'false');
  assert.match(f.message.textContent, /^2026-08-01 – 2026-08-31 · Finnish time$/);
  assert.match(f.root.textContent, /€6.00/); assert.doesNotMatch(f.root.textContent, /€1.00/);
});

test('closing aborts requests, removes both calendars and ignores subsequent controls and replies', async () => {
  const f = fixture();
  const first = f.controller.refresh({ now: NOW }); await tick();
  assert.equal(f.document.body.children.filter(node => node.className === 'date-picker').length, 2);
  f.controller.close();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.document.body.children.filter(node => node.className === 'date-picker').length, 0);
  f.preset('year'); f.change('start', '2026-01-01'); f.retry.emit('click');
  await f.controller.refresh({ now: NOW });
  reply(f.requests[0], 99); await first;
  assert.equal(f.requests.length, 1); assert.equal(f.root.textContent, '');
});
