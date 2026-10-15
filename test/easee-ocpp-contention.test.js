import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/storage/store.js';
import { createEaseeOcpp } from '../src/acquisition/easee-ocpp.js';

const initialTime = Date.parse('2026-10-07T12:00:00Z');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const closed = socket => new Promise(resolve => socket.once('close', resolve));
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'The expected fixture transition did not complete.');
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-contention-'));
  const path = join(directory, 'fixture.sqlite'), store = new Store(path), competitor = new DatabaseSync(path);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let now = initialTime, authority = true, sequence = 0, ledgerWrites = 0;
  const clients = [];
  const openTransport = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
      headers: { Authorization: `Basic ${Buffer.from('fixture-charger:fixture-ocpp-pass').toString('base64')}` },
    });
    clients.push(ws); ws.on('error', () => {}); return ws;
  };
  const local = createEaseeOcpp({ config: { host: '127.0.0.1', port, password: 'fixture-ocpp-pass', authorization_tags: ['fixture-tag'] },
    chargerId: 'fixture-charger', clock: () => now, canControl: () => authority,
    state: { get: () => store.getState('fixture:ocpp'), set: value => { ledgerWrites++; store.setState('fixture:ocpp', value); },
      runWrite: (action, options) => store.runWrite(action, options),
      afterCommit: effect => store.afterCommit(effect), afterRollback: effect => store.afterRollback(effect) } });
  t.after(async () => {
    try { competitor.exec('ROLLBACK'); } catch { /* No active fixture lock. */ }
    for (const client of clients) client.terminate();
    await local.close(); competitor.close(); await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await local.start();
  return { local, store, competitor, port, openTransport, get ledgerWrites() { return ledgerWrites; },
    get now() { return now; }, set now(value) { now = value; },
    revoke() { authority = false; },
    async connect() {
      const ws = openTransport();
      const pending = new Map(), calls = [], replies = [];
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

for (const interruption of ['cancelled', 'new-native-frame']) test(`worker commit wait revalidates OCPP dispatch after ${interruption}`, async t => {
  const f = await fixture(t), client = await f.connect();
  await waitFor(() => f.store.writeQueueStatus().pending === 0);
  await f.store.startWriter();
  let entered, release, intercepted = false;
  const held = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const request = f.store.writer.request.bind(f.store.writer);
  f.store.writer.request = async (operation, args) => {
    if (operation === 'commit' && !intercepted) { intercepted = true; entered(); await resumed; }
    return request(operation, args);
  };
  t.after(() => release());
  const cancellation = new AbortController();
  let dispatches = 0;
  const command = f.local.request('ChangeAvailability', { connectorId: 0, type: 'Operative' },
    { signal: cancellation.signal, beforeSend: () => { dispatches++; return true; } });
  const rejected = assert.rejects(command, { code: interruption === 'cancelled' ? 'ocpp-request-aborted' : 'ocpp-request-revoked' });
  await held;
  assert.equal(dispatches, 0, 'The dispatch hook must wait for durability');
  let native;
  if (interruption === 'cancelled') cancellation.abort();
  else {
    native = client.call('StatusNotification', { connectorId: 1, status: 'SuspendedEVSE', errorCode: 'NoError',
      timestamp: new Date(f.now).toISOString() });
    await waitFor(() => f.store.writeQueueStatus().pending >= 2);
  }
  release(); await rejected; await native;
  assert.equal(dispatches, 0);
  assert.equal(client.calls.filter(frame => frame[2] === 'ChangeAvailability').length, 0);
});

test('a disconnected pending OCPP upgrade releases writer admission before the lock clears', async t => {
  const f = await fixture(t), ledger = f.store.getState('fixture:ocpp'), checkpoint = f.store.checkpoint(), writes = f.ledgerWrites;
  f.competitor.exec('BEGIN IMMEDIATE');
  const client = f.openTransport();
  await waitFor(() => f.store.writeQueueStatus().waitingSince !== null);
  assert.equal(f.local.status().ready, true); assert.equal(f.local.status().connectionGeneration, 0);
  assert.equal(f.store.writeQueueStatus().pending, 1);
  const completion = closed(client); client.terminate(); await completion;
  await waitFor(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.ledgerWrites, writes); assert.deepEqual(f.store.getState('fixture:ocpp'), ledger);
  assert.deepEqual(f.store.checkpoint(), checkpoint);
  f.competitor.exec('ROLLBACK'); await delay(25);
  assert.equal(f.ledgerWrites, writes); assert.equal(f.local.status().connectionGeneration, 0);
  assert.deepEqual(f.store.checkpoint(), checkpoint);
  const replacement = await f.connect();
  assert.equal((await replacement.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
  assert.equal(f.local.status().connectionGeneration, 2, 'Only the replacement upgrade and its BootNotification establish generations.');
});

test('cancelling one pending OCPP upgrade retains a replacement client and its durable gate', async t => {
  const f = await fixture(t), writes = f.ledgerWrites;
  f.competitor.exec('BEGIN IMMEDIATE');
  const retired = f.openTransport();
  await waitFor(() => f.store.writeQueueStatus().pending === 1);
  const replacement = f.openTransport(); let opened = false;
  const ready = once(replacement, 'open').then(() => { opened = true; });
  void ready.catch(() => {}); // Cleanup may close this client after a failing assertion.
  await waitFor(() => f.store.writeQueueStatus().pending === 2);
  const completion = closed(retired); retired.terminate(); await completion;
  await waitFor(() => f.store.writeQueueStatus().pending === 1);
  assert.equal(opened, false); assert.equal(f.ledgerWrites, writes); assert.equal(f.local.status().connectionGeneration, 0);
  f.competitor.exec('ROLLBACK'); await ready;
  assert.equal(f.ledgerWrites, writes + 1); assert.equal(f.local.status().connectionGeneration, 1);
});

test('a dead pending OCPP upgrade preserves the existing authenticated transaction and connection', async t => {
  const f = await fixture(t), active = await f.connect();
  await active.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 100,
    timestamp: new Date(f.now).toISOString() });
  await active.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError',
    timestamp: new Date(f.now).toISOString() });
  const ledger = f.store.getState('fixture:ocpp'), checkpoint = f.store.checkpoint(), writes = f.ledgerWrites,
    control = f.local.controlSnapshot(), generation = f.local.status().connectionGeneration;
  f.competitor.exec('BEGIN IMMEDIATE');
  const pending = f.openTransport();
  await waitFor(() => f.store.writeQueueStatus().waitingSince !== null);
  const completion = closed(pending); pending.terminate(); await completion;
  await waitFor(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(active.ws.readyState, WebSocket.OPEN); assert.equal(f.local.status().connectionGeneration, generation);
  assert.deepEqual(f.local.controlSnapshot(), control); assert.equal(f.ledgerWrites, writes);
  assert.deepEqual(f.store.getState('fixture:ocpp'), ledger); assert.deepEqual(f.store.checkpoint(), checkpoint);
  f.competitor.exec('ROLLBACK');
  assert.equal((await active.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
  assert.deepEqual(f.store.getState('fixture:ocpp'), ledger);
});

test('pending OCPP upgrade preserves revocation and whole-listener shutdown cancellation', async t => {
  for (const action of ['revoke', 'close']) {
    const f = await fixture(t), ledger = f.store.getState('fixture:ocpp'), checkpoint = f.store.checkpoint(), writes = f.ledgerWrites;
    f.competitor.exec('BEGIN IMMEDIATE');
    const client = f.openTransport(); let opened = false; client.on('open', () => { opened = true; });
    const completion = closed(client);
    await waitFor(() => f.store.writeQueueStatus().waitingSince !== null);
    if (action === 'revoke') { f.revoke(); f.competitor.exec('ROLLBACK'); await completion; }
    else {
      await f.local.close(); await completion;
      const probe = createServer(); probe.listen(f.port, '127.0.0.1'); await once(probe, 'listening');
      await new Promise(resolve => probe.close(resolve));
      f.competitor.exec('ROLLBACK');
    }
    await waitFor(() => f.store.writeQueueStatus().pending === 0);
    assert.equal(opened, false); assert.equal(f.local.status().connectionGeneration, 0);
    assert.equal(f.ledgerWrites, writes); assert.deepEqual(f.store.getState('fixture:ocpp'), ledger);
    assert.deepEqual(f.store.checkpoint(), checkpoint);
  }
});

test('a committed OCPP upgrade cannot attach after its admitted transport closes', async t => {
  const f = await fixture(t), checkpoint = f.store.checkpoint();
  const execute = f.store.db.exec.bind(f.store.db);
  const upgrade = WebSocketServer.prototype.handleUpgrade;
  let committed = false, opened = false;
  t.after(() => { WebSocketServer.prototype.handleUpgrade = upgrade; f.store.db.exec = execute; });
  f.store.db.exec = sql => {
    const result = execute(sql);
    if (sql === 'COMMIT') committed = true;
    return result;
  };
  WebSocketServer.prototype.handleUpgrade = function(request, stream, head, callback) {
    assert.equal(committed, true, 'WebSocket publication must follow durable admission.');
    stream.destroy(); return upgrade.call(this, request, stream, head, callback);
  };
  const client = f.openTransport(); client.on('open', () => { opened = true; });
  await closed(client); await waitFor(() => f.store.writeQueueStatus().pending === 0);
  await delay(25);
  assert.equal(committed, true); assert.equal(opened, false); assert.equal(f.local.status().connectionGeneration, 0);
  assert.deepEqual(f.store.checkpoint(), checkpoint);
  f.store.db.exec = execute; WebSocketServer.prototype.handleUpgrade = upgrade;
  const replacement = await f.connect();
  assert.equal((await replacement.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
});

test('pending OCPP upgrade cannot publish after a failed commit or authority loss at commit', async t => {
  for (const action of ['fail', 'revoke']) {
    const f = await fixture(t), ledger = f.store.getState('fixture:ocpp'), checkpoint = f.store.checkpoint();
    const execute = f.store.db.exec.bind(f.store.db);
    f.store.db.exec = sql => {
      if (sql === 'COMMIT' && action === 'fail')
        throw Object.assign(new Error('Synthetic upgrade commit failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
      const result = execute(sql);
      if (sql === 'COMMIT') f.revoke();
      return result;
    };
    const client = f.openTransport(); let opened = false; client.on('open', () => { opened = true; });
    await closed(client); await waitFor(() => f.store.writeQueueStatus().pending === 0);
    f.store.db.exec = execute;
    assert.equal(opened, false); assert.equal(f.local.status().connectionGeneration, 0);
    assert.deepEqual(f.store.getState('fixture:ocpp'), ledger); assert.deepEqual(f.store.checkpoint(), checkpoint);
  }
});

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
