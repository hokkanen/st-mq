import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryWorkload } from './helpers/recovery-workload.js';
import { fixture, observation, recover, start, W } from './helpers/recovery-fixture.js';
import { Store } from '../src/storage/store.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { Recorder } from '../src/storage/recorder.js';
import { pendingEnergyObservations } from '../src/storage/pending-energy.js';
import { listRecoveries, previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';

test('backup, recovery and reversible corrections retain live writes while status stays responsive', async t => {
  const result = await recoveryWorkload(t, { records: 512, windows: 96 });
  t.diagnostic(JSON.stringify(result));
  for (const stage of result.stages) {
    assert(stage.heartbeatTicks > 1, `${stage.name}: the event loop keeps running`);
    assert(stage.httpRequests > 0, `${stage.name}: status requests are served`);
    assert(stage.writes > 0, `${stage.name}: recording continues`);
    // This generous regression budget catches the former five-second SQLite
    // busy waits without requiring production-speed storage in shared CI.
    assert(stage.maxHeartbeatGapMs < 1500, `${stage.name}: heartbeat stalled ${stage.maxHeartbeatGapMs} ms`);
    assert(stage.maxLiveWriteMs < 1000, `${stage.name}: live write stalled ${stage.maxLiveWriteMs} ms`);
    assert(stage.maxHttpMs < 1500, `${stage.name}: status response stalled ${stage.maxHttpMs} ms`);
  }
});

test('a held-reading coverage extension during restoration invalidates the review without new observation rows', async t => {
  const f = fixture(t), recorder = new Recorder(f.master);
  const reading = at => ({ source: 'synthetic', device: 'invented-house', signal: 'indoor_temperature',
    unit: 'degC', value: 21, sourceTime: at, receivedAt: at });
  recorder.record(reading(start - 1000));
  const donor = await f.donor(); observation(donor, start, 999);
  const accepted = await recover(f, await f.snapshot(donor));
  const args = { store: f.master, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const restore = { ...args, active: true }, preview = await previewRecoveryRevision(restore);
  const oldEpoch = f.master.learningEpoch('mqtt'), rows = f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  let extended = false;
  await assert.rejects(reviseRecovery({ ...restore, preview, onProgress(value) {
    if (value.phase === 'catching-up' && !extended) {
      extended = true;
      recorder.record(reading(start + 1000));
      assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, rows,
        'an unchanged measured value extends its compact span instead of creating a new observation');
    }
  } }), /New local evidence/);
  assert(extended);
  assert.equal(f.master.learningEpoch('mqtt'), oldEpoch);
  assert.equal(listRecoveries(f.master, 'mqtt')[0].active, false);
  assert.deepEqual(f.master.observations().map(row => row.value), [21]);
});

for (const change of ['extend', 'start', 'quality'])
test(`restoration preserves recovered energy conflicts when an overlapping pending tail changes ${change}`, async t => {
  const f = fixture(t), donor = await f.donor();
  for (const phase of [1, 2, 3]) observation(donor, start + W, phase, {
    signal: `property_energy_l${phase}`, unit: 'kWh',
    raw: { intervalStart: start, intervalEnd: start + W, basis: 'integrated-power-phase-allocation' },
  });
  const accepted = await recover(f, await f.snapshot(donor));
  assert.equal(accepted.report.imported, 3);
  const args = { store: f.master, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const original = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const originalEpoch = f.master.learningEpoch('mqtt');
  const energyKey = 'recorder:energy:["synthetic","synthetic-current-property-meter","property"]';
  const tail = { lastEnd: start + 3 * W, lastReceivedAt: start + 3 * W,
    pending: { start: start + W / 2, end: start + 3 * W, receivedAt: start + 3 * W,
      energies: [4, 5, 6], quality: [] }, lastPowers: [1, 2, 3], lastQuality: [], scales: [null, null, null] };
  f.master.setState(energyKey, tail);
  const measured = pendingEnergyObservations(f.master, { now: Date.now(), input: 'mqtt', prefix: 'property' });
  assert.equal(measured.length, 3, 'the fixture is a real current three-phase pending stream');
  assert(measured.every(row => row.quality === '[]' && JSON.parse(row.raw).intervalStart < start + W
    && row.source_time > start + W), 'each pending phase already overlaps the recovered energy interval');
  const restore = { ...args, active: true }, preview = await previewRecoveryRevision(restore);
  const changedPhases = new Set();
  const restoring = reviseRecovery({ ...restore, preview, onProgress(value) {
    // These phases begin after the initial restoration conflict scan. Later
    // independent updates must not revive any part of the rejected cohort.
    if (!['catching-up', 'publishing'].includes(value.phase) || changedPhases.has(value.phase)
      || change !== 'extend' && changedPhases.size) return;
    changedPhases.add(value.phase);
    tail.pending.end += W; tail.pending.receivedAt = tail.pending.end;
    tail.lastEnd = tail.pending.end; tail.lastReceivedAt = tail.pending.receivedAt;
    tail.pending.energies = tail.pending.energies.map(value => value + 1);
    if (change === 'start') tail.pending.start = start + 2 * W;
    if (change === 'quality') tail.pending.quality = tail.lastQuality = ['integration-gap'];
    f.master.setState(energyKey, tail);
  } });
  if (change === 'extend') {
    const result = await restoring;
    assert.equal(result.report.status, 'complete');
    assert(changedPhases.size >= 2, 'the valid overlapping tail advances during multiple restoration phases');
    assert.equal(listRecoveries(f.master, 'mqtt')[0].active, true);
  } else {
    await assert.rejects(restoring, /New local evidence changes this restoration/);
    assert.equal(changedPhases.size, 1);
    assert.equal(f.master.learningEpoch('mqtt'), originalEpoch, 'changed evidence prevents publication until a fresh review');
    assert.equal(listRecoveries(f.master, 'mqtt')[0].active, false);
  }
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, 0,
    'all three conflicting recovered phases remain excluded');
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), original,
    'the original accepted energy and its provenance remain intact for later review');
});

