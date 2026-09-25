import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, createEquipmentPanel, equipmentControlResult, equipmentCoverResult } from '../chart/equipment.js';

const now = Date.parse('2026-09-21T10:00:00Z');
const device = (value = 1, observedAt = now) => ({ id: 'fixture-switch', label: 'Fixture switch', area: 'garage',
  kind: 'switch', available: true, controls: { switch: true },
  readings: { switch_active: { value, unit: 'state', stale: false, observedAt } } });
const receipt = (extra = {}) => ({ deviceId: 'fixture-switch', at: now, confirmedAt: now, on: true,
  confirmed: true, status: 'confirmed', sent: true, ...extra });
const status = (extra = {}) => ({ now, role: 'primary', equipment: { devices: [device()] },
  equipmentControls: { available: true, lastResult: receipt() }, equipmentTests: { available: true }, ...extra });
const door = (operation = {}) => ({ ...device(), id: 'fixture-door', kind: 'door',
  controls: { cover: { open: true, close: true, stop: true } },
  cover: { available: true, operation: { action: 'open', status: 'published', requestedAt: now, ...operation } },
  readings: { door_open: { value: 0, unit: 'state', stale: false, observedAt: now - 1, coverState: 'closed' } } });

function equipmentDocument() {
  class Element {
    constructor(document, tag) {
      this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.hidden = false; this.className = '';
      this.classList = { contains: value => this.className.split(' ').includes(value),
        add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
        toggle: (value, present) => { this.className = this.className.split(' ').filter(name => name !== value).join(' ');
          if (present) this.classList.add(value); } };
    }
    set id(value) { this.attributes.set('id', value); this.ownerDocument.nodes.set(value, this); }
    get id() { return this.attributes.get('id'); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent).join(''); }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, next) { child.remove(); const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, child); child.parentElement = this; }
    remove() { const parent = this.parentElement; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelector(selector) { return descendants(this).find(child => selector.startsWith('.')
      ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase()) ?? null; }
    focus() { this.ownerDocument.activeElement = this; }
  }
  const document = { nodes: new Map(), activeElement: null, addEventListener() {}, querySelectorAll: () => [],
    defaultView: { addEventListener() {} }, createElement(tag) { return new Element(this, tag); },
    createElementNS(namespace, tag) { return this.createElement(tag); },
    getElementById(id) {
      if (!this.nodes.has(id)) { const node = this.createElement('div'); node.id = id; this.body.append(node); }
      return this.nodes.get(id);
    } };
  document.body = document.createElement('body'); return document;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const deviceNode = (document, rootId, id) => document.getElementById(rootId).children.find(node => node.dataset.deviceId === id);

test('switch receipts expire from their original request time and disappear when fresh feedback supersedes them', () => {
  const current = status();
  assert.match(equipmentControlResult(current, device()), /On requested.*device confirmed/);
  assert.equal(equipmentControlResult({ ...current, now: now + 60_000 }, device()), '');
  assert.equal(equipmentControlResult({ ...current, now: now + 2_000 }, device(0, now + 1_000)), '');
  assert.match(equipmentControlResult(current, device(0, now - 1)), /On requested/,
    'A report from before the request does not supersede it');
  assert.equal(equipmentControlResult(current, { ...device(), id: 'another-switch' }), '');
  const stale = device(0, now + 1_000); stale.readings.switch_active.stale = true;
  assert.match(equipmentControlResult({ ...current, now: now + 2_000 }, stale), /On requested/,
    'Unusable readings do not prove a new physical state');
});

test('switch failures remain briefly, pending delivery stays visible, and a newer live state resolves old uncertainty', () => {
  const current = status({ equipmentControls: { available: true,
    lastResult: receipt({ status: 'unconfirmed', confirmed: false, confirmedAt: undefined }) } });
  assert.match(equipmentControlResult(current, device(0, now - 1)), /awaiting device confirmation/);
  assert.equal(equipmentControlResult({ ...current, now: now + 2_000 }, device(1, now + 1_000)), '');
  assert.equal(equipmentControlResult({ ...current, now: now + 60_000 }, device(0, now - 1)), '');
  current.now += 120_000;
  current.equipmentControls.busy = true;
  current.equipmentControls.lastResult.status = 'pending';
  assert.match(equipmentControlResult(current, device()), /On requested/,
    'Actual in-flight delivery is not dismissed by the receipt timeout');
});

