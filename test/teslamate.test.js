import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createTeslaMateCapture, decodeTeslaMateField } from '../src/acquisition/teslamate.js';

const initial = Date.parse('2026-01-01T12:00:00Z');
function setup(t, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-teslamate-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = initial;
  const recorder = new Recorder(store, { clock: () => now });
  const engine = { recorder, clock: () => now, electricitySnapshot: {} };
  let capture = createTeslaMateCapture({ engine, store, settings });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const fixture = { store, recorder, engine, get capture() { return capture; }, get now() { return now; },
    at: ms => { now = initial + ms; }, tick: () => capture.tick(now),
    send: (field, value, retained = false) => capture.receive(`${capture.topic.slice(0, -1)}${field}`, Buffer.from(String(value)), { retain: retained }, now),
    restart: () => { capture = createTeslaMateCapture({ engine, store, settings }); capture.setConnected(true, now); },
    energy: () => { recorder.flush(now, { force: true }); return store.db.prepare("SELECT COALESCE(SUM(value),0) n FROM observations WHERE source='teslamate' AND signal='ev2_energy'").get().n; },
    checks: () => store.db.prepare("SELECT payload FROM events WHERE type='charging-session-check' ORDER BY id").all().map(row => JSON.parse(row.payload)),
    property: (powerKw, sourceTime = now) => { engine.electricitySnapshot.property = { powerKw, sourceTime, receivedAt: now }; },
    easee: (powerKw, sourceTime = now) => { engine.electricitySnapshot.charger = { powerKw, sourceTime, receivedAt: now, device: 'invented-charger' }; },
  };
  capture.setConnected(true, now);
  return fixture;
}
function begin(f, { retained = false, since = f.now } = {}) {
  f.send('charging_state', 'Disconnected', retained);
  f.send('geofence', 'Home', retained);
  f.send('healthy', true, retained);
  f.send('charge_energy_added', 0, retained);
  f.send('since', new Date(since).toISOString(), retained);
  f.send('state', 'charging', retained);
  f.send('charging_state', 'Charging', retained);
  f.send('charger_power', 11, retained);
  f.tick();
}

test('steady changed-only MQTT power becomes scalar energy and one terminal session reference', t => {
  const f = setup(t); begin(f);
  for (let index = 1; index <= 8; index++) {
    f.at(index * 15_000); f.send('healthy', true); f.send('charge_energy_added', index * 0.04); f.tick();
  }
  f.send('charging_state', 'Complete');
  f.at(125_000); f.send('charge_energy_added', 0.33);
  f.at(166_000); f.tick(); f.tick();
  assert(Math.abs(f.energy() - 11 * 120 / 3600) < 1e-10);
  assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0].referenceKwh, 0.33);
  assert.equal(f.checks()[0].complete, true);
  assert(Math.abs(f.checks()[0].estimatedKwh - f.energy()) < 1e-10);
  assert.deepEqual(f.store.db.prepare("SELECT DISTINCT signal FROM observations WHERE source='teslamate'").all().map(row => row.signal), ['ev2_energy']);
  assert.equal(f.capture.receive('teslamate/cars/2/charger_power', '100'), false);
  assert.equal(f.capture.receive('teslamate/cars/1/charger_actual_current', '16'), true);
});

test('retained state and a healthy heartbeat cannot by themselves start charging energy', t => {
  const f = setup(t); begin(f, { retained: true });
  f.at(60_000); f.tick(); f.send('healthy', true); f.tick();
  assert.equal(f.energy(), 0);
  f.at(70_000); f.send('charge_energy_added', 0.2); f.tick();
  f.at(80_000); f.tick();
  assert(Math.abs(f.energy() - 11 * 10 / 3600) < 1e-10, 'Only live-evidence coverage after startup contributes');
});

