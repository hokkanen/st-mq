import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { createRecordingHealth } from '../src/app/recording-health.js';

async function fixture(t, { role = 'master', unavailable = false, writer = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-health-api-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  if (writer) await store.startWriter();
  const engine = { store, config: { input: 'providers' }, latestStatus: { now: Date.now(), input: 'providers' } };
  engine.status = () => engine.latestStatus;
  const token = 'synthetic-storage-health-admin-token';
  const familyToken = 'synthetic-storage-health-family-token';
  const health = createRecordingHealth({
    filesystem: async () => ({ blocks: 100_000, bavail: 80_000, bsize: 1024 * 1024 }),
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
  return { store, engine, base: `http://127.0.0.1:${server.address().port}`,
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
    assert.equal(result.version, 3);
    assert.equal(result.operations.version, 1);
    assert.equal(result.operations.scope, 'local-node');
    assert.deepEqual(result.recording.writer, { state: 'ready' });
    assert.equal(result.recording.history.version, 3);
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

test('authenticated control requests blocked by storage count independently of nonexistent native commands', async t => {
  const f = await fixture(t);
  f.engine.setAutomation = async () => f.store.runWrite(() => {
    throw Object.assign(new Error('synthetic failed control save'), { errcode: 13 });
  });
  const request = headers => fetch(`${f.base}/api/automation`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await request({})).status, 401);
  assert.equal(f.store.writeHealth.status().history.windows.day.controlRequestsBlocked, 0);
  assert.notEqual((await request(f.headers)).status, 200);
  let day = f.store.writeHealth.status().history.windows.day;
  assert.equal(day.controlRequestsBlocked, 1); assert.equal(day.commandsNotSent, 0);
  assert.equal(day.failedWrites, 1);
  f.store.writerFailed = true;
  assert.equal((await request(f.headers)).status, 503);
  day = f.store.writeHealth.status().history.windows.day;
  assert.equal(day.controlRequestsBlocked, 2); assert.equal(day.commandsNotSent, 0);
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
    assert.equal(result.recording.state, 'starting', 'saving preserves the initial source wait');
    assert.deepEqual(result.recording.writer, { state: 'saving' });
    assert.deepEqual(result.attention, [], 'an ordinary save does not introduce an alert');
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
  assert.equal(result.recording.writer, null);
  assert.equal(result.recording.runtimeTiming, null);
  assert.deepEqual(result.recording.storageTimings, f.store.writeHealth.status().transactions,
    'the existing Store timings remain local evidence within the explicit snapshot scope');
});

test('an actual worker save remains neutral and health responds while COMMIT is held', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { writer: true });
  const before = f.store.writeHealth.status();
  const at = Date.now();
  f.engine.recordingSourceStatus = () => ({ parameters: [{ observedThisRun: true, signal: 'indoor_temperature', lastPollAt: at,
    freshness: { status: 'held', sourceObservedAt: at, maxAgeMs: null } }] });
  const request = f.store.writer.request.bind(f.store.writer);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.store.writer.request = async (operation, ...args) => {
    if (operation === 'commit') { entered(); await gate; }
    return request(operation, ...args);
  };
  const saving = f.store.runWrite(() => f.store.setState('synthetic-pending-save', true));
  try {
    await ready;
    const response = await fetch(`${f.base}/api/recording-health`, { headers: f.headers, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.recording.writer, { state: 'saving' });
    assert.equal(result.recording.state, 'ok');
    assert.equal(result.recording.history.current.activeJobs, 1);
    assert.equal(result.recording.history.windows.day.failedWrites, 0);
    assert.equal(result.recording.lastWriteAt, before.lastWriteAt);
    assert.deepEqual(result.attention, [], 'saving is not a storage or source warning');
    assert.equal(f.store.canDispatch(), false, 'neutral activity does not grant control authority');
  } finally { release(); await saving; }
  const result = await (await fetch(`${f.base}/api/recording-health`, { headers: f.headers })).json();
  assert.deepEqual(result.recording.writer, { state: 'ready' });
  assert.equal(result.recording.history.current.activeJobs, 0);
  assert(Number.isSafeInteger(result.recording.lastWriteAt));
});

test('a lost actual COMMIT reply confirms the save without presenting the failed worker as caught up', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { writer: true });
  const before = f.store.writeHealth.status();
  const writer = f.store.writer, frame = writer.frame.bind(writer), receive = writer.receive.bind(writer),
    terminate = writer.terminate.bind(writer);
  let commitId, release, entered, calls = 0, effects = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const confirming = new Promise(resolve => { entered = resolve; });
  writer.frame = (operation, ...args) => {
    const result = frame(operation, ...args);
    if (operation === 'commit') commitId = result.id;
    return result;
  };
  writer.receive = value => {
    const message = deserialize(value);
    if (message.id === commitId && message.ok === true) {
      // SQLite has really committed, but the client never receives its reply.
      writer.fail(Object.assign(new Error('Synthetic lost reply'), { code: 'STORAGE_WRITER_UNAVAILABLE' }));
      return;
    }
    receive(value);
  };
  writer.terminate = async () => { entered(); await gate; return terminate(); };
  const saving = f.store.runWrite(() => {
    calls++; f.store.setState('synthetic-confirmed-save', true);
    f.store.afterCommit(() => effects++);
    return 'saved';
  });
  try {
    await confirming;
    const response = await fetch(`${f.base}/api/recording-health`, { headers: f.headers, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.recording.writer, { state: 'confirming' });
    assert.equal(result.recording.state, 'writer-confirming');
    assert.equal(result.recording.history.windows.day.failedWrites, 0);
    assert.equal(result.recording.lastFailureAt, null);
    assert.equal(result.attention.find(row => row.id === 'storage-writer').severity, 'warning');
  } finally { release(); assert.equal(await saving, 'saved'); }
  const savedAt = f.store.writeHealth.status().lastWriteAt;
  assert(Number.isSafeInteger(savedAt));
  const checkpoint = f.store.checkpoint();
  for (const headers of [f.headers, f.familyHeaders]) {
    const response = await fetch(`${f.base}/api/recording-health`, { headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.recording.writer, { state: 'unavailable' });
    assert.equal(result.recording.state, 'writer-unavailable');
    assert.equal(result.recording.history.current.activeJobs, 0);
    assert.equal(result.recording.history.current.pending, 0);
    assert.equal(result.recording.history.windows.day.failedWrites, 0, 'known committed work must not become a failed save');
    assert.equal(result.recording.history.windows.day.committedTransactions, before.history.windows.day.committedTransactions + 1);
    assert.equal(result.recording.lastWriteAt, savedAt, 'health does not refresh the successful save clock');
    assert.equal(result.recording.lastFailureAt, null);
    assert.equal(result.attention.find(row => row.id === 'storage-writer').severity, 'critical');
  }
  assert.deepEqual(f.store.checkpoint(), checkpoint, 'health adds no recording');
  assert.equal(f.store.getState('synthetic-confirmed-save'), true);
  assert.equal(calls, 1); assert.equal(effects, 1);
  assert.equal(f.store.canDispatch(), false);
});

test('idle worker termination is unavailable even with no failed save or outstanding job', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { writer: true });
  await f.store.runWrite(() => f.store.setState('synthetic-idle-save', true));
  const savedAt = f.store.writeHealth.status().lastWriteAt;
  await f.store.writer.worker.terminate();
  assert.equal(f.store.writerFailed, false, 'the client observes an idle exit before another Store transaction runs');
  const result = await (await fetch(`${f.base}/api/recording-health`, { headers: f.headers })).json();
  assert.equal(result.recording.writer.state, 'unavailable');
  assert.equal(result.recording.state, 'writer-unavailable');
  assert.equal(result.recording.lastWriteAt, savedAt);
  assert.equal(result.recording.lastFailureAt, null);
  assert.equal(result.recording.history.windows.day.failedWrites, 0);
  assert.equal(result.recording.history.current.activeJobs, 0);
  assert.equal(result.recording.history.current.pending, 0);
  assert.equal(result.attention.find(row => row.id === 'storage-writer').severity, 'critical');
  assert.equal(f.store.canDispatch(), false);
});
