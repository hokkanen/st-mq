import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createChargingTeslaCapture, teslamateConnectionContext } from '../src/charging/teslamate.js';
import { matchTeslaSession } from '../src/charging/vehicle.js';

const NOW = 1800000000000;
const identityValues = { plugged_in: 'true', charging_state: 'Charging', state: 'charging', geofence: 'Home', charger_power: '7' };
function fixture(initialState) {
  let now = NOW, saved;
  const boundaries = [];
  const capture = createChargingTeslaCapture({ initialState, clock: () => now,
    saveState: state => { saved = state; }, onBoundary: event => boundaries.push(event) });
  capture.setConnected(true);
  return { capture, boundaries, setNow(value) { now = value; }, saved: () => structuredClone(saved),
    send(field, value, packet = {}) { return capture.receive(`teslamate/cars/1/${field}`, value, packet); } };
}
test('vehicle observation cannot create canonical grid energy or a charger session check',()=>{
  const captured=[];const capture=createChargingTeslaCapture({saveState:value=>captured.push(value),clock:()=>1800000000000});capture.setConnected(true);
  for(const [field,value]of Object.entries({healthy:'true',plugged_in:'true',charging_state:'Charging',geofence:'Home',charger_power:'11',charge_energy_added:'1'}))capture.receive(`teslamate/cars/1/${field}`,value);
  assert.equal(capture.status().recording,false);assert.equal(captured.length,6);
  assert.equal(existsSync(new URL('../src/acquisition/teslamate.js',import.meta.url)),false);
  assert.doesNotMatch(readFileSync(new URL('../src/charging/teslamate.js',import.meta.url),'utf8'),/recordEnergy|recordChargingSessionCheck/);
});

test('identical live publications preserve retained identity provenance while healthy pulses renew availability', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: true });
  const original = f.capture.snapshot().fields;
  const connectedAt = NOW + 120000;
  f.setNow(connectedAt);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  f.send('healthy', 'true');
  const snapshot = f.capture.snapshot();
  assert.equal(snapshot.healthy, true);
  for (const field of Object.keys(identityValues)) assert.deepEqual(snapshot.fields[field], original[field], field);
  assert.equal(f.boundaries.length, 0);
  assert.equal(matchTeslaSession(snapshot, { connectedAt, now: connectedAt, chargingAt: [connectedAt],
    physical: { charging: { value: true }, powerKw: { available: true, value: 7, measuredAt: connectedAt } } }), false);
  f.setNow(connectedAt + 1000); f.send('healthy', 'true');
  assert.equal(f.capture.snapshot().fields.healthy.receivedAt, connectedAt + 1000);
});

test('periodic live identity repeats cannot renew plug, power or start clocks', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  const original = f.capture.snapshot().fields, boundaryCount = f.boundaries.length;
  f.setNow(NOW + 60000);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  const snapshot = f.capture.snapshot();
  for (const field of Object.keys(identityValues)) assert.deepEqual(snapshot.fields[field], original[field], field);
  assert.equal(f.boundaries.length, boundaryCount);
});

test('actual live plug and charging changes retain their own receipt times and can identify the new session', () => {
  const f = fixture();
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: true });
  f.setNow(NOW + 1000);
  for (const [field, value] of Object.entries({ plugged_in: 'false', charging_state: 'Disconnected', state: 'online', charger_power: '0' })) f.send(field, value);
  const connectedAt = NOW + 2000;
  f.setNow(connectedAt);
  for (const [field, value] of Object.entries(identityValues)) f.send(field, value);
  f.send('healthy', 'true');
  const snapshot = f.capture.snapshot();
  for (const field of ['plugged_in', 'charging_state', 'state', 'charger_power']) {
    assert.equal(snapshot.fields[field].receivedAt, connectedAt, field);
    assert.equal(snapshot.fields[field].retained, false, field);
  }
  assert.deepEqual(f.boundaries.filter(event => event.field === 'plugged_in').map(event => event.value), [false, true]);
  assert.equal(matchTeslaSession(snapshot, { connectedAt, lastDisconnectedAt: NOW + 1000,
    now: connectedAt, chargingAt: [connectedAt], physical: {
      charging: { value: true, available: true, measuredAt: connectedAt },
      powerKw: { available: true, value: 7, measuredAt: connectedAt },
    } }), true);
});

test('unknown identity gaps and same-value recovery preserve provenance across restart', () => {
  for (const retained of [false, true]) {
    const f = fixture();
    for (const [field, value] of Object.entries(identityValues)) f.send(field, value, { retain: retained });
    const original = f.capture.snapshot().fields;
    f.setNow(NOW + 1000);
    for (const field of ['plugged_in', 'charging_state', 'state', 'charger_power']) f.send(field, 'invalid');
    f.send('geofence', 'x'.repeat(201));
    for (const field of Object.keys(identityValues)) assert.equal(f.capture.snapshot().fields[field].value, null, field);
    const restarted = fixture(f.saved()); restarted.setNow(NOW + 2000);
    for (const [field, value] of Object.entries(identityValues)) restarted.send(field, value);
    for (const field of Object.keys(identityValues)) assert.deepEqual(restarted.capture.snapshot().fields[field], original[field], `${field}, retained=${retained}`);
    assert.deepEqual(restarted.boundaries, []);
  }
});

