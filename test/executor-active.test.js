import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../src/app/executor.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

function rig(t, { native = true, saved = new Map(), publishLegacy, publishDhwr, config = {} } = {}) {
  let now = Date.parse('2026-09-07T12:00Z');
  const log = [], observations = [], values = { '0203': 19, '0212': 47, '0208': 62, '2201': 1 };
  const store = { getState: key => structuredClone(saved.get(key) ?? null),
    setState: (key, value) => saved.set(key, structuredClone(value)), event() {}, observation: row => observations.push(row) };
  const decoder = createH66Decoder({ deviceId: 'synthetic' });
  const receive = (index, value) => h66.ingest(decoder.decode({ topic: `synthetic/HP/${index}`, payload: String(value), receivedAt: now }));
  const h66 = native ? createH66Controller({ deviceId: 'synthetic', store, clock: () => now,
    config: { writeEnabled: true, readbackTimeoutMs: 30 }, publish: async (topic, payload) => {
      const index = topic.split('/').at(-1);
      assert.ok(saved.get('h66:control:synthetic').obligations[index], 'native restoration saved before publishing');
      log.push({ native: index, value: Number(payload), now }); values[index] = Number(payload);
      queueMicrotask(() => receive(index, values[index]));
    } }) : null;
  if (h66) { h66.setConnected(true); for (const [index, value] of Object.entries(values)) receive(index, value); }
  const transport = { publish: async commands => {
    log.push({ commands: [...commands], now });
    assert(!commands.includes('circulation'), 'DHWR button intents must never enter the heating transport');
    return publishLegacy ? publishLegacy(commands) : { status: 'mqtt', sent: true, actual: null };
  }, publishDhwr: async on => {
    log.push({ dhwr: on, now });
    if (on) {
      assert.equal(saved.get('executor:mqtt').dhwrOutstanding, true, 'Save the OFF obligation before ON can reach the broker');
      assert.equal(saved.get('executor:mqtt').pulseUntil, now + (config.dhwrPulseMinutes ?? 10) * 60_000 + 10_000);
    }
    return publishDhwr ? publishDhwr(on) : { status: 'mqtt', sent: true, actual: null };
  }, async close() {} };
  const executor = new Executor({ input: 'mqtt', store, h66, config, commandTransport: transport, clock: () => now });
  t.after(async () => { clearTimeout(executor.timer); executor.closed = true; await h66?.close(); });
  return { executor, h66, log, observations, values, saved, store, transport, get now() { return now; },
    advance(ms) { now += ms; if (h66) for (const [index, value] of Object.entries(values)) receive(index, value); },
    run(phase, duration = 1_800_000, extra = {}) { return executor.execute({ phase, action: phase === 'reduction' ? 'reduction' : 'normal',
      commands: phase === 'reduction' ? ['reduction'] : ['normal'], roomBoostC: 2, expiresAt: now + duration, ...extra }, { mode: 'active', now }); } };
}

test('active base control works without H66 and refreshes idempotently', async t => {
  const r = rig(t, { native: false });
  const first = await r.run('reduction');
  assert.equal(first.phase, 'reduction'); assert.equal(first.actual, null); assert.equal(first.physicalStateVerified, false);
  assert.deepEqual(r.log.map(entry => entry.commands), [['reduction']]);
  assert.equal((await r.run('reduction')).sent, false);
  r.advance(600_000); await r.run('reduction'); await r.run('normal');
  assert.deepEqual(r.log.map(entry => entry.commands), [['reduction'], ['reduction'], ['normal']]);
  assert.equal(r.executor.status().legacyOutstanding, false);
});

test('compressor recovery restores ROOM and DHW while retaining mode2 until fallback',async t=>{
  const r=rig(t);
  await r.run('reduction');
  const first=r.log.length;
  const result=await r.run('recovery',1800000,{recoveryCompressorOnly:true});
  assert.equal(result.recoveryCompressorOnly,true);
  assert.deepEqual(r.values,{'0203':19,'0212':47,'0208':62,'2201':2});
  assert.deepEqual(r.log.at(-1).commands,['normal']);
  assert.equal(r.log.slice(first).some(row=>row.native==='2201'&&row.value===1),false);
  assert.ok(r.h66.status().obligations['2201']);
  const before=r.log.length;
  await r.run('recovery',1800000,{recoveryCompressorOnly:true});
  assert.equal(r.log.length,before);
  await r.run('recovery',1800000,{recoveryCompressorOnly:false,recoveryFallbackReason:'recovery-comfort-margin'});
  assert.equal(r.values['2201'],1);assert.deepEqual(r.h66.status().obligations,{});
});

