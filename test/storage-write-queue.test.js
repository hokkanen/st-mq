import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-write-queue-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const writer = new DatabaseSync(store.path);
  let closed = false;
  t.after(() => {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close(); if (!closed) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, writer, close() { store.close(); closed = true; } };
}

test('writer admission waits beyond the old timeout without blocking timers, losing writes or retrying their bodies', { timeout: 15000 }, async t => {
  const { store, writer } = fixture(t), order = [];
  writer.exec('BEGIN IMMEDIATE');
  let beats = 0;
  const timer = setInterval(() => beats++, 10);
  t.after(() => clearInterval(timer));
  const firstAt = Date.now(), secondAt = firstAt + 1;
  const first = store.runWrite(() => { order.push('first'); return store.event('queued-first', {}, firstAt); }, { bytes: 128 });
  const second = store.runWrite(() => { order.push('second'); return store.event('queued-second', {}, secondAt); }, { bytes: 128 });
  await delay(5150);
  assert.ok(beats > 100, 'independent control timers kept running throughout the held writer lock');
  assert.deepEqual(order, [], 'no state mutation or command callback ran before admission');
  assert.equal(store.writeHealth.status().failing, false, 'waiting is observable without misreporting rejected saves');
  assert.equal(store.writeQueueStatus().pending, 2);
  assert.equal(store.writeQueueStatus().bytes, 256);
  assert.ok(store.writeQueueStatus().waitingSince >= firstAt);
  writer.exec('COMMIT');
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(store.db.prepare('SELECT type,at FROM events ORDER BY id').all().map(row => ({ ...row })),
    [{ type: 'queued-first', at: firstAt }, { type: 'queued-second', at: secondAt }]);
  assert.equal(store.writeQueueStatus().pending, 0);
  assert.equal(store.db.isTransaction, false);
});

test('control admission has priority, preserving FIFO and eventual normal progress', async t => {
  const { store, writer } = fixture(t), order = [];
  writer.exec('BEGIN IMMEDIATE');
  const normal = [1, 2].map(id => store.runWrite(() => order.push(`n${id}`)));
  const control = Array.from({ length: 12 }, (_, id) => store.runWrite(() => order.push(`c${id}`), { priority: 'control' }));
  writer.exec('ROLLBACK'); await Promise.all([...normal, ...control]);
  assert.equal(order[0], 'c0'); assert.ok(order.indexOf('n1') <= 8);
  assert.deepEqual(order.filter(id => id.startsWith('c')), Array.from({ length: 12 }, (_, id) => `c${id}`));
  assert.deepEqual(order.filter(id => id.startsWith('n')), ['n1', 'n2']);
});

test('bounded admission reports overflow and cancellation or closure rejects without executing callbacks', async t => {
  const { store, writer, close } = fixture(t);
  writer.exec('BEGIN IMMEDIATE');
  const cancel = new AbortController();
  let called = 0;
  const pending = store.runWrite(() => called++, { bytes: 8 * 1024 * 1024, signal: cancel.signal }).catch(error => error);
  await assert.rejects(store.runWrite(() => called++, { bytes: 1 }), { code: 'STORAGE_QUEUE_FULL' });
  assert.equal(store.writeHealth.status().errorCode, 'write-queue-full');
  cancel.abort(); assert.equal((await pending).code, 'STORAGE_WRITE_CANCELLED');
  assert.equal(store.writeQueueStatus().pending, 0);
  const rest = Array.from({ length: 2048 }, () => store.runWrite(() => called++).catch(error => error));
  await assert.rejects(store.runWrite(() => called++), { code: 'STORAGE_QUEUE_FULL' });
  close();
  assert.ok((await Promise.all(rest)).every(error => error.code === 'STORAGE_CLOSED'));
  assert.equal(called, 0);
});

test('queued authority checks run after waiting and reject changed ownership before mutation', async t => {
  const { store, writer } = fixture(t);
  writer.exec('BEGIN IMMEDIATE');
  let current = true, called = false;
  const pending = store.runWrite(() => { called = true; }, { isCurrent: () => current });
  current = false; writer.exec('ROLLBACK');
  await assert.rejects(pending, { code: 'STORAGE_WRITE_STALE' });
  assert.equal(called, false);
});

test('callback failures roll back once, reject asynchronous callbacks and never replay work after it starts', async t => {
  const { store } = fixture(t);
  let called = 0;
  await assert.rejects(store.runWrite(() => {
    called++; store.setState('rolled-back', true);
    throw Object.assign(new Error('synthetic busy after operation began'), { errcode: 5 });
  }), { errcode: 5 });
  assert.equal(called, 1); assert.equal(store.getState('rolled-back'), null);
  await assert.rejects(store.runWrite(() => { store.setState('async-body', true); return Promise.resolve(); }), /must be synchronous/);
  assert.equal(store.getState('async-body'), null);
  await store.runWrite(() => store.setState('healthy', true));
  assert.equal(store.getState('healthy'), true);
  assert.equal(store.writeHealth.status().failing, false);
});

