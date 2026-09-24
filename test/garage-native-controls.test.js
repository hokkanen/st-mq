import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';
import { SHELLY_CN105_CONTRACT } from '../src/garage/contract.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'invented/native/state',
  telemetryTopic: 'invented/native/telemetry', commandTopic: 'invented/native/command' };
const INITIAL = { power: 'on', mode: 'heat', targetC: 10, fan: 'auto', vane: 3, wideVane: 'center', vanes: 'fixed' };
function fixture(t, options = {}) {
  let now = BASE, sequence = 0, owner = true;
  const published = [], saved = [], observations = [];
  const store = new Store(':memory:');
  const config = { input: 'mqtt', garage: { enabled: false, adapter: SETTINGS } };
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'shadow' } };
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now, canControl: () => owner });
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'invented-owner', clock: () => now,
    canControl: () => owner, persisted: options.persisted,
    onState: snapshot => { options.onState?.(snapshot); saved.push(snapshot); runtime.adapterChanged(snapshot); },
    onObservation: row => observations.push(row),
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (topic, payload, opts) => {
      published.push({ topic, command: JSON.parse(payload), options: opts }); await options.publish?.();
    } }) });
  runtime.setAdapter(adapter); adapter.setConnected(true);
  function state(patch = {}, packet = {}) {
    const value = structuredClone(TEMPLATE);
    Object.assign(value, { sequence: ++sequence, observedAt: now, mode: 'monitoring',
      authority: { ownerSession: null, controlAllowed: false, manualControlAllowed: true },
      native: Object.fromEntries(Object.entries(INITIAL).map(([key, value]) => [key, { value, measuredAt: now }])),
      challenge: { value: `invented-manual-${sequence}`, expiresAt: now + 30_000 },
      manualPending: false, result: null, ...patch });
    for (const field of Object.values(value.health)) field.measuredAt = now;
    value.capabilities = { ...value.capabilities, manualControls: Object.fromEntries(
      ['power', 'mode', 'targetC', 'fan', 'vane', 'wideVane'].map(key => [key, true])), targetStep: 1, ...patch.capabilities };
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  function result(status, patch = {}) {
    const command = published.at(-1).command;
    const [setting, value] = Object.entries(command.settings)[0];
    const native = Object.fromEntries(Object.entries({ ...INITIAL, [setting]: value }).map(([key, value]) => [key, { value, measuredAt: now }]));
    return state({ authority: { ownerSession: command.ownerSession, controlAllowed: false, manualControlAllowed: true },
      native, manualPending: status === 'accepted', result: { action: 'manual', commandId: command.commandId,
        sequence: command.sequence, ownerSession: command.ownerSession, status }, ...patch });
  }
  state();
  t.after(async () => { await runtime.close({ restore: false }); await adapter.close({ restore: false }); store.close(); });
  return { adapter, runtime, store, engine, config, published, saved, observations, state, result,
    at(value) { now = value; }, owner(value) { owner = value; }, now: () => now };
}

test('ordinary native controls work in monitoring/shadow with economic control disabled, without an automatic claim or lease', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.status().automaticControl, false);
  assert.equal(f.runtime.status().nativeControls.available, true);
  assert.equal(f.published.length, 0);
  await f.runtime.setNativeSettings({ setting: 'power', value: 'off' });
  const sent = f.published[0];
  assert.equal(sent.topic, SETTINGS.commandTopic);
  assert.deepEqual(sent.options, { qos: 0, retain: false, noReplay: true });
  assert.equal(sent.command.action, 'manual');
  assert.equal(sent.command.schema, SHELLY_CN105_CONTRACT);
  assert.deepEqual(sent.command.settings, { power: 'off' });
  assert.equal(sent.command.episodeId, undefined);
  assert.equal(sent.command.requestedExpiryAt, undefined);
  assert.equal(f.adapter.snapshot().restorePending, false);
  assert.equal(f.adapter.status().lastCommand, null);
  assert.equal(f.runtime.status().nativeControls.result.status, 'published');
  assert.equal(f.runtime.status().nativeControls.pending, true);
  assert.ok(f.saved.some(row => row.lastNativeCommand?.status === 'pending'));
  await f.adapter.close();
  assert.equal(f.published.length, 1, 'an ordinary owner OFF selection must not manufacture restoration');
});

