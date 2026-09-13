import test from 'node:test';
import assert from 'node:assert/strict';
import { setStatusDetail } from '../chart/status-details.js';

function fixture({ native = true, failPopover = false, width = 390, height = 640 } = {}) {
  const frames = [];
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(listener);
    }
    dispatch(name, options = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
      for (const listener of this.listeners.get(name) ?? []) listener(event);
      return event;
    }
  }
  const document = new Events();
  const window = new Events();
  Object.assign(window, { innerWidth: width, innerHeight: height, requestAnimationFrame: callback => frames.push(callback) });
  class Element extends Events {
    constructor(tagName) {
      super();
      Object.assign(this, { tagName, ownerDocument: document, children: [], style: {}, attributes: {},
        className: '', parentNode: null, scrollTop: 0, hidden: false, ownText: '',
        rect: { left: 30, top: 80, right: 110, bottom: 104, width: 80, height: 24 } });
      if (native) {
        this.showPopover = () => {
          if (failPopover) throw new Error('Synthetic unsupported popover');
          this.popoverOpen = true;
          this.showCount = (this.showCount ?? 0) + 1;
        };
        this.hidePopover = () => { this.popoverOpen = false; this.dispatch('toggle', { newState: 'closed' }); };
      }
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
    append(...children) {
      for (const child of children) {
        child.remove();
        child.parentNode = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.ownText = '';
      this.append(...children);
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelector(selector) {
      for (const child of this.children) {
        const matches = selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.id === selector.slice(1);
        if (matches) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    matches(selector) { return selector === ':popover-open' && this.popoverOpen === true; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() {
      if (this.id !== 'status-detail-popover') return this.rect;
      const left = Number.parseFloat(this.style.left) || 0, top = Number.parseFloat(this.style.top) || 0;
      const width = Number.parseFloat(this.style.width) || 352;
      const height = Math.min(200, Number.parseFloat(this.style.maxHeight) || 288);
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
  }
  document.createElement = tag => new Element(tag);
  document.defaultView = window;
  document.body = new Element('body');
  document.documentElement = { clientWidth: width, clientHeight: height };
  const root = document.createElement('strong');
  document.body.append(root);
  return { document, window, root, flushFrames: () => { while (frames.length) frames.shift()(); },
    popup: () => document.body.querySelector('#status-detail-popover') };
}

const unavailable = { label: 'Unavailable', title: 'Indoor average', detail: 'Waiting for a current reading.', key: 'indoor-average' };

test('status updates retain a native button and safely render text with accessible explanation controls', () => {
  const { root, popup } = fixture();
  const trigger = setStatusDetail(root, unavailable);
  assert.equal(trigger.tagName, 'button');
  assert.equal(trigger.type, 'button', 'native buttons support Enter, Space, click and tap');
  assert.equal(root.textContent, 'Unavailable');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-controls'), popup().id);
  assert.equal(popup().getAttribute('role'), 'dialog');
  assert.equal(popup().getAttribute('aria-labelledby'), popup().querySelector('.status-detail-heading').id);
  assert.equal(popup().hidden, true);
  assert.equal(setStatusDetail(root, { ...unavailable, label: '<b>Stale</b>' }), trigger);
  assert.equal(root.textContent, '<b>Stale</b>');
  assert.equal(trigger.children.length, 1);
  assert.equal(trigger.querySelector('.status-detail-label').children.length, 0, 'labels never become markup');
  trigger.dispatch('click');
  assert.equal(popup().hidden, false);
  assert.equal(popup().popoverOpen, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});

test('polling refreshes the open explanation without remounting, stealing focus or resetting scroll', () => {
  const { document, root, popup } = fixture();
  const trigger = setStatusDetail(root, unavailable);
  trigger.dispatch('click');
  const panel = popup(), close = panel.querySelector('.status-detail-close');
  panel.scrollTop = 56;
  panel.querySelector('.status-detail-body').scrollTop = 18;
  assert.equal(document.activeElement, close);
  assert.equal(setStatusDetail(root, { ...unavailable, detail: '<script>synthetic</script> Updated reason.' }), trigger);
  assert.equal(panel.querySelector('.status-detail-body').textContent, '<script>synthetic</script> Updated reason.');
  assert.equal(panel.querySelector('.status-detail-body').children.length, 0);
  assert.equal(panel.scrollTop, 56);
  assert.equal(panel.querySelector('.status-detail-body').scrollTop, 18);
  assert.equal(document.activeElement, close);
  assert.equal(panel.showCount, 1);
});

test('a stable key transfers an open explanation to a rerendered row and Escape returns focus there', () => {
  const { document, root, popup, flushFrames } = fixture();
  const previous = setStatusDetail(root, unavailable);
  previous.dispatch('click');
  root.remove();
  const replacement = document.createElement('span');
  const trigger = setStatusDetail(replacement, { ...unavailable, title: 'Updated indoor average', detail: 'A sensor is reconnecting.' });
  trigger.rect = { left: 160, right: 220, top: 370, bottom: 394, width: 60, height: 24 };
  document.body.append(replacement);
  flushFrames();
  assert.equal(popup().hidden, false);
  assert.equal(popup().showCount, 1);
  assert.equal(previous.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(popup().querySelector('.status-detail-heading').textContent, 'Updated indoor average');
  assert.equal(popup().style.top, '402px');
  const escape = document.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(popup().hidden, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);
});

test('one popup serves every status and supports close, outside dismissal and internal scrolling', () => {
  const { document, root, popup } = fixture();
  const trigger = setStatusDetail(root, unavailable);
  const other = document.createElement('div');
  document.body.append(other);
  const second = setStatusDetail(other, { ...unavailable, title: 'Outdoor temperature', key: 'outdoor' });
  assert.equal(document.body.children.filter(child => child.id === 'status-detail-popover').length, 1);
  trigger.dispatch('click');
  popup().querySelector('.status-detail-close').dispatch('click');
  assert.equal(document.activeElement, trigger);
  trigger.dispatch('click');
  popup().scrollTop = 48;
  document.dispatch('pointerdown', { target: second });
  second.focus();
  assert.equal(popup().hidden, true);
  assert.equal(document.activeElement, second, 'outside dismissal does not restore the previous trigger');
  second.dispatch('click');
  assert.equal(popup().querySelector('.status-detail-heading').textContent, 'Outdoor temperature');
  assert.equal(popup().scrollTop, 0, 'a newly opened explanation starts at the beginning');
  document.dispatch('scroll', { target: popup().querySelector('.status-detail-body') });
  assert.equal(popup().hidden, false, 'the explanation itself can scroll');
  document.dispatch('scroll');
  assert.equal(popup().hidden, true, 'page movement dismisses the explanation');
});

test('small viewports constrain the popup and resizing repositions it above a low anchor', () => {
  const { root, popup, window } = fixture({ width: 320, height: 480 });
  const trigger = setStatusDetail(root, unavailable);
  trigger.rect = { left: 250, right: 315, top: 420, bottom: 448, width: 65, height: 28 };
  trigger.dispatch('click');
  assert.equal(popup().style.width, '296px');
  assert.equal(popup().style.left, '12px');
  assert.equal(popup().style.top, '212px');
  window.innerWidth = 240;
  window.innerHeight = 180;
  window.dispatch('resize');
  const bounds = popup().getBoundingClientRect();
  assert.equal(popup().style.maxHeight, '156px');
  assert(bounds.left >= 12 && bounds.right <= 228);
  assert(bounds.top >= 12 && bounds.bottom <= 168);
});

test('unsupported or failing native popovers retain disclosure and dismissal behavior', () => {
  for (const options of [{ native: false }, { failPopover: true }]) {
    const { root, popup, document } = fixture(options);
    const trigger = setStatusDetail(root, unavailable);
    trigger.dispatch('click');
    assert.equal(popup().hidden, false);
    if (options.failPopover) assert.equal(popup().getAttribute('popover'), null);
    document.dispatch('keydown', { key: 'Escape' });
    assert.equal(popup().hidden, true);
    assert.equal(document.activeElement, trigger);
  }
});

test('browser dismissal clears expanded state and missing explanations become plain labels', () => {
  const { root, popup } = fixture();
  const trigger = setStatusDetail(root, unavailable);
  trigger.dispatch('click');
  popup().hidePopover();
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(popup().hidden, true);
  trigger.dispatch('click');
  assert.equal(setStatusDetail(root, { ...unavailable, label: '20.4 °C', detail: '' }), null);
  assert.equal(root.textContent, '20.4 °C');
  assert.equal(root.children.length, 0);
  assert.equal(popup().hidden, true);
});
