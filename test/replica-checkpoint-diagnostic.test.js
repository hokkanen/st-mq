import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readlink, stat, rm, rename } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { createChartService } from '../src/app/chart-service.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory, publishSnapshot, readReplicaPublication } from '../src/replication/publication.js';
import { acceptPeerPublication, applyPeerPublication } from '../src/replication/journal-publication.js';
import { peerOperation, PeerTransfers, receivePeerTransfer } from '../src/replication/coalesced.js';
import { databaseCheckpoint, sameCheckpoint } from '../src/replication/incremental.js';
import { checkpointAt, journalBase } from '../src/storage/journal.js';

const generic = { error: 'Request could not be confirmed. Retry shortly.' };
const mismatch = { code: 'replica_checkpoint_mismatch',
  error: 'The read-only snapshot no longer matches its database checkpoint. Wait for verified synchronization, then refresh.' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { makeChartService, readPublication, sinkFailure = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-replica-diagnostic-'));
  const source = new Store(join(root, 'source.sqlite'));
  const diagnostics = [], publicationReads = [], requestClocks = [];
  t.mock.method(console, 'error', text => {
    diagnostics.push(JSON.parse(text));
    if (sinkFailure === 'throw') throw Error('Synthetic private diagnostic sink failure');
    if (sinkFailure === 'reject') return Promise.reject(Error('Synthetic private diagnostic sink rejection'));
  });
  let app;
  t.after(async () => { await app?.close(); source.close(); await rm(root, { recursive: true, force: true }); });
  const now = Date.now(); source.event('decision', { input: 'mqtt', phase: 'pause', commands: [] }, now);
  const directory = join(root, 'replica'); await ownedDirectory(directory, '.st-mq-replica');
  await peerOperation('enroll', { dbPath: source.path });
  const generation = randomUUID(), incoming = join(directory, `incoming-${generation}.sqlite`);
  const seed = await createSourceSnapshot({ dbPath: source.path, destination: incoming });
  await publishSnapshot(directory, incoming, { ...seed, generation, verifiedAt: now });
  const publication = await acceptPeerPublication({ directory });
  app = await startReplica({ config: { topology: 'mirror', role: 'slave', input: 'mqtt', addon: false,
    host: '127.0.0.1', port: 0, token: '', dataDir: root, dbPath: publication.dbPath, databaseDir: directory,
    mirror: { directory, intervalMs: 60_000 }, recording: { backupDirectory: join(root, 'backups'), fullVerificationIntervalMs: 0 },
    connections: {}, h66: { enabled: false, writeEnabled: false } },
    makeChartService: makeChartService ?? (() => ({ pin: async () => {}, close: async () => {} })),
    readPublication: (...args) => {
      publicationReads.push(true);
      return (readPublication ?? readReplicaPublication)(...args);
    }, clock: () => now, installSignalHandlers: false });
  const request = async path => {
    const startedAt = Date.now(), startedMonotonicMs = performance.now();
    // These requests deliberately wait while the test transfers and syncs a
    // newer publication behind a held gate. Bound fixture cleanup without
    // treating the speed of that unrelated forced I/O as a response deadline.
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { signal: AbortSignal.timeout(30000) });
    const bytes = await response.text(), body = JSON.parse(bytes);
    requestClocks.push({ route: path.slice('/api/'.length), status: response.status,
      startedAt, startedMonotonicMs, finishedAt: Date.now(), finishedMonotonicMs: performance.now() });
    if (body.code === mismatch.code) assert.equal(bytes, JSON.stringify(mismatch), 'The exact public refusal body remains unchanged');
    return { status: response.status, body };
  };
  return { root, source, directory, publication, app, request, now, diagnostics, publicationReads, requestClocks };
}

const phaseDiagnostic = (latestManifestState, changes = {}) => ({ event: 'replica-read-refused', route: 'recording-health',
  attempt: 1, rollbackConfirmed: true, closed: false, latestManifestState, suppressed: 0, suppressedClipped: false, ...changes });

