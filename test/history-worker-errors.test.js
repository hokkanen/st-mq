import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { startHistoryLearning } from '../src/app/learning.js';

test('worker failure callbacks stay nonthrowing when diagnostic storage and stderr fail', async () => {
  let worker;
  class WorkerFixture extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage() { queueMicrotask(() => this.emit('exit', 0)); }
  }
  const messages = [];
  const learning = startHistoryLearning({ store: { path: '/tmp/invented.sqlite', runWrite: async operation => operation(), event() { throw new Error('private-invented-value'); } },
    WorkerClass: WorkerFixture, stderr: message => { messages.push(message); throw new Error('broken stderr'); } });
  try {
    assert.doesNotThrow(() => worker.emit('message', { error: 'private-invented-value' }));
    assert.doesNotThrow(() => worker.emit('error', new Error('private-invented-value')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1, 'Fallback reporting is bounded');
    assert.doesNotMatch(messages[0], /private-invented-value/);
  } finally { await learning.close(); }
});


test('learning shutdown cancels diagnostic writes while SQLite is held by another connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-learning-close-'));
  const store = new Store(join(directory, 'history.sqlite')), writer = new DatabaseSync(store.path);
  let worker;
  class WorkerFixture extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage() { queueMicrotask(() => this.emit('exit', 0)); }
  }
  const learning = startHistoryLearning({ store, WorkerClass: WorkerFixture, stderr() {} });
  writer.exec('BEGIN IMMEDIATE');
  let timeout;
  try {
    worker.emit('error', new Error('synthetic-worker-failure'));
    assert.equal(store.writeQueueStatus().pending, 1);
    await Promise.race([learning.close(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Diagnostic save blocked shutdown')), 1000);
    })]);
    assert.equal(writer.isTransaction, true);
    assert.equal(store.writeQueueStatus().pending, 0);
  } finally {
    clearTimeout(timeout); writer.exec('ROLLBACK'); writer.close(); await learning.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
