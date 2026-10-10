import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fixture, sample, recover, start, W } from './helpers/recovery-fixture.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';

const cycle = (id, index = 0) => ({
  id, input: 'mqtt', status: 'completed', startedAt: start + (index + 3) * W,
  endedAt: start + (index + 4) * W, plan: { model: { trainedAt: start + 2 * W } },
  actual: { costCents: 80 }, assessment: { profitCents: 20, uncertaintyCents: 5, recoveryErrorCents: 2 },
});

async function recoveredCycles(t) {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  sample(donor, start + 2 * W);
  const recovered = await recover(f, await f.snapshot(donor));
  const frozen = Array.from({ length: 130 }, (_, index) => cycle(`invented-cycle-${String(index).padStart(3, '0')}`, index));
  f.master.transaction(() => { for (const value of frozen) f.master.cycle('mqtt', value); });
  const args = { store: f.master, recoveryId: recovered.report.recoveryId, active: false, signal: t.signal };
  return { ...f, args, frozen, preview: await previewRecoveryRevision(args) };
}

// Drive the existing worker handshake directly so redundant batches are counted
// deterministically, without production pacing or a machine-speed assertion.
function revisionWorker(data) {
  const worker = new Worker(new URL('../src/recovery/revision-worker.js', import.meta.url), { workerData: data });
  let yields = 0, waiting = null, failure = null;
  const ready = [];
  const fail = error => { failure = error; waiting?.reject(error); waiting = null; };
  worker.on('error', fail);
  worker.on('exit', code => { if (waiting) fail(new Error(`Revision worker exited before ready (${code})`)); });
  worker.on('message', message => {
    if (message.type === 'yield') { yields++; worker.postMessage({ type: 'continue', id: message.id }); }
    if (message.type === 'failed') fail(new Error(message.error));
    if (message.type === 'ready') {
      const result = { ...message, yields }; yields = 0;
      if (waiting) { waiting.resolve(result); waiting = null; } else ready.push(result);
    }
  });
  const next = () => {
    if (failure) return Promise.reject(failure);
    if (ready.length) return Promise.resolve(ready.shift());
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };
  return { next, catchup() { const result = next(); worker.postMessage({ type: 'catchup' }); return result; },
    close: () => worker.terminate() };
}

test('revision catch-up skips invalidated assessment batches and admits newly affected cycles', { timeout: 30000 }, async t => {
  const f = await recoveredCycles(t);
  const worker = revisionWorker({ mode: 'revision', masterPath: f.master.path, input: 'mqtt',
    recoveryId: f.args.recoveryId, active: false, preview: f.preview });
  const cancelled = () => { void worker.close(); };
  t.signal.addEventListener('abort', cancelled, { once: true });
  try {
    const initial = await worker.next();
    const repeated = await worker.catchup();
    assert.equal(repeated.yields, 0, 'unchanged catch-up must not transact and yield for already invalidated assessments');
    assert.deepEqual(repeated.checkpoint, initial.checkpoint);
    const excluded = f.master.db.prepare("SELECT COUNT(*) n FROM recovery_exclusions WHERE generation=? AND table_name='cycle_assessments'");
    assert.equal(excluded.get(initial.generation).n, f.frozen.length);

    // A fresh scan must still find new affected IDs before the old scan cursor.
    const late = cycle('a-new-affected-cycle', 131);
    f.master.cycle('mqtt', late);
    for (let window = 3; window <= 4; window++) {
      sample(f.master, start + window * W);
      const caught = await worker.catchup();
      assert.equal(caught.sourceHead, f.master.learningJournalHead('mqtt'));
      assert.equal(caught.checkpoint.windowCursor, start + window * W);
      assert.equal(excluded.get(initial.generation).n, f.frozen.length + 1);
      assert.equal((await worker.catchup()).yields, 0, 'later retries also skip the newly invalidated assessment');
    }
    assert.deepEqual(f.master.cycles({ input: 'mqtt', limit: 200 }), [late, ...f.frozen.toReversed()]);
    assert.equal(f.master.learningEpoch('mqtt'), initial.sourceEpoch, 'worker staging cannot publish a history selection');
  } finally {
    t.signal.removeEventListener('abort', cancelled);
    await worker.close();
  }
});

test('reversal publishes during continuing learning and preserves assessment evidence through restoration', { timeout: 30000 }, async t => {
  const f = await recoveredCycles(t);
  const late = cycle('a-cycle-recorded-during-reversal', 131);
  let timer = null, pending = null, streaming = true, failure = null, nextWindow = 3;
  let liveWrites = 0, forcedCatchup = false, publishedWhileStreaming = false;
  const stop = () => { streaming = false; clearInterval(timer); timer = null; };
  const write = () => {
    if (pending) return;
    pending = f.master.runWrite(() => {
      sample(f.master, start + nextWindow++ * W); liveWrites++;
    }, { signal: t.signal, isCurrent: () => streaming })
      .catch(error => { if (error.code !== 'STORAGE_WRITE_STALE') failure ??= error; })
      .finally(() => { pending = null; });
  };
  let result;
  try {
    result = await reviseRecovery({ ...f.args, preview: f.preview,
      async onProgress(value) {
        if (timer === null && streaming && value.phase === 'checking') {
          timer = setInterval(write, 100); write();
        }
        if (!forcedCatchup && value.phase === 'publishing') {
          forcedCatchup = true;
          await f.master.runWrite(() => {
            f.master.cycle('mqtt', late);
            sample(f.master, start + nextWindow++ * W); liveWrites++;
          }, { signal: t.signal });
        }
      },
      onPublish() { publishedWhileStreaming = streaming && timer !== null; stop(); },
    });
  } finally { stop(); await pending; }
  assert.ifError(failure);
  assert(forcedCatchup && publishedWhileStreaming);
  assert(liveWrites >= 2, 'learning commits during reversal and forces a publication retry');
  assert.equal(result.checkpoint.windowCursor, start + (nextWindow - 1) * W);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint);
  const frozen = [late, ...f.frozen.toReversed()];
  assert.deepEqual(f.master.cycles({ input: 'mqtt', limit: 200 }), frozen);
  const summaries = f.master.cycleSummaries({ input: 'mqtt', limit: 200 });
  assert.equal(summaries.length, frozen.length);
  assert(summaries.every(row => row.profitCents === null && row.uncertaintyCents === null && row.recoveryErrorCents === null));
  assert(summaries.every(row => row.actualCostCents === 80), 'observed costs survive assessment invalidation');

  const restore = { ...f.args, active: true };
  const restored = await reviseRecovery({ ...restore, preview: await previewRecoveryRevision(restore) });
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), restored.checkpoint);
  assert(f.master.cycleSummaries({ input: 'mqtt', limit: 200 }).every(row => row.profitCents === 20));
  assert.deepEqual(f.master.cycles({ input: 'mqtt', limit: 200 }), frozen);
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});