function phaseDiagnostics(f) {
  return f.diagnostics.map(record => {
    const { reportedAt, monotonicMs, ...phase } = record;
    assert(Number.isSafeInteger(reportedAt) && reportedAt >= 0 && reportedAt <= 8640000000000000);
    assert(Number.isFinite(monotonicMs) && monotonicMs >= 0 && monotonicMs <= Number.MAX_SAFE_INTEGER);
    assert(f.requestClocks.some(request => request.status === 503 && request.route === record.route
      && reportedAt >= request.startedAt && reportedAt <= request.finishedAt
      && monotonicMs >= request.startedMonotonicMs && monotonicMs <= request.finishedMonotonicMs),
    'The actual refusal reporter clocks fall inside the original HTTP request receipt brackets');
    assert(Buffer.byteLength(JSON.stringify(record)) <= 384);
    return phase;
  });
}

function chartBoundaries(t) {
  const pending = [], all = [];
  let created = 0, candidate;
  const checkpoint = Store.prototype.checkpoint, originalStat = filesystem.stat;
  t.mock.method(Store.prototype, 'checkpoint', function (...args) {
    if (this.readOnly) candidate = this;
    return checkpoint.apply(this, args);
  });
  // Continuing publications no longer create/pin another chart worker. Hold
  // the real refresh after its native snapshot check instead, exercising the
  // same publication/lease race without requiring the obsolete worker churn.
  filesystem.stat = async (...args) => {
    const result = await originalStat(...args);
    if (pending.length && candidate?.path === args[0]) {
      const boundary = pending.shift(); boundary.store = candidate;
      boundary.entered.resolve(); await boundary.released.promise;
    }
    return result;
  };
  syncBuiltinESMExports();
  t.after(() => {
    for (const boundary of all) boundary.released.resolve();
    filesystem.stat = originalStat; syncBuiltinESMExports();
  });
  return {
    get created() { return created; },
    arm() {
      const boundary = { entered: deferred(), released: deferred(), store: null };
      pending.push(boundary); all.push(boundary); return boundary;
    },
    makeChartService({ store }) {
      created++;
      return createChartService({ store });
    },
  };
}

function publicationUpdates(f) {
  const transfers = new PeerTransfers(join(f.root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  let publication = f.publication;
  return async label => {
    f.source.event(label, { synthetic: true }, f.now);
    const target = f.source.checkpoint();
    const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer, after: publication.checkpoint });
    publication = await applyPeerPublication({ directory: f.directory, transfer,
      metadata: { ...publication, generation: randomUUID() } });
    assert.ok(sameCheckpoint(publication.checkpoint, target));
    return publication;
  };
}

test('real coalesced catch-up retains completed charts after pruning the previous journal boundary', async t => {
  let created = 0;
  const f = await fixture(t, { makeChartService: options => { created++; return createChartService(options); } });
  const path = '/api/chart?start=2026-01-15&end=2026-01-15&view=garage';
  const first = await f.request(path); assert.equal(first.status, 200);
  const previous = f.publication.checkpoint;
  const publication = await publicationUpdates(f)('synthetic-cache-continuation');
  assert.equal(checkpointAt(f.app.store.db, previous.sequence), null, 'Normal coalescing removed the old prefix');
  const next = await f.request(path);
  assert.equal(next.status, 200); assert.equal(next.body.meta.cacheHit, true);
  assert.equal(created, 1); assert.deepEqual(next.body.series, first.body.series);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), publication.checkpoint));
});

test('a completed newer publication is verified after an older refresh loses its checkpoint', async t => {
  const charts = chartBoundaries(t), f = await fixture(t, charts), update = publicationUpdates(f);
  const inode = (await stat(f.publication.dbPath)).ino;
  const first = await update('synthetic-first-published-event');
  const boundary = charts.arm(), waiting = f.request('/api/recording-health');
  await boundary.entered.promise;
  assert.ok(sameCheckpoint(boundary.store.checkpoint(), first.checkpoint));
  const second = await update('synthetic-second-published-event');
  assert.ok(sameCheckpoint((await readReplicaPublication(f.directory)).checkpoint, second.checkpoint));
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), second.checkpoint));
  assert.ok(sameCheckpoint(boundary.store.checkpoint(), first.checkpoint), 'The old read transaction remains coherent');
  const reads = f.publicationReads.length;
  boundary.released.resolve();
  assert.equal((await waiting).status, 200, 'A completed current publication can satisfy this original request');
  assert.equal(f.publicationReads.length - reads, 2, 'Only the original manifest check and verified retry refresh run');
  assert.deepEqual(f.diagnostics, [], 'A completed different generation adds no refusal diagnostic');
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), second.checkpoint));
  assert.equal(charts.created, 1, 'Verified generations share the physical file cache');
  assert.equal((await stat(f.publication.dbPath)).ino, inode);
  const status = await f.request('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.sync.generation, second.generation);
  assert.equal(status.body.sync.snapshotAt, second.sourceAt, 'Publication time is not replaced by the retry clock');
});

