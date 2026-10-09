import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Executor } from '../src/app/executor.js';
import { createHeatingTransport } from '../src/control/mqtt.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const ioError = code => Object.assign(new Error('Synthetic storage fault'), {
  code: 'ERR_SQLITE_ERROR', errcode: code === 'FULL' ? 13 : 10,
});

// Real transactions and an independent SQLite reader, with deterministic faults
// at the write/COMMIT boundary. This does not simulate damaged disk hardware.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-executor-failure-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const reader = new DatabaseSync(store.path, { readOnly: true });
  const read = () => {
    const row = reader.prepare('SELECT value FROM state WHERE key=?').get('executor:home');
    return row ? JSON.parse(row.value) : null;
  };
  let now = Date.parse('2026-10-09T12:00Z'), elapsed = 0, fault = null;
  let authority = true, ready = true, route = 'original', response = null;
  const calls = [], heatingCalls = [], executors = [];
  const originalSetState = store.setState.bind(store), originalExec = store.db.exec.bind(store.db);
  const faultApplies = value => fault && (!fault.clearingOnly || value?.dhwrOutstanding === false)
    && (!fault.tariffClearingOnly || value?.legacyOutstanding === false);
  store.setState = (key, value) => {
    const result = originalSetState(key, value);
    if (key === 'executor:home' && faultApplies(value)) {
      if (fault.at === 'statement') throw ioError(fault.code);
      if (fault.at === 'observer') store.afterCommit(() => { throw new Error('Synthetic observer failure'); });
    }
    return result;
  };
  store.db.exec = sql => {
    if (sql === 'COMMIT' && fault?.at === 'commit' && faultApplies(store.getState('executor:home')))
      throw ioError(fault.code);
    return originalExec(sql);
  };
  const create = () => {
    const transport = createHeatingTransport({ canControl: () => authority });
    transport.setHeatingRelay(async commands => {
      assert.equal(store.db.isTransaction, false);
      heatingCalls.push(...commands);
      return { sent: true, confirmed: true };
    }, () => [route]);
    transport.setDhwrRelay(async on => {
      if (!ready) throw Object.assign(new Error('Synthetic evidence loss'), { code: 'MQTT_STORAGE_FAILED' });
      assert.equal(store.db.isTransaction, false, 'No device command may run inside a database transaction.');
      assert.equal(read().dhwrOutstanding, true, 'The original OFF duty remains independently readable.');
      calls.push(on);
      return response ? response(on) : { sent: true, confirmed: true };
    }, () => [route]);
    const executor = new Executor({ input: 'mqtt', store, commandTransport: transport,
      config: { dhwrPulseMinutes: 1 }, clock: () => now, monotonicClock: () => elapsed });
    executors.push(executor);
    return executor;
  };
  const executor = create();
  t.after(async () => {
    fault = null;
    for (const item of executors) await item.close({ restore: false });
    reader.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { executor, store, calls, heatingCalls, read, create,
    start: () => executor.execute({ commands: ['circulation'] }, { manualTest: true, now }),
    reduce: () => executor.execute({ commands: ['reduction'], phase: 'reduction', expiresAt: now + 60_000 },
      { automationEnabled: true, now }),
    stop: () => executor.exclusive(() => executor.stopDhwr(now)),
    advance: ms => { now += ms; elapsed += ms; },
    setFault: next => { fault = next; }, revoke: () => { authority = false; },
    replace: () => { route = 'replacement'; }, loseEvidence: () => { ready = false; },
    setResponse: next => { response = next; },
  };
}

for (const code of ['IOERR', 'FULL']) for (const at of ['statement', 'commit'])
  test(`committed circulation expires through ${code} at ${at}, retaining its duty until clearing commits`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    await f.start();
    const saved = f.read();
    f.setFault({ code, at });
    f.advance(60_000); t.mock.timers.tick(60_000); await turn();
    assert.deepEqual(f.calls, [true, false], 'Rejected bookkeeping cannot suppress an already committed OFF.');
    assert.equal(f.store.writeQueueStatus().pending, 0, 'This exercises permanent failure, not a BUSY queue.');
    assert.deepEqual(f.read(), saved, 'Failed statements and commits preserve the original database duty.');
    assert.equal(f.executor.status().dhwrOutstanding, true, 'RAM cannot publish an uncommitted clearing.');
    assert.equal(f.executor.status().restorationPending, true);
    const stoppedAt = f.executor.expiryDhwr.completedAt;
    f.setFault(null); f.advance(5000);
    await f.executor.restore();
    assert.equal(f.read().dhwrOutstanding, false);
    assert.equal(f.executor.status().dhwrOutstanding, false);
    assert.equal(f.read().dhwrStoppedAt, stoppedAt, 'Storage recovery retains the original native confirmation time.');
    assert.deepEqual(f.calls, [true, false], 'Clearing retries cannot duplicate an already confirmed OFF.');
  });

