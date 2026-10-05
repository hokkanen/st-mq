import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { fixture, observation, start } from './helpers/recovery-fixture.js';

test('recovery releases SQLite for progress persistence and concurrent controller writes between batches', { timeout: 20000 }, async t => {
  const f = fixture(t), donor = await f.donor(), rows = 2304;
  donor.transaction(() => { for (let i = 0; i < rows; i++) observation(donor, start + i * 60000, 20 + i % 3); });
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ masterPath: f.master.path, donorPath, signal: t.signal });
  const failures = [], deferredWrites = [];
  let beats = 0, progressWrites = 0, maxWriteMs = 0;
  const timer = setInterval(() => {
    const before = performance.now();
    try { f.master.event('synthetic-control-tick', { tick: ++beats }, start + 10_000_000 + beats); }
    catch (error) { failures.push(error.code); }
    maxWriteMs = Math.max(maxWriteMs, performance.now() - before);
  }, 10);
  let result;
  try {
    result = await recoverHistory({ store: f.master, donorPath, preview, signal: t.signal, onProgress(value) {
      if (value.phase !== 'importing') return;
      // Production persists progress on the controller connection. Defer the
      // write one controller turn to prove the worker waits for acknowledgement,
      // rather than merely releasing/reacquiring before the message is handled.
      deferredWrites.push(new Promise(resolve => setImmediate(() => {
        f.master.db.exec('PRAGMA busy_timeout=0');
        try { f.master.setState('synthetic:recovery-progress', { processed: value.processed }); progressWrites++; }
        catch (error) { failures.push(error.code); }
        finally { f.master.db.exec('PRAGMA busy_timeout=5000'); resolve(); }
      })));
    } });
    await Promise.all(deferredWrites);
  } finally { clearInterval(timer); }
  assert.deepEqual(failures, [], 'controller and progress writes never exhaust SQLite lock waiting');
  assert.ok(progressWrites > 0, 'progress persistence was exercised with no lock-wait allowance');
  assert.ok(beats > 0, 'the controller kept writing during recovery');
  assert.ok(maxWriteMs < 1500, 'bounded recovery batches do not make control wait for the five-second SQLite timeout');
  assert.equal(result.report.imported, rows);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, rows);
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  t.diagnostic(JSON.stringify({ controllerWrites: beats, progressWrites, maxWriteMs: Math.round(maxWriteMs) }));
});
