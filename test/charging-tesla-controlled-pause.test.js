import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceIdentification, validateIdentificationState, prepareActiveTeslaCandidate,
  matchActiveTeslaPause, matchActiveBmwPause } from '../src/charging/identification.js';

const START = Date.parse('2026-10-09T10:00:00Z'), NOW = START + 20_000;
const field = (value, at = NOW - 1000) => ({ value, receivedAt: at, retained: false,
  measuredAt: null, timeBasis: 'receipt-only' });
const signal = value => ({ value, measuredAt: NOW - 500, receivedAt: NOW, available: true, retained: false });
function fixture() {
  const reading = { association: 'synthetic-tesla-pause', connected: true, healthy: true,
    atHome: true, pluggedIn: true, charging: true, actualCurrentA: 5, actualPowerKw: 3,
    fields: { plugged_in: field(true, START - 1000), geofence: field('Home', START - 1000),
      charging_state: field('Charging'), charger_actual_current: field(5), charger_power: field(3) }, boundaries: [] };
  const options = { connectedAt: START, startedAt: START, now: NOW,
    physical: { providerConnected: true, connected: signal(true), charging: signal(true),
      phaseCurrentA: signal([5, 5, 5]), powerKw: signal(3.4) } };
  const candidate = prepareActiveTeslaCandidate(reading, options);
  assert.ok(candidate);
  const state = advanceIdentification(null, { connectedAt: START, now: NOW, charging: true, candidate });
  const requestedAt = NOW + 1000, stoppedAt = NOW + 4000;
  const pause = { connectedAt: START, requestedAt, stoppedAt, confirmedAt: stoppedAt + 1000, startAt: state.pauseUntil };
  return { reading, options, candidate, state, pause, now: NOW + 6000 };
}
function stopped(f) {
  f.reading.charging = false; f.reading.actualCurrentA = 0; f.reading.actualPowerKw = 0;
  f.reading.fields.charging_state = field('Stopped', f.now - 1000);
  f.reading.fields.charger_actual_current = field(0, f.now - 1000);
  f.reading.fields.charger_power = field(0, f.now - 1000);
  f.state = advanceIdentification(f.state, { connectedAt: START, now: f.now, charging: false, pause: f.pause });
  return f;
}
const match = f => matchActiveTeslaPause(f.reading, { state: f.state, now: f.now });

test('matching draw creates only a Tesla pause baseline; confirmed physical and independent vehicle stops identify', () => {
  const f = fixture();
  assert.equal(f.state.phase, 'pausing'); assert.equal(f.state.action, 'pause');
  assert.equal(match(f), null, 'Positive matching draw alone is insufficient');
  stopped(f);
  assert.deepEqual(match(f), { powerReceivedAt: f.candidate.powerReceivedAt, confirmedAt: f.pause.confirmedAt, requestedAt: f.pause.requestedAt });
  validateIdentificationState(f.state);
  assert.deepEqual(matchActiveTeslaPause(f.reading, { state: structuredClone(f.state), now: f.now }), match(f),
    'Restart preserves original candidate and pause clocks');
  assert.equal(matchActiveBmwPause({ provider: 'bmw-cardata' }, { state: f.state, now: f.now }), null);
});

test('Tesla baseline requires fresh positive matching physical and live vehicle evidence', () => {
  const changes = {
    'unhealthy Tesla': f => { f.reading.healthy = false; },
    'offline Tesla': f => { f.reading.connected = false; },
    'away': f => { f.reading.atHome = false; },
    'not charging': f => { f.reading.charging = false; },
    'current mismatch': f => { f.reading.actualCurrentA = 8; },
    'power mismatch': f => { f.reading.actualPowerKw = 8; },
    'retained current': f => { f.reading.fields.charger_actual_current.retained = true; },
    'retained power': f => { f.reading.fields.charger_power.retained = true; },
    'retained start': f => { f.reading.fields.charging_state.retained = true; },
    'pre-attempt current': f => { f.reading.fields.charger_actual_current.receivedAt = START - 1; },
    'old start': f => { f.reading.fields.charging_state.receivedAt = START - 1; },
    'unknown physical charging': f => { f.options.physical.charging.available = false; },
    'no physical current': f => { f.options.physical.phaseCurrentA.available = false; },
    'retained physical power': f => { f.options.physical.powerKw.retained = true; },
    'assumed physical power': f => { f.options.physical.powerKw.assumed = true; },
    'stale physical power': f => { f.options.physical.powerKw.measuredAt = NOW - 61_000; },
    'consumed power': f => { f.options.consumedPowerAt = f.candidate.powerReceivedAt; },
  };
  for (const [reason, change] of Object.entries(changes)) {
    const f = fixture(); change(f);
    assert.equal(prepareActiveTeslaCandidate(f.reading, f.options), null, reason);
  }
});

