import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter, createGarageSimulationTransport } from '../src/garage/adapter.js';
import { garageAdapterSettings, SHELLY_CN105_CONTRACT } from '../src/garage/contract.js';
import { createShellyCn105Transport, SHELLY_CN105_COMMISSIONING } from '../src/garage/shelly-cn105.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'invented/pump/state',
  telemetryTopic: 'invented/pump/telemetry', commandTopic: 'invented/pump/command' };
function fixture(options = {}) {
  let now = BASE, sequence = 0, owner = true;
  const published = [], saved = [], observations = [];
  const settings = { ...SETTINGS, ...options.settings };
  const publish = async (topic, payload, publicationOptions) => {
    published.push({ topic, command: JSON.parse(payload), options: publicationOptions });
    await options.publish?.();
  };
  const adapter = createGarageAdapter({ settings, hostSession: 'invented-host', clock: () => now,
    canControl: () => owner, onState: snapshot => saved.push(snapshot), onObservation: row => observations.push(row),
    productionTransport: createShellyCn105Transport({ settings, publish }), ...options.adapter });
  adapter.setConnected(true);
  function state(patch = {}, packet = {}) {
    const value = structuredClone(TEMPLATE);
    value.schema = SHELLY_CN105_CONTRACT;
    value.sequence = ++sequence; value.observedAt = now;
    value.commissioning = Object.fromEntries(SHELLY_CN105_COMMISSIONING.map(name => [name, true]));
    value.authority = { ownerSession: 'invented-host', controlAllowed: true };
    value.challenge = { value: `invented-challenge-${sequence}`, expiresAt: now + 30_000 };
    for (const field of Object.values(value.health)) field.measuredAt = now;
    value.native.power.measuredAt = now; value.baseline.measuredAt = now;
    Object.assign(value, patch);
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  const start = () => adapter.plannerTick({ now, valid: true, recoveryReady: true,
    plan: { id: 'invented-pause', pauseFrom: BASE, pauseUntil: BASE + 900_000,
      temperatureEvidenceAt: now, permissionExpiresAt: now + 180_000 } });
  return { adapter, state, published, saved, observations, start,
    at(value) { now = value; }, owner(value) { owner = value; } };
}

test('production driver needs explicit distinct topics and has no configuration commissioning bypass', () => {
  for (const patch of [{ armed: true }, { commissioning: true }, { driver: 'unknown' },
    { driver: 'fixture', commandTopic: SETTINGS.commandTopic }, { commandTopic: SETTINGS.stateTopic },
    { stateTopic: '', commandTopic: SETTINGS.commandTopic }, { commandTopic: 'invented/#' }])
    assert.throws(() => garageAdapterSettings({ ...SETTINGS, ...patch }));
  assert.equal(createShellyCn105Transport({ settings: {} }), null);
  const f = fixture({ adapter: { productionTransport: { send() { throw Error('forged'); } },
    simulationTransport: createGarageSimulationTransport(() => { throw Error('wrong contract'); }) } });
  f.state();
  assert.equal(f.adapter.status().liveControlSupported, false);
  assert.equal(f.adapter.status().automaticControl, false);
});

test('monitoring reads the real protocol without claiming ownership or publishing control', async () => {
  const f = fixture();
  f.state({ mode: 'monitoring', commissioning: {}, baseline: { verified: false },
    authority: { ownerSession: null, controlAllowed: false } });
  assert.equal((await f.start()).status, 'blocked');
  assert.equal(f.published.length, 0);
  assert.equal(f.adapter.status().contractVersion, SHELLY_CN105_CONTRACT);
  assert.equal(f.adapter.status().contractStatus, 'supported-driver');
  assert.equal(f.adapter.status().liveControlSupported, true);
  assert.equal(f.adapter.status().automaticControl, false);
  assert.deepEqual(f.adapter.status().health, { deviceOnline: true, driverProgressing: true, pumpCommunicating: true });
  assert.equal(f.adapter.status().native.power, 'on');
});

test('each independent installed commissioning result gates both OFF and ownership claim', async () => {
  for (const name of SHELLY_CN105_COMMISSIONING) {
    const f = fixture();
    f.state({ commissioning: { ...Object.fromEntries(SHELLY_CN105_COMMISSIONING.map(key => [key, true])), [name]: false } });
    assert.ok((await f.start()).reasons.includes('installed-commissioning-required'));
    f.state({ authority: { ownerSession: null, controlAllowed: false }, commissioning: {} });
    assert.equal(f.published.length, 0, name);
  }
});

test('fresh armed state claims an unowned commissioned adapter once and waits for new authority evidence', async () => {
  const f = fixture();
  const first = f.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(f.published.length, 1);
  const claim = f.published[0];
  assert.equal(claim.command.action, 'claim');
  assert.equal(claim.command.schema, SHELLY_CN105_CONTRACT);
  assert.equal(claim.command.episodeId, undefined);
  assert.deepEqual(claim.options, { qos: 0, retain: false, noReplay: true });
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(first));
  assert.equal(f.published.length, 1);
  assert.equal((await f.start()).status, 'blocked');
  f.at(BASE + 1000); f.state();
  assert.equal(f.adapter.status().authority.owned, true);
  assert.equal(f.adapter.status().authority.claimPending, false);
  assert.equal((await f.start()).status, 'published');
  const command = f.published.at(-1).command;
  assert.equal(command.action, 'start');
  assert.equal(command.sequence, claim.command.sequence + 1);
  assert.ok(f.saved.some(row => row.restorePending && row.lastCommand.status === 'pending'));
  assert.equal(command.requestedExpiryAt, BASE + 181_000);
});

