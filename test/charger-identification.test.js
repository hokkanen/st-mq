import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargerIdentification } from '../src/acquisition/charger-identification.js';

const START = 1_000_000;
function fixture({ amps = 16, teslaPower = amps * 0.69, read, limit, ...options } = {}) {
  let now = START, lastEnergyAt = now, energy = 2, chargerAmps = amps, power = teslaPower;
  let powerAt = now, currentAt = now, teslaAmps = amps, healthyAt = now;
  let energyAt = now, sourceTime = now, connected = true, home = true, plugged = true;
  let chargerSession = 'invented-session-one', healthy = true, charging = true;
  let teslaSession = 'invented-tesla-session-one';
  let telemetryAt = null, telemetryConfirmed = false;
  const calls = [];
  const control = {
    read: read ?? (async () => ({ safeToProbe: true, connected: true, receivedAt: now, minCurrentA: 7,
      powerKw: chargerAmps * 0.69, currents: [chargerAmps, chargerAmps, chargerAmps] })),
    limit: limit ?? (async ({ amps, minutes }) => { calls.push({ amps, minutes }); return { accepted: true, requestedAt: now, expiresAfterMs: 60_000 }; }),
  };
  const machine = createChargerIdentification({ control, clock: () => now, ...options });
  const snapshot = () => ({ tesla: { connected, home, plugged, healthy, healthyAt, charging,
    powerKw: power, powerAt, currentA: teslaAmps, currentAt, energyKwh: energy, energyAt, sessionKey: teslaSession },
  charger: { powerKw: chargerAmps * 0.69, currentA: chargerAmps, sourceTime, receivedAt: now,
    sessionKey: chargerSession, telemetryAt, telemetryConfirmed } });
  async function step(seconds = 5, changes = {}) {
    const next = now + seconds * 1000;
    if (changes.progress !== false && charging && power > 0) {
      energy += power * (next - lastEnergyAt) / 3_600_000 * 0.9; energyAt = next;
    }
    lastEnergyAt = next; now = next;
    if (changes.chargerAmps !== undefined) chargerAmps = changes.chargerAmps;
    if (changes.power !== undefined && power !== changes.power) { power = changes.power; powerAt = now; }
    if (changes.teslaAmps !== undefined && teslaAmps !== changes.teslaAmps) { teslaAmps = changes.teslaAmps; currentAt = now; }
    if (changes.healthy !== undefined) healthy = changes.healthy;
    if (changes.heartbeat !== false) healthyAt = now;
    if (changes.source !== false) sourceTime = now;
    if (changes.sourceTime !== undefined) sourceTime = changes.sourceTime;
    if (changes.diagnostic === true) { telemetryAt = now; telemetryConfirmed = true; }
    if (changes.telemetryAt !== undefined) telemetryAt = changes.telemetryAt;
    if (changes.connected !== undefined) connected = changes.connected;
    if (Object.hasOwn(changes, 'home')) home = changes.home;
    if (changes.plugged !== undefined) plugged = changes.plugged;
    if (changes.charging !== undefined) charging = changes.charging;
    if (changes.session !== undefined) chargerSession = changes.session;
    if (Object.hasOwn(changes, 'teslaSession')) teslaSession = changes.teslaSession;
    if (changes.powerAt !== undefined) powerAt = changes.powerAt;
    if (changes.energyAt !== undefined) energyAt = changes.energyAt;
    if (changes.energy !== undefined) energy = changes.energy;
    if (changes.currentAt !== undefined) currentAt = changes.currentAt;
    return machine.tick(snapshot(), now);
  }
  const baseline = async () => { await machine.tick(snapshot(), now); for (let i = 0; i < 5; i++) await step(); };
  const hold = async (changes, count = 11) => { for (let i = 0; i < count; i++) await step(5, changes); };
  const restore = async () => { await step(5, { chargerAmps: amps, power: teslaPower, teslaAmps: amps, charging: true }); await step(); };
  return { machine, calls, snapshot, step, baseline, hold, restore, get now() { return now; } };
}

