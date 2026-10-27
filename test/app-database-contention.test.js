import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { setTimeout as delay } from 'node:timers/promises';

const until = async (t, predicate) => {
  while (!predicate()) await delay(10, undefined, { signal: t.signal });
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
  await until(t, () => app.store.writeQueueStatus().waitingSince !== null);
  await until(t, () => turns > 20);
  assert(turns > 20, 'SQLite acquisition leaves the event loop responsive');
  assert.equal(ticks, 0, 'The tick does not start before write admission');
  assert.deepEqual(reports, [], 'Waiting for the lock is not a failed write');
  writer.exec('ROLLBACK'); locked = false;
  await until(t, () => ticks > 0);
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
    if (attempts === 2) now++;
    return tick();
  });
  const event = app.store.event.bind(app.store);
  t.mock.method(app.store, 'event', (...args) => {
    if (args[0] === 'controller-error') throw new Error('synthetic-sensitive-database-detail');
    return event(...args);
  });
  now += 59_999; app.engine.onTemporaryChange();
  await until(t, () => reports.length > 0 && attempts > 1);
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
  await until(t, () => attempts > 1 && app.store.events().some(event => event.type === 'controller-error'));
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

for (const boundary of ['shutdown', 'revocation']) test(`scheduled lifecycle cancellation during ${boundary} does not record a controller failure`, { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-tick-cancellation-'));
  let now = Date.parse('2026-09-08T12:00:00Z'), release;
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config, clock: () => now, installSignalHandlers: false });
  t.after(async () => { release?.(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const reports = [];
  t.mock.method(console, 'error', message => reports.push(JSON.parse(message)));
  let enter;
  const entered = new Promise(resolve => { enter = resolve; }), update = app.engine.update.bind(app.engine);
  t.mock.method(app.engine, 'update', (...args) => { const pending = update(...args); enter(); return pending; });
  let admit;
  const admitted = new Promise(resolve => { admit = resolve; });
  const publication = app.store.runPublication(() => new Promise(resolve => { release = resolve; admit(); }));
  await admitted;
  now += 59_999; app.engine.onTemporaryChange();
  await entered;
  assert(app.store.writeQueueStatus().queued > 0, 'The real controller save is queued behind publication');
  const stopped = boundary === 'shutdown' ? app.close() : app.revokeControl();
  release(); await Promise.all([publication, stopped]);
  await app.close();
  assert.deepEqual(reports, [], 'Cancelling obsolete control work is not a failed controller update');
  const saved = new DatabaseSync(config.dbPath, { readOnly: true });
  try { assert.equal(saved.prepare("SELECT count(*) n FROM events WHERE type='controller-error'").get().n, 0); }
  finally { saved.close(); }
});

for (const [name, error, shutdown] of [
  ['a real storage failure during shutdown', { code: 'ERR_SQLITE_ERROR', errcode: 10 }, true],
  ['an uncertain committed outcome during shutdown', { code: 'STORAGE_WRITE_CANCELLED', committed: true }, true],
  ['an unexpected cancellation in the current runtime', { code: 'STORAGE_WRITE_CANCELLED' }, false],
]) test(`scheduled error reporting retains ${name}`, { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-tick-error-boundary-'));
  let now = Date.parse('2026-09-08T12:00:00Z'), release, enter;
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const app = await start({ config, clock: () => now, installSignalHandlers: false });
  t.after(async () => { release?.(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const reports = [], entered = new Promise(resolve => { enter = resolve; });
  t.mock.method(console, 'error', message => reports.push(JSON.parse(message)));
  t.mock.method(app.engine, 'update', () => { enter(); return new Promise(resolve => { release = resolve; })
    .then(() => { throw Object.assign(new Error('synthetic-sensitive-controller-detail'), error); }); });
  now += 59_999; app.engine.onTemporaryChange(); await entered; now++;
  const stopping = shutdown ? app.close() : Promise.resolve();
  release(); await stopping;
  await until(t, () => reports.length > 0);
  assert.deepEqual(reports, [{ event: 'controller-error', reason: 'controller-tick-failed', eventStored: false }]);
  assert.doesNotMatch(JSON.stringify(reports), /synthetic-sensitive/);
});
