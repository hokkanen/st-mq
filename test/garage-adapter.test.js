import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter, createGarageSimulationTransport } from '../src/garage/adapter.js';
import { garageAdapterSettings } from '../src/garage/contract.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { stateTopic: 'fixture/garage/state', telemetryTopic: 'fixture/garage/telemetry' };
function fixture(options = {}) {
  let now = BASE, counter = 0, owner = true;
  const sent = [], saved = [], observations = [], energy = [];
  const adapter = createGarageAdapter({ settings: { ...SETTINGS, ...options.settings }, clock: () => now,
    hostSession: options.hostSession ?? 'fixture-host', canControl: () => owner,
    onState: snapshot => saved.push(snapshot), onObservation: row => observations.push(row), onEnergy: row => energy.push(row),
    simulationTransport: createGarageSimulationTransport(async command => { sent.push(command); await options.send?.(command); }),
    ...options, settings: { ...SETTINGS, ...options.settings } });
  function state(patch = {}, packet = {}) {
    const value = structuredClone(TEMPLATE);
    value.sequence = ++counter; value.observedAt = now;
    for (const key of ['device', 'driver', 'pump']) value.health[key].measuredAt = now;
    value.native.power.measuredAt = now; value.baseline.measuredAt = now;
    value.challenge = { value: `fixture-challenge-${counter}`, expiresAt: now + 30_000 };
    Object.assign(value, patch);
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  function accepted(command = sent.at(-1), patch = {}) {
    return state({ native: { power: { value: command.action === 'release' ? 'on' : 'off', measuredAt: now } },
      lease: command.action === 'release' ? null : { episodeId: command.episodeId,
        endpointAt: command.endpointAt, expiresAt: command.requestedExpiryAt },
      restorationPending: command.action !== 'release', result: { commandId: command.commandId,
        sequence: command.sequence, episodeId: command.episodeId, action: command.action,
        status: command.action === 'release' ? 'native-confirmed' : 'accepted' }, ...patch });
  }
  adapter.setConnected(true);
  if (options.initialize !== false) state(options.initialState);
  return { adapter, sent, saved, observations, energy, state, accepted, now: () => now,
    at(value) { now = value; }, owner(value) { owner = value; },
    plan: { id: 'fixture-episode-1', pauseFrom: BASE, pauseUntil: BASE + 1_200_000 },
    start(plan = this.plan) { return adapter.plannerTick({ now, valid: true, plan, recoveryReady: true }); } };
}

test('real MQTT fixture observations can never arm live control, including forged configuration', async () => {
  for (const setting of [{ writeEnabled: true }, { armed: true }, { live: true }, { contractVerified: true }, { simulation: true }])
    assert.throws(() => garageAdapterSettings(setting), /Unsupported/);
  assert.throws(() => garageAdapterSettings({ stateTopic: 'fixture/#' }), /exact MQTT/);
  const f = fixture({ simulationTransport: { send() { throw new Error('must never send'); } } });
  assert.equal(f.adapter.status().liveControlSupported, false);
  assert.equal(f.adapter.status().automaticControl, false);
  assert.deepEqual((await f.start()).reasons, ['real-adapter-contract-unavailable']);
  assert.equal(f.adapter.status().contractStatus, 'provisional-fixture-only');
});

test('start, broker publication, acceptance, native confirmation and useful heat remain different evidence', async () => {
  const f = fixture();
  assert.equal((await f.start()).status, 'published');
  assert.equal(f.saved.find(row => row.restorePending)?.lastCommand.status, 'pending');
  assert.equal(f.adapter.status().lastCommand.nativeConfirmedAt, null);
  f.at(BASE + 1000); f.accepted();
  assert.equal(f.adapter.status().lastCommand.status, 'accepted');
  assert.equal(f.adapter.status().lastCommand.nativeConfirmedAt, null);
  await f.adapter.release({ reason: 'cancelled', now: f.now() });
  f.at(BASE + 2000); f.accepted();
  const status = f.adapter.status();
  assert.equal(status.restorePending, false);
  assert.equal(status.lastCommand.status, 'native-confirmed');
  assert.equal(status.lastCommand.usefulHeatAt, null);
  assert.equal(f.adapter.recordHeatResponse({ at: BASE + 1000, useful: true }), false);
  assert.equal(f.adapter.recordHeatResponse({ at: f.now(), useful: true }), true);
});

test('only valid planner ticks renew, with the same episode and immutable authorized endpoint', async () => {
  const f = fixture(); await f.start(); f.at(BASE + 1); f.accepted();
  f.at(BASE + 300_000); f.accepted(f.sent[0]);
  for (let i = 0; i < 10; i++) await f.adapter.safetyTick({ now: f.now(), valid: true });
  assert.equal(f.sent.length, 1);
  await f.start({ ...f.plan, pauseUntil: f.plan.pauseUntil + 3_600_000 });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].action, 'renew');
  assert.equal(f.sent[1].episodeId, f.sent[0].episodeId);
  assert.equal(f.sent[1].endpointAt, f.sent[0].endpointAt);
  assert.equal(f.sent[1].requestedExpiryAt, BASE + 900_000);
  assert.equal(f.sent[1].sequence, 2);
  assert.notEqual(f.sent[1].challenge, f.sent[0].challenge);
  f.at(BASE + 900_000); f.accepted(f.sent[1]);
  await f.adapter.safetyTick({ now: f.now(), valid: true });
  assert.equal(f.sent.at(-1).action, 'release');
});