test('unknown simultaneous charging triggers reduction and matching drop/recovery identifies Charger 1', async () => {
  const f = fixture(); await f.baseline();
  assert.deepEqual(f.calls, [{ amps: 10, minutes: 1 }]);
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.machine.status().assignmentPending, true);
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 });
  assert.equal(f.machine.status().verdict, null, 'A matching dip alone is insufficient');
  await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.machine.status().active, false);
  assert.equal(f.machine.status().pauseExpected, false);
  await f.step(120);
  assert.equal(f.calls.length, 1, 'No repeated experiment after identification');
});

test('near minimum actual current selects timed pause without raising load-balancing limits', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  assert.deepEqual(f.calls, [{ amps: 0, minutes: 1 }]);
  assert.equal(f.machine.status().pauseExpected, true);
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false });
  assert.equal(f.machine.status().pauseExpected, true);
  await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
  assert.deepEqual(f.calls, [{ amps: 0, minutes: 1 }], 'Expiry restores control; no unrestricted resume command');
});

test('fresh energy progression through restriction and recovery identifies a separate Charger 2', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10 });
  await f.restore();
  assert.equal(f.machine.status().verdict, 'bmw');
});

test('explicit pause can retest a known connection and keeps TeslaMate pause session changes transient', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.machine.request({ strategy: 'pause' }), true);
  await f.baseline();
  assert.deepEqual(f.calls.at(-1), { amps: 0, minutes: 1 });
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false });
  await f.step(5, { chargerAmps: 16, power: 11.04, teslaAmps: 16, charging: true, session: 'invented-session-two' });
  await f.step();
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.calls.length, 2);
});

test('retained power and health heartbeats without live energy cannot establish a baseline', async () => {
  const f = fixture();
  await f.step(0, { powerAt: null, currentAt: null });
  for (let i = 0; i < 15; i++) await f.step(5, { progress: false });
  assert.equal(f.calls.length, 0);
  assert.equal(f.machine.status().verdict, null);
});

test('retained startup power is baseline context only when live energy progresses and effects arrive live', async () => {
  const f = fixture();
  await f.step(0, { powerAt: null, currentAt: null });
  for (let i = 0; i < 5; i++) await f.step();
  assert.deepEqual(f.calls, [{ amps: 10, minutes: 1 }]);
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
});

test('a separate car can prove continued energy progression while retained power never republishes', async () => {
  const f = fixture();
  await f.step(0, { powerAt: null, currentAt: null });
  for (let i = 0; i < 5; i++) await f.step();
  await f.hold({ chargerAmps: 10 }); await f.restore();
  assert.equal(f.machine.status().verdict, 'bmw');
  assert.equal(f.snapshot().tesla.powerAt, null);
});

test('healthy heartbeat alone never makes stale held power a different-car verdict', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, progress: false });
  await f.restore(); await f.step(95, { progress: false });
  assert.equal(f.machine.status().phase, 'inconclusive');
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.calls.length, 1);
});

test('stale property-independent Charger 1 measurements do not renew through HTTP receipts', async () => {
  const f = fixture();
  await f.step(0, { sourceTime: START - 65_000 });
  for (let i = 0; i < 20; i++) await f.step(5, { source: false });
  assert.equal(f.calls.length, 0);
});

