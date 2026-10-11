import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';
import { recoveryPreview } from '../src/recovery/service.js';
import { checkedRecoverySource, emptyRecoverySource } from '../src/recovery/source-check.js';
import { readReplicaPublication } from '../src/replication/publication.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const command = extra => ({ requestId: randomUUID(), confirmed: true, ...extra });
function useStore(path, fn, { readOnly = false } = {}) {
  const store = new Store(path, { readOnly });
  try { return fn(store); } finally { store.close(); }
}
function observe(path, at, value) {
  return useStore(path, store => store.observation({ source: 'synthetic', device: 'invented-house',
    signal: 'indoor_temperature', unit: 'degC', value, sourceTime: at, receivedAt: at }));
}
function contents(path) {
  return useStore(path, store => ({ observations: store.observations(),
    model: store.getState('synthetic-model-reference'), epoch: store.learningEpoch('mqtt') }), { readOnly: true });
}
function connect(left, right) {
  left.peer.peerUrl = `http://127.0.0.1:${right.peer.server.address().port}`;
  right.peer.peerUrl = `http://127.0.0.1:${left.peer.server.address().port}`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-empty-pair-recovery-')), instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const primaryPath = join(root, 'master.sqlite');
  useStore(primaryPath, store => store.setState('synthetic-model-reference', { trained: true, coefficient: 12 }));
  observe(primaryPath, START, 20);
  let importCalls = 0;
  async function manager(name, { restart = false, hooks = {} } = {}) {
    let instance, owned = false;
    const config = { directory: join(root, name), snapshotDirectory: join(root, `${name}-replica`),
      databasePath: join(root, `${name}.sqlite`), pairId: 'synthetic-empty-source-pair',
      token: 'synthetic-empty-source-token-0123456789abcdef', platform: name === 'master' ? 'hassio' : 'ubuntu',
      listenHost: '127.0.0.1', port: 0, peerUrl: 'http://127.0.0.1:1',
      timeoutMs: 30000, intervalMs: 60000, vip: {} };
    instance = new PairManager({ config, announcements: () => null,
      vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; },
        status: () => ({ owned, ready: owned }) },
      hooks: { startPrimary: async () => {}, startReplica: async () => {},
        stopControl: async () => {}, closeReplica: async () => {},
        recoveryPreview: ({ donorPath, donorJournalPath }) => recoveryPreview({
          masterPath: instance.state.value.activeDbPath, donorPath, donorJournalPath, signal: t.signal }),
        recoveryApply: async () => { importCalls++; throw Error('An empty source must not be imported'); }, ...hooks } });
    instances.push(instance);
    await instance.init(); await instance.start(); clearTimeout(instance.timer);
    if (name === 'master' && !restart) await instance.promote();
    return instance;
  }
  const primary = await manager('master'), donor = await manager('donor');
  connect(primary, donor);
  await donor.synchronize(primary.state.claim());
  assert.equal(donor.sync.state, 'ready');
  const publication = await readReplicaPublication(donor.config.snapshotDirectory);
  // This offline fixture represents a previous refusal with unchanged history.
  // It does not pretend that different software caused the household failure.
  await donor.state.update({ role: 'protected', reason: 'snapshot_verification_failed' });
  donor.sync = { ...donor.sync, state: 'error', error: 'verification_failed' };
  await primary.poll();
  return { root, primary, donor, donorPath: publication.dbPath, manager,
    imports: () => importCalls, async check() {
      await primary.action('check-recovery', command());
      return primary.status().recovery.preview;
    } };
}