test('Tesla stop requires all independent live zero/stop fields within the response window', () => {
  for (const key of ['charging_state', 'charger_actual_current', 'charger_power']) {
    for (const update of [{ retained: true }, { receivedAt: NOW }, { receivedAt: NOW + 1000 },
      { receivedAt: NOW + 70_000 }, { receivedAt: NOW + 90_001 }, { value: null }]) {
      const f = stopped(fixture()); Object.assign(f.reading.fields[key], update);
      if (update.receivedAt > f.now) f.now = update.receivedAt;
      assert.equal(match(f), null, `${key}: ${JSON.stringify(update)}`);
    }
  }
  for (const value of ['NoPower', 'Starting', 'Disconnected', 'online', 'asleep', 'unknown']) {
    const f = stopped(fixture()); f.reading.fields.charging_state.value = value;
    assert.equal(match(f), null, `${value} does not independently confirm the stop`);
  }
  const f = stopped(fixture()); f.reading.fields.charging_state.value = 'Complete'; assert.ok(match(f));
});

test('controlled Tesla identity retains session, attempt, feed, departure and consumed-evidence fences', () => {
  const changes = {
    'no physical pause': f => { f.state.pause = null; },
    'different connection': f => { f.state.connectedAt--; },
    'different feed': f => { f.reading.association = 'replacement-synthetic-feed'; },
    'unhealthy feed after stop': f => { f.reading.healthy = false; },
    'newer retry': f => { f.state.startedAt = f.now; },
    'unplug after baseline': f => { f.reading.boundaries.push({ association: f.reading.association,
      field: 'plugged_in', value: false, at: NOW + 2000 }); },
    'left home after baseline': f => { f.reading.boundaries.push({ association: f.reading.association,
      field: 'geofence', value: 'Away', at: NOW + 2000 }); },
    'stale stop': f => { f.now += 61_000; },
  };
  for (const [reason, change] of Object.entries(changes)) {
    const f = stopped(fixture()); change(f); assert.equal(match(f), null, reason);
  }
  const f = stopped(fixture());
  assert.equal(matchActiveTeslaPause(f.reading, { state: f.state, now: f.now, consumedPowerAt: f.candidate.powerReceivedAt }), null);
  assert.equal(matchActiveTeslaPause(f.reading, { state: f.state, now: f.now, lastDisconnectedAt: START }), null);
});

test('a saved positive inferred connection survives the controlled stop without inventing a new plug report', () => {
  const f = fixture();
  f.reading.pluggedIn = false; f.reading.fields.plugged_in = { ...field(false, START - 10_000), retained: true };
  f.candidate = prepareActiveTeslaCandidate(f.reading, f.options); assert.ok(f.candidate);
  f.state.candidate = f.candidate;
  stopped(f); assert.ok(match(f), 'The known pre-baseline unplug is not a new departure');
  assert.equal(f.reading.fields.plugged_in.value, false);
});

test('malformed saved Tesla candidates fail closed and cannot masquerade as BMW source events', () => {
  const f = stopped(fixture());
  for (const update of [{ currentReceivedAt: null }, { powerReceivedAt: f.now + 1 },
    { chargingReceivedAt: START - 1 }, { association: null }, { kind: 'ongoing' }, { measuredAt: NOW }]) {
    const state = structuredClone(f.state); Object.assign(state.candidate, update);
    assert.throws(() => validateIdentificationState(state), /Unsupported saved charging identification/);
  }
});
