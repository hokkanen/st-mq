import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { createWriteHealth } from '../src/storage/write-health.js';
import { createRecordingHealth, diskSpaceStatus } from '../src/app/recording-health.js';
import { createAppServer } from '../src/app/server.js';
import { createWebAccess } from '../src/app/web-access.js';

const MINUTE = 60_000, GIB = 1024 ** 3, start = Date.parse('2026-10-07T12:00:00Z');
const capacity = (free = 20 * GIB, total = 100 * GIB) => ({ blocks: total / 4096, bavail: free / 4096, bsize: 4096 });
function fixture(options = {}) {
  let now = start;
  const state = new Map();
  const store = { path: '/invented/storage/history.sqlite', readOnly: false,
    getState: key => state.get(key) ?? null, setState: (key, value) => state.set(key, structuredClone(value)),
    writeHealth: createWriteHealth(() => now) };
  const engine = { config: { input: 'mqtt' }, latestStatus: { now } };
  const parameter = { observedThisRun: true, signal: 'indoor_temperature', lastPollAt: now,
    freshness: { status: 'held', sourceObservedAt: now, maxAgeMs: null } };
  const current = { input: 'mqtt', recording: { parameters: [], exactParameters: [parameter] } };
  const config = { dbPath: store.path, recording: { exportDirectory: '/invented/exports' } };
  const health = createRecordingHealth({ clock: () => now, getConfig: () => config,
    filesystem: async () => capacity(), savedBackups: async () => [], ...options });
  return { health, store, engine, current, parameter, config, state,
    status: (overrides = {}) => health.status({ store, engine, current, ...overrides }),
    advance: ms => { now += ms; }, now: () => now };
}

test('disk pressure uses application-available blocks, with absolute and bounded percentage thresholds', () => {
  assert.equal(diskSpaceStatus(capacity(), start).state, 'ok');
  assert.equal(diskSpaceStatus(capacity(3 * GIB), start).state, 'low');
  assert.equal(diskSpaceStatus(capacity(GIB / 2), start).state, 'critical');
  assert.equal(diskSpaceStatus(capacity(6 * GIB, 10_000 * GIB), start).state, 'ok', 'large volumes do not demand hundreds of GB');
  assert.equal(diskSpaceStatus({ ...capacity(), bavail: 0, bfree: 100_000 }, start).freeBytes, 0, 'reserved blocks are not available');
  assert.throws(() => diskSpaceStatus(capacity(-1), start));
});

test('held readings do not need new observation rows and a stale tick is not refreshed by the status clock', async () => {
  const f = fixture();
  assert.equal((await f.status()).recording.state, 'ok');
  f.advance(4 * MINUTE); f.current.now = f.now();
  assert.equal((await f.status()).recording.state, 'stalled');
  f.engine.latestStatus.now = f.now();
  assert.equal((await f.status()).recording.state, 'ok');
  f.parameter.freshness = { status: 'fresh', sourceObservedAt: start, maxAgeMs: MINUTE };
  assert.equal((await f.status()).recording.state, 'source-unavailable');
});

test('a live loop that never completed warns, while an intentional replica never expects local recording', async () => {
  const f = fixture({ filesystem: async () => capacity(GIB / 2) });
  f.engine.latestStatus = null; f.current.recording = { parameters: [] };
  assert.equal((await f.status()).recording.state, 'starting');
  f.advance(4 * MINUTE);
  assert.equal((await f.status()).recording.state, 'stalled');
  f.engine.latestStatus = { now: f.now() };
  assert.equal((await f.status()).recording.state, 'source-unavailable', 'an active loop without any confirmed source still needs attention');
  const replica = await f.status({ readOnly: true });
  assert.equal(replica.scope, 'snapshot'); assert.equal(replica.recording.state, 'read-only');
  assert.deepEqual(replica.attention.map(row => row.id), ['disk-space']);
});

