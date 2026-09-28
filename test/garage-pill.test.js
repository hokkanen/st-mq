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
      temperatureEvidenceAt: now, permissionExpiresAt: now + 120_000 } });
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
  assert.equal(f.adapter.status().pauseControl, false);
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
  assert.equal(f.adapter.status().pauseControl, false);
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

test('an explicit automatic request claims an unowned commissioned adapter once and waits for fresh ownership', async () => {
  const f = fixture();
  const first = f.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(f.published.length, 0, 'Fresh observations do not acquire command authority');
  assert.equal((await f.start()).status, 'claiming');
  assert.equal(f.published.length, 1);
  const claim = f.published[0];
  assert.equal(claim.command.action, 'claim');
  assert.equal(claim.command.schema, SHELLY_CN105_CONTRACT);
  assert.equal(claim.command.episodeId, undefined);
  assert.deepEqual(claim.options, { qos: 0, retain: false, noReplay: true });
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(first));
  assert.equal(f.published.length, 1);
  assert.equal((await f.start()).status, 'claiming');
  f.at(BASE + 1000); f.state();
  assert.equal(f.adapter.status().authority.owned, true);
  assert.equal(f.adapter.status().authority.claimPending, false);
  assert.equal((await f.start()).status, 'published');
  const command = f.published.at(-1).command;
  assert.equal(command.action, 'start');
  assert.equal(command.sequence, claim.command.sequence + 1);
  assert.ok(f.saved.some(row => row.restorePending && row.lastCommand.status === 'pending'));
  assert.equal(command.requestedExpiryAt, BASE + 121_000);
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
  assert.equal(f.published.length, 0);
  await f.start();
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].command.action, 'claim');

  const restarted = fixture({ adapter: { persisted: saved } });
  restarted.at(expiry + 2000);
  restarted.state({ authority: { ownerSession: null, controlAllowed: false } });
  assert.equal(restarted.adapter.status().restorePending, false, 'The observed obligation survives another host restart');
  assert.equal(restarted.published.length, 0);
  await restarted.start();
  assert.equal(restarted.published[0].command.action, 'claim');
});

test('fixture payloads cannot authorize the production route and production payloads cannot authorize fixtures', async () => {
  const f = fixture();
  f.state({ schema: TEMPLATE.schema });
  assert.equal(f.adapter.status().pauseControl, false);
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

test('current publisher monitoring contract interoperation preserves diagnostic data without control authority', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
  const telemetry = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-telemetry.json', import.meta.url)));
  const f = fixture(); f.at(state.observedAt + 1000);
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(state));
  f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify(telemetry));
  const status = f.adapter.status();
  assert.equal(status.contractVersion, SHELLY_CN105_CONTRACT);
  assert.equal(status.native.targetC, 17);
  assert.equal(status.native.mode, 'heat');
  assert.equal(status.telemetry.indoorTemperature.value, 22.5);
  assert.equal(status.telemetry.outdoorTemperature.value, -5.5);
  assert.equal(status.telemetry.compressorActive.value, true, 'The current publisher uses the boolean unit for true/false');
  assert.equal(status.telemetry.compressorFrequency.value, 35);
  assert.equal(status.telemetry.compressorActive.usable, false, 'Unverified observations remain diagnostic');
  assert.equal(status.telemetry.compressorActive.diagnosticAvailable, true);
  const activity = f.observations.find(row => row.signal === 'garage_compressor_active');
  assert.equal(activity.value, 1, 'Reviewed diagnostic output can be charted with its unverified quality');
  assert.equal(activity.unit, 'state');
  assert.equal(activity.sourceTime, telemetry.fields.compressorActive.measuredAt);
  assert.deepEqual(activity.quality, ['observed-unverified']);
  assert.equal(activity.raw.diagnosticAvailable, true);
  assert.equal(activity.raw.accuracyVerified, false);
  assert.equal(activity.raw.usableForControl, false);
  assert.equal(status.native.compressorActive, undefined, 'Diagnostics cannot become qualified native activity');
  assert.equal(status.telemetry.power.usable, false);
  assert.equal(status.health.pumpCommunicating, true);
  assert.equal(status.pauseControl, false);
  assert.equal(f.published.length, 0);
});