test('compressor recovery expires back to the captured native mode',async t=>{
  const r=rig(t);
  await r.run('reduction');await r.run('recovery',60000,{recoveryCompressorOnly:true});
  r.advance(60000);await r.h66.reconcile({now:r.now});
  assert.equal(r.values['2201'],1);assert.deepEqual(r.h66.status().obligations,{});
});

test('a coupled45-minute trial retains useful preheat exposure with acknowledgement latency',async t=>{
  let r;
  r=rig(t,{publishLegacy:async()=>{r.advance(1000);return{status:'mqtt',sent:true,actual:null};}});
  const end=r.now+45*60000;let pulses=0;
  for(let i=0;i<5;i++) {
    const remaining=end-r.now;
    if(remaining<=0)break;
    const result=await r.run('preheat',remaining);
    if(result.phase!=='preheat')break;
    pulses++;
    r.advance(600000);
  }
  assert.ok(pulses>=3);
  assert.ok(r.log.filter(row=>row.dhwr===true).length>=3);
});

test('coupled preheat switches ON before ROOM and acknowledges OFF before reduction', async t => {
  const r = rig(t);
  const preheat = await r.run('preheat');
  assert.equal(preheat.phase, 'preheat'); assert.equal(r.values['0203'], 21);
  assert.deepEqual(r.log.slice(0, 3).map(entry => entry.commands ?? entry.native ?? entry.dhwr), [true, ['normal'], '0203']);
  assert.equal(r.h66.status().expiresAt, r.now + 600_000);
  assert.equal((await r.run('preheat')).sent, false);
  r.advance(60_000);
  const reduction = await r.run('reduction');
  assert.equal(reduction.phase, 'reduction'); assert.equal(r.values['0203'], 19);
  const off = r.log.findIndex(entry => entry.dhwr === false);
  const reduce = r.log.findIndex(entry => entry.commands?.includes('reduction'));
  assert(off > 0 && reduce > off, 'Acknowledged OFF removes the old external ten-minute waiting period');
  assert.deepEqual(r.values, { '0203': 19, '0212': 40, '0208': 50, '2201': 2 });
  assert.deepEqual(r.log.at(-1).commands, ['reduction']);
  await r.run('recovery');
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
});

test('a pulse renews only at ten minutes and must fit the preheat window', async t => {
  const r = rig(t);
  await r.run('preheat', 300_000);
  assert.equal(r.log.some(entry => entry.dhwr === true), false);
  await r.run('preheat'); r.advance(600_000); await r.run('preheat');
  assert.equal(r.log.filter(entry => entry.dhwr === true).length, 2);
  assert.equal(r.values['0203'], 21, 'baseline boost never accumulates');
});

test('preheat without native settings restores normal and never requests DHWR', async t => {
  const r = rig(t, { native: false });
  const result = await r.run('preheat');
  assert.equal(result.phase, 'normal'); assert.match(result.reason, /fresh writable H66/);
  assert.deepEqual(r.log.map(entry => entry.commands), [['normal']]);
});

