import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectPickers } from '../chart/select-picker.js';

function fixture({ popovers = true } = {}) {
  const observers = [];
  let document;
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.nodeType = 1; this.childNodes = []; this.attributes = new Map();
      this.listeners = []; this.dataset = {}; this.style = {}; this.className = ''; this._disabled = false; this._hidden = false;
      this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); },
        remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); } };
    }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { return document?.contains(this); }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(text) { this.replaceChildren(); this.childNodes.push({ nodeType: 3, textContent: String(text), parentNode: this }); }
    get disabled() { return this._disabled; }
    set disabled(value) { this._disabled = Boolean(value); }
    get hidden() { return this._hidden; }
    set hidden(value) { this._hidden = Boolean(value); }
    get options() { return this.querySelectorAll('option'); }
    get selectedIndex() { return this.options.findIndex(option => option.selected); }
    set selectedIndex(value) { this.options.forEach((option, index) => { option.selected = index === Number(value); }); }
    get value() { return this.tagName === 'SELECT' ? this.options[this.selectedIndex]?.value ?? '' : this._value ?? ''; }
    set value(value) {
      if (this.tagName === 'SELECT') this.selectedIndex = this.options.findIndex(option => option.value === String(value));
      else this._value = String(value);
    }
    get label() { return this._label ?? this.textContent; }
    set label(value) { this._label = value; }
    get labels() { return document.querySelectorAll('label').filter(label => label.contains(this) || label.htmlFor === this.id); }
    get validity() { return { valid: !this.required || Boolean(this.value) }; }
    get validationMessage() { return this.validity.valid ? '' : 'Please select an item in the list.'; }
    get scrollHeight() { return this.children.length * 42 + 10; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove?.(); this.childNodes.push(node); node.parentNode = this; } }
    after(...nodes) {
      const parent = this.parentNode, index = parent.childNodes.indexOf(this);
      parent.childNodes.splice(index + 1, 0, ...nodes); for (const node of nodes) node.parentNode = parent;
    }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
    replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
    contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
    matches(selector) {
      return selector.split(',').some(raw => {
        const part = raw.trim();
        if (part === ':disabled') return this.disabled || Boolean(this.closest('fieldset')?.disabled);
        if (part === ':popover-open') return Boolean(this.popoverOpen);
        if (part === '[hidden]') return this.hidden;
        if (part === '[inert]') return Boolean(this.inert);
        if (part === '[data-index]') return this.dataset.index !== undefined;
        if (part === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
        if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
        return this.tagName === part.toUpperCase();
      });
    }
    closest(selector) { for (let node = this; node?.matches; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type, listener, capture = false) { this.listeners.push({ type, listener, capture }); }
    removeEventListener(type, listener, capture = false) { this.listeners = this.listeners.filter(item => item.type !== type || item.listener !== listener || item.capture !== capture); }
    dispatchEvent(event) {
      Object.defineProperty(event, 'target', { configurable: true, value: this });
      const path = []; for (let node = this; node; node = node.parentNode) path.push(node);
      for (const capture of [true, false]) {
        for (const node of capture ? [...path].reverse() : path) {
          for (const item of [...node.listeners]) if (item.type === event.type && item.capture === capture) item.listener(event);
          if (event.cancelBubble) return !event.defaultPrevented;
          if (!capture && !event.bubbles) break;
        }
      }
      return !event.defaultPrevented;
    }
    focus() { document.activeElement = this; this.dispatchEvent(new Event('focusin', { bubbles: true })); }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    getClientRects() { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]; }
    getBoundingClientRect() {
      return this.bounds ?? { left: 20, top: 20, bottom: 62, width: 200, height: this.className === 'app-select-popup' ? Math.min(this.scrollHeight, 320) : 42 };
    }
    scrollIntoView() {}
    showPopover() { this.popoverOpen = true; }
    hidePopover() { this.popoverOpen = false; }
  }
  if (!popovers) { Node.prototype.showPopover = undefined; Node.prototype.hidePopover = undefined; }
  const window = new Node('window');
  Object.assign(window, { innerWidth: 800, innerHeight: 600, Event, queueMicrotask,
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } } });
  document = new Node('document'); document.nodeType = 9; document.defaultView = window;
  document.createElement = tag => new Node(tag); document.body = new Node('body'); document.append(document.body);
  const makeOption = (value, text, attributes = {}) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text; Object.assign(option, attributes); return option;
  };
  const makeSelect = (parent = document.body, rows = [['a', 'Auto'], ['b', 'Boost'], ['c', 'Cool']]) => {
    const select = document.createElement('select'); select.id = 'mode'; select.setAttribute('aria-label', 'Mode');
    select.append(...rows.map(([value, text, attributes]) => makeOption(value, text, attributes))); select.selectedIndex = 0; parent.append(select); return select;
  };
  const source = makeSelect(), controller = createSelectPickers(document);
  const button = select => select.parentNode.children[select.parentNode.children.indexOf(select) + 1];
  const popup = () => document.querySelectorAll('.app-select-popup').find(node => !node.hidden) ?? document.querySelector('.app-select-popup');
  const emit = (target, type, fields = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, fields); target.dispatchEvent(event); return event;
  };
  return { document, window, source, controller, makeSelect, makeOption, button, popup, emit,
    key: (key, fields = {}, select = source) => emit(button(select), 'keydown', { key, ...fields }),
    click: (select = source) => emit(button(select), 'click'),
    row: index => popup().children.find(node => node.dataset.index === String(index)),
    mutate: (target, properties = {}) => observers[0].callback([{ target, type: 'attributes', attributeName: 'disabled', ...properties }]), observers };
}

