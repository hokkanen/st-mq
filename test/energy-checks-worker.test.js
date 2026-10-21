import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/storage/store.js';
import { createEnergyChecksService } from '../src/app/energy-checks-service.js';
import { createChartService } from '../src/app/chart-service.js';
import { createAppServer } from '../src/app/server.js';
import { energyCheckSummaries } from '../src/app/energy-checks.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';

const start = Date.parse('2026-09-01T00:00:00Z');
const signal = 'property_import_energy_counter';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-energy-checks-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const service = createEnergyChecksService({ store, ...options });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service };
}
function energy(store, from, to, changes = {}) {
  for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'easee', device: 'invented-property',
    signal: `property_energy_l${phase}`, sourceTime: to, receivedAt: to, value: 1 / 3, unit: 'kWh',
    quality: ['estimated'], raw: { intervalStart: from, intervalEnd: to }, ...changes });
}
function counters(store, count) {
  const insert = store.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality)
    VALUES('easee','invented-property',?,?,?,?, '[]')`);
  for (let offset = 0; offset < count; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(count, offset + 256); index++) insert.run(signal, start + index * 1000, start + index * 1000, index);
  });
}
async function finished(service, args = {}) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const state = await service.view(args);
    if (state.job.state === 'failed') assert.fail(JSON.stringify(state.job.error));
    if (state.job.state === 'completed') return state;
    await pause();
  }
  assert.fail('Synthetic energy checks did not finish');
}
async function serverFixture(t, store, chartService, overrides = {}) {
  const engine = { clock: () => start + 1_000_000_000, config: { input: 'providers' }, status: () => ({}) };
  const server = createAppServer({ store, engine, chartService, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('100,000-counter jobs return immediately, share work and preserve old successes while recording continues', async t => {
  const { store, service } = fixture(t);
  counters(store, 100_000); energy(store, start, start + 1000);
  const now = start + 1_000_000_000;
  const began = performance.now();
  const first = await service.view({ now });
  assert.equal(first.result, null);
  assert.equal(first.job.state, 'queued');
  assert(performance.now() - began < 100, 'initial view does no historical scan');
  assert.equal((await service.view({ now })).job.id, first.job.id, 'concurrent viewers share the job');
  let beats = 0, writes = 0, turns = 0, maximumTurn = 0;
  const runStorageTask = store.runStorageTask.bind(store);
  store.runStorageTask = (operation, options) => runStorageTask(async () => {
    const at = performance.now();
    try { return await operation(); }
    finally { turns++; maximumTurn = Math.max(maximumTurn, performance.now() - at); }
  }, options);
  const heartbeat = setInterval(() => {
    beats++; store.setState('synthetic:concurrent-recording', { beats }); writes++;
  }, 5);
  let completed;
  try { completed = await finished(service, { now }); } finally { clearInterval(heartbeat); }
  assert(beats >= 3 && writes >= 3, 'timers and committed writes continue during background work');
  assert(turns > 100, 'history uses many admitted source batches instead of one aggregate');
  const rows = completed.result;
  assert.equal(rows[0].summary.readingCount, 100_000);
  assert.equal(rows[0].summary.status, 'incomplete-coverage');
  assert.equal(rows[0].summary.lastSuccessfulComparison.end, start + 1000);
  assert.equal(rows[0].summary.lastSuccessfulComparison.meteredKwh, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM energy_audits').get().n, 100_000);
  assert.equal(completed.resultAsOf, now);
  assert.equal((await service.view({ now })).job.id, first.job.id, 'completed results are reused');
  assert(!JSON.stringify(completed).includes('invented-property'));
  t.diagnostic(`Local synthetic 100,000 counters: ${(performance.now() - began).toFixed(1)} ms, ${turns} source turns, `
    + `${writes} concurrent commits, longest admitted turn ${maximumTurn.toFixed(1)} ms; no Pi timing claim.`);
});

test('append refresh reuses evidence while updates, deletions and unchanged-generation exclusions rebuild it', async t => {
  const { store, service } = fixture(t);
  counters(store, 3); energy(store, start, start + 1000); energy(store, start + 1000, start + 2000);
  const now = start + 100_000;
  await finished(service, { now });
  const sessionId = recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'invented-session',
    start, end: start + 1000, estimatedKwh: 1.1, referenceKwh: 1, complete: true });
  await service.action({ action: 'refresh' }, { now });
  let state = await finished(service, { now });
  assert.equal(state.job.processed, 1, 'only the appended charging check is copied');
  assert.deepEqual(state.result, energyCheckSummaries(store, { now }));
  store.transaction(() => store.db.prepare('UPDATE observations SET value=value*2 WHERE id=1').run());
  await service.action({ action: 'refresh' }, { now });
  state = await finished(service, { now });
  assert.deepEqual(state.result, energyCheckSummaries(store, { now }));
  assert(state.job.processed > 1, 'updates cannot reuse old energy');
  store.transaction(() => store.db.prepare('DELETE FROM observations WHERE id=1').run());
  await service.action({ action: 'refresh' }, { now });
  assert.deepEqual((await finished(service, { now })).result, energyCheckSummaries(store, { now }));
  store.transaction(() => store.db.prepare(`INSERT INTO recovery_exclusions(generation,table_name,record_key)
    VALUES('original','events',?)`).run(String(sessionId)));
  await service.action({ action: 'refresh' }, { now });
  assert.deepEqual((await finished(service, { now })).result, energyCheckSummaries(store, { now }));
});

test('oversized evidence is discarded after exact completion without discarding the completed summary', async t => {
  const { store, service } = fixture(t, { evidenceCacheBytes: 1 });
  counters(store, 20); energy(store, start, start + 1000);
  const now = start + 100_000;
  const first = await finished(service, { now });
  assert.deepEqual(first.result, energyCheckSummaries(store, { now }));
  assert.equal(first.result[0].summary.readingCount, 20);
  const retained = await service.view({ now });
  assert.deepEqual(retained.result, first.result);
  assert.equal(retained.job.id, first.job.id);
  await service.action({ action: 'refresh' }, { now });
  const rebuilt = await finished(service, { now });
  assert.equal(rebuilt.job.processed, 23, 'discarded evidence is rebuilt in full on demand');
  assert.deepEqual(rebuilt.result, first.result);
});

test('idle evidence expires while the complete summary remains available', async t => {
  const { store, service } = fixture(t, { idleMs: 20 });
  counters(store, 20); energy(store, start, start + 1000);
  const now = start + 100_000;
  const first = await finished(service, { now });
  await new Promise(resolve => setTimeout(resolve, 50));
  const retained = await service.view({ now });
  assert.deepEqual(retained.result, first.result);
  assert.equal(retained.resultGeneratedAt, first.resultGeneratedAt);
  assert.equal(retained.job.id, first.job.id, 'status reads do not restart expired evidence');
  await service.action({ action: 'refresh' }, { now });
  const rebuilt = await finished(service, { now });
  assert.equal(rebuilt.job.processed, 23, 'idle retirement releases the scratch database');
  assert.deepEqual(rebuilt.result, first.result);
});

test('week, month and year mixed hourly histories retain exact results with constant-size source turns', async t => {
  const { store, service } = fixture(t);
  const hour = 3_600_000;
  const audit = store.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality)
    VALUES('easee','invented-property',?,?,?,?,'[]')`);
  const observation = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
    VALUES('easee','invented-property',?,?,?,?,?,'[]',?)`);
  audit.run(signal, start, start, 0);
  let hours = 0;
  for (const days of [7, 30, 365]) {
    const through = days * 24;
    for (let offset = hours; offset < through; offset += 64) store.transaction(() => {
      for (let index = offset; index < Math.min(through, offset + 64); index++) {
        const at = start + (index + 1) * hour;
        audit.run(signal, at, at, index + 1);
        for (const phase of [1, 2, 3]) observation.run(`property_energy_l${phase}`, 1 / 3, 'kWh', at, at,
          JSON.stringify({ intervalStart: at - hour, intervalEnd: at }));
        // Other signal payloads are present in the source but never copied into
        // energy evidence. This workload states its hourly reporting density.
        observation.run('outdoor_temperature', 10, '°C', at, at, '{}');
        observation.run('indoor_temperature', 21, '°C', at, at, '{}');
      }
    });
    hours = through;
    const now = start + through * hour;
    const began = performance.now();
    await service.action({ action: 'refresh' }, { now });
    const completed = await finished(service, { now });
    assert.deepEqual(completed.result, energyCheckSummaries(store, { now }));
    assert.equal(completed.result[0].summary.readingCount, through + 1);
    assert.equal(completed.result[0].summary.comparison.meteredKwh, 1);
    t.diagnostic(`${days} days, hourly synthetic density: ${through * 5} mixed observations, `
      + `${(performance.now() - began).toFixed(1)} ms for background checks; source batches remain at most 128 rows.`);
  }
});

test('jobs follow selected history, delayed receipts and clock rollback without exposing cached future evidence', async t => {
  const { store, service } = fixture(t);
  counters(store, 3);
  energy(store, start, start + 1000, { receivedAt: start + 5000 });
  energy(store, start + 1000, start + 2000);
  const first = (await finished(service, { now: start + 6000 })).result;
  assert.deepEqual(first, energyCheckSummaries(store, { now: start + 6000 }));
  const rolledBack = await service.view({ now: start });
  assert.equal(rolledBack.result, null);
  assert.equal(rolledBack.latest, null);
  assert.equal((await finished(service, { now: start })).result[0].summary.status, 'waiting-for-second-reading');
  store.transaction(() => {
    store.db.prepare(`INSERT INTO recovery_exclusions(generation,table_name,record_key)
      VALUES('synthetic-selection','energy_audits','3')`).run();
    store.db.prepare("UPDATE history_selection SET generation='synthetic-selection' WHERE id=1").run();
  });
  const selected = await service.view({ now: start + 6000 });
  assert.equal(selected.result, null, 'prior selection is removed before the next scan');
  assert.deepEqual((await finished(service, { now: start + 6000 })).result,
    energyCheckSummaries(store, { now: start + 6000 }));
});

test('exact worker parity retains resets, late counter values, exclusions, source admission and pending energy', async t => {
  const { store, service } = fixture(t);
  counters(store, 4);
  energy(store, start, start + 1000, { quality: ['estimated', 'local_ocpp'],
    raw: { intervalStart: start, intervalEnd: start + 1000, transport: 'ocpp', privatePayload: 'never-copied' } });
  energy(store, start + 1000, start + 3000);
  store.energyAudit({ source: 'easee', device: 'invented-property', signal, sourceTime: start + 1500,
    receivedAt: start + 4000, value: 900 });
  store.energyAudit({ source: 'easee', device: 'invented-property', signal, sourceTime: start + 4000,
    receivedAt: start + 4000, value: 0 });
  const key = `recorder:energy:${JSON.stringify(['easee', 'invented-property', 'property'])}`;
  store.setState(key, { pending: { start: start + 3000, end: start + 4000, receivedAt: start + 3999,
    admittedAt: start + 4000, energies: [1 / 3, 1 / 3, 1 / 3], quality: ['estimated'], transport: 'cloud' } });
  recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'invented-excluded',
    start, end: start + 1000, estimatedKwh: null, referenceKwh: 1, complete: false, quality: ['incomplete-coverage'] });
  for (const now of [start + 5000, start + 3999, start + 4000]) {
    await service.action({ action: 'refresh' }, { now });
    const state = await finished(service, { now });
    assert.deepEqual(state.result, energyCheckSummaries(store, { now }));
    assert(!JSON.stringify(state).includes('never-copied'));
  }
});

test('explicit cancellation is retained across polling and refresh starts a fresh independent job', async t => {
  const { store, service } = fixture(t);
  counters(store, 1000);
  const now = start + 100_000;
  const first = await service.view({ now });
  const cancelled = await service.action({ action: 'cancel' }, { now });
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal((await service.view({ now })).job.state, 'cancelled');
  const restarted = await service.action({ action: 'refresh' }, { now });
  assert(restarted.job.id > first.job.id);
  assert.equal((await finished(service, { now })).result[0].summary.readingCount, 101);
  await assert.rejects(service.action({ action: 'unknown' }, { now }), TypeError);
  await assert.rejects(service.action({ action: 'refresh', retiredField: true }, { now }), TypeError);
  await assert.rejects(service.view({ now, force: true }), TypeError);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(service.view({ now, signal: aborted.signal }), { name: 'AbortError' });
});

test('failed refresh preserves the last complete result and revoked snapshot scope hides it', async t => {
  const { store, service } = fixture(t);
  counters(store, 2); energy(store, start, start + 1000);
  const now = start + 1000;
  const first = await finished(service, { now });
  const runStorageTask = store.runStorageTask;
  store.runStorageTask = () => Promise.reject(Object.assign(new Error('Private failure must stay private'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }));
  await service.action({ action: 'refresh' }, { now });
  const deadline = performance.now() + 5000;
  let failed;
  while (performance.now() < deadline) {
    failed = await service.view({ now });
    if (failed.job.state === 'failed') break;
    await pause();
  }
  assert.equal(failed.job.state, 'failed');
  assert.deepEqual(failed.result, first.result);
  assert.equal(failed.resultGeneratedAt, first.resultGeneratedAt);
  assert(!JSON.stringify(failed).includes('Private failure'));
  store.runStorageTask = runStorageTask;
  const checkpoint = { ...store.checkpoint(), databaseId: '00000000-0000-0000-0000-000000000000' };
  const different = await service.view({ now, checkpoint });
  assert.equal(different.result, null);
  assert.equal(different.latest, null);
  while (performance.now() < deadline) {
    failed = await service.view({ now, checkpoint });
    if (failed.job.state === 'failed') break;
    await pause();
  }
  assert.equal(failed.job.error.code, 'history-changed');
  const valid = store.checkpoint();
  await service.action({ action: 'refresh' }, { now, checkpoint: valid });
  assert.deepEqual((await finished(service, { now, checkpoint: valid })).result, first.result);
});

test('forward publication of the same physical replica preserves an in-flight job and its dated result', async t => {
  const { store, service } = fixture(t);
  counters(store, 2000);
  const now = start + 10_000_000, original = store.checkpoint();
  const first = await service.view({ now, checkpoint: original });
  const deadline = performance.now() + 5000;
  while ((await service.view({ now, checkpoint: original })).job.state !== 'running' && performance.now() < deadline) await pause();
  assert.equal((await service.view({ now, checkpoint: original })).job.state, 'running');
  store.setState('synthetic:forward-replica-publication', { sequence: 1 });
  const advanced = store.checkpoint();
  assert(advanced.sequence > original.sequence);
  const sameJob = await service.view({ now, checkpoint: advanced });
  assert.equal(sameJob.job.id, first.job.id);
  assert.notEqual(sameJob.job.state, 'cancelled');
  const complete = await finished(service, { now, checkpoint: advanced });
  assert.equal(complete.job.id, first.job.id);
  assert.equal(complete.result[0].summary.readingCount, 2000);
  store.setState('synthetic:forward-replica-publication', { sequence: 2 });
  const next = await service.view({ now, checkpoint: store.checkpoint() });
  assert.deepEqual(next.result, complete.result);
  assert.equal(next.resultGeneratedAt, complete.resultGeneratedAt);
  assert.equal(next.job.id, complete.job.id);
  await assert.rejects(service.view({ now, checkpoint: original }), { code: 'ENERGY_CHECKPOINT_CHANGED' });
  await assert.rejects(service.view({ now, checkpoint: { ...store.checkpoint(), hash: '0'.repeat(64) } }),
    { code: 'ENERGY_CHECKPOINT_CHANGED' });
});

test('cancelling an admitted worker releases storage before the replacement job runs', async t => {
  const { store, service } = fixture(t);
  counters(store, 2000);
  const now = start + 10_000_000;
  await service.view({ now });
  const deadline = performance.now() + 5000;
  while ((await service.view({ now })).job.state !== 'running' && performance.now() < deadline) await pause();
  assert.equal((await service.view({ now })).job.state, 'running');
  const cancelled = await service.action({ action: 'cancel' }, { now });
  assert.equal(cancelled.job.state, 'cancelled');
  await store.runWrite(() => store.setState('synthetic:after-worker-cancel', { saved: true }), { priority: 'control' });
  assert.equal(store.getState('synthetic:after-worker-cancel').saved, true);
  await service.action({ action: 'refresh' }, { now });
  assert.equal((await finished(service, { now })).result[0].summary.readingCount, 2000);
});

test('HTTP energy view is quick, disconnect leaves the shared job running, and actions use one current contract', async t => {
  const { store } = fixture(t);
  counters(store, 1000); energy(store, start, start + 1000);
  const charts = createChartService({ store, warmCache: false });
  t.after(() => charts.close());
  const base = await serverFixture(t, store, charts);
  const first = await fetch(`${base}/api/energy-audits`).then(response => response.json());
  assert(['queued', 'running'].includes(first.job.state));
  assert.equal(first.result, null);
  const refreshed = await fetch(`${base}/api/energy-audits`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'refresh' }) }).then(response => response.json());
  assert.equal(refreshed.job.id, first.job.id);
  const deadline = performance.now() + 10_000;
  let completed;
  while (performance.now() < deadline) {
    completed = await fetch(`${base}/api/energy-audits`).then(response => response.json());
    if (completed.job.state === 'completed') break;
    assert.notEqual(completed.job.state, 'failed'); await pause();
  }
  assert.equal(completed.job.state, 'completed');
  assert.equal(completed.result[0].summary.readingCount, 1000);
  assert.equal((await fetch(`${base}/api/energy-audits?force=1`)).status, 400);
  assert.equal((await fetch(`${base}/api/energy-audits`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'refresh', retiredField: true }) })).status, 400);
});

test('energy HTTP responses retain replica context and reject revoked access before sending results', async t => {
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
  assert.equal(released, 0);
  access = { enabled: false, token: '' };
  finish({ result: [{ privateFixtureMustNotLeak: true }] });
  const denied = await response;
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: 'Direct web access is disabled' });
  assert.equal(released, 1);
});

test('date-scoped jobs share bounded work without cancelling another period or automatically refreshing results', async t => {
  const { store, service } = fixture(t);
  counters(store, 3); energy(store, start, start + 1000);
  recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'range-included', start, end: start + 1000,
    estimatedKwh: 1, referenceKwh: 1, complete: true });
  recordChargingSessionCheck(store, { source: 'easee', sessionKey: 'range-crossing', start: start - 86400_000,
    end: start + 1000, estimatedKwh: 2, referenceKwh: 2, complete: true });
  const args = { now: start + 4 * 86400_000, startDate: '2026-09-01', endDate: '2026-09-01' };
  const other = { ...args, startDate: '2026-09-02', endDate: '2026-09-02' };
  const first = await service.view(args), waiting = await service.view(other);
  assert.equal(waiting.job.id, first.job.id); assert.equal(waiting.waitingForPeriod, true);
  assert.equal((await service.action({ action: 'cancel' }, other)).job.id, first.job.id);
  const completed = await finished(service, args);
  assert.equal(completed.result[1].summary.recordedSessions, 1);
  const unchanged = await service.view({ ...args, now: args.now + 120_000 });
  assert.equal(unchanged.job.id, first.job.id); assert.equal(unchanged.resultAsOf, args.now);
  const changed = await finished(service, other);
  assert.notEqual(changed.job.id, first.job.id);
  assert.equal(changed.result[0].summary.status, 'no-readings');
  assert.equal(changed.result[1].summary.recordedSessions, 0);
  for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const state = await finished(service, { now: Date.parse('2026-11-01T12:00:00Z'), startDate: day, endDate: day });
    assert.equal(state.range.to - state.range.from, hours * 3600_000);
  }
  await assert.rejects(service.view({ ...args, endDate: '2026-02-30' }));
});