test('endpoint arrival restores immediately and never starts the expired plan', async () => {
  const f = fixture(); const plan = { ...f.plan, pauseUntil: BASE + 30_000 };
  await f.start(plan); f.at(BASE + 1); f.accepted();
  f.at(plan.pauseUntil); f.accepted(f.sent[0]);
  await f.start(plan);
  assert.equal(f.sent.at(-1).action, 'release');
  assert.equal(f.sent.length, 2);
});

test('failed safety inputs release; delayed START confirmation cannot revive superseded intent', async () => {
  const f = fixture(); await f.start(); const old = f.sent[0];
  f.at(BASE + 1000); f.accepted(old);
  await f.adapter.safetyTick({ now: f.now(), valid: false });
  const release = f.sent[1];
  assert.equal(release.action, 'release');
  f.at(BASE + 2000); f.accepted(old);
  assert.equal(f.adapter.status().phase, 'restoring');
  assert.equal(f.adapter.status().restorePending, true);
  await f.start();
  assert.equal(f.sent.length, 2);
  f.at(BASE + 3000); f.accepted(release);
  assert.equal(f.adapter.status().restorePending, false);
  assert.ok((await f.start()).reasons.includes('completed-episode'));
});

test('retained, cached, relative-clock and stale states cannot reconcile a new connection', async () => {
  for (const kind of ['retained', 'stale', 'relative']) {
    const f = fixture({ initialize: false });
    const patch = kind === 'stale' ? { observedAt: BASE - 120_000 }
      : kind === 'relative' ? { observedAt: null, observedAgeMs: 0 } : {};
    f.state(patch, { retain: kind === 'retained' });
    assert.ok((await f.start()).reasons.includes('fresh-session-reconciliation-required'), kind);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture(); f.adapter.setConnected(false); f.adapter.setConnected(true);
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(TEMPLATE));
  assert.ok((await f.start()).reasons.includes('fresh-session-reconciliation-required'));
});

test('online device, stalled driver and absent pump have separate health and unresolved restoration', async () => {
  const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted();
  const h = structuredClone(TEMPLATE.health); h.driver.value = false; h.pump.value = false;
  f.state({ health: h, native: { power: { value: 'on', measuredAt: BASE } } });
  assert.deepEqual(f.adapter.status().health, { deviceOnline: true, driverProgressing: false, pumpCommunicating: false });
  await f.adapter.safetyTick({ now: f.now() });
  assert.equal(f.sent.at(-1).action, 'release');
  f.at(BASE + 2000); f.accepted(f.sent.at(-1), { health: h });
  assert.equal(f.adapter.status().restorePending, true);
  assert.ok(f.adapter.status().blockedReasons.includes('driver-not-progressing'));
});

test('stale native ON cannot settle a newer restoration obligation', async () => {
  const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted();
  await f.adapter.release({ now: f.now() });
  f.at(BASE + 2000); f.accepted(f.sent.at(-1), { native: { power: { value: 'on', measuredAt: BASE } } });
  assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.adapter.status().lastCommand.status, 'uncertain');
  assert.equal(f.adapter.status().lastCommand.nativeConfirmedAt, null);
});

test('disconnect never queues an OFF; reconnect requires fresh reconciliation and release', async () => {
  const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted();
  f.adapter.setConnected(false); await f.start();
  assert.equal(f.sent.length, 1);
  f.adapter.setConnected(true); await f.start();
  assert.equal(f.sent.length, 1);
  f.at(BASE + 2000); f.accepted(f.sent[0]); await f.start();
  assert.equal(f.sent.at(-1).action, 'release');
  assert.equal(f.adapter.status().restorePending, true);
});

