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

const snapshotAt = Date.parse('2026-01-15T00:00:00Z');

async function fixture(t, saved, ownership) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-replica-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'snapshot.sqlite'), store = new Store(dbPath);
  store.event('decision', { input: 'mqtt', mode: 'monitoring' }, snapshotAt);
  store.setState('charging:mqtt', saved);
  if (ownership) store.setState('charging:mqtt:charger1:ownership', ownership);
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
  return { app, root: `http://127.0.0.1:${app.server.address().port}`, digest, originalDigest, advance: () => { now += 86400_000; } };
}

test('read-only replica shows saved charging preferences, SoC and ownership at the original snapshot time without replanning', async t => {
  const settings = chargingSettings({ chargers: { charger1: { enabled: true, capacityKwh: 62, manualSoc: 45 }, charger2: { capacityKwh: 51 } } });
  const automaticSoc = { soc: 32, measuredAt: snapshotAt - 86400_000, receivedAt: snapshotAt - 60_000,
    association: 'stmq/garage/charger1/vehicle', readingId: 'snapshot-reading' };
  const plan = { state: 'waiting', reason: 'cheapest-feasible-start', startAt: snapshotAt + 3600_000,
    deadlineAt: snapshotAt + 4 * 3600_000, finishAt: snapshotAt + 3 * 3600_000, requiredGridKwh: 24, feasible: true };
  const owned = { planId: 'snapshot-plan', startAt: plan.startAt, confirmedAt: snapshotAt - 10_000, fingerprint: 'invented-fingerprint' };
  const ownership = { version: 1, phase: 'waiting', owned,
    released: false, manual: null, reason: 'Native delayed start confirmed.' };
  const view = { settings, chargers: CHARGER_DEFINITIONS.map(definition => {
    const first = definition.id === 'charger1';
    return { ...buildCharger({ definition, settings: settings.chargers[definition.id], now: snapshotAt,
      timezone: 'Europe/Helsinki', automaticSoc: first ? automaticSoc : null,
      configuration: { efficiency: .925 }, control: first ? ownership : { phase: 'off', released: false },
      telemetry: first ? {} : { soc: { value: 67, source: 'teslamate', measuredAt: null, receivedAt: snapshotAt - 5000 } } }),
      automaticSoc: first ? automaticSoc : null, plan: first ? plan : null,
      forecast: null, mqtt: { connected: true, subscribed: true, reason: null }, error: null };
  }), coordination: null, error: null };
  // A publication from before the fixed-loss rule retains its own assumption.
  view.chargers[0].configuration.efficiency = .9;
  view.chargers[0].requiredGridKwh = 62 * (view.chargers[0].values.minimumSoc.value - 32) / 100 / .9;
  view.chargers[0].referenceGridKwh = view.chargers[0].requiredGridKwh;
  view.chargers[0].requiredGridKwh -= 2;
  view.chargers[0].progress = { creditedGridKwh: 2, remainingGridKwh: view.chargers[0].requiredGridKwh,
    basis: { source: 'integrated-measured-power', lastMeasuredAt: snapshotAt - 10_000 } };
  const { app, root, digest, originalDigest, advance } = await fixture(t, { version: 2, settings, chargers: {
    charger1: { automaticSoc, plan }, charger2: { automaticSoc: null, plan: null },
  }, view }, ownership);
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
  assert.equal(charger1.values.soc.source, 'mqtt', 'SoC source is resolved at the source snapshot boundary');
  assert.equal(charger1.values.soc.value, 32);
  assert.equal(charger1.configuration.efficiency, .9, 'The current viewer must not replace a recorded primary energy assumption');
  assert.equal(charger1.requiredGridKwh, view.chargers[0].requiredGridKwh);
  assert.deepEqual(charger1.progress, view.chargers[0].progress, 'Measured energy credit stays frozen at publication');
  assert.deepEqual(charger1.automaticSoc, automaticSoc);
  assert.equal(charger2.plan, null);
  assert.equal(charger2.values.soc.value, 67, 'The common charger view retains actual recorded provider telemetry');
  assert.equal(charger2.values.soc.receivedAt, snapshotAt - 5000);
  assert.equal(charger1.mqtt.connected, null);
  assert.equal(charger2.mqtt.connected, null);
  advance();
  assert.deepEqual(JSON.parse(JSON.stringify(app.status().charging)), status.charging);
  const denied = await fetch(`${root}/api/charging/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"chargers":{"charger1":{"enabled":false}}}' });
  assert.equal(denied.status, 405);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) count FROM events').get().count, 1);
  assert.equal(digest(), originalDigest, 'Replica rendering and rejected mutations leave the published database unchanged');
});

test('replica preserves independent vehicle identification, selected values and session costs from the published view', async t => {
  const settings = chargingSettings(), automaticSoc = { source: 'bmw-cardata', soc: 85, chargeLimitSoc: 95,
    measuredAt: snapshotAt - 3600_000, receivedAt: snapshotAt - 30_000, readingId: 'published-bmw' };
  const charger = buildCharger({ definition: CHARGER_DEFINITIONS[0], settings: settings.chargers.charger1,
    automaticSoc, now: snapshotAt, telemetry: { connected: true, charging: true } });
  charger.vehicle = { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata', chargerId: 'charger1' };
  charger.automaticSoc = automaticSoc;
  charger.sessionCost = { totalCents: 123, incurredCents: 73, remainingCents: 50 };
  charger.progress = { estimatedSoc: 89, creditedGridKwh: 3.5, hasEnergyEstimate: true };
  charger.vehicleMqtt = { provider: 'bmw-cardata', brokerConnected: true, subscribed: true, lastLiveAt: snapshotAt - 30_000 };
  const feed = { id: 'bmw', label: 'BMW', provider: 'bmw-cardata', topic: 'stmq/vehicles/bmw',
    usedByChargerId: 'charger1', reception: charger.vehicleMqtt };
  const { app, digest, originalDigest, advance } = await fixture(t, { version: 4, settings,
    vehicleFeeds: { bmw: { reading: automaticSoc } }, chargers: { charger1: {}, charger2: {} },
    view: { chargers: [charger], vehicleFeeds: [feed] } });
  const charging = app.status().charging, actual = charging.chargers[0];
  for (const key of ['vehicle', 'values', 'automatic', 'automaticSoc', 'sessionCost', 'progress', 'configuration'])
    assert.deepEqual(actual[key], charger[key], `${key} remains the primary's published value`);
  assert.equal(actual.vehicleMqtt.brokerConnected, null);
  assert.equal(actual.vehicleMqtt.subscribed, null);
  assert.equal(actual.vehicleMqtt.lastLiveAt, feed.reception.lastLiveAt);
  assert.equal(charging.vehicleFeeds[0].usedByChargerId, 'charger1');
  assert.equal(charging.vehicleFeeds[0].label, 'BMW');
  assert.equal(charging.vehicleFeeds[0].topic, feed.topic);
  assert.equal(charging.vehicleFeeds[0].reception.brokerConnected, null);
  advance(); assert.deepEqual(app.status().charging, charging);
  assert.equal(digest(), originalDigest);
});

test('a legacy replica without a saved charger view never invents an energy assumption or fresh estimate', async t => {
  const settings = chargingSettings();
  const { app } = await fixture(t, { version: 1, settings, chargers: { charger1: {
    automaticSoc: { soc: 40, measuredAt: snapshotAt - 60_000, readingId: 'legacy-soc' },
    plan: { requiredGridKwh: 17, deadlineAt: snapshotAt + 3600_000 },
  } } });
  const [one, two] = app.status().charging.chargers;
  assert.equal(one.values.soc.value, 40);
  assert.equal(one.requiredGridKwh, 17, 'Only the primary plan can supply a saved energy requirement');
  assert.equal(one.configuration.efficiency, null);
  assert.equal(two.requiredGridKwh, null);
  assert.equal(two.configuration.efficiency, null);
});