test('connection status distinguishes retained startup from live charging and expires before the maintenance tick', t => {
  const f = setup(t, { max_age_seconds: 30 });
  assert.equal(f.capture.status().reason, 'awaiting-readings');
  begin(f, { retained: true });
  assert.equal(f.capture.status().reason, 'awaiting-health');
  f.send('healthy', true);
  assert.equal(f.capture.status().reason, 'awaiting-charging-evidence');
  f.send('charger_power', 11); f.tick();
  assert.equal(f.capture.status().status, 'ok');
  assert.equal(f.capture.status().recording, true);
  const checkpoint = f.store.getState('teslamate:acquisition:1');
  f.at(31_000);
  assert.equal(f.capture.status().status, 'degraded');
  assert.equal(f.capture.status().reason, 'teslamate-stale');
  assert.equal(f.capture.status().recording, false);
  assert.equal(f.capture.status().maxAgeMs, 30_000);
  assert.deepEqual(f.capture.status().freshnessChecks, [
    { key: 'vehicle-health', at: initial, maxAgeMs: 30_000 },
    { key: 'charging-evidence', at: initial, maxAgeMs: 30_000 },
  ]);
  assert.deepEqual(f.store.getState('teslamate:acquisition:1'), checkpoint, 'Reading status never saves new acquisition state');
  f.capture.setConnected(false);
  assert.equal(f.capture.status().reason, 'mqtt-disconnected');
  assert.equal(f.capture.status().lastMessageAt, null);
});

test('idle, asleep and away status does not require changing charging evidence', t => {
  const f = setup(t, { max_age_seconds: 30 });
  f.send('healthy', true); f.send('state', 'asleep');
  f.at(120_000);
  assert.equal(f.capture.status().status, 'ok');
  assert.equal(f.capture.status().reason, 'not-charging');
  f.send('geofence', 'Invented away location'); f.send('state', 'charging');
  assert.equal(f.capture.status().status, 'ok');
  assert.equal(f.capture.status().reason, 'away-or-unknown-location');
  f.send('healthy', false);
  assert.equal(f.capture.status().status, 'degraded');
  assert.equal(f.capture.status().reason, 'teslamate-unhealthy');
});

test('connection status exposes only safe descriptors and explains Charger 1 assignment', t => {
  const f = setup(t, { charger_assignment: 'easee', namespace: 'invented-private-namespace', home_geofence: 'Invented home geofence' });
  begin(f); f.send('geofence', 'Invented home geofence'); f.tick();
  const status = f.capture.status();
  assert.equal(status.reason, 'assigned-to-easee');
  assert.equal(status.recording, false);
  assert.deepEqual(Object.keys(status).sort(), ['charging', 'connected', 'freshnessChecks', 'healthy', 'home', 'lastMessageAt', 'maxAgeMs', 'reason', 'recording', 'sessionOpen', 'status', 'suppressed']);
  assert(!JSON.stringify(status).includes('invented-private-namespace'));
  assert(!JSON.stringify(status).includes('Invented home geofence'));
});

test('stale Tesla diagnostics name the required expired evidence even when unrelated messages arrive', t => {
  const f = setup(t, { max_age_seconds: 30 }); begin(f);
  f.at(30_000);
  assert.equal(f.capture.status().reason, 'recording', 'The exact freshness limit is inclusive');
  f.at(30_001); f.send('healthy', true);
  assert.equal(f.capture.status().lastMessageAt, f.now);
  assert.deepEqual(f.capture.status().freshnessChecks, [
    { key: 'charging-evidence', at: initial, maxAgeMs: 30_000 },
  ], 'A fresh health message cannot renew charging evidence');
  f.send('charger_power', 11);
  assert.deepEqual(f.capture.status().freshnessChecks, []);
  f.at(60_002); f.send('charger_power', 11);
  assert.deepEqual(f.capture.status().freshnessChecks, [
    { key: 'vehicle-health', at: initial + 30_001, maxAgeMs: 30_000 },
  ], 'A fresh charging message cannot renew vehicle health');
});

test('fresh comparable property impossibility suspends immediately and house load cannot revive stale Tesla power', t => {
  const f = setup(t); begin(f);
  f.at(10_000); f.property(13); f.tick();
  const before = f.energy();
  f.at(20_000); f.property(2); f.tick();
  assert.equal(f.capture.status().suppressed, 'property-power-impossible');
  assert.equal(f.capture.status().status, 'degraded');
  assert.equal(f.capture.status().reason, 'property-power-impossible');
  assert.equal(f.energy(), before);
  f.at(30_000); f.property(15); f.send('healthy', true); f.send('charge_energy_added', 0.2); f.tick();
  assert.equal(f.energy(), before);
  f.at(40_000); f.send('charger_power', 2); f.tick();
  assert.equal(f.capture.status().suppressed, 'property-power-impossible');
  f.at(50_000); f.property(4); f.tick();
  f.at(60_000); f.property(4); f.tick();
  assert.equal(f.capture.status().suppressed, null);
  assert(f.energy() > before);
});

