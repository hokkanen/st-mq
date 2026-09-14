import test from 'node:test';
import assert from 'node:assert/strict';
import { createEquipmentActions, equipmentCoverAllowed, equipmentCoverResult, equipmentReadingRows } from '../chart/equipment.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const door = (id = 'door1') => ({ id, label: 'Door 1', kind: 'door', available: true,
  controls: { cover: { open: true, close: true, stop: false } }, cover: { available: true, state: 'open', operation: null },
  readings: { door_open: { value: 1, unit: 'state', observedAt: now, stale: false } } });
const status = (device = door()) => ({ role: 'primary', now, equipment: { devices: [device] } });

test('fresh reported movement is prominent while binary contact values and stable state semantics remain unchanged', () => {
  const device = door(), reading = device.readings.door_open;
  for (const [coverState, label] of [['opening', 'Opening'], ['closing', 'Closing']]) {
    reading.coverState = coverState;
    const before = structuredClone(device), row = equipmentReadingRows(device)[0];
    assert.equal(row.value, label);
    assert.match(row.detail, new RegExp(`Reported ${coverState}`));
    assert.deepEqual(device, before, 'Rendering does not rewrite the contact or create an operation');
    assert.equal(device.cover.operation, null, 'Movement can be reported without a local request');
  }
  reading.coverState = 'closed';
  assert.equal(equipmentReadingRows(device)[0].value, 'Open', 'Stable readings preserve the independent contact value');
  reading.value = 0;
  assert.equal(equipmentReadingRows(device)[0].value, 'Closed');
  reading.coverState = 'opening'; reading.stale = true; device.available = false;
  const stale = equipmentReadingRows(device)[0];
  assert.equal(stale.value, 'Unknown'); assert.equal(stale.stale, true);
  assert.doesNotMatch(stale.detail, /opening/i);
  reading.stale = false; device.available = true; reading.value = null;
  assert.equal(equipmentReadingRows(device)[0].value, 'Unknown', 'A movement field does not make an invalid contact usable');
});

test('cover controls use advertised capability and authority without treating a released contact as fully open', () => {
  const device = door(), current = status(device);
  assert.equal(equipmentCoverAllowed(current, device, 'open'), true);
  assert.equal(equipmentCoverAllowed(current, device, 'close'), true);
  assert.equal(equipmentCoverAllowed(current, device, 'stop'), false);
  for (const action of ['toggle', 'OPEN', null]) assert.equal(equipmentCoverAllowed(current, device, action), false);
  for (const update of [{ role: 'replica' }, { role: 'transition' }, { controlAuthority: { state: 'protected' } },
    { pairing: { enabled: true, role: 'primary', canControl: false } }])
    assert.equal(equipmentCoverAllowed({ ...current, ...update }, device, 'open'), false);
  for (const update of [{ enabled: false }, { kind: 'switch' }, { cover: { available: false } }, { cover: null }])
    assert.equal(equipmentCoverAllowed(current, { ...device, ...update }, 'open'), false);
  assert.equal(equipmentCoverAllowed(current, device, 'open', true), false);
});

test('cover requests serialize delivery, retain contact state, and permit Stop while movement is unconfirmed', async () => {
  let finish; const calls = [], device = door();
  device.controls.cover.stop = true;
  device.readings.door_open.value = 0;
  device.cover.state = 'closed';
  const actions = createEquipmentActions({ request: (path, body) => {
    calls.push({ path, body }); return new Promise(resolve => { finish = resolve; });
  } });
  actions.update(status(device));
  assert.equal(await actions.cover('missing', 'open'), false);
  const pending = actions.cover('door1', 'open');
  assert.equal(await actions.cover('door1', 'open'), false);
  assert.equal(await actions.recheck(), false);
  assert.equal(actions.snapshot().actionKind, 'cover');
  assert.equal(actions.snapshot().actionDeviceId, 'door1');
  const acknowledged = status({ ...device, cover: { available: true, state: 'closed',
    operation: { action: 'open', status: 'published', requestedAt: now } } });
  finish(acknowledged); assert.equal(await pending, true);
  assert.equal(equipmentReadingRows(actions.snapshot().status.equipment.devices[0])[0].value, 'Closed');
  assert.match(equipmentCoverResult(acknowledged.equipment.devices[0]), /position unconfirmed/);
  const stopping = actions.cover('door1', 'stop');
  assert.deepEqual(calls, [
    { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'open' } },
    { path: '/api/equipment/cover', body: { deviceId: 'door1', action: 'stop' } },
  ]);
  finish(status({ ...device, cover: { available: true, operation: { action: 'stop', status: 'published' } } }));
  await stopping;
  assert.match(equipmentCoverResult(actions.snapshot().status.equipment.devices[0]), /stopping unconfirmed/);
});

test('failed cover requests keep monitoring intact and expose no private transport details', async () => {
  const current = status(), actions = createEquipmentActions({ request: async () => { throw new Error('private-broker-detail'); } });
  actions.update(current);
  assert.equal(await actions.cover('door1', 'close'), false);
  assert.equal(actions.snapshot().status, current);
  assert.equal(actions.snapshot().busy, false);
  assert.equal(actions.snapshot().error, true);
  assert.doesNotMatch(actions.snapshot().message, /private-broker-detail/);
  assert.match(equipmentCoverResult({ cover: { operation: { action: 'close', status: 'unconfirmed' } } }), /no new position report/);
  assert.equal(equipmentCoverResult(door('door2')), '', 'One door does not inherit another door’s request result');
});
