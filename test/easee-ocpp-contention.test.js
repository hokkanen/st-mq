import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Store } from '../src/storage/store.js';
import { createEaseeOcpp } from '../src/acquisition/easee-ocpp.js';

const initialTime = Date.parse('2026-10-07T12:00:00Z');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-contention-'));
  const path = join(directory, 'fixture.sqlite'), store = new Store(path), competitor = new DatabaseSync(path);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let now = initialTime, authority = true, sequence = 0;
  const clients = [];
  const local = createEaseeOcpp({ config: { host: '127.0.0.1', port, password: 'fixture-ocpp-pass', authorization_tags: ['fixture-tag'] },
    chargerId: 'fixture-charger', clock: () => now, canControl: () => authority,
    state: { get: () => store.getState('fixture:ocpp'), set: value => store.setState('fixture:ocpp', value),
      runWrite: (action, options) => store.runWrite(action, options),
      afterCommit: effect => store.afterCommit(effect), afterRollback: effect => store.afterRollback(effect) } });
  t.after(async () => {
    try { competitor.exec('ROLLBACK'); } catch { /* No active fixture lock. */ }
    for (const client of clients) client.terminate();
    await local.close(); competitor.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await local.start();
  return { local, store, competitor, get now() { return now; }, set now(value) { now = value; },
    revoke() { authority = false; },
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
        headers: { Authorization: `Basic ${Buffer.from('fixture-charger:fixture-ocpp-pass').toString('base64')}` },
      });
      const pending = new Map(), calls = [], replies = [];
      clients.push(ws); ws.on('error', () => {});
      ws.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame[0] === 2) { calls.push(frame); ws.send(JSON.stringify([3, frame[1], { status: 'Accepted' }])); }
        else {
          replies.push(frame);
          if (frame[2]?.transactionId) assert.equal(store.getState('fixture:ocpp').activeId, frame[2].transactionId,
            'A transaction authorization cannot reach the wire before COMMIT.');
          pending.get(frame[1])?.(frame); pending.delete(frame[1]);
        }
      });
      ws.on('close', () => { for (const resolve of pending.values()) resolve(null); pending.clear(); });
      await once(ws, 'open');
      const client = { ws, calls, replies, call(action, payload) {
        return new Promise(resolve => { const id = `fixture-${++sequence}`; pending.set(id, resolve); ws.send(JSON.stringify([2, id, action, payload])); });
      } };
      await client.call('BootNotification', { chargePointVendor: 'Fixture', chargePointModel: 'Fixture' });
      for (let attempt = 0; attempt < 100 && local.status().pendingConfiguration.length; attempt++) await delay(2);
      await delay(5);
      return client;
    },
  };
}

test('OCPP preserves ordered frames and original receipts across a prolonged SQLite writer, with no early authorization', async t => {
  const f = await fixture(t), client = await f.connect();
  f.competitor.exec('BEGIN IMMEDIATE');
  let beats = 0, answered = false;
  const heartbeat = setInterval(() => { beats++; }, 5);
  t.after(() => clearInterval(heartbeat));
  const starting = client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 100,
    timestamp: new Date(f.now).toISOString() }).then(reply => { answered = true; return reply; });
  const status = client.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError',
    timestamp: new Date(f.now).toISOString() });
  await delay(220);
  assert.equal(answered, false); assert.ok(beats >= 5);
  assert.equal(f.store.getState('fixture:ocpp').transactions.length, 0);
  f.now += 800; f.competitor.exec('ROLLBACK');
  assert.equal((await starting)[2].idTagInfo.status, 'Accepted'); await status;
  assert.equal(f.store.getState('fixture:ocpp').transactions[0].startReceivedAt, initialTime);
  assert.equal(f.local.controlSnapshot().receivedAt, initialTime);
});

test('OCPP rechecks native command guards after storage admission and discards a disconnected socket backlog', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError', timestamp: new Date(f.now).toISOString() });
  f.competitor.exec('BEGIN IMMEDIATE');
  let permission = true;
  const request = assert.rejects(f.local.request('GetConfiguration', {}, { guard: () => permission }), { code: 'ocpp-request-revoked' });
  await delay(25); permission = false;
  f.competitor.exec('ROLLBACK'); await request;
  assert.equal(client.calls.filter(frame => frame[2] === 'GetConfiguration').length, 0);
  f.competitor.exec('BEGIN IMMEDIATE');
  const starting = client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 100,
    timestamp: new Date(f.now).toISOString() });
  await delay(25);
  client.ws.terminate(); await once(client.ws, 'close');
  f.competitor.exec('ROLLBACK');
  assert.equal(await starting, null);
  await delay(25);
  assert.equal(client.calls.filter(frame => frame[2] === 'GetConfiguration').length, 0);
  assert.equal(f.store.getState('fixture:ocpp').transactions.length, 0);
  const next = await f.connect();
  assert.equal((await next.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
});

test('OCPP sends no accepted transaction reply when its admitted transaction fails at COMMIT', async t => {
  const f = await fixture(t), client = await f.connect();
  const execute = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && f.store.getState('fixture:ocpp')?.transactions.length)
      throw Object.assign(new Error('Synthetic durable commit failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    return execute(sql);
  };
  const response = await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 100,
    timestamp: new Date(f.now).toISOString() });
  assert.equal(response, null);
  assert.equal(f.store.getState('fixture:ocpp').transactions.length, 0);
  assert.equal(f.local.status().ready, false);
});

test('delayed OCPP authorization cannot make an old frame into fresh charging permission', async t => {
  const f = await fixture(t), client = await f.connect();
  f.competitor.exec('BEGIN IMMEDIATE');
  const authorization = client.call('Authorize', { idTag: 'fixture-tag' });
  await delay(25); f.now += 60_001; f.competitor.exec('ROLLBACK');
  assert.equal((await authorization)[2].idTagInfo.status, 'Blocked');
  assert.equal(f.local.status().lastMessageAt, initialTime);
});
