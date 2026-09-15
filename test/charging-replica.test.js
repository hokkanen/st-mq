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
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';

test('read-only replica shows saved charging preferences, SoC and ownership at the original snapshot time without replanning', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-replica-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshotAt = Date.parse('2026-01-15T00:00:00Z'), dbPath = join(directory, 'snapshot.sqlite');
  const settings = chargingSettings({ chargers: { charger1: { enabled: true, capacityKwh: 62, manualSoc: 45 }, charger2: { capacityKwh: 51 } } });
  const automaticSoc = { soc: 32, measuredAt: snapshotAt - 86400_000, receivedAt: snapshotAt - 60_000,
    vehicleId: settings.chargers.charger1.mqtt.vehicleId, sourceId: settings.chargers.charger1.mqtt.sourceId, readingId: 'snapshot-reading' };
  const manualSoc = { soc: 45, enteredAt: snapshotAt - 30_000, expiresAt: snapshotAt + 4 * 3600_000 };
  const plan = { state: 'waiting', reason: 'cheapest-feasible-start', startAt: snapshotAt + 3600_000,
    deadlineAt: manualSoc.expiresAt, finishAt: snapshotAt + 3 * 3600_000, requiredGridKwh: 24, feasible: true };
  const owned = { planId: 'snapshot-plan', startAt: plan.startAt, confirmedAt: snapshotAt - 10_000, fingerprint: 'invented-fingerprint' };
  const store = new Store(dbPath);
  store.event('decision', { input: 'mqtt', mode: 'monitoring' }, snapshotAt);
  const ownership = { version: 1, phase: 'waiting', owned,
    released: false, manual: null, reason: 'Native delayed start confirmed.' };
  const view = { settings, chargers: CHARGER_DEFINITIONS.map(definition => {
    const first = definition.id === 'charger1';
    return { ...buildCharger({ definition, settings: settings.chargers[definition.id], now: snapshotAt,
      timezone: settings.timezone, automaticSoc: first ? automaticSoc : null,
      manualSoc: first ? manualSoc : null, control: first ? ownership : { phase: 'off', released: false },
      telemetry: first ? {} : { soc: { value: 67, source: 'teslamate', measuredAt: null, receivedAt: snapshotAt - 5000 } } }),
      automaticSoc: first ? automaticSoc : null, manualSoc: first ? manualSoc : null, plan: first ? plan : null,
      forecast: null, mqtt: { connected: true, subscribed: true, reason: null }, error: null };
  }), coordination: null, error: null };
  store.setState('charging:mqtt', { version: 2, settings, chargers: {
    charger1: { automaticSoc, manualSoc, plan }, charger2: { automaticSoc: null, manualSoc: null, plan: null },
  }, view });
  store.setState('charging:mqtt:charger1:ownership', ownership);
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
  const [charger1, charger2] = status.charging.chargers;
  assert.deepEqual(charger1.plan, plan);
  assert.deepEqual(charger1.control.owned, owned);
  assert.equal(charger1.control.phase, 'waiting');
  assert.equal(charger1.control.snapshot, null);
  assert.equal(charger1.control.released, false, 'Elapsed viewer time never releases a saved charging plan');
  assert.equal(charger1.values.soc.source, 'manual', 'SoC source is resolved at the source snapshot boundary');
  assert.equal(charger1.values.soc.expiresAt, manualSoc.expiresAt);
  assert.deepEqual(charger1.automaticSoc, automaticSoc);
  assert.equal(charger2.plan, null);
  assert.equal(charger2.values.soc.value, 67, 'The common charger view retains actual recorded provider telemetry');
  assert.equal(charger2.values.soc.receivedAt, snapshotAt - 5000);
  assert.equal(charger1.mqtt.connected, null);
  assert.equal(charger2.mqtt.connected, null);
  now += 86400_000;
  assert.deepEqual(JSON.parse(JSON.stringify(app.status().charging)), status.charging);
  const denied = await fetch(`${root}/api/charging/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"chargers":{"charger1":{"enabled":false}}}' });
  assert.equal(denied.status, 405);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) count FROM events').get().count, 1);
  assert.equal(digest(), originalDigest, 'Replica rendering and rejected mutations leave the published database unchanged');
});