test('retained, expired, foreign-owned, disconnected and inactive state cannot claim the pump', async () => {
  for (const scenario of ['retained', 'expired', 'foreign', 'disconnected', 'inactive']) {
    const f = fixture(), patch = { authority: { ownerSession: null, controlAllowed: false } };
    if (scenario === 'expired') patch.observedAt = BASE - 120_001;
    if (scenario === 'foreign') patch.authority.ownerSession = 'invented-other-owner';
    if (scenario === 'disconnected') f.adapter.setConnected(false);
    if (scenario === 'inactive') f.owner(false);
    f.state(patch, { retain: scenario === 'retained' });
    assert.equal((await f.start()).status, 'blocked');
    assert.equal(f.published.length, 0, scenario);
  }
});

test('replacement host remembers a foreign pause expiry until fresh restored ON allows a new claim', async () => {
  const f = fixture(), expiry = BASE + 180_000;
  f.state({ authority: { ownerSession: 'invented-previous-host', controlAllowed: true },
    native: { power: { value: 'off', measuredAt: BASE } }, restorationPending: true,
    lease: { episodeId: 'invented-previous-pause', expiresAt: expiry, endpointAt: BASE + 900_000 } });
  assert.equal(f.adapter.status().restorePending, true);
  assert.equal(f.adapter.status().episode, null, 'Observing another host does not adopt its OFF intention');
  assert.equal(f.adapter.status().outstandingPermissionExpiresAt, expiry);
  await f.adapter.safetyTick({ valid: false });
  assert.equal(f.published.length, 0, 'The replacement must not command the previous owner');

  f.at(expiry - 1000);
  f.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(f.adapter.status().restorePending, true, 'Early ON does not prove queued OFF is cancelled');
  assert.equal(f.adapter.status().outstandingPermissionExpiresAt, expiry);
  const saved = f.adapter.snapshot();
  assert.equal(saved.outstandingPermissionExpiresAt, expiry);
  assert.equal(f.published.length, 0);

  f.adapter.setConnected(false); f.adapter.setConnected(true); f.at(expiry + 1000);
  f.state({ authority: { ownerSession: null, controlAllowed: false },
    native: { power: { value: 'on', measuredAt: expiry - 1000 } } });
  assert.equal(f.adapter.status().restorePending, true, 'The ON measurement must follow the permission expiry');
  f.state({ authority: { ownerSession: null, controlAllowed: false } }, { retain: true });
  assert.equal(f.adapter.status().restorePending, true, 'Retained state cannot establish restoration');
  f.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(f.adapter.status().restorePending, false);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].command.action, 'claim');

  const restarted = fixture({ adapter: { persisted: saved } });
  restarted.at(expiry + 2000);
  restarted.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(restarted.adapter.status().restorePending, false, 'The observed obligation survives another host restart');
  assert.equal(restarted.published[0].command.action, 'claim');
});

