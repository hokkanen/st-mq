import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../../src/storage/store.js';

// Fault injection surrounds the production worker and real SQLite transaction.
// The gate delays only a test worker; the application's main thread stays free.
const { mode, gate } = workerData.testBoundary;
const barrier = gate && new Int32Array(gate);
const post = parentPort.postMessage.bind(parentPort);
const hold = phase => {
  post({ type: 'test-boundary', phase });
  if (Atomics.wait(barrier, 0, 0, 10_000) === 'timed-out') throw new Error('Test publication gate timed out');
};

if (mode === 'before-commit') {
  const runWrite = Store.prototype.runWrite;
  Store.prototype.runWrite = function (operation, options) {
    return runWrite.call(this, () => { hold('before-commit'); return operation(); }, options);
  };
}
if (mode === 'rollback') {
  const setState = Store.prototype.setState;
  Store.prototype.setState = function (key, value) {
    const result = setState.call(this, key, value);
    if (key.startsWith('learning:publication:')) throw new Error('Injected failure before transaction commit');
    return result;
  };
}
parentPort.postMessage = message => {
  if (message?.type === 'result' && message.result) {
    if (mode === 'lost-reply') process.exit(23);
    if (mode === 'after-commit') hold('after-commit');
  }
  return post(message);
};

await import('../../src/app/learning-publication-worker.js');
