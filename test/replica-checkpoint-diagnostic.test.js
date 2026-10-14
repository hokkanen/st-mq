import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readlink, stat, rm, rename } from 'node:fs/promises';
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

const generic = { error: 'Request could not be confirmed. Retry shortly.' };
const mismatch = { code: 'replica_checkpoint_mismatch',
  error: 'The read-only snapshot no longer matches its database checkpoint. Wait for verified synchronization, then refresh.' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { makeChartService, readPublication, sinkFailure = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-replica-diagnostic-'));
  const source = new Store(join(root, 'source.sqlite'));
  const diagnostics = [], publicationReads = [];
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
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { signal: AbortSignal.timeout(5000) });
    const bytes = await response.text(), body = JSON.parse(bytes);
    if (body.code === mismatch.code) assert.equal(bytes, JSON.stringify(mismatch), 'The exact public refusal body remains unchanged');
    return { status: response.status, body };
  };
  return { root, source, directory, publication, app, request, now, diagnostics, publicationReads };
}

const phaseDiagnostic = (latestManifestState, changes = {}) => ({ event: 'replica-read-refused', route: 'recording-health',
  attempt: 1, rollbackConfirmed: true, closed: false, latestManifestState, suppressed: 0, suppressedClipped: false, ...changes });

function chartBoundaries(t) {
  const pending = [], all = [];
  let created = 0;
  t.after(() => { for (const boundary of all) boundary.released.resolve(); });
  return {
    get created() { return created; },
    arm() {
      const boundary = { entered: deferred(), released: deferred(), store: null };
      pending.push(boundary); all.push(boundary); return boundary;
    },
    makeChartService({ store }) {
      created++;
      const service = createChartService({ store }), pin = service.pin.bind(service);
      const boundary = pending.shift();
      service.pin = async (...args) => {
        await pin(...args);
        if (boundary) {
          boundary.store = store;
          boundary.entered.resolve();
          await boundary.released.promise;
        }
      };
      return service;
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

test('a completed newer publication is verified after an older chart-worker refresh loses its checkpoint', async t => {
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
  assert.equal(charts.created, 3, 'Only one new verified generation is opened for this request');
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
  assert.deepEqual(f.diagnostics, [phaseDiagnostic('not-checked', { attempt: 2 })]);
  assert.equal(charts.created, 3, 'This request cannot chase successive publications');
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
  assert.deepEqual(f.diagnostics, [phaseDiagnostic('not-checked', { rollbackConfirmed: false })]);
  assert.equal(charts.created, 2, 'Cleanup failure cannot open the next generation');
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
  assert.deepEqual(f.diagnostics, [phaseDiagnostic('unreadable')]);
  assert.equal(charts.created, 2);
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
  assert.deepEqual(f.diagnostics, [phaseDiagnostic('missing')]);
  assert.equal(charts.created, 2);
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
  assert.equal(charts.created, 2, 'A closed viewer cannot open the next generation');
  assert.throws(() => f.app.store.checkpoint(), 'The original reader is closed too');
});

test('real incremental publication exposes only a typed status/health refusal and preserves the fence through recovery', async t => {
  const f = await fixture(t, { sinkFailure: 'throw' }), inode = (await stat(f.publication.dbPath)).ino;
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  f.source.event('synthetic-unpublished-event', { value: 'synthetic-private-row' }, f.now + 1);
  const target = f.source.checkpoint(), transfers = new PeerTransfers(join(f.root, 'changes'));
  const peer = { request: (operation, value) => operation === 'peer-transfer'
    ? transfers.export({ dbPath: f.source.path, ...value }) : transfers.chunk(value) };
  const transfer = await receivePeerTransfer({ directory: join(f.root, 'receive'), peer, after: f.publication.checkpoint });
  const probe = await open(join(f.root, 'file-handle-probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync; await probe.close();
  const entered = deferred(), released = deferred(); let held = false, publishing;
  t.after(async () => { released.resolve(); prototype.sync = sync; await publishing?.catch(() => {}); });
  // Hold the actual manifest fsync after the producer has committed its rows.
  // SQLite application and checkpoint checks remain the production functions.
  prototype.sync = async function (...args) {
    const path = await readlink(`/proc/self/fd/${this.fd}`).catch(() => null);
    if (!held && path === resolve(f.directory, 'publication.json.tmp')) {
      held = true; entered.resolve(); await released.promise;
    }
    return sync.apply(this, args);
  };
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
  assert.deepEqual(await f.request('/api/events'), { status: 503, body: generic }, 'Other routes retain their generic refusal');
  assert.deepEqual(boundaries, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
  assert.equal(f.publicationReads.length - reads, 6, 'Each original refusal keeps its existing refresh and one manifest check');
  assert.deepEqual(f.diagnostics, [phaseDiagnostic('same', { route: 'status' })], 'The health refusal is capped, while both public responses retain their original bodies');
  assert.ok(sameCheckpoint(await databaseCheckpoint({ dbPath: f.publication.dbPath }), target), 'Refused reads cannot mutate the committed database');
  released.resolve(); await publishing; prototype.sync = sync;
  for (const path of ['/api/status', '/api/recording-health']) assert.equal((await f.request(path)).status, 200);
  const publication = await readReplicaPublication(f.directory);
  assert.ok(sameCheckpoint(publication.checkpoint, target));
  assert.equal((await stat(publication.dbPath)).ino, inode);
  const reader = new Store(publication.dbPath, { readOnly: true });
  try { assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='synthetic-unpublished-event'").get().n, 1); }
  finally { reader.close(); }
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
