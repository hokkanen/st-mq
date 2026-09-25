import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorOverride, floorOverrideConfiguration } from '../src/control/floor-override.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

const START = Date.parse('2026-09-25T08:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const store = new Store(':memory:'), recorder = new Recorder(store), requests = [];
  const settings = floorOverrideConfiguration({ enabled: true, commissioned: true,
    storage: { topic_prefix: 'synthetic/storage' }, living: { topic_prefix: 'synthetic/living' } });
  let now = START, historyFailure = false;
  const build = () => createFloorOverride({ store, settings, clock: () => now, readbackTimeoutMs: 1000,
    publish: async (topic, payload) => requests.push({ topic, command: JSON.parse(payload) }),
    onObservation: observation => {
      if (historyFailure) throw new Error('synthetic history unavailable');
      return recorder.record(observation);
    } });
  let adapter = build();
  t.after(async () => { await adapter.close({ restore: false }); store.close(); });
  return { store, recorder, requests, get adapter() { return adapter; },
    at(offset) { now = START + offset; },
    failHistory(value) { historyFailure = value; },
    async restart() { await adapter.close({ restore: false }); requests.length = 0; adapter = build(); },
    rows(signal) { return store.observations({ signal }); },
    respond(request, patch = {}, packet = {}) {
      const command = request.command;
      return adapter.ingest(request.topic.replace('/command', '/status'), JSON.stringify({
        protocol: 'stmq-floor-v1', requestId: command.requestId, at: now / 1000, boot: 1,
        ready: true, clockOk: true, sequence: command.sequence ?? 0, owner: command.owner ?? null,
        expiresAt: command.expiresAt ?? 0, channels: [0, 1].map(id => ({ id, output: command.action === 'lease' })), ...patch,
      }), packet, now);
    },
  };
}

test('all four floor outputs record only actual feedback, exact changes and quality transitions', async t => {
  const f = fixture(t);
  f.adapter.setConnected(true); await flush();
  const signals = ['storage', 'living'].flatMap(group => [0, 1].map(id => `floor_${group}_${id}_active`));
  for (const request of f.requests.splice(0)) f.respond(request);
  for (const signal of signals) assert.deepEqual(f.rows(signal).map(row => row.value), [null, 0]);
  f.at(30_000);
  let tick = f.adapter.tick(); await flush();
  for (const request of f.requests.splice(0)) f.respond(request);
  await tick;
  for (const signal of signals) assert.equal(f.rows(signal).length, 2, 'unchanged replies extend coverage only');
  f.at(31_000);
  const leasing = f.adapter.lease({ owner: 'synthetic-cycle', until: START + 600_000 }); await flush();
  for (const signal of signals) assert.equal(f.rows(signal).at(-1).value, 0, 'commands do not invent output changes');
  for (const request of f.requests.splice(0)) f.respond(request);
  await leasing;
  for (const signal of signals) assert.equal(f.rows(signal).at(-1).value, 1);
  f.at(32_000);
  const release = f.adapter.release(); await flush();
  for (const request of f.requests.splice(0)) f.respond(request, { clockOk: false, at: null });
  assert.equal((await release).released, true, 'OFF readback still clears restoration without a device clock');
  for (const signal of signals) {
    assert.equal(f.rows(signal).at(-1).value, 0);
    assert(f.rows(signal).at(-1).quality.includes('device-clock-unavailable'));
  }
  assert(!f.recorder.status(START + 32_000).parameters.some(row => signals.includes(row.signal)), 'exact floor feedback is outside adaptive inventory');
});

test('floor history records stale, disconnected and restarted periods as unknown, never restored cached outputs', async t => {
  const f = fixture(t), signal = 'floor_storage_0_active';
  f.adapter.setConnected(true); await flush();
  for (const request of f.requests.splice(0)) f.respond(request);
  f.at(90_001);
  await f.adapter.tick();
  assert.equal(f.rows(signal).at(-1).value, null);
  assert(f.rows(signal).at(-1).quality.includes('missing-report'));
  const count = f.rows(signal).length;
  await f.adapter.tick();
  assert.equal(f.rows(signal).length, count);
  f.adapter.setConnected(false);
  assert(f.rows(signal).at(-1).quality.includes('mqtt-disconnected'));
  f.at(100_000); f.adapter.setConnected(true); await flush();
  const requests = f.requests.splice(0).slice(-2);
  for (const request of requests) assert.equal(f.respond(request, {}, { retain: true }), false);
  assert.equal(f.rows(signal).at(-1).value, null);
  for (const request of requests) f.respond(request);
  assert.equal(f.rows(signal).at(-1).value, 0);
  f.at(110_000); await f.restart();
  assert.equal(f.rows(signal).at(-1).value, null);
  assert(f.rows(signal).at(-1).quality.includes('host-started'));
  f.adapter.setConnected(true); await flush();
  for (const request of f.requests.splice(0)) f.respond(request, { boot: 2 });
  assert.equal(f.rows(signal).at(-1).value, 0);
});

test('malformed or errored channel feedback remains unknown independently for each output', async t => {
  const f = fixture(t);
  f.adapter.setConnected(true); await flush();
  for (const request of f.requests.splice(0)) f.respond(request, {
    channels: [{ id: 0, output: false }, { id: 1, output: true, error: 'readback-failed' }],
  });
  for (const group of ['storage', 'living']) {
    assert.equal(f.rows(`floor_${group}_0_active`).at(-1).value, 0);
    const invalid = f.rows(`floor_${group}_1_active`).at(-1);
    assert.equal(invalid.value, null);
    assert(invalid.quality.includes('invalid-output-readback'));
  }
});

test('floor history failure cannot prevent confirmed OFF readback from releasing its obligation', async t => {
  const f = fixture(t);
  f.adapter.setConnected(true); await flush();
  for (const request of f.requests.splice(0)) f.respond(request);
  const leasing = f.adapter.lease({ owner: 'synthetic-cycle', until: START + 600_000 }); await flush();
  for (const request of f.requests.splice(0)) f.respond(request);
  await leasing;
  const on = f.rows('floor_storage_0_active').at(-1);
  assert.equal(on.value, 1);
  assert.equal(on.raw.recorder.status, 'fresh', 'correlated output changes can share a host millisecond');
  const releasing = f.adapter.release(); await flush();
  f.failHistory(true);
  for (const request of f.requests.splice(0)) assert.throws(() => f.respond(request), /synthetic history unavailable/);
  assert.equal((await releasing).released, true);
  assert.equal(f.store.getState('floor-override:v1').outstanding, null);
  f.failHistory(false);
  f.at(30_000); const tick = f.adapter.tick(); await flush();
  for (const request of f.requests.splice(0)) f.respond(request);
  await tick;
  assert.equal(f.rows('floor_storage_0_active').at(-1).value, 0);
});
