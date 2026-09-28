import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createGarageAdapter } from '../../src/garage/adapter.js';
import { createShellyCn105Transport } from '../../src/garage/shelly-cn105.js';
import { GarageRuntime } from '../../src/garage/runtime.js';
import { Store } from '../../src/storage/store.js';
import { knownGarageReserve } from '../helpers/garage-reserve-fixture.js';
import { GarageRoomTemperature } from '../../src/garage/room-temperature.js';

// Explicit external artifact, never a copied driver or a real device connection.
// Build shelly-cn105-mqtt first, then set STMQ_PILL_ARTIFACT to dist/driver.js.
const artifact = process.env.STMQ_PILL_ARTIFACT;
const EPOCH = Date.UTC(2026, 8, 28);
const prefix = 'synthetic/pill-integration';
const settings = { driver: 'shelly-cn105', stateTopic: `${prefix}/state`,
  telemetryTopic: `${prefix}/telemetry`, commandTopic: `${prefix}/command` };

function installation(t, { phase = 0, readDelay = 0, commissioned = false, onState = () => {} } = {}) {
  let uptime = 10000 + phase, callback, wallOffset = 0, commandDelay = 0, withhold = false;
  const pending = [], reports = [], commands = [], events = [];
  let pumpOn = true;
  const storage = { cn105_config: { prefix, profile: 'msz-ge', manualEnabled: true,
    externalTemperatureEnabled: true, pauseEnabled: commissioned } };
  if (commissioned) storage.cn105_proof = { selectivePowerVerified: true, expiryVerified: true, restartVerified: true };
  const context = vm.createContext({
    Shelly: {
      getDeviceInfo: () => ({ id: 'synthetic-pill', ver: 'synthetic-firmware' }),
      getUptimeMs: () => uptime,
      getComponentStatus() {
        const unixtime = Math.floor((EPOCH + uptime + wallOffset) / 1000);
        uptime += readDelay;
        return { unixtime };
      },
      call: (method, args, cb, userData) => pending.push({ method, args, cb, userData }),
    },
    Timer: { set: () => 1, clear() {} },
    UART: { get: () => ({ configure() {}, recv(cb) { callback = cb; },
      send: bytes => bytes.length }) },
    MQTT: { isConnected: () => true, subscribe: () => true,
      publish(topic, payload) { reports.push({ topic, payload }); return true; } },
  });
  const adapter = createGarageAdapter({ settings, hostSession: 'synthetic-controller',
    clock: () => EPOCH + uptime, onState, onDiagnostic: event => events.push(event),
    productionTransport: createShellyCn105Transport({ settings, publish: async (topic, payload) => {
      commands.push(JSON.parse(payload)); uptime += commandDelay;
      context.cnCommand(topic, payload);
    } }) });
  adapter.setConnected(true);
  t.after(() => adapter.close({ restore: false }));
  vm.runInContext(readFileSync(artifact, 'utf8'), context);
  function flush() {
    let budget = 50;
    while (pending.length) {
      assert.ok(budget-- > 0, 'bounded flash callback chain');
      const { method, args, cb, userData } = pending.shift();
      if (method === 'KVS.Get') cb({ value: storage[args.key] }, Object.hasOwn(storage, args.key) ? 0 : -105, '', userData);
      else if (method === 'KVS.Set') { storage[args.key] = args.value; cb({}, 0, '', userData); }
      else assert.fail(`Unexpected RPC ${method}`);
    }
  }
  function deliver() {
    if (withhold) return;
    while (reports.length) {
      const r = reports.shift();
      adapter.receive(r.topic, r.payload, {}, EPOCH + uptime);
    }
  }
  function reply() {
    const p = context.CN105_PENDING;
    if (!p || p.offset !== p.bytes.length) return;
    if (p.kind === 'connect') callback(context.CN105.frame(0x7a, [0]));
    else if (p.kind === 'power') { pumpOn = p.effect.on; callback(context.CN105.frame(0x61, [0])); }
    else if (p.kind === 'external' || p.kind === 'manual') callback(context.CN105.frame(0x61, [0]));
    else if (p.kind === 'info') {
      const fields = Array(16).fill(0); fields[0] = p.info;
      if (p.info === 2) Object.assign(fields, { 3: pumpOn ? 1 : 0, 4: 1, 5: 14, 6: 0, 7: 3 });
      callback(context.CN105.frame(0x62, fields));
    } else assert.fail(`Unexpected actuation ${p.kind}`);
  }
  function step(ms = 500) { uptime += ms; context.cnTick(); reply(); flush(); deliver(); }
  function run(ms) { const until = uptime + ms; while (uptime < until) step(); }
  function publish(staleLoopMs = 0) { context.cnPublish(uptime - staleLoopMs); deliver(); }
  flush(); run(5000); publish();
  return { adapter, context, commands, events, storage, run, step, publish,
    now: () => EPOCH + uptime, uptime: () => uptime,
    wallStep(ms) { wallOffset += ms; },
    transportDelay(ms) { commandDelay = ms; },
    withholdReports(value) { withhold = value; if (!value) deliver(); },
    sample: (duration = 120000) => ({ temperatureC: 27, measuredAt: EPOCH + uptime,
      requestedExpiryAt: EPOCH + uptime + duration }) };
}