test('a populated protected source with no changed history can resume verified mirroring without recovery', async t => {
  const f = await fixture(t), before = contents(f.primary.state.value.activeDbPath);
  observe(f.primary.state.value.activeDbPath, START + 1000, 21);
  const master = contents(f.primary.state.value.activeDbPath), preview = await f.check();
  assert.equal(checkedRecoverySource(preview), true);
  assert.equal(emptyRecoverySource(preview), true);
  assert.equal(preview.incremental.records, 0);
  assert.deepEqual(preview.incremental.base, preview.incremental.checkpoint);
  assert.equal(contents(f.donorPath).observations.length, 1, 'the populated source is not an empty database');
  assert.equal(master.observations.length, 2, 'the source check does not establish master catch-up');
  assert.equal(f.donor.state.value.reason, 'snapshot_verification_failed', 'checking does not clear mirroring failure');
  assert.equal(f.primary.status().actions.recover, false);
  assert.equal(f.primary.status().actions.rejoin, true);
  await assert.rejects(f.primary.action('recover', command({ previewId: preview.previewId })), { code: 'invalid_transition' });
  assert.equal(f.imports(), 0);
  await assert.rejects(f.primary.action('rejoin', command()), { code: 'invalid_transition' });
  await assert.rejects(f.primary.action('rejoin', command({ previewId: 'b'.repeat(64) })), { code: 'invalid_transition' });
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId, discardUnrecovered: true })),
    { code: 'invalid_transition' }, 'a new empty-source action must not claim to skip history');
  const action = command({ previewId: preview.previewId });
  await f.primary.action('rejoin', action);
  assert.equal(f.imports(), 0);
  assert.equal(f.donor.state.value.role, 'slave');
  assert.equal(f.donor.canControl(), false);
  assert.equal(f.primary.canControl(), true);
  assert.equal(f.donor.state.value.reason, null);
  assert.equal(f.donor.sync.state, 'ready');
  assert.deepEqual(contents(f.primary.state.value.activeDbPath), master, 'resume does not rewrite master history or model');
  const mirrored = contents((await readReplicaPublication(f.donor.config.snapshotDirectory)).dbPath);
  assert.deepEqual(mirrored, master);
  assert.deepEqual(mirrored.model, before.model);
  assert.equal(f.primary.status().recovery.report.status, 'no-recovery-needed');
  assert.equal(f.primary.status().recovery.report.imported, 0);
  assert.equal(f.primary.status().recovery.report.model.status, 'unchanged');
  assert.notEqual(f.primary.status().recovery.report.recoverySkipped, true);
  assert.equal((await f.primary.action('rejoin', action)).duplicate, true);
});

test('nonempty checks retain changed periods and cannot resume without recovery or explicit discard consent', async t => {
  const f = await fixture(t);
  observe(f.donorPath, START + 2000, 22);
  observe(f.donorPath, START + 4000, 23);
  const preview = await f.check();
  assert.equal(checkedRecoverySource(preview), true);
  assert.equal(emptyRecoverySource(preview), false);
  assert.equal(preview.incremental.records, 2);
  assert.deepEqual(preview.sourceSummary.categories.find(row => row.name === 'temperatures'),
    { name: 'temperatures', count: 2, from: START + 2000, to: START + 4000, undated: 0 });
  assert.equal(preview.tables.find(row => row.name === 'observations').count, 2);
  assert(Number.isSafeInteger(preview.sourceSummary.checkedAt));
  assert.equal(f.primary.status().actions.recover, true);
  assert.equal(f.primary.status().actions.rejoin, true);
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'recovery_required' });
  assert.equal(f.donor.state.value.role, 'protected');
  assert.equal(f.imports(), 0);
});

