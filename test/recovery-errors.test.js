import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { RECOVERY_ERROR_CODES, recoveryFailure } from '../src/recovery/errors.js';
import { createHistoryRecovery } from '../src/app/history-recovery.js';
import { PairPeer, publicPairError } from '../src/pairing/peer.js';
import { pairDisplay, pairIssueHelp } from '../chart/pair-status.js';
import { recoveryJobText } from '../chart/history-recovery.js';
import { sample, start, W } from './helpers/recovery-fixture.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-recovery-errors-'));
  const master = new Store(join(directory, 'master.sqlite'));
  master.setState('adaptive:mqtt', { synthetic: 'previous-model' });
  t.after(() => { master.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, master, donorPath: join(directory, 'donor.sqlite') };
}

test('recovery diagnostics classify native failures without publishing private error text', () => {
  const native = (code, errcode) => Object.assign(new Error('/invented/private-database.sqlite household-value'), { code, errcode });
  for (const [error, expected] of [
    [native('ERR_SQLITE_ERROR', 5), 'recovery_database_busy'],
    [native('ERR_SQLITE_ERROR', 262), 'recovery_database_busy'],
    [native('ERR_SQLITE_ERROR', 13), 'recovery_storage_full'],
    [native('ERR_SQLITE_ERROR', 2067), 'recovery_database_constraint'],
    [native('ERR_SQLITE_ERROR', 11), 'recovery_database_corrupt'],
    [native('ERR_SQLITE_ERROR', 26), 'recovery_database_corrupt'],
    [native('ERR_SQLITE_ERROR', 10), 'recovery_storage_failed'],
    [native('ERR_SQLITE_ERROR', 8), 'recovery_storage_failed'],
    [native('ERR_SQLITE_ERROR', 14), 'recovery_storage_unavailable'],
    [native('ENOSPC'), 'recovery_storage_full'],
    [native('EACCES'), 'recovery_storage_failed'],
    [native('ENOENT'), 'recovery_storage_unavailable'],
    [native('database_algorithm_mismatch'), 'database_algorithm_mismatch'],
    [native('HEATING_CONTROL_STATE_UNREADABLE'), 'database_state_incompatible'],
    [native('database_state_incompatible'), 'database_state_incompatible'],
    [native('database_integrity_failed'), 'database_integrity_failed'],
    [native('unknown'), 'recovery_failed'],
    [native('__proto__'), 'recovery_failed'],
    [native('unrelated', 13), 'recovery_failed'],
  ]) {
    const failure = recoveryFailure(error);
    assert.equal(failure.code, expected);
    assert.doesNotMatch(failure.error, /private-database|household-value/);
    assert.equal(publicPairError(failure), expected);
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE synthetic(id INTEGER PRIMARY KEY); INSERT INTO synthetic VALUES(1)');
    assert.throws(() => db.exec('INSERT INTO synthetic VALUES(1)'), error => {
      assert.equal(recoveryFailure(error).code, 'recovery_database_constraint'); return true;
    });
  } finally { db.close(); }
});