test('a property reading before the current Tesla ramp does not falsely stop charging', t => {
  const f = setup(t); begin(f);
  f.at(10_000); f.property(2, initial); f.tick();
  assert.equal(f.capture.status().suppressed, null);
  assert(f.energy() > 0);
});

test('two simultaneous cars count separately when property accommodates both; impossible matching overlap suppresses Tesla', t => {
  const f = setup(t); begin(f);
  f.at(10_000); f.property(25); f.easee(11); f.tick();
  const before = f.energy(); assert(before > 0);
  f.at(20_000); f.property(13); f.easee(11); f.tick();
  assert.equal(f.capture.status().suppressed, 'duplicate-suspected');
  assert.equal(f.energy(), before);
});

test('disconnect and restart recover the session accumulator without bridging gaps or replaying energy', t => {
  const f = setup(t); begin(f);
  f.at(20_000); f.tick(); const before = f.energy();
  f.capture.setConnected(false, f.now);
  f.at(120_000); f.restart(); begin(f, { retained: true, since: initial });
  f.send('healthy', true); f.tick(); assert.equal(f.energy(), before);
  f.at(130_000); f.send('charge_energy_added', 0.5); f.tick();
  f.at(140_000); f.tick(); f.tick();
  assert(Math.abs(f.energy() - before - 11 * 10 / 3600) < 1e-10);
  f.send('charge_energy_added', 0.53); f.send('charging_state', 'Complete'); f.at(190_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
  assert(f.checks()[0].quality.includes('disconnected'));
});

test('fresh heartbeat alone cannot hold charging forever without power or energy progress', t => {
  const f = setup(t, { max_age_seconds: 30 }); begin(f);
  f.at(10_000); f.tick(); const before = f.energy();
  f.at(40_000); f.send('healthy', true); f.tick();
  assert.equal(f.energy(), before);
  f.at(70_000); f.send('healthy', true); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
});

test('invalid values and unknown raw fields cannot become energy input', () => {
  for (const value of ['', '-1', 'NaN', 'Infinity', '{}', '351']) assert.equal(decodeTeslaMateField('charger_power', value), null);
  assert.equal(decodeTeslaMateField('charger_power', '11'), 11);
  assert.equal(decodeTeslaMateField('since', '2026-01-01 12:00:00'), null);
  assert.equal(decodeTeslaMateField('charger_actual_current', '16'), 16);
  assert.equal(decodeTeslaMateField('charger_actual_current', '101'), null);
});

test('only exact Home geofence records; unknown or away charging is excluded', t => {
  const f = setup(t); begin(f);
  f.at(10_000); f.tick(); const homeEnergy = f.energy();
  f.send('geofence', 'Away');
  f.at(20_000); f.tick(); f.at(70_000); f.tick();
  assert.equal(f.energy(), homeEnergy);
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
  f.send('geofence', 'home'); f.send('charger_power', 12); f.at(80_000); f.tick();
  assert.equal(f.energy(), homeEnergy, 'Geofence matching is case-sensitive');
  f.send('geofence', ''); f.at(90_000); f.tick();
  assert.equal(f.energy(), homeEnergy);
});

test('explicit Easee assignment counts no Tesla energy and uses covered Easee energy for session check', t => {
  const f = setup(t, { charger_assignment: 'easee' }); f.easee(11); begin(f);
  f.at(60_000); f.send('charge_energy_added', 0.17); f.tick(); f.send('charging_state', 'Complete');
  f.recorder.recordEnergy({ source: 'easee', device: 'invented-charger', prefix: 'ev1', start: initial, end: f.now,
    energies: [0.06, 0.06, 0.06], powers: [3.6, 3.6, 3.6], quality: ['estimated'] });
  f.at(110_000); f.tick();
  assert.equal(f.energy(), 0); assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0].estimatedKwh, 0.18); assert.equal(f.checks()[0].referenceKwh, 0.17);
  assert.equal(f.checks()[0].complete, true);
});