test('all ordinary native settings use exact typed enums and advertised target step', async t => {
  const f = fixture(t);
  for (const [setting, value] of [['power', 'on'], ['mode', 'cool'], ['targetC', 21], ['fan', 4], ['vane', 'swing'], ['wideVane', 'far-left']]) {
    await f.runtime.setNativeSettings({ setting, value });
    f.at(f.now() + 1000); f.result('native-confirmed');
    const controls = f.runtime.status().nativeControls;
    assert.equal(controls.result.status, 'native-confirmed', setting);
    assert.equal(controls.settings[setting].value, value);
    assert.equal(controls.result.nativeConfirmedAt, f.now());
  }
  f.state({ capabilities: { targetStep: .5 } });
  await f.adapter.setNativeSetting({ setting: 'targetC', value: 20.5 });
  assert.deepEqual(f.published.at(-1).command.settings, { targetC: 20.5 });
});

test('ordinary request validation rejects aliases, extra fields, wrong types and unsupported target encoding', async t => {
  const f = fixture(t);
  for (const input of [{ setting: 'targetC', value: 10 }, { setting: 'targetC', value: 20.5 },
    { setting: 'targetC', value: 32 }, { setting: 'targetC', value: '20' }, { setting: 'fan', value: '4' },
    { setting: 'fan', value: 5 }, { setting: ['power'], value: 'off' }, { setting: 'vanes', value: 'fixed' }, { setting: 'mode', value: 'HEAT' },
    { setting: 'power', value: 'off', holdMs: 1000 }, { settings: { power: 'off' } }])
    await assert.rejects(f.runtime.setNativeSettings(input));
  assert.equal(f.published.length, 0);
  f.state({ capabilities: { targetStep: null } });
  assert.equal(f.runtime.status().nativeControls.settings.targetC.available, false);
  assert.equal(f.runtime.status().nativeControls.settings.power.available, true);
});

test('installed advertised options restrict both public choices and command admission without changing generic compatibility', async t => {
  const f = fixture(t);
  f.state({ capabilities: { manualOptions: { fan: ['auto', 1, 2, 3, 4], mode: ['heat', 'cool', 'dry', 'auto'] },
    manualControls: { power: true, mode: true, targetC: true, fan: true, vane: true, wideVane: false } } });
  let controls = f.runtime.status().nativeControls;
  assert.deepEqual(controls.settings.fan.values, ['auto', 1, 2, 3, 4]);
  assert.deepEqual(controls.settings.mode.values, ['heat', 'cool', 'auto', 'dry']);
  assert.equal(controls.settings.wideVane.supported, false);
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'fan', value: 'quiet' }), /does not support/);
  await assert.rejects(f.adapter.setNativeSetting({ setting: 'mode', value: 'fan' }), /does not support/);
  assert.equal(f.published.length, 0);
  await f.runtime.setNativeSettings({ setting: 'fan', value: 1 });
  assert.deepEqual(f.published[0].command.settings, { fan: 1 });
  f.at(BASE + 1000); f.result('native-confirmed');
  controls = f.runtime.status().nativeControls;
  assert.ok(controls.settings.fan.values.includes('quiet'), 'missing optional metadata retains the generic contract');
});

