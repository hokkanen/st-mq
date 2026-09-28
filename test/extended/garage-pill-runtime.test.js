import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createGarageAdapter } from '../../src/garage/adapter.js';
import { createShellyCn105Transport } from '../../src/garage/shelly-cn105.js';
import { GarageRoomTemperature } from '../../src/garage/room-temperature.js';

// Explicit external artifact, never a copied driver or a real device connection.
// Build shelly-cn105-mqtt first, then set STMQ_PILL_ARTIFACT to dist/driver.js.
const artifact = process.env.STMQ_PILL_ARTIFACT;
const EPOCH = Date.UTC(2026, 8, 28);
const prefix = 'synthetic/pill-integration';
const settings = { driver: 'shelly-cn105', stateTopic: `${prefix}/state`,
  telemetryTopic: `${prefix}/telemetry`, commandTopic: `${prefix}/command` };

function installation(t, { phase = 0, readDelay = 0 } = {}) {
  let uptime = 10000 + phase, callback, wallOffset = 0, commandDelay = 0, withhold = false;
  const pending = [], reports = [], commands = [], events = [];
  const storage = { cn105_config: { prefix, profile: 'msz-ge', manualEnabled: true,
    externalTemperatureEnabled: true, armed: false } };
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
    clock: () => EPOCH + uptime, onDiagnostic: event => events.push(event),
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
    else if (p.kind === 'external' || p.kind === 'manual') callback(context.CN105.frame(0x61, [0]));
    else if (p.kind === 'info') {
      const fields = Array(16).fill(0); fields[0] = p.info;
      if (p.info === 2) Object.assign(fields, { 3: 1, 4: 1, 5: 14, 6: 0, 7: 3 });
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