test('recorder and acquisition cursor roll back together, so retry counts an interval exactly once', t => {
  const f = setup(t); begin(f);
  f.at(10_000);
  const original = f.store.setState.bind(f.store);
  let reject = true;
  f.store.setState = (key, value) => {
    if (reject && key.startsWith('teslamate:acquisition:')) { reject = false; throw new Error('Synthetic transaction failure'); }
    return original(key, value);
  };
  assert.throws(() => f.tick(), /Synthetic/);
  f.tick(); f.tick();
  assert(Math.abs(f.energy() - 11 * 10 / 3600) < 1e-10);
});

test('restart without any subsequent Tesla publication finalizes the interrupted session as incomplete', t => {
  const f = setup(t, { max_age_seconds: 30 }); begin(f);
  f.at(10_000); f.tick();
  f.at(20_000); f.restart();
  f.at(80_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
  assert(f.checks()[0].quality.includes('missing-end'));
});

test('new charging since after restart cannot merge the previous session reference and energy', t => {
  const f = setup(t); begin(f);
  f.at(20_000); f.send('charge_energy_added', 0.05); f.tick();
  const before = f.energy();
  f.at(120_000); f.restart();
  // Retained messages have independent order; since can precede charging state.
  f.send('since', new Date(f.now).toISOString(), true);
  f.send('geofence', 'Home', true); f.send('charging_state', 'Charging', true);
  f.send('charger_power', 11, true); f.send('charge_energy_added', 0.2, true);
  f.send('healthy', true); f.send('charge_energy_added', 0.21); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].referenceKwh, 0.05);
  assert(Math.abs(f.checks()[0].estimatedKwh - before) < 1e-10);
  f.at(140_000); f.send('charge_energy_added', 0.27); f.send('charging_state', 'Complete');
  f.at(190_000); f.tick();
  assert.equal(f.checks().length, 2); assert.equal(f.checks()[1].referenceKwh, 0.27);
});

test('a terminal zero counter keeps the last reference, with either packet ordering', async t => {
  for (const order of ['counter-first', 'state-first']) await t.test(order, t => {
    const f = setup(t); begin(f);
    f.at(60_000); f.send('charge_energy_added', 0.17); f.tick();
    if (order === 'counter-first') { f.send('charge_energy_added', 0); f.send('charging_state', 'Complete'); }
    else { f.send('charging_state', 'Complete'); f.send('charge_energy_added', 0); }
    f.at(110_000); f.tick();
    assert.equal(f.checks().length, 1);
    assert.equal(f.checks()[0].referenceKwh, 0.17);
    assert.equal(f.checks()[0].complete, true);
    assert(!f.checks()[0].quality.includes('counter-reset'));
  });
});

test('a reset with no terminal state closes the old session as incomplete before new energy is counted', t => {
  const f = setup(t); begin(f);
  f.at(60_000); f.send('charge_energy_added', 0.17); f.tick(); const before = f.energy();
  f.send('charge_energy_added', 0);
  f.at(70_000); f.send('charge_energy_added', 0.02); f.tick();
  assert.equal(f.energy(), before, 'No energy is extended across an unresolved reset');
  f.at(80_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].referenceKwh, 0.17);
  assert.equal(f.checks()[0].complete, false); assert(f.checks()[0].quality.includes('counter-reset'));
  f.at(90_000); f.tick();
  f.at(100_000); f.send('charge_energy_added', 0.1); f.send('charging_state', 'Complete');
  f.at(150_000); f.tick();
  assert.equal(f.checks().length, 2); assert.equal(f.checks()[1].referenceKwh, 0.1);
  assert.equal(f.checks()[1].complete, false);
});

test('normal-cadence final counter arrives after stop and is processed before finalization', t => {
  const f = setup(t); begin(f);
  f.at(40_000); f.send('charge_energy_added', 0.1);
  f.at(60_000); f.send('charging_state', 'Complete');
  f.at(80_000); f.tick(); assert.equal(f.checks().length, 0);
  f.send('charge_energy_added', 0.17);
  f.at(110_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].referenceKwh, 0.17);
  assert.equal(f.checks()[0].complete, true);
});

