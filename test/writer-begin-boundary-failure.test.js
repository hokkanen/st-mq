import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const rollbackFails of [false, true]) test(`a real writer checkpoint read failing after BEGIN ${rollbackFails ? 'joins and fences failed cleanup' : 'rolls back before reuse'}`,
  { timeout: 30_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-writer-begin-failure-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const preload = join(directory, 'fault.mjs'), child = join(directory, 'scenario.mjs');
    writeFileSync(preload, `
      import { DatabaseSync } from 'node:sqlite';
      import { isMainThread, workerData } from 'node:worker_threads';
      if (!isMainThread && workerData?.syncResponse instanceof SharedArrayBuffer) {
        const execute = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
        let armed = false, injected = false, failRead = false;
        const fault = () => Object.assign(new Error('Synthetic boundary read failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
        DatabaseSync.prototype.exec = function (sql) {
          if (${rollbackFails} && injected && sql === 'ROLLBACK') throw fault();
          const result = execute.call(this, sql);
          // The real writer arms only after its complete startup validation.
          if (sql === 'PRAGMA busy_timeout=0') armed = true;
          if (armed && !injected && sql === 'BEGIN IMMEDIATE') { injected = true; failRead = true; }
          return result;
        };
        DatabaseSync.prototype.prepare = function (sql) {
          const statement = prepare.call(this, sql);
          if (sql === 'SELECT database_id,sequence,hash FROM journal_meta WHERE id=1') {
            const get = statement.get.bind(statement);
            statement.get = (...args) => {
              if (failRead) { failRead = false; throw fault(); }
              return get(...args);
            };
          }
          return statement;
        };
      }
    `);
    writeFileSync(child, `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { setTimeout as delay } from 'node:timers/promises';
      import { Store } from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
      const store = new Store(process.argv[2]);
      try {
        await store.startWriter();
        let calls = 0;
        const checkpoint = store.checkpoint();
        const error = await store.runWrite(() => calls++).catch(error => error);
        assert.equal(error.errcode, 10);
        assert.equal(calls, 0, 'A failed checkpoint response cannot invoke the callback');
        assert.equal(store.writePending, false);
        assert.deepEqual(store.checkpoint(), checkpoint);
        const blocker = new DatabaseSync(store.path);
        try {
          blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
          if (${rollbackFails}) {
            assert.equal(store.writerFailed, true);
            assert.equal(store.writer.terminated, true, 'Failure settles only after worker exit releases the native connection');
            assert.equal(store.canDispatch(), false);
            await assert.rejects(store.runWrite(() => calls++), { code: 'STORAGE_WRITER_FAILED' });
            blocker.exec('ROLLBACK');
          } else {
            assert.equal(store.writerFailed, false);
            assert.equal(store.writer.failed, null);
            assert.equal(store.canDispatch(), true);
            const saved = store.runWrite(() => { calls++; store.setState('recovered', true); });
            for (let attempt = 0; attempt < 100 && store.writeQueueStatus().waitingSince === null; attempt++) await delay(5);
            assert.notEqual(store.writeQueueStatus().waitingSince, null, 'Ordinary BUSY retains asynchronous admission');
            assert.equal(calls, 0);
            blocker.exec('ROLLBACK');
            await saved;
            assert.equal(calls, 1, 'Lock retry never repeats an admitted callback');
            assert.equal(store.getState('recovered'), true);
          }
        } finally { blocker.close(); }
      } finally { await store.close(); }
    `);
    await promisify(execFile)(process.execPath, ['--import', preload, child, join(directory, 'history.sqlite')],
      { timeout: 20_000, maxBuffer: 1024 * 1024 });
  });
