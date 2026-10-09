import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../src/storage/store.js';
import { fullVerificationActivity } from '../../src/storage/full-verifier.js';

const percentile = (values, fraction) => values.length
  ? values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
const maximum = values => values.length ? Math.max(...values) : null;
const bytes = path => { try { return statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') throw error; return 0; } };

// Synthetic assurance on the actual filesystem selected by TMPDIR. Device type
// and live-service load must be recorded separately; no installation is opened.
test('verified portable backups preserve growing history while recording and local reads continue', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-backup-scale-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scales = (process.env.STMQ_BACKUP_SCALE_MIB ?? '16,64').split(',').map(Number);
  const intervalMs = Number(process.env.STMQ_BACKUP_WRITE_INTERVAL_MS ?? 5);
  const baselineMs = Number(process.env.STMQ_BACKUP_BASELINE_MS ?? 1000);
  const settleMs = Number(process.env.STMQ_BACKUP_SETTLE_MS ?? 0);
  assert(scales.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1024));
  assert(Number.isSafeInteger(intervalMs) && intervalMs >= 5 && intervalMs <= 1000);
  assert(Number.isSafeInteger(baselineMs) && baselineMs >= 100 && baselineMs <= 60000);
  assert(Number.isSafeInteger(settleMs) && settleMs >= 0 && settleMs <= 60000);
  for (const payloadMiB of scales) {
    const store = new Store(join(directory, `source-${payloadMiB}.sqlite`));
    const destination = join(directory, `backup-${payloadMiB}.sqlite`), count = payloadMiB * 256;
    let timer;
    try {
      const payload = { synthetic: 'x'.repeat(4096) };
      for (let offset = 0; offset < count; offset += 64) store.transaction(() => {
        for (let id = offset; id < Math.min(count, offset + 64); id++) store.event('synthetic-history', payload, id);
      });
      const settings = { synchronous: store.db.prepare('PRAGMA synchronous').get().synchronous,
        walAutocheckpointPages: store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,
        pageSize: store.db.prepare('PRAGMA page_size').get().page_size };
      assert.equal(settings.synchronous, 2, 'Qualification must retain FULL durability');
      if (settleMs) await delay(settleMs, undefined, { signal: t.signal });
      let writes = 0, verifiedWrites = 0, peakRss = process.memoryUsage().rss, lastBeat = performance.now();
      let verificationQueued, verificationStarted, snapshotSeen = false;
      const phases = [], phasesByName = new Map();
      function beginPhase(name) {
        if (phasesByName.has(name)) return;
        const now = performance.now();
        if (phases.length) phases.at(-1).durationMs = now - phases.at(-1).started;
        const phase = { name, started: now, writes: 0, gaps: [], begin: [], body: [], commit: [], total: [],
          walBeforeBytes: bytes(store.path + '-wal'), walPeakBytes: 0 };
        phases.push(phase); phasesByName.set(name, phase);
      }
      beginPhase('recording-only');
      const execute = store.db.exec.bind(store.db);
      store.db.exec = sql => {
        const before = performance.now();
        try { return execute(sql); }
        finally {
          const bucket = sql === 'COMMIT' ? 'commit' : sql === 'BEGIN IMMEDIATE' ? 'begin' : null;
          if (bucket) phases.at(-1)[bucket].push(performance.now() - before);
        }
      };
      timer = setInterval(() => {
        const phase = phases.at(-1), now = performance.now(); phase.gaps.push(now - lastBeat); lastBeat = now;
        const before = performance.now(); let body;
        store.transaction(() => {
          const started = performance.now();
          store.event('synthetic-live', { sequence: ++writes }, count + writes);
          store.setState('synthetic-live-boundary', writes);
          body = performance.now() - started;
        });
        phase.body.push(body); phase.total.push(performance.now() - before); phase.writes++;
        assert.equal(store.events({ limit: 1 })[0].payload.sequence, writes);
        if (verificationStarted !== undefined) verifiedWrites++;
        phase.walPeakBytes = Math.max(phase.walPeakBytes, bytes(store.path + '-wal'));
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, intervalMs);
      await delay(baselineMs, undefined, { signal: t.signal });
      const started = performance.now(), writesBeforeBackup = writes;
      beginPhase('copy-and-finalization');
      await store.backup(destination, { signal: t.signal, onProgress(value) {
        if (value.phase === 'validating') beginPhase(snapshotSeen ? 'destination-validation' : 'source-validation');
        if (value.phase === 'snapshotting') { snapshotSeen = true; beginPhase('snapshotting'); }
        if (value.phase === 'finalizing') beginPhase('finalizing');
        if (value.phase === 'queued') { verificationQueued ??= performance.now(); beginPhase('verification-queue'); }
        if (value.phase === 'checking-contracts') { verificationStarted ??= performance.now(); beginPhase('verification-and-publication'); }
      } });
      const completed = performance.now(); clearInterval(timer); timer = null;
      phases.at(-1).durationMs = completed - phases.at(-1).started;
      assert(writes > writesBeforeBackup); assert(verifiedWrites > 0, 'recording continues during full copy verification');
      const copy = new Store(destination, { readOnly: true });
      try {
        assert.equal(copy.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-history'").get().n, count);
        assert.equal(copy.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
        const recorded = copy.db.prepare("SELECT COUNT(*) n FROM events WHERE type='synthetic-live'").get().n;
        assert.equal(copy.getState('synthetic-live-boundary') ?? 0, recorded, 'each concurrent transaction is copied completely');
        assert(recorded < writes, 'the completed backup keeps its earlier consistent boundary');
        assert.deepEqual(fullVerificationActivity().lastRun.result.checkpoint, copy.checkpoint());
      } finally { copy.close(); }
      t.diagnostic(JSON.stringify({ node: process.version, payloadMiB, offeredWriteIntervalMs: intervalMs, settleMs, settings,
        sourceBytes: bytes(store.path), backupBytes: bytes(destination), allocatedWalBytes: bytes(store.path + '-wal'),
        totalMs: completed - started, copyAndFinalizationMs: verificationQueued - started,
        verificationAndPublicationMs: completed - verificationQueued,
        liveWrites: writes - writesBeforeBackup, liveWritesDuringVerification: verifiedWrites, peakRssBytes: peakRss,
        phases: phases.map(phase => ({ name: phase.name, durationMs: phase.durationMs, writes: phase.writes,
          commitsPerSecond: phase.writes * 1000 / phase.durationMs, walBeforeBytes: phase.walBeforeBytes, walPeakBytes: phase.walPeakBytes,
          ...Object.fromEntries(['gaps', 'begin', 'body', 'commit', 'total'].map(key => [key,
            { maxMs: maximum(phase[key]), p99Ms: percentile(phase[key], 0.99) }])) })),
        qualification: 'synthetic workload on this host and filesystem; no power-loss or year-scale qualification' }));
    } finally { clearInterval(timer); store.close(); }
  }
});
