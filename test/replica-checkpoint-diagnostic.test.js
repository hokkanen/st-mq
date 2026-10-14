import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readlink, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory, publishSnapshot, readReplicaPublication } from '../src/replication/publication.js';
import { acceptPeerPublication, applyPeerPublication } from '../src/replication/journal-publication.js';
import { peerOperation, PeerTransfers, receivePeerTransfer } from '../src/replication/coalesced.js';
import { databaseCheckpoint, sameCheckpoint } from '../src/replication/incremental.js';

const generic = { error: 'Request could not be confirmed. Retry shortly.' };
const mismatch = { code: 'replica_checkpoint_mismatch',
  error: 'The read-only snapshot no longer matches its database checkpoint. Wait for verified synchronization, then refresh.' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-replica-diagnostic-'));
  const source = new Store(join(root, 'source.sqlite'));
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
    makeChartService: () => ({ pin: async () => {}, close: async () => {} }), clock: () => now, installSignalHandlers: false });
  const request = async path => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  return { root, source, directory, publication, app, request, now };
}

test('real incremental publication exposes only a typed status/health refusal and preserves the fence through recovery', async t => {
  const f = await fixture(t), inode = (await stat(f.publication.dbPath)).ino;
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
  for (const path of ['/api/status', '/api/recording-health']) {
    const response = await f.request(path);
    assert.deepEqual(response, { status: 503, body: mismatch });
    assert.equal(JSON.stringify(response).includes('synthetic-private-row'), false);
  }
  assert.deepEqual(await f.request('/api/events'), { status: 503, body: generic }, 'Other routes retain their generic refusal');
  assert.deepEqual(boundaries, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
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
});