test('a full supported cycle provenance graph eventually recovers while unrelated recording continues', async t => {
  const f = fixture(t), donor = await f.donor();
  const observationId = observation(donor, start, 21);
  const cycle = { id: 'synthetic-complete-cycle', status: 'completed', startedAt: start, endedAt: start + W,
    observations: Array.from({ length: 3001 }, (_, index) => ({ start: start + index,
      end: start + index + 1, indoorC: 21,
      provenance: { observationId, lineage: { indoor: { observations: [observationId] } } } })) };
  donor.db.prepare('INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload) VALUES(?,?,?,?,?,?)')
    .run(cycle.id, 'mqtt', cycle.startedAt, cycle.endedAt, cycle.status, JSON.stringify(cycle));
  const snapshot = await f.snapshot(donor);
  let writes = 0, largestGap = 0, last = performance.now();
  const pending = new Set();
  const timer = setInterval(() => {
    const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now;
    const saved = f.master.runWrite(() => f.master.event('synthetic-independent-event', { sequence: ++writes }), { signal: t.signal });
    pending.add(saved); void saved.finally(() => pending.delete(saved)).catch(() => {});
  }, 10);
  const stop = () => clearInterval(timer);
  t.signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await recover(f, snapshot);
    assert.equal(result.report.counts.skipped, 0);
    assert.equal(result.report.tables.find(value => value.name === 'learning_cycles').missing, 1);
    const saved = JSON.parse(f.master.db.prepare('SELECT payload FROM learning_cycles').get().payload);
    assert.equal(saved.observations.length, 3001, 'all supported frozen evidence is retained');
    assert(writes > 1);
    assert(largestGap < 1500, `supported provenance must not stall recording (${largestGap} ms)`);
  } finally { stop(); t.signal.removeEventListener('abort', stop); await Promise.allSettled([...pending]); }
});

test('an unchanged future pending-energy receipt becoming eligible during restoration requires a fresh review', async t => {
  const f = fixture(t), donor = await f.donor();
  for (const phase of [1, 2, 3]) observation(donor, start + W, phase, {
    signal: `property_energy_l${phase}`, unit: 'kWh',
    raw: { intervalStart: start, intervalEnd: start + W, basis: 'integrated-power-phase-allocation' },
  });
  const accepted = await recover(f, await f.snapshot(donor));
  const args = { store: f.master, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const energyKey = 'recorder:energy:["synthetic","synthetic-future-receipt","property"]';
  const tail = receipt => ({ lastEnd: start + 2 * W, lastReceivedAt: receipt,
    pending: { start: start + W / 2, end: start + 2 * W, receivedAt: receipt, energies: [4, 5, 6], quality: [] },
    lastPowers: [1, 2, 3], lastQuality: [], scales: [null, null, null] });
  f.master.setState(energyKey, tail(Date.now() + 60_000));
  const restore = { ...args, active: true }, preview = await previewRecoveryRevision(restore);
  const cutoff = Date.now() + 3000;
  f.master.setState(energyKey, tail(cutoff));
  const original = f.master.getState(energyKey), epoch = f.master.learningEpoch('mqtt');
  let crossed = false;
  await assert.rejects(reviseRecovery({ ...restore, preview, async onProgress(value) {
    if (value.phase !== 'catching-up' || crossed) return;
    crossed = true;
    assert(Date.now() < cutoff, 'The initial conflict scan sees a future receipt');
    await new Promise(resolve => setTimeout(resolve, cutoff - Date.now() + 25));
  } }), /New local evidence changes this restoration/);
  assert(crossed);
  assert.deepEqual(f.master.getState(energyKey), original, 'No state edit is needed to change time-based eligibility');
  assert.equal(f.master.learningEpoch('mqtt'), epoch);
  assert.equal(listRecoveries(f.master, 'mqtt')[0].active, false);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, 0);
});
