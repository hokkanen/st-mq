import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createHistoryRecovery } from '../src/app/history-recovery.js';
import * as recovery from '../src/recovery/service.js';
import { backgroundProgress } from '../chart/background-progress.js';
import { fixture, sample, start, W } from './helpers/recovery-fixture.js';

test('real worker counts and units reach coordinator state and the displayed phase fraction', async t => {
  const f = fixture(t), donorPath = join(f.directory, 'synthetic-progress.sqlite');
  sample(f.master, start + W);
  const donor = new Store(`${donorPath}.working`);
  try { sample(donor, start + W); sample(donor, start + 2 * W); }
  finally { await donor.backup(donorPath); donor.close(); }
  const source = { kind: 'upload', label: 'Uploaded database' }, progress = new Map();
  const engine = { config: { input: 'mqtt' }, checkpoint: null };
  let coordinator;
  const module = Object.fromEntries(['recoveryPreview', 'recoverHistory', 'previewRecoveryRevision', 'reviseRecovery']
    .map(name => [name, args => recovery[name]({ ...args, onProgress(value) {
      args.onProgress(value);
      const saved = coordinator.currentJob().progress;
      assert.deepEqual(saved, { ...value, updatedAt: saved.updatedAt });
      assert(Number.isFinite(saved.updatedAt));
      const rows = progress.get(coordinator.currentJob().kind) ?? [];
      rows.push(structuredClone(saved)); progress.set(coordinator.currentJob().kind, rows);
    } })]));
  coordinator = createHistoryRecovery({ store: f.master, getEngine: () => engine, recoveryModule: async () => module });
  const abort = () => coordinator.cancel();
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    await coordinator.initialize();
    const preview = await coordinator.checkPath({ donorPath, source });
    assert(!progress.get('check').some(value => value.phase === 'snapshotting'), 'Source-only checking does not copy the master');
    const digest = progress.get('check').findLast(value => value.phase === 'validating' && value.unit === 'bytes');
    assert.equal(digest?.processed, (await stat(donorPath)).size);
    assert.equal(digest?.total, digest.processed);
    const accepted = await coordinator.applyPath({ donorPath, preview, source });
    assert.equal(coordinator.currentJob().status, 'complete');
    for (const action of ['revert', 'restore']) {
      await coordinator.action({ action: `review-${action}`, requestId: randomUUID(), operationId: accepted.report.recoveryId });
      await coordinator.settled();
      assert.equal(coordinator.currentJob().status, 'complete');
      const review = (await coordinator.view()).preview;
      await coordinator.action({ action, requestId: randomUUID(), previewId: review.previewId, confirmed: true });
      await coordinator.settled();
      assert.equal(coordinator.currentJob().status, 'complete');
    }
    for (const action of ['recover', 'revert', 'restore']) {
      const replay = progress.get(action).findLast(value => value.phase === 'rebuilding' && value.total > 0);
      assert(replay, `${action}: the real worker supplies a measured replay total`);
      assert.equal(replay.unit, 'entries');
      assert.equal(replay.processed, replay.total);
      const displayed = backgroundProgress(replay, { startedAt: coordinator.currentJob().startedAt });
      assert(displayed.determinate, `${action}: the progress bar uses the measured phase fraction`);
      assert.equal(displayed.work, `${replay.total} of ${replay.total} entries`);
    }
    const preparing = [...progress.values()].flat().filter(value => value.total === undefined
      && ['validating', 'snapshotting', 'publishing'].includes(value.phase));
    assert(preparing.some(value => value.phase === 'validating'));
    assert(preparing.some(value => value.phase === 'publishing'));
    for (const value of preparing) {
      assert.equal(value.processed, 0);
      assert.equal(value.unit, undefined, `${value.phase}: an uncounted phase has no invented record unit`);
      assert.equal(backgroundProgress(value).work, '', `${value.phase}: the UI shows the phase without a false zero count`);
    }
  } finally {
    t.signal.removeEventListener('abort', abort);
    await coordinator.close();
  }
});