test('malformed option metadata disables only the affected choice set and cannot widen the contract', async t => {
  for (const choices of [null, [], ['auto', 'quiet', 1, 2, 3, 4, 5], ['auto', 'auto'], ['AUTO'], ['auto', '1'], 'auto', {}]) {
    const f = fixture(t); f.state({ capabilities: { manualOptions: { fan: choices } } });
    const controls = f.runtime.status().nativeControls;
    assert.equal(controls.settings.fan.supported, false);
    assert.equal(controls.settings.fan.available, false);
    assert.deepEqual(controls.settings.fan.values, []);
    assert.equal(controls.settings.power.available, true);
    await assert.rejects(f.adapter.setNativeSetting({ setting: 'fan', value: 'auto' }));
    assert.equal(f.published.length, 0);
  }
  for (const manualOptions of [null, [], 'invalid']) {
    const f = fixture(t); f.state({ capabilities: { manualOptions } });
    assert.equal(f.runtime.status().nativeControls.settings.power.available, false);
  }
});

test('native controls independently gate unsupported settings and require fresh exact readbacks', async t => {
  const f = fixture(t);
  f.state({ capabilities: { manualControls: { power: true, mode: true, targetC: true, fan: true, vane: true, wideVane: false } } });
  assert.equal(f.runtime.status().nativeControls.settings.wideVane.supported, false);
  assert.equal(f.runtime.status().nativeControls.settings.power.available, true);
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'wideVane', value: 'center' }), /not supported/);
  const native = structuredClone(TEMPLATE.native);
  native.power = { value: 'on', measuredAt: BASE - 120_000 };
  f.state({ native });
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'power', value: 'off' }), /fresh native/);
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'vane', value: 1 }), /fresh native/);
  assert.equal(f.published.length, 0);
});

test('disabled authority, foreign owner, maintenance, commissioning, retained and stale sessions cannot manually control', async t => {
  const patches = [
    { authority: { ownerSession: null, controlAllowed: true, manualControlAllowed: false } },
    { authority: { ownerSession: 'invented-other', controlAllowed: false, manualControlAllowed: true } },
    { mode: 'maintenance' }, { mode: 'commissioning' }, { observedAt: BASE - 120_000 },
    { manualPending: true }, { challenge: null },
  ];
  for (const patch of patches) {
    const f = fixture(t);
    if (patch.observedAt !== undefined) f.at(BASE + 120_000);
    f.state(patch);
    await assert.rejects(f.runtime.setNativeSettings({ setting: 'power', value: 'off' }));
    assert.equal(f.published.length, 0);
  }
  const retained = fixture(t); retained.state({}, { retain: true });
  await assert.rejects(retained.adapter.setNativeSetting({ setting: 'power', value: 'off' }));
  const replica = fixture(t); replica.owner(false);
  await assert.rejects(replica.runtime.setNativeSettings({ setting: 'power', value: 'off' }), /own device control/);
  const disconnected = fixture(t); disconnected.adapter.setConnected(false);
  await assert.rejects(disconnected.runtime.setNativeSettings({ setting: 'power', value: 'off' }));
});

test('native confirmation requires a matching command and a later exact field observation; an acceptance is not confirmation', async t => {
  const f = fixture(t);
  await f.runtime.setNativeSettings({ setting: 'mode', value: 'cool' });
  f.at(BASE + 1000); f.result('accepted');
  assert.equal(f.runtime.status().nativeControls.result.status, 'accepted');
  assert.equal(f.runtime.status().nativeControls.result.nativeConfirmedAt, null);
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'power', value: 'off' }), /current garage request/);
  f.at(BASE + 2000);
  const native = { mode: { value: 'cool', measuredAt: BASE - 1 }, power: { value: 'on', measuredAt: BASE + 2000 } };
  f.result('native-confirmed', { native });
  assert.equal(f.runtime.status().nativeControls.result.status, 'uncertain');
  f.at(BASE + 3000); f.result('native-confirmed');
  assert.equal(f.runtime.status().nativeControls.result.status, 'native-confirmed');
  assert.equal(f.runtime.status().nativeControls.result.reason, null);
  f.result('accepted');
  assert.equal(f.runtime.status().nativeControls.result.status, 'native-confirmed', 'old acknowledgements cannot undo confirmed evidence');
});

