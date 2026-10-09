import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/storage/store.js';
import { createChartService } from '../src/app/chart-service.js';
import { createAppServer } from '../src/app/server.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';

const start = Date.parse('2026-09-01T00:00:00Z');
const signal = 'property_import_energy_counter';
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-energy-checks-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const service = createChartService({ store, ...options });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service };
}
function energy(store, from, to) {
  for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'easee', device: 'invented-property',
    signal: `property_energy_l${phase}`, sourceTime: to, receivedAt: to, value: 1 / 3, unit: 'kWh',
    quality: ['estimated'], raw: { intervalStart: from, intervalEnd: to } });
}
function counters(store, count) {
  const insert = store.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality)
    VALUES('easee','invented-property',?,?,?,?, '[]')`);
  for (let offset = 0; offset < count; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(count, offset + 256); index++) insert.run(signal, start + index * 1000, start + index * 1000, index);
  });
}
async function serverFixture(t, store, chartService, overrides = {}) {
  const engine = { clock: () => start + 1_000_000_000, config: { input: 'providers' }, status: () => ({}) };
  const server = createAppServer({ store, engine, chartService, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('large energy-check HTTP reads preserve old successes while independent timers, recording and HTTP continue', async t => {
  const { store, service } = fixture(t);
  counters(store, 100_000);
  energy(store, start, start + 1000);
  let began;
  const workerStarted = new Promise(resolve => { began = resolve; });
  const routedService = { ...service, energyChecks(args, options) {
    return service.energyChecks(args, { ...options, onProgress(progress) {
      if (progress.stage === 'reading-energy-checks') began();
    } });
  } };
  const base = await serverFixture(t, store, routedService);
  let finished = false, beats = 0, writes = 0, maxGap = 0, maxWriteMs = 0, previous = performance.now();
  const request = fetch(`${base}/api/energy-audits`).then(async response => {
    assert.equal(response.status, 200);
    return response.json();
  }).finally(() => { finished = true; });
  await workerStarted;
  const beganAt = performance.now();
  previous = beganAt;
  const heartbeat = setInterval(() => {
    const at = performance.now(); maxGap = Math.max(maxGap, at - previous); previous = at; beats++;
    const started = performance.now();
    try { store.setState('synthetic:concurrent-recording', { beats }); writes++; }
    finally { maxWriteMs = Math.max(maxWriteMs, performance.now() - started); }
  }, 5);
  let rows;
  try {
    const independent = await fetch(`${base}/api/events`);
    assert.equal(independent.status, 200);
    await independent.json();
    assert.equal(finished, false, 'unrelated HTTP completes during the real history traversal');
    rows = await request;
  } finally {
    clearInterval(heartbeat);
    // Keep the measurements even when the overlap assertion fails. A final
    // blocking write may finish the request before another heartbeat samples it.
    t.diagnostic(`100,000 counters: ${(performance.now() - beganAt).toFixed(1)} ms after worker start; `
      + `${beats} timer ticks and ${writes} committed writes; maximum timer gap ${maxGap.toFixed(1)} ms; `
      + `maximum synchronous write ${maxWriteMs.toFixed(1)} ms (local synthetic fixture)`);
  }
  assert(beats >= 3 && writes >= 3, 'independent timers and committed writes continue during the read');
  assert.equal(rows[0].summary.readingCount, 100_000);
  assert.equal(rows[0].summary.status, 'incomplete-coverage');
  assert.equal(rows[0].summary.lastSuccessfulComparison.end, start + 1000);
  assert.equal(rows[0].summary.lastSuccessfulComparison.meteredKwh, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM energy_audits').get().n, 100_000);
});

test('energy checks share the bounded foreground queue and cancellation releases its capacity', async t => {
  const { service } = fixture(t, { maxQueue: 1 });
  const cancellation = new AbortController();
  const first = service.energyChecks({ now: start }, { signal: cancellation.signal });
  await assert.rejects(service.energyChecks({ now: start }), /Too many pending/);
  cancellation.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal((await service.energyChecks({ now: start }))[0].summary.status, 'no-readings');
});

test('worker energy checks follow selected history and clock rollback without a stale summary cache', async t => {
  const { store, service } = fixture(t);
  counters(store, 3);
  energy(store, start, start + 1000); energy(store, start + 1000, start + 2000);
  const eventId = recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'invented-session',
    start, end: start + 1000, estimatedKwh: 1, referenceKwh: 1, complete: true });
  const read = now => service.energyChecks({ now });
  const first = await read(start + 2000);
  assert.equal(first[0].summary.readingCount, 3);
  assert.equal(first[0].summary.comparison.meteredKwh, 1);
  assert.equal(first[1].summary.recordedSessions, 1);
  store.transaction(() => {
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('synthetic-selection',?,?)")
      .run('energy_audits', '3');
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('synthetic-selection',?,?)")
      .run('events', String(eventId));
    store.db.prepare("UPDATE history_selection SET generation='synthetic-selection' WHERE id=1").run();
  });
  const selected = await read(start + 2000);
  assert.equal(selected[0].summary.readingCount, 2);
  assert.equal(selected[0].summary.comparison.end, start + 1000);
  assert.equal(selected[1].summary.recordedSessions, 0);
  assert.equal((await read(start))[0].summary.status, 'waiting-for-second-reading');
  store.db.prepare("UPDATE history_selection SET generation='original' WHERE id=1").run();
  assert.deepEqual(await read(start + 2000), first);
});

test('energy-check HTTP waits retain the replica read context and reject revoked access before sending results', async t => {
  const { store } = fixture(t);
  let finish, began, released = 0, access = { enabled: true, token: 'synthetic-energy-check-access' };
  const started = new Promise(resolve => { began = resolve; });
  const chartService = { overview: async () => ({}), energyChecks() {
    began(); return new Promise(resolve => { finish = resolve; });
  } };
  const base = await serverFixture(t, store, chartService, { getAccess: () => access,
    getReadContext: async () => ({ store, chartService, engine: { clock: () => start }, release() { released++; } }) });
  const response = fetch(`${base}/api/energy-audits`, { headers: { Authorization: `Bearer ${access.token}` } });
  await started;
  assert.equal(released, 0, 'replica snapshot remains held while the worker reads it');
  access = { enabled: false, token: '' };
  finish([{ privateFixtureMustNotLeak: true }]);
  const denied = await response;
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: 'Direct web access is disabled' });
  assert.equal(released, 1);
});

test('disconnecting an energy-check client cancels its history work and releases the read context', async t => {
  const { store } = fixture(t);
  let began, cancelled, released = 0;
  const started = new Promise(resolve => { began = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const chartService = { overview: async () => ({}), energyChecks(_args, { signal }) {
    began(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled(); reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    }, { once: true }));
  } };
  const base = await serverFixture(t, store, chartService, { getReadContext: async () => ({ store, chartService,
    engine: { clock: () => start }, release() { released++; } }) });
  const cancellation = new AbortController();
  const response = fetch(`${base}/api/energy-audits`, { signal: cancellation.signal });
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await started;
  cancellation.abort();
  await rejected; await aborted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});
