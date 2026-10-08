import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recoveryPreview, recoverHistory, previewRecoveryRevision } from '../src/recovery/service.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

for (const mode of ['preview', 'revision-preview']) test(`${mode} removes only its own scratch on cancellation and completion`, async t => {
  const f = fixture(t), donorPath = join(f.directory, 'synthetic-cancellation.sqlite');
  const donor = new Store(`${donorPath}.working`);
  try { observation(donor, start, 21); } finally { await donor.backup(donorPath); donor.close(); }
  const directory = join(f.directory, mode === 'preview' ? 'chosen-work-directory' : 'recovery');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'preserved-marker'), 'synthetic unrelated work', { mode: 0o600 });
  let recoveryId;
  if (mode === 'revision-preview') {
    const args = { masterPath: f.master.path, donorPath, signal: t.signal };
    const preview = await recoveryPreview(args);
    const result = await recoverHistory({ ...args, store: f.master, preview });
    recoveryId = result.report.recoveryId;
  }
  const before = f.master.observations(), epoch = f.master.learningEpoch('mqtt');
  const run = (signal, onProgress = () => {}) => mode === 'preview'
    ? recoveryPreview({ masterPath: f.master.path, donorPath, workDirectory: directory, signal, onProgress })
    : previewRecoveryRevision({ store: f.master, recoveryId, active: false, signal, onProgress });
  const clean = async () => {
    assert.deepEqual(await readdir(directory), ['preserved-marker'], 'only the owned preview directory is removed');
    assert.deepEqual(f.master.observations(), before, 'a cancelled or completed review never changes source history');
    assert.equal(f.master.learningEpoch('mqtt'), epoch, 'review never publishes a different model history');
  };
  for (const stage of ['before-start', 'validating', 'checking']) await t.test(stage, async () => {
    const controller = new AbortController();
    let cancelled = stage === 'before-start';
    if (cancelled) controller.abort();
    await assert.rejects(run(AbortSignal.any([controller.signal, t.signal]), value => {
      if (!cancelled && value.phase === stage) {
        cancelled = true; controller.abort();
      }
    }));
    assert(cancelled, `the real worker reached ${stage}`);
    await clean();
  });
  await t.test('complete', async () => {
    const result = await run(t.signal);
    assert.equal(mode === 'preview' ? result.tables.find(row => row.name === 'observations').count : result.counts.affected, 1);
    await clean();
  });
});