test('a damaged donor reports its cause through the recovery worker without changing the master', async t => {
  const { directory, master, donorPath } = fixture(t);
  writeFileSync(donorPath, Buffer.alloc(4096, 0x5a));
  await assert.rejects(recoveryPreview({ masterPath: master.path, donorPath, workDirectory: directory, signal: t.signal }), error => {
    assert.equal(error.code, 'recovery_database_corrupt');
    assert.doesNotMatch(error.message, /stmq-recovery-errors|donor.sqlite/);
    return true;
  });
  assert.deepEqual(master.getState('adaptive:mqtt'), { synthetic: 'previous-model' });
  assert.equal(master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('a real database lock is distinguished from corruption and a later source check succeeds', { timeout: 15000 }, async t => {
  const { directory, master, donorPath } = fixture(t);
  const source = new Store(donorPath); source.close();
  const lock = new DatabaseSync(donorPath);
  try {
    lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    await assert.rejects(recoveryPreview({ masterPath: master.path, donorPath, workDirectory: directory, signal: t.signal }),
      { code: 'recovery_database_busy' });
    lock.exec('ROLLBACK');
    const result = await recoveryPreview({ masterPath: master.path, donorPath, workDirectory: directory, signal: t.signal });
    assert.match(result.previewId, /^[a-f0-9]{64}$/);
    assert.deepEqual(master.getState('adaptive:mqtt'), { synthetic: 'previous-model' });
    assert.equal(master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { lock.close(); }
});

test('a publication transaction failure keeps its cause and the previous model selected', async t => {
  const { master, donorPath } = fixture(t);
  const donor = new Store(`${donorPath}.working`);
  sample(donor, start + W);
  await donor.backup(donorPath); donor.close();
  master.setState('pending-plan:mqtt', { id: 'synthetic-previous-plan' });
  const preview = await recoveryPreview({ masterPath: master.path, donorPath, signal: t.signal });
  // Inject after the worker opens the current schema and before its final
  // authority admission. The trigger then reaches the real transaction rather
  // than replacing a parent method which that worker never calls.
  let publicationStarted = false, injected = false;
  const runPublication = master.runPublication;
  master.runPublication = function (operation, options) {
    return runPublication.call(this, () => {
      const pending = operation(); publicationStarted = true; return pending;
    }, options);
  };
  const isCurrent = () => {
    if (publicationStarted && !injected) {
      master.db.exec(`CREATE TRIGGER synthetic_publication_failure BEFORE UPDATE ON state
        WHEN NEW.key='recovery:active:mqtt' AND json_extract(NEW.value,'$.status')='complete'
        BEGIN SELECT RAISE(ABORT,'synthetic publication constraint'); END`);
      injected = true;
    }
    return true;
  };
  try {
    await assert.rejects(recoverHistory({ store: master, donorPath, preview, signal: t.signal, isCurrent }),
      { code: 'recovery_database_constraint' });
    assert(injected, 'publication reached the real worker admission');
  } finally {
    master.runPublication = runPublication;
    if (injected) master.db.exec('DROP TRIGGER synthetic_publication_failure');
  }
  assert.deepEqual(master.getState('adaptive:mqtt'), { synthetic: 'previous-model' });
  assert.equal(master.learningEpoch('mqtt'), 'original');
  assert.deepEqual(master.getState('pending-plan:mqtt'), { id: 'synthetic-previous-plan' });
  assert.equal(master.db.prepare("SELECT COUNT(*) n FROM recovery_runs WHERE status='complete'").get().n, 0);
  assert.equal(master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('cancelled recovery skips failure bookkeeping behind an external SQLite writer', { timeout: 5000 }, async t => {
  const { master, donorPath } = fixture(t), donor = new Store(`${donorPath}.working`);
  donor.observation({ source: 'synthetic', device: 'cancellation-fixture', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: 1000, receivedAt: 1000 });
  await donor.backup(donorPath); donor.close();
  const preview = await recoveryPreview({ masterPath: master.path, donorPath, signal: t.signal });
  const lock = new DatabaseSync(master.path), cancellation = new AbortController();
  let timer, locked = false;
  try {
    const outcome = recoverHistory({ store: master, donorPath, preview, signal: cancellation.signal,
      onProgress(value) {
        if (locked || value.phase !== 'importing') return;
        assert.match(master.getState('recovery:active:mqtt').operationToken, /^[a-f0-9-]{36}$/);
        lock.exec('BEGIN IMMEDIATE'); locked = true; cancellation.abort();
      } }).catch(error => error);
    const error = await Promise.race([outcome, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancelled recovery waited for SQLite diagnostics')), 1500);
    })]);
    assert.equal(error.code, 'recovery_invalid');
    assert.equal(locked, true, 'Cancellation happens after a durable recovery operation exists');
    assert.equal(master.observations().length, 1, 'Already committed source evidence survives cancellation');
    assert.equal(master.writeQueueStatus().pending, 0);
    assert.deepEqual(master.getState('adaptive:mqtt'), { synthetic: 'previous-model' });
  } finally { clearTimeout(timer); if (locked) lock.exec('ROLLBACK'); lock.close(); }
});

test('cancellation after publication commit reports the completed recovery and joins model adoption', async t => {
  const { master, donorPath } = fixture(t), donor = new Store(`${donorPath}.working`);
  sample(donor, start + W);
  await donor.backup(donorPath); donor.close();
  const preview = await recoveryPreview({ masterPath: master.path, donorPath, signal: t.signal });
  const cancellation = new AbortController();
  let adopted = null;
  const result = await recoverHistory({ store: master, donorPath, preview,
    signal: AbortSignal.any([cancellation.signal, t.signal]),
    onPublish(value) {
      assert.equal(master.getState('recovery:active:mqtt').status, 'complete');
      adopted = value.checkpoint;
      cancellation.abort();
    } });
  assert(cancellation.signal.aborted);
  assert.equal(result.report.status, 'complete');
  assert.equal(master.getState('recovery:active:mqtt').status, 'complete');
  assert.equal(master.learningEpoch('mqtt'), result.epoch);
  assert.deepEqual(adopted, result.checkpoint);
  assert.deepEqual(master.getState('adaptive:mqtt'), adopted);
  assert.equal(master.db.prepare("SELECT COUNT(*) n FROM recovery_runs WHERE status='complete'").get().n, 1);
});

test('paired transport and recovery UI preserve fixed causes while hiding arbitrary messages', async t => {
  const options = { token: 'synthetic-recovery-error-test-token-0123456789', pairId: 'synthetic-diagnostics', listenHost: '127.0.0.1', port: 0 };
  const server = new PairPeer({ ...options, handler: (_operation, { code }) => {
    throw Object.assign(new Error('private-household-value'), { code });
  } });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await client.close(); await server.close(); });
  for (const code of RECOVERY_ERROR_CODES) {
    await assert.rejects(client.request('status', { code }), { code, message: code });
    const view = { role: 'master', canControl: true, peer: { reachable: true, role: 'protected' }, recovery: { state: 'error', error: code } };
    assert.equal(pairDisplay(view).recovery, pairIssueHelp(view));
    assert.ok(pairIssueHelp(view).length > 20);
    assert.doesNotMatch(pairDisplay(view).recovery, /private-household-value|Review the current computer roles/);
    const safeMessage = recoveryFailure({ code }).error;
    assert.equal(recoveryJobText({ job: { status: 'error', error: safeMessage } }), safeMessage);
  }
  await assert.rejects(client.request('status', { code: 'private-household-value' }), { code: 'peer_protocol_failed' });
  assert.equal(pairIssueHelp({ recovery: { error: 'private-household-value' } }), '');
  assert.doesNotMatch(recoveryJobText({ job: { status: 'error', error: 'private-household-value' } }), /private-household-value/);
});

test('standalone recovery persists only the fixed diagnostic, including after reopening', async t => {
  const { directory, master, donorPath } = fixture(t);
  const engine = { config: { input: 'mqtt' } };
  const options = { store: master, getEngine: () => engine,
    recoveryModule: async () => ({ recoveryPreview: async () => {
      throw Object.assign(new Error(`${directory}/private-source.sqlite`), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    } }) };
  const coordinator = createHistoryRecovery(options); await coordinator.initialize();
  await assert.rejects(coordinator.checkPath({ donorPath, source: { kind: 'upload', label: 'Uploaded database' } }));
  await coordinator.settled();
  assert.match(coordinator.currentJob().error, /ran out of storage space/);
  assert.equal(coordinator.currentJob().errorCode, 'recovery_storage_full');
  assert.doesNotMatch(coordinator.currentJob().error, /private-source|stmq-recovery-errors/);
  await coordinator.close();
  const reopened = createHistoryRecovery(options); await reopened.initialize();
  assert.match(reopened.currentJob().error, /ran out of storage space/);
  assert.equal(reopened.currentJob().errorCode, 'recovery_storage_full');
  await reopened.close();
});
