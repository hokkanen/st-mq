import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatePicker } from '../chart/date-picker.js';

function fixture(value = '2026-09-27', min = '2026-09-01', options = {}) {
  const emit = (target, type, properties = {}) => {
    const event = { target, type, button: 0, defaultPrevented: false, ...properties,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    const path = [];
    for (let node = target; node; node = node.parentNode) path.push(node);
    for (const capture of [true, false]) {
      for (const node of capture ? [...path].reverse() : path) {
        for (const item of node.listeners || []) if (item.type === type && item.capture === capture) item.listener(event);
        if (event.stopped) return event;
      }
    }
    return event;
  };
  class Node {
    constructor(tagName = 'div') {
      this.tagName = tagName; this.listeners = []; this.children = []; this.attributes = {};
      this.dataset = {}; this.style = {}; this.className = ''; this.value = ''; this.min = ''; this.max = '';
    }
    addEventListener(type, listener, capture = false) { this.listeners.push({ type, listener, capture }); }
    removeEventListener(type, listener, capture) { this.listeners = this.listeners.filter(item => item.type !== type || item.listener !== listener || item.capture !== capture); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
    contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
    closest(selector) {
      for (let node = this; node; node = node.parentNode) {
        if (selector === '[data-date]' && node.dataset.date) return node;
        if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node;
      }
      return null;
    }
    remove() { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    set textContent(text) { this.text = text; for (const node of this.children) node.parentNode = null; this.children = []; }
    get textContent() { return this.text; }
    focus() { document.activeElement = this; emit(this, 'focusin'); }
    getBoundingClientRect() { return this.bounds || { left: 20, top: 20, bottom: 44, width: 280, height: 300 }; }
    setCustomValidity(message) { this.validationMessage = message; }
    checkValidity() { return !this.validationMessage && this.valid !== false; }
    reportValidity() { return this.checkValidity(); }
  }
  const window = Object.assign(new Node(), { innerWidth: 800, innerHeight: 600 });
  const document = Object.assign(new Node(), { defaultView: window });
  document.createElement = tag => Object.assign(new Node(tag), { ownerDocument: document });
  document.body = document.createElement('body'); document.append(document.body);
  const panel = document.createElement('section'); panel.className = 'history-panel'; document.body.append(panel);
  const input = document.createElement('input'); input.id = 'date-end'; input.value = value; input.min = min; panel.append(input);
  const selections = [];
  const controller = createDatePicker(input, { label: 'Choose end date', onSelect: date => selections.push(date), ...options });
  const find = (predicate, parent = panel) => {
    if (predicate(parent)) return parent;
    for (const child of parent.children) { const found = find(predicate, child); if (found) return found; }
    return null;
  };
  const popup = find(node => node.className === 'date-picker');
  return { input, selections, controller, document, window, panel, popup, emit,
    day: date => find(node => node.dataset.date === date),
    button: label => find(node => node.getAttribute('aria-label') === label || node.tagName === 'button' && node.textContent === label),
    field: name => find(node => node.id === `${popup.id}-${name}`),
    open: () => emit(input, 'click'),
  };
}

test('opening preserves the suggested end date and clicking that same day explicitly selects it', () => {
  const f = fixture();
  assert.equal(f.popup.parentNode, f.panel, 'The fullscreen chart owns its calendar focus targets');
  assert.equal(f.open().defaultPrevented, true);
  assert.equal(f.input.value, '2026-09-27');
  assert.deepEqual(f.selections, []);
  assert.equal(f.document.activeElement, f.day('2026-09-27'));
  assert.equal(f.day('2026-09-27').getAttribute('aria-pressed'), 'true');
  f.emit(f.day('2026-09-27'), 'click');
  assert.deepEqual(f.selections, ['2026-09-27']);
  assert.equal(f.popup.hidden, true);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.input.getAttribute('aria-expanded'), 'false');
});

test('Escape, outside interactions, and programmatic dismissal keep the suggestion without selecting', () => {
  const f = fixture();
  for (const dismiss of [
    () => f.emit(f.document.activeElement, 'keydown', { key: 'Escape' }),
    () => f.emit(f.document.body, 'mousedown'),
    () => f.emit(f.document.body, 'touchstart'),
    () => f.document.body.focus(),
    () => f.controller.dismiss(),
  ]) {
    f.open(); dismiss();
    assert.equal(f.popup.hidden, true);
    assert.equal(f.input.value, '2026-09-27');
    assert.deepEqual(f.selections, []);
  }
});

test('an earlier suggestion stays unchanged while its calendar opens at the minimum valid date', () => {
  const f = fixture('2026-08-20', '2026-09-10');
  f.open();
  assert.equal(f.input.value, '2026-08-20');
  assert.equal(f.document.activeElement, f.day('2026-09-10'));
  assert.equal(f.day('2026-09-09').disabled, true);
  assert.equal(f.button('Previous month').disabled, true);
  f.emit(f.day('2026-09-09'), 'click');
  assert.deepEqual(f.selections, []);
  f.emit(f.day('2026-09-11'), 'click');
  assert.deepEqual(f.selections, ['2026-09-11']);
  assert.equal(f.input.value, '2026-09-11');
});

test('calendar navigation crosses leap days, month ends and years without timezone drift', () => {
  const f = fixture('2024-03-31', '2023-01-01');
  f.open();
  const press = (key, properties = {}) => f.emit(f.document.activeElement, 'keydown', { key, ...properties });
  press('PageUp');
  assert.equal(f.document.activeElement.dataset.date, '2024-02-29');
  press('ArrowRight');
  assert.equal(f.document.activeElement.dataset.date, '2024-03-01');
  press('Home');
  assert.equal(f.document.activeElement.dataset.date, '2024-02-26');
  press('End');
  assert.equal(f.document.activeElement.dataset.date, '2024-03-03');
  press('PageUp', { shiftKey: true });
  assert.equal(f.document.activeElement.dataset.date, '2023-03-03');
  f.emit(f.button('Previous month'), 'click');
  assert.ok(f.day('2023-02-03'));
  f.emit(f.button('Next month'), 'click');
  assert.ok(f.day('2023-03-03'));
  assert.deepEqual(f.selections, []);
  assert.equal(f.input.value, '2024-03-31');
});

test('keyboard shortcuts open the calendar and Enter confirms the existing valid value', () => {
  const f = fixture();
  for (const keys of [{ key: ' ' }, { key: 'ArrowDown', altKey: true }]) {
    assert.equal(f.emit(f.input, 'keydown', keys).defaultPrevented, true);
    assert.equal(f.popup.hidden, false);
    f.controller.dismiss();
  }
  f.emit(f.input, 'keydown', { key: 'Enter' });
  assert.deepEqual(f.selections, ['2026-09-27']);
  f.input.valid = false;
  f.emit(f.input, 'keydown', { key: 'Enter' });
  assert.deepEqual(f.selections, ['2026-09-27']);
});

test('keyboard dates stay within the current bounds and the popup stays inside a small viewport', () => {
  const f = fixture('2026-09-27', '2026-09-27');
  f.input.max = '2026-09-28';
  f.input.bounds = { left: 600, top: 1000, bottom: 1030, width: 150, height: 30 };
  f.window.innerWidth = 390; f.window.innerHeight = 780;
  f.open();
  assert.equal(f.popup.style.left, '102px');
  assert.equal(f.popup.style.top, '472px');
  f.emit(f.document.activeElement, 'keydown', { key: 'ArrowLeft' });
  assert.equal(f.document.activeElement.dataset.date, '2026-09-27');
  f.emit(f.document.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(f.document.activeElement.dataset.date, '2026-09-28');
  assert.equal(f.button('Next month').disabled, true);
  assert.equal(f.day('2026-09-29').disabled, true);
});

test('closing removes calendar listeners and restores the input accessibility attributes', () => {
  const f = fixture();
  f.open(); f.controller.close();
  assert.equal(f.popup.parentNode, null);
  assert.equal(f.input.getAttribute('aria-haspopup'), null);
  assert.equal(f.input.getAttribute('aria-expanded'), null);
  assert.equal(f.input.getAttribute('aria-controls'), null);
  assert.equal(f.emit(f.input, 'click').defaultPrevented, false);
  f.emit(f.input, 'keydown', { key: 'Enter' });
  assert.deepEqual(f.selections, []);
});

test('the start calendar uses the shared UI and keeps typed dates subject to calendar and range validation', () => {
  const f = fixture('2026-09-27', '2026-09-01', { label: 'Choose start date' });
  assert.equal(f.input.type, 'text', 'No browser date popup can open');
  assert.equal(f.popup.getAttribute('aria-label'), 'Choose start date');
  f.open(); f.emit(f.day('2026-09-03'), 'click');
  assert.deepEqual(f.selections, ['2026-09-03']);
  for (const value of ['2026-02-30', 'not a date', '2026-08-31']) {
    f.input.value = value; f.emit(f.input, 'change');
    assert.equal(f.input.checkValidity(), false, value);
    f.emit(f.input, 'keydown', { key: 'Enter' });
  }
  assert.equal(f.selections.length, 1);
  f.input.value = '2026-09-08'; f.emit(f.input, 'input');
  assert.equal(f.input.checkValidity(), true);
  f.emit(f.input, 'keydown', { key: 'Enter' });
  assert.deepEqual(f.selections, ['2026-09-03', '2026-09-08']);
});

test('date and time selection stages a draft until Set, preserves cancellation and supports clearing', () => {
  const f = fixture('2026-09-27T09:30', '', { mode: 'datetime-local' });
  f.open();
  assert.equal(f.field('hour').value, '09');
  assert.equal(f.field('minute').value, '30');
  f.emit(f.day('2026-09-28'), 'click');
  f.field('hour').value = '18'; f.field('minute').value = '45';
  assert.equal(f.input.value, '2026-09-27T09:30');
  assert.deepEqual(f.selections, []);
  f.emit(f.button('Close'), 'click');
  f.open();
  assert.equal(f.field('hour').value, '09');
  f.emit(f.day('2026-09-29'), 'click');
  f.field('hour').value = '17'; f.field('minute').value = '05';
  f.emit(f.button('Set'), 'click');
  assert.equal(f.input.value, '2026-09-29T17:05');
  assert.deepEqual(f.selections, ['2026-09-29T17:05']);
  assert.equal(f.popup.hidden, true);
  f.open(); f.emit(f.button('Clear'), 'click');
  assert.equal(f.input.value, '');
  assert.equal(f.input.checkValidity(), true);
  assert.deepEqual(f.selections, ['2026-09-29T17:05', '']);
});

test('time bounds and invalid clock values cannot be committed, and a disabled control cannot change', () => {
  const f = fixture('2026-09-27T09:30', '2026-09-27T09:00', { mode: 'datetime-local' });
  f.input.max = '2026-09-27T12:00';
  f.open();
  for (const [hours, minutes] of [['24', '00'], ['10', '60'], ['', '30'], ['10.5', '30'], ['08', '00']]) {
    f.field('hour').value = hours; f.field('minute').value = minutes;
    f.emit(f.field('minute'), 'input'); f.emit(f.button('Set'), 'click');
    assert.deepEqual(f.selections, [], `${hours}:${minutes}`);
  }
  f.field('hour').value = '11'; f.field('minute').value = '45'; f.emit(f.field('minute'), 'input');
  f.input.disabled = true; f.emit(f.button('Set'), 'click');
  assert.deepEqual(f.selections, []);
  f.input.disabled = false; f.emit(f.button('Set'), 'click');
  assert.deepEqual(f.selections, ['2026-09-27T11:45']);
});

test('empty date/time fields open at Finnish local time and collapsing their drawer dismisses them', () => {
  const f = fixture('', '', { mode: 'datetime-local', now: () => Date.parse('2026-09-27T22:05:00Z') });
  f.open();
  assert.equal(f.document.activeElement.dataset.date, '2026-09-28');
  assert.equal(f.field('hour').value, '01');
  assert.equal(f.field('minute').value, '05');
  f.panel.open = false; f.emit(f.panel, 'toggle');
  assert.equal(f.popup.hidden, true);
  assert.deepEqual(f.selections, []);
});
