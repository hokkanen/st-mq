import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { createAppServer } from '../src/app/server.js';
import { createChartService } from '../src/app/chart-service.js';
import { ReplicaCheckpointAdvancedError } from '../src/app/chart-read-errors.js';
import { storageOperationHealth } from '../src/storage/operation-health.js';
import { storageOperationsView } from '../chart/storage-health.js';
import { checkpointAt } from '../src/storage/journal.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory, publishSnapshot } from '../src/replication/publication.js';
import { acceptPeerPublication, applyPeerPublication } from '../src/replication/journal-publication.js';
import { peerOperation, PeerTransfers, receivePeerTransfer } from '../src/replication/coalesced.js';

const now = Date.parse('2026-01-15T12:00:00Z');
const path = '/api/chart?start=2026-01-15&end=2026-01-15&view=garage';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const decode = async response => (await response.text()).trim().split('\n').map(JSON.parse);
const historyHealth = () => storageOperationHealth.status().coverage.find(row => row.kind === 'history-query');

for (const role of ['admin', 'family']) for (const coalesced of [false, true])
test(`queued ${role} replica chart retries after ${coalesced ? 'coalesced publication prunes the old checkpoint' : 'a retained forward checkpoint'} and preserves failure evidence`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-chart-retry-'));
  const writer = new Store(join(root, 'source.sqlite'));
  const sample = (value, at) => writer.observation({ source: 'synthetic', device: 'invented-garage',
    signal: 'garage_native_indoor_temperature', value, unit: 'degC', sourceTime: at, receivedAt: at });
  sample(12, now - 60_000);
  writer.event('decision', { input: 'mqtt', phase: 'pause', commands: [] }, now);
  let publication = { dbPath: writer.path, generation: randomUUID(), fileGeneration: randomUUID(),
    sourceAt: now, verifiedAt: now, checkpoint: writer.checkpoint() };
  const directory = coalesced ? join(root, 'replica') : root;
  if (coalesced) {
    await ownedDirectory(directory, '.st-mq-replica');
    await peerOperation('enroll', { dbPath: writer.path });
    const incoming = join(directory, `incoming-${publication.generation}.sqlite`);
    const seed = await createSourceSnapshot({ dbPath: writer.path, destination: incoming });
    await publishSnapshot(directory, incoming, { ...seed, generation: publication.generation, verifiedAt: now });
    publication = await acceptPeerPublication({ directory });
  }
  const entered = deferred(), released = deferred();
  let hold = false, raw, app;
  t.after(async () => { released.resolve(); await app?.close(); writer.close(); await rm(root, { recursive: true, force: true }); });
  app = await startReplica({ config: { topology: 'mirror', role: 'slave', input: 'mqtt', addon: false,
    host: '127.0.0.1', port: 0, token: 'synthetic-admin', familyToken: 'synthetic-family', dbPath: join(root, 'local.sqlite'),
    mirror: { directory, intervalMs: 60_000 }, connections: {},
    charts: { cacheDays: 0, cacheBytes: 64 * 1024 * 1024 } },
    readPublication: async () => publication, clock: () => now, installSignalHandlers: false,
    makeChartService(options) {
      const run = options.store.runStorageTask.bind(options.store);
      options.store.runStorageTask = (operation, settings) => {
        if (hold) { hold = false; entered.resolve(); return released.promise.then(() => run(operation, settings)); }
        return run(operation, settings);
      };
      return raw = createChartService({ ...options, warmCache: false });
    } });
  const before = historyHealth().week.failed;
  // The first worker occupies the lane without requiring an old publication.
  // The HTTP request then queues with A, before the file and manifest advance.
  hold = true;
  const first = raw.query({ input: 'mqtt', now, startDate: '2026-01-15', endDate: '2026-01-15', view: 'garage' }, { checkpoint: null });
  await entered.promise;
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    headers: { Accept: 'application/x-ndjson', Authorization: `Bearer synthetic-${role}` }, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const previousCheckpoint = publication.checkpoint;
  sample(13, now + 1);
  if (coalesced) {
    const transfers = new PeerTransfers(join(root, 'transfers'));
    const peer = { request: (operation, value) => operation === 'peer-transfer'
      ? transfers.export({ dbPath: writer.path, ...value }) : transfers.chunk(value) };
    const transfer = await receivePeerTransfer({ directory: join(root, 'receive'), peer, after: previousCheckpoint });
    publication = await applyPeerPublication({ directory, transfer, metadata: { ...publication, generation: randomUUID() } });
    const current = new DatabaseSync(publication.dbPath, { readOnly: true });
    try { assert.equal(checkpointAt(current, previousCheckpoint.sequence), null, 'The production coalesced update pruned the old boundary'); }
    finally { current.close(); }
  } else publication = { ...publication, generation: randomUUID(), sourceAt: now + 1, verifiedAt: now + 1, checkpoint: writer.checkpoint() };
  released.resolve(); await first;
  const messages = await decode(response);
  assert(messages.some(row => row.type === 'progress'));
  assert.equal(messages.filter(row => row.type === 'result').length, 1);
  assert(!messages.some(row => row.type === 'error'));
  assert(messages.at(-1).data.series.garage_native_indoor_temperature.some(point => point.y === 13));
  assert.deepEqual(app.store.checkpoint(), publication.checkpoint);
  assert.equal(historyHealth().week.failed - before, 1, 'The refused A read is still counted');
  assert.equal(historyHealth().week.lastProblem.reason, 'replica-checkpoint-advanced');
  const view = storageOperationsView({ version: 3, operations: storageOperationHealth.status() }, 'week');
  assert.match(view.coverage.find(row => row.kind === 'history-query').problemDetail, /database checkpoint was ahead of this queued read/);
});

