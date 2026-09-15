import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { chargingSettings } from '../src/charging/settings.js';

test('read-only replica shows saved charging preferences, SoC and ownership at the original snapshot time without replanning', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-replica-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshotAt = Date.parse('2026-01-15T00:00:00Z'), dbPath = join(directory, 'snapshot.sqlite');
  const settings = chargingSettings({ enabled: true, capacity1Kwh: 62, capacity2Kwh: 51, manualSoc: 45 });
  const automaticSoc = { soc: 32, measuredAt: snapshotAt - 86400_000, receivedAt: snapshotAt - 60_000,
    vehicleId: settings.vehicleId, sourceId: settings.sourceId, readingId: 'snapshot-reading' };
  const manualSoc = { soc: 45, enteredAt: snapshotAt - 30_000, expiresAt: snapshotAt + 4 * 3600_000 };
  const plan = { state: 'waiting', reason: 'cheapest-feasible-start', startAt: snapshotAt + 3600_000,
    deadlineAt: manualSoc.expiresAt, finishAt: snapshotAt + 3 * 3600_000, requiredGridKwh: 24, feasible: true };
  const owned = { planId: 'snapshot-plan', startAt: plan.startAt, confirmedAt: snapshotAt - 10_000, fingerprint: 'invented-fingerprint' };
  const store = new Store(dbPath);
  store.event('decision', { input: 'mqtt', mode: 'monitoring' }, snapshotAt);
  store.setState('charging:mqtt', { settings, automaticSoc, manualSoc, plan });
  store.setState('charging:mqtt:ownership', { version: 1, phase: 'waiting', owned,
    released: false, manual: null, reason: 'Native delayed start confirmed.' });
  store.close();
  const raw = new DatabaseSync(dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  const originalDigest = digest();
  const publication = { dbPath, generation: 'charging-snapshot', sourceAt: snapshotAt, verifiedAt: snapshotAt,
    digest: originalDigest, bytes: readFileSync(dbPath).length };
  let now = snapshotAt + 7 * 86400_000;
  const app = await startReplica({ config: { role: 'replica', input: 'offline', addon: false,
    host: '127.0.0.1', port: 0, token: '', replication: { directory } }, clock: () => now,
    readPublication: async () => publication, installSignalHandlers: false,
    makeChartService: () => ({ overview: async () => ({}), close: async () => {} }) });
  t.after(() => app.close());
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const status = await (await fetch(`${root}/api/status`)).json();
  assert.equal(status.role, 'replica');
  assert.equal(status.input, 'mqtt', 'Charging scope follows the primary recorded input, not the viewer configuration');
  assert.equal(status.replication.state, 'stale');
  assert.equal(status.charging.readOnly, true);
  assert.equal(status.charging.snapshotAt, snapshotAt);
  assert.deepEqual(status.charging.settings, settings);
  assert.deepEqual(status.charging.plan, plan);
  assert.deepEqual(status.charging.control.owned, owned);
  assert.equal(status.charging.control.phase, 'waiting');
  assert.equal(status.charging.control.snapshot, null);
  assert.equal(status.charging.control.released, false, 'Elapsed viewer time never releases a saved charging plan');
  assert.equal(status.charging.soc.source, 'manual', 'SoC source is resolved at the source snapshot boundary');
  assert.equal(status.charging.soc.expiresAt, manualSoc.expiresAt);
  assert.deepEqual(status.charging.automaticSoc, automaticSoc);
  assert.equal(status.charging.charger2, null, 'Transient Charger 2 telemetry is not fabricated from a copied plan');
  assert.equal(status.charging.mqtt.connected, null);
  now += 86400_000;
  assert.deepEqual(app.status().charging, status.charging);
  const denied = await fetch(`${root}/api/charging/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
  assert.equal(denied.status, 405);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) count FROM events').get().count, 1);
  assert.equal(digest(), originalDigest, 'Replica rendering and rejected mutations leave the published database unchanged');
});