test('compiled Pill and controller agree on quantized expiry across slow clock reads and stale loop instants',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    for (const phase of [0, 100, 900, 999]) for (const readDelay of [0, 100, 1200]) {
      await t.test(`phase ${phase}, clock read ${readDelay} ms`, async t => {
        const h = installation(t, { phase, readDelay }), sample = h.sample();
        assert.equal(h.adapter.externalTemperature().available, true);
        await h.adapter.setExternalTemperature(sample);
        h.run(15000); h.publish(2500);
        const external = h.adapter.externalTemperature();
        assert.equal(external.result.status, 'acknowledged', JSON.stringify({host: external.result, device: h.context.CN105_POLICY.external, result: h.context.CN105_LAST_RESULT}));
        assert.ok(h.context.CN105_POLICY.external.until + EPOCH <= sample.requestedExpiryAt,
          'physical monotonic permission does not exceed the requested deadline');
        assert.ok(external.continuation.expiresAt <= sample.requestedExpiryAt);
        assert.equal(h.events.some(e => /expiry/.test(e.reason)), false);
        h.run(45000); h.publish(2500);
        assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged',
          'the original 45-second timeout does not clear a valid acknowledged sample');
        assert.equal(h.commands.length, 1);
      });
    }
  });

test('an advertised unused challenge remains valid beyond the old 15-second rotation',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t);
    h.withholdReports(true); h.run(16000);
    assert.equal(h.adapter.externalTemperature().available, true);
    await h.adapter.setExternalTemperature(h.sample());
    h.withholdReports(false); h.run(7000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(h.commands.length, 1, 'a valid advertised challenge needs no replacement command');
    assert.equal(h.events.some(e => e.reason === 'challenge'), false);
  });

test('a delayed clear rejected by the compiled Pill waits for an eligible challenge and then completes',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t, { phase: 100, readDelay: 100 });
    await h.adapter.setExternalTemperature(h.sample()); h.run(15000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    const expiry = h.context.CN105_POLICY.external.until;
    h.transportDelay(31000);
    await h.adapter.setExternalTemperature({ temperatureC: null }); h.step(); h.publish();
    assert.equal(h.adapter.externalTemperature().result.reason, 'challenge');
    assert.equal(h.adapter.externalTemperature().clearAvailable, false);
    assert.equal(h.context.CN105_POLICY.external.until, expiry, 'a rejected clear never renews the sample');
    h.transportDelay(0); h.run(5000); h.publish();
    assert.equal(h.adapter.externalTemperature().clearAvailable, true);
    await h.adapter.setExternalTemperature({ temperatureC: null }); h.run(10000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(h.context.CN105_POLICY.external.phase, 'internal');
    assert.equal(h.storage.cn105_external.external_pending, false);
    assert.equal(h.commands.length, 3, 'one numeric sample and two explicit clear attempts');
  });

