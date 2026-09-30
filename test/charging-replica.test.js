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
  store.event('decision', { input: 'mqtt',  }, snapshotAt);
  store.setState('charging:mqtt', saved);
  if (ownership) store.setState('charging:mqtt:charger1:synthetic-association:ownership', ownership);
  store.close();
  const raw = new DatabaseSync(dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  const originalDigest = digest();
  const publication = { dbPath, generation: 'charging-snapshot', sourceAt: snapshotAt, verifiedAt: snapshotAt,
    digest: originalDigest, bytes: readFileSync(dbPath).length };
  let now = snapshotAt + 7 * 86400_000;
  const app = await startReplica({ config: { topology: 'mirror', role: 'slave', input: 'offline', addon: false,
    host: '127.0.0.1', port: 0, token: '', mirror: { directory } }, clock: () => now,
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
  const ownership = { version: 5, phase: 'waiting', owned,
    released: false, manual: null, reason: 'Native delayed start confirmed.' };
  const view = { settings, controls: { priority: 'balanced', revision: 2 }, chargers: CHARGER_DEFINITIONS.map(definition => {
    const first = definition.id === 'charger1';
    return { ...buildCharger({ definition, settings: settings.chargers[definition.id], now: snapshotAt,
      timezone: 'Europe/Helsinki', automaticSoc: first ? automaticSoc : null,
      configuration: { efficiency: .925 }, control: first ? ownership : { phase: 'off', released: false },
      telemetry: first ? {} : { soc: { value: 67, source: 'teslamate', measuredAt: null, receivedAt: snapshotAt - 5000 } } }),
      controls: { enabled: settings.chargers[definition.id].enabled, revision: 3 },
      automaticSoc: first ? automaticSoc : null, plan: first ? plan : null,
      forecast: null, mqtt: { connected: true, subscribed: true, reason: null }, error: null };
  }), coordination: null, error: null };
  // The snapshot keeps the primary's current connection assumptions frozen.
  view.chargers[0].configuration.efficiency = .925;
  view.chargers[0].requiredGridKwh = 62 * (view.chargers[0].values.minimumSoc.value - 32) / 100 / .925;
  view.chargers[0].referenceGridKwh = view.chargers[0].requiredGridKwh;
  view.chargers[0].requiredGridKwh -= 2;
  view.chargers[0].progress = { creditedGridKwh: 2, remainingGridKwh: view.chargers[0].requiredGridKwh,
    basis: { source: 'integrated-measured-power', lastMeasuredAt: snapshotAt - 10_000 } };
  const { app, root, digest, originalDigest, advance } = await fixture(t, { version: 6, chargers: {
    charger1: { association: 'synthetic-association', plan }, charger2: { automaticSoc: null, plan: null },
  }, view }, ownership);
  const status = await (await fetch(`${root}/api/status`)).json();
  assert.equal(status.role, 'slave');
  assert.equal(status.input, 'mqtt', 'Charging scope follows the primary recorded input, not the viewer configuration');
  assert.equal(status.sync.state, 'stale');
  assert.equal(status.charging.readOnly, true);
  assert.equal(status.charging.snapshotAt, snapshotAt);
  assert.deepEqual(status.charging.settings, settings);
  assert.deepEqual(status.charging.controls, view.controls);
  const [charger1, charger2] = status.charging.chargers;
  assert.deepEqual(charger1.controls, { enabled: true, revision: 3 });
  assert.deepEqual(charger1.plan, plan);
  assert.deepEqual(charger1.control.owned, owned);
  assert.equal(charger1.control.phase, 'waiting');
  assert.equal(charger1.control.snapshot, null);
  assert.equal(charger1.control.released, false, 'Elapsed viewer time never releases a saved charging plan');
  assert.equal(charger1.values.soc.source, 'mqtt', 'SoC source is resolved at the source snapshot boundary');
  assert.equal(charger1.values.soc.value, 32);
  assert.equal(charger1.configuration.efficiency, .925, 'The current viewer must not replace a recorded primary energy assumption');
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
  charger.targetSelection = { connectedAt: snapshotAt - 5 * 60_000, conflict: true,
    raw: { value: 100, measuredAt: snapshotAt - 1000, receivedAt: snapshotAt - 500, readingId: 'raw-target' },
    lower: { value: 95, measuredAt: snapshotAt - 60_000, receivedAt: snapshotAt - 30_000, readingId: 'held-target' },
    selected: { value: 95, source: 'bmw-target-filter', measuredAt: snapshotAt - 60_000, receivedAt: snapshotAt - 30_000, readingId: 'held-target' } };
  charger.automaticSoc.chargeLimitSoc = 100;
  charger.automatic.minimumSoc.value = 100;
  charger.values.minimumSoc = { ...charger.values.minimumSoc, ...charger.targetSelection.selected };
  charger.sessionCost = { totalCents: 123, incurredCents: 73, remainingCents: 50 };
  charger.progress = { estimatedSoc: 89, creditedGridKwh: 3.5, hasEnergyEstimate: true };
  charger.vehicleMqtt = { provider: 'bmw-cardata', brokerConnected: true, subscribed: true, lastLiveAt: snapshotAt - 30_000 };
  const feed = { id: 'bmw', label: 'BMW', provider: 'bmw-cardata', topic: 'stmq/vehicles/bmw',
    usedByChargerId: 'charger1', reception: charger.vehicleMqtt };
  const { app, root, digest, originalDigest, advance } = await fixture(t, { version: 6,
    vehicleFeeds: { bmw: { reading: automaticSoc } }, chargers: { charger1: {}, charger2: {} },
    view: { settings, chargers: [charger, buildCharger({definition:CHARGER_DEFINITIONS[1], settings:settings.chargers.charger2, now:snapshotAt})], vehicleFeeds: [feed] } });
  const charging = app.status().charging, actual = charging.chargers[0];
  for (const key of ['vehicle', 'values', 'automatic', 'automaticSoc', 'targetSelection', 'sessionCost', 'progress', 'configuration'])
    assert.deepEqual(actual[key], charger[key], `${key} remains the primary's published value`);
  assert.equal(actual.vehicleMqtt.brokerConnected, null);
  assert.equal(actual.vehicleMqtt.subscribed, null);
  assert.equal(actual.vehicleMqtt.lastLiveAt, feed.reception.lastLiveAt);
  assert.equal(charging.vehicleFeeds[0].usedByChargerId, 'charger1');
  assert.equal(charging.vehicleFeeds[0].label, 'BMW');
  assert.equal(charging.vehicleFeeds[0].topic, feed.topic);
  assert.equal(charging.vehicleFeeds[0].reception.brokerConnected, null);
  advance(); assert.deepEqual(app.status().charging, charging);
  const denied = await fetch(`${root}/api/charging/chargers/charger1/settings`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'session', association: 'synthetic-association', sessionId: 'synthetic-session',
      revision: 1, changes: { minimumSoc: 100 } }) });
  assert.equal(denied.status, 405);
  assert.equal(digest(), originalDigest);
});

