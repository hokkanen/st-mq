import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { LEARNING_WINDOW_MS } from '../src/app/committed-learning.js';

const START = Date.parse('2026-10-07T12:00:00Z');
function fixture(t, input = 'simulated', path = ':memory:') {
  const store = new Store(path);
  let now = START;
  const engine = new Engine({ store, config: { input, settings: {} }, clock: () => now });
  t.after(async () => {
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  return { store, engine, advance() { now += LEARNING_WINDOW_MS; } };
}
function failCommit(store) {
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT') throw Object.assign(new Error('synthetic outer commit failure'), { errcode: 10 });
    return exec(sql);
  };
  return () => { store.db.exec = exec; };
}

test('failed outer controller commit restores complete learning, observations and planning caches', async t => {
  const { store, engine, advance } = fixture(t);
  await store.runWrite(() => engine.tick());
  await engine.charging.planningFlight?.catch(() => {});
  const before = structuredClone({ checkpoint: engine.checkpoint, status: engine.latestStatus, plant: engine.plant.state,
    observations: engine.ingestionCheckpoint(), cycleContext: engine.cycles.fireplaceContext, explorer: engine.heatingExplorer.input });
  const checkpoint = store.getState('adaptive:simulated');
  const cursor = store.learningJournal({ input: 'simulated' }).at(-1)?.id;
  advance();
  const restore = failCommit(store);
  try {
    await assert.rejects(store.runWrite(() => {
      engine.tick();
      assert.ok(engine.checkpoint.journalCursor > before.checkpoint.journalCursor, 'the attempted tick really advanced learning before commit');
    }), { errcode: 10 });
  } finally { restore(); }
  assert.deepEqual({ checkpoint: engine.checkpoint, status: engine.latestStatus, plant: engine.plant.state,
    observations: engine.ingestionCheckpoint(), cycleContext: engine.cycles.fireplaceContext, explorer: engine.heatingExplorer.input }, before);
  assert.deepEqual(store.getState('adaptive:simulated'), checkpoint);
  assert.equal(store.learningJournal({ input: 'simulated' }).at(-1)?.id, cursor);
  assert.equal(engine.heatingPlanning.completed, null);
  await store.runWrite(() => engine.tick());
  assert.ok(engine.checkpoint.journalCursor > before.checkpoint.journalCursor);
});

test('failed outer commit cannot dispatch startup restoration and preserves its original duty for retry', async t => {
  const { store, engine } = fixture(t, 'mqtt');
  let commands = 0;
  engine.startupRestorationPending = true;
  engine.executor.restore = async () => { commands++; return { status: 'confirmed' }; };
  const restore = failCommit(store);
  try { await assert.rejects(store.runWrite(() => engine.tick()), { errcode: 10 }); }
  finally { restore(); }
  await engine.dispatchPending;
  assert.equal(commands, 0);
  assert.equal(engine.startupRestorationPending, true);
  await store.runWrite(() => engine.tick());
  await engine.dispatchPending;
  assert.equal(commands, 1);
  assert.equal(engine.startupRestorationPending, false);
});

test('recording presentation does not retain a stream whose enclosing save rolled back', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => START });
  const observation = { source: 'mqtt-temperature', device: 'synthetic-room', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: START, receivedAt: START, quality: [] };
  const restore = failCommit(store);
  try { await assert.rejects(store.runWrite(() => recorder.record(observation)), { errcode: 10 }); }
  finally { restore(); }
  assert.equal(recorder.observedStreams.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
  await store.runWrite(() => recorder.record(observation));
  assert.equal(recorder.observedStreams.size, 1);
});


test('execution records keep the completion receipt time while SQLite publication waits', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-execution-receipt-'));
  let writer, locked = false;
  t.after(() => { if (locked) writer.exec('ROLLBACK'); writer?.close(); });
  const { store, engine, advance } = fixture(t, 'mqtt', join(directory, 'history.sqlite'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writer = new DatabaseSync(store.path);
  let complete;
  engine.automationEnabled = () => true;
  engine.executor.execute = () => new Promise(resolve => { complete = resolve; });
  await store.runWrite(() => engine.tick());
  assert.equal(typeof complete, 'function');
  writer.exec('BEGIN IMMEDIATE'); locked = true;
  complete({ status: 'mqtt', sent: true, phase: 'normal', expiresAt: START + 60_000 });
  await new Promise(resolve => setImmediate(resolve));
  assert(store.writeQueueStatus().pending > 0);
  advance();
  writer.exec('ROLLBACK'); locked = false;
  await engine.dispatchPending;
  assert.equal(store.getState('applied:mqtt').at, START);
  const phase = store.observations({ signal: 'controller_phase' }).at(-1);
  assert.equal(phase.sourceTime, START);
  assert.equal(phase.receivedAt, START);
});


test('revocation cancels queued execution publication without waiting for a foreign writer', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-execution-revoke-'));
  let writer, locked = false;
  t.after(() => { if (locked) writer.exec('ROLLBACK'); writer?.close(); });
  const { store, engine } = fixture(t, 'mqtt', join(directory, 'history.sqlite'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writer = new DatabaseSync(store.path);
  let complete;
  engine.automationEnabled = () => true;
  engine.executor.execute = () => new Promise(resolve => { complete = resolve; });
  await store.runWrite(() => engine.tick());
  const before = store.getState('applied:mqtt');
  writer.exec('BEGIN IMMEDIATE'); locked = true;
  complete({ status: 'mqtt', sent: true, phase: 'normal' });
  await new Promise(resolve => setImmediate(resolve));
  assert(store.writeQueueStatus().pending > 0);
  engine.beginShutdown({ restore: false });
  let timeout;
  try { await Promise.race([engine.dispatchPending, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Revocation waited for SQLite')), 1000);
  })]); } finally { clearTimeout(timeout); }
  assert.equal(writer.isTransaction, true, 'the foreign writer is still holding its lock');
  assert.equal(store.writeQueueStatus().pending, 0);
  writer.exec('ROLLBACK'); locked = false;
  assert.deepEqual(store.getState('applied:mqtt'), before);
  await store.runWrite(() => store.setState('new-runtime', true));
  assert.equal(store.getState('new-runtime'), true, 'revocation does not close shared storage');
});

test('failed execution publication rolls back provisional model and control presentation', async t => {
  const { store, engine } = fixture(t, 'mqtt');
  let complete;
  engine.automationEnabled = () => true;
  engine.executor.execute = () => new Promise(resolve => { complete = resolve; });
  await store.runWrite(() => engine.tick());
  const before = structuredClone({ applied: engine.applied, checkpoint: engine.checkpoint,
    latestStatus: engine.latestStatus, explorer: engine.heatingExplorer.input });
  const restore = failCommit(store);
  try {
    complete({ status: 'mqtt', sent: true, phase: 'normal' });
    await engine.dispatchPending;
  } finally { restore(); }
  assert.equal(engine.latestStatus.execution.status, 'failed', 'the failed publication remains visible');
  assert.deepEqual({ applied: engine.applied, checkpoint: engine.checkpoint,
    latestStatus: { ...engine.latestStatus, execution: before.latestStatus.execution },
    explorer: engine.heatingExplorer.input }, before);
});