test('failed clearing alone retains the duty and does not repeat a confirmed OFF', async t => {
  const f = fixture(t);
  await f.start();
  const binding = f.read().targetBindings.dhwr;
  f.setFault({ code: 'IOERR', at: 'commit', clearingOnly: true });
  await assert.rejects(f.stop(), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  assert.deepEqual(f.calls, [true, false]);
  assert.equal(f.read().dhwrOutstanding, true);
  assert.deepEqual(f.executor.status().targetBindings.dhwr, binding);
  await assert.rejects(f.stop(), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(f.calls, [true, false]);
  f.setFault(null);
  await f.stop();
  assert.equal(f.read().dhwrOutstanding, false);
  assert.deepEqual(f.calls, [true, false]);
});

test('a later ON cannot reuse an earlier OFF confirmation with the same target and deadline', async t => {
  const f = fixture(t);
  await f.start();
  f.setFault({ code: 'IOERR', at: 'commit', clearingOnly: true });
  await assert.rejects(f.stop(), { code: 'ERR_SQLITE_ERROR' });
  const oldDeadline = f.read().pulseUntil;
  f.setFault(null);
  await f.start();
  assert.equal(f.read().pulseUntil, oldDeadline);
  await f.stop();
  assert.deepEqual(f.calls, [true, false, true, false]);
  assert.equal(f.read().dhwrOutstanding, false);
});

test('restart with failed bookkeeping stops the original committed run and retains the duty until recovery', async t => {
  const f = fixture(t);
  await f.start();
  const saved = f.read();
  await f.executor.close({ restore: false });
  const successor = f.create();
  f.setFault({ code: 'FULL', at: 'commit' });
  await assert.rejects(successor.restore(), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  assert.deepEqual(f.calls, [true, false]);
  assert.deepEqual(f.read(), saved);
  assert.equal(successor.status().dhwrOutstanding, true);
  f.setFault(null);
  await successor.restore();
  assert.equal(f.read().dhwrOutstanding, false);
  assert.deepEqual(f.calls, [true, false]);
});

test('restorative shutdown attempts committed OFF through failure and a successor reconciles the retained duty', async t => {
  const f = fixture(t);
  await f.start();
  const saved = f.read();
  f.setFault({ code: 'IOERR', at: 'commit' });
  await assert.rejects(f.executor.close(), { code: 'ERR_SQLITE_ERROR' });
  assert.equal(f.executor.closed, true);
  assert.deepEqual(f.calls, [true, false]);
  assert.deepEqual(f.read(), saved);
  f.setFault(null);
  const successor = f.create();
  await successor.restore();
  assert.equal(f.read().dhwrOutstanding, false);
  assert.deepEqual(f.calls, [true, false, false], 'A successor needs its own live confirmation; RAM readback is not durable evidence.');
});

test('bookkeeping failure cannot bypass revoked authority, replacement identity or failed input evidence', async t => {
  for (const change of ['revoke', 'replace', 'loseEvidence']) await t.test(change, async t => {
    const f = fixture(t);
    await f.start();
    const saved = f.read();
    f.setFault({ code: 'IOERR', at: 'commit' });
    f[change]();
    await assert.rejects(f.stop());
    assert.deepEqual(f.calls, [true]);
    assert.deepEqual(f.read(), saved);
    assert.equal(f.executor.status().dhwrOutstanding, true);
  });
});

test('an unsaved new circulation or external Stop cannot obtain command authority from storage failure', async t => {
  for (const action of ['start', 'external-stop']) await t.test(action, async t => {
    const f = fixture(t);
    f.setFault({ code: 'FULL', at: 'statement' });
    await assert.rejects(action === 'start' ? f.start()
      : f.executor.exclusive(() => f.executor.stopDhwr(undefined, { force: true })), { code: 'ERR_SQLITE_ERROR' });
    assert.deepEqual(f.calls, []);
    assert.equal(f.read(), null);
  });
});

test('a failed postcommit observer cannot roll runtime restoration behind the committed OFF clearing', async t => {
  const f = fixture(t);
  await f.start();
  f.setFault({ at: 'observer', clearingOnly: true });
  await assert.rejects(f.stop(), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  assert.deepEqual(f.calls, [true, false]);
  assert.equal(f.read().dhwrOutstanding, false);
  assert.equal(f.executor.status().dhwrOutstanding, false);
  assert.equal(f.executor.durableState.dhwrOutstanding, false);
  f.setFault(null);
  assert.equal(await f.executor.stopDhwr(), false);
  assert.deepEqual(f.calls, [true, false]);
});

test('an unconfirmed OFF survives storage failure and retries after fresh command evidence', async t => {
  const f = fixture(t);
  await f.start();
  let resolve;
  f.setResponse(() => new Promise(done => { resolve = done; }));
  f.setFault({ code: 'IOERR', at: 'commit' });
  const operation = f.stop();
  const rejected = assert.rejects(operation, { code: 'ERR_SQLITE_ERROR' });
  await turn();
  assert.equal(f.read().dhwrOutstanding, true);
  resolve({ sent: false, confirmed: false });
  await rejected;
  assert.equal(f.executor.status().dhwrOutstanding, true);
  assert.equal(f.executor.expiryDhwr, null);
  f.setFault(null); f.setResponse(null);
  await f.stop();
  assert.deepEqual(f.calls, [true, false, false]);
  assert.equal(f.read().dhwrOutstanding, false);
});

test('authority loss while OFF awaits confirmation cannot clear the retained obligation', async t => {
  const f = fixture(t);
  await f.start();
  let resolve;
  f.setResponse(() => new Promise(done => { resolve = done; }));
  f.setFault({ code: 'IOERR', at: 'commit' });
  const operation = f.stop();
  const rejected = assert.rejects(operation, { code: 'MQTT_AUTHORITY_LOST' });
  await turn();
  assert.deepEqual(f.calls, [true, false]);
  f.setFault(null); f.revoke();
  resolve({ sent: true, confirmed: true });
  await rejected;
  assert.equal(f.executor.status().dhwrOutstanding, true);
  assert.equal(f.read().dhwrOutstanding, true);
  assert.equal(f.executor.expiryDhwr, null);
});

test('a failed tariff clearing retains its device-bound obligation in runtime and on disk', async t => {
  const f = fixture(t);
  await f.reduce();
  const binding = f.read().targetBindings.tariff;
  f.setFault({ code: 'IOERR', at: 'commit', tariffClearingOnly: true });
  assert.equal((await f.executor.restore()).restorationPending, true);
  assert.deepEqual(f.heatingCalls, ['reduction', 'normal']);
  assert.equal(f.read().legacyOutstanding, true);
  assert.equal(f.executor.status().legacyOutstanding, true);
  assert.deepEqual(f.executor.status().targetBindings.tariff, binding);
  f.setFault(null);
  assert.equal((await f.executor.restore()).restorationPending, false);
  assert.equal(f.read().legacyOutstanding, false);
  assert.equal(f.executor.status().legacyOutstanding, false);
});