test('unknown, incomplete, unsupported and category-zero results cannot claim an empty checked source', async t => {
  const f = await fixture(t), preview = await f.check();
  for (const [description, patch] of [
    ['unknown', { status: 'pending' }],
    ['missing inventory', { tables: undefined }],
    ['empty inventory', { tables: [] }],
    ['actual changed records', { incremental: { ...preview.incremental, records: 1 } }],
    ['changed checkpoint', { incremental: { ...preview.incremental,
      checkpoint: { ...preview.incremental.checkpoint, sequence: preview.incremental.checkpoint.sequence + 1 } } }],
    ['invalid checkpoint', { incremental: { ...preview.incremental, checkpoint: { sequence: 0 } } }],
    ['unsupported only', { unsupported: [{ name: 'charging_reports', count: 1 }] }],
    ['uncounted source category', { sourceSummary: { ...preview.sourceSummary,
      categories: preview.sourceSummary.categories.map(row => row.name === 'events' ? { ...row, count: 1 } : row) } }],
    ['omitted learning inputs', { sourceAssessment: { ...preview.sourceAssessment, skippedLearningRecords: 1 } }],
    ['malformed row count', { tables: [{ name: 'observations', count: '0' }] }],
  ]) {
    const candidate = { ...preview, ...patch };
    assert.equal(emptyRecoverySource(candidate), false, description);
    await f.primary.state.update({ recovery: { ...f.primary.state.value.recovery, preview: candidate } });
    await assert.rejects(f.primary.action('rejoin', command({ previewId: candidate.previewId })), { code: 'recovery_required' }, description);
    assert.equal(f.donor.state.value.role, 'protected', description);
  }
  assert.equal(f.imports(), 0);
});

test('changed donor history after an empty check needs a new source check before mirroring', async t => {
  const f = await fixture(t), preview = await f.check(), master = contents(f.primary.state.value.activeDbPath);
  observe(f.donorPath, START + 2000, 22);
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'recovery_required' });
  assert.equal(f.donor.state.value.role, 'protected');
  assert.equal(f.primary.status().recovery.pendingRelease, null);
  assert.equal(contents(f.donorPath).observations.length, 2);
  assert.deepEqual(contents(f.primary.state.value.activeDbPath), master);
  const changed = await f.check();
  assert.notEqual(changed.previewId, preview.previewId);
  assert.equal(emptyRecoverySource(changed), false);
  assert.equal(f.primary.status().actions.recover, true);
  await assert.rejects(f.primary.action('rejoin', command({ previewId: changed.previewId })), { code: 'recovery_required' });
  assert.equal(f.imports(), 0);
});

test('an empty structural summary cannot bypass saved preview integrity or checked donor checkpoint binding', async t => {
  const f = await fixture(t), preview = await f.check(), recovery = structuredClone(f.primary.state.value.recovery);
  for (const [description, candidate] of [
    ['altered preview identity', { ...recovery, preview: { ...preview, previewId: 'b'.repeat(64) } }],
    ['altered checked report', { ...recovery, preview: { ...preview,
      sourceSummary: { ...preview.sourceSummary, checkedAt: preview.sourceSummary.checkedAt + 1 } } }],
    ['different checked donor checkpoint', { ...recovery, metadata: { ...recovery.metadata,
      checkpoint: { ...recovery.metadata.checkpoint, sequence: recovery.metadata.checkpoint.sequence + 1 } } }],
  ]) {
    assert.equal(emptyRecoverySource(candidate.preview), true, description);
    await f.primary.state.update({ recovery: candidate });
    await assert.rejects(f.primary.action('rejoin', command({ previewId: candidate.preview.previewId })),
      { code: 'recovery_required' }, description);
    assert.equal(f.primary.status().recovery.pendingRelease, null, description);
    assert.equal(f.donor.state.value.role, 'protected', description);
  }
  assert.equal(f.imports(), 0);
});