test('retained and wrong-owner command results never confirm a pending ordinary request', async t => {
  const f = fixture(t);
  await f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
  f.at(BASE + 1000);
  const value = f.result('native-confirmed', { result: { action: 'manual', commandId: f.published[0].command.commandId,
    sequence: f.published[0].command.sequence, status: 'native-confirmed', ownerSession: 'invented-other' } });
  assert.equal(f.adapter.nativeControls().result.status, 'published');
  value.result.ownerSession = 'invented-owner'; value.sequence++;
  f.adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), { retain: true }, f.now());
  assert.equal(f.adapter.nativeControls().result.status, 'published');
});

test('a result copied across an adapter restart cannot confirm an old command', async t => {
  const f = fixture(t);
  await f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
  f.at(BASE + 1000); f.result('native-confirmed', { bootId: 'invented-restarted-boot', sessionId: 'invented-restarted-session' });
  assert.equal(f.adapter.nativeControls().result.status, 'uncertain');
  assert.equal(f.adapter.nativeControls().result.reason, 'adapter-session-changed');
  assert.equal(f.adapter.nativeControls().result.nativeConfirmedAt, null);
});

test('uncertain delivery is never replayed; timeouts, disconnect and restart remain explicit', async t => {
  const lost = fixture(t, { publish: async () => { throw Error('invented disconnect'); } });
  assert.equal((await lost.adapter.setNativeSetting({ setting: 'fan', value: 'quiet' })).status, 'uncertain');
  assert.equal(lost.published.length, 1);
  const f = fixture(t); await f.adapter.setNativeSetting({ setting: 'vane', value: 2 });
  f.at(BASE + 45_000);
  assert.equal(f.adapter.nativeControls().result.reason, 'native-readback-timeout');
  const restarted = fixture(t, { persisted: f.adapter.snapshot() });
  assert.equal(restarted.adapter.nativeControls().result.reason, 'host-restarted');
  assert.equal(restarted.published.length, 0);
  f.adapter.setConnected(false);
  assert.equal(f.adapter.nativeControls().result.reason, 'mqtt-disconnected');
});

test('failed persistence prevents publication and concurrent requests cannot share a challenge', async t => {
  let fail = false;
  const f = fixture(t, { onState: snapshot => { if (fail && snapshot.lastNativeCommand?.status === 'pending') throw Error('invented storage failure'); } });
  fail = true;
  await assert.rejects(f.adapter.setNativeSetting({ setting: 'power', value: 'off' }), /storage failure/);
  assert.equal(f.published.length, 0);
  fail = false;
  await assert.rejects(f.adapter.setNativeSetting({ setting: 'power', value: 'off' }), /fresh device challenge/);
  f.state();
  const first = f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
  await assert.rejects(f.adapter.setNativeSetting({ setting: 'fan', value: 'auto' }), /current native command/);
  await first;
  assert.equal(f.published.length, 1);
});

test('pending native settings cannot be followed by an automatic lease even with all economic proofs', async t => {
  const f = fixture(t);
  f.state({ mode: 'armed', authority: { ownerSession: 'invented-owner', controlAllowed: true, manualControlAllowed: true },
    commissioning: { selectivePowerVerified: true, lowHeatVerified: true, expiryVerified: true, restartVerified: true, releaseOrderingVerified: true },
    baseline: { verified: true, profile: 'existing-low-heat', targetC: 10, fan: 'auto', vanes: 'fixed', measuredAt: BASE },
    capabilities: { preserveNativeBaseline: true } });
  await f.adapter.setNativeSetting({ setting: 'power', value: 'off' });
  const result = await f.adapter.plannerTick({ now: BASE, valid: true, recoveryReady: true,
    plan: { id: 'invented-plan', pauseFrom: BASE, pauseUntil: BASE + 600_000,
      temperatureEvidenceAt: BASE, permissionExpiresAt: BASE + 180_000 } });
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('manual-setting-pending'));
  assert.deepEqual(f.published.map(row => row.command.action), ['manual']);
});

