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
import { ocppCommitEffect } from '../src/acquisition/ocpp-startup-diagnostics.js';

const sourceTime = Date.parse('2026-10-07T12:00:00Z');
async function fixture(t, { deferredStart = false, sinkThrows = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-phase-'));
  const path = join(directory, 'fixture.sqlite'), store = new Store(path), competitor = new DatabaseSync(path);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening', { signal: t.signal });
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const rows = [], waiters = new Set(), clients = [];
  const original = console.error;
  console.error = (...values) => {
    let row;
    try { row = JSON.parse(values[0]); } catch { return original(...values); }
    if (row.event !== 'ocpp-startup-phase') return original(...values);
    if (sinkThrows) throw new Error('Synthetic private diagnostic sink failure');
    rows.push(row); for (const waiter of waiters) waiter();
  };
  let authority = true, cleaned = false;
  const state = { get: () => store.getState('fixture:ocpp'), set: value => store.setState('fixture:ocpp', value),
    runWrite: (action, options) => store.runWrite(action, options), afterCommit: ocppCommitEffect(store),
    afterRollback: effect => store.afterRollback(effect) };
  const local = createEaseeOcpp({ config: { host: '127.0.0.1', port, password: 'fixture-ocpp-pass', authorization_tags: ['fixture-tag'] },
    chargerId: 'fixture-charger', clock: () => sourceTime, canControl: () => authority, state });
  const release = () => { try { competitor.exec('ROLLBACK'); } catch { /* No held fixture writer. */ } };
  const cancel = () => { release(); for (const client of clients) client.terminate(); void local.close().catch(() => {}); };
  t.signal.addEventListener('abort', cancel, { once: true });
  t.after(async () => {
    if (cleaned) return; cleaned = true;
    release(); for (const client of clients) client.terminate();
    await local.close(); console.error = original;
    t.signal.removeEventListener('abort', cancel); competitor.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const wait = predicate => {
    const found = () => rows.find(predicate);
    if (found()) return Promise.resolve(found());
    return new Promise((resolve, reject) => {
      const check = () => { const row = found(); if (row) { finish(); resolve(row); } };
      const abort = () => { finish(); reject(t.signal.reason); };
      const finish = () => { waiters.delete(check); t.signal.removeEventListener('abort', abort); };
      waiters.add(check); t.signal.addEventListener('abort', abort, { once: true });
      if (t.signal.aborted) abort(); else check();
    });
  };
  const phase = (name, attempt) => wait(row => row.phase === name && (attempt === undefined || row.attempt === attempt));
  const open = (password = 'fixture-ocpp-pass') => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
      headers: { Authorization: `Basic ${Buffer.from(`fixture-charger:${password}`).toString('base64')}` },
    });
    client.on('error', () => {}); clients.push(client); return client;
  };
  const heartbeat = client => {
    const reply = once(client, 'message', { signal: t.signal });
    client.send(JSON.stringify([2, 'fixture-heartbeat', 'Heartbeat', {}]));
    return reply.then(([data]) => JSON.parse(data));
  };
  if (!deferredStart) await local.start();
  return { local, store, competitor, state, port, rows, phase, open, heartbeat, release, revoke() { authority = false; } };
}

test('initial Store admission precedes actual listener callback without changing readiness', async t => {
  const f = await fixture(t, { deferredStart: true }); f.competitor.exec('BEGIN IMMEDIATE');
  const starting = f.local.start();
  await f.phase('start-requested');
  assert.equal(f.local.status().listening, false); assert.equal(f.local.status().ready, false);
  assert.equal(f.rows.some(row => row.phase === 'listening-observed'), false);
  f.release(); await starting;
  assert.equal(f.local.status().ready, true); assert.equal(f.local.status().connectionGeneration, 0);
  assert.equal(f.rows.filter(row => row.phase === 'listening-observed').length, 1);
});

test('real Upgrade separates TCP and validated request from held Store entry, commit and authenticated attachment', async t => {
  const f = await fixture(t), before = f.store.checkpoint(); f.competitor.exec('BEGIN IMMEDIATE');
  const client = f.open(), opened = once(client, 'open', { signal: t.signal });
  await f.phase('upgrade-write-requested');
  assert.equal(f.local.status().connectionGeneration, 0); assert.equal(f.local.status().transportConnected, false);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-entered'), false);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
  assert.deepEqual(f.store.checkpoint(), before);
  f.release(); await opened;
  const names = f.rows.filter(row => row.attempt === 1).map(row => row.phase);
  assert.deepEqual(names.slice(0, 8), ['tcp-observed', 'upgrade-observed', 'upgrade-validated', 'upgrade-write-requested',
    'upgrade-write-entered', 'upgrade-write-committed', 'upgrade-write-settled', 'authenticated-attached']);
  assert.equal(f.local.status().connectionGeneration, 1);
  assert.equal(f.rows.find(row => row.phase === 'authenticated-attached').generation, 1);
});