test('replica rejects unsupported development charging payloads', async t => {
  const { app, root, digest, originalDigest } = await fixture(t, { version: 5, settings: chargingSettings(), chargers: {} });
  const status = app.status();
  assert.equal(status.charging.available, false);
  assert.equal(status.charging.settings, null);
  assert.deepEqual(status.charging.chargers, []);
  assert.match(status.charging.error, /saved charging data is unavailable/);
  assert.equal(status.readOnly, true);
  const response = await fetch(`${root}/api/status`);
  assert.equal(response.status, 200, 'Invalid charging preferences do not break the protected dashboard');
  assert.deepEqual((await response.json()).charging.chargers, []);
  assert.equal(digest(), originalDigest);
});

test('replica rejects retired BMW target state and selection shapes without altering the snapshot', async t => {
  const settings = chargingSettings();
  const fact = { value: 85, measuredAt: snapshotAt, receivedAt: snapshotAt, readingId: 'target-85' };
  for (const kind of ['state', 'selection']) await t.test(kind, async t => {
    const chargers = CHARGER_DEFINITIONS.map(definition => buildCharger({ definition,
      settings: settings.chargers[definition.id], now: snapshotAt }));
    const state = { version: 6, chargers: { charger1: {} }, view: { settings, chargers } };
    if (kind === 'state') state.chargers.charger1.targetState = {
      connectedAt: snapshotAt, history: [fact], conflict: false, lower: fact, last: fact, override: null };
    else chargers[0].targetSelection = { connectedAt: snapshotAt, conflict: false, lower: fact,
      raw: fact, selected: { ...fact, source: 'bmw-cardata' }, mode: 'automatic' };
    const { app, digest, originalDigest } = await fixture(t, state);
    const status = app.status();
    assert.equal(status.charging.available, false);
    assert.equal(status.charging.settings, null);
    assert.deepEqual(status.charging.chargers, []);
    assert.match(status.charging.error, /saved charging data is unavailable/);
    assert.equal(status.readOnly, true);
    assert.equal(digest(), originalDigest);
  });
});