test('current publisher true and false are recorded distinctly; malformed or unavailable activity remains a gap', () => {
  for (const scenario of [
    { name: 'running', patch: { value: true }, expected: 1 },
    { name: 'idle', patch: { value: false }, expected: 0 },
    { name: 'wrong-unit-running', patch: { value: true, unit: null }, expected: null, flag: 'units-unverified' },
    { name: 'wrong-unit-idle', patch: { value: false, unit: null }, expected: null, flag: 'units-unverified' },
    { name: 'absent', patch: { value: null, unit: null, supported: false, decodeVerified: false, quality: 'unknown' }, expected: null, flag: 'unknown' },
    { name: 'unsupported', patch: { supported: false }, expected: null, flag: 'unsupported' },
    { name: 'invalid', patch: { quality: 'invalid' }, expected: null, flag: 'invalid' },
    { name: 'unknown', patch: { quality: 'unknown' }, expected: null, flag: 'unknown' },
    { name: 'numeric-boolean', patch: { value: 1 }, expected: null, flag: 'invalid-value' },
    { name: 'unreviewed-decoder', patch: { decodeVerified: false }, expected: null, flag: 'decoding-unverified' },
    { name: 'stale', patch: { measuredAt: BASE - 120_000 }, expected: null, flag: 'stale' },
    { name: 'future', patch: { measuredAt: BASE + 1 }, expected: null, flag: 'future-source-time' },
    { name: 'no-clock', patch: { measuredAt: null }, expected: null, flag: 'source-time-unknown' },
    { name: 'retained', patch: {}, packet: { retain: true }, expected: null, flag: 'retained' },
  ]) {
    const f = fixture();
    const field = { value: true, unit: 'boolean', supported: true, decodeVerified: true,
      measuredAt: BASE, quality: 'observed-unverified', accuracyVerified: false, ...scenario.patch };
    f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ schema: SHELLY_CN105_CONTRACT,
      deviceId: 'invented-pill', bootId: 'invented-boot', sequence: 1, observedAt: BASE,
      fields: { compressorActive: field } }), scenario.packet ?? {});
    const reading = f.adapter.status().telemetry.compressorActive, observation = f.observations.at(-1);
    assert.equal(observation.value, scenario.expected, scenario.name);
    assert.equal(reading.diagnosticAvailable, scenario.expected !== null, scenario.name);
    assert.equal(reading.usable, false, scenario.name);
    assert.equal(observation.raw.usableForControl, false, scenario.name);
    assert.equal(observation.raw.accuracyVerified, false, scenario.name);
    if (scenario.flag) assert.ok(observation.quality.includes(scenario.flag), scenario.name);
    if (scenario.name === 'absent') assert.equal(observation.quality.includes('units-unverified'), false);
  }
});

test('diagnostic source clocks never move backwards and a cached report cannot repair an outage', () => {
  for (const outage of ['disconnect', 'subscription']) {
    const f = fixture(); let sequence = 0;
    const report = (at, value = true) => f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({
      schema: SHELLY_CN105_CONTRACT, deviceId: 'invented-pill', bootId: 'invented-boot',
      sequence: ++sequence, observedAt: BASE + sequence * 1000,
      fields: { compressorActive: { value, unit: 'boolean', supported: true, decodeVerified: true,
        measuredAt: at, quality: 'observed-unverified', accuracyVerified: false } } }));
    f.at(BASE + 1000); report(BASE + 1000);
    f.at(BASE + 2000); report(BASE, false);
    assert.equal(f.observations.length, 1, 'Older diagnostic packets cannot replace newer source data');
    assert.equal(f.adapter.status().telemetry.compressorActive.value, true);
    f.at(BASE + 3000);
    if (outage === 'disconnect') f.adapter.setConnected(false); else f.adapter.subscriptionFailed();
    assert.equal(f.observations.at(-1).value, null, outage);
    assert.equal(f.observations.at(-1).sourceTime, null, outage);
    assert.equal(f.observations.at(-1).receivedAt, BASE + 3000, outage);
    assert.ok(f.observations.at(-1).quality.includes('unavailable'), outage);
    if (outage === 'disconnect') f.adapter.setConnected(true);
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false, outage);
    f.at(BASE + 4000); report(BASE + 1000);
    assert.equal(f.observations.at(-1).value, null, 'Republishing a pre-outage cache cannot restore chart activity');
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false, outage);
    f.at(BASE + 5000); report(BASE + 5000, false);
    assert.equal(f.observations.at(-1).value, 0, outage);
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, true, outage);
    assert.equal(f.adapter.status().telemetry.compressorActive.usable, false, outage);
  }
});


