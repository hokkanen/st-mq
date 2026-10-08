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
  let maxSynchronousCommitMs = 0, maxProgressWriteMs = 0, worstHeartbeat = null;
  const slowWrites = [];
  const committed = (kind, started) => {
    const elapsed = performance.now() - started;
    if (kind === 'controller') maxSynchronousCommitMs = Math.max(maxSynchronousCommitMs, elapsed);
    else maxProgressWriteMs = Math.max(maxProgressWriteMs, elapsed);
    if (elapsed >= 50) {
      slowWrites.push({ kind, phase, ms: Math.round(elapsed) });
      slowWrites.sort((a, b) => b.ms - a.ms); slowWrites.length = Math.min(slowWrites.length, 5);
    }
  };
  const transaction = f.master.writeQueue.transaction;
  f.master.writeQueue.transaction = callback => {
    const started = performance.now();
    try { return transaction(callback); }
    finally { committed('controller', started); }
  };
  t.after(() => {
    f.master.writeQueue.transaction = transaction;
    setPhase('done');
    t.diagnostic(JSON.stringify({ controllerWrites: beats, progressWrites, maxWriteMs: Math.round(maxWriteMs),
      maxCommitWaitMs: Math.round(maxCommitWaitMs), maxHeartbeatGapMs: Math.round(maxHeartbeatGapMs),
      maxSynchronousCommitMs: Math.round(maxSynchronousCommitMs), maxProgressWriteMs: Math.round(maxProgressWriteMs),
      worstHeartbeat, slowWrites, phases }));
  });
  const timer = setInterval(() => {
    const before = performance.now(), tick = ++beats;
    if (before - lastBeat > maxHeartbeatGapMs) {
      maxHeartbeatGapMs = before - lastBeat; worstHeartbeat = { phase, pending: f.master.writeQueueStatus().pending };
    }
    lastBeat = before;
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
        const started = performance.now();
        try { f.master.setState('synthetic:recovery-progress', { processed: value.processed }); progressWrites++; }
        catch (error) { failures.push(error.code); }
        finally { committed('progress', started); f.master.db.exec(`PRAGMA busy_timeout=${busyTimeout}`); resolve(); }
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


test('a delayed controller retry commits before recovery receives its next writer turn', { timeout: 15000 }, async t => {
  const f = fixture(t), donor = await f.donor();
  donor.transaction(() => { for (let i = 0; i < 192; i++) observation(donor, start + i * 60000); });
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ masterPath: f.master.path, donorPath, signal: t.signal });
  const transaction = f.master.writeQueue.transaction;
  let pending, release, atYield, atAdmission, admitted = false;
  t.after(() => { clearTimeout(release); f.master.writeQueue.transaction = transaction; });
  const result = await recoverHistory({ store: f.master, donorPath, preview, signal: t.signal, onProgress(value) {
    if (value.phase !== 'importing' || pending) return;
    atYield = f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
    // Model a delayed retry after admission has seen contention. The worker is
    // free to write; only the controller's previously queued job is delayed.
    f.master.writeQueue.transaction = fn => {
      if (!admitted) throw Object.assign(new Error('Synthetic delayed writer admission'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      return transaction(fn);
    };
    pending = f.master.runWrite(() => {
      atAdmission = f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
      f.master.event('synthetic-admitted-controller-write', {});
    });
    release = setTimeout(() => { admitted = true; }, 250);
  } });
  await pending;
  assert.equal(atAdmission, atYield, 'recovery cannot consume the retry interval before the queued controller write');
  assert.equal(result.report.imported, 192);
  assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-admitted-controller-write'").get().n, 1);
});
