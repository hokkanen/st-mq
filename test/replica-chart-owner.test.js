import test from 'node:test';
import assert from 'node:assert/strict';
import { continuesReplicaCharts, createReplicaChartOwner, leaseReplicaCharts, leaseReplicaEvents } from '../src/app/replica-chart-owner.js';

test('replica cache continuity rejects replacement, identity changes, rewinds and conflicting equal boundaries', () => {
  const publication = { dbPath: '/synthetic/file', fileGeneration: 'synthetic-file',
    checkpoint: { databaseId: 'synthetic-database', sequence: 10, hash: 'synthetic-hash' } };
  const previous = { publication, fileIdentity: '1:2' };
  assert(continuesReplicaCharts(previous, publication, '1:2'));
  assert(continuesReplicaCharts(previous, { ...publication, checkpoint: { ...publication.checkpoint, sequence: 20 } }, '1:2'));
  for (const changes of [
    { dbPath: '/synthetic/replacement' }, { fileGeneration: 'replacement' },
    { checkpoint: { ...publication.checkpoint, sequence: 9 } },
    { checkpoint: { ...publication.checkpoint, hash: 'conflicting-hash' } },
    { checkpoint: { ...publication.checkpoint, databaseId: 'another-database', sequence: 20 } },
    { checkpoint: null },
  ]) assert.equal(continuesReplicaCharts(previous, { ...publication, ...changes }, '1:2'), false);
  assert.equal(continuesReplicaCharts(previous, publication, '1:3'), false);
});

test('event reads share the physical owner across publication leases and retain each requested checkpoint', async () => {
  const reads = [], order = []; let made = 0, release;
  const exit = new Promise(resolve => { release = resolve; });
  const store = { db: {}, path: '/synthetic/file', runStorageTask: operation => operation(),
    storageStatus() {}, writeQueueStatus() {}, writeHealth: { status() {} }, close() { order.push('store'); } };
  const owner = createReplicaChartOwner(store, () => ({ close: async () => { order.push('charts'); } }), {}, ({ store: admission }) => {
    assert.equal(admission.path, store.path); made++;
    return { query: (args, options) => { reads.push({ args, options }); return Promise.resolve('events'); },
      close: async () => { await exit; order.push('events'); } };
  });
  const one = { databaseId: 'synthetic', sequence: 1 }, two = { databaseId: 'synthetic', sequence: 2 };
  const first = leaseReplicaCharts(owner, store, one), second = leaseReplicaCharts(owner, { writeHealth: {} }, two);
  const firstEvents = leaseReplicaEvents(owner, one), secondEvents = leaseReplicaEvents(owner, two);
  const controller = new AbortController();
  assert.equal(await firstEvents.query({ now: 1 }, { signal: controller.signal }), 'events');
  assert.equal(await secondEvents.query({ now: 2, checkpoint: one }), 'events');
  assert.equal(made, 1); assert.deepEqual(reads.map(row => row.args.checkpoint), [one, two]);
  assert.equal(reads[0].options.signal, controller.signal);
  await first.close(); assert.deepEqual(order, []);
  const closing = second.close(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['charts']); release(); await closing;
  assert.deepEqual(order, ['charts', 'events', 'store']);
});

test('publication chart leases capture boundaries, share queue diagnostics and close the backing owner exactly once', async () => {
  const requests = []; let closed = 0, storeClosed = 0;
  const store = { db: {}, path: '/synthetic/file', expectedCheckpoint: { sequence: 1 },
    runStorageTask: operation => operation(), storageStatus: () => 'shared-storage', writeQueueStatus: () => 'shared-queue',
    writeHealth: { status: () => 'shared-health' }, close: () => { storeClosed++; } };
  const owner = createReplicaChartOwner(store, ({ store: admission }) => ({
    query: (args, options) => { requests.push(options.checkpoint); return admission.runStorageTask(() => 'result'); },
    overview: options => { requests.push(options.checkpoint); }, close: async () => { closed++; },
  }), {});
  const one = { sequence: 1 }, two = { sequence: 2 };
  const first = leaseReplicaCharts(owner, store, one);
  const nextStore = { writeHealth: {} }, second = leaseReplicaCharts(owner, nextStore, two);
  owner.admission.expectedCheckpoint = two;
  assert.equal(await first.query({}), 'result'); second.overview();
  assert.deepEqual(requests, [one, two]); assert.deepEqual(store.expectedCheckpoint, { sequence: 1 });
  assert.equal(nextStore.storageStatus(), 'shared-storage'); assert.equal(nextStore.writeQueueStatus(), 'shared-queue');
  assert.equal(nextStore.writeHealth.status(), 'shared-health');
  await first.close(); await first.close(); assert.equal(closed, 0); assert.equal(storeClosed, 0);
  await second.close(); await second.close(); assert.equal(closed, 1); assert.equal(storeClosed, 1);
});
