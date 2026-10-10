import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { isMainThread, threadId, workerData } from 'node:worker_threads';
import { Store } from '../../src/storage/store.js';

// Loaded only by the crash fixture's child process. Replay/preview workers do
// not own publication and must never trigger this fault.
const parameters = new URL(import.meta.url).searchParams;
const path = parameters.get('path'), action = parameters.get('action');
if (!isMainThread && workerData?.dbPath === path && ['recovery', 'revision'].includes(workerData.kind)) {
  const setState = Store.prototype.setState;
  Store.prototype.setState = function (key, value) {
    const result = setState.call(this, key, value);
    if (key === `adaptive:${workerData.input}`) {
      assert(threadId > 0, 'the crash must occur in the publication worker');
      assert(this.db.isTransaction, 'the crash must occur inside the real publication transaction');
      writeFileSync(`${path}.crash.json`, JSON.stringify({ action, boundary: 'during-publication',
        point: 'adaptive-state-written', threadId, inTransaction: this.db.isTransaction }));
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  };
}
