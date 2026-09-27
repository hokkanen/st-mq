import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryChart, historyRenderFingerprint } from '../chart/history-chart.js';

test('comparison-only changes do not redraw the independently selected chart', () => {
  const selection = { startDate: '2026-09-01', endDate: '2026-09-01', view: 'power' };
  const before = { range: { from: 0, to: 1000 }, now: 2000, series: {}, meta: { revision: 1 },
    heatingSavings: { garage: { model: { valueEuro: 2 } }, total: { model: { valueEuro: 3 } } } };
  const after = { ...before, heatingSavings: {
    garage: { model: { valueEuro: 5 } }, total: { model: { valueEuro: 6 } },
  } };
  assert.equal(historyRenderFingerprint(before, selection), historyRenderFingerprint(after, selection));
  assert.equal(historyRenderFingerprint(after, selection), historyRenderFingerprint({ ...after, now: 3000 }, selection),
    'An out-of-range clock change alone does not redraw historical results');
});

/** Exercise the real refresh/request path without finishing a download or
 * starting canvas rendering. Controls need only their ordinary DOM methods. */
function fixture(t) {
  class Element extends EventTarget {
    constructor() { super(); this.dataset = {}; this.children = []; this.attributes = new Map(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    remove() {}
    checkValidity() { return true; }
    setCustomValidity() {}
    closest() { return this; }
  }
  const nodes = new Map();
  const document = Object.assign(new EventTarget(), {
    documentElement: new Element(),
    getElementById(id) {
      if (id === 'timing-benefit') return null;
      if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(), { ownerDocument: document }));
      return nodes.get(id);
    },
    createElement() { return new Element(); },
    body: new Element(),
  });
  const globals = { document, localStorage: { getItem: () => null },
    window: Object.assign(new EventTarget(), { matchMedia: () => new EventTarget() }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }) };
  document.defaultView = globals.window;
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const requests = [];
  const chart = createHistoryChart({ api: (path, { signal }) => new Promise((_resolve, reject) => {
    requests.push({ path, signal });
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  t.after(() => chart.close());
  return { chart, requests, nodes };
}

test('a start selected before the first status keeps the original inactive end suggestion', async t => {
  const { requests, nodes } = fixture(t);
  const suggestedEnd = nodes.get('date-end').value;
  const start = nodes.get('date-start');
  start.value = '2024-01-15'; start.dispatchEvent(new Event('change'));
  await Promise.resolve();
  assert.equal(nodes.get('date-end').value, suggestedEnd);
  assert.equal(nodes.get('date-end').dataset.singleDay, 'true');
  const query = new URL(requests[0].path, 'http://fixture');
  assert.equal(query.searchParams.get('start'), '2024-01-15');
  assert.equal(query.searchParams.get('end'), '2024-01-15');
});

test('explicit chart refresh after a mutation cancels old work while recorder polls share it', async t => {
  const { chart, requests } = fixture(t);
  const status = { now: Date.parse('2026-09-20T12:00:00Z'), input: 'providers',
    recording: { historyRevision: 1, temperatureReportRevision: 1, sourceReportRevision: 1 } };
  const initial = chart.refresh(status);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  const updated = { ...status, recording: { ...status.recording, historyRevision: 2, sourceReportRevision: 2 } };
  const polled = chart.refresh(updated);
  await Promise.resolve();
  assert.equal(requests.length, 1, 'A new recorder revision must not restart the pending query');
  assert.equal(requests[0].signal.aborted, false);

  // For example, a garage sensor correction need not change the house model's
  // trainedAt field or another automatically observed chart invalidation key.
  const corrected = chart.refresh(updated, { force: true });
  await Promise.resolve();
  assert.equal(requests[0].signal.aborted, true, 'The explicit correction discards the pre-mutation query');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, requests[0].path, 'Even identical selected dates must be refetched');
  chart.close();
  await Promise.all([initial, polled, corrected]);
});
