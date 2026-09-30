import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigurationReview } from '../chart/configuration-review.js';
import { ACTION_RECEIPT_MS } from '../chart/action-receipts.js';

function fixture(request) {
  const nodes = new Map(), calls = [], applied = [], busy = [];
  let status = { webAccess: { role: 'admin' } }, blocked = false, now = 100;
  class Node {
    constructor() {
      this.children = []; this.events = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = '';
      const classes = new Set();
      this.classList = { toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
        remove: name => classes.delete(name), contains: name => classes.has(name) };
    }
    set textContent(value) { this.value = value; this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; this.value = ''; }
    addEventListener(type, listener) { this.events[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { document.activeElement = this; }
    click() { return this.events.click?.(); }
  }
  const document = { createElement: () => new Node(), getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id);
  } };
  const panel = createConfigurationReview({ document, request: async (...args) => { calls.push(args); return request(...args); },
    getStatus: () => status, blocked: () => blocked, clock: () => now,
    onBusy: value => busy.push(value), onStatus: value => applied.push(value), afterApply: async () => {} });
  return { document, panel, calls, applied, busy, get: document.getElementById,
    role(role) { status = { webAccess: { role } }; panel.update(); },
    block(value) { blocked = value; panel.update(); }, advance(ms) { now += ms; panel.update(); } };
}
const review = { valid: true, reviewId: 'synthetic-review-id', canApply: true, imported: false,
  changes: [{ path: 'garage.awayTargetC', before: 8, after: 6, redacted: false }], restartRequired: [] };

test('check displays a diff without applying; only explicit reviewed apply submits the review ID', async () => {
  const f = fixture(async path => path.endsWith('/preview') ? review : { loaded: true });
  await f.get('settings-reload').click();
  assert.deepEqual(f.calls, [['/api/settings/preview', {}]]);
  assert.equal(f.get('settings-review').hidden, false);
  assert.equal(f.document.activeElement, f.get('settings-review-title'));
  assert.equal(f.get('settings-review-changes').textContent, 'garage.awayTargetC86');
  f.panel.update();
  assert.equal(f.document.activeElement, f.get('settings-review-title'));
  await f.get('settings-review-apply').click();
  assert.deepEqual(f.calls[1], ['/api/settings/reload', { reviewId: review.reviewId }]);
  assert.deepEqual(f.applied, [{ loaded: true }]);
  assert.equal(f.get('settings-review').hidden, true);
  assert.equal(f.get('settings-reload-message').textContent, 'Configuration applied.');
  f.advance(ACTION_RECEIPT_MS - 1);
  assert.equal(f.get('settings-reload-message').textContent, 'Configuration applied.');
  f.advance(1);
  assert.equal(f.get('settings-reload-message').textContent, '');
  assert.deepEqual(f.busy, [true, false, true, false]);
});

test('cancel discards the review and restoring authority cannot apply it', async () => {
  const f = fixture(async () => review);
  await f.get('settings-reload').click();
  f.get('settings-review-cancel').click();
  f.block(true); f.block(false);
  await f.get('settings-review-apply').click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.get('settings-review').hidden, true);
  assert.equal(f.document.activeElement, f.get('settings-reload'));
});

test('family and blocked controls cannot request or apply; late admin response cannot reopen a cleared review', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.role('family');
  assert.equal(f.get('settings-reload').hidden, true);
  await f.get('settings-reload').click();
  assert.equal(f.calls.length, 0);
  f.role('admin'); f.block(true);
  await f.get('settings-reload').click();
  assert.equal(f.calls.length, 0);
  f.block(false);
  const pending = f.get('settings-reload').click();
  f.role('family'); f.role('admin');
  finish(review); await pending;
  assert.equal(f.get('settings-review').hidden, true);
  await f.get('settings-review-apply').click();
  assert.equal(f.calls.length, 1);
});

test('restart-only review cannot apply and private values remain hidden even if a renderer receives raw values', async () => {
  const f = fixture(async () => ({ ...review, canApply: false, restartRequired: ['Web listening port'],
    changes: [{ path: 'mqtt.pw', before: 'invented-before', after: 'invented-after', redacted: true }] }));
  await f.get('settings-reload').click();
  assert.equal(f.get('settings-review-changes').textContent, 'mqtt.pwHiddenHidden');
  assert.equal(f.get('settings-review-restart-note').hidden, false);
  assert.equal(f.get('settings-review-restart').textContent, 'Web listening port');
  assert.equal(f.get('settings-review-apply').disabled, true);
  await f.get('settings-review-apply').click();
  assert.equal(f.calls.length, 1);
});

test('a failed recheck invalidates the previous review and leaves an actionable validation error', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw Error('Invalid configuration field: garage.awayTargetC.'); return review; });
  await f.get('settings-reload').click();
  fail = true;
  await f.get('settings-reload').click();
  assert.equal(f.get('settings-review').hidden, true);
  assert.equal(f.get('settings-reload-message').classList.contains('form-error'), true);
  assert.match(f.get('settings-reload-message').textContent, /garage.awayTargetC/);
  await f.get('settings-review-apply').click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.get('settings-reload').disabled, false);
});
