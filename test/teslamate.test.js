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
  assert.equal(f.capture.receive('teslamate/cars/1/charger_actual_current', '16'), false);
});

test('retained state and a healthy heartbeat cannot by themselves start charging energy', t => {
  const f = setup(t); begin(f, { retained: true });
  f.at(60_000); f.tick(); f.send('healthy', true); f.tick();
  assert.equal(f.energy(), 0);
  f.at(70_000); f.send('charge_energy_added', 0.2); f.tick();
  f.at(80_000); f.tick();
  assert(Math.abs(f.energy() - 11 * 10 / 3600) < 1e-10, 'Only live-evidence coverage after startup contributes');
});

test('fresh comparable property impossibility suspends immediately and house load cannot revive stale Tesla power', t => {
  const f = setup(t); begin(f);
  f.at(10_000); f.property(13); f.tick();
  const before = f.energy();
  f.at(20_000); f.property(2); f.tick();
  assert.equal(f.capture.status().suppressed, 'property-power-impossible');
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
  assert.equal(decodeTeslaMateField('charger_actual_current', '16'), undefined);
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