test('real original frame receipt precedes Store admission and only COMMIT publishes valid success', async t => {
  const f = await fixture(t), client = f.open(); await once(client, 'open', { signal: t.signal });
  f.competitor.exec('BEGIN IMMEDIATE'); const reply = f.heartbeat(client);
  const raw = await f.phase('first-raw-frame-received');
  assert.equal(f.local.status().lastMessageAt, null);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-admitted'), false);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-committed'), false);
  f.release(); assert.equal((await reply)[0], 3);
  const admitted = await f.phase('first-valid-envelope-admitted'), committed = await f.phase('first-valid-envelope-committed');
  assert.equal(raw.originalReceivedAt, sourceTime); assert.equal(admitted.originalReceivedAt, sourceTime); assert.equal(committed.originalReceivedAt, sourceTime);
  assert.equal(committed.receivedMonotonicNs, raw.receivedMonotonicNs);
  assert.ok(BigInt(admitted.monotonicNs) >= BigInt(raw.monotonicNs));
  assert.ok(BigInt(committed.monotonicNs) >= BigInt(admitted.monotonicNs));
  assert.equal(f.local.status().lastMessageAt, sourceTime);
  const count = f.rows.length; await f.heartbeat(client); assert.equal(f.rows.length, count, 'Ordinary subsequent frames add no phase logs.');
});

test('dead queued Upgrade has no entered or committed marker and no late ledger mutation', async t => {
  const f = await fixture(t), ledger = f.store.getState('fixture:ocpp'), checkpoint = f.store.checkpoint();
  f.competitor.exec('BEGIN IMMEDIATE'); const client = f.open();
  const closed = new Promise(resolve => client.once('close', resolve)); await f.phase('upgrade-write-requested');
  client.terminate(); await closed; await f.phase('admission-failed');
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-entered'), false);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
  assert.equal(f.rows.some(row => row.phase === 'authenticated-attached'), false);
  f.release(); await f.store.runWrite(() => {});
  assert.deepEqual(f.store.getState('fixture:ocpp'), ledger); assert.deepEqual(f.store.checkpoint(), checkpoint);
  assert.equal(f.local.status().connectionGeneration, 0);
});

test('real COMMIT failure preserves refused Upgrade and cannot emit committed success', async t => {
  const f = await fixture(t), checkpoint = f.store.checkpoint(); const execute = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && f.rows.some(row => row.phase === 'upgrade-write-entered'))
      throw Object.assign(new Error('Synthetic failed Upgrade COMMIT'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    return execute(sql);
  };
  const client = f.open(), closed = new Promise(resolve => client.once('close', resolve));
  await closed; await f.phase('admission-failed'); f.store.db.exec = execute;
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-entered'), true);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
  assert.equal(f.rows.some(row => row.phase === 'authenticated-attached'), false);
  assert.deepEqual(f.store.checkpoint(), checkpoint); assert.equal(f.local.status().connectionGeneration, 0);
});

test('authority lost after successful native COMMIT records that commit without granting attachment', async t => {
  const f = await fixture(t), execute = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => { const result = execute(sql); if (sql === 'COMMIT' && f.rows.some(row => row.phase === 'upgrade-write-entered')) f.revoke(); return result; };
  const client = f.open(), closed = new Promise(resolve => client.once('close', resolve)); await closed;
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), true);
  assert.equal(f.rows.some(row => row.phase === 'authenticated-attached'), false);
  assert.equal(f.local.status().connectionGeneration, 0); assert.equal(f.local.status().transportConnected, false);
});

test('malformed first frame is received evidence only and replacement has its own valid generation', async t => {
  const f = await fixture(t), broken = f.open(); await once(broken, 'open', { signal: t.signal });
  const closed = new Promise(resolve => broken.once('close', resolve)); broken.send('not-json'); await closed;
  assert.equal(f.rows.some(row => row.phase === 'first-raw-frame-received' && row.attempt === 1), true);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-committed' && row.attempt === 1), false);
  const current = f.open(); await once(current, 'open', { signal: t.signal }); await f.heartbeat(current);
  const committed = await f.phase('first-valid-envelope-committed', 2);
  assert.equal(committed.generation, 2); assert.equal(f.local.status().connectionGeneration, 2);
});

