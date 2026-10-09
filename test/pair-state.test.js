import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptsLineage, PairState } from '../src/pairing/state.js';

test('malformed saved authority is rejected before changing state or acquiring a node lock', async t => {
  const directory = await mkdtemp('/tmp/stmq-pair-state-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'history.sqlite'), path = join(directory, 'state.json');
  const saved = { version: 3, pairId: 'fixture-pair', nodeId: randomUUID(), epoch: randomUUID(),
    platform: 'ubuntu', role: 'master', sequence: 0, ancestors: [], everWritten: true,
    bootstrapPending: false, accepted: null, activeDbPath: databasePath, reason: null,
    transition: null, release: null, actions: [], createdAt: 1000, updatedAt: 1000 };
  const options = { directory, databasePath, pairId: saved.pairId, platform: saved.platform };
  const accepted = { generation: randomUUID(), digest: 'a'.repeat(64), nodeId: randomUUID(),
    epoch: randomUUID(), sequence: 3 };
  const receipt = { mode: 'fresh', requestId: randomUUID(), archiveDirectory: '/tmp/synthetic-reset-archive',
    completedAt: 1000, backupCount: 1, unavailableCount: 0, unavailableReasons: [] };
  const invalid = [
    { sequence: -1 }, { sequence: 0.5 }, { ancestors: [null] },
    { ancestors: [{ epoch: randomUUID(), sequence: -1 }] },
    { bootstrapPending: 'false' }, { activeDbPath: null }, { activeDbPath: 'relative.sqlite' },
    { accepted: {} }, { accepted: { ...accepted, sequence: -1 } },
    { accepted: { ...accepted, nodeId: 'retired-node' } },
    { accepted: { ...accepted, digest: 'invalid' } },
    { dbStamp: { epoch: randomUUID(), sequence: 1, token: '' } },
    { pendingStamp: { epoch: randomUUID(), sequence: -1, token: randomUUID() } },
    { supersededPeer: { nodeId: randomUUID(), epoch: null } },
    { actions: [null] }, { actions: [{ requestId: randomUUID(), name: 'promote', state: 'approved' }] },
    { retiredAuthority: true },
    ...[undefined, false, true, 0, '', [], {}, { kind: 'handover' },
      { kind: 'handover', phase: 'stopping', token: randomUUID() },
      { kind: 'handover', phase: 'quiescing', token: randomUUID(), peerNodeId: randomUUID() },
      { kind: 'handover', phase: 'released', token: randomUUID(), peerNodeId: randomUUID() },
      { kind: 'handover', phase: 'prepared', token: randomUUID(), peerNodeId: randomUUID(), epoch: randomUUID() },
      { kind: 'handover', phase: 'staged', token: randomUUID(), peerNodeId: randomUUID(), epoch: randomUUID(), ocpp: false, mqtt: null },
      { kind: 'handover', phase: 'stopping', token: randomUUID(), peerNodeId: randomUUID(), retiredAuthority: true },
    ].map(transition => ({ transition })),
    { createdAt: -1 }, { updatedAt: 'recent' },
    { accepted: { ...accepted, checkpoint: {} } },
    { accepted: { ...accepted, retiredAuthority: true } },
    { release: {} }, { releaseReceipt: {} },
    { release: { epoch: randomUUID(), digest: 'a'.repeat(64), identity: null } },
    { resetReceipt: { ...receipt, backupCount: undefined } },
    { resetReceipt: { ...receipt, unavailableCount: -1 } },
    { resetReceipt: { ...receipt, unavailableCount: 1, unavailableReasons: [] } },
    { resetReceipt: { ...receipt, unavailableCount: 1, unavailableReasons: ['private raw error'] } },
    { resetReceipt: { ...receipt, unavailableReasons: ['invalid-database'] } },
    { resetReceipt: { ...receipt, unavailableCount: 2, unavailableReasons: ['invalid-database', 'invalid-database'] } },
  ];
  for (const patch of invalid) {
    const raw = JSON.stringify({ ...saved, ...patch });
    await writeFile(path, raw, { mode: 0o600 });
    await assert.rejects(new PairState(options).open(), { code: 'invalid_pair_state' });
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.deepEqual(await readdir(directory), ['state.json']);
  }
});

test('invalid updates preserve both durable authority and the usable in-memory state', async t => {
  const directory = await mkdtemp('/tmp/stmq-pair-state-update-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new PairState({ directory, databasePath: join(directory, 'history.sqlite'), pairId: 'fixture-pair', platform: 'ubuntu' });
  await state.open(); t.after(() => state.close());
  const before = structuredClone(state.value), bytes = await readFile(state.path);
  for (const patch of [{ transition: false }, { role: 'retired' }, { sequence: -1 }, { retiredAuthority: true }]) {
    await assert.rejects(state.update(patch), { code: 'invalid_pair_state' });
    assert.deepEqual(state.value, before);
    assert.deepEqual(await readFile(state.path), bytes);
  }
  await state.update({ reason: 'synthetic-retry' });
  assert.equal(state.value.reason, 'synthetic-retry', 'A rejected update does not poison later valid transitions');
});

test('every current handover phase survives restart without translating or losing its requirements', async t => {
  for (const phase of ['stopping', 'released', 'prepared', 'staged']) await t.test(phase, async () => {
    const directory = await mkdtemp('/tmp/stmq-pair-state-handover-');
    try {
      const options = { directory, databasePath: join(directory, 'history.sqlite'), pairId: 'fixture-pair', platform: 'ubuntu' };
      const state = new PairState(options); await state.open();
      const transition = { kind: 'handover', phase, token: randomUUID(), peerNodeId: randomUUID(),
        ...(phase === 'released' ? { generation: randomUUID() } : {}),
        ...(['prepared', 'staged'].includes(phase) ? { epoch: randomUUID(), ocpp: null,
          mqtt: { version: 1, protocol: 'mqtt:', port: 1883 } } : {}) };
      await state.update({ transition }); await state.close();
      const restarted = new PairState(options);
      try { await restarted.open(); assert.deepEqual(restarted.value.transition, transition); }
      finally { await restarted.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('current saved state retains valid accepted history and permits a genuinely absent optional bootstrap flag', async t => {
  const directory = await mkdtemp('/tmp/stmq-pair-state-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, databasePath: join(directory, 'history.sqlite'), pairId: 'fixture-pair', platform: 'ubuntu' };
  const state = new PairState(options);
  await state.open();
  const accepted = { generation: randomUUID(), digest: 'b'.repeat(64), nodeId: randomUUID(), epoch: randomUUID(), sequence: 5 };
  const resetReceipt = { mode: 'fresh', requestId: randomUUID(), archiveDirectory: '/tmp/synthetic-reset-archive',
    completedAt: 1000, backupCount: 2, unavailableCount: 1, unavailableReasons: ['invalid-database'] };
  await state.update({ accepted, bootstrapPending: undefined, resetReceipt });
  const nodeId = state.value.nodeId;
  await state.close();
  const restarted = new PairState(options);
  await restarted.open();
  try {
    assert.equal(restarted.value.nodeId, nodeId);
    assert.deepEqual(restarted.value.accepted, accepted);
    assert.deepEqual(restarted.value.resetReceipt, resetReceipt);
    assert.equal(restarted.value.bootstrapPending, undefined);
    assert.equal(restarted.value.role, 'slave');
  } finally { await restarted.close(); }
});

test('lineage comparisons fail closed for malformed branches without throwing or admitting partial proofs', () => {
  const accepted = { epoch: randomUUID(), sequence: 2 };
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'master', platform: 'ubuntu', sequence: 0,
    ancestors: [{ ...accepted }] };
  assert.equal(acceptsLineage(accepted, claim), true);
  assert.equal(acceptsLineage(null, null), false);
  assert.equal(acceptsLineage({ ...accepted, sequence: -1 }, claim), false);
  assert.equal(acceptsLineage(accepted, { ...claim, sequence: -1 }), false);
  assert.equal(acceptsLineage(accepted, { ...claim, ancestors: [null, ...claim.ancestors] }), false);
  assert.equal(acceptsLineage(accepted, { ...claim, ancestors: [...claim.ancestors, { epoch: randomUUID() }] }), false);
  assert.equal(acceptsLineage(accepted, { ...claim, ancestors: [{ ...accepted, sequence: 1 }] }), false);
});
