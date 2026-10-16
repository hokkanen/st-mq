import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { storageOperationHealth, observeStorageOperation } from '../src/storage/operation-health.js';
import { startHistoryLearning } from '../src/app/learning.js';
import { publishLearning } from '../src/app/learning-publication.js';
import { createRecoveryHistoryReader } from '../src/app/history-recovery-reader.js';
import { createBackupInspection } from '../src/app/backup-inspection.js';

const row = kind => storageOperationHealth.status().coverage.find(value => value.kind === kind);
test('observer failure cannot replace successful work or the original owner error', async () => {
  const begin = storageOperationHealth.begin, expected = Error('synthetic original owner failure');
  try {
    storageOperationHealth.begin = () => { throw Error('synthetic observer failure'); };
    assert.equal(await observeStorageOperation('backup', () => 17), 17);
    await assert.rejects(observeStorageOperation('backup', () => { throw expected; }), error => error === expected);
    storageOperationHealth.begin = () => ({ finish() { throw Error('synthetic observer failure'); } });
    assert.equal(await observeStorageOperation('backup', () => 23), 23);
    await assert.rejects(observeStorageOperation('backup', () => { throw expected; }), error => error === expected);
  } finally { storageOperationHealth.begin = begin; }
});

test('worker construction and synchronous publication admission failures never leak observations', () => {
  const expected = Error('synthetic startup failure'), before = row('learning-rebuild').week.failed;
  class BrokenWorker { constructor() { throw expected; } }
  assert.throws(() => startHistoryLearning({ store: { path: '/synthetic/example.sqlite' }, WorkerClass: BrokenWorker }), error => error === expected);
  assert.equal(row('learning-rebuild').running, 0);
  assert.equal(row('learning-rebuild').week.failed, before + 1);
  const publicationBefore = row('learning-publication').week.failed;
  assert.throws(() => publishLearning({ store: { checkpoint: () => ({ databaseId: 'synthetic' }),
    runPublication() { throw expected; } }, input: 'mqtt', kind: 'correction' }), error => error === expected);
  assert.equal(row('learning-publication').queued, 0);
  assert.equal(row('learning-publication').week.failed, publicationBefore + 1);
});

test('history readers observe actual shared jobs once and retain active cancellation until worker join', async () => {
  const workers = [], before = row('history-query').week;
  let release;
  class Worker extends EventEmitter {
    constructor() { super(); this.messages = []; workers.push(this); }
    postMessage(value) { this.messages.push(value); }
    terminate() { return new Promise(resolve => { release = resolve; }); }
  }
  const reader = createRecoveryHistoryReader({ path: '/synthetic/example.sqlite' }, { WorkerClass: Worker });
  for (let index = 0; index < 100; index++) reader.snapshot('mqtt', { limit: 50 });
  assert.equal(workers[0].messages.length, 1);
  assert.equal(row('history-query').queued, 1);
  const id = workers[0].messages[0].id;
  workers[0].emit('message', { id, storageOperationStart: true });
  assert.equal(row('history-query').running, 1);
  workers[0].emit('message', { id, rows: [] });
  for (let index = 0; index < 100; index++) reader.snapshot('mqtt', { limit: 50 });
  assert.equal(row('history-query').week.completed, before.completed + 1);
  assert.equal(workers[0].messages.length, 1);
  for (let index = 0; index < 8; index++) reader.snapshot('mqtt', { limit: 50, before: `${index}:synthetic` });
  reader.snapshot('mqtt', { limit: 50, before: '9:synthetic' });
  assert.equal(row('history-query').week.refused, before.refused + 1);
  const closing = reader.close();
  assert.equal(row('history-query').queued, 8, 'closing work remains observed until its owning worker releases');
  release(); await closing;
  assert.equal(row('history-query').queued, 0);
  assert.equal(row('history-query').week.cancelled, before.cancelled + 8);
});

test('failed saved-copy acquisition never changes authoritative download receipts', async () => {
  const events = [], expected = Error('synthetic copy unavailable');
  const inspection = createBackupInspection({ catalog: { open() { throw expected; } }, onDownloadEvent: event => events.push(event) });
  const before = row('backup-download').week.failed;
  try {
    await assert.rejects(inspection.download({ sourceId: 'synthetic', response: {}, authorized: () => true }), error => error === expected);
    assert.deepEqual(events, []);
    assert.equal(row('backup-download').week.failed, before + 1);
    assert.equal(row('backup-download').running, 0);
  } finally { await inspection.close(); }
});