test('restart keeps restoration obligation, uses a new host session and cannot resume old permission', async () => {
  const first = fixture(); await first.start(); first.at(BASE + 1000); first.accepted();
  const second = fixture({ persisted: first.adapter.snapshot(), hostSession: 'fixture-new-host' });
  assert.equal(second.adapter.status().restorePending, true);
  await second.start(); assert.equal(second.sent.length, 0);
  second.at(BASE + 2000); second.state({ authority: { ownerSession: 'fixture-new-host', controlAllowed: true },
    native: { power: { value: 'off', measuredAt: second.now() } }, restorationPending: true });
  await second.start();
  assert.equal(second.sent[0].action, 'release');
  assert.equal(second.sent[0].ownerSession, 'fixture-new-host');
});

test('manual ON and reboot invalidate the episode and honor native recovery locks', async () => {
  for (const event of ['manual-on', 'watchdog-recovery', 'reboot']) {
    const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted();
    f.at(BASE + 2000); f.state({ ...event === 'reboot' ? { bootId: 'fixture-boot-2' } : { event: { type: event, at: f.now() } },
      leaseLimits: { ...TEMPLATE.leaseLimits, minimumOnMs: 180_000 }, native: { power: { value: 'on', measuredAt: f.now() } } });
    assert.equal(f.adapter.status().restorePending, false, event);
    assert.equal(f.adapter.status().phase, 'recovery');
    assert.ok((await f.start({ ...f.plan, id: 'fixture-new-episode' })).reasons.includes('native-recovery-lock'));
    assert.ok((await f.start()).reasons.includes('completed-episode'));
  }
});

test('inactive instances, maintenance and unexpected manual OFF do not fight native ownership', async () => {
  const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted(); f.owner(false);
  await f.adapter.safetyTick({ now: f.now(), valid: false });
  await f.adapter.close({ restore: true });
  assert.equal(f.sent.length, 1);
  assert.equal(f.adapter.snapshot().restorePending, true);
  const maintenance = fixture({ initialState: { mode: 'maintenance' } });
  assert.ok((await maintenance.start()).reasons.includes('maintenance-handover'));
  const manual = fixture({ initialState: { native: { power: { value: 'off', measuredAt: BASE } } } });
  assert.ok((await manual.start()).reasons.includes('native-on-unconfirmed'));
  await manual.adapter.release(); assert.equal(manual.sent.length, 0);
});

test('challenge expiration and reused challenges cannot authorize old intentions', async () => {
  const f = fixture(); f.at(BASE + 30_000);
  assert.ok((await f.start()).reasons.includes('fresh-challenge-required'));
  assert.equal(f.sent.length, 0);
  f.state(); await f.start(); f.at(BASE + 30_001); f.accepted();
  const oldChallenge = f.sent[0].challenge;
  await f.adapter.release({ now: f.now() });
  f.state({ challenge: { value: oldChallenge, expiresAt: f.now() + 30_000 },
    native: { power: { value: 'off', measuredAt: f.now() } }, restorationPending: true });
  assert.ok(f.adapter.status().blockedReasons.includes('fresh-challenge-required'));
});

test('publication failure and unresolved START never become a successful pause', async () => {
  const f = fixture({ send: () => { throw new Error('invented transport failure'); } });
  await f.start(); assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.adapter.status().phase, 'restoring');
  assert.notEqual(f.adapter.status().lastCommand.status, 'native-confirmed');
  const timeout = fixture(); await timeout.start(); timeout.at(BASE + 31_000); timeout.state();
  await timeout.start(); assert.equal(timeout.sent.at(-1).action, 'release');
});

test('storage failure before OFF publication prevents any command', async () => {
  let fail = false;
  const f = fixture({ onState: snapshot => { if (fail && snapshot.restorePending) throw new Error('fixture storage failed'); } });
  fail = true;
  await assert.rejects(f.start(), /storage failed/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.adapter.status().restorePending, true);
});

test('an existing restore obligation can request ON despite failed persistence, without repeated unchanged callbacks', async () => {
  let fail = false, callbacks = 0;
  const f = fixture({ onState: () => { callbacks++; if (fail) throw new Error('fixture storage failure'); } });
  await f.start(); f.at(BASE + 1000); f.accepted();
  fail = true;
  await f.adapter.release({ reason: 'storage-failed', now: f.now() });
  assert.equal(f.sent.at(-1).action, 'release');
  assert.equal(f.adapter.status().restorePending, true);
  assert.ok(f.adapter.status().faults.includes('restoration-state-storage-failed'));
  fail = false;
  await f.adapter.release({ reason: 'storage-failed', now: f.now() });
  const count = callbacks;
  for (let i = 0; i < 100; i++) await f.adapter.release({ reason: 'storage-failed', now: f.now() });
  assert.equal(callbacks, count);
  assert.equal(f.sent.length, 2);
});