for (const mode of ['unsupported-only', 'deletion-only']) test(`real ${mode} donor changes with zero supported counts cannot authorize empty-source mirroring`, async t => {
  const f = await fixture(t);
  useStore(f.donorPath, store => {
    if (mode === 'deletion-only') store.db.exec('DELETE FROM observations');
    else store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,ended_at,summary,checkpoint)
      VALUES('mqtt','charger-2','invented-report','invented-association',?,NULL,'{}','{}')`).run(START + 2000);
  });
  const preview = await f.check();
  assert.equal(checkedRecoverySource(preview), true);
  assert(preview.tables.every(row => row.count === 0));
  assert(preview.sourceSummary.categories.every(row => row.count === 0));
  if (mode === 'unsupported-only') {
    assert.equal(preview.incremental.records, 1);
    assert.equal(preview.unsupported.find(row => row.name === 'charging_reports').count, 1);
  } else {
    assert.equal(preview.incremental.records, 0);
    assert.notDeepEqual(preview.incremental.base, preview.incremental.checkpoint);
  }
  assert.equal(emptyRecoverySource(preview), false);
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'recovery_required' });
  assert.equal(f.donor.state.value.role, 'protected');
  assert.equal(f.primary.status().recovery.pendingRelease, null);
  assert.equal(f.imports(), 0);
});

test('an empty preview cannot authorize a promoted peer or act without master authority', async t => {
  const f = await fixture(t), preview = await f.check();
  await f.donor.action('promote', command());
  assert.equal(f.donor.state.value.role, 'master');
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'invalid_transition' });
  assert.equal(f.primary.status().recovery.pendingRelease, null);
  await assert.rejects(f.donor.action('rejoin', command({ previewId: preview.previewId })), { code: 'recovery_required' });
  // Demotion fences a formerly authorized request even while its preview remains.
  await f.primary.state.update({ role: 'protected' });
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'not_master' });
  assert.equal(f.primary.canControl(), false);
  assert.equal(f.imports(), 0);
});

test('a current format refusal after an empty check preserves donor files and protection', async t => {
  const f = await fixture(t), preview = await f.check(), master = contents(f.primary.state.value.activeDbPath);
  useStore(f.donorPath, store => store.db.exec('PRAGMA user_version=7'));
  const bytes = await readFile(f.donorPath);
  await assert.rejects(f.primary.action('rejoin', command({ previewId: preview.previewId })), { code: 'database_schema_mismatch' });
  assert.deepEqual(await readFile(f.donorPath), bytes);
  assert.equal(f.donor.state.value.role, 'protected');
  assert.deepEqual(contents(f.primary.state.value.activeDbPath), master);
  assert.equal(f.imports(), 0);
});

test('full verification failure during empty-source rejoin does not clear protection or claim success', async t => {
  const f = await fixture(t), preview = await f.check();
  observe(f.primary.state.value.activeDbPath, START + 1000, 21);
  const verify = f.donor.fullVerification.bind(f.donor);
  f.donor.fullVerification = async (...args) => {
    const result = await verify(...args);
    return { ...result, digest: 'a'.repeat(64) };
  };
  const action = command({ previewId: preview.previewId, verifyWithFullSnapshot: true });
  await assert.rejects(f.primary.action('rejoin', action), { code: 'full_verification_content_mismatch' });
  assert.equal(f.donor.state.value.role, 'protected');
  assert.equal(f.donor.canControl(), false);
  assert.equal(f.primary.status().recovery.state, 'ready');
  assert.equal(f.primary.status().recovery.report, null);
  assert.equal(f.primary.status().recovery.pendingRelease.requestId, action.requestId);
  assert.equal(f.imports(), 0);
  f.donor.fullVerification = verify;
  await f.primary.action('rejoin', action);
  assert.equal(f.donor.state.value.role, 'slave');
  assert.equal(f.primary.status().recovery.report.status, 'no-recovery-needed');
});

test('lost empty-source release replies survive restart and retry only the original checked request', async t => {
  const f = await fixture(t), preview = await f.check();
  observe(f.primary.state.value.activeDbPath, START + 1000, 21);
  const originalRequest = f.primary.peer.request.bind(f.primary.peer), sent = [];
  const action = command({ previewId: preview.previewId, verifyWithFullSnapshot: true });
  f.primary.peer.request = async (operation, body, options) => {
    const result = await originalRequest(operation, body, options);
    if (operation === 'release') {
      sent.push(structuredClone(body));
      throw Object.assign(Error('Synthetic lost reply'), { code: 'peer_unavailable' });
    }
    return result;
  };
  await assert.rejects(f.primary.action('rejoin', action), { code: 'peer_unavailable' });
  assert.equal(f.donor.state.value.role, 'slave');
  const saved = structuredClone(f.primary.state.value.recovery.releaseOperation);
  assert.equal(saved.skipRecovery, false);
  assert.equal(saved.requestId, action.requestId);
  assert.equal(saved.verifyWithFullSnapshot, true);
  assert.equal(f.primary.status().recovery.pendingRelease.previewId, action.previewId);
  await f.primary.close(); await f.donor.close();
  const primary = await f.manager('master', { restart: true }), donor = await f.manager('donor', { restart: true });
  connect(primary, donor); await primary.poll();
  const accepted = structuredClone(donor.state.value.accepted);
  assert.deepEqual(primary.state.value.recovery.releaseOperation, saved);
  assert.equal(primary.status().actions.rejoin, true);
  assert.equal(primary.status().actions['check-recovery'], false);
  await assert.rejects(primary.action('check-recovery', command()), { code: 'invalid_transition' });
  for (const patch of [{ requestId: randomUUID() }, { previewId: 'b'.repeat(64) },
    { previewId: undefined }, { discardUnrecovered: true }, { verifyWithFullSnapshot: false }])
    await assert.rejects(primary.action('rejoin', { ...action, ...patch }), { code: 'invalid_transition' });
  const retry = primary.peer.request.bind(primary.peer);
  primary.peer.request = async (operation, body, options) => {
    if (operation === 'release') sent.push(structuredClone(body));
    return retry(operation, body, options);
  };
  await primary.action('rejoin', action);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'retry sends the frozen verified release without a new export or authority scope');
  assert.deepEqual(donor.state.value.accepted, accepted);
  assert.equal(primary.status().recovery.state, 'resolved');
  assert.equal(primary.status().recovery.report.status, 'no-recovery-needed');
  assert.equal(primary.status().recovery.report.imported, 0);
  assert.equal(primary.status().recovery.report.model.status, 'unchanged');
  assert.equal(f.imports(), 0);
});

test('an already authorized current-session skip release remains exactly retryable for an empty source', async t => {
  const f = await fixture(t), preview = await f.check(), recovery = f.primary.state.value.recovery;
  const action = command({ previewId: preview.previewId, discardUnrecovered: true });
  const checkpoint = await f.primary.exportCheckpoint();
  const delivery = await f.primary.peerTransfers.export({ dbPath: f.primary.state.value.activeDbPath,
    after: preview.incremental.base, refresh: true, signal: t.signal });
  // Model an existing accepted release from this current-format session. It is
  // a saved physical obligation, not permission to create another skip action.
  const operation = { requestId: action.requestId, donor: recovery.metadata,
    metadata: { ...checkpoint, checkpoint: delivery.target, digest: delivery.target.hash },
    skipRecovery: true, verifyWithFullSnapshot: false };
  await f.primary.state.update({ recovery: { ...recovery, releaseOperation: operation },
    actions: [...f.primary.state.value.actions, { requestId: action.requestId, name: 'rejoin', state: 'error',
      startedAt: Date.now(), finishedAt: Date.now(), error: 'peer_unavailable' }] });
  await f.primary.close();
  const restarted = await f.manager('master', { restart: true });
  connect(restarted, f.donor); await restarted.poll();
  assert.deepEqual(restarted.state.value.recovery.releaseOperation, operation);
  await assert.rejects(restarted.action('rejoin', { ...action, discardUnrecovered: false }), { code: 'invalid_transition' });
  await assert.rejects(restarted.action('rejoin', { ...action, requestId: randomUUID() }), { code: 'invalid_transition' });
  await restarted.action('rejoin', action);
  assert.equal(f.donor.state.value.role, 'slave');
  assert.equal(restarted.status().recovery.report.status, 'skipped');
  assert.equal(restarted.status().recovery.report.recoverySkipped, true);
  assert.equal(restarted.status().recovery.report.imported, 0);
  assert.equal(f.imports(), 0);
});