async function httpFixture(t, query, { getAccess, beforeLease, checkpointFor } = {}) {
  const store = new Store(':memory:'), events = [], calls = [];
  const engine = { clock: () => now, config: { input: 'offline' }, contract: () => null };
  let leased = 0;
  const server = createAppServer({ store, engine, getAccess,
    async getReadContext() {
      const revision = ++leased;
      events.push(`lease:${revision}`); await beforeLease?.(revision);
      return { store: { getState: key => ({ key, revision }) },
        checkpoint: checkpointFor ? checkpointFor(revision)
          : { databaseId: '11111111-1111-4111-8111-111111111111', sequence: revision, hash: revision.toString(16).padStart(64, '0') },
        engine: { clock: () => now + revision, config: { input: 'providers' }, contract: () => ({ revision }) },
        chartService: { queryWire: async (args, options) => {
          calls.push({ revision, args });
          return query({ revision, args, options, events });
        } }, release: () => events.push(`release:${revision}`) };
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return { events, calls, fetch: options => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}

for (const accept of ['application/json', 'application/x-ndjson']) test(`retry rebuilds all context arguments and releases both leases for ${accept}`, async t => {
  const f = await httpFixture(t, ({ revision, args, options }) => {
    options.onProgress?.({ stage: 'reading-history' });
    if (revision === 1) throw new ReplicaCheckpointAdvancedError();
    assert.equal(args.now, now + 2);
    assert.deepEqual(args.contract, { revision: 2 });
    assert.deepEqual(args.market, { key: 'provider:market', revision: 2 });
    assert.deepEqual(args.weather, { key: 'provider:weather', revision: 2 });
    return Buffer.from(JSON.stringify(accept.endsWith('ndjson') ? { type: 'result', data: { revision } } : { revision }));
  });
  const response = await f.fetch({ headers: { Accept: accept } });
  if (accept.endsWith('ndjson')) {
    const messages = await decode(response);
    assert.equal(messages.at(-1).data.revision, 2);
    assert(!messages.some(row => row.type === 'error'));
  } else assert.deepEqual(await response.json(), { revision: 2 });
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2', 'release:2']);
});

test('a second checkpoint advancement ends the stream rather than retrying indefinitely', async t => {
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' }); throw new ReplicaCheckpointAdvancedError();
  });
  const messages = await decode(await f.fetch({ headers: { Accept: 'application/x-ndjson' } }));
  assert.equal(messages.filter(row => row.type === 'error').length, 1);
  assert.match(messages.at(-1).message, /checkpoint advanced/);
  assert(!messages.some(row => row.type === 'result'));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2', 'release:2']);
});

for (const change of ['unchanged', 'rollback', 'foreign database'])
test(`a fresh context with ${change} checkpoint cannot authorize the retry`, async t => {
  const databaseId = randomUUID(), other = randomUUID();
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' }); throw new ReplicaCheckpointAdvancedError();
  }, { checkpointFor: revision => ({ databaseId: revision === 2 && change === 'foreign database' ? other : databaseId,
    sequence: revision === 1 ? 10 : change === 'unchanged' ? 10 : change === 'rollback' ? 9 : 11, hash: 'a'.repeat(64) }) });
  const messages = await decode(await f.fetch({ headers: { Accept: 'application/x-ndjson' } }));
  assert.match(messages.at(-1).message, /checkpoint advanced/);
  assert(!messages.some(row => row.type === 'result'));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2', 'release:2']);
});

