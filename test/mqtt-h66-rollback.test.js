import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';

const START = Date.parse('2026-09-07T12:00:00Z'), DEVICE = 'synthetic-h66';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const store = new Store(':memory:'), client = new EventEmitter(); let now = START;
  client.subscribe = (_topic, _options, done) => done();
  client.publish = (_topic, _payload, _options, done) => done();
  client.end = (_force, _options, done) => done();
  const config = { input: 'mqtt', deviceId: DEVICE, settings: { mode: 'shadow' },
    h66: { writeEnabled: true, readbackTimeoutMs: 1000 }, garage: { enabled: false },
    connections: { mqtt: { address: 'mqtt://synthetic.invalid' }, equipment: equipmentConfiguration({ devices: [] }) } };
  const engine = new Engine({ store, config, clock: () => now });
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  client.emit('connect');
  t.after(async () => { await reader.close({ restore: false }); await engine.garage.close({ restore: false });
    await engine.charging.close(); await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  return { engine, store, reader, at: at => { now = at; },
    send: (register, value, packet = {}) => client.emit('message', `${DEVICE}/HP/${register}`, Buffer.from(String(value)), packet) };
}
function failCommit(store) {
  const transaction = store.transaction.bind(store); let armed = true;
  store.transaction = action => armed ? transaction(() => { armed = false; action(); throw new Error('synthetic commit failure'); }) : transaction(action);
}

test('failed H66 delivery rewinds durable rows, held state, compressor transition and duplicate admission', async t => {
  const f = await fixture(t); f.send('1A01', 0, { qos: 1, messageId: 10 });
  const before = f.engine.ingestionCheckpoint(), count = f.store.observations().length;
  f.at(START + 1000); failCommit(f.store);
  const packet = { qos: 1, messageId: 11, dup: true };
  f.send('1A01', 1, packet);
  assert.deepEqual(f.engine.ingestionCheckpoint(), before);
  assert.equal(f.store.observations().length, count);
  assert.deepEqual(f.reader.h66.status().compressorState, { value: 0, since: START, transitionObserved: false });
  f.send('1A01', 1, packet);
  assert.deepEqual(f.reader.h66.status().compressorState, { value: 1, since: START + 1000, transitionObserved: true });
  assert.equal(f.engine.latest.compressor_active.value, 1);
  const acceptedAt = f.reader.h66.status().readings['1A01'].receivedAt;
  f.at(START + 2000); f.send('1A01', 1, packet);
  assert.equal(f.reader.h66.status().readings['1A01'].receivedAt, acceptedAt, 'successful duplicate cannot refresh evidence');
});

test('H66 readback confirms only after durable commit and rollback retains physical obligation identity', async t => {
  const f = await fixture(t);
  f.send('0203', 20, { qos: 1, messageId: 20 });
  f.at(START + 1000);
  const pending = f.reader.h66.setSetting({ register: '0203', value: 21 }); let confirmed = false;
  pending.then(() => { confirmed = true; }); await flush();
  const before = f.reader.h66.ingestionCheckpoint(), packet = { qos: 1, messageId: 21, dup: true };
  failCommit(f.store); f.send('0203', 21, packet); await flush();
  assert.equal(confirmed, false);
  assert.equal(f.reader.h66.status().readings['0203'].value, 20);
  assert.equal(f.reader.h66.ingestionCheckpoint().state.obligations['0203'], before.state.obligations['0203']);
  f.send('0203', 21, packet); await pending;
  assert.equal(confirmed, true);
  assert.equal(f.reader.h66.status().readings['0203'].value, 21);
  const committed = f.reader.h66.ingestionCheckpoint(), saved = f.store.getState(`h66:control:${DEVICE}`);
  f.at(START + 2000); failCommit(f.store); const external = { qos: 1, messageId: 22, dup: true };
  f.send('0203', 22, external);
  assert.equal(f.reader.h66.ingestionCheckpoint().state.obligations['0203'], committed.state.obligations['0203']);
  assert.deepEqual(f.store.getState(`h66:control:${DEVICE}`), saved);
  assert.equal(f.reader.h66.status().readings['0203'].value, 21);
  f.send('0203', 22, external);
  assert.equal(f.reader.h66.status().readings['0203'].value, 22);
  assert.equal(f.reader.h66.status().obligations['0203'], undefined, 'committed external change preserves the owner setting');
});