test('fixture payloads cannot authorize the production route and production payloads cannot authorize fixtures', async () => {
  const f = fixture();
  f.state({ schema: TEMPLATE.schema });
  assert.equal(f.adapter.status().automaticControl, false);
  assert.equal(f.published.length, 0);
  const fixtureAdapter = createGarageAdapter({ settings: { stateTopic: SETTINGS.stateTopic } });
  fixtureAdapter.setConnected(true);
  fixtureAdapter.receive(SETTINGS.stateTopic, JSON.stringify({ ...TEMPLATE, schema: SHELLY_CN105_CONTRACT }));
  assert.ok(fixtureAdapter.status().faults.includes('unsupported-or-invalid-adapter-contract'));
});

test('production telemetry preserves source clocks and optional decoder qualification', () => {
  const f = fixture(); f.state({ mode: 'monitoring' });
  f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ ...TEMPLATE, schema: SHELLY_CN105_CONTRACT,
    fields: { indoorTemperature: { supported: true, decodeVerified: true, value: 10.5, unit: 'degC', measuredAt: BASE - 10_000 },
      outdoorTemperature: { supported: true, decodeVerified: true, value: -5.5, unit: 'degC', measuredAt: BASE },
      power: { supported: true, decodeVerified: false, value: 0, unit: 'W', measuredAt: BASE, quality: 'observed-unverified' } } }));
  const telemetry = f.adapter.status().telemetry;
  assert.equal(telemetry.indoorTemperature.usable, true);
  assert.equal(telemetry.indoorTemperature.sourceTime, BASE - 10_000);
  assert.equal(telemetry.outdoorTemperature.value, -5.5);
  assert.equal(telemetry.power.usable, false);
  assert.ok(telemetry.power.quality.includes('decoding-unverified'));
  assert.ok(!telemetry.power.quality.includes('provisional-contract'));
  assert.equal(f.observations[0].raw.contractVersion, SHELLY_CN105_CONTRACT);
  assert.equal(f.observations[0].raw.provisional, false);
  f.at(BASE + 120_000);
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, false);
});

test('commissioning and native baseline loss prevent renewals while preserving owned restoration', async () => {
  const f = fixture(); f.state(); await f.start();
  const start = f.published.at(-1).command;
  f.at(BASE + 1000);
  f.state({ commissioning: {}, baseline: { verified: false },
    authority: { ownerSession: 'invented-host', controlAllowed: false },
    native: { power: { value: 'off', measuredAt: BASE + 1000 } },
    lease: { episodeId: start.episodeId, endpointAt: start.endpointAt, expiresAt: start.requestedExpiryAt },
    restorationPending: true });
  await f.adapter.safetyTick({ now: BASE + 1000 });
  assert.equal(f.published.at(-1).command.action, 'release');
  assert.equal(f.adapter.status().restorePending, true);
});

test('a lost publication remains uncertain and cannot silently retry the same OFF', async () => {
  const f = fixture({ publish: async () => { throw Error('invented disconnect'); } });
  f.state();
  assert.equal((await f.start()).status, 'superseded');
  assert.ok(f.adapter.status().faults.includes('command-publication-uncertain'));
  assert.equal(f.adapter.status().restorePending, true);
  await f.start();
  assert.equal(f.published.length, 1);
});

test('captured production runtime monitoring messages interoperate without fixture schema substitution', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
  const telemetry = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-telemetry.json', import.meta.url)));
  const f = fixture(); f.at(state.observedAt + 1000);
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(state));
  f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify(telemetry));
  const status = f.adapter.status();
  assert.equal(status.contractVersion, SHELLY_CN105_CONTRACT);
  assert.equal(status.native.targetC, 10);
  assert.equal(status.native.mode, 'heat');
  assert.equal(status.telemetry.indoorTemperature.value, 22.5);
  assert.equal(status.telemetry.outdoorTemperature.value, -5.5);
  assert.equal(status.telemetry.compressorActive.value, true, 'Production boolean fields have no physical unit');
  assert.equal(status.telemetry.compressorFrequency.value, 35);
  assert.equal(status.telemetry.compressorActive.usable, false, 'Unverified observations remain diagnostic');
  assert.equal(f.observations.find(row => row.signal === 'garage_compressor_active').value, null,
    'Unqualified diagnostic values cannot create chart activity');
  assert.equal(status.telemetry.power.usable, false);
  assert.equal(status.health.pumpCommunicating, true);
  assert.equal(status.automaticControl, false);
  assert.equal(f.published.length, 0);
});