test('missing terminal counter cannot be averaged as a complete session using an old reference', t => {
  const f = setup(t); begin(f);
  f.at(30_000); f.send('charge_energy_added', 0.09);
  f.at(60_000); f.send('charging_state', 'Complete');
  f.at(110_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
  assert(f.checks()[0].quality.includes('missing-final-reference'));
});

test('new charging start waits for its own reference instead of opening a fake session from the old counter', t => {
  const f = setup(t); begin(f);
  f.at(60_000); f.send('charge_energy_added', 0.17); f.send('charging_state', 'Complete');
  f.at(110_000); f.tick();
  f.at(120_000); f.send('since', new Date(f.now).toISOString()); f.send('healthy', true);
  f.send('charging_state', 'Charging'); f.send('charger_power', 11); f.tick();
  assert.equal(f.capture.status().sessionOpen, false, 'The preceding 0.17 kWh is not this session baseline');
  f.at(125_000); f.send('charge_energy_added', 0); f.tick();
  f.at(130_000); f.send('charge_energy_added', 0.04); f.tick();
  f.at(180_000); f.send('charge_energy_added', 0.17); f.send('charging_state', 'Complete');
  f.at(230_000); f.tick();
  assert.equal(f.checks().length, 2);
  assert.equal(f.checks()[1].start, initial + 125_000);
  assert.equal(f.checks()[1].end, initial + 180_000);
  assert.equal(f.checks()[1].referenceKwh, 0.17);
});

test('new online logger state overrides held Charging even if the charging-state stop packet is missing', t => {
  const f = setup(t); begin(f);
  f.at(60_000); f.send('charge_energy_added', 0.17); f.send('state', 'online'); f.send('since', new Date(f.now).toISOString());
  f.at(110_000); f.tick(); const endedEnergy = f.energy();
  f.at(120_000); f.send('healthy', true); f.tick();
  f.at(130_000); f.tick();
  assert.equal(f.capture.status().charging, false);
  assert.equal(f.capture.status().sessionOpen, false);
  assert.equal(f.energy(), endedEnergy);
  assert.equal(f.checks().length, 1);
});

test('an inferred impossible-power pause can resume the same session after a long pause on fresh compatible Tesla power', t => {
  const f = setup(t, { max_age_seconds: 30 }); begin(f);
  f.at(10_000); f.property(2); f.tick();
  f.at(100_000); f.tick(); assert.equal(f.checks().length, 0);
  f.send('healthy', true); f.send('charger_power', 2);
  f.at(110_000); f.property(4); f.tick();
  f.at(120_000); f.tick();
  assert(f.energy() > 0); assert.equal(f.capture.status().suppressed, null);
  f.send('charge_energy_added', 0.1); f.send('charging_state', 'Complete');
  f.at(170_000); f.tick();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].complete, false);
});

function identificationFixture(t) {
  const f = setup(t, { charger_identification: true });
  const status = { active: false, assignmentPending: true, phase: 'baseline', verdict: null, pauseExpected: false };
  f.engine.chargerIdentification = { status: () => ({ ...status }) };
  f.property(25); f.easee(11); begin(f);
  return { f, status };
}

test('unknown overlap buffers ordinary intervals in memory, then records them once for Charger 2', t => {
  const { f, status } = identificationFixture(t);
  for (let n = 1; n <= 4; n++) {
    f.at(n * 15_000); f.property(25); f.easee(11);
    f.send('healthy', true); f.send('charge_energy_added', n * 0.04); f.tick();
  }
  assert.equal(f.energy(), 0);
  assert.equal(f.capture.status().reason, 'charger-identification-pending');
  assert.equal(f.capture.status().recording, false);
  const checkpoint = f.store.getState('teslamate:acquisition:1');
  assert.equal(checkpoint.session.assignment, 'auto');
  assert.equal(checkpoint.session.estimatedKwh, 0);
  assert.equal(checkpoint.suppression, null);
  for (const word of ['baseline', 'verdict', 'pendingEnergy', 'targetAmps', 'identification'])
    assert(!JSON.stringify(checkpoint).includes(word));
  Object.assign(status, { assignmentPending: false, verdict: 'other', phase: 'identified' });
  f.tick(); f.tick();
  assert(Math.abs(f.energy() - 11 * 60 / 3600) < 1e-10);
  assert.equal(f.capture.status().reason, 'recording');
  assert.deepEqual(f.store.db.prepare("SELECT DISTINCT signal FROM observations WHERE source='teslamate' AND value IS NOT NULL").all().map(row => row.signal), ['ev2_energy']);
});

