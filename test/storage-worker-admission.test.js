import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { attachStorageAdmission, terminateStorageWorker } from '../src/storage/worker-admission.js';

// Explicit exit models a worker which receives termination during startup but
// reaches its first synchronous admission wait before actually stopping.
class StartingWorker extends EventEmitter {
  terminate() { return once(this, 'exit').then(([code]) => code); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('late startup admission is cancelled after termination was requested', async () => {
  const worker = new StartingWorker(), signal = new Int32Array(new SharedArrayBuffer(4));
  let requests = 0;
  attachStorageAdmission(worker, signal, () => { requests++; return new Promise(() => {}); });
  const stopped = terminateStorageWorker(worker);
  // Startup can reset the word after the parent has already requested a stop.
  Atomics.store(signal, 0, 0);
  worker.emit('message', { storage: 'acquire', id: 1 });
  await turn();
  assert.equal(Atomics.load(signal, 0), -1, 'The late native wait must receive cancellation');
  assert.equal(requests, 0, 'Late startup must not queue a new storage reservation');
  worker.emit('exit', 1);
  assert.equal(await stopped, 1);
});

for (const admitted of [false, true]) test(`termination retains ${admitted ? 'admitted' : 'queued'} storage until worker exit`, async () => {
  const worker = new StartingWorker(), signal = new Int32Array(new SharedArrayBuffer(4));
  let grant, reservation, completed = false;
  const admission = new Promise(resolve => { grant = resolve; });
  attachStorageAdmission(worker, signal, operation => {
    reservation = (async () => {
      if (!admitted) await admission;
      await operation();
      completed = true;
    })();
    return reservation;
  });
  worker.emit('message', { storage: 'acquire', id: 1 });
  await turn();
  assert(reservation, 'The parent queue received the storage request');
  assert.equal(Atomics.load(signal, 0), admitted ? 1 : 0);
  const stopped = terminateStorageWorker(worker);
  grant();
  await turn();
  assert.equal(Atomics.load(signal, 0), -1, 'A retiring worker cannot receive fresh admission');
  assert.equal(completed, false, 'Termination request alone must not release the reservation');
  worker.emit('exit', 1);
  await Promise.all([stopped, reservation]);
  assert.equal(completed, true);
});
