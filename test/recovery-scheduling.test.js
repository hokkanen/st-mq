import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

// Bulk completion includes durable journal fsyncs under shared CI I/O load.
// Use the suite's completion budget; bound actual controller responsiveness
// independently below, rather than treating background throughput as a lock.
test('recovery releases SQLite for progress persistence and concurrent controller writes between batches', { timeout: 60000 }, async t => {
  let phase = 'source-setup', phaseAt = performance.now();
  const phases = [];
  const setPhase = next => {
    if (next === phase) return;
    phases.push({ phase, ms: Math.round(performance.now() - phaseAt) });
    phase = next; phaseAt = performance.now();
  };
  const f = fixture(t), donor = await f.donor(), rows = 2304;
  donor.transaction(() => { for (let i = 0; i < rows; i++) observation(donor, start + i * 60000, 20 + i % 3); });
  const donorPath = await f.snapshot(donor);
  setPhase('preview');
  const preview = await recoveryPreview({ masterPath: f.master.path, donorPath, signal: t.signal });
  const failures = [], deferredWrites = [];
  const busyTimeout = f.master.db.prepare('PRAGMA busy_timeout').get().timeout;
  let beats = 0, progressWrites = 0, maxWriteMs = 0, maxCommitWaitMs = 0, maxHeartbeatGapMs = 0, lastBeat = performance.now();
  t.after(() => {
    setPhase('done');
    t.diagnostic(JSON.stringify({ controllerWrites: beats, progressWrites, maxWriteMs: Math.round(maxWriteMs),
      maxCommitWaitMs: Math.round(maxCommitWaitMs), maxHeartbeatGapMs: Math.round(maxHeartbeatGapMs), phases }));
  });
  const timer = setInterval(() => {
    const before = performance.now(), tick = ++beats;
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, before - lastBeat); lastBeat = before;
    deferredWrites.push(f.master.runWrite(() => f.master.event('synthetic-control-tick', { tick }, start + 10_000_000 + tick))
      .then(() => { maxCommitWaitMs = Math.max(maxCommitWaitMs, performance.now() - before); })
      .catch(error => failures.push(error.code)));
    maxWriteMs = Math.max(maxWriteMs, performance.now() - before);
  }, 10);
  let result;
  try {
    result = await recoverHistory({ store: f.master, donorPath, preview, signal: t.signal, onProgress(value) {
      setPhase(`recovery:${value.phase}`);
      if (value.phase !== 'importing') return;
      // Production persists progress on the controller connection. Defer the
      // write one controller turn to prove the worker waits for acknowledgement,
      // rather than merely releasing/reacquiring before the message is handled.
      deferredWrites.push(new Promise(resolve => setImmediate(() => {
        f.master.db.exec('PRAGMA busy_timeout=0');
        try { f.master.setState('synthetic:recovery-progress', { processed: value.processed }); progressWrites++; }
        catch (error) { failures.push(error.code); }
        finally { f.master.db.exec(`PRAGMA busy_timeout=${busyTimeout}`); resolve(); }
      })));
    } });
  } finally { clearInterval(timer); }
  await Promise.all(deferredWrites);
  assert.deepEqual(failures, [], 'controller and progress writes never exhaust SQLite lock waiting');
  assert.ok(progressWrites > 1, 'progress persisted between multiple batches with no lock-wait allowance');
  assert.ok(beats > 0, 'the controller kept writing during recovery');
  assert.ok(maxWriteMs < 1000, 'bounded recovery batches keep controller write waits below the event-loop warning threshold');
  assert(maxHeartbeatGapMs < 1000, 'controller heartbeat remains responsive');
  assert(maxCommitWaitMs < 1500, 'controller writes actually commit between bounded recovery batches');
  assert.equal(result.report.imported, rows);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, rows);
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
