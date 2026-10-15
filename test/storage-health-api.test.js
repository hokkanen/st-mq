import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { createRecordingHealth } from '../src/app/recording-health.js';

async function fixture(t, { role = 'master', unavailable = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-health-api-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const engine = { config: { input: 'providers' }, latestStatus: { now: Date.now(), input: 'providers' } };
  engine.status = () => engine.latestStatus;
  const token = 'synthetic-storage-health-admin-token';
  const familyToken = 'synthetic-storage-health-family-token';
  const health = createRecordingHealth({
    filesystem: async () => ({ blocks: 1000, bavail: 800, bsize: 1024 * 1024 }),
    savedBackups: async () => [], resetBackups: async () => [],
  });
  const server = createAppServer({ engine, store, token, familyToken, role,
    chartService: { overview() {} }, recordingHealth: health,
    settingsReloadStatus: () => ({ unavailable, reason: 'Synthetic configuration reload' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, base: `http://127.0.0.1:${server.address().port}`,
    headers: { Authorization: `Bearer ${token}` },
    familyHeaders: { Authorization: `Bearer ${familyToken}` } };
}

test('memory storage summaries use existing authenticated health access without changing the journal', async t => {
  const f = await fixture(t);
  await f.store.runWrite(() => f.store.setState('synthetic-health-record', true));
  const checkpoint = f.store.checkpoint();
  assert.equal((await fetch(`${f.base}/api/recording-health`)).status, 401);
  for (const headers of [f.headers, f.familyHeaders]) {
    const response = await fetch(`${f.base}/api/recording-health`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.recording.history.version, 2);
    assert(result.recording.history.windows.day.committedTransactions > 0);
    assert.equal(result.recording.history.windows.day.failedWrites, 0);
    assert.equal(result.recording.history.windows.day.commandsNotSent, 0);
    const stages = result.recording.storageTimings;
    assert(Number.isFinite(stages.journalSealMs.last));
    assert(Number.isFinite(stages.nativeCommitMs.last));
    assert(stages.commitMs.last >= stages.journalSealMs.last + stages.nativeCommitMs.last);
    assert(result.recording.history.windows.day.journalSealDuration.count > 0);
    assert(result.recording.history.windows.day.nativeCommitDuration.count > 0);
    assert.deepEqual(result.recording.history.windows.day.incidents, []);
    assert(Number.isSafeInteger(result.recording.lastWriteAt));
    assert.equal(result.recording.history.windows.day.complete, false, 'a new run is partial coverage');
  }
  assert.deepEqual(f.store.checkpoint(), checkpoint, 'health reads add no recorded state or diagnostics');
});

test('health history remains available during a held writer lock and unavailable ordinary status', async t => {
  const f = await fixture(t, { unavailable: true });
  const blocker = new DatabaseSync(f.store.path);
  const checkpoint = f.store.checkpoint();
  blocker.exec('BEGIN IMMEDIATE');
  const pending = f.store.runWrite(() => f.store.setState('synthetic-delayed-save', true));
  try {
    await delay(25);
    assert.equal((await fetch(`${f.base}/api/status`, { headers: f.headers })).status, 503);
    const response = await fetch(`${f.base}/api/recording-health`, { headers: f.headers,
      signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recording.state, 'write-waiting');
    assert.equal(result.recording.history.current.pending, 1);
    assert(result.recording.history.current.oldestPendingMs >= 20);
    assert.equal(result.recording.history.windows.day.failedWrites, 0, 'contention is not a rejected save');
    assert.deepEqual(f.store.checkpoint(), checkpoint);
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK');
    await pending;
    blocker.close();
  }
  assert.equal(f.store.getState('synthetic-delayed-save'), true);
});

test('health reports a pending worker save without inventing writer lock contention', async t => {
  const f = await fixture(t);
  await f.store.startWriter();
  const request = f.store.writer.request.bind(f.store.writer);
  let entered, release;
  const held = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  f.store.writer.request = async (operation, ...args) => {
    if (operation === 'commit') { entered(); await resumed; }
    return request(operation, ...args);
  };
  const checkpoint = f.store.checkpoint();
  const saved = f.store.runWrite(() => f.store.setState('pending-worker-health', true));
  try {
    await held;
    const response = await fetch(`${f.base}/api/recording-health`, { headers: f.headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recording.state, 'write-waiting');
    assert.match(result.recording.detail, /last committed readings/);
    assert.equal(result.recording.waitingSince, null);
    assert.equal(result.recording.history.current.activeJobs, 1);
    assert.deepEqual(f.store.checkpoint(), checkpoint);
  } finally { release(); await saved; }
  assert.equal(f.store.getState('pending-worker-health'), true);
});

test('standby health cannot present local memory counters as active master history', async t => {
  const f = await fixture(t, { role: 'slave' });
  await f.store.runWrite(() => f.store.setState('synthetic-local-save', true));
  const response = await fetch(`${f.base}/api/recording-health`, { headers: f.headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scope, 'snapshot');
  assert.equal(result.recording.state, 'read-only');
  assert.equal(result.recording.history, null);
  assert.deepEqual(result.recording.storageTimings, f.store.writeHealth.status().transactions,
    'the existing Store timings remain local evidence within the explicit snapshot scope');
});