test('old native WebSocket callbacks cannot acquire a replacement generation or new write', async t => {
  const f = await fixture(t), actualUpgrade = WebSocketServer.prototype.handleUpgrade, native = [];
  WebSocketServer.prototype.handleUpgrade = function(request, stream, head, callback) {
    return actualUpgrade.call(this, request, stream, head, connection => { native.push(connection); callback(connection); });
  };
  t.after(() => { WebSocketServer.prototype.handleUpgrade = actualUpgrade; });
  const older = f.open(); await once(older, 'open', { signal: t.signal }); await f.heartbeat(older);
  const replacement = f.open(); await once(replacement, 'open', { signal: t.signal }); await f.heartbeat(replacement);
  const checkpoint = f.store.checkpoint(), before = f.rows.length;
  native[0].emit('message', Buffer.from(JSON.stringify([2, 'private-old-message', 'Heartbeat', {}])), false);
  native[0].emit('close');
  assert.equal(f.rows.length, before); assert.deepEqual(f.store.checkpoint(), checkpoint);
  assert.equal(f.local.status().connectionGeneration, 2); assert.equal(f.local.status().transportConnected, true);
});

test('diagnostic sink failure leaves the actual Store/socket ready and the original command gate intact', async t => {
  const f = await fixture(t, { sinkThrows: true }), client = f.open(); await once(client, 'open', { signal: t.signal });
  assert.equal((await f.heartbeat(client))[0], 3);
  assert.equal(f.local.status().ready, true); assert.equal(f.local.status().connected, true);
  assert.equal(f.local.status().connectionGeneration, 1); assert.deepEqual(f.rows, []);
});

test('controlled synchronous COMMIT-entry hold separates entered and committed clocks', async t => {
  const f = await fixture(t), execute = f.store.db.exec.bind(f.store.db);
  let held = false, heldNs = 0n;
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && !held && f.rows.some(row => row.phase === 'upgrade-write-entered')) {
      held = true; const began = process.hrtime.bigint();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      heldNs = process.hrtime.bigint() - began;
    }
    return execute(sql);
  };
  const client = f.open(); await once(client, 'open', { signal: t.signal });
  const entered = await f.phase('upgrade-write-entered'), committed = await f.phase('upgrade-write-committed');
  assert.equal(held, true); assert.ok(heldNs >= 35000000n);
  assert.ok(BigInt(committed.monotonicNs) - BigInt(entered.monotonicNs) >= heldNs);
  assert.equal(f.local.status().connectionGeneration, 1);
});

test('a real admitted valid frame with failed COMMIT publishes no reply or committed marker', async t => {
  const f = await fixture(t), client = f.open(); await once(client, 'open', { signal: t.signal });
  const execute = f.store.db.exec.bind(f.store.db); let replies = 0; client.on('message', () => { replies++; });
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && f.rows.some(row => row.phase === 'first-valid-envelope-admitted'))
      throw Object.assign(new Error('Synthetic first-frame COMMIT failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    return execute(sql);
  };
  const closed = new Promise(resolve => client.once('close', resolve));
  client.send(JSON.stringify([2, 'fixture-failed-frame', 'Heartbeat', {}])); await closed; f.store.db.exec = execute;
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-admitted'), true);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-committed'), false);
  assert.equal(replies, 0); assert.equal(f.local.status().lastMessageAt, null);
});

test('a real Upgrade post-commit failure keeps the commit marker and original refused attachment', async t => {
  const f = await fixture(t), save = f.state.set;
  f.state.set = value => { save(value); f.store.afterCommit(() => { throw new Error('Synthetic post-commit failure'); }); };
  const client = f.open(), closed = new Promise(resolve => client.once('close', resolve)); await closed;
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), true);
  assert.equal(f.rows.some(row => row.phase === 'admission-failed'), true);
  assert.equal(f.rows.some(row => row.phase === 'authenticated-attached'), false);
  assert.equal(f.local.status().connectionGeneration, 0);
});

test('invalid authentication records only observed TCP/Upgrade and never private fields or admission', async t => {
  const f = await fixture(t), client = f.open('wrong-synthetic-password');
  await new Promise(resolve => client.once('close', resolve));
  assert.equal(f.rows.some(row => row.phase === 'tcp-observed'), true);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-observed'), true);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-validated'), false);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-entered'), false);
  const encoded = JSON.stringify(f.rows);
  for (const privateValue of ['fixture-charger', 'fixture-ocpp-pass', 'wrong-synthetic-password', 'Authorization', '/ocpp/', '127.0.0.1'])
    assert.equal(encoded.includes(privateValue), false);
  assert.equal(f.local.status().connectionGeneration, 0);
});