test('a second completed publication race still refuses after the one verified read attempt', async t => {
  const charts = chartBoundaries(t), f = await fixture(t, charts), update = publicationUpdates(f);
  await update('synthetic-first-published-event');
  const first = charts.arm(), waiting = f.request('/api/recording-health');
  await first.entered.promise;
  const second = await update('synthetic-second-published-event'), retry = charts.arm();
  first.released.resolve();
  await retry.entered.promise;
  assert.ok(sameCheckpoint(retry.store.checkpoint(), second.checkpoint));
  const third = await update('synthetic-third-published-event');
  assert.ok(sameCheckpoint((await readReplicaPublication(f.directory)).checkpoint, third.checkpoint));
  const reads = f.publicationReads.length;
  retry.released.resolve();
  assert.deepEqual(await waiting, { status: 503, body: mismatch });
  assert.equal(f.publicationReads.length, reads, 'A second mismatch adds no manifest check');
  assert.deepEqual(phaseDiagnostics(f), [phaseDiagnostic('not-checked', { attempt: 2 })]);
  assert.equal(charts.created, 1, 'This request cannot churn chart workers across publications');
  assert.equal((await f.request('/api/recording-health')).status, 200);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), third.checkpoint));
});

test('a failed rollback does not admit a newer publication or expose its cleanup failure', async t => {
  const charts = chartBoundaries(t), f = await fixture(t, charts), update = publicationUpdates(f);
  await update('synthetic-first-published-event');
  const boundary = charts.arm(), waiting = f.request('/api/recording-health');
  await boundary.entered.promise;
  const second = await update('synthetic-second-published-event');
  const exec = boundary.store.db.exec.bind(boundary.store.db);
  let rollbacks = 0;
  const mocked = t.mock.method(boundary.store.db, 'exec', sql => {
    if (sql === 'ROLLBACK' && ++rollbacks === 2) throw Error('Synthetic private cleanup failure');
    return exec(sql);
  });
  t.after(() => { mocked.mock.restore(); });
  const reads = f.publicationReads.length;
  boundary.released.resolve();
  assert.deepEqual(await waiting, { status: 503, body: mismatch });
  assert.equal(f.publicationReads.length, reads, 'Failed cleanup cannot read or admit another manifest');
  assert.deepEqual(phaseDiagnostics(f), [phaseDiagnostic('not-checked', { rollbackConfirmed: false })]);
  assert.equal(charts.created, 1, 'Cleanup failure cannot open another cache owner');
  mocked.mock.restore();
  exec('ROLLBACK');
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), second.checkpoint));
  assert.equal((await f.request('/api/recording-health')).status, 200);
});

test('an unreadable current manifest retains the original verified checkpoint refusal', async t => {
  const charts = chartBoundaries(t); let unreadable = false;
  const f = await fixture(t, { ...charts, readPublication: directory => {
    if (unreadable) throw Error('Synthetic private manifest failure');
    return readReplicaPublication(directory);
  } }), update = publicationUpdates(f);
  await update('synthetic-first-published-event');
  const boundary = charts.arm(), waiting = f.request('/api/recording-health');
  await boundary.entered.promise;
  const second = await update('synthetic-second-published-event');
  unreadable = true; const reads = f.publicationReads.length; boundary.released.resolve();
  assert.deepEqual(await waiting, { status: 503, body: mismatch });
  assert.equal(f.publicationReads.length - reads, 1, 'The original manifest check runs once');
  assert.deepEqual(phaseDiagnostics(f), [phaseDiagnostic('unreadable')]);
  assert.equal(charts.created, 1);
  unreadable = false;
  assert.equal((await f.request('/api/recording-health')).status, 200);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), second.checkpoint));
});

