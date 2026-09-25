import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectDismissal } from '../chart/select-dismissal.js';

function fixture() {
  const document = new EventTarget();
  const controller = createSelectDismissal(document);
  const select = () => {
    const node = { disabled: false, multiple: false, size: 0,
      closest: selector => selector === 'select' ? node : null,
      focus() { document.activeElement = node; },
      blur() { document.activeElement = null; } };
    return node;
  };
  const emit = (type, target) => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
  };
  return { document, controller, select, emit };
}

test('pointer selections dismiss dropdowns including controls added after setup', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const select = f.select(), previous = f.select(); previous.focus();
    f.emit('pointerdown', select); f.emit('focusout', previous); select.focus(); f.emit('change', select);
    assert.equal(f.document.activeElement, null);
    select.focus(); f.emit('change', select);
    assert.equal(f.document.activeElement, select, 'Programmatic changes do not reuse a prior pointer interaction');
  }
});

test('keyboard navigation and cancelled pointer interactions keep focus', () => {
  const f = fixture(), select = f.select();
  for (const type of ['keydown', 'pointercancel', 'focusout']) {
    select.focus(); f.emit('pointerdown', select); f.emit(type, select); f.emit('change', select);
    assert.equal(f.document.activeElement, select, type);
  }
});

test('dismissal preserves the setting handler’s focus transfer to its value editor', () => {
  const f = fixture(), setting = f.select(), value = f.select();
  setting.focus(); f.emit('pointerdown', setting);
  value.focus(); f.emit('change', setting);
  assert.equal(f.document.activeElement, value);
});

test('listboxes, disabled controls and unrelated fields do not dismiss', () => {
  const f = fixture();
  for (const properties of [{ multiple: true }, { size: 3 }, { disabled: true }]) {
    const select = Object.assign(f.select(), properties); select.focus();
    f.emit('pointerdown', select); f.emit('change', select);
    assert.equal(f.document.activeElement, select);
  }
  const select = f.select(); select.focus(); f.emit('pointerdown', select);
  f.emit('pointerdown', {}); f.emit('change', select);
  assert.equal(f.document.activeElement, select);
  f.controller.close();
  f.emit('pointerdown', select); f.emit('change', select);
  assert.equal(f.document.activeElement, select);
});