test('fresh explicit health loss ends diagnostic availability while unrelated native setting loss does not', () => {
  for (const [key, reason] of [['device', 'device-offline'], ['driver', 'driver-not-progressing'], ['pump', 'pump-not-communicating']]) {
    const f = fixture(); f.state({ mode: 'monitoring' });
    f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ ...TEMPLATE, schema: SHELLY_CN105_CONTRACT,
      fields: { compressorActive: { value: true, unit: 'boolean', supported: true, decodeVerified: true,
        measuredAt: BASE, quality: 'observed-unverified' } } }));
    f.at(BASE + 1000);
    f.state({ native: { power: { value: null, measuredAt: BASE + 1000 } } });
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, true,
      'Unavailable pump setting is not evidence of compressor activity loss');
    f.at(BASE + 2000);
    f.state({ health: { ...TEMPLATE.health, [key]: { value: false, measuredAt: BASE + 2000 } } });
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false, key);
    assert.equal(f.observations.at(-1).value, null, key);
    assert.deepEqual(f.observations.at(-1).quality, ['unavailable', reason]);
  }
});

test('a known outage is a genuine availability event even after a retained telemetry packet', () => {
  const f = fixture();
  f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ ...TEMPLATE, schema: SHELLY_CN105_CONTRACT,
    fields: { compressorActive: { value: true, unit: 'boolean', supported: true, decodeVerified: true,
      measuredAt: BASE, quality: 'observed-unverified' } } }), { retain: true });
  f.at(BASE + 1000); f.adapter.setConnected(false);
  const gap = f.observations.at(-1);
  assert.equal(gap.value, null);
  assert.equal(gap.sourceTime, null);
  assert.equal(gap.raw.retained, false);
  assert.equal(gap.raw.timeBasis, 'host-observed');
  assert.deepEqual(gap.quality, ['unavailable', 'mqtt-disconnected']);
});

test('invalid newer packets cannot clear an outage barrier or poison recovery with a valid measurement', () => {
  for (const patch of [{ unit: null }, { quality: 'invalid' }, { decodeVerified: false }, { measuredAt: BASE + 1_000_000 }]) {
    const f = fixture(); let sequence = 0;
    const report = (receivedAt, measuredAt, extra = {}) => {
      f.at(receivedAt);
      f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({
        schema: SHELLY_CN105_CONTRACT, deviceId: 'invented-pill', bootId: 'invented-boot',
        sequence: ++sequence, observedAt: receivedAt,
        fields: { compressorActive: { value: true, unit: 'boolean', supported: true, decodeVerified: true,
          measuredAt, quality: 'observed-unverified', accuracyVerified: false, ...extra } } }));
    };
    report(BASE, BASE);
    f.at(BASE + 1000); f.adapter.setConnected(false); f.adapter.setConnected(true);
    report(BASE + 2000, BASE + 2000, patch);
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false, JSON.stringify(patch));
    report(BASE + 3000, BASE);
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, false,
      'A malformed newer packet cannot authorize a cached pre-outage report');
    assert.equal(f.observations.at(-1).value, null);
    report(BASE + 4000, BASE + 4000, { value: false });
    assert.equal(f.adapter.status().telemetry.compressorActive.diagnosticAvailable, true,
      'An invalid future source clock cannot fence out a genuine new observation');
    assert.equal(f.observations.at(-1).value, 0);
    assert.equal(f.adapter.status().telemetry.compressorActive.usable, false);
  }
});

test('live unverified electrical readings retain disconnect fencing without power history', () => {
  const f = fixture(); let sequence = 0;
  const report = (at, measuredAt = at, decodeVerified = false) => {
    f.at(at);
    f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({
      schema: SHELLY_CN105_CONTRACT, deviceId: 'invented-pill', bootId: 'invented-boot',
      sequence: ++sequence, observedAt: at,
      fields: { power: { value: 400, unit: 'W', supported: true, decodeVerified,
        measuredAt, quality: 'observed-unverified', accuracyVerified: false } } }));
  };
  report(BASE);
  f.at(BASE + 1000); f.adapter.setConnected(false); f.adapter.setConnected(true);
  report(BASE + 2000);
  assert.equal(f.adapter.status().telemetry.power.value, 400, 'Raw electrical diagnostic remains live');
  assert.equal(f.adapter.status().telemetry.power.usable, false);
  f.at(BASE + 3000); f.adapter.setConnected(false);
  assert.equal(f.adapter.status().telemetry.power.diagnosticAvailable, false);
  assert(f.adapter.status().telemetry.power.quality.includes('mqtt-disconnected'));
  f.adapter.setConnected(true);
  report(BASE + 4000, BASE + 2000, true);
  assert.equal(f.adapter.status().telemetry.power.diagnosticAvailable, false,
    'The latest outage, not the first outage, fences recovery of cached measurements');
  assert.ok(f.adapter.status().telemetry.power.quality.includes('out-of-order-source-time'));
  report(BASE + 5000, BASE + 5000, true);
  assert.equal(f.adapter.status().telemetry.power.diagnosticAvailable, true);
  assert.equal(f.adapter.status().telemetry.power.usable, false);
  assert(!f.observations.some(row => row.signal === 'garage_power'), 'Live acquisition never archives standalone power');
});