test('door completion clears its receipt while recent delivery failures and movement requests stay visible', () => {
  assert.equal(equipmentCoverResult(door({ status: 'observed' }), now), '');
  assert.match(equipmentCoverResult(door(), now), /position unconfirmed/);
  assert.match(equipmentCoverResult(door({ status: 'unconfirmed' }), now), /no new position report/);
  assert.equal(equipmentCoverResult(door({ status: 'unconfirmed' }), now + 60_000), '');
  assert.equal(equipmentCoverResult(door({ action: 'stop' }), now + 60_000), '',
    'Stop has no backend completion event, so its acknowledgement must also expire');
  assert.match(equipmentCoverResult(door({ status: 'publishing' }), now + 120_000), /sending/);
  const stopped = door({ action: 'stop' });
  stopped.readings.door_open.observedAt = now + 1_000;
  assert.equal(equipmentCoverResult(stopped, now + 2_000), '');
});

test('equipment panel never revives a superseded switch receipt on repeated polls or later unusable readings', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const current = status(); panel.update(current);
  const result = deviceNode(document, 'garage-equipment-readings', 'fixture-switch').querySelector('.equipment-control-result');
  assert.equal(result.hidden, false);
  const changed = status({ now: now + 2_000, equipment: { devices: [device(0, now + 1_000)] } });
  panel.update(changed); assert.equal(result.hidden, true);
  changed.equipment.devices[0].readings.switch_active.stale = true;
  panel.update(changed); assert.equal(result.hidden, true);
  panel.update({ ...current, now: now + 3_000 }); assert.equal(result.hidden, true);
  const next = status({ now: now + 4_000,
    equipmentControls: { available: true, lastResult: receipt({ at: now + 4_000, confirmedAt: now + 4_000 }) } });
  panel.update(next); assert.equal(result.hidden, false, 'A new request receives its own feedback');
  panel.update({ ...next, now: now + 64_000 }); assert.equal(result.hidden, true);
  panel.update({ ...next, now: now + 65_000 }); assert.equal(result.hidden, true);
});

test('equipment panel clears completed door messages and does not revive old request state', () => {
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => {} });
  const current = status({ equipment: { devices: [door()] } }); panel.update(current);
  const result = deviceNode(document, 'garage-equipment-readings', 'fixture-door')
    .querySelector('.equipment-cover-controls').querySelector('.equipment-control-result');
  assert.equal(result.hidden, false);
  panel.update({ ...current, equipment: { devices: [door({ status: 'observed' })] } });
  assert.equal(result.hidden, true);
  panel.update(current); assert.equal(result.hidden, true);
  panel.update({ ...current, now: now + 1_000,
    equipment: { devices: [door({ action: 'close', requestedAt: now + 1_000 })] } });
  assert.equal(result.hidden, false);
});

test('local equipment action errors expire and authoritative receipts replace generic network errors', async () => {
  const actions = createEquipmentActions({ request: async () => { throw new Error('fixture failure'); } });
  actions.update(status({ equipmentControls: { available: true } }));
  assert.equal(await actions.switch('fixture-switch', false), false);
  assert.equal(actions.snapshot().error, true);
  actions.update(status({ now: now + 30_000, equipmentControls: { available: true } }));
  assert.equal(actions.snapshot().error, true);
  actions.update(status({ now: now + 60_000, equipmentControls: { available: true } }));
  assert.equal(actions.snapshot().error, false);
  assert.equal(actions.snapshot().message, '');
  assert.equal(await actions.switch('fixture-switch', false), false);
  actions.update(status({ now: now + 61_000, equipmentControls: { available: true,
    lastResult: receipt({ on: false, at: now + 60_000, confirmed: false, status: 'unconfirmed' }) } }));
  assert.equal(actions.snapshot().error, false);
  assert.equal(actions.snapshot().message, '');
});

test('recheck acknowledgements expire while active test restoration notices remain present', async () => {
  const current = status({ equipmentTests: { available: true, active: { deviceId: 'fixture-switch', status: 'restoration-pending' } } });
  const document = equipmentDocument(), panel = createEquipmentPanel({ document, request: async () => current });
  panel.update(current); await panel.actions.recheck();
  assert.equal(document.getElementById('equipment-check-message').hidden, false);
  panel.update({ ...current, now: now + 60_000 });
  assert.equal(document.getElementById('equipment-check-message').hidden, true);
  assert.equal(document.getElementById('garage-active-test').hidden, false);
  assert.match(document.getElementById('garage-active-test').textContent, /restoration pending/);
});
