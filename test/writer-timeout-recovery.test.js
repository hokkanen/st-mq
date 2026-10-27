import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';

const slowSql = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) AS n FROM n';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-writer-timeout-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await store.startWriter();
  return store;
}
function holdRecovery(t, store) {
  const entered = deferred(), release = deferred(), recover = store._recoverWriter.bind(store);
  t.signal.addEventListener('abort', release.resolve, { once: true });
  t.mock.method(store, '_recoverWriter', async (...args) => { entered.resolve(); await release.promise; return recover(...args); });
  return { entered: entered.promise, release: release.resolve };
}
function slowBody(store) {
  // Use real native SQLite execution so the worker cannot answer the shared
  // statement request in time. This changes only this test client's deadline.
  store.writer.syncTimeoutMs = 100;
  store.db.prepare(slowSql).get();
}
const enteredRecovery = (gate, result) => Promise.race([gate.entered,
  result.then(() => { throw new Error('The timed-out body never reached owned recovery'); })]);

test('a timed-out uncommitted body reopens only after rollback and never replays its callback', async t => {
  const store = await fixture(t), old = store.writer, before = store.checkpoint(), gate = holdRecovery(t, store);
  const events = []; let calls = 0, child, next, ram = 'committed';
  const failed = store.runWrite(() => {
    calls++; store.setState('partial', true); ram = 'provisional';
    store.afterRollback(() => { ram = 'committed'; events.push('rollback'); });
    store.afterCommit(() => assert.fail('Uncommitted effects escaped'));
    child = store.runWrite(() => assert.fail('Rolled-back descendant executed')).catch(error => error);
    slowBody(store);
  }).catch(error => error);
  try {
    await enteredRecovery(gate, failed);
    assert.equal(old.terminated, true);
    assert.equal(store.canDispatch(), false);
    assert.equal(store.getState('partial'), null);
    assert.deepEqual(store.checkpoint(), before);
    assert.deepEqual(events, []);
    next = store.runWrite(() => {
      assert.equal(ram, 'committed'); events.push('next');
      // The Store retains this prepared facade across the worker replacement.
      store.observation({ source: 'synthetic', device: 'timeout-proof', signal: 'temperature',
        value: 21, unit: 'degC', sourceTime: 100, receivedAt: 100 });
    });
    assert.deepEqual(events, []);
  } finally { gate.release(); }
  assert.equal((await failed).code, 'STORAGE_WRITER_TIMEOUT');
  assert.equal((await child).code, 'STORAGE_WRITE_ROLLED_BACK');
  await next;
  assert.equal(calls, 1); assert.deepEqual(events, ['rollback', 'next']);
  assert.notEqual(store.writer, old);
  assert.equal(store.writerFailed, false); assert.equal(store.canDispatch(), true);
  assert.equal(store.getState('partial'), null); assert.equal(store.observations().length, 1);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(verifyJournal(store.db).commits, 1);
});

test('a changed journal head keeps timeout recovery fenced', async t => {
  const store = await fixture(t), old = store.writer, gate = holdRecovery(t, store);
  const failed = store.runWrite(() => { store.setState('partial', true); slowBody(store); }).catch(error => error);
  try {
    await enteredRecovery(gate, failed);
    const external = new Store(store.path);
    try { external.setState('independent-change', true); } finally { external.close(); }
  } finally { gate.release(); }
  assert.equal((await failed).code, 'STORAGE_WRITER_TIMEOUT');
  assert.equal(store.writer, old); assert.equal(store.writerFailed, true); assert.equal(store.canDispatch(), false);
  assert.equal(store.getState('partial'), null); assert.equal(store.getState('independent-change'), true);
  await assert.rejects(store.runWrite(() => assert.fail('Changed history authorized a new write')), { code: 'STORAGE_WRITER_FAILED' });
});

test('a nested statement timeout rolls back once without a circular cleanup error', async t => {
  const store = await fixture(t); let rollbacks = 0, calls = 0;
  const error = await store.runWrite(() => {
    calls++;
    store.transaction(() => {
      store.setState('nested-partial', true);
      store.afterRollback(() => rollbacks++);
      slowBody(store);
    });
  }).catch(error => error);
  assert.equal(error.code, 'STORAGE_WRITER_TIMEOUT'); assert.notEqual(error.cleanupError, error);
  assert.equal(calls, 1); assert.equal(rollbacks, 1);
  assert.equal(store.getState('nested-partial'), null); assert.equal(store.canDispatch(), true);
  await store.runWrite(() => store.setState('after-nested-timeout', true));
  assert.equal(store.getState('after-nested-timeout'), true);
});

test('a replaced physical database keeps timeout recovery fenced even at the same journal boundary', async t => {
  const store = await fixture(t), old = store.writer, gate = holdRecovery(t, store), original = `${store.path}.original`;
  let replaced = false;
  const failed = store.runWrite(() => { store.setState('partial', true); slowBody(store); }).catch(error => error);
  try {
    await enteredRecovery(gate, failed);
    renameSync(store.path, original); copyFileSync(original, store.path); replaced = true;
    gate.release();
    assert.equal((await failed).code, 'STORAGE_WRITER_TIMEOUT');
    assert.equal(store.writer, old); assert.equal(store.writerFailed, true); assert.equal(store.canDispatch(), false);
  } finally {
    gate.release(); await failed;
    if (replaced) { rmSync(store.path); renameSync(original, store.path); }
  }
});

test('closing admission while timeout recovery is held cannot publish a replacement writer', async t => {
  const store = await fixture(t), old = store.writer, gate = holdRecovery(t, store);
  const failed = store.runWrite(() => { store.setState('partial', true); slowBody(store); }).catch(error => error);
  let closing;
  try { await enteredRecovery(gate, failed); closing = store.close(); }
  finally { gate.release(); }
  assert.equal((await failed).code, 'STORAGE_WRITER_TIMEOUT'); await closing;
  assert.equal(store.writer, old); assert.equal(store.canDispatch(), false);
});

for (const committed of [false, true])
test(`a timeout after COMMIT was requested retains its existing ${committed ? 'confirmed-save' : 'uncertain-save'} fence`, async t => {
  const store = await fixture(t), old = store.writer, request = old.request.bind(old);
  let effects = 0, rollbacks = 0;
  t.mock.method(store, '_recoverWriter', () => assert.fail('A COMMIT timeout entered body-only recovery'));
  old.request = async (operation, ...args) => {
    if (operation !== 'commit') return request(operation, ...args);
    if (committed) await request(operation, ...args);
    const error = old.fail(Object.assign(new Error('Synthetic lost COMMIT reply'), { code: 'STORAGE_WRITER_TIMEOUT' }));
    await old.terminate(); throw error;
  };
  const result = store.runWrite(() => {
    store.setState('candidate', true); store.afterCommit(() => effects++); store.afterRollback(() => rollbacks++);
    return 'saved';
  });
  if (committed) assert.equal(await result, 'saved');
  else await assert.rejects(result, { code: 'STORAGE_WRITER_TIMEOUT' });
  assert.equal(effects, committed ? 1 : 0); assert.equal(rollbacks, committed ? 0 : 1);
  assert.equal(store.getState('candidate'), committed ? true : null);
  assert.equal(store.writerFailed, true); assert.equal(store.canDispatch(), false);
});
