import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { createHouseholdForecastService } from '../src/charging/history-service.js';

const now = Date.parse('2026-09-15T00:00:00Z');
const options = { now, deadlineAt: now + 3_600_000, input: 'live', timezone: 'UTC', voltageV: 230 };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'charging-history-worker-')), store = new Store(join(dir, 'example.sqlite'));
  const service = createHouseholdForecastService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service };
}

test('file-backed history runs outside the event loop and supersedes all but the newest queued forecast', async t => {
  const { store, service } = fixture(t);
  const before = store.db.prepare('SELECT count(*) AS n FROM observations').get().n;
  const first = service.request(options);
  const superseded = service.request({ ...options, deadlineAt: now + 2 * 3_600_000 });
  const latest = service.request({ ...options, deadlineAt: now + 3 * 3_600_000 });
  assert.equal(await superseded, null);
  let eventLoopRan = false;
  await new Promise(resolve => setImmediate(() => { eventLoopRan = true; resolve(); }));
  const rows = await first;
  assert.equal(eventLoopRan, true);
  assert.equal(rows.length, 1);
  assert.equal((await latest).length, 3);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM observations').get().n, before, 'Worker never adds derived observations');
});

test('closing the service settles pending work without publishing stale results', async t => {
  const { service } = fixture(t);
  const running = service.request(options), queued = service.request(options);
  await service.close();
  assert.equal(await running, null);
  assert.equal(await queued, null);
  assert.equal(await service.request(options), null);
});

test('memory-store fallback shares the same promise and close contract', async t => {
  const store = new Store(':memory:'), service = createHouseholdForecastService({ store });
  t.after(() => store.close());
  assert.equal((await service.request(options))[0].reference.noHistory, true);
  service.close();
  assert.equal(await service.request(options), null);
});

test('worker errors are safe and do not expose the database path', async () => {
  const service = createHouseholdForecastService({ store: { path: '/missing/example-household.sqlite' } });
  try {
    await assert.rejects(service.request(options), error => error.code === 'history-unavailable' && !error.message.includes('example-household'));
  } finally { await service.close(); }
});