test('identifying Charger 1 discards ambiguous duplicate energy and creates no Charger 2 session check', t => {
  const { f, status } = identificationFixture(t);
  f.at(30_000); f.send('healthy', true); f.send('charge_energy_added', 0.08); f.tick();
  Object.assign(status, { verdict: 'easee', assignmentPending: false, phase: 'identified' });
  f.tick(); f.at(60_000); f.send('healthy', true); f.send('charge_energy_added', 0.16); f.tick();
  f.send('charging_state', 'Complete');
  // The connection verdict can be forgotten before the ordinary terminal settle.
  status.verdict = null;
  f.at(110_000); f.tick();
  assert.equal(f.energy(), 0); assert.equal(f.checks().length, 0);
  const text = f.store.db.prepare('SELECT value FROM state').all().map(row => row.value).join('\n');
  for (const word of ['matching-drop', 'targetAmps', 'pauseExpected', 'pendingEnergy', 'sessionAssignment']) assert(!text.includes(word));
});

test('owned pause preserves a session through stopped, online, changed since and counter reset', t => {
  const { f, status } = identificationFixture(t);
  f.at(20_000); f.send('charge_energy_added', 0.05); f.tick();
  Object.assign(status, { active: true, pauseExpected: true, settlingUntil: initial + 200_000 });
  f.at(25_000); f.send('charger_power', 0); f.send('charging_state', 'Stopped'); f.send('state', 'online');
  f.send('since', new Date(f.now).toISOString()); f.send('charge_energy_added', 0);
  f.at(85_000); f.send('healthy', true); f.tick();
  assert.equal(f.checks().length, 0); assert.equal(f.capture.status().sessionOpen, true);
  f.at(90_000); f.send('charging_state', 'Charging'); f.send('state', 'charging');
  f.send('since', new Date(f.now).toISOString()); f.send('charger_power', 11); f.send('charge_energy_added', 0.02);
  f.at(100_000); f.send('healthy', true); f.property(25); f.easee(11);
  Object.assign(status, { active: false, pauseExpected: false, settlingUntil: null, verdict: 'other', assignmentPending: false });
  f.tick(); assert.equal(f.checks().length, 0);
  f.at(110_000); f.send('charge_energy_added', 0.05); f.send('charging_state', 'Complete');
  f.at(160_000); f.tick();
  assert.equal(f.checks().length, 1);
  assert(Math.abs(f.checks()[0].referenceKwh - 0.1) < 1e-10);
  assert(!f.checks()[0].quality.includes('counter-reset'));
  assert(!f.checks()[0].quality.includes('missing-end'));
});

test('actual disconnection still ends a session during an owned pause and restart loses identification', t => {
  const { f, status } = identificationFixture(t);
  f.at(10_000); Object.assign(status, { active: true, pauseExpected: true, settlingUntil: initial + 200_000 });
  f.send('charger_power', 0); f.send('charging_state', 'Disconnected');
  f.at(70_000); f.tick();
  assert.equal(f.capture.status().sessionOpen, false);
  assert.equal(f.checks().length, 1);
  f.engine.chargerIdentification = null;
  f.restart(); begin(f, { since: f.now }); f.at(90_000); f.tick();
  assert.equal(f.energy(), 0, 'No verdict or deferred intervals survive restart');
});

test('current used by identification stays in RAM and retained values carry no live timestamp', t => {
  const f = setup(t); begin(f, { retained: true });
  f.send('charger_actual_current', 16, true);
  assert.equal(f.capture.identificationSnapshot().currentA, 16);
  assert.equal(f.capture.identificationSnapshot().currentAt, null);
  f.at(10_000); f.send('charger_actual_current', 10);
  assert.equal(f.capture.identificationSnapshot().currentAt, f.now);
  assert(!f.store.db.prepare("SELECT 1 FROM observations WHERE signal LIKE '%current%' AND source='teslamate'").get());
});

test('passive guardrail rejects 22 kW chargers against 12 kW property with supported held Easee readings', t => {
  const f = setup(t); begin(f);
  const held = powerKw => ({ powerKw, sourceTime: initial - 8 * 60_000, receivedAt: f.now,
    telemetryAt: initial - 20_000, telemetryConfirmed: true, device: 'invented-charger' });
  f.at(10_000); f.engine.electricitySnapshot = { property: held(12), charger: held(11) }; f.tick();
  assert.equal(f.capture.status().suppressed, null, 'A new Tesla value gets bounded settling time');
  f.at(25_000); f.engine.electricitySnapshot = { property: held(12), charger: held(11) }; f.tick();
  const before = f.energy();
  assert.equal(f.capture.status().suppressed, 'duplicate-suspected');
  f.at(40_000); f.send('healthy', true); f.send('charge_energy_added', 0.12); f.tick();
  assert.equal(f.energy(), before);
});