test('compiled Pill expiry remains bounded through repeated renewal, wall-clock change and local cleanup',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t, { phase: 999, readDelay: 100 });
    for (let i = 0; i < 12; i++) {
      const sample = h.sample();
      await h.adapter.setExternalTemperature(sample); h.run(18000); h.publish(2000);
      assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
      assert.ok(EPOCH + h.context.CN105_POLICY.external.until <= sample.requestedExpiryAt);
    }
    const expiry = h.context.CN105_POLICY.external.until;
    h.wallStep(-30000); h.run(15000);
    assert.equal(h.context.CN105_POLICY.external.until, expiry, 'UTC steps do not extend a local permission');
    h.run(expiry - h.uptime() + 12000);
    assert.equal(h.context.CN105_POLICY.external.phase, 'internal');
    assert.equal(h.storage.cn105_external.external_pending, false, 'serial ACK precedes durable cleanup');
    assert.equal(h.commands.length, 12, 'no renewal or cleanup command fabricated by the host fixture');
  });

test('the room controller sustains external sensing through quantized-clock renewals without unnecessary clearing',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t, { phase: 999, readDelay: 100 });
    const room = new GarageRoomTemperature({ targetC: 7, now: h.now() });
    let observedAt = h.now(), firstActive = null, commandCountAtFirstActive = 0;
    for (const stop = h.now() + 360000; h.now() < stop;) {
      h.step();
      if (h.now() - observedAt >= 30000) observedAt = h.now();
      const observation = { source: 'shelly-mqtt', device: 'synthetic-rear', value: 17,
        sourceTime: observedAt, receivedAt: observedAt, quality: [] };
      await h.adapter.safetyTick();
      await room.tick({ adapter: h.adapter, observation, now: h.now(), canControl: true,
        sourceUsable: true, sourceIdentity: 'synthetic-source',
        protection: { allowed: true, expiresAt: observedAt + 120000 },
        holdProtection: { allowed: true, expiresAt: observedAt + 120000 } });
      if (room.phase === 'active' && firstActive === null) {
        firstActive = h.now(); commandCountAtFirstActive = h.commands.length;
      }
      if (firstActive !== null) {
        assert.notEqual(h.context.CN105_POLICY.external.phase, 'internal');
        assert.equal(h.commands.slice(commandCountAtFirstActive).some(c => c.temperatureC === null), false);
      }
    }
    assert.notEqual(firstActive, null, 'the actual room controller establishes external sensing');
    assert.ok(h.commands.filter(c => typeof c.temperatureC === 'number').length >= 8,
      'multiple real host renewals traverse the production Pill handler');
    assert.equal(h.events.some(e => /expiry|challenge/.test(e.reason)), false);
  });

test('compiled Pill separates external control from bounded OFF and resumes only after restoration',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t, { commissioned: true });
    h.run(305000); h.publish();
    const sample = h.sample();
    await h.adapter.setExternalTemperature(sample); h.run(15000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    const plan = { id: 'separate-manual-pause', pauseFrom: h.now(), pauseUntil: h.now() + 120000,
      temperatureEvidenceAt: h.now(), permissionExpiresAt: h.now() + 90000 };
    const tick = () => h.adapter.plannerTick({ now: h.now(), valid: true, recoveryReady: true, plan });
    const blocked = await tick();
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.reasons.includes('external-temperature-busy'));
    await h.adapter.setExternalTemperature({ temperatureC: null }); h.run(15000); h.publish();
    assert.equal(h.adapter.externalTemperature().phase, 'internal');
    assert.equal(h.storage.cn105_external.external_pending, false);
    const started = await tick();
    assert.ok(['published', 'accepted', 'pending'].includes(started.status), JSON.stringify(started));
    h.run(15000); h.publish();
    assert.equal(h.adapter.status().phase, 'paused');
    assert.equal(h.context.CN105_NATIVE.power, 'OFF');
    assert.equal(h.storage.cn105_restore.restoration_pending, true);
    assert.equal(h.context.CN105_POLICY.external.phase, 'internal');
    await assert.rejects(h.adapter.setExternalTemperature(h.sample()), /restor|pause|native|OFF/i);
    await h.adapter.release({ reason: 'manual-normal', now: h.now() }); h.run(15000); h.publish();
    assert.equal(h.context.CN105_NATIVE.power, 'ON');
    assert.equal(h.storage.cn105_restore.restoration_pending, false);
    assert.equal(h.adapter.status().restorePending, false);
    await h.adapter.setExternalTemperature(h.sample()); h.run(15000); h.publish();
    assert.equal(h.context.CN105_POLICY.external.phase, 'active');
    assert.equal(h.adapter.externalTemperature().continuation.confirmed, true);
    assert.equal(h.context.CN105_NATIVE.target_c, 17);
  });