test('a missing current manifest cannot make the advanced database a readable fallback', async t => {
  const charts = chartBoundaries(t), f = await fixture(t, charts), update = publicationUpdates(f);
  await update('synthetic-first-published-event');
  const boundary = charts.arm(), waiting = f.request('/api/recording-health');
  await boundary.entered.promise;
  const second = await update('synthetic-second-published-event');
  const manifest = join(f.directory, 'publication.json'), held = join(f.directory, 'publication-held.json');
  await rename(manifest, held);
  const reads = f.publicationReads.length;
  boundary.released.resolve();
  assert.deepEqual(await waiting, { status: 503, body: mismatch });
  assert.equal(f.publicationReads.length - reads, 1, 'Missing manifest adds no fallback or retry');
  assert.deepEqual(phaseDiagnostics(f), [phaseDiagnostic('missing')]);
  assert.equal(charts.created, 1);
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), second.checkpoint));
  await rename(held, manifest);
  assert.equal((await f.request('/api/recording-health')).status, 200);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), second.checkpoint));
});

test('closing the viewer during the fresh-manifest check cannot acquire a new read lease', async t => {
  const charts = chartBoundaries(t), entered = deferred(), released = deferred();
  let holdManifest = false;
  t.after(() => released.resolve());
  const f = await fixture(t, { ...charts, readPublication: async directory => {
    const publication = await readReplicaPublication(directory);
    if (holdManifest) { holdManifest = false; entered.resolve(); await released.promise; }
    return publication;
  } }), update = publicationUpdates(f);
  await update('synthetic-first-published-event');
  const boundary = charts.arm();
  const waiting = f.request('/api/recording-health').then(response => ({ response }), () => ({ transportLost: true }));
  await boundary.entered.promise;
  await update('synthetic-second-published-event');
  holdManifest = true; boundary.released.resolve();
  await entered.promise;
  const reads = f.publicationReads.length;
  const closing = f.app.close();
  released.resolve();
  const result = await waiting;
  await closing;
  assert.equal(f.publicationReads.length, reads, 'Close adds no manifest check or new lease');
  assert.deepEqual(f.diagnostics, [], 'The unchanged close/transport failure is not classified as a served typed refusal');
  assert.ok(result.transportLost || result.response.status !== 200);
  assert.equal(charts.created, 1, 'A closed viewer cannot open another cache owner');
  assert.throws(() => f.app.store.checkpoint(), 'The original reader is closed too');
});