test('bounded pause uses one installation capability and carries no scheduling purpose', async () => {
  const f = fixture();
  f.state({ mode: 'ready', authority: { ownerSession: null, controlAllowed: true } });
  assert.equal(f.published.length, 0, 'Reports do not claim in the background');
  assert.equal(f.adapter.status().pauseReasons.length, 0);
  const request = { now: BASE, valid: true, recoveryReady: true,
    plan: { id: 'bounded-pause', pauseFrom: BASE, pauseUntil: BASE + 600_000,
      temperatureEvidenceAt: BASE, permissionExpiresAt: BASE + 120_000 } };
  assert.equal((await f.adapter.plannerTick(request)).status, 'claiming');
  assert.equal(f.published.at(-1).command.action, 'claim');
  assert.equal(Object.hasOwn(f.published.at(-1).command, 'purpose'), false);
  f.at(BASE + 1000);
  f.state({ mode: 'ready', authority: { ownerSession: 'invented-host', controlAllowed: true } });
  assert.equal((await f.adapter.plannerTick({ ...request, now: BASE + 1000 })).status, 'published');
  assert.equal(f.published.at(-1).command.action, 'start');
  assert.equal(Object.hasOwn(f.published.at(-1).command, 'purpose'), false);
  assert.ok(f.published.at(-1).command.requestedExpiryAt <= BASE + 120_000);
  const disabled = fixture();
  disabled.state({ mode: 'monitoring', authority: { ownerSession: 'invented-host', controlAllowed: false } });
  const refused = await disabled.start();
  assert.equal(refused.status, 'blocked');
  assert.ok(refused.reasons.includes('adapter-monitoring'));
  assert.equal(disabled.published.length, 0);
  await assert.rejects(disabled.adapter.plannerTick({ ...request, purpose: 'manual' }), /Unsupported Garage pause request/);
});

test('software release-ordering qualification is required independently of installed commissioning', async () => {
  const f = fixture(); f.state({ capabilities: { ...TEMPLATE.capabilities, releaseOrdering: false } });
  assert.ok((await f.start()).reasons.includes('essential-capability-unverified'));
  assert.equal(f.published.length, 0);
});

test('mixed retired proof, baseline and capability fields invalidate an otherwise current production state', async () => {
  for (const patch of [
    { commissioning: { selectivePowerVerified: true, expiryVerified: true, restartVerified: true, lowHeatVerified: false } },
    { commissioning: { selectivePowerVerified: true, expiryVerified: true, restartVerified: true, releaseOrderingVerified: true } },
    { baseline: { ...TEMPLATE.baseline, assumed: true } },
    { baseline: { ...TEMPLATE.baseline, candidateMatched: true } },
    { capabilities: { ...TEMPLATE.capabilities, preserveNativeBaseline: true } },
    { authority: { ownerSession: 'invented-host', controlAllowed: true, manualPauseAllowed: true } },
    { mode: 'armed' },
    { lease: { purpose: 'automatic' } },
  ]) {
    const f = fixture(); f.state(); assert.equal(f.adapter.status().pauseControl, true);
    f.at(BASE + 1000); f.state(patch);
    assert.equal(f.adapter.status().pauseControl, false);
    assert.equal(f.adapter.status().targetIdentity, null);
    assert.ok(f.adapter.status().faults.includes('invalid-adapter-state'));
    assert.equal((await f.start()).status, 'blocked');
    assert.equal(f.published.length, 0);
  }
});


test('saved retired wire purpose requires explicit reconciliation rather than a compatibility decoder', () => {
  assert.throws(() => fixture({ adapter: { persisted: { episode: { id: 'retired-pause', purpose: 'manual' } } } }),
    /Unsupported saved Garage pause contract.*physical restoration/);
});


test('ownership acquisition requires a current bounded pause intention and thermal readiness', async () => {
  for (const patch of [{ plan: null }, { recoveryReady: false }, { valid: false },
    { plan: { id: 'expired', pauseFrom: BASE - 1000, pauseUntil: BASE, temperatureEvidenceAt: BASE, permissionExpiresAt: BASE + 1000 } }]) {
    const f = fixture(); f.state({ authority: { ownerSession: null, controlAllowed: true } });
    await f.adapter.plannerTick({ now: BASE, valid: true, recoveryReady: true,
      plan: { id: 'current', pauseFrom: BASE, pauseUntil: BASE + 60000,
        temperatureEvidenceAt: BASE, permissionExpiresAt: BASE + 60000 }, ...patch });
    assert.equal(f.published.length, 0);
  }
});
