import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { createInventoryService } from '../../src/app/inventory-service.js';
import { getDatabaseOverview } from '../../src/app/database-overview.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = view => ['queued','running'].includes(view.job.state);
const at = Date.parse('2026-01-01T00:00:00Z');

test('100k mixed inventory leaves the catalogue immediate and admits committed recording between batches', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-inventory-scale-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  let inventory;
  t.after(async () => { await inventory?.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const streams = [
    ['supply_temperature','degC','adaptive-value'], ['property_energy_l1','kWh','adaptive-energy'],
    ['garage_temperature','degC','change-only'], ['controller_phase','state','event'],
  ];
  const insert = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
    VALUES('synthetic','private-scale-device',?,?,?,?,?,'[]',?)`);
  const raw = streams.map(([, ,policy]) => JSON.stringify({ recorder: { policy },
    qualityBasis: 'synthetic', intervalStart: at, context: 'private-scale-source'.repeat(12) }));
  for (let start = 0; start < 100_000; start += 500) store.transaction(() => {
    for (let index = start; index < start + 500; index++) {
      const [signal, unit] = streams[index % streams.length], time = at + index * 60_000;
      insert.run(signal, index % 19, unit, time, time, raw[index % streams.length]);
    }
    store.event(start % 1000 ? 'decision' : 'settings-changed', {}, at + start * 60_000);
  });
  store.compactJournal();
  const baseline = getDatabaseOverview({ store, now: at });
  inventory = createInventoryService({ store, clock: () => at });
  const started = performance.now(), first = await inventory.view();
  const catalogueMs = performance.now() - started;
  assert.equal(first.result, null); assert.equal(first.job.state, 'idle');
  assert.equal(first.catalogue.database.adaptiveEstimatedBytes, null);

  // Count actual admitted native turns and commit a recording change while the
  // source scan is in progress. It belongs to the next snapshot, not this one.
  let turns = 0, recording = null;
  const originalAdmission = store.runStorageTask.bind(store);
  store.runStorageTask = (fn, options) => originalAdmission(async () => {
    turns++;
    return fn();
  }, options);
  const measurement = await inventory.action({ action: 'measure' });
  const shared = await inventory.action({ action: 'measure' });
  assert.equal(shared.job.id, measurement.job.id);
  const deadline = performance.now() + 90_000;
  let last = measurement, maxViewMs = 0;
  while (active(last) && performance.now() < deadline) {
    await wait(10);
    if (turns > 50 && !recording) recording = store.runWrite(() => store.event('decision', { syntheticConcurrentRecording: true }, at + 10));
    const tick = performance.now(); last = await inventory.view();
    maxViewMs = Math.max(maxViewMs, performance.now() - tick);
  }
  assert.equal(last.job.state, 'completed', JSON.stringify(last.job.error));
  await recording;
  assert(recording, 'recording was admitted before the inventory completed');
  assert(turns > 1000, `${turns} admitted turns should release the source between batches`);
  const logicalSnapshot = ({ database: { fileBytes, walBytes, totalFileBytes, ...database }, ...view }) => ({ ...view, database });
  assert.deepEqual(logicalSnapshot(last.result), logicalSnapshot(baseline), 'the complete result retains one consistent committed snapshot');
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM events WHERE at=?").get(at + 10).count, 1);
  assert(!JSON.stringify(last).includes('private-scale-device'));
  assert(!JSON.stringify(last).includes('private-scale-source'));

  await inventory.action({ action: 'measure' });
  const cancelled = await inventory.action({ action: 'cancel' });
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal(cancelled.result.generatedAt, last.result.generatedAt);
  t.diagnostic(JSON.stringify({ observations: 100_000, catalogueMs, maxViewMs, admittedTurns: turns,
    measuredRowsAndPages: last.job.processed, elapsedMs: performance.now() - started,
    largestRecentTurnMs: Math.max(...(store.storageTurns ?? []).map(row => row.runMs)) }));
});
