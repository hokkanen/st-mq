import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-worker-'));
  const store = new Store(join(directory, 'history.sqlite'));
  await store.startWriter();
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function hold(store, operation = 'commit') {
  const request = store.writer.request.bind(store.writer);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let once = false;
  store.writer.request = async (name, ...args) => {
    if (name === operation && !once) { once = true; entered(); await gate; }
    return request(name, ...args);
  };
  return { ready, release };
}

test('writer keeps dependent SQL atomic and outside reads committed while timers run', async t => {
  const store = await fixture(t), gate = hold(store), effects = [];
  let called = 0, child;
  const saving = store.runWrite(() => {
    called++;
    store.setState('counter', 1);
    assert.equal(store.getState('counter'), 1);
    store.transaction(() => {
      store.setState('counter', store.getState('counter') + 1);
      store.afterCommit(() => effects.push('saved'));
    });
    assert.throws(() => store.transaction(() => {
      store.setState('discarded', true);
      store.afterCommit(() => effects.push('wrong'));
      store.afterRollback(() => effects.push('nested-rollback'));
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    child = store.runWrite(() => store.setState('child', store.getState('counter')));
    return 42;
  });
  await gate.ready;
  assert.equal(store.transactionDepth, 0);
  assert.equal(store.canDispatch(), false);
  assert.equal(store.getState('counter'), null);
  assert.deepEqual(effects, ['nested-rollback']);
  assert.throws(() => store.setState('unadmitted', true), { code: 'STORAGE_WRITE_PENDING' });
  let beats = 0;
  const timer = setInterval(() => beats++, 5);
  await delay(80); clearInterval(timer);
  assert.ok(beats >= 5);
  gate.release(); assert.equal(await saving, 42); await child;
  assert.equal(called, 1);
  assert.equal(store.getState('counter'), 2);
  assert.equal(store.getState('child'), 2);
  assert.equal(store.getState('discarded'), null);
  assert.deepEqual(effects, ['nested-rollback', 'saved']);
  assert.equal(store.canDispatch(), true);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('writer lock waits asynchronously and checks cancellation and authority before callback', async t => {
  const store = await fixture(t), lock = new DatabaseSync(store.path);
  t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE');
  let current = true, calls = 0;
  const cancellation = new AbortController();
  const stale = store.runWrite(() => calls++, { isCurrent: () => current }).catch(error => error);
  const cancelled = store.runWrite(() => calls++, { signal: cancellation.signal }).catch(error => error);
  await delay(50); current = false; cancellation.abort();
  assert.equal(calls, 0);
  lock.exec('ROLLBACK');
  assert.equal((await stale).code, 'STORAGE_WRITE_STALE');
  assert.equal((await cancelled).code, 'STORAGE_WRITE_CANCELLED');
  assert.equal(calls, 0);
  await store.runWrite(() => store.setState('next', true));
  assert.equal(store.getState('next'), true);
});

test('failed commit rolls back RAM and descendants once before settlement observers and next write', async t => {
  const store = await fixture(t), gate = hold(store, 'seal');
  const request = store.writer.request.bind(store.writer);
  const events = [];
  let child, once = false;
  store.writer.request = async (operation, ...args) => {
    if (operation === 'commit' && !once) {
      once = true;
      throw Object.assign(new Error('synthetic disk full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    }
    return request(operation, ...args);
  };
  const failed = store.runWrite(() => {
    store.setState('candidate', true);
    store.afterRollback(() => events.push('rollback'));
    store.afterCommit(() => events.push('wrong'));
    child = store.runWrite(() => assert.fail('discarded descendant executed')).catch(error => error);
  }).catch(error => error);
  await gate.ready;
  const remove = store.onWriteSettled(() => { events.push('settled'); remove(); });
  const next = store.runWrite(() => { events.push('next'); store.setState('good', true); });
  gate.release();
  assert.equal((await failed).errcode, 13);
  assert.equal((await child).code, 'STORAGE_WRITE_ROLLED_BACK');
  await next;
  assert.deepEqual(events, ['rollback', 'settled', 'next']);
  assert.equal(store.getState('candidate'), null);
  assert.equal(store.getState('good'), true);
  assert.equal(store.writerFailed, false);
});

test('worker loss after commit reconciles the durable checkpoint without replaying effects', async t => {
  const store = await fixture(t), request = store.writer.request.bind(store.writer);
  let calls = 0, effects = 0;
  store.writer.request = async (operation, ...args) => {
    const result = await request(operation, ...args);
    if (operation === 'commit') {
      await store.writer.terminate();
      throw Object.assign(new Error('lost reply'), { code: 'STORAGE_WRITER_FAILED' });
    }
    return result;
  };
  assert.equal(await store.runWrite(() => {
    calls++; store.setState('durable', true); store.afterCommit(() => effects++); return 'saved';
  }), 'saved');
  assert.equal(store.getState('durable'), true);
  assert.equal(calls, 1); assert.equal(effects, 1);
  assert.equal(store.writerFailed, true);
  assert.equal(store.canDispatch(), false);
  await assert.rejects(store.runWrite(() => assert.fail('failed writer reused')), { code: 'STORAGE_WRITER_FAILED' });
});

test('worker loss before commit cannot publish provisional state or run durable effects', async t => {
  const store = await fixture(t), gate = hold(store, 'seal');
  let effects = 0, rolledBack = 0;
  const result = store.runWrite(() => {
    store.setState('uncommitted', true);
    store.afterCommit(() => effects++); store.afterRollback(() => rolledBack++);
  }).catch(error => error);
  await gate.ready; await store.writer.terminate(); gate.release();
  assert.equal((await result).code, 'STORAGE_WRITER_UNAVAILABLE');
  assert.equal(store.getState('uncommitted'), null);
  assert.equal(effects, 0); assert.equal(rolledBack, 1);
  assert.equal(store.canDispatch(), false);
});

test('shutdown joins an admitted save, rejects queued jobs, and preserves committed data', async t => {
  const store = await fixture(t), gate = hold(store);
  const save = store.runWrite(() => store.setState('final', true));
  await gate.ready;
  const rejected = store.runWrite(() => assert.fail('queued job executed after close')).catch(error => error);
  let closed = false;
  const closing = store.close().then(() => { closed = true; });
  await delay(30); assert.equal(closed, false);
  assert.equal((await rejected).code, 'STORAGE_CLOSED');
  gate.release(); await save; await closing;
  const reopened = new Store(store.path, { readOnly: true });
  assert.equal(reopened.getState('final'), true); reopened.close();
});

test('post-commit errors do not roll back data or suppress later effects', async t => {
  const store = await fixture(t);
  let effects = 0;
  await assert.rejects(store.runWrite(() => {
    store.setState('saved', true);
    store.afterCommit(() => { throw new Error('consumer failed'); });
    store.afterCommit(() => effects++);
    store.afterRollback(() => assert.fail('committed rollback'));
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  assert.equal(effects, 1); assert.equal(store.getState('saved'), true);
  await store.runWrite(() => store.setState('next', true));
});

test('statement settings and no-op transactions preserve the current database contract', async t => {
  const store = await fixture(t), before = store.checkpoint();
  await store.runWrite(() => {
    assert.equal(store.db.prepare('SELECT 123 AS n').setReadBigInts(true).get().n, 123n);
    assert.deepEqual([...store.db.prepare('SELECT 1 AS n UNION ALL SELECT 2').iterate()].map(row => row.n), [1, 2]);
  });
  assert.deepEqual(store.checkpoint(), before);
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
});

test('dashboard keeps a complete committed view during pending durability and refreshes on settlement', async t => {
  const { Engine } = await import('../src/app/engine.js');
  const directory = mkdtempSync(join(tmpdir(), 'stmq-worker-status-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const engine = new Engine({ store, config: { input: 'simulated', settings: {} }, clock: () => Date.parse('2026-10-15T12:00:00Z') });
  t.after(async () => {
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false });
    await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await store.startWriter();
  await store.runWrite(() => engine.tick());
  const before = engine.status(), gate = hold(store);
  const saving = store.runWrite(() => {
    const previous = engine.latestStatus;
    store.afterRollback(() => { engine.latestStatus = previous; });
    engine.latestStatus = { ...previous, testLabel: 'candidate' };
    store.setState('status-change', true);
  });
  await gate.ready;
  const pending = engine.status();
  assert.equal(pending.storagePending, true);
  assert.equal(pending.now, before.now);
  assert.equal(pending.testLabel, undefined);
  gate.release(); await saving;
  assert.equal(engine.status().testLabel, 'candidate');
  assert.equal(engine.statusSettlement, null);
});

test('OCPP diagnostics recognize the real worker Store durability boundary', async t => {
  const { createOcppStartupDiagnostics, ocppCommitEffect } = await import('../src/acquisition/ocpp-startup-diagnostics.js');
  const store = await fixture(t), rows = [], stream = {};
  const diagnostics = createOcppStartupDiagnostics({ report: row => rows.push(row) });
  diagnostics.start(); diagnostics.tcp(stream);
  await store.runWrite(() => {
    store.setState('diagnostic', true);
    diagnostics.commit('upgrade-write-committed', stream, { afterCommit: ocppCommitEffect(store) });
    assert.equal(rows.some(row => row.phase === 'upgrade-write-committed'), false);
  });
  assert.equal(rows.some(row => row.phase === 'upgrade-write-committed'), true);
  assert.equal(rows.some(row => row.phase === 'durability-unknown'), false);
});