test('the themed control keeps form values and immediate programmatic updates authoritative', () => {
  const f = fixture(), trigger = f.button(f.source);
  assert.equal(trigger.getAttribute('role'), 'combobox');
  assert.equal(trigger.getAttribute('aria-label'), 'Mode: Auto');
  assert.equal(f.source.getAttribute('aria-hidden'), 'true');
  f.source.value = 'b'; assert.equal(trigger.textContent, 'Boost⌄');
  f.source.selectedIndex = 2; assert.equal(trigger.textContent, 'Cool⌄');
  f.source.disabled = true; assert.equal(trigger.disabled, true); f.click(); assert.equal(f.popup(), null);
  f.source.disabled = false; f.source.hidden = true; assert.equal(trigger.hidden, true);
  f.source.hidden = false; f.source.focus(); assert.equal(f.document.activeElement, trigger);
});

test('keyboard browsing and dismissal do not commit; Enter commits one input/change pair', () => {
  const f = fixture(), changes = [];
  for (const type of ['input', 'change']) f.source.addEventListener(type, () => changes.push(type));
  f.key('ArrowDown'); assert.equal(f.row(0).dataset.active, 'true');
  f.key('ArrowDown'); assert.equal(f.row(1).dataset.active, 'true'); assert.equal(f.source.value, 'a');
  f.key('Escape'); assert.equal(f.popup().hidden, true); assert.equal(f.source.value, 'a');
  f.key('End'); assert.equal(f.row(2).dataset.active, 'true'); f.key('Enter');
  assert.equal(f.source.value, 'c'); assert.deepEqual(changes, ['input', 'change']);
  assert.equal(f.popup().hidden, true); assert.equal(f.document.activeElement, f.button(f.source));
  f.click(); f.emit(f.row(2), 'click'); assert.deepEqual(changes, ['input', 'change']);
});

test('typeahead, disabled options, pointer choice and focus transfer use current source options', () => {
  const f = fixture(), editor = f.document.createElement('input'); f.document.body.append(editor);
  f.source.options[1].disabled = true;
  f.key('ArrowDown'); f.key('ArrowDown'); assert.equal(f.row(2).dataset.active, 'true');
  f.emit(f.row(1), 'click'); assert.equal(f.source.value, 'a');
  f.key('Home'); f.key('c'); assert.equal(f.row(2).dataset.active, 'true');
  let pointer = false;
  f.source.addEventListener('pointerdown', () => { pointer = true; });
  f.source.addEventListener('change', () => { if (pointer) editor.focus(); });
  f.emit(f.row(2), 'click'); assert.equal(f.source.value, 'c'); assert.equal(f.document.activeElement, editor);
});

test('outside interaction, Tab, disabled fields and closed owners dismiss without changes', () => {
  const f = fixture();
  for (const action of [() => f.emit(f.document.body, 'pointerdown'), () => f.document.body.focus(), () => f.key('Tab'),
    () => { f.source.disabled = true; }, () => { f.source.parentNode.hidden = true; f.mutate(f.source.parentNode, { attributeName: 'hidden' }); }]) {
    f.source.disabled = false; f.source.parentNode.hidden = false; f.click();
    assert.equal(f.popup().hidden, false); action();
    assert.equal(f.popup().hidden, true); assert.equal(f.source.value, 'a');
  }
});