test('an actual negative plug after an unknown gap still records a departure', () => {
  const f = fixture(); f.send('plugged_in', 'true');
  f.setNow(NOW + 1000); f.send('plugged_in', 'invalid');
  f.setNow(NOW + 2000); f.send('plugged_in', 'false');
  assert.deepEqual(f.boundaries.map(event => [event.value, event.at]), [[true, NOW], [false, NOW + 2000]]);
  assert.equal(f.capture.snapshot().pluggedIn, false);
});

function corroboratedConnection() {
  const f = fixture();
  for (const [field, value] of Object.entries({ geofence: 'Home', plugged_in: 'false',
    charging_state: 'Disconnected', state: 'online', charger_actual_current: '0', charger_power: '0' }))
    f.send(field, value, { retain: true });
  f.setNow(NOW + 1000);
  for (const [field, value] of Object.entries({ healthy: 'true', charging_state: 'Charging',
    state: 'charging', charger_actual_current: '16', charger_power: '11' })) f.send(field, value);
  return f;
}

test('live charging corroborates an old retained negative plug without rewriting the raw observation', () => {
  const f = corroboratedConnection(), snapshot = f.capture.snapshot();
  assert.equal(snapshot.pluggedIn, false);
  assert.equal(snapshot.fields.plugged_in.value, false);
  assert.equal(snapshot.fields.plugged_in.retained, true);
  assert.equal(snapshot.fields.plugged_in.receivedAt, NOW);
  assert.deepEqual(snapshot.connectionContext, { source: 'live-charging', receivedAt: NOW + 1000,
    retained: false, timeBasis: 'receipt-only', chargingAt: NOW + 1000, currentAt: NOW + 1000,
    powerAt: NOW + 1000, reportedPluggedIn: false, reportedPlugAt: NOW });
  assert.deepEqual(f.boundaries, [], 'Corroboration does not invent a positive plug edge');
});

test('stable live charging context keeps its source times through health pulses and restart', () => {
  const f = corroboratedConnection(), original = f.capture.snapshot();
  f.setNow(NOW + 3600_000); f.send('healthy', 'true');
  for (const [field, value] of Object.entries({ charging_state: 'Charging', state: 'charging',
    charger_actual_current: '16', charger_power: '11' })) f.send(field, value);
  assert.deepEqual(f.capture.snapshot().connectionContext, original.connectionContext);
  assert.deepEqual(f.capture.snapshot().fields.plugged_in, original.fields.plugged_in);
  const restarted = fixture(f.saved()); restarted.setNow(NOW + 3601_000);
  assert.equal(restarted.capture.snapshot().connectionContext, null, 'Saved context cannot substitute for live logger health');
  restarted.send('healthy', 'true', { retain: true });
  assert.equal(restarted.capture.snapshot().connectionContext, null, 'Retained health cannot admit saved context');
  restarted.send('healthy', 'true');
  assert.deepEqual(restarted.capture.snapshot().connectionContext, original.connectionContext);
});

test('reported positive Tesla plug still requires healthy home context and a connected feed', () => {
  const original = corroboratedConnection().capture.snapshot();
  original.pluggedIn = true;
  for (const patch of [{ healthy: false }, { connected: false }, { atHome: false }, { atHome: null }]) {
    assert.equal(teslamateConnectionContext({ ...original, ...patch }, { now: NOW + 2000 }), null);
  }
});

test('newer native departure fences a held positive Tesla plug until a later actual connection', () => {
  for (const [field, value] of [['charging_state', 'Disconnected'], ['state', 'driving']]) {
    const f = corroboratedConnection();
    f.setNow(NOW + 2000); f.send('plugged_in', 'true');
    assert.equal(f.capture.snapshot().connectionContext.source, 'reported-plug');
    f.setNow(NOW + 3000); f.send(field, value);
    assert.equal(f.capture.snapshot().pluggedIn, true, 'The raw held positive is still visible');
    assert.equal(f.capture.snapshot().connectionContext, null, 'Newer negative state has priority over the old plug');
    f.setNow(NOW + 4000); f.send('plugged_in', 'false');
    f.setNow(NOW + 5000); f.send('plugged_in', 'true');
    assert.equal(f.capture.snapshot().connectionContext.source, 'reported-plug', 'A later actual plug recovers context without charging');
    const invalid = f.capture.snapshot();
    invalid.fields[field].receivedAt = null;
    assert.equal(teslamateConnectionContext(invalid, { now: NOW + 5000 }), null,
      'An unknown departure clock cannot be ordered before the positive plug');
  }
});