test('change-only stable power accepts live diagnostic confirmation without inventing new source timestamps', async () => {
  const f = fixture();
  await f.step(0, { sourceTime: START - 455_000, diagnostic: true });
  for (let i = 0; i < 5; i++) await f.step(5, { source: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.snapshot().charger.sourceTime, START - 455_000);
  assert.equal(f.machine.status().phase, 'holding');
});

test('old diagnostic confirmation cannot revive stale change-only values', async () => {
  const f = fixture();
  await f.step(0, { sourceTime: START - 455_000, diagnostic: true, telemetryAt: START - 18 * 60_000 });
  for (let i = 0; i < 20; i++) await f.step(5, { source: false });
  assert.equal(f.calls.length, 0);
});

test('a single new zero measurement held through fresh polls permits late Tesla pause evidence', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.step(5, { chargerAmps: 0 });
  const pauseTime = f.snapshot().charger.sourceTime;
  await f.step(5, { source: false, power: 0, teslaAmps: 0, charging: false });
  await f.hold({ source: false }, 9);
  assert.equal(f.snapshot().charger.sourceTime, pauseTime);
  await f.step(5, { chargerAmps: 6, power: 4.14, teslaAmps: 6, charging: true });
  const resumedTime = f.snapshot().charger.sourceTime;
  await f.step(5, { source: false });
  assert.equal(f.snapshot().charger.sourceTime, resumedTime);
  assert.equal(f.machine.status().verdict, 'easee');
});

test('an immediate device response is allowed to settle without demanding another change-only publication', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.step(1, { chargerAmps: 0, power: 0, teslaAmps: 0, charging: false });
  await f.step(4, { source: false });
  await f.hold({ source: false }, 10);
  await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
});

test('second-rounded Easee timestamps prove new changes without requiring subsecond precision', async () => {
  const f = fixture({ amps: 6 });
  await f.step(0.4, { sourceTime: START - 5000 });
  for (let i = 0; i < 5; i++) await f.step(5, { source: false });
  const commandAt = f.now;
  await f.step(0.2, { chargerAmps: 0, power: 0, teslaAmps: 0, charging: false,
    sourceTime: Math.floor(commandAt / 1000) * 1000 });
  await f.step(4.8, { source: false });
  await f.hold({ source: false }, 10);
  await f.step(5.2, { chargerAmps: 6, power: 4.14, teslaAmps: 6, charging: true,
    sourceTime: Math.floor((commandAt + 60_000) / 1000) * 1000 });
  await f.step(5, { source: false });
  assert.equal(f.machine.status().verdict, 'easee');
});

test('late session metadata after pause recovery has a bounded grace without hiding real unplug', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false }); await f.restore();
  assert.equal(f.machine.status().pauseExpected, true);
  await f.step(5, { session: 'invented-resumed-run' });
  assert.equal(f.machine.status().verdict, 'easee');
  await f.step(30);
  assert.equal(f.machine.status().pauseExpected, false);
  await f.step(5, { plugged: false });
  assert.equal(f.machine.status().verdict, null);
});

test('fresh receipts and diagnostic heartbeats cannot make pre-command measurements prove a pause', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.hold({ source: false, diagnostic: true, chargerAmps: 0, power: 0, teslaAmps: 0, charging: false });
  await f.restore(); await f.step(100);
  assert.equal(f.machine.status().verdict, null);
});

test('changing load balancing resets the stability window rather than forcing a test', async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) await f.step(5, { chargerAmps: i % 2 ? 16 : 10 });
  assert.equal(f.calls.length, 0);
  for (let i = 0; i < 6; i++) await f.step(5, { chargerAmps: 16 });
  assert.equal(f.calls.length, 1);
});

test('accepted command with no actual charger reduction proves nothing and is not retried', async () => {
  const f = fixture(); await f.baseline(); await f.hold({}); await f.restore(); await f.step(100);
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.machine.status().phase, 'inconclusive');
  await f.step(120);
  assert.equal(f.calls.length, 1);
});

test('load balancing preventing recovery leaves the experiment inconclusive without forcing current up', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 });
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }, 20);
  assert.equal(f.machine.status().phase, 'inconclusive');
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.calls.length, 1);
});

test('existing restrictive or unknown dynamic control defers without issuing any command', async () => {
  for (const safeToProbe of [false, undefined]) {
    const f = fixture({ read: async () => ({ safeToProbe, connected: true, receivedAt: START + 25_000 }) });
    await f.baseline();
    assert.equal(f.calls.length, 0); assert.equal(f.machine.status().phase, 'deferred');
  }
});

