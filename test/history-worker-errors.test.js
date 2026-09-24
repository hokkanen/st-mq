import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startHistoryLearning } from '../src/app/learning.js';

test('worker failure callbacks stay nonthrowing when diagnostic storage and stderr fail', async () => {
  let worker;
  class WorkerFixture extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage() { queueMicrotask(() => this.emit('exit', 0)); }
  }
  const messages = [];
  const learning = startHistoryLearning({ store: { path: '/tmp/invented.sqlite', event() { throw new Error('private-invented-value'); } },
    WorkerClass: WorkerFixture, stderr: message => { messages.push(message); throw new Error('broken stderr'); } });
  try {
    assert.doesNotThrow(() => worker.emit('message', { error: 'private-invented-value' }));
    assert.doesNotThrow(() => worker.emit('error', new Error('private-invented-value')));
    assert.equal(messages.length, 1, 'Fallback reporting is bounded');
    assert.doesNotMatch(messages[0], /private-invented-value/);
  } finally { await learning.close(); }
});