test('compiled Pill claims an unowned pause through the common capability and restores on permission expiry',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t, { commissioned: true }); h.run(305000); h.publish();
    const plan = { id: 'manual-expiry', pauseFrom: h.now(), pauseUntil: h.now() + 120000,
      temperatureEvidenceAt: h.now(), permissionExpiresAt: h.now() + 60000 };
    const tick = () => h.adapter.plannerTick({ now: h.now(), valid: true, recoveryReady: true, plan });
    assert.equal((await tick()).status, 'claiming');
    assert.equal(h.commands.at(-1).action, 'claim'); assert.equal(Object.hasOwn(h.commands.at(-1), 'purpose'), false);
    h.run(3000); h.publish();
    assert.equal((await tick()).status, 'published'); h.run(15000); h.publish();
    assert.equal(h.adapter.status().phase, 'paused'); assert.equal(h.context.CN105_NATIVE.power, 'OFF');
    const commands = h.commands.length;
    h.run(70000); h.publish();
    assert.equal(h.context.CN105_NATIVE.power, 'ON');
    assert.equal(h.storage.cn105_restore.restoration_pending, false);
    assert.equal(h.adapter.status().restorePending, false);
    assert.equal(h.commands.length, commands, 'device restores without another controller command');
    assert.equal(h.context.CN105_POLICY.pauseEnabled, true);
  });


