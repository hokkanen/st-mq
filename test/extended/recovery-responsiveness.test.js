import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryWorkload } from '../helpers/recovery-workload.js';
import { fixture, observation, recover, start } from '../helpers/recovery-fixture.js';
import { listRecoveries, previewRecoveryRevision, reviseRecovery } from '../../src/recovery/service.js';
import { Recorder } from '../../src/storage/recorder.js';

test('larger recoveries keep serving status through backup, recovery, reversal and restoration', async t => {
  // Ten attempted durable writes per second exercise concurrent recording over
  // the full history fixture. This is a synthetic regression load, not measured
  // household traffic; retain the existing latency limits and 10 ms heartbeat.
  const result = await recoveryWorkload(t, { records: 4000, windows: 7 * 96, liveWriteIntervalMs: 100 });
  t.diagnostic(JSON.stringify(result));
  for (const stage of result.stages) {
    assert(stage.httpRequests > 1, `${stage.name} keeps serving status`);
    assert(stage.writes > 1, `${stage.name} keeps recording new history`);
    assert(stage.maxHeartbeatGapMs < 2000, `${stage.name}: heartbeat stalled ${stage.maxHeartbeatGapMs} ms`);
    assert(stage.maxLiveWriteMs < 1500, `${stage.name}: recording stalled ${stage.maxLiveWriteMs} ms`);
    assert(stage.maxHttpMs < 2000, `${stage.name}: status stalled ${stage.maxHttpMs} ms`);
  }
});

for (const pendingStart of [900_000, 200_000])
test(`restoration catches up continuous recording with a ${pendingStart === 900_000 ? 'later' : 'history-overlapping'} pending-energy start`, async t => {
  const f = fixture(t), donor = await f.donor();
  donor.transaction(() => {
    for (let index = 0; index < 512; index++) observation(donor, start + index * 1000, 20);
  });
  const accepted = await recover(f, await f.snapshot(donor));
  const args = { store: f.master, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const energyTail = (at, sequence) => ({
    lastEnd: at, lastReceivedAt: at,
    pending: { start: start + pendingStart, end: at, receivedAt: at,
      energies: [0.1 + sequence * 0.0001, 0.2 + sequence * 0.0002, 0.3 + sequence * 0.0003], quality: [] },
    lastPowers: [1, 2, 3], lastQuality: [], scales: [null, null, null],
  });
  const energyKey = 'recorder:energy:["synthetic","synthetic-independent-live-meter","property"]';
  f.master.setState(energyKey, energyTail(start + 1_000_000, 0));
  const restore = { ...args, active: true }, preview = await previewRecoveryRevision(restore);
  let recorded = 0, sourceStopped = false, largestGap = 0, last = performance.now();
  const held = new Recorder(f.master);
  const pending = new Set();
  const recorder = setInterval(() => {
    const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now;
    const at = start + 1_000_000 + ++recorded * 360;
    const saved = f.master.runWrite(() => {
      observation(f.master, at, 22,
        { device: 'synthetic-independent-live-sensor', signal: 'synthetic_live_temperature' });
      f.master.setState(energyKey, energyTail(at, recorded));
      held.record({ source: 'synthetic', device: 'synthetic-current-held-sensor', signal: 'indoor_temperature',
        unit: 'degC', value: 23, sourceTime: at, receivedAt: at });
    }, { signal: t.signal });
    pending.add(saved); void saved.finally(() => pending.delete(saved)).catch(() => {});
  }, 20);
  const stop = () => clearInterval(recorder);
  t.signal.addEventListener('abort', stop, { once: true });
  // On a regression, eventually stop the fixture source so the operation can
  // unwind and reveal the failed liveness assertion instead of hanging CI.
  const bound = setTimeout(() => { sourceStopped = true; stop(); }, 10_000);
  try {
    await reviseRecovery({ ...restore, preview });
    stop(); await Promise.all([...pending]);
    assert.equal(sourceStopped, false, 'new unrelated observations must not restart a complete conflict scan forever');
    assert(recorded > 2, 'the restore overlaps ongoing source ingestion');
    assert.equal(listRecoveries(f.master, 'mqtt')[0].active, true);
    assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM active_observations WHERE device='invented-house'").get().n, 512);
    assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM active_observations WHERE device='synthetic-independent-live-sensor'").get().n, recorded);
    assert(largestGap < 1500, `catch-up must leave ingestion responsive (${largestGap} ms)`);
  } finally { stop(); clearTimeout(bound); t.signal.removeEventListener('abort', stop); await Promise.allSettled([...pending]); }
});
