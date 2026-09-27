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
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'details[open]');
      return [f.details, otherFold].filter(fold => fold.open);
    },
    getElementById(id) { assert.equal(id, 'comparison-toggle'); return f.button; },
    defaultView: { scrollTo(options) { scrolls.push(options); } },
  };
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