test('a managed pause is restored before ordinary native settings can change', async t => {
  const f = fixture(t);
  f.state({ authority: { ownerSession: 'invented-owner', controlAllowed: false, manualControlAllowed: true },
    restorationPending: true, lease: { episodeId: 'invented-economic', endpointAt: BASE + 120_000, expiresAt: BASE + 60_000 } });
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'mode', value: 'cool' }), /managed pause to restore/);
  assert.deepEqual(f.published.map(row => row.command.action), ['release']);
});

test('all streamed optional values retain their own clocks and diagnostic qualification without electrical accounting', t => {
  const f = fixture(t);
  const fields = { energyCounterRaw: [1234, 'count'], actualFan: [3, 'stage'], preheat: [false, null],
    standby: [true, null], faultRaw: ['00000100', null] };
  let sequence = 1;
  for (const [key, [value, unit]] of Object.entries(fields)) {
    f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ schema: SHELLY_CN105_CONTRACT,
      deviceId: TEMPLATE.deviceId, bootId: TEMPLATE.bootId, sequence: sequence++, observedAt: BASE,
      fields: { [key]: { value, unit, supported: true, decodeVerified: false, quality: 'observed-unverified', measuredAt: BASE - 2000 } } }));
  }
  const telemetry = f.runtime.status().adapter.telemetry;
  for (const [key, [value]] of Object.entries(fields)) {
    assert.equal(telemetry[key].value, value, key);
    assert.equal(telemetry[key].sourceTime, BASE - 2000);
    assert.equal(telemetry[key].usable, false);
    assert.ok(telemetry[key].quality.includes('observed-unverified'));
  }
  assert.equal(telemetry.energy, undefined);
  assert.equal(f.observations.length, 0);
});

test('public production status retains unavailable diagnostics without qualifying controls or learning', async t => {
  const f = fixture(t);
  f.state({ native: { power: { value: 'on', measuredAt: BASE }, vane: { value: null, measuredAt: BASE - 2000 } } });
  assert.deepEqual(Object.keys(f.adapter.status().native.readbacks), ['power', 'vane']);
  assert.deepEqual(f.adapter.status().native.readbacks.vane, { value: null, measuredAt: BASE - 2000 });
  assert.equal(Object.hasOwn(f.adapter.status().native, 'vane'), false);
  assert.equal(f.runtime.status().nativeControls.settings.vane.usable, false);
  await assert.rejects(f.runtime.setNativeSettings({ setting: 'vane', value: 1 }), /fresh native/);
  assert.equal(f.published.length, 0);
  const field = (value, unit, quality = 'observed-unverified', supported = true) => ({ value, unit, quality,
    supported, decodeVerified: true, measuredAt: BASE - 2000 });
  f.adapter.receive(SETTINGS.telemetryTopic, JSON.stringify({ schema: SHELLY_CN105_CONTRACT,
    deviceId: TEMPLATE.deviceId, bootId: TEMPLATE.bootId, sequence: 1, observedAt: BASE,
    fields: { indoorTemperature: field(12, 'degC'), power: field(0, 'W', 'unknown'),
      energy: field(null, 'kWh', 'unsupported', false), compressorFrequency: field(null, 'Hz', 'unknown'),
      compressorActive: field(true, null, 'invalid'), defrost: field(false, null, 'unknown') } }));
  let status = f.adapter.status();
  assert.equal(status.telemetry.indoorTemperature.value, 12);
  for (const [key, value, quality] of [['power', 0, 'unknown'], ['energy', null, 'unsupported'],
    ['compressorFrequency', null, 'unknown'], ['compressorActive', true, 'invalid'], ['defrost', false, 'unknown']]) {
    const reading = status.telemetry[key];
    assert.equal(reading.value, value, key);
    assert.equal(reading.sourceTime, BASE - 2000, key);
    assert.equal(reading.receivedAt, BASE, key);
    assert.equal(reading.usable, false, key);
    assert.ok(reading.quality.includes(quality), key);
  }
  assert.equal(status.telemetry.energy.supported, false);
  assert.equal(status.telemetry.garage_compressor_active, status.telemetry.compressorActive);
  assert.equal(status.telemetry.outdoorTemperature, undefined, 'Never-received reports remain absent from the API');
  assert.equal(status.native.compressorActive, undefined, 'Invalid diagnostics do not become qualified native activity');
  assert.equal(status.native.defrost, undefined);
  assert.equal(f.runtime.read().activity, null);
  assert.equal(f.runtime.read().powerKw, null);
  assert.equal(f.observations.find(row => row.signal === 'garage_compressor_active').value, null,
    'Invalid compressor state remains a history gap');
  status.native.readbacks.vane.measuredAt = 0;
  assert.equal(f.adapter.status().native.readbacks.vane.measuredAt, BASE - 2000,
    'Diagnostic status cannot mutate retained native evidence');
  f.at(BASE + 120_000); status = f.adapter.status();
  assert.equal(status.telemetry.indoorTemperature.value, 12);
  assert.ok(status.telemetry.indoorTemperature.quality.includes('stale'));
  assert.equal(status.native.readbacks.power.measuredAt, BASE);
  assert.equal(status.telemetry.compressorActive.sourceTime, BASE - 2000);
  assert.ok(status.telemetry.compressorActive.quality.includes('stale'));
  assert.ok(status.telemetry.compressorActive.quality.includes('invalid'));
});

