import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { merossMessage, validMerossMessage } from '../src/acquisition/meross.js';

const START = Date.parse('2026-10-30T10:00:00Z');
const uuid = '0123456789abcdef0123456789abcdef', key = 'abcdef0123456789abcdef0123456789';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, onRequest = () => {}) {
  const store = new Store(':memory:'), sent = []; let now = START, authority = true, capture;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reply = request => {
    const frame = merossMessage(key, `/appliance/${uuid}/publish`, 'GETACK', { state: [{ channel: 1, open: 0 }] }, now);
    frame.header.messageId = request.header.messageId;
    frame.header.sign = createHash('md5').update(frame.header.messageId + key + frame.header.timestamp).digest('hex');
    capture.receiveDoors(request.header.from, JSON.stringify(frame), {}, now, 'primary');
  };
  capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest() {} },
    settings: equipmentConfiguration({ devices: [{ id: 'fixture_door', area: 'garage', kind: 'door',
      connection: `mqtt:/appliance/${uuid}/publish`, meross: { uuid, key, channel: 1 } }] }),
    canControl: () => authority, monotonicClock: () => now - START, readbackTimeoutMs: 10000,
    publish: (topic, body, options) => {
      options.beforePublish?.(); assert.notEqual(options.beforeWrite?.(), false);
      const frame = JSON.parse(body); sent.push({ topic, frame, options });
      return onRequest(frame, sent.length, reply);
    } });
  t.after(async () => { capture.close(); await store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics); await flush();
  return { capture, sent, reply, status: () => capture.status().devices[0],
    authority(value) { authority = value; },
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await flush(); } };
}

test('one missed native state request gets a new signed read-only request before the original deadline', async t => {
  const f = await fixture(t, (request, count, reply) => { if (count === 2) reply(request); });
  assert.equal(f.sent.length, 1); assert.equal(f.status().available, false);
  await f.advance(1999); assert.equal(f.sent.length, 1);
  await f.advance(1); assert.equal(f.sent.length, 2); assert.equal(f.status().available, true);
  assert.equal(f.status().check.status, 'available');
  assert.notEqual(f.sent[0].frame.header.messageId, f.sent[1].frame.header.messageId);
  assert(f.sent.every(p => p.frame.header.method === 'GET' && p.options.qos === 0
    && p.options.retain === false && validMerossMessage(p.frame, key)));
  await f.advance(30000); assert.equal(f.sent.length, 2, 'A completed check owns no retry timer');
});

test('continued native query loss neither repeats indefinitely nor extends the original timeout', async t => {
  const f = await fixture(t);
  await f.advance(2000); assert.equal(f.sent.length, 2);
  await f.advance(7999); assert.equal(f.status().check.checking, true);
  await f.advance(1); assert.equal(f.status().check.status, 'timeout'); assert.equal(f.status().available, false);
  await f.advance(30000); assert.equal(f.sent.length, 2);
});

test('a delayed first reply remains correlated after the bounded retry starts', async t => {
  const f = await fixture(t); await f.advance(2000);
  assert.equal(f.sent.length, 2); f.reply(f.sent[0].frame); await flush();
  assert.equal(f.status().available, true); assert.equal(f.status().check.status, 'available');
  f.capture.setConnected(false); f.reply(f.sent[1].frame);
  assert.equal(f.status().available, false, 'A later reply cannot survive connection invalidation');
});

test('native query retry is cancelled by disconnect, shutdown and control-authority loss', async t => {
  for (const reason of ['disconnect', 'shutdown', 'authority']) await t.test(reason, async t => {
    const f = await fixture(t); await f.advance(1000);
    if (reason === 'disconnect') f.capture.setConnected(false);
    if (reason === 'shutdown') f.capture.close();
    if (reason === 'authority') f.authority(false);
    await f.advance(2000); assert.equal(f.sent.length, 1);
  });
});

test('a delayed initial publication cannot schedule a retry after its original timeout', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => pending);
  await f.advance(9000); release(); await flush();
  await f.advance(1000); assert.equal(f.status().check.status, 'timeout');
  await f.advance(2000); assert.equal(f.sent.length, 1);
});
