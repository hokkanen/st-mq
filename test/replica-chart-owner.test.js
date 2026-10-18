import test from 'node:test';
import assert from 'node:assert/strict';
import { continuesReplicaCharts, createReplicaChartOwner, leaseReplicaCharts } from '../src/app/replica-chart-owner.js';

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
