import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Scheduled controller did not settle');
};

test('a scheduled controller survives SQLite contention and resumes after the writer releases its lock', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-lock-recovery-'));
  let now = Date.parse('2026-09-08T12:00:00Z');
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config, clock: () => now });
  const writer = new DatabaseSync(config.dbPath);
  let locked = false;
  t.after(async () => {
    if (locked) writer.exec('ROLLBACK');
    writer.close(); await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reports = [];
  t.mock.method(console, 'error', message => reports.push(JSON.parse(message)));
  let ticks = 0;
  const tick = app.engine.tick.bind(app.engine);
  t.mock.method(app.engine, 'tick', () => { const result = tick(); ticks++; return result; });
  let turns = 0;
  const heartbeat = setInterval(() => turns++, 5);
  t.after(() => clearInterval(heartbeat));
  writer.exec('BEGIN IMMEDIATE'); locked = true;
  now += 59_999; app.engine.onTemporaryChange();
  await until(() => app.store.writeQueueStatus().waitingSince !== null);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(turns > 20, 'SQLite acquisition leaves the event loop responsive');
  assert.equal(ticks, 0, 'The tick does not start before write admission');
  assert.deepEqual(reports, [], 'Waiting for the lock is not a failed write');
  writer.exec('ROLLBACK'); locked = false;
  await until(() => ticks > 0);
  assert(app.server.listening);
  assert.equal(app.store.db.isTransaction, false);
});

test('failed error persistence cannot terminate the controller or expose the original error on stderr', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-error-reporting-'));
  let now = Date.parse('2026-09-08T12:00:00Z');
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config, clock: () => now });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const reports = [];
  t.mock.method(console, 'error', message => reports.push(JSON.parse(message)));
  let attempts = 0;
  const tick = app.engine.tick.bind(app.engine);
  t.mock.method(app.engine, 'tick', () => {
    attempts++;
    if (attempts === 1) throw new Error('synthetic-sensitive-controller-detail');
    return tick();
  });
  const event = app.store.event.bind(app.store);
  t.mock.method(app.store, 'event', (...args) => {
    if (args[0] === 'controller-error') throw new Error('synthetic-sensitive-database-detail');
    return event(...args);
  });
  now += 59_999; app.engine.onTemporaryChange();
  await until(() => reports.length > 0 && attempts > 1);
  assert.deepEqual(reports, [{ event: 'controller-error', reason: 'controller-tick-failed', eventStored: false }]);
  assert(app.server.listening);
});


test('stored controller errors retain a fixed reason without exposing exception text to either access role', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-error-privacy-'));
  let now = Date.parse('2026-09-08T12:00:00Z');
  const admin = 'synthetic-admin-event-password', family = 'synthetic-family-event-password';
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0',
    STMQ_INPUT: 'simulated', STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family }, directory);
  const app = await start({ config, clock: () => now });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(console, 'error', () => {});
  let attempts = 0;
  const tick = app.engine.tick.bind(app.engine);
  t.mock.method(app.engine, 'tick', () => {
    if (++attempts === 1) throw new Error('synthetic-sensitive-controller-detail');
    // Cross the scheduled minute once recovered, as a real advancing clock
    // would. Holding it at :59.999 would enqueue control work every millisecond.
    if (attempts === 2) now++;
    return tick();
  });
  now += 59_999; app.engine.onTemporaryChange();
  await until(() => attempts > 1 && app.store.events().some(event => event.type === 'controller-error'));
  const stored = app.store.events().find(event => event.type === 'controller-error');
  assert.deepEqual(stored.payload, { reason: 'controller-tick-failed' });
  assert.doesNotMatch(JSON.stringify(app.store.events()), /synthetic-sensitive/);
  for (const token of [admin, family]) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /synthetic-sensitive/);
  }
});

test('application shutdown fences new heating before waiting for an existing dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shutdown-fence-'));
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config });
  let finishDispatch, fenced = false;
  const beginShutdown = app.engine.executor.beginShutdown.bind(app.engine.executor);
  t.mock.method(app.engine.executor, 'beginShutdown', () => { fenced = true; beginShutdown(); });
  app.engine.dispatchPending = new Promise(resolve => { finishDispatch = resolve; });
  const closing = app.close();
  try { assert.equal(fenced, true, 'waiting for old work cannot postpone the activation fence'); }
  finally {
    finishDispatch(); await closing;
    rmSync(directory, { recursive: true, force: true });
  }
});