test('supported held property power also stops an impossible Tesla value by itself', t => {
  const f = setup(t); begin(f);
  f.at(25_000);
  f.engine.electricitySnapshot.property = { powerKw: 2, sourceTime: initial - 120_000,
    receivedAt: f.now, telemetryAt: initial, telemetryConfirmed: true };
  f.tick();
  assert.equal(f.capture.status().suppressed, 'property-power-impossible');
});

test('deferred energy survives a failed flush in RAM and retry commits it exactly once', t => {
  const { f, status } = identificationFixture(t);
  f.at(30_000); f.send('healthy', true); f.send('charge_energy_added', 0.08); f.tick();
  const original = f.store.observation.bind(f.store);
  f.store.observation = () => { throw new Error('invented write failure'); };
  Object.assign(status, { verdict: 'other', assignmentPending: false });
  assert.throws(() => f.tick(), /invented write failure/);
  f.store.observation = original;
  assert.equal(f.store.getState('teslamate:acquisition:1').session.estimatedKwh, 0);
  f.tick(); f.tick();
  assert(Math.abs(f.energy() - 11 * 30 / 3600) < 1e-10);
});

test('unresolved buffering is bounded and a lost verdict never continues counting both chargers', t => {
  const { f, status } = identificationFixture(t);
  for (let n = 1; n <= 18; n++) {
    f.at(n * 15_000); f.property(25); f.easee(11);
    f.send('healthy', true); f.send('charge_energy_added', n * 0.04); f.tick();
  }
  assert.equal(f.energy(), 0);
  assert.equal(f.store.getState('teslamate:acquisition:1').session.complete, false);
  Object.assign(status, { verdict: 'other', assignmentPending: false }); f.tick();
  const before = f.energy(); assert(before < 11 * 60 / 3600, 'Expired unresolved coverage was discarded');
  Object.assign(status, { verdict: null, assignmentPending: true });
  f.at(285_000); f.send('healthy', true); f.send('charge_energy_added', 0.8); f.tick();
  assert.equal(f.energy(), before, 'Historical session attribution cannot override a revoked live verdict');
});

test('Charger 1 becoming idle cannot release preceding ambiguous overlap as Charger 2 energy', t => {
  const { f, status } = identificationFixture(t);
  f.at(30_000); f.send('healthy', true); f.send('charge_energy_added', 0.08); f.tick();
  f.at(60_000); f.property(15); f.easee(0);
  Object.assign(status, { assignmentPending: false, phase: 'inconclusive' });
  f.tick();
  assert.equal(f.energy(), 0, 'Earlier ambiguous intervals require a positive Charger 2 verdict');
  assert.equal(f.store.getState('teslamate:acquisition:1').session.complete, false);
  f.at(70_000); f.send('charger_power', 11); f.send('healthy', true); f.send('charge_energy_added', 0.12); f.tick();
  assert(f.energy() <= 11 * 10 / 3600 + 1e-10, 'Only coverage after Charger 1 stopped can subsequently count');
});

test('a transient zero during an owned pause never doubles a continuing Tesla counter', t => {
  const { f, status } = identificationFixture(t);
  f.at(20_000); f.send('charge_energy_added', 0.1);
  Object.assign(status, { active: true, pauseExpected: true, settlingUntil: initial + 200_000 });
  f.at(25_000); f.send('charger_power', 0); f.send('charging_state', 'Stopped'); f.send('charge_energy_added', 0);
  f.at(90_000); f.send('healthy', true); f.send('charging_state', 'Charging'); f.send('charger_power', 11);
  f.send('charge_energy_added', 0.12);
  Object.assign(status, { active: false, pauseExpected: false, verdict: 'other', assignmentPending: false });
  f.at(100_000); f.property(25); f.easee(11); f.tick();
  f.send('charging_state', 'Complete'); f.at(150_000); f.tick();
  assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0].referenceKwh, 0.12);
  assert.equal(f.checks()[0].complete, false, 'A reset that catches up cannot be distinguished from a transient zero');
});
