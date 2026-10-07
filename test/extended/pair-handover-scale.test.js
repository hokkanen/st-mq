import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/storage/store.js';
import { PairManager } from '../../src/pairing/manager.js';
import { snapshotDigest } from '../../src/replication/publication.js';

// Real encrypted loopback HTTP, snapshot workers, SQLite validation and pair
// state transitions. VIP/equipment hooks are simulated; these timings do not
// measure LAN devices reconnecting or physical Raspberry Pi storage.
async function fixture(t, payloadMiB) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-handover-scale-'));
  const owners = new Set(), managers = [];
  let live = null, timer = null, pending = Promise.resolve(), stoppedAt = null;
  let recordingStopped = false;
  let activatedAt = null, writes = 0, ticks = 0, maxHeartbeatMs = 0;
  t.after(async () => {
    clearInterval(timer);
    await pending;
    live?.close(); live = null;
    for (const manager of managers.reverse()) await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'source.sqlite'), seed = new Store(path);
  const payload = JSON.stringify({ synthetic: 'x'.repeat(4096) });
  const rows = payloadMiB * 256;
  const insert = seed.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
  seed.transaction(() => {
    for (let index = 0; index < rows; index++) insert.run('synthetic-scale', payload, index);
  });
  seed.close();
  async function node(name, platform) {
    const config = { directory: join(directory, name), snapshotDirectory: join(directory, `${name}-replica`),
      databasePath: name === 'source' ? path : join(directory, `${name}.sqlite`),
      pairId: 'synthetic-scale-pair', token: 'synthetic-handover-scale-token-0123456789abcdef', platform,
      listenHost: '127.0.0.1', port: 0, peerUrl: 'http://127.0.0.1:1', timeoutMs: 120000,
      intervalMs: 60000, vip: {} };
    const app = new PairManager({ config, announcements: () => null,
      reportStartupFailure: () => {},
      vip: {
        acquire: async () => { assert.equal(owners.size, 0, 'never acquire a second simulated VIP owner'); owners.add(name); },
        release: async () => { owners.delete(name); }, status: () => ({ owned: owners.has(name), ready: owners.has(name) }),
      },
      hooks: {
        startPrimary: async () => { if (name === 'receiver') activatedAt = performance.now(); },
        startReplica: async () => {}, closeReplica: async () => {},
        stopControl: async () => {
          if (name !== 'source' || !live) return;
          stoppedAt ??= performance.now();
          recordingStopped = true; await pending; live.close(); live = null;
        },
      },
    });
    managers.push(app);
    await app.init(); await app.start(); clearTimeout(app.timer);
    return app;
  }
  const source = await node('source', 'hassio');
  await source.promote();
  const receiver = await node('receiver', 'ubuntu');
  source.peer.peerUrl = `http://127.0.0.1:${receiver.peer.server.address().port}`;
  receiver.peer.peerUrl = `http://127.0.0.1:${source.peer.server.address().port}`;
  live = new Store(source.state.value.activeDbPath);
  let lastTick = performance.now();
  timer = setInterval(() => {
    const at = performance.now(); maxHeartbeatMs = Math.max(maxHeartbeatMs, at - lastTick); lastTick = at; ticks++;
    if (!live || recordingStopped || !source.canControl()) return;
    const current = live;
    pending = pending.then(() => current.runWrite(() => { current.event('synthetic-live', { write: ++writes }, Date.now()); }));
  }, 20);
  return { source, receiver, rows, bytes: (await stat(path)).size,
    metrics: () => ({ writes, ticks, maxHeartbeatMs, stoppedAt, activatedAt }) };
}

const requestedScale = process.env.STMQ_PAIR_SCALE_MIB;
const scales = requestedScale === undefined ? [32, 128] : requestedScale.split(',').map(Number);
if (!scales.length || scales.some(size => !Number.isSafeInteger(size) || size < 1 || size > 1024))
  throw new Error('Synthetic handover payload sizes must be integers between 1 and 1024 MiB');
for (const payloadMiB of scales) {
  test(`cold handover of ${payloadMiB} MiB synthetic payload retains concurrent records and one owner`, async t => {
    const f = await fixture(t, payloadMiB), started = performance.now();
    await f.source.action('handover', { requestId: randomUUID(), confirmed: true });
    const elapsedMs = performance.now() - started, metrics = f.metrics();
    assert.equal(f.source.state.value.role, 'slave');
    assert.equal(f.source.canControl(), false);
    assert.equal(f.receiver.state.value.role, 'master');
    assert.equal(f.receiver.canControl(), true);
    assert(metrics.writes > 0, 'recording continues while the initial full snapshot is prepared and transferred');
    assert(metrics.stoppedAt > started && metrics.activatedAt >= metrics.stoppedAt);
    const selected = new Store(f.receiver.state.value.activeDbPath, { readOnly: true });
    try {
      assert.equal(selected.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-scale'").get().n, f.rows);
      assert.equal(selected.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-live'").get().n, metrics.writes);
      assert.equal(selected.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(selected.db.prepare('PRAGMA foreign_key_check').get(), undefined);
    } finally { selected.close(); }
    assert(metrics.maxHeartbeatMs < 2000, 'large transfer leaves the loop responsive within a generous offline bound');
    t.diagnostic(JSON.stringify({ payloadMiB, databaseMiB: +(f.bytes / 1024 ** 2).toFixed(2),
      elapsedMs: +elapsedMs.toFixed(1), preflightMs: +(metrics.stoppedAt - started).toFixed(1),
      simulatedControlGapMs: +(metrics.activatedAt - metrics.stoppedAt).toFixed(1),
      writes: metrics.writes, heartbeatTicks: metrics.ticks, maxHeartbeatMs: +metrics.maxHeartbeatMs.toFixed(1) }));
  });
}

test('large incompatible receiver snapshot is rejected without stopping the current master', async t => {
  const f = await fixture(t, 32), original = f.source.snapshots.snapshot;
  // Model a peer whose software accepts a different charging format. Only the
  // offered export is changed; the running master's database remains intact.
  f.source.snapshots.snapshot = async options => {
    const result = await original(options);
    const db = new DatabaseSync(options.destination);
    try { db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('charging:mqtt', '{"version":-1}', 1); }
    finally { db.close(); }
    return { ...result, ...await snapshotDigest(options.destination) };
  };
  const started = performance.now();
  await assert.rejects(f.source.action('handover', { requestId: randomUUID(), confirmed: true }), { code: 'database_state_incompatible' });
  assert.equal(f.metrics().stoppedAt, null);
  assert.equal(f.source.canControl(), true);
  assert.equal(f.source.vip.status().owned, true);
  assert.equal(f.receiver.canControl(), false);
  assert.equal(f.receiver.vip.status().owned, false);
  assert(f.metrics().writes > 0);
  t.diagnostic(JSON.stringify({ rejectedAfterMs: +(performance.now() - started).toFixed(1), controlInterrupted: false,
    concurrentWrites: f.metrics().writes }));
});
