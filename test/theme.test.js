import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../chart/theme.js', import.meta.url), 'utf8');

function browser({ preference = null, denyStorage = false, ready = false } = {}) {
  const documentListeners = new Map(), windowListeners = new Map(), buttonListeners = new Map();
  const changes = [], saved = new Map();
  const root = { dataset: {} }, meta = {};
  const button = { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { const handlers = buttonListeners.get(name) ?? []; handlers.push(listener); buttonListeners.set(name, handlers); } };
  const document = { documentElement: root, readyState: ready ? 'complete' : 'loading',
    querySelector: () => meta, getElementById: () => button,
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    dispatchEvent: event => changes.push(event) };
  const window = { addEventListener: (name, listener) => windowListeners.set(name, listener) };
  const localStorage = {
    getItem() { if (denyStorage) throw new Error('Denied'); return preference; },
    setItem(key, value) { if (denyStorage) throw new Error('Denied'); saved.set(key, value); },
  };
  runInNewContext(script, { document, window, localStorage, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { root, meta, button, theme: window.homeEnergyTheme, changes, saved,
    ready: () => documentListeners.get('DOMContentLoaded')?.(),
    click: () => buttonListeners.get('click')?.forEach(listener => listener()),
    storage: event => windowListeners.get('storage')?.(event) };
}

test('theme is dark before DOM readiness and toggle changes only the current page', () => {
  const page = browser();
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.meta.content, '#101e19');
  page.ready();
  page.theme.initialize(); // Reinitializing must not attach another click handler.
  page.click();
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.theme.current, 'light');
  assert.equal(page.saved.size, 0);
  assert.equal(page.button.textContent, 'Dark theme');
  assert.equal(page.button.attributes['aria-label'], 'Switch to dark theme');
  assert.equal(page.changes.length, 1);
  assert.equal(page.changes[0].type, 'themechange');
  assert.equal(page.changes[0].detail.theme, 'light');
  assert.equal(browser().theme.current, 'dark');
});

test('legacy saved light preference is ignored and every page starts dark', () => {
  const page = browser({ preference: 'light' });
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.meta.content, '#101e19');
  page.ready();
  assert.equal(page.button.textContent, 'Light theme');
  assert.equal(browser({ preference: 'invalid' }).theme.current, 'dark');
  page.theme.setTheme('invalid');
  assert.equal(page.theme.current, 'dark');
  assert.equal(page.changes.length, 0);
});

test('unavailable browser storage does not prevent theme switching', () => {
  const page = browser({ denyStorage: true, ready: true });
  assert.equal(page.theme.current, 'dark');
  page.click();
  assert.equal(page.root.dataset.theme, 'light');
  page.click();
  assert.equal(page.theme.current, 'dark');
});

test('storage changes in other tabs do not override the current page theme', () => {
  const page = browser({ ready: true });
  page.storage({ key: 'unrelated', newValue: 'light' });
  assert.equal(page.theme.current, 'dark');
  page.storage({ key: 'home-energy-theme', newValue: 'light' });
  assert.equal(page.theme.current, 'dark');
  page.click();
  assert.equal(page.theme.current, 'light');
  assert.equal(page.button.textContent, 'Dark theme');
  page.storage({ key: null, newValue: null });
  assert.equal(page.theme.current, 'light');
  assert.equal(page.button.textContent, 'Dark theme');
  assert.equal(page.changes.length, 1);
  assert.equal(page.saved.size, 0);
});