test('a slow prepared manifest keeps the old verified publication readable before SQLite apply', async t => {
  const f = await fixture(t, { makeChartService: ({ store }) => createChartService({ store }) });
  assert.equal((await f.request('/api/recording-health')).status, 200);
  f.source.event('synthetic-prepared-manifest', { synthetic: true }, f.now + 1);
  const target = f.source.checkpoint(), transfers = new PeerTransfers(join(f.root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer, after: f.publication.checkpoint });
  const probe = await open(join(f.root, 'file-handle-probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync; await probe.close();
  const entered = deferred(), released = deferred(); let held = false, publishing, timer;
  t.after(async () => { released.resolve(); prototype.sync = sync; await publishing?.catch(() => {}); });
  prototype.sync = async function (...args) {
    const path = await readlink(`/proc/self/fd/${this.fd}`).catch(() => null);
    if (!held && path === resolve(f.directory, 'publication.json.tmp')) {
      held = true; entered.resolve(); await released.promise;
    }
    return sync.apply(this, args);
  };
  publishing = applyPeerPublication({ directory: f.directory, transfer, metadata: { ...f.publication, generation: randomUUID() } });
  try { await Promise.race([entered.promise, publishing.then(() => { throw Error('Manifest gate was not reached'); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Manifest gate timed out')), 15_000); })]); }
  finally { clearTimeout(timer); }
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), f.publication.checkpoint),
    'A slow temporary-file fsync must not strand committed rows under the old manifest');
  assert.ok(sameCheckpoint((await readReplicaPublication(f.directory)).checkpoint, f.publication.checkpoint));
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  assert.deepEqual(f.diagnostics, []);
  released.resolve(); await publishing; prototype.sync = sync;
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), target));
  const final = await readReplicaPublication(f.directory);
  assert.equal(final.sourceStartedAt, transfer.metadata.sourceStartedAt);
  assert.equal(final.sourceAt, transfer.metadata.sourceAt);
});

test('real incremental publication exposes only a typed status/health refusal and preserves the fence through recovery', async t => {
  const f = await fixture(t, { sinkFailure: 'throw' }), inode = (await stat(f.publication.dbPath)).ino;
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  f.source.event('synthetic-unpublished-event', { value: 'synthetic-private-row' }, f.now + 1);
  const target = f.source.checkpoint(), transfers = new PeerTransfers(join(f.root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer, after: f.publication.checkpoint });
  const originalRename = filesystem.rename;
  const entered = deferred(), released = deferred(); let held = false, publishing;
  const restore = () => { filesystem.rename = originalRename; syncBuiltinESMExports(); };
  t.after(async () => { released.resolve(); restore(); await publishing?.catch(() => {}); });
  // Keep the real COMMIT-before-publication gap observable after file fsync
  // moves before apply. A held final rename must still select the same fence.
  filesystem.rename = async (from, to) => {
    if (!held && from === resolve(f.directory, 'publication.json.tmp') && to === resolve(f.directory, 'publication.json')) {
      held = true; entered.resolve(); await released.promise;
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  publishing = applyPeerPublication({ directory: f.directory, transfer, metadata: { ...f.publication, generation: randomUUID() } });
  let timer;
  try { await Promise.race([entered.promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Synthetic publication boundary not reached')), 15_000);
  })]); } finally { clearTimeout(timer); }
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), target));
  assert.ok(sameCheckpoint((await readReplicaPublication(f.directory)).checkpoint, f.publication.checkpoint));
  assert.equal((await stat(f.publication.dbPath)).ino, inode);
  const exec = f.app.store.db.exec.bind(f.app.store.db), boundaries = [];
  t.mock.method(f.app.store.db, 'exec', sql => { boundaries.push(sql); return exec(sql); });
  const reads = f.publicationReads.length;
  for (const path of ['/api/status', '/api/recording-health']) {
    const response = await f.request(path);
    assert.deepEqual(response, { status: 503, body: mismatch });
    assert.equal(JSON.stringify(response).includes('synthetic-private-row'), false);
  }
  assert.deepEqual(await f.request('/api/events'), { status: 503, body: { code: 'event_log_unavailable',
    error: 'The event log could not be refreshed. Previously fetched entries remain available.' } }, 'The event log retains its safe local refusal');
  assert.deepEqual(boundaries, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
  assert.equal(f.publicationReads.length - reads, 6, 'Each original refusal keeps its existing refresh and one manifest check');
  assert.deepEqual(phaseDiagnostics(f), [phaseDiagnostic('same', { route: 'status' })], 'The health refusal is capped, while both public responses retain their original bodies');
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), target), 'Refused reads cannot mutate the committed database');
  released.resolve(); await publishing; restore();
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  const publication = await readReplicaPublication(f.directory);
  assert.ok(sameCheckpoint(publication.checkpoint, target));
  assert.equal((await stat(publication.dbPath)).ino, inode);
  const reader = new Store(publication.dbPath, { readOnly: true });
  try { assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-unpublished-event'").get().n, 1); }
  finally { reader.close(); }
});

async function advanceEventLogPublication(f, index) {
  const previous = await readReplicaPublication(f.directory);
  f.source.event('settings-reloaded', { input: 'mqtt' }, f.now + index);
  const transfers = new PeerTransfers(join(f.root, `event-changes-${index}`));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  const transfer = await receivePeerTransfer({ directory: join(f.root, `event-receive-${index}`), peer, after: previous.checkpoint });
  await applyPeerPublication({ directory: f.directory, transfer, metadata: { ...previous, generation: randomUUID() } });
  const publication = await readReplicaPublication(f.directory), reader = new Store(publication.dbPath, { readOnly: true });
  try {
    assert.equal(checkpointAt(reader.db, previous.checkpoint.sequence), null, 'The real coalesced receiver has pruned the preceding operational boundary');
    assert.ok(journalBase(reader.db).sequence > previous.checkpoint.sequence);
  } finally { reader.close(); }
  return publication;
}
async function eventAdmission(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The isolated event worker did not request storage admission.')), 15000); })]); }
  finally { clearTimeout(timer); }
}

