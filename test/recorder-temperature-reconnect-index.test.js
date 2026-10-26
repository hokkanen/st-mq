import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

const MINUTE = 60_000, start = 1_800_000_000_000;
const signal = 'indoor_temperature', source = 'mqtt-temperature', routeSignature = 'a'.repeat(64);
const policy = { reportIntervalMs: 10 * MINUTE, reportGraceMs: 2 * MINUTE };
const report = at => ({ source, device: signal, signal, unit: 'degC', value: 21,
  sourceTime: at, receivedAt: at, quality: [], raw: { ...policy, temperatureRouteSignature: routeSignature, timeBasis: 'mqtt-received' } });

test('temperature reconnect seeks recent stream receipts and retains invalid-attempt rejection', async () => {
  for (const prefix of [1000, 20000]) for (const invalid of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'st-mq-temperature-reconnect-'));
    const store = new Store(join(directory, 'recording.sqlite'));
    const recorder = new Recorder(store, { clock: () => start + 2 * MINUTE });
    try {
      recorder.record(report(start));
      // Historical recovery can assign late IDs to older same-stream receipts.
      // They must not enter the recent safety window after an unchanged report.
      for (let from = 0; from < prefix; from += 128) store.transaction(() => {
        for (let i = from; i < Math.min(prefix, from + 128); i++) store.observation(report(start - prefix + i - 1));
      });
      const current = report(start + MINUTE);
      recorder.record(current);
      if (invalid) store.observation({ ...report(start + MINUTE + 1), value: null, quality: ['invalid-value'] });
      recorder.recordFailure({ source, device: signal, signal, unit: 'degC', at: start + 90_000,
        quality: ['mqtt-disconnected'], raw: { ...policy, temperatureRouteSignature: routeSignature } });
      await store.startWriter();
      const call = store.writer.call.bind(store.writer), plans = [], sizes = [];
      store.writer.call = (operation, parameters) => {
        const result = call(operation, parameters);
        if (operation === 'statement' && parameters.sql.includes('SELECT quality,raw FROM active_observations')) {
          sizes.push(result.length);
          plans.push(call('statement', { ...parameters, sql: `EXPLAIN QUERY PLAN ${parameters.sql}` }).map(row => row.detail));
        }
        return result;
      };
      const result = await store.runWrite(() => recorder.recoverTemperatureConnection(current, policy, start + 2 * MINUTE, { routeSignature }));
      assert.equal(result.changed, !invalid);
      if (!invalid) {
        assert.equal(result.observation.value, 21);
        assert.equal(result.reportSourceTime, current.sourceTime);
        assert.equal(result.reportReceivedAt, current.receivedAt);
      }
      assert.equal(plans.length, 1);
      assert(sizes.every(size => size <= 3), JSON.stringify(sizes));
      for (const plan of plans) {
        assert(plan.some(line => /observations_temperature_stream_receipt .*source=\? AND device=\? AND signal=\? AND received_at>\? AND received_at<\?/.test(line)), plan.join('; '));
        assert(!plan.some(line => /TEMP B-TREE/.test(line)), plan.join('; '));
      }
    } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