test('ordinary Mitsubishi HTTP route uses shared write authorization and returns pending native status', async t => {
  const f = fixture(t);
  const app = { engine: { garage: f.runtime, status: () => ({ garage: f.runtime.status() }) },
    store: f.store, chartService: { overview: async () => ({ rows: [] }) } };
  const servers = [];
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); });
  async function serve(role = 'primary') {
    const server = createAppServer({ ...app, role }); servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return (input, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/garage/native`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  }
  const post = await serve();
  assert.equal((await post({ setting: 'targetC', value: 10 })).status, 400);
  assert.equal((await post({ setting: 'power', value: 'off' }, { Origin: 'http://invented.invalid' })).status, 403);
  const replica = await serve('replica');
  assert.equal((await replica({ setting: 'power', value: 'off' })).status, 405);
  assert.equal(f.published.length, 0);
  const response = await post({ setting: 'power', value: 'off' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).garage.nativeControls.result.status, 'published');
  assert.equal(f.published.length, 1);
});

test('explicit Normal heating from unmanaged OFF publishes ordinary ON with correlated readback', async t => {
  const f = fixture(t); f.runtime.settings.enabled = true; f.engine.settings.mode = 'active';
  f.state({ native: { power: { value: 'off', measuredAt: BASE } } });
  assert.equal(f.adapter.status().restorePending, false);
  await f.runtime.setHeating({ mode: 'normal' });
  const command = f.published.at(-1).command;
  assert.equal(command.action, 'manual'); assert.deepEqual(command.settings, { power: 'on' });
  assert.equal(f.runtime.heatingControls().requestedMode, 'normal');
  assert.equal(f.runtime.heatingControls().confirmed, false);
  f.at(BASE + 1000); f.result('native-confirmed');
  assert.equal(f.runtime.heatingControls().confirmed, true);
  assert.equal(f.adapter.status().restorePending, false);
});

test('unmanaged OFF Normal rejects missing power capability before persisting manual intent', async t => {
  const f = fixture(t); f.runtime.settings.enabled = true; f.engine.settings.mode = 'active';
  f.state({ native: { power: { value: 'off', measuredAt: BASE } }, capabilities: { manualControls: { power: false } } });
  assert.equal(f.runtime.heatingControls().normalAvailable, false);
  await assert.rejects(f.runtime.setHeating({ mode: 'normal' }), /not supported/);
  assert.equal(f.runtime.manual, null); assert.equal(f.published.length, 0);
});
