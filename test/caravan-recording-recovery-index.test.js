import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder, isCaravanRecordingRecovery } from '../src/storage/recorder.js';

const BASE = 1_800_000_000_000, SOURCE = BASE + 30_000, GAP = BASE + 40_000, RECOVERY = GAP + 700;
const SIGNAL = 'caravan_dehumidifier_state', MAX_AGE = 180_000, IDENTITY = 'a'.repeat(64), METER = 'b'.repeat(64);
const wait = () => ({ startedAt: GAP, recordingSince: BASE + 20_000, identity: IDENTITY, meterSignature: METER, deadline: BASE + 200_000 });
function reading() {
  return { source: 'mqtt-equipment', device: 'caravan_dehumidifier', signal: SIGNAL, unit: 'state',
    value: 1, sourceTime: SOURCE, receivedAt: SOURCE, quality: [], raw: { timeBasis: 'mqtt-live-status', identity: IDENTITY,
      maxAgeMs: MAX_AGE, reportIntervalMs: MAX_AGE, reportGraceMs: 0,
      fieldTimestamps: { power: SOURCE, fanSpeed: BASE + 20_000 },
      locationEvidence: { method: 'native-power-cycle-v1', meterSignature: METER, maxAgeMs: MAX_AGE,
        startedAt: BASE, completedAt: BASE + 20_000, meterObservedAt: SOURCE,
        powerRiseW: 5, powerFallW: 5, minimumChangeW: 3, phases: {
          baseline: { commandAt: null, firstPowerObservedAt: BASE, lastPowerObservedAt: BASE + 5000 },
          on: { commandAt: BASE + 6000, firstPowerObservedAt: BASE + 7000, lastPowerObservedAt: BASE + 12000 },
          off: { commandAt: BASE + 13000, firstPowerObservedAt: BASE + 14000, lastPowerObservedAt: BASE + 19000 } } } } };
}
function prepare(store) {
  const recorder = new Recorder(store, { clock: () => RECOVERY }), original = reading();
  recorder.record(original);
  recorder.record({ ...original, sourceTime: null, receivedAt: GAP, value: null,
    quality: ['location-unconfirmed', 'unavailable', 'missing'], raw: { reportIntervalMs: MAX_AGE,
      reportGraceMs: 0, timeBasis: 'availability-transition', sourceTimeWait: wait() } });
  const candidate = structuredClone(original); candidate.raw.sourceTimeWait = wait();
  candidate.raw.locationEvidence.meterObservedAt = RECOVERY;
  return { recorder, original, candidate };
}

test('Caravan recovery seeks a fixed causal receipt window on the real writer', async () => {
  const transfers = [];
  for (const prefix of [1000, 20000]) {
    const directory = mkdtempSync(join(tmpdir(), 'st-mq-caravan-recovery-'));
    const store = new Store(join(directory, 'recording.sqlite'));
    try {
      const f = prepare(store);
      for (let from = 0; from < prefix; from += 128) store.transaction(() => {
        for (let i = from; i < Math.min(prefix, from + 128); i++) store.observation({ ...reading(),
          sourceTime: BASE - prefix + i - 1, receivedAt: BASE - prefix + i - 1 });
      });
      // A later malformed receipt must remain outside this as-of boundary.
      store.observation({ ...reading(), value: null, unit: 'malformed-unit', sourceTime: null,
        receivedAt: RECOVERY + 1, quality: ['invalid-value'] });
      const before = store.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
      await store.startWriter();
      const call = store.writer.call.bind(store.writer), reads = [];
      store.writer.call = (operation, parameters) => {
        const result = call(operation, parameters);
        if (operation === 'statement' && parameters.sql.includes('SELECT value,quality,raw,received_at FROM active_observations')) {
          reads.push({ count: result.length, params: parameters.params,
            plan: call('statement', { ...parameters, method: 'all', sql: `EXPLAIN QUERY PLAN ${parameters.sql}` }).map(row => row.detail) });
        }
        return result;
      };
      assert.equal((await store.runWrite(() => f.recorder.resumeCaravanRecording(f.candidate, GAP - 1))).changed, false);
      assert.equal(reads.length, 0, 'A future wait cannot be examined before its committed pause');
      const result = await store.runWrite(() => f.recorder.resumeCaravanRecording(f.candidate, RECOVERY));
      assert.equal(result.changed, true); assert.equal(isCaravanRecordingRecovery(result.observation), true);
      assert.equal(result.observation.sourceTime, SOURCE);
      assert.equal(result.observation.raw.originalReportReceivedAt, SOURCE);
      assert.deepEqual(store.db.prepare('SELECT * FROM recorder_coverage WHERE id<=? ORDER BY id').all(before.at(-1).id), before);
      assert.equal(reads.length, 1); assert.equal(reads[0].params.at(-2), SOURCE); assert.equal(reads[0].params.at(-1), RECOVERY);
      assert(reads[0].plan.some(row => /observations_receipt \(received_at>\? AND received_at<\?\)/.test(row)), reads[0].plan.join('; '));
      assert(!reads[0].plan.some(row => /TEMP B-TREE/.test(row)), reads[0].plan.join('; '));
      transfers.push(reads[0].count);
    } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  assert.deepEqual(transfers, [2, 2], 'An older stream prefix cannot enlarge the safety window');
});

test('Caravan receipt seek preserves malformed and retained attempts and selected history', t => {
  for (const scenario of ['malformed-unit', 'retained', 'unrecorded-invalid', 'excluded-invalid']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = prepare(store), attempt = { ...reading(), sourceTime: null, receivedAt: GAP + 1,
      value: null, quality: ['invalid-value'], raw: { reason: 'synthetic-invalid' } };
    if (scenario === 'malformed-unit') attempt.unit = 'unsupported-state-unit';
    if (scenario === 'retained') { attempt.quality = ['retained']; attempt.raw.retained = true; }
    const id = store.observation(attempt);
    if (scenario === 'excluded-invalid') store.db.prepare(`INSERT INTO recovery_exclusions(generation,table_name,record_key)
      VALUES('original','observations',?)`).run(String(id));
    const before = store.checkpoint(), result = f.recorder.resumeCaravanRecording(f.candidate, RECOVERY);
    assert.equal(result.changed, scenario === 'excluded-invalid', scenario);
    if (scenario !== 'excluded-invalid') assert.deepEqual(store.checkpoint(), before, 'Rejected recovery cannot mutate source history');
  }
});
