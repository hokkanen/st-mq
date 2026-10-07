import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Executor } from '../src/app/executor.js';
import { createHeatingTransport } from '../src/control/mqtt.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, { closeWriteTimeoutMs = 5000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-executor-lock-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const writer = new DatabaseSync(store.path);
  let now = Date.parse('2026-10-07T12:00Z'), elapsed = 0, authority = true, locked = false;
  const commands = [];
  const transport = createHeatingTransport({ canControl: () => authority });
  transport.setHeatingRelay(async batch => {
    assert.equal(store.db.isTransaction, false, 'A network request must follow the outer commit');
    const saved = JSON.parse(writer.prepare('SELECT value FROM state WHERE key=?').get('executor:home').value);
    if (batch.includes('reduction')) {
      assert.equal(saved.legacyOutstanding, true);
      assert(saved.targetBindings.tariff, 'The original target must be durably bound');
    }
    commands.push(...batch);
    return { sent: true, confirmed: true };
  }, ['synthetic-relay']);
  const executor = new Executor({ input: 'mqtt', store, commandTransport: transport,
    clock: () => now, monotonicClock: () => elapsed, closeWriteTimeoutMs });
  t.after(async () => {
    if (locked) writer.exec('ROLLBACK');
    // An assertion can fail while retry timers are mocked and a save is queued.
    // Cancel those jobs before awaiting the controller's unfinished operation.
    store.close();
    await executor.close({ restore: false });
    writer.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, executor, commands, transport, now: () => now,
    advance: ms => { now += ms; elapsed += ms; }, revoke: () => { authority = false; },
    lock: () => { writer.exec('BEGIN IMMEDIATE'); locked = true; },
    release: () => { writer.exec('ROLLBACK'); locked = false; } };
}

test('tariff activation waits asynchronously for a committed, independently readable restoration duty', async t => {
  const f = fixture(t);
  f.lock();
  const pending = f.executor.execute({ phase: 'reduction', commands: ['reduction'], expiresAt: f.now() + 60_000 },
    { automationEnabled: true, now: f.now() });
  await delay(120);
  assert.deepEqual(f.commands, []);
  assert.equal(f.store.getState('executor:home'), null);
  assert(f.store.writeQueueStatus().pending > 0);
  f.release();
  assert.equal((await pending).phase, 'reduction');
  assert.deepEqual(f.commands, ['reduction']);
});

test('an automatic tariff reduction that expires while waiting is never sent late', async t => {
  const f = fixture(t);
  f.lock();
  const pending = f.executor.execute({ phase: 'reduction', commands: ['reduction'], expiresAt: f.now() + 60_000 },
    { automationEnabled: true, now: f.now() });
  await delay(40); f.advance(61_000); f.release();
  await pending;
  assert(!f.commands.includes('reduction'));
  assert.equal(f.executor.status().legacyOutstanding, false);
});

test('authority revoked during storage admission prevents tariff dispatch and retains saved duty', async t => {
  const f = fixture(t);
  f.lock();
  const pending = f.executor.execute({ phase: 'reduction', commands: ['reduction'], expiresAt: f.now() + 60_000 },
    { automationEnabled: true, now: f.now() });
  const rejected = assert.rejects(pending, { code: 'MQTT_AUTHORITY_LOST' });
  await delay(40); f.revoke(); f.release(); await rejected;
  assert.deepEqual(f.commands, []);
  assert.equal(f.store.getState('executor:home').legacyOutstanding, true);
});

test('a committed circulation OFF duty expires while post-ON bookkeeping is blocked, then clears only after admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), switches = [];
  const startedAt = f.now();
  f.executor.pulseMs = 60_000;
  f.transport.setDhwrRelay(async on => {
    switches.push(on);
    assert.equal(f.store.db.isTransaction, false);
    if (on) {
      assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
      f.lock();
    }
    return { sent: true, confirmed: true };
  }, ['synthetic-circulation']);
  const pending = f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
  await new Promise(resolve => setImmediate(resolve));
  const deadline = f.executor.status().pulseUntil;
  assert.deepEqual(switches, [true]);
  assert(f.store.writeQueueStatus().pending > 0);
  f.advance(60_000); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(switches, [true, false], 'The original committed OFF duty does not wait for optional post-ON bookkeeping.');
  assert.equal(f.executor.status().pulseUntil, deadline);
  assert.equal(f.executor.status().restorationPending, true);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, true, 'An uncommitted clearing cannot erase the durable physical duty.');
  const stoppedAt = f.now(); f.advance(10_000);
  f.release(); t.mock.timers.tick(10); await pending;
  assert.equal(f.executor.status().acknowledgedAt, startedAt, 'Storage admission cannot renew the original ON acknowledgement.');
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, false);
  assert.equal(f.store.getState('executor:home').dhwrStoppedAt, stoppedAt, 'Delayed bookkeeping preserves the actual OFF readback time.');
  assert.deepEqual(switches, [true, false], 'The ordinary restoration accepts the already confirmed OFF without another command.');
});

