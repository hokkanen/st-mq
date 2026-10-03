import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonDisclosure } from '../chart/comparison-disclosure.js';
import { createDashboardReset } from '../chart/dashboard-reset.js';

class Button extends EventTarget {
  attributes = new Map();
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  click() { this.dispatchEvent(new Event('click')); }
  focus(options) { this.focusOptions = options; }
}

function fixture() {
  const button = new Button(); button.setAttribute('aria-expanded', 'false');
  const details = { open: true }, date = { value: '2026-09-12' };
  const selection = new Button(); selection.setAttribute('aria-pressed', 'true');
  const content = { hidden: true, children: [date, selection, details] };
  const openings = [];
  const controller = createComparisonDisclosure({ button, content, onOpen() {
    openings.push({ hidden: content.hidden, expanded: button.getAttribute('aria-expanded') });
  } });
  return { button, content, details, date, selection, openings, controller };
}

test('comparison reopening shows the mounted cards before requesting their layout', () => {
  const f = fixture(), children = f.content.children;
  assert.equal(f.content.hidden, true);
  assert.deepEqual(f.openings, []);
  for (let cycle = 0; cycle < 3; cycle++) {
    f.button.click();
    assert.equal(f.content.hidden, false);
    assert.equal(f.button.getAttribute('aria-expanded'), 'true');
    f.button.click();
    assert.equal(f.content.hidden, true);
    assert.equal(f.button.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(f.content.children, children);
    assert.strictEqual(f.content.children[0], f.date);
    assert.strictEqual(f.content.children[1], f.selection);
    assert.strictEqual(f.content.children[2], f.details);
    assert.equal(f.date.value, '2026-09-12');
    assert.equal(f.selection.getAttribute('aria-pressed'), 'true');
    assert.equal(f.details.open, true);
  }
  assert.deepEqual(f.openings, Array.from({ length: 3 }, () => ({ hidden: false, expanded: 'true' })));
  f.controller.close();
  f.button.click();
  assert.equal(f.content.hidden, true, 'Disposal removes the toggle listener');
  assert.equal(f.openings.length, 3);
});

test('the initial expanded state and the panel visibility agree', () => {
  const button = new Button(); button.setAttribute('aria-expanded', 'true');
  const content = { hidden: true };
  const controller = createComparisonDisclosure({ button, content });
  assert.equal(content.hidden, false);
  button.click();
  assert.equal(content.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  controller.close();
});

test('dashboard reset closes comparisons and native folds without changing comparison choices', () => {
  const f = fixture(), resetButton = new Button(), scrolls = [];
  const otherFold = { open: true };
  const document = Object.assign(new EventTarget(), {
    querySelectorAll(selector) {
      assert.equal(selector, 'details[open]');
      return [f.details, otherFold].filter(fold => fold.open);
    },
    getElementById(id) { assert.equal(id, 'comparison-toggle'); return f.button; },
    defaultView: { scrollTo(options) { scrolls.push(options); } },
  });
  const reset = createDashboardReset({ document, button: resetButton });
  f.button.click();
  resetButton.click();
  assert.equal(f.content.hidden, true);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.details.open, false);
  assert.equal(otherFold.open, false);
  assert.equal(f.date.value, '2026-09-12');
  assert.equal(f.selection.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(scrolls, [{ top: 0, behavior: 'auto' }]);
  assert.deepEqual(resetButton.focusOptions, { preventScroll: true });
  resetButton.click();
  assert.equal(f.content.hidden, true, 'Reset must not reopen a closed comparison');
  assert.equal(f.openings.length, 1);
  reset.close();
  f.button.click(); otherFold.open = true;
  resetButton.click();
  assert.equal(f.content.hidden, false);
  assert.equal(otherFold.open, true);
  assert.equal(scrolls.length, 2, 'Disposal removes the dashboard reset listener');
  f.controller.close();
});

test('closing a linked fold clears only its hidden destination and preserves the URL context', async () => {
  const target = {}, summaryTarget = {}, state = { navigation: 'fixture-entry' }, replacements = [];
  const fold = { tagName: 'DETAILS', open: true,
    contains: node => node === target || node === summaryTarget,
    querySelector: () => ({ contains: node => node === summaryTarget }) };
  const view = { setTimeout, location: { pathname: '/fixture-ingress/dashboard/', search: '?view=heating', hash: '#pipe%20settings' },
    history: { state, replaceState(value, title, url) { replacements.push([value, title, url]); view.location.hash = ''; } } };
  const document = Object.assign(new EventTarget(), {
    defaultView: view, getElementById: id => id === 'pipe settings' ? target : id === 'summary' ? summaryTarget : null,
  });
  const controller = createDashboardReset({ document });
  const toggle = async node => {
    const event = new Event('toggle'); Object.defineProperty(event, 'target', { value: node }); document.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await toggle(fold);
  assert.equal(view.location.hash, '#pipe%20settings', 'Opening retains the direct link');
  fold.open = false;
  await toggle({ ...fold, contains: () => false });
  assert.equal(view.location.hash, '#pipe%20settings', 'Closing an unrelated fold retains the destination');
  await toggle(fold);
  assert.deepEqual(replacements, [[state, '', '/fixture-ingress/dashboard/?view=heating']]);
  for (const hash of ['#summary', '#missing', '#%invalid']) {
    view.location.hash = hash; await toggle(fold);
    assert.equal(view.location.hash, hash, 'Visible, unknown and malformed destinations are left alone');
  }
  view.location.hash = '#pipe%20settings';
  const pendingToggle = toggle(fold);
  fold.open = true; await pendingToggle;
  assert.equal(view.location.hash, '#pipe%20settings', 'A newer navigation that reopens the fold keeps its fragment');
  fold.open = false;
  const closingToggle = toggle(fold);
  controller.close(); await closingToggle;
  await toggle(fold);
  assert.equal(view.location.hash, '#pipe%20settings', 'Disposal removes the capture listener');
});