test('commit and rollback hooks respect real outer persistence and nested savepoint failures', async t => {
  const { store, writer } = fixture(t), effects = [];
  await store.runWrite(() => {
    store.transaction(() => {
      store.setState('committed', true);
      store.afterCommit(() => {
        assert.equal(store.db.isTransaction, false);
        assert.equal(JSON.parse(writer.prepare("SELECT value FROM state WHERE key='committed'").get().value), true);
        effects.push('commit');
      });
      store.afterRollback(() => effects.push('wrong-rollback'));
    });
    assert.throws(() => store.transaction(() => {
      store.afterCommit(() => effects.push('wrong-commit'));
      store.afterRollback(() => effects.push('nested-rollback'));
      throw new Error('nested failure');
    }), /nested failure/);
    assert.deepEqual(effects, ['nested-rollback']);
  });
  assert.deepEqual(effects, ['nested-rollback', 'commit']);
  await assert.rejects(store.runWrite(() => {
    store.afterCommit(() => effects.push('wrong-commit'));
    store.afterRollback(() => effects.push('outer-rollback'));
    store.transaction(() => store.afterRollback(() => effects.push('inner-rollback')));
    throw new Error('outer failure');
  }), /outer failure/);
  assert.deepEqual(effects, ['nested-rollback', 'commit', 'inner-rollback', 'outer-rollback']);
});

test('uncontended admission invokes its synchronous callback immediately and nested saves wait for actual commit', async t => {
  const { store } = fixture(t);
  let called = false, inner;
  const result = store.runWrite(() => { called = true; return 42; });
  assert.equal(called, true); assert.equal(await result, 42);
  store.transaction(() => {
    store.setState('outer', true);
    inner = store.runWrite(() => assert.equal(store.getState('outer'), true));
  });
  await inner;
});

test('read-only stores reject admission without calling mutation code', async t => {
  const { store } = fixture(t), replica = new Store(store.path, { readOnly: true });
  t.after(() => replica.close());
  await assert.rejects(replica.runWrite(() => assert.fail('read-only callback ran')), { errcode: 8 });
});

for (const admission of ['synchronous', 'queued']) {
  test(`${admission} parent rollback rejects deferred children without executing or journaling them`, async t => {
    const { store } = fixture(t), before = store.checkpoint();
    const failure = new Error('synthetic parent failure');
    let child, called = 0;
    const body = () => {
      store.setState('parent', true);
      child = store.runWrite(() => { called++; store.setState('child', true); }).catch(error => error);
      throw failure;
    };
    if (admission === 'queued') await assert.rejects(store.runWrite(body), error => error === failure);
    else assert.throws(() => store.transaction(body), error => error === failure);
    assert.equal((await child).code, 'STORAGE_WRITE_ROLLED_BACK');
    assert.equal(called, 0);
    assert.equal(store.getState('parent'), null);
    assert.equal(store.getState('child'), null);
    assert.deepEqual(store.checkpoint(), before);
    assert.equal(store.writeQueueStatus().pending, 0);
  });

  test(`${admission} parent commit preserves children of successful savepoints and rejects rolled-back children`, async t => {
    const { store, writer } = fixture(t);
    let discarded, accepted;
    const body = () => {
      assert.throws(() => store.transaction(() => {
        discarded = store.runWrite(() => assert.fail('rolled-back descendant ran')).catch(error => error);
        throw new Error('synthetic savepoint failure');
      }), /savepoint failure/);
      store.transaction(() => {
        store.setState('parent', true);
        accepted = store.runWrite(() => {
          assert.equal(JSON.parse(writer.prepare("SELECT value FROM state WHERE key='parent'").get().value), true);
          store.setState('child', true);
        });
      });
      assert.equal(store.getState('child'), null);
    };
    if (admission === 'queued') await store.runWrite(body);
    else store.transaction(body);
    assert.equal((await discarded).code, 'STORAGE_WRITE_ROLLED_BACK');
    await accepted;
    assert.equal(store.getState('child'), true);
    assert.equal(store.checkpoint().sequence, 2, 'child has its own later durable commit');
  });
}

test('a post-commit failure cannot roll back saved data or strand subsequent commit callbacks', async t => {
  const { store } = fixture(t);
  let deferred, calls = 0;
  await assert.rejects(store.runWrite(() => {
    calls++; store.setState('committed-despite-consumer', true);
    store.afterCommit(() => { throw new Error('synthetic consumer failure'); });
    store.afterCommit(() => { deferred = store.runWrite(() => store.setState('next', true)); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  await deferred;
  assert.equal(calls, 1); assert.equal(store.getState('committed-despite-consumer'), true);
  assert.equal(store.getState('next'), true); assert.equal(store.writeHealth.status().failing, false);
});

test('cancellation after a synchronous callback starts cannot misreport its committed result as cancelled', async t => {
  const { store } = fixture(t), cancel = new AbortController();
  const result = await store.runWrite(() => {
    store.setState('accepted', true); cancel.abort(); return 'saved';
  }, { signal: cancel.signal });
  assert.equal(result, 'saved'); assert.equal(store.getState('accepted'), true);
});

for (const errcode of [10, 13]) test(`SQLite commit failure ${errcode} rejects descendants and preserves the durable checkpoint`, async t => {
  const { store } = fixture(t), before = store.checkpoint();
  const exec = store.db.exec.bind(store.db);
  let calls = 0, child;
  const failure = Object.assign(new Error('synthetic commit failure'), { code: 'ERR_SQLITE_ERROR', errcode });
  store.db.exec = sql => { if (sql === 'COMMIT') throw failure; return exec(sql); };
  try {
    await assert.rejects(store.runWrite(() => {
      calls++; store.setState('parent', true);
      child = store.runWrite(() => assert.fail('child escaped failed commit')).catch(error => error);
    }), error => error === failure);
  } finally { store.db.exec = exec; }
  assert.equal((await child).code, 'STORAGE_WRITE_ROLLED_BACK');
  assert.equal(calls, 1);
  assert.deepEqual(store.checkpoint(), before);
  assert.equal(store.getState('parent'), null);
  assert.equal(store.db.isTransaction, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM journal_pending').get().n, 0);
  assert.equal(store.writeHealth.status().failing, true);
  await store.runWrite(() => store.setState('recovered', true));
  assert.equal(store.writeHealth.status().failing, false);
});