test('full Garage runtime keeps a manual OFF request through persistence acceptance and delayed native OFF',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    for (const phase of [0, 174, 900]) await t.test(`publication phase ${phase}`, async t => {
      let runtime;
      const h = installation(t, { commissioned: true, phase, onState: snapshot => runtime?.adapterChanged(snapshot) });
      h.run(305000); h.publish();
      const store = new Store(':memory:'), engine = { latest: {}, automationEnabled: () => false };
      runtime = new GarageRuntime({ store, engine, clock: h.now,
        config: { input: 'mqtt', garage: { enabled: true, minOnMs: 0,
          protection: { approved: true }, adapter: settings } } });
      const current = runtime;
      t.after(async () => { runtime = null; await current.close({ restore: false }); store.close(); });
      runtime.setAdapter(h.adapter);
      runtime.exposure = knownGarageReserve(runtime.settings, { at: h.now(), rearC: 10, frontC: 10 });
      const measure = () => {
        for (const [signal, value] of [['garage_temperature', 10], ['garage_temperature_2', 10], ['outdoor_temperature', 5]])
          engine.latest[signal] = { signal, value, unit: 'degC', sourceTime: h.now(), receivedAt: h.now(),
            quality: ['good'], source: 'synthetic-temperature', device: signal, raw: {} };
      };
      measure();
      async function advance(ms) {
        const until = h.now() + ms;
        while (h.now() < until) {
          h.step(500);
          if (h.now() - engine.latest.garage_temperature.sourceTime >= 20000) measure();
          runtime.safetyTick();
          for (let i = 0; i < 4; i++) { await Promise.resolve(); await runtime.roomDispatch; }
        }
      }
      await runtime.setNativeSettings({ setting: 'targetC', value: 5 });
      await advance(45000);
      assert.equal(runtime.status().roomTemperature.acknowledged, true);
      await runtime.setTemporary({ pauseUntil: new Date(h.now() + 720000).toISOString() });
      const managedCommandsFrom = h.commands.length;
      await runtime.setHeating({ mode: 'off' });
      let sawAcceptedOn = false, sawConfirmedOff = false;
      for (let i = 0; i < 80; i++) {
        await advance(500);
        const state = h.adapter.status(), command = state.lastCommand;
        if (command?.action === 'start' && command.status === 'accepted' && state.native.power === 'on') sawAcceptedOn = true;
        if (command?.action === 'start' && command.status === 'native-confirmed' && state.native.power === 'off') {
          sawConfirmedOff = true; break;
        }
        assert.equal(h.commands.some(command => command.action === 'release'), false,
          JSON.stringify({ phase: state.phase, faults: state.faults, reasons: state.blockedReasons,
            manual: runtime.activeManual()?.mode ?? null, protection: runtime.protection?.reasons,
            lastPlannerAge: h.now() - runtime.lastPlannerAt,
            sourceBound: runtime.pauseTemperatureIdentity?.id === state.episode?.id }));
      }
      assert.equal(sawAcceptedOn, true, 'Actual device acceptance must precede OFF readback');
      assert.equal(sawConfirmedOff, true);
      assert.equal(runtime.heatingControls().confirmed, true);
      assert.equal(runtime.heatingControls().requestedMode, 'off');
      await advance(25000);
      assert.equal(h.context.CN105_NATIVE.power, 'OFF');
      assert.equal(h.context.CN105_POLICY.external.phase, 'internal');
      await runtime.setHeating({ mode: 'normal' });
      await advance(45000);
      assert.equal(h.context.CN105_NATIVE.power, 'ON');
      assert.equal(h.adapter.status().restorePending, false);
      assert.equal(h.context.CN105_POLICY.external.phase, 'active');
      const managed = h.commands.slice(managedCommandsFrom), offAt = managed.findIndex(command => command.action === 'start');
      assert.ok(offAt > 0);
      assert.ok(managed.slice(0, offAt).some(command => command.action === 'remote-temperature' && command.temperatureC === null));
      const onAt = managed.findIndex(command => command.action === 'release');
      assert.ok(managed.slice(offAt, onAt).every(command => command.action !== 'remote-temperature' || command.temperatureC === null));
      assert.ok(managed.slice(onAt).some(command => command.action === 'remote-temperature' && command.temperatureC !== null));
    });
  });

test('compiled Pill accepts a changed target offset on the same active original sample without extending expiry',
  { skip: !artifact && 'Set STMQ_PILL_ARTIFACT to the built Pill driver' }, async t => {
    const h = installation(t);
    const sample = h.sample(); sample.temperatureC = 17;
    await h.adapter.setExternalTemperature(sample); h.run(15000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    const originalDeadline = h.context.CN105_POLICY.external.until;
    await h.adapter.setExternalTemperature({ ...sample, temperatureC: 22,
      requestedExpiryAt: h.now() + 120000 }); h.run(15000); h.publish();
    assert.equal(h.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(h.adapter.externalTemperature().temperatureC, 22);
    assert.equal(h.adapter.externalTemperature().measuredAt, sample.measuredAt);
    assert.ok(h.context.CN105_POLICY.external.until <= originalDeadline);
    assert.equal(h.context.CN105_NATIVE.power, 'ON');
    assert.ok(h.commands.every(command => command.action === 'remote-temperature' && command.temperatureC !== null));
    await h.adapter.setExternalTemperature({ temperatureC: null }); h.run(15000); h.publish();
    await assert.rejects(h.adapter.setExternalTemperature({ ...sample, temperatureC: 17,
      requestedExpiryAt: h.now() + 60000 }), /newer original/);
  });
