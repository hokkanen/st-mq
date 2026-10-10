import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../src/storage/store.js';
import { recoveryPreview, recoverHistory, previewRecoveryRevision, reviseRecovery } from '../../src/recovery/service.js';
import { replayLearningJournal } from '../../src/app/committed-learning.js';
import { fixture, observation, sample, start, W } from './recovery-fixture.js';

const round = value => Math.round(value * 100) / 100;

/** Real current-schema operations with unrelated live writes and HTTP polling.
 * The fixture never opens household configuration or databases. Descriptive
 * timing is kept separate from correctness so benchmarks can run on slow hosts. */
export async function recoveryWorkload(t, { records = 1024, windows = 32, payloadBytes = 128, liveWriteIntervalMs = 10,
  onStage = value => t.diagnostic?.(JSON.stringify(value)) } = {}) {
  const f = fixture(t), stages = [];
  sample(f.master, start + W);
  observation(f.master, start, 20);
  f.master.setState('synthetic-authority', { permitted: false, equipment: 'synthetic-current-equipment' });
  const donor = await f.donor();
  donor.transaction(() => {
    for (let index = 1; index <= records; index++)
      observation(donor, start + index * 1000, 20 + index % 4 / 10,
        { raw: { synthetic: 'x'.repeat(payloadBytes), sequence: index } });
    for (let index = 2; index <= windows + 1; index++) sample(donor, start + index * W);
  });
  const snapshot = await f.snapshot(donor);
  let sequence = 0, selectedPhase = 'idle', currentProgress = null;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    // Exact replay assertions between measured stages intentionally run in
    // this test process. A socket must not age out during those assertions and
    // then race the fetch pool on the next stage's first request.
    response.setHeader('connection', 'close');
    response.end(JSON.stringify({ phase: selectedPhase, progress: currentProgress,
      authority: f.master.getState('synthetic-authority') }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}/status`;
  const closeServer = () => { server.closeAllConnections(); server.close(); };
  t.after(closeServer);

  async function measure(name, operation) {
    selectedPhase = name; currentProgress = null;
    let lastBeat = performance.now(), maxHeartbeatGapMs = 0, heartbeatTicks = 0, peakRssBytes = process.memoryUsage.rss();
    let pendingWrite = null;
    let maxLiveWriteMs = 0, writes = 0, polling = true, httpRequests = 0, maxHttpMs = 0, failure = null;
    let maxHeartbeatGapPhase = null;
    const slowWrites = [];
    const phases = new Set(), firstSequence = sequence;
    const beat = () => {
      const now = performance.now();
      if (now - lastBeat > maxHeartbeatGapMs) {
        maxHeartbeatGapMs = now - lastBeat; maxHeartbeatGapPhase = currentProgress?.phase ?? null;
      }
      lastBeat = now; heartbeatTicks++; peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    };
    const record = async () => {
      const then = performance.now();
      try {
        await f.master.runWrite(() => f.master.event('synthetic-recovery-live-tick', { sequence: ++sequence }, start + 400 * W + sequence), { signal: f.signal });
        writes++;
      } catch (error) { failure ??= error; }
      const elapsedMs = performance.now() - then;
      maxLiveWriteMs = Math.max(maxLiveWriteMs, elapsedMs);
      if (elapsedMs >= 50) {
        slowWrites.push({ phase: currentProgress?.phase ?? null, processed: currentProgress?.processed ?? null,
          elapsedMs: round(elapsedMs) });
        slowWrites.sort((a, b) => b.elapsedMs - a.elapsedMs); slowWrites.length = Math.min(slowWrites.length, 5);
      }
    };
    // Sample event-loop progress independently of the offered write load.
    const heartbeatTimer = setInterval(beat, 10);
    const writeTimer = setInterval(() => {
      if (!pendingWrite) pendingWrite = record().finally(() => { pendingWrite = null; });
    }, liveWriteIntervalMs);
    const stop = () => { clearInterval(heartbeatTimer); clearInterval(writeTimer); polling = false; };
    f.signal.addEventListener('abort', stop, { once: true });
    const pollingTask = (async () => {
      while (polling) {
        const then = performance.now();
        try {
          const response = await fetch(address);
          assert.equal(response.status, 200);
          const status = await response.json();
          assert.equal(status.authority.permitted, false);
          httpRequests++; maxHttpMs = Math.max(maxHttpMs, performance.now() - then);
        } catch (error) { failure ??= error; }
        if (polling) await delay(10);
      }
    })();
    const progress = value => { currentProgress = value; phases.add(value.phase); };
    const then = performance.now();
    try {
      const value = await operation(progress);
      beat();
      return value;
    } finally {
      stop(); f.signal.removeEventListener('abort', stop); await pollingTask; await pendingWrite;
      const metric = { name, liveWriteIntervalMs, elapsedMs: round(performance.now() - then), heartbeatTicks,
        maxHeartbeatGapMs: round(maxHeartbeatGapMs), maxHeartbeatGapPhase, writes, maxLiveWriteMs: round(maxLiveWriteMs), slowWrites,
        httpRequests, maxHttpMs: round(maxHttpMs), peakRssBytes, phases: [...phases] };
      stages.push(metric); onStage(metric);
      assert.ifError(failure);
      const retained = f.master.db.prepare(`SELECT COUNT(*) n FROM events WHERE type='synthetic-recovery-live-tick'
        AND json_extract(payload,'$.sequence')>? AND json_extract(payload,'$.sequence')<=?`).get(firstSequence, sequence).n;
      assert.equal(retained, writes, `${name}: every concurrent live write remains durable`);
    }
  }

  const preview = await measure('preview', onProgress => recoveryPreview({ masterPath: f.master.path, donorPath: snapshot,
    input: 'mqtt', workDirectory: join(f.directory, 'work'), signal: f.signal, onProgress }));
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1, 'preview never imports source history');
  let tail = windows + 2;
  const recovered = await measure('recover', onProgress => recoverHistory({ store: f.master, donorPath: snapshot,
    input: 'mqtt', preview, signal: f.signal, onProgress: async progress => {
      onProgress(progress);
      if (progress.phase === 'rebuilding' && tail === windows + 2) { await f.master.runWrite(() => sample(f.master, start + tail * W), { signal: f.signal }); tail++; }
    } }));
  assert.equal(recovered.report.model.acceptedSamples, windows);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, records + 1);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), recovered.checkpoint);
  assert.equal(recovered.checkpoint.windowCursor, start + (tail - 1) * W, 'recovery catches up live learning');
  const backupPath = join(f.directory, 'verified-export.sqlite');
  await measure('backup', onProgress => f.master.backup(backupPath, { signal: f.signal, onProgress }));
  const backup = new Store(backupPath, { readOnly: true });
  try {
    assert.equal(backup.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.db.prepare('SELECT COUNT(*) n FROM observations').get().n, records + 1);
    assert.deepEqual(backup.getState('synthetic-authority'), f.master.getState('synthetic-authority'));
    assert.equal(backup.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally { backup.close(); }
  const originalRows = f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  observation(f.master, start + 500 * W, 22, { device: 'synthetic-later-sensor' });
  for (const active of [false, true]) {
    const args = { store: f.master, input: 'mqtt', recoveryId: recovered.report.recoveryId, active, signal: f.signal };
    const action = active ? 'restore' : 'revert';
    const checked = await measure(`review-${action}`, onProgress => previewRecoveryRevision({ ...args, onProgress }));
    let appended = false;
    const oldEpoch = f.master.learningEpoch('mqtt');
    const revised = await measure(action, onProgress => reviseRecovery({ ...args, preview: checked, onProgress: async progress => {
      onProgress(progress);
      if (progress.phase === 'rebuilding' && !appended) {
        appended = true; await f.master.runWrite(() => sample(f.master, start + tail++ * W), { signal: f.signal });
        assert.equal(f.master.learningEpoch('mqtt'), oldEpoch, 'publication retains the prior selected model while rebuilding');
      }
    } }));
    assert(appended, `${action} accepts concurrent local learning`);
    assert.equal(revised.checkpoint.windowCursor, start + (tail - 1) * W);
    assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), revised.checkpoint);
    assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, originalRows + 1,
      `${action} retains original source rows`);
    const selected = f.master.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n;
    assert.equal(selected, active ? records + 2 : 2);
    const reopened = new Store(f.master.path, { readOnly: true });
    try {
      assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, selected);
      assert.deepEqual(reopened.getState('adaptive:mqtt'), revised.checkpoint);
    } finally { reopened.close(); }
  }
  assert.deepEqual(f.master.getState('synthetic-authority'), { permitted: false, equipment: 'synthetic-current-equipment' });
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  const databaseBytes = f.master.databaseBytes(), sourceBytes = statSync(snapshot).size;
  closeServer();
  return { records, windows, sourceBytes, databaseBytes, stages, liveWrites: sequence };
}