test('restart restores a previous reduction before processing a new command', async t => {
  const r = rig(t, { native: false });
  await r.run('reduction'); clearTimeout(r.executor.timer);
  const restarted = new Executor({ input: 'mqtt', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => { clearTimeout(restarted.timer); restarted.closed = true; });
  await restarted.execute({ phase: 'normal', commands: ['normal'] }, { mode: 'active', now: r.now });
  assert.deepEqual(r.log.map(entry => entry.commands), [['reduction'], ['normal']]);
  assert.equal(restarted.status().restorationPending, false);
});

test('a lost ON acknowledgement requires an acknowledged OFF before reduction after restart', async t => {
  let fail = true;
  const r = rig(t, { native: false, publishDhwr: async on => {
    if (fail && on) throw Object.assign(new Error('synthetic failure'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await assert.rejects(r.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: r.now }), { code: 'MQTT_TIMEOUT' });
  assert.equal(r.saved.get('executor:mqtt').dhwrOutstanding, true);
  fail = false;
  const restarted = new Executor({ input: 'mqtt', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => { clearTimeout(restarted.timer); restarted.closed = true; });
  const result = await restarted.execute({ phase: 'reduction', commands: ['reduction'] }, { mode: 'active', now: r.now });
  assert.equal(result.phase, 'reduction');
  assert.deepEqual(r.log.map(entry => entry.commands ?? entry.dhwr), [true, false, ['reduction']]);
  assert.equal(restarted.status().dhwrOutstanding, false);
});

test('normal service DHWR is honored even when the normal phase is unchanged', async t => {
  const r = rig(t, { native: false });
  await r.run('normal'); await r.run('normal', 1_800_000, { commands: ['circulation', 'normal'] });
  assert.deepEqual(r.log.map(entry => entry.commands ?? entry.dhwr), [['normal'], true, ['normal']]);
  await r.run('normal', 1_800_000, { commands: ['circulation', 'normal'] });
  assert.equal(r.log.length, 3);
});

test('PUBACK latency extends the conservative pulse end before reduction is allowed', async t => {
  let advance;
  const r = rig(t, { native: false, publishDhwr: async on => {
    if (on) advance(3000);
    return { status: 'mqtt', sent: true, actual: null };
  } });
  advance = ms => r.advance(ms);
  const startedAt = r.now;
  await r.run('normal', 1_800_000, { commands: ['circulation', 'normal'] });
  assert.equal(r.executor.status().pulseUntil, startedAt + 603_000);
  r.advance(597_000);
  assert.equal((await r.run('reduction')).status, 'waiting');
  r.advance(3000);
  assert.equal((await r.run('reduction')).phase, 'reduction');
});

test('monitoring and shadow are synchronous and tests cannot overlap an active write', async t => {
  let acknowledge;
  const r = rig(t, { native: false, publishLegacy: () => new Promise(resolve => { acknowledge = resolve; }) });
  for (const mode of ['monitoring', 'shadow']) {
    for (const command of ['reduction', 'circulation']) {
      const result = r.executor.execute({ commands: [command] }, { mode, now: r.now });
      assert.equal(result.sent, false); assert.equal(typeof result.then, 'undefined');
    }
  }
  assert.equal(r.log.length, 0);
  const pending = r.run('reduction');
  await assert.rejects(r.executor.execute({ commands: ['normal'] }, { mode: 'shadow', manualTest: true, now: r.now }), { code: 'EXECUTOR_BUSY' });
  acknowledge({ status: 'mqtt', sent: true, actual: null }); await pending;
});

test('shutdown restores owned native settings and the tariff relay', async t => {
  const r = rig(t); await r.run('reduction'); await r.executor.close();
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
  assert.deepEqual(r.log.at(-1).commands, ['normal']);
  assert.equal(r.executor.status().legacyOutstanding, false);
});

test('the configured DHWR duration controls manual runs and required preheat exposure', async t => {
  const r = rig(t, { config: { dhwrPulseMinutes: 3 } });
  const start = r.now;
  await r.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: r.now });
  assert.equal(r.executor.status().pulseUntil, start + 3 * 60_000);
  await r.executor.restore();
  assert.deepEqual(r.log.filter(row => typeof row.dhwr === 'boolean').map(row => row.dhwr), [true, false]);
  assert.equal(r.observations.at(-1).value, 0);
  const before = r.log.length;
  await r.run('preheat', 2 * 60_000);
  assert(!r.log.slice(before).some(row => row.dhwr === true));
  await r.run('preheat', 3 * 60_000);
  assert.equal(r.executor.status().pulseUntil, r.now + 3 * 60_000);
  assert.equal(r.h66.status().expiresAt, r.now + 3 * 60_000);
});

test('a later heating relay acknowledgement does not extend the DHWR ON deadline', async t => {
  let r;
  r = rig(t, { native: false, publishLegacy: async () => {
    r.advance(10_000);
    return { status: 'mqtt', sent: true, actual: null };
  } });
  const start = r.now;
  await r.run('normal', 1_800_000, { commands: ['circulation', 'normal'] });
  assert.equal(r.now, start + 10_000);
  assert.equal(r.executor.status().pulseUntil, start + 600_000);
});

test('manual DHWR expiry sends OFF and retries an unconfirmed OFF without a new ON', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stops = 0;
  const r = rig(t, { native: false, config: { dhwrPulseMinutes: 1 }, publishDhwr: async on => {
    if (!on && ++stops === 1) throw Object.assign(new Error('Synthetic timeout'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.executor.execute({ commands: ['circulation'] }, { mode: 'monitoring', manualTest: true, now: r.now });
  r.advance(60_000); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(r.saved.get('executor:mqtt').dhwrOutstanding, true);
  assert.equal(r.executor.status().restorationPending, true);
  r.advance(1000); t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(r.log.map(row => row.dhwr), [true, false, false]);
  assert.equal(r.executor.status().dhwrOutstanding, false);
  assert.equal(r.executor.status().restorationPending, false);
  assert.equal(r.observations.filter(row => row.signal === 'dhwr_request' && row.value === 0).length, 1,
    'Only a broker-acknowledged OFF creates a completed stop observation');
});

test('failed DHWR OFF cannot prevent independent native and tariff restoration', async t => {
  let failStop = true;
  const r = rig(t, { publishDhwr: async on => {
    if (!on && failStop) throw Object.assign(new Error('Synthetic timeout'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.run('preheat');
  r.advance(600_000);
  const before = r.log.length;
  const pending = await r.executor.restore();
  assert.equal(pending.restorationPending, true);
  assert.equal(pending.dhwrError, 'MQTT_TIMEOUT');
  assert.deepEqual(r.log.slice(before).map(row => row.commands ?? row.native ?? row.dhwr), [false, '0203', ['normal']]);
  assert.equal(r.values['0203'], 19);
  assert.equal(r.saved.get('executor:mqtt').legacyOutstanding, false);
  assert.equal(r.saved.get('executor:mqtt').dhwrOutstanding, true);
  failStop = false;
  assert.equal((await r.executor.restore()).restorationPending, false);
  assert.equal(r.saved.get('executor:mqtt').dhwrOutstanding, false);
});

test('shutdown stops an uncertain ON and demotion preserves its obligation without a write', async t => {
  const shutdown = rig(t, { native: false, publishDhwr: async on => {
    if (on) throw Object.assign(new Error('Synthetic timeout'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await assert.rejects(shutdown.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: shutdown.now }), { code: 'MQTT_TIMEOUT' });
  await shutdown.executor.close();
  assert.deepEqual(shutdown.log.map(row => row.dhwr), [true, false]);
  assert.equal(shutdown.saved.get('executor:mqtt').dhwrOutstanding, false);

  const demoted = rig(t, { native: false });
  await demoted.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: demoted.now });
  await demoted.executor.close({ restore: false });
  assert.deepEqual(demoted.log.map(row => row.dhwr), [true]);
  assert.equal(demoted.saved.get('executor:mqtt').dhwrOutstanding, true);
  const successor = new Executor({ input: 'mqtt', store: demoted.store, commandTransport: demoted.transport, clock: () => demoted.now });
  t.after(() => { clearTimeout(successor.timer); successor.closed = true; });
  assert.equal(successor.status().restorationPending, true);
  await successor.restore({ reason: 'authority-transfer' });
  assert.deepEqual(demoted.log.map(row => row.dhwr), [true, false]);
});

test('a manual DHWR request cannot erase an outstanding tariff reduction', async t => {
  const r = rig(t, { native: false });
  await r.executor.execute({ commands: ['reduction'] }, { mode: 'shadow', manualTest: true, now: r.now });
  await r.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: r.now });
  assert(r.saved.get('executor:mqtt').legacyOutstanding || r.log.some(row => row.commands?.includes('normal')),
    'Starting a separate circulation switch cannot forget restoring the heat reduction relay');
  await r.executor.close();
  assert(r.log.some(row => row.commands?.includes('normal')));
  assert.equal(r.saved.get('executor:mqtt').legacyOutstanding, false);
  assert.equal(r.saved.get('executor:mqtt').dhwrOutstanding, false);
});

test('failed early DHWR stop retries without waiting for the original run deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stops = 0;
  const r = rig(t, { native: false, publishDhwr: async on => {
    if (!on && ++stops === 1) throw Object.assign(new Error('Synthetic timeout'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.executor.execute({ commands: ['circulation'] }, { mode: 'shadow', manualTest: true, now: r.now });
  assert.equal((await r.executor.restore()).restorationPending, true);
  r.advance(10_000); t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 2);
  assert.equal(r.executor.status().dhwrOutstanding, false);
});