test('event log reacquires once after a real verified publication advances behind queued worker admission', async t => {
  let f;
  const entered = deferred(), released = deferred();
  const native = Store.prototype.runStorageTask; let held = false;
  // Physical-file owners capture admission at construction, before any event
  // request. Install the gate before opening this fixture's owner.
  t.mock.method(Store.prototype, 'runStorageTask', async function(operation, options) {
    if (f && !held && this.readOnly && this.path === f.publication.dbPath) { held = true; entered.resolve(); await released.promise; }
    return native.call(this, operation, options);
  });
  f = await fixture(t);
  const request = f.request('/api/events?view=all');
  try {
    await eventAdmission(entered.promise);
    const publication = await advanceEventLogPublication(f, 1);
    released.resolve();
    const response = await request;
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.scope, 'snapshot');
    assert.equal(response.body.snapshotAt, publication.sourceAt);
    assert.ok(response.body.events.some(row => row.title === 'Configuration applied' && row.at === f.now + 1));
    assert.deepEqual(f.diagnostics, [], 'A verified worker-start race is not a local replica-manifest failure');
  } finally { released.resolve(); await request.catch(() => {}); }
});

test('a second queued event-log checkpoint advance is refused without an unbounded retry loop', async t => {
  let f;
  const entered = [deferred(), deferred()], released = [deferred(), deferred()];
  const native = Store.prototype.runStorageTask, seen = new WeakSet(); let attempts = 0;
  t.mock.method(Store.prototype, 'runStorageTask', async function(operation, options) {
    if (f && this.readOnly && this.path === f.publication.dbPath && !seen.has(f.app.store)) {
      seen.add(f.app.store); const index = attempts++;
      if (index < 2) { entered[index].resolve(); await released[index].promise; }
    }
    return native.call(this, operation, options);
  });
  f = await fixture(t);
  const request = f.request('/api/events?view=all');
  try {
    for (let index = 0; index < 2; index++) {
      await eventAdmission(entered[index].promise);
      await advanceEventLogPublication(f, index + 1);
      released[index].resolve();
    }
    const response = await request;
    assert.equal(response.status, 503); assert.equal(response.body.code, 'event_log_checkpoint_advanced');
    assert.equal(attempts, 2, 'Only the original verified lease and one reacquired lease reach the worker');
    assert.match(response.body.error, /checkpoint is ahead/);
  } finally { released.forEach(gate => gate.resolve()); await request.catch(() => {}); }
});

test('native or unknown read failures cannot counterfeit the authored checkpoint refusal or expose private diagnostics', async t => {
  const f = await fixture(t), original = f.app.store.checkpoint();
  const prepare = f.app.store.db.prepare.bind(f.app.store.db), exec = f.app.store.db.exec.bind(f.app.store.db);
  const boundaries = []; let failing = true;
  t.mock.method(f.app.store.db, 'exec', sql => { boundaries.push(sql); return exec(sql); });
  t.mock.method(f.app.store.db, 'prepare', sql => {
    const statement = prepare(sql);
    if (sql !== 'SELECT database_id,sequence,hash FROM journal_meta WHERE id=1') return statement;
    return { get() {
      if (failing) throw Object.assign(Error('Synthetic private SQLite diagnostic and path'), {
        statusCode: 503, code: 'replica_checkpoint_mismatch', publicMessage: 'Synthetic private counterfeited explanation' });
      return statement.get();
    } };
  });
  for (const path of ['/api/status', '/api/recording-health']) assert.deepEqual(await f.request(path), { status: 503, body: generic });
  assert.deepEqual(boundaries, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
  failing = false;
  assert.equal((await f.request('/api/status')).status, 200);
  assert.ok(sameCheckpoint(f.app.store.checkpoint(), original));
  assert.deepEqual(f.diagnostics, [], 'Unknown native failures acquire neither typed provenance nor private phase logging');
});