test('new controls, replaced options, reset and removal synchronize without stale popups', async () => {
  const f = fixture(), added = f.makeSelect();
  f.mutate(f.document.body, { type: 'childList', addedNodes: [added], removedNodes: [] });
  assert.equal(f.button(added).getAttribute('role'), 'combobox');
  f.click(added); added.replaceChildren(f.makeOption('new', 'New mode', { selected: true }));
  f.mutate(added, { type: 'childList', addedNodes: added.children, removedNodes: [] });
  assert.equal(f.button(added).textContent, 'New mode⌄'); assert.equal(f.row(0).textContent, 'New mode');
  f.source.options[0].selected = false; f.source.options[2].selected = true;
  f.emit(f.document.body, 'reset'); await Promise.resolve(); assert.equal(f.button(f.source).textContent, 'Cool⌄');
  const trigger = f.button(added), popup = f.popup(); added.remove();
  f.mutate(f.document.body, { type: 'childList', addedNodes: [], removedNodes: [added] });
  assert.equal(trigger.isConnected, false); assert.equal(popup.isConnected, false);
});

test('required validation focuses the application control and clears its error after selection', () => {
  const f = fixture(); f.source.required = true; f.source.value = '';
  const invalid = f.emit(f.source, 'invalid');
  assert.equal(invalid.defaultPrevented, true); assert.equal(f.document.activeElement, f.button(f.source));
  assert.equal(f.button(f.source).getAttribute('aria-invalid'), 'true');
  assert.equal(f.document.querySelector('.app-select-error').textContent, 'Please select an item in the list.');
  f.click(); f.emit(f.row(1), 'click');
  assert.equal(f.source.value, 'b'); assert.equal(f.button(f.source).getAttribute('aria-invalid'), null);
  assert.equal(f.document.querySelector('.app-select-error').hidden, true);
});

test('modal and fullscreen owners contain popups and bounded positioning fits small screens', () => {
  const f = fixture(), dialog = f.document.createElement('dialog'); dialog.open = true; f.document.body.append(dialog);
  const modal = f.makeSelect(dialog); f.controller.refresh(); f.click(modal);
  assert.equal(f.popup().parentNode, dialog);
  f.emit(dialog, 'close'); assert.equal(f.popup().hidden, true);
  f.document.fullscreenElement = f.document.body;
  f.window.innerWidth = 240; f.window.innerHeight = 200;
  f.button(f.source).bounds = { left: 190, top: 165, bottom: 195, width: 100, height: 30 }; f.click();
  assert.equal(f.popup().parentNode, f.document.body);
  assert.equal(f.popup().style.left, '32px'); assert.ok(Number.parseFloat(f.popup().style.top) >= 8);
  f.emit(f.document, 'fullscreenchange'); assert.equal(f.popup().hidden, true);
});

test('closing restores source focus methods and attributes and removes listeners', () => {
  const f = fixture(), trigger = f.button(f.source); f.click(); f.controller.close();
  assert.equal(trigger.isConnected, false); assert.equal(f.popup(), null);
  assert.equal(f.source.getAttribute('aria-hidden'), null); assert.equal(f.source.className, '');
  assert.equal(Object.hasOwn(f.source, 'value'), false); assert.equal(Object.hasOwn(f.source, 'focus'), false);
  assert.equal(f.observers[0].disconnected, true); assert.equal(f.document.listeners.length, 0);
});


test('the application listbox works without browser Popover support', () => {
  const f = fixture({ popovers: false }); f.click();
  assert.equal(f.popup().hidden, false); assert.equal(f.popup().getAttribute('popover'), null);
  f.key('End'); f.key('Enter'); assert.equal(f.source.value, 'c'); assert.equal(f.popup().hidden, true);
  f.controller.close();
});

test('disabled fieldsets and hidden option groups preserve native availability', () => {
  const f = fixture(), fieldset = f.document.createElement('fieldset'), group = f.document.createElement('optgroup');
  f.document.body.append(fieldset); const select = f.makeSelect(fieldset);
  group.label = 'Unavailable modes'; group.disabled = true;
  group.append(f.makeOption('d', 'Dry')); select.append(group); f.controller.refresh(); f.click(select);
  assert.equal(f.row(3).getAttribute('aria-disabled'), 'true'); f.emit(f.row(3), 'click'); assert.equal(select.value, 'a');
  fieldset.disabled = true; f.mutate(fieldset); assert.equal(f.button(select).disabled, true); assert.equal(f.popup().hidden, true);
  fieldset.disabled = false; group.hidden = true; f.mutate(fieldset); f.click(select);
  assert.equal(f.row(3), undefined); assert.equal(f.button(select).disabled, false);
});