test('corroborated Tesla connection fails closed for missing, retained, contradictory and invalid evidence', async t => {
  const good = corroboratedConnection().capture.snapshot();
  const cases = {
    'unhealthy logger': s => { s.healthy = false; },
    'disconnected broker': s => { s.connected = false; },
    'away vehicle': s => { s.atHome = false; },
    'unknown home': s => { s.atHome = null; },
    'stopped vehicle': s => { s.charging = false; },
    'retained current': s => { s.fields.charger_actual_current.retained = true; },
    'retained power': s => { s.fields.charger_power.retained = true; },
    'retained starts': s => { s.fields.charging_state.retained = s.fields.state.retained = true; },
    'no current': s => { delete s.fields.charger_actual_current; },
    'zero current': s => { s.fields.charger_actual_current.value = 0; },
    'zero power': s => { s.fields.charger_power.value = 0; },
    'unknown current': s => { s.fields.charger_actual_current.value = null; },
    'future current': s => { s.fields.charger_actual_current.receivedAt = NOW + 2001; },
    'future plug': s => { s.fields.plugged_in.receivedAt = NOW + 2001; },
    'unknown plug clock': s => { s.fields.plugged_in.receivedAt = null; },
    'invented measured clock': s => { s.fields.charger_power.measuredAt = NOW; },
    'current before plug': s => { s.fields.charger_actual_current.receivedAt = NOW - 1; },
    'power at negative plug': s => { s.fields.charger_power.receivedAt = NOW; },
    'later raw negative': s => { s.fields.plugged_in.receivedAt = NOW + 1500; },
    'later driving state': s => { s.fields.state = { ...s.fields.state, value: 'driving', receivedAt: NOW + 1500 }; },
    'later disconnected state': s => { s.fields.charging_state = { ...s.fields.charging_state,
      value: 'Disconnected', receivedAt: NOW + 1500 }; },
    'later recorded departure': s => { s.boundaries = [{ association: s.association,
      field: 'charging_state', value: 'Disconnected', at: NOW + 1500 }]; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const snapshot = structuredClone(good); change(snapshot);
    assert.equal(teslamateConnectionContext(snapshot, { now: NOW + 2000 }), null);
  });
});

test('native Tesla disconnect and driving transitions preserve boundaries even when the plug topic stays false', () => {
  for (const [field, value] of [['charging_state', 'Disconnected'], ['state', 'driving']]) {
    const f = corroboratedConnection();
    f.setNow(NOW + 2000); f.send(field, value);
    assert.equal(f.capture.snapshot().connectionContext, null);
    assert.deepEqual(f.boundaries.map(({ field, value, at }) => ({ field, value, at })),
      [{ field, value, at: NOW + 2000 }]);
    f.setNow(NOW + 3000); f.send(field, value);
    assert.equal(f.boundaries.length, 1, 'Same-value publications cannot create another disconnect');
    f.send('charger_actual_current', '6'); f.send('charger_power', '4');
    assert.equal(f.capture.snapshot().connectionContext, null, 'Late current and power cannot replace the missing new start');
    f.send(field, field === 'state' ? 'charging' : 'Charging');
    assert.equal(f.capture.snapshot().connectionContext?.source, 'live-charging');
    assert.equal(f.capture.snapshot().pluggedIn, false);
  }
});

test('a Tesla pause withdraws charging corroboration without inventing a disconnect', () => {
  const f = corroboratedConnection();
  f.setNow(NOW + 2000);
  f.send('charging_state', 'Stopped'); f.send('state', 'online');
  f.send('charger_actual_current', '0'); f.send('charger_power', '0');
  assert.equal(f.capture.snapshot().connectionContext, null);
  assert.deepEqual(f.boundaries, []);
  assert.equal(f.capture.snapshot().fields.plugged_in.receivedAt, NOW);
});

test('charging corroboration does not replace physical session and power correlation', () => {
  const f = corroboratedConnection();
  const options = { connectedAt: NOW + 1000, now: NOW + 2000, chargingAt: [NOW + 1000],
    physical: { charging: { value: true }, powerKw: { value: 11, available: true, measuredAt: NOW + 2000 } } };
  assert.equal(matchTeslaSession(f.capture.snapshot(), options), true);
  assert.equal(matchTeslaSession(f.capture.snapshot(), { ...options,
    physical: { ...options.physical, powerKw: { value: 7, available: true, measuredAt: NOW + 2000 } } }), false);
  assert.equal(matchTeslaSession(f.capture.snapshot(), { ...options, connectedAt: NOW + 180_000,
    now: NOW + 181_000, chargingAt: [NOW + 180_000], physical: { ...options.physical,
      powerKw: { value: 11, available: true, measuredAt: NOW + 181_000 } } }), false,
  'Old charging evidence cannot identify a later physical connection');
});