test('disk and catalog refreshes are coalesced and failed filesystem checks do not become zero bytes', async () => {
  let diskCalls = 0, catalogCalls = 0;
  const f = fixture({ filesystem: async () => { diskCalls++; throw new Error('/private/path'); },
    savedBackups: async () => { catalogCalls++; return []; } });
  const results = await Promise.all([f.status(), f.status(), f.status()]);
  assert.equal(diskCalls, 1); assert.equal(catalogCalls, 1);
  assert.equal(results[0].disk.state, 'unknown'); assert.equal(results[0].disk.freeBytes, null);
  assert(!JSON.stringify(results).includes('/private/path'));
  await f.status(); assert.equal(diskCalls, 1);
  f.advance(MINUTE); await f.status(); assert.equal(diskCalls, 2); assert.equal(catalogCalls, 1);
});

test('a hung filesystem refresh cannot relabel old free-space evidence as a current healthy check', async () => {
  let hung = false;
  const f = fixture({ filesystem: () => hung ? new Promise(() => {}) : Promise.resolve(capacity(GIB / 2)) });
  assert.equal((await f.status()).disk.state, 'critical');
  hung = true; f.advance(3 * MINUTE); f.engine.latestStatus.now = f.now();
  const result = await f.status();
  assert.equal(result.disk.state, 'unknown'); assert.equal(result.disk.freeBytes, null);
  assert(result.attention.some(row => row.id === 'disk-check' && row.severity === 'critical'));
});

test('backup discovery is not verification and no age-based schedule or automatic copy is invented', async () => {
  const old = start - 365 * 86_400_000;
  const f = fixture({ savedBackups: async () => [{ path: '/private/household.sqlite', createdAt: old, bytes: 7 }] });
  const result = await f.status();
  assert.equal(result.backup.state, 'available'); assert.equal(result.backup.latestAt, old);
  assert.equal(result.backup.latestVerifiedAt, null); assert.equal(result.attention.length, 0);
  assert(!JSON.stringify(result).includes('/private/household.sqlite'));
  assert.equal(f.state.size, 0, 'reading health never writes a receipt or creates a backup');
});

test('backup completion, cancellation, failure and browser transfer remain separate evidence', async () => {
  const f = fixture();
  const event = (phase, more = {}) => f.health.backupEvent({ phase, kind: 'download', at: f.now(), ...more }, f.store);
  event('start'); assert.equal((await f.status()).backup.state, 'running');
  assert.equal(f.state.size, 0, 'a pending backup is not copied into its own snapshot as interrupted');
  event('cancelled'); assert.equal((await f.status()).backup.state, 'none-known');
  event('start'); event('failed', { errorCode: 'ENOSPC' });
  assert.equal((await f.status()).backup.state, 'failed');
  assert.equal(f.state.get('storage:backup-health').failure.errorCode, 'disk-full');
  f.advance(1); event('start'); event('complete');
  const completed = await f.status();
  assert.equal(completed.backup.state, 'available'); assert.equal(completed.backup.latestVerifiedAt, null);
  assert.match(completed.backup.detail, /browser.*cannot be verified/);
});

test('backup failure survives restart but an empty replacement store cannot inherit it', async () => {
  const f = fixture();
  f.health.backupEvent({ phase: 'failed', kind: 'saved-copy', at: start, errorCode: 'database_publication_unconfirmed' }, f.store);
  const restarted = createRecordingHealth({ clock: f.now, savedBackups: async () => [], filesystem: async () => capacity() });
  assert.equal((await restarted.status({ store: f.store })).backup.state, 'failed');
  const fresh = { ...f.store, getState: () => null };
  assert.equal((await restarted.status({ store: fresh })).backup.state, 'none-known');
});

test('failed write evidence survives broken receipt persistence without exposing SQL or private paths', async () => {
  const f = fixture();
  f.store.writeHealth.failure({ errcode: 13, message: 'private values in /secret/path' });
  f.store.setState = () => { throw new Error('database full'); };
  f.health.backupEvent({ phase: 'failed', kind: 'saved-copy', at: start, errorCode: '/private/path' }, f.store);
  const result = await f.status();
  assert.equal(result.recording.state, 'write-failed'); assert.equal(result.backup.state, 'failed');
  assert(!JSON.stringify(result).includes('/private/path')); assert(!JSON.stringify(result).includes('/secret/path'));
  f.advance(1); f.store.writeHealth.success();
  assert.equal((await f.status()).recording.state, 'ok');
  assert((await f.status()).attention.some(row => row.id === 'recording-resumed'));
});

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-write-health-'));
  const store = new Store(join(directory, 'history.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test('real SQLite full errors are retained through no-op writes and clear only after an actual commit', t => {
  const store = database(t);
  store.setState('existing', 1);
  const pages = store.db.prepare('PRAGMA page_count').get().page_count;
  store.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => store.setState('large', 'x'.repeat(1024 * 1024)), error => (error.errcode & 0xff) === 13);
  assert.equal(store.writeHealth.status().errorCode, 'disk-full');
  store.setState('existing', 1); store.transaction(() => store.getState('existing'));
  assert.equal(store.writeHealth.status().failing, true, 'no-op state updates and empty transactions cannot prove writes resumed');
  store.db.exec(`PRAGMA max_page_count=${pages + 1000}`);
  store.transaction(() => store.setState('after', 2));
  assert.equal(store.writeHealth.status().failing, false);
  assert.equal(store.writeHealth.status().failures, 1);
});

