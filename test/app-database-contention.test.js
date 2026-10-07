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
  const event = t.mock.method(app.store, 'event', app.store.event.bind(app.store));
  writer.exec('BEGIN IMMEDIATE'); locked = true;
  now += 59_999; app.engine.onTemporaryChange();
  await until(() => reports.length > 0);
  assert.deepEqual(reports[0], { event: 'controller-error', reason: 'database-busy', eventStored: false });
  assert(!event.mock.calls.some(call => call.arguments[0] === 'controller-error'),
    'A busy database is not asked to record its own failed write');
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