test('a fresh pre-command API change in actual current rejects the older stable polling baseline', async () => {
  const f = fixture({ read: async () => ({ safeToProbe: true, connected: true, receivedAt: START + 25_000,
    powerKw: 6.9, currents: [10, 10, 10], minCurrentA: 7 }) });
  await f.baseline();
  assert.equal(f.calls.length, 0);
  assert.equal(f.machine.status().reason, 'telemetry-changed-before-command');
});

test('energy counter rollback invalidates an otherwise unchanged-power independent-car conclusion', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10 });
  await f.step(0, { energy: f.snapshot().tesla.energyKwh - 0.02 });
  await f.restore(); await f.step(100);
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.machine.status().phase, 'inconclusive');
});

test('a counter reset during our pause does not invalidate positive matching power steps', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.step(5, { chargerAmps: 0, power: 0, teslaAmps: 0, charging: false, energy: 0 });
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false }, 10);
  await f.restore();
  assert.equal(f.machine.status().verdict, 'easee');
});

test('MQTT reconnect clears identification but retains the physical-connection attempt latch', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  await f.step(5, { connected: false, home: false });
  assert.equal(f.machine.status().verdict, null);
  await f.step(5, { connected: true, home: true });
  await f.baseline();
  assert.equal(f.calls.length, 1, 'A network outage does not authorize another automatic interruption');
  await f.step(5, { plugged: false });
  await f.step(5, { plugged: true }); await f.baseline();
  assert.equal(f.calls.length, 2, 'A genuine new connection can be identified again');
});

test('a new Tesla charging session invalidates identification even when Charger 1 session is unchanged', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  await f.step(5, { teslaSession: 'invented-tesla-session-two' });
  assert.equal(f.machine.status().verdict, null);
  await f.baseline();
  assert.equal(f.calls.length, 2, 'A missed unplug packet cannot carry the old assignment into a new charging session');
});

test('idle Tesla logger timestamps do not clear a charging-session assignment', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  await f.step(5, { charging: false, teslaSession: 'invented-online-since' });
  assert.equal(f.machine.status().verdict, 'easee');
  await f.step(5, { charging: true, teslaSession: 'invented-tesla-session-one' });
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.calls.length, 1);
});

test('our pause absorbs Tesla online, resumed and late session timestamps without another experiment', async () => {
  const f = fixture({ amps: 6 }); await f.baseline();
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false, teslaSession: 'invented-pause-since' });
  await f.step(5, { chargerAmps: 6, power: 4.14, teslaAmps: 6, charging: true, teslaSession: 'invented-resumed-since' });
  await f.step();
  assert.equal(f.machine.status().verdict, 'easee');
  await f.step(5, { teslaSession: 'invented-late-resumed-since' });
  await f.step(35);
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.calls.length, 1);
});

test('unknown Tesla session key initializes once without invalidating a completed identification', async () => {
  const f = fixture(); await f.step(0, { teslaSession: null }); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  await f.step(5, { teslaSession: 'invented-first-known-session' });
  assert.equal(f.machine.status().verdict, 'easee');
  assert.equal(f.calls.length, 1);
});

test('a new Tesla session during a reduction abandons the old experiment', async () => {
  const f = fixture(); await f.baseline();
  await f.step(5, { teslaSession: 'invented-unexpected-new-session' });
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.machine.status().active, false);
  assert.equal(f.machine.status().phase, 'baseline');
});

test('unknown home after MQTT reconnect does not release the attempt latch', async () => {
  const f = fixture(); await f.baseline();
  await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
  await f.step(5, { connected: false, home: undefined });
  await f.step(5, { connected: true, home: undefined });
  await f.step(5, { home: true }); await f.baseline();
  assert.equal(f.calls.length, 1);
  assert.equal(f.machine.status().verdict, null);
});

