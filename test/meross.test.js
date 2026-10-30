import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { merossMessage, validMerossMessage } from '../src/acquisition/meross.js';
import { mqttRouting } from '../src/acquisition/mqtt-routing.js';
const uuid = '0123456789abcdef0123456789abcdef', key = 'abcdef0123456789abcdef0123456789';
const door = channel => ({ id: `door${channel}`, area: 'garage', kind: 'door',
  connection: `mqtt:/appliance/${uuid}/publish`, cover_control: true, meross: { uuid, key, channel } });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let now = Date.parse('2026-10-30T10:00:00Z'), authority = true;
  const store = new Store(':memory:'), sent = [], ingested = [];
  const settings = equipmentConfiguration({ devices: [door(1), door(2)] });
  const capture = createEquipmentCapture({ store, settings, engine: { clock: () => now, ingest: row => ingested.push(row) },
    canControl: () => authority, publish: async (topic, body, options) => {
      options.beforePublish?.(); assert.notEqual(options.beforeWrite?.(), false);
      sent.push({ topic, body: JSON.parse(body), options });
    } });
  t.after(() => { capture.close(); store.close(); });
  const reply = (channel, open = 0, { method = 'GETACK', retain = false, badKey = false, execute = 0 } = {}) => {
    const request = sent.findLast(x => x.body.header.method === 'GET' && x.body.payload.state[0].channel === channel);
    const m = merossMessage(badKey ? '0'.repeat(32) : key, `/appliance/${uuid}/publish`, method,
      { state: [{ channel, open, execute }] }, now);
    if (method === 'GETACK' && request) {
      m.header.messageId = request.body.header.messageId;
      m.header.sign = createHash('md5').update(`${m.header.messageId}${badKey ? '0'.repeat(32) : key}${m.header.timestamp}`).digest('hex');
    }
    capture.receiveDoors(request?.body.header.from ?? capture.topics[0], JSON.stringify(m), { retain }, now, 'primary');
    return m;
  };
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  return { capture, sent, reply, ingested, advance: ms => now += ms, authority: value => authority = value };
}
test('Meross config enforces exact native identity, channel, finite age and no generic mapping', () => {
  for (const patch of [{ meross: { uuid, key, channel: 0 } }, { meross: { uuid, key } }, { max_age_seconds: 0 },
    { mqtt: {} }, { connection: 'mqtt:other' }, { kind: 'switch' }])
    assert.throws(() => equipmentConfiguration({ devices: [{ ...door(1), ...patch }] }));
  assert.throws(() => equipmentConfiguration({ devices: [door(1), { ...door(1), id: 'duplicate' }] }));
  const d = equipmentConfiguration({ devices: [door(3)] }).devices[0];
  assert.equal(mqttRouting({ connections: { mqtt: { address: 'mqtt://local', ha: { address: 'mqtt://ha' } } } }).equipmentBroker(d), 'primary');
});
test('signed queries recover both channels independently; commands retain no-replay guards and broker receipts', async t => {
  const f = fixture(t); await settle();
  assert.equal(f.sent.length, 2);
  for (const row of f.sent) assert.ok(validMerossMessage(row.body, key));
  f.reply(1); f.reply(2); await settle();
  assert.ok(f.capture.status().devices.every(d => d.available));
  const receipt = await f.capture.setCover({ deviceId: 'door1', action: 'open' });
  const command = f.sent.at(-1);
  assert.deepEqual(command.body.payload, { state: { channel: 1, open: 1 } });
  assert.equal(command.options.noReplay, true); assert.equal(command.options.retain, false);
  assert.equal(receipt.confirmed, false);
  f.reply(1, 1, { method: 'SETACK', execute: 1 });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 0);
  f.advance(1000); f.reply(1, 1, { method: 'PUSH' });
  assert.equal(f.capture.status().devices[0].readings.door1_open.value, 1);
  f.authority(false);
  await assert.rejects(f.capture.setCover({ deviceId: 'door2', action: 'open' }));
});
test('retained, bad signatures, unmatched acknowledgements and stale reports grant no control; reconnect requires fresh reports', async t => {
  const f = fixture(t); await settle();
  f.reply(1, 0, { retain: true }); f.reply(2, 0, { badKey: true });
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.reply(1); f.reply(2); await settle();
  f.capture.setConnected(false); f.capture.setConnected(true);
  assert.ok(f.capture.status().devices.every(d => !d.available));
  f.capture.confirmSubscriptions(f.capture.topics); await settle(); f.reply(1); f.reply(2); await settle();
  f.advance(91_000); f.capture.tickDoors();
  assert.ok(f.capture.status().devices.every(d => !d.available));
});

test('Home Assistant empty nested Meross sections preserve generic equipment contracts', () => {
  const d = { id: 'contact', kind: 'door', connection: 'mqtt:invented/contact' };
  assert.deepEqual(equipmentConfiguration({ devices: [d] }), equipmentConfiguration({ devices: [{ ...d, meross: {} }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ ...d, meross: { retired: true } }] }));
});