for (const change of ['foreign database', 'same-sequence hash', 'rollback', 'divergent old hash'])
test(`native worker ${change} mismatch never acquires the forward-retry code`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-chart-mismatch-'));
  const store = new Store(join(root, 'synthetic.sqlite')), old = store.checkpoint();
  store.event('synthetic-forward-write', {}, now);
  const current = store.checkpoint();
  store.expectedCheckpoint = change === 'foreign database' ? { ...current, databaseId: randomUUID() }
    : change === 'same-sequence hash' ? { ...current, hash: '0'.repeat(64) }
      : change === 'rollback' ? { ...current, sequence: current.sequence + 1 }
        : { ...old, hash: '0'.repeat(64) };
  const service = createChartService({ store, warmCache: false, cacheDays: 0 });
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(service.query({ now, input: 'offline', startDate: '2026-01-15', view: 'garage' }), error => {
    assert.match(error.message, /no longer matches/);
    assert.equal(error.code, undefined);
    return true;
  });
  assert.equal(historyHealth().week.lastProblem.reason, 'operation-failed');
});

test('an unrelated history error never acquires a replacement lease', async t => {
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' });
    throw Object.assign(new Error('Synthetic database read failure'), { code: 'SQLITE_IOERR' });
  });
  const messages = await decode(await f.fetch({ headers: { Accept: 'application/x-ndjson' } }));
  assert.match(messages.at(-1).message, /Synthetic database read failure/);
  assert.deepEqual(f.events, ['lease:1', 'release:1']);
});

test('a failed verified refresh ends the request without reusing the old lease', async t => {
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' }); throw new ReplicaCheckpointAdvancedError();
  }, { beforeLease(revision) { if (revision === 2) throw new Error('Synthetic verified snapshot unavailable'); } });
  const messages = await decode(await f.fetch({ headers: { Accept: 'application/x-ndjson' } }));
  assert.equal(f.calls.length, 1);
  assert.match(messages.at(-1).message, /Synthetic verified snapshot unavailable/);
  assert(!messages.some(row => row.type === 'result'));
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2']);
});

test('revoked access during fresh lease acquisition prevents the retried query', async t => {
  let access = { enabled: true, token: '', familyToken: '', tokenRequired: false };
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' }); throw new ReplicaCheckpointAdvancedError();
  }, { getAccess: () => access, beforeLease(revision) { if (revision === 2) access = { ...access, enabled: false }; } });
  const messages = await decode(await f.fetch({ headers: { Accept: 'application/x-ndjson' } }));
  assert.deepEqual(messages.at(-1), { type: 'error', message: 'Direct web access is disabled', status: 503 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2', 'release:2']);
});

test('disconnect during fresh lease acquisition cancels the request and releases its new lease', async t => {
  const entered = deferred(), released = deferred(), aborted = deferred(), done = deferred();
  const f = await httpFixture(t, ({ options }) => {
    options.onProgress?.({ stage: 'reading-history' });
    options.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    throw new ReplicaCheckpointAdvancedError();
  }, { async beforeLease(revision) { if (revision === 2) { entered.resolve(); await released.promise; } } });
  // Resolve cleanup even when an assertion fails before the simulated refresh.
  t.after(() => released.resolve());
  const controller = new AbortController();
  const response = await f.fetch({ headers: { Accept: 'application/x-ndjson' }, signal: controller.signal });
  const body = response.text().catch(() => {});
  await entered.promise; controller.abort(); await aborted.promise; released.resolve(); await body;
  // A subsequent event-loop turn lets the asynchronous request finally run.
  setImmediate(() => done.resolve()); await done.promise;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, ['lease:1', 'release:1', 'lease:2', 'release:2']);
});

test('a native worker rollback failure cannot authorize a checkpoint retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-chart-cleanup-'));
  const store = new Store(join(root, 'synthetic.sqlite'));
  store.expectedCheckpoint = store.checkpoint();
  store.event('synthetic-forward-write', {}, now);
  const OriginalWorker = workerThreads.Worker;
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { DatabaseSync } from 'node:sqlite';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'ROLLBACK' && this.isTransaction) throw new Error('Synthetic native rollback failure');
      return exec.call(this, sql);
    };
  `);
  workerThreads.Worker = class extends OriginalWorker {
    constructor(url, options) {
      super(url, String(url).endsWith('/chart-worker.js')
        ? { ...options, execArgv: ['--import', preload] } : options);
    }
  };
  syncBuiltinESMExports();
  let service;
  t.after(async () => {
    await service?.close(); store.close();
    workerThreads.Worker = OriginalWorker; syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  service = createChartService({ store, warmCache: false, cacheDays: 0 });
  await assert.rejects(service.query({ now, input: 'offline', startDate: '2026-01-15', view: 'garage' }), error => {
    assert.match(error.message, /checkpoint advanced/);
    assert.equal(error.code, undefined, 'A failed rollback strips permission to retry the mismatch');
    return true;
  });
  assert.equal(historyHealth().week.lastProblem.reason, 'cleanup-failed');
});