test('the independent committed OFF expiry cannot act after authority or target identity changes', async t => {
  for (const changed of ['authority', 'identity']) await t.test(changed, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), switches = [];
    f.executor.pulseMs = 60_000;
    f.transport.setDhwrRelay(async on => { switches.push(on); if (on) f.lock(); return { sent: true, confirmed: true }; }, ['original-circulation']);
    const pending = f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
    await new Promise(resolve => setImmediate(resolve));
    const binding = f.store.getState('executor:home').targetBindings.dhwr;
    if (changed === 'authority') f.revoke();
    else f.transport.setDhwrRelay(async on => { switches.push(on); return { sent: true, confirmed: true }; }, ['replacement-circulation']);
    f.advance(60_000); t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(switches, [true]);
    assert.deepEqual(f.store.getState('executor:home').targetBindings.dhwr, binding);
    assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
    f.release(); t.mock.timers.tick(10); await pending;
  });
});

test('committed circulation still stops when a competing writer arrives only after startup bookkeeping finished', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), switches = [];
  f.executor.pulseMs = 60_000;
  f.transport.setDhwrRelay(async on => { switches.push(on); return { sent: true, confirmed: true }; }, ['synthetic-circulation']);
  await f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
  assert.equal(f.executor.pending, null);
  f.lock(); f.advance(60_000); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert(f.store.writeQueueStatus().pending > 0, 'Ordinary expiry is now waiting for the new competing writer.');
  t.mock.timers.tick(101); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(switches, [true, false]);
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, true);
  f.release(); t.mock.timers.tick(10);
  await f.executor.pending;
  assert.equal(f.store.getState('executor:home').dhwrOutstanding, false);
  assert.deepEqual(switches, [true, false]);
});

test('shutdown rejects new circulation and reduction activations already waiting for SQLite admission', async t => {
  for (const command of ['circulation', 'reduction']) await t.test(command, async t => {
    const f = fixture(t), switches = [];
    f.transport.setDhwrRelay(async on => { switches.push(on); return { sent: true, confirmed: true }; }, ['synthetic-circulation']);
    f.lock();
    const pending = f.executor.execute({ commands: [command], phase: command === 'reduction' ? 'reduction' : 'normal',
      expiresAt: f.now() + 60_000 }, { automationEnabled: true, manualTest: command === 'circulation', now: f.now() });
    const rejected = assert.rejects(pending, { code: 'EXECUTOR_CLOSED' });
    await delay(40);
    assert(f.store.writeQueueStatus().pending > 0);
    const closing = f.executor.close();
    f.release();
    await rejected; await closing;
    assert(!switches.includes(true));
    assert(!f.commands.includes('reduction'));
    assert.equal(f.executor.status().dhwrOutstanding ?? false, false);
    assert.equal(f.executor.status().legacyOutstanding, false);
  });
});

test('demotion cancels queued executor saves before an external writer releases SQLite', async t => {
  for (const issued of [false, true]) await t.test(issued ? 'existing physical duty' : 'unissued activation', async t => {
    const f = fixture(t), switches = [];
    f.transport.setDhwrRelay(async on => { switches.push(on); return { sent: true, confirmed: true }; }, ['synthetic-circulation']);
    if (issued) await f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
    const saved = f.store.getState('executor:home');
    f.lock();
    const pending = issued ? f.executor.restore()
      : f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
    const rejected = assert.rejects(pending, { code: 'STORAGE_WRITE_CANCELLED' });
    await delay(30);
    assert(f.store.writeQueueStatus().pending > 0);
    await f.executor.close({ restore: false });
    await rejected;
    assert.equal(f.store.writeQueueStatus().pending, 0);
    assert.deepEqual(f.store.getState('executor:home'), saved, 'Cancellation preserves the last committed duty exactly.');
    assert.deepEqual(switches, issued ? [true] : []);
    f.release();
    await f.store.runWrite(() => f.store.setState('next-runtime', { ready: true }));
    assert.equal(f.store.getState('next-runtime').ready, true, 'Demotion leaves the shared Store usable.');
  });
});

test('restorative executor shutdown bounds its own storage wait and retains the committed obligation', async t => {
  const f = fixture(t, { closeWriteTimeoutMs: 50 }), switches = [];
  f.transport.setDhwrRelay(async on => { switches.push(on); return { sent: true, confirmed: true }; }, ['synthetic-circulation']);
  await f.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: f.now() });
  const saved = f.store.getState('executor:home');
  f.lock();
  await assert.rejects(f.executor.close(), { code: 'STORAGE_WRITE_CANCELLED' });
  assert.equal(f.store.writeQueueStatus().pending, 0);
  assert.deepEqual(f.store.getState('executor:home'), saved);
  assert.deepEqual(switches, [true]);
  f.release();
  await f.store.runWrite(() => f.store.setState('next-runtime', { ready: true }));
  assert.equal(f.store.getState('next-runtime').ready, true);
});