test('failed BEGIN is observable and a rolled-back outer operation cannot report a nested write as committed', t => {
  const store = database(t), other = new DatabaseSync(store.path);
  t.after(() => other.close());
  store.db.exec('PRAGMA busy_timeout=1'); other.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.transaction(() => store.setState('blocked', 1)), error => (error.errcode & 0xff) === 5);
  assert.equal(store.writeHealth.status().errorCode, 'database-busy');
  other.exec('ROLLBACK');
  assert.throws(() => store.transaction(() => { store.setState('rolled-back', 1); throw new Error('intentional'); }));
  assert.equal(store.getState('rolled-back'), null); assert.equal(store.writeHealth.status().failing, true);
  store.transaction(() => {
    try { store.transaction(() => { store.setState('inner-rollback', 1); throw new Error('caught savepoint failure'); }); }
    catch { /* A read-only outer commit must not count these rolled-back writes. */ }
  });
  assert.equal(store.getState('inner-rollback'), null); assert.equal(store.writeHealth.status().failing, true);
  store.transaction(() => {
    try { store.transaction(() => { store.setState('inner-rollback', 1); throw new Error('caught savepoint failure'); }); } catch {}
    store.setState('committed-after-rollback', 1);
  });
  assert.equal(store.writeHealth.status().failing, false);
});

test('health API remains authenticated and available when controller status and runtime readiness fail', async t => {
  const f = fixture();
  const engine = { status() { throw new Error('private DB details'); }, latestStatus: null };
  const server = createAppServer({ store: f.store, engine, chartService: { overview() {} }, token: 'synthetic-admin-token',
    familyToken: 'synthetic-family-token', recordingHealth: f.health,
    settingsReloadStatus: () => ({ unavailable: true, reason: 'Controller unavailable' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/recording-health`)).status, 401);
  const result = await fetch(`${base}/api/recording-health`, { headers: { Authorization: 'Bearer synthetic-family-token' } });
  assert.equal(result.status, 200); assert.equal((await result.json()).version, 1);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer synthetic-admin-token' } })).status, 503);
});

test('direct and ingress exports share one slot and the same backup health', async t => {
  const f = fixture(), store = database(t);
  let release, begun;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { begun = resolve; });
  const backup = store.backup.bind(store);
  store.backup = async destination => { begun(); await gate; return backup(destination); };
  const token = 'synthetic-long-controller-token';
  const access = createWebAccess({ config: { addon: true, token, host: '127.0.0.1', port: 0,
    ingressHost: '127.0.0.1', ingressPort: 0 }, engine: f.engine, store, recordingHealth: f.health,
    chartService: { overview() {} } });
  await access.start();
  t.after(async () => { release(); await access.close(); });
  access.ingressServer.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '172.30.32.2' }));
  const direct = `http://127.0.0.1:${access.server.address().port}`, ingress = `http://127.0.0.1:${access.ingressServer.address().port}`;
  const first = fetch(`${direct}/api/database-export`, { headers: { Authorization: `Bearer ${token}` } });
  await started;
  const concurrent = await fetch(`${ingress}/api/database-export`);
  assert.equal(concurrent.status, 409);
  const pending = await fetch(`${ingress}/api/recording-health`);
  assert.equal((await pending.json()).backup.state, 'running');
  release(); const response = await first; assert.equal(response.status, 200); await response.arrayBuffer();
});