test('replica rejects a current snapshot missing its recorded configuration instead of inventing defaults', async t => {
  const settings = chargingSettings();
  const { app, digest, originalDigest } = await fixture(t, { version: 6, chargers: {}, view: {
    chargers: CHARGER_DEFINITIONS.map(definition => buildCharger({ definition,
      settings: settings.chargers[definition.id], now: snapshotAt })),
  } });
  const status = app.status();
  assert.equal(status.charging.available, false);
  assert.equal(status.charging.settings, null);
  assert.deepEqual(status.charging.chargers, []);
  assert.match(status.charging.error, /saved charging data is unavailable/);
  assert.equal(digest(), originalDigest);
});

test('replica preserves recorded charging assessments while withdrawing live evidence and test authority', async t => {
  const settings = chargingSettings(), outcome = { state: 'target-confirmed', at: snapshotAt - 60_000, basis: 'vehicle-reading' };
  const current = { id: 'recorded-session', chargerId: 'charger1', startedAt: snapshotAt - 3600_000,
    observedAt: snapshotAt, evaluatedAt: snapshotAt, endedAt: null, behavior: 'expected', evidenceStale: false,
    outcome, current: { physicalFresh: true, charging: false }, findings: [], coverage: { targetAttainment: { state: 'verified', at: outcome.at } },
    plans: [{ at: snapshotAt - 3600_000, periods: [{ startAt: snapshotAt - 1800_000, endAt: null }] }], timeline: [] };
  const finished = { ...structuredClone(current), id: 'earlier-session', endedAt: snapshotAt - 600_000 };
  const run = { id: 'recorded-test', chargerId: 'charger1', vehicleId: 'bmw', phase: 'observing',
    deadlineAt: snapshotAt + 60_000, updatedAt: snapshotAt, findings: [], milestones: {}, report: { id: current.id } };
  const feed = { id: 'bmw', provider: 'bmw-cardata', reception: { available: true, connected: true },
    setup: { available: true, fields: { soc: { value: 80, available: true, measuredAt: snapshotAt - 1000 },
      atHome: { value: true, available: true, measuredAt: snapshotAt - 1000 } } } };
  const { app, root, digest, originalDigest, advance } = await fixture(t, { version: 6, chargers: {}, view: {
    settings, chargers: CHARGER_DEFINITIONS.map(definition => buildCharger({ definition,
      settings: settings.chargers[definition.id], now: snapshotAt })), vehicleFeeds: [feed],
    diagnostics: { version: 1, chargers: [{ id: 'charger1', current, recent: [finished] }] },
    physicalTests: { version: 1, canManage: true, runs: [run] },
  } });
  const before = app.status().charging, projected = before.diagnostics.chargers[0];
  assert.deepEqual(projected.current.outcome, outcome);
  assert.equal(projected.current.behavior, 'expected', 'Recorded assessment is not reinterpreted by the viewer');
  assert.equal(projected.current.evaluatedAt, snapshotAt);
  assert.equal(projected.current.evidenceStale, true);
  assert.equal(projected.current.recorded, true);
  assert.equal(projected.current.liveAvailable, false);
  assert.deepEqual(projected.current.current, current.current, 'Physical facts remain explicitly recorded rather than overwritten');
  assert.equal(projected.recent[0].evidenceStale, false, 'An ended report retains its historical conclusion');
  assert.deepEqual(projected.current.plans, current.plans);
  assert.equal(before.physicalTests.canManage, false);
  assert.equal(before.physicalTests.runs[0].phase, 'observing');
  assert.equal(before.physicalTests.runs[0].recorded, true);
  assert.equal(before.physicalTests.runs[0].liveAvailable, false);
  assert.equal(before.vehicleFeeds[0].setup.available, false);
  assert.equal(before.vehicleFeeds[0].setup.fields.soc.available, false);
  assert.equal(before.vehicleFeeds[0].setup.fields.soc.value, 80);
  assert.equal(before.vehicleFeeds[0].reception.available, false);
  advance(); assert.deepEqual(app.status().charging, before, 'Elapsed viewer time never completes a physical test');
  for (const action of ['preview', 'start', 'schedule', 'cancel']) {
    const denied = await fetch(`${root}/api/charging/tests/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 405);
  }
  assert.equal(digest(), originalDigest);
});

test('replica rejects unsupported assessment versions without altering publication', async t => {
  const settings = chargingSettings();
  for (const type of ['diagnostics', 'physicalTests']) await t.test(type, async t => {
    const { app, digest, originalDigest } = await fixture(t, { version: 6, chargers: {}, view: {
      settings, chargers: CHARGER_DEFINITIONS.map(definition => buildCharger({ definition,
        settings: settings.chargers[definition.id], now: snapshotAt })),
      [type]: type === 'diagnostics' ? { version: 0, chargers: [] } : { version: 0, runs: [] },
    } });
    assert.equal(app.status().charging.available, false);
    assert.equal(digest(), originalDigest);
  });
});