test('configured baseline is a readback check; unexpected native settings block without thermostat writes', async () => {
  const f = fixture({ baselineC: 12, initialState: { baseline: { ...TEMPLATE.baseline, targetC: 12 },
    native: { power: { value: 'on', measuredAt: BASE }, mode: { value: 'heat', measuredAt: BASE },
      targetC: { value: 12, measuredAt: BASE }, fan: { value: 'auto', measuredAt: BASE }, vanes: { value: 'fixed', measuredAt: BASE } } } });
  assert.equal(f.adapter.status().configuredBaselineC, 12);
  assert.equal(f.adapter.status().native.targetC, 12);
  await f.start();
  assert.equal(f.sent[0].action, 'start');
  assert.equal(Object.hasOwn(f.sent[0], 'targetC'), false);
  const changed = fixture({ initialState: { native: { power: { value: 'on', measuredAt: BASE },
    mode: { value: 'cool', measuredAt: BASE } } } });
  assert.ok((await changed.start()).reasons.includes('native-settings-changed'));
});

test('adapter source epoch changes at reboot and never exposes native identities', () => {
  const f = fixture(); const first = f.adapter.status().sourceEpoch;
  assert.match(first, /^[a-f0-9]{64}$/);
  f.at(BASE + 1000); f.state({ bootId: 'fixture-boot-2' });
  assert.notEqual(f.adapter.status().sourceEpoch, first);
  assert.equal(JSON.stringify(f.adapter.status()).includes(TEMPLATE.deviceId), false);
});

test('late asynchronous START publication success cannot replace the newer release outcome', async () => {
  let resolveStart;
  const delayed = new Promise(resolve => { resolveStart = resolve; });
  const f = fixture({ send: command => command.action === 'start' ? delayed : undefined });
  const starting = f.start();
  assert.equal(f.sent[0].action, 'start');
  f.at(BASE + 1000); f.accepted(f.sent[0]);
  await f.adapter.safetyTick({ now: f.now(), valid: false });
  const release = f.sent[1];
  f.at(BASE + 2000); f.accepted(release);
  resolveStart(); await starting;
  assert.equal(f.adapter.status().lastCommand.action, 'release');
  assert.equal(f.adapter.status().lastCommand.status, 'native-confirmed');
  assert.equal(f.adapter.status().restorePending, false);
  assert.equal(f.adapter.status().commandHistory[0].status, 'superseded');
});

test('accepted shorter endpoints remain binding and overlong reported leases force unresolved release', async () => {
  const shorter = fixture(); await shorter.start(); shorter.at(BASE + 1000);
  shorter.accepted(shorter.sent[0], { lease: { episodeId: shorter.plan.id, expiresAt: BASE + 600_000, endpointAt: BASE + 700_000 } });
  assert.equal(shorter.adapter.status().episode.endpointAt, BASE + 700_000);
  shorter.at(BASE + 300_000); shorter.accepted(shorter.sent[0], {
    lease: { episodeId: shorter.plan.id, expiresAt: BASE + 600_000, endpointAt: BASE + 700_000 } });
  await shorter.start();
  assert.equal(shorter.sent.at(-1).endpointAt, BASE + 700_000);
  const longer = fixture(); await longer.start(); longer.at(BASE + 1000);
  longer.accepted(longer.sent[0], { lease: { episodeId: longer.plan.id, expiresAt: BASE + 900_000, endpointAt: longer.plan.pauseUntil } });
  assert.equal(longer.adapter.status().phase, 'restoring');
  assert.equal(longer.adapter.status().episode.leaseExpiresAt, BASE + 900_000);
  await longer.adapter.safetyTick({ now: longer.now() });
  assert.equal(longer.sent.at(-1).action, 'release');
});

test('an explicit incompatible contract or malformed state immediately revokes previous state eligibility', async () => {
  for (const patch of [{ schema: 'unimplemented-published-contract/v9' }, { mode: 'unknown-mode' }, { deviceId: 'different-fixture-device' }]) {
    const f = fixture(); await f.start(); f.at(BASE + 1000); f.accepted();
    f.adapter.receive(SETTINGS.stateTopic, JSON.stringify({ ...TEMPLATE, sequence: 99, observedAt: f.now(), ...patch }), {}, f.now());
    assert.equal(f.adapter.status().automaticControl, false);
    assert.equal(f.adapter.status().phase, 'restoring');
    assert.equal(f.adapter.status().restorePending, true);
    await f.start();
    assert.equal(f.sent.length, 1, 'unsupported schema cannot reuse the old session for another write');
  }
});
