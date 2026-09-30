import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingDiagnosticsPanel } from '../chart/charging-diagnostics.js';

function fixture() {
  const document = { activeElement: null };
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, events: new Map(), className: '', textContent: '', open: false }); }
    append(...children) { for (const node of children) { node.parent = this; this.children.push(node); } }
    replaceChildren(...children) { for (const node of this.children) node.parent = null; this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(name, listener) { this.events.set(name, listener); }
    dispatch(name, event = {}) { return this.events.get(name)?.(event); }
    focus() { document.activeElement = this; }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
    querySelector(selector) { return descendants(this).find(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector.toUpperCase()) ?? null; }
  }
  document.createElement = tag => new Node(tag);
  document.body = document.createElement('body');
  document.getElementById = id => descendants(document.body).find(node => node.id === id) ?? null;
  document.querySelector = selector => selector === 'dialog[open]'
    ? descendants(document.body).find(node => node.tagName === 'DIALOG' && node.open) ?? null
    : document.body.querySelector(selector);
  for (const id of ['charger1', 'charger2']) {
    const summary = document.createElement('summary'); summary.id = `${id}-device-summary`;
    const footer = document.createElement('div'); footer.className = 'charging-disclosure';
    summary.append(footer); document.body.append(summary);
  }
  return document;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const now = Date.parse('2026-09-28T18:00:00Z');
function status() {
  const report = { id: 'current', startedAt: now, endedAt: null, evaluatedAt: now, chargerId: 'charger1',
    behavior: 'expected', outcome: { state: 'in-progress' }, coverage: { initialRelease: { state: 'verified' } }, findings: [],
    timeline: [{ at: now, kind: 'physical', code: 'charging-started' }], plans: [], truncated: { plans: 0, findings: 0, timeline: 0 } };
  return { now, charging: { timezone: 'Europe/Helsinki', chargers: [{ id: 'charger1', label: 'Charger 1' }, { id: 'charger2', label: 'Charger 2' }],
    diagnostics: { version: 1, chargers: [{ id: 'charger1', current: report, recent: [{ ...report, id: 'previous', endedAt: now - 1 }] }] },
    physicalTests: { runs: [{ vehicleId: 'bmw', chargerId: 'charger1', program: 'immediate', phase: 'observing', report: { id: 'current' } }] } } };
}

test('report shortcut preserves focus across refreshes and opens without disclosure or control actions', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  panel.update(state);
  const button = document.getElementById('charger1-session-report'); button.focus();
  panel.update(structuredClone(state));
  assert.equal(document.getElementById('charger1-session-report'), button);
  assert.equal(document.activeElement, button);
  assert.equal(button.textContent, 'Report · Checks passed');
  let prevented = 0, stopped = 0;
  button.dispatch('click', { preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(dialog.open, true); assert.equal(button.getAttribute('aria-expanded'), 'true');
  panel.close();
  assert.equal(dialog.open, false); assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, button);
});

test('opens the requested retained report and does not substitute a different physical session after expiry', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }); panel.update(status());
  panel.open('charger1', 'previous');
  assert.equal(document.getElementById('charging-report-session').value, 'previous');
  panel.close(); panel.open('charger1', 'expired-session');
  const result = document.getElementById('charging-report-dialog').querySelector('.charging-report-result');
  assert.equal(result.children[0].textContent, 'This session report is no longer retained');
  assert.notEqual(document.getElementById('charging-report-session').value, 'current');
});

test('guided assessment link opens the selected vehicle without issuing charger actions', () => {
  const document = fixture(), calls = [], panel = createChargingDiagnosticsPanel({ document, onOpenTest: id => calls.push(id) });
  panel.update(status()); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog'), guided = dialog.querySelector('.charging-report-guided');
  assert.equal(guided.hidden, false);
  guided.children[1].dispatch('click');
  assert.deepEqual(calls, ['bmw']); assert.equal(dialog.open, false);
});

test('current recorded reports show their snapshot scope and incomplete live evidence', () => {
  const document = fixture(), panel = createChargingDiagnosticsPanel({ document }), state = status();
  Object.assign(state.charging.diagnostics.chargers[0].current, { recorded: true, evidenceStale: true });
  panel.update(state); panel.open('charger1');
  const dialog = document.getElementById('charging-report-dialog');
  assert.equal(document.getElementById('charger1-session-report').dataset.state, 'unknown');
  assert(descendants(dialog).some(node => /Recorded master report.*Connected at snapshot/.test(node.textContent)));
  assert.equal(dialog.querySelector('.charging-report-result').children[1].textContent, 'Observation is no longer current');
});