test('departure, true unplug and MQTT disconnect clear RAM identification', async () => {
  for (const change of [{ home: false }, { plugged: false }, { connected: false }]) {
    const f = fixture(); await f.baseline();
    await f.hold({ chargerAmps: 10, power: 6.9, teslaAmps: 10 }); await f.restore();
    assert.equal(f.machine.status().verdict, 'easee');
    await f.step(5, change);
    assert.equal(f.machine.status().verdict, null);
  }
});

test('singleflight and shutdown prevent late preflight completion from sending a command', async () => {
  let resolveRead, requestSignal;
  const f = fixture({ read: ({ signal }) => new Promise(resolve => { resolveRead = resolve; requestSignal = signal; }) });
  const waiting = f.baseline();
  while (!resolveRead) await new Promise(resolve => setImmediate(resolve));
  await f.step();
  assert.equal(f.machine.request({ strategy: 'pause' }), false);
  f.machine.stop();
  assert.equal(requestSignal.aborted, true);
  resolveRead({ safeToProbe: true, connected: true, receivedAt: f.now });
  await waiting;
  assert.equal(f.calls.length, 0);
  assert.equal(f.machine.status().phase, 'stopped');
});

test('disconnect during preflight prevents the pending command and clears experiment state', async () => {
  let resolveRead;
  const f = fixture({ read: () => new Promise(resolve => { resolveRead = resolve; }) });
  const waiting = f.baseline();
  while (!resolveRead) await new Promise(resolve => setImmediate(resolve));
  await f.step(5, { connected: false });
  resolveRead({ safeToProbe: true, connected: true, receivedAt: f.now });
  await waiting;
  assert.equal(f.calls.length, 0); assert.equal(f.machine.status().active, false);
});

test('a late command response cannot reactivate a stopped machine', async () => {
  let resolveLimit, requestSignal;
  const f = fixture({ limit: ({ signal }) => new Promise(resolve => { resolveLimit = resolve; requestSignal = signal; }) });
  const waiting = f.baseline();
  while (!resolveLimit) await new Promise(resolve => setImmediate(resolve));
  f.machine.stop();
  assert.equal(requestSignal.aborted, true);
  resolveLimit({ accepted: true, requestedAt: f.now, expiresAfterMs: 60_000 });
  await waiting;
  assert.equal(f.machine.status().phase, 'stopped');
  assert.equal(f.machine.status().active, false);
});

test('control timeout aborts the HTTP operation and prevents later automatic retries', async () => {
  let requestSignal;
  const f = fixture({ controlTimeoutMs: 5, read: ({ signal }) => { requestSignal = signal; return new Promise(() => {}); } });
  await f.baseline();
  assert.equal(requestSignal.aborted, true);
  assert.equal(f.machine.status().phase, 'deferred');
  assert.equal(f.calls.length, 0);
  await f.step(100);
  assert.equal(f.calls.length, 0);
});

test('failed command retains bounded pause grace but can never produce a verdict', async () => {
  const f = fixture({ amps: 6, limit: async () => { throw new Error('invented request failure'); } });
  await f.baseline();
  assert.equal(f.machine.status().pauseExpected, true);
  assert(f.machine.status().settlingUntil <= START + 25_000 + 180_000);
  await f.hold({ chargerAmps: 0, power: 0, teslaAmps: 0, charging: false }); await f.restore();
  await f.step(100);
  assert.equal(f.machine.status().verdict, null);
  assert.equal(f.machine.status().pauseExpected, false);
});

test('invalid timestamps, strategy and disabled operation never result in uncontrolled writes', async () => {
  const f = fixture({ enabled: false }); await f.baseline();
  assert.equal(f.calls.length, 0); assert.equal(f.machine.request(), false);
  await assert.rejects(f.machine.tick(f.snapshot(), -1), /UTC/);
  assert.throws(() => f.machine.request({ strategy: 'raise' }), /Unknown/);
});
