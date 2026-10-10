import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';
import { enrollJournalPeer, acceptPeerCheckpoint, preparePeerTransfer, peerTransferRows,
  applyPeerTransfer, acknowledgePeer } from '../src/storage/journal-peer.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { chargingSettings } from '../src/charging/settings.js';

const key = 'charging:simulated', at = Date.parse('2026-10-10T09:00:00Z');
const reading = (value, timestamp = at) => ({ value, source: 'easee', available: true,
  measuredAt: timestamp, receivedAt: timestamp });
function runtimeState() {
  const settings = chargingSettings({ chargers: { charger1: { enabled: true } } });
  const plan = { id: 'synthetic-accepted-plan', state: 'waiting', feasible: true, deadlineAt: at + 7200_000,
    periods: [{ startAt: at + 3600_000, endAt: null }], finalStartAt: at + 3600_000,
    priceSnapshot: [[at, at + 3600_000, 12], [at + 3600_000, at + 7200_000, 8]],
    intervals: [{ start: at, end: at + 3600_000, priceCtPerKwh: 12, powerKw: 11,
      scenarios: [{ source: 'synthetic-household', weight: 1, phaseCurrentA: [4, 3, 2] }],
      reference: { method: 'synthetic-reference', newestAt: at } }] };
  return { version: 7, revision: 1, chargers: { charger1: { association: 'synthetic-equipment',
    controls: { enabled: true, revision: 1 }, plan, supplyEstimate: { observedAt: at, voltageV: 230 } } },
  view: { settings, reportRetentionDays: 30, chargers: [{ id: 'charger1', plan: structuredClone(plan),
    values: { powerKw: reading(0) }, telemetry: { readAt: at } }] } };
}
function seedReportHistory(store, saved) {
  const observer = new ChargingSessionDiagnostics({ store, key: `${key}:session-diagnostics`, clock: () => at });
  const view = { id: 'charger1', association: 'synthetic-equipment', request: { sessionId: 'synthetic-earlier-session' },
    settings: saved.view.settings.chargers.charger1, deadlineAt: saved.chargers.charger1.plan.deadlineAt,
    values: { connected: reading(true), charging: reading(false), powerKw: reading(0) },
    control: { phase: 'waiting', session: { connectedAt: at }, snapshot: { online: true, readAt: at } },
    telemetry: { providerConnected: true }, vehicle: { state: 'unidentified' }, plan: saved.chargers.charger1.plan };
  observer.observe([view], at);
  view.values.connected = reading(false, at + 1000);
  view.control.snapshot.readAt = at + 1000;
  observer.observe([view], at + 1000);
}
const reportRows = store => Object.fromEntries(['charging_reports', 'charging_report_events', 'charging_report_contexts']
  .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY namespace,charger_id,report_id${table === 'charging_reports' ? '' : ',id'}`).all()]));
function* transferRows(store, id) {
  let afterOrdinal = -1;
  for (;;) {
    const page = peerTransferRows(store.db, { id, afterOrdinal, limit: 2 });
    if (!page.length) return;
    for (const row of page) { afterOrdinal = row.ordinal; yield row.change; }
  }
}

test('seeded charging fragments and replacement GC survive consolidated peer transfer without deleting report history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'charging-runtime-replication-'));
  const source = new Store(join(directory, 'source.sqlite')), replicaPath = join(directory, 'replica.sqlite');
  let replica;
  t.after(async () => { replica?.close(); source.close(); await rm(directory, { recursive: true, force: true }); });
  const original = runtimeState();
  writeChargingRuntime(source, key, original);
  seedReportHistory(source, original);
  const history = reportRows(source), originalManifest = source.getState(key);
  assert.equal(originalManifest.plans.length, 1, 'The plan shared by runtime and view is stored once');
  assert.equal(originalManifest.contexts.length, 1);
  assert.ok(history.charging_report_events.length);
  assert.ok(history.charging_report_contexts.length, 'The separate report history owns its price context');
  enrollJournalPeer(source.db);
  await source.backup(replicaPath);
  replica = new Store(replicaPath);
  acceptPeerCheckpoint(replica.db, { checkpoint: replica.checkpoint() });
  const base = replica.checkpoint();
  assert.deepEqual(readChargingRuntime(replica, key), original, 'The initial seed hydrates all referenced plan data');
  assert.deepEqual(reportRows(replica), history);
  verifyJournal(replica.db);

  let latest;
  for (let revision = 1; revision <= 3; revision++) {
    latest = structuredClone(original);
    const changedAt = at + revision * 60_000, plan = latest.chargers.charger1.plan;
    latest.revision += revision;
    latest.chargers.charger1.supplyEstimate.observedAt = changedAt;
    latest.view.chargers[0].values.powerKw = reading(revision, changedAt);
    latest.view.chargers[0].telemetry.readAt = changedAt;
    plan.periods[0].startAt += revision * 300_000;
    plan.finalStartAt = plan.periods[0].startAt;
    plan.intervals[0].scenarios[0].phaseCurrentA = [4 + revision, 3, 2];
    latest.view.chargers[0].plan = structuredClone(plan);
    writeChargingRuntime(source, key, latest);
    source.compactJournal({ maxCommits: 1 });
  }
  assert.ok(source.journalBase().sequence > base.sequence, 'The peer must use consolidated changes beyond retained commits');
  const transfer = preparePeerTransfer(source.db, { after: base });
  assert.ok(transfer.rows > 2, 'The complete fragment replacement spans multiple transfer pages');
  applyPeerTransfer(replica.db, { ...transfer, changes: transferRows(source, transfer.id) });
  assert.deepEqual(replica.checkpoint(), source.checkpoint());
  assert.deepEqual(readChargingRuntime(replica, key), latest);
  assert.deepEqual(readChargingRuntime(source, key), latest);
  for (const store of [source, replica]) {
    assert.equal(store.getState(`${key}:runtime:plan/${originalManifest.plans[0]}`), null);
    assert.equal(store.getState(`${key}:runtime:context/${originalManifest.contexts[0]}`), null);
    assert.equal(store.db.prepare('SELECT count(*) n FROM state WHERE key GLOB ?').get(`${key}:runtime:plan/*`).n, 1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM state WHERE key GLOB ?').get(`${key}:runtime:context/*`).n, 1);
    assert.deepEqual(reportRows(store), history, 'Runtime replacement cannot collect report-owned events or contexts');
    verifyJournal(store.db);
  }
  let acknowledgement;
  do { acknowledgement = acknowledgePeer(source.db, { checkpoint: replica.checkpoint(), limit: 2 }); }
  while (!acknowledgement.complete);
  verifyJournal(source.db);
  replica.close();
  replica = new Store(replicaPath);
  assert.deepEqual(readChargingRuntime(replica, key), latest, 'Receiver restart passes current-format preflight');
  assert.deepEqual(reportRows(replica), history);
  verifyJournal(replica.db);
});
