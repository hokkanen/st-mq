import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../src/app/executor.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';

function rig(t, { native = true, saved = new Map(), publishLegacy } = {}) {
  let now = Date.parse('2026-09-07T12:00Z');
  const log = [], values = { '0203': 19, '0212': 47, '0208': 62, '2201': 1 };
  const store = { getState: key => structuredClone(saved.get(key) ?? null),
    setState: (key, value) => saved.set(key, structuredClone(value)), event() {} };
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
    if (commands.includes('heaton60')) assert.equal(saved.get('executor:mqtt').pulseUntil, now + 610_000);
    return publishLegacy ? publishLegacy(commands) : { status: 'mqtt', sent: true, actual: null };
  } };
  const executor = new Executor({ input: 'mqtt', store, h66, commandTransport: transport, clock: () => now });
  t.after(async () => { clearTimeout(executor.timer); executor.closed = true; await h66?.close(); });
  return { executor, h66, log, values, saved, store, transport, get now() { return now; },
    advance(ms) { now += ms; if (h66) for (const [index, value] of Object.entries(values)) receive(index, value); },
    run(phase, duration = 1_800_000, extra = {}) { return executor.execute({ phase, action: phase === 'reduction' ? 'reduction' : 'normal',
      commands: phase === 'reduction' ? ['heatoff'] : ['heaton15'], roomBoostC: 2, expiresAt: now + duration, ...extra }, { mode: 'active', now }); } };
}

test('active base control works without H66 and refreshes idempotently', async t => {
  const r = rig(t, { native: false });
  const first = await r.run('reduction');
  assert.equal(first.phase, 'reduction'); assert.equal(first.actual, null); assert.equal(first.physicalStateVerified, false);
  assert.deepEqual(r.log.map(entry => entry.commands), [['heatoff']]);
  assert.equal((await r.run('reduction')).sent, false);
  r.advance(600_000); await r.run('reduction'); await r.run('normal');
  assert.deepEqual(r.log.map(entry => entry.commands), [['heatoff'], ['heatoff'], ['heaton15']]);
  assert.equal(r.executor.status().legacyOutstanding, false);
});

test('compressor recovery restores ROOM and DHW while retaining mode2 until fallback',async t=>{
  const r=rig(t);
  await r.run('reduction');
  const first=r.log.length;
  const result=await r.run('recovery',1800000,{recoveryCompressorOnly:true});
  assert.equal(result.recoveryCompressorOnly,true);
  assert.deepEqual(r.values,{'0203':19,'0212':47,'0208':62,'2201':2});
  assert.deepEqual(r.log.at(-1).commands,['heaton15']);
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
  assert.ok(r.log.filter(row=>row.commands?.includes('heaton60')).length>=3);
});

test('coupled preheat publishes pulse before ROOM and restores ROOM before waiting for reduction', async t => {
  const r = rig(t);
  const preheat = await r.run('preheat');
  assert.equal(preheat.phase, 'preheat'); assert.equal(r.values['0203'], 21);
  assert.deepEqual(r.log.slice(0, 2).map(entry => entry.commands ?? entry.native), [['heaton60', 'heaton15'], '0203']);
  assert.equal(r.h66.status().expiresAt, r.now + 600_000);
  assert.equal((await r.run('preheat')).sent, false);
  r.advance(60_000);
  const waiting = await r.run('reduction');
  assert.equal(waiting.status, 'waiting'); assert.equal(r.values['0203'], 19);
  assert.equal(r.log.some(entry => entry.commands?.includes('heatoff')), false);
  r.advance(540_000);
  assert.equal((await r.run('reduction')).phase, 'reduction');
  assert.deepEqual(r.values, { '0203': 19, '0212': 40, '0208': 50, '2201': 2 });
  assert.deepEqual(r.log.at(-1).commands, ['heatoff']);
  await r.run('recovery');
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
});

test('a pulse renews only at ten minutes and must fit the preheat window', async t => {
  const r = rig(t);
  await r.run('preheat', 300_000);
  assert.equal(r.log.some(entry => entry.commands?.includes('heaton60')), false);
  await r.run('preheat'); r.advance(600_000); await r.run('preheat');
  assert.equal(r.log.filter(entry => entry.commands?.includes('heaton60')).length, 2);
  assert.equal(r.values['0203'], 21, 'baseline boost never accumulates');
});

test('preheat without native settings restores normal and never requests DHWR', async t => {
  const r = rig(t, { native: false });
  const result = await r.run('preheat');
  assert.equal(result.phase, 'normal'); assert.match(result.reason, /fresh writable H66/);
  assert.deepEqual(r.log.map(entry => entry.commands), [['heaton15']]);
});

test('restart restores a previous reduction before processing a new command', async t => {
  const r = rig(t, { native: false });
  await r.run('reduction'); clearTimeout(r.executor.timer);
  const restarted = new Executor({ input: 'mqtt', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => { clearTimeout(restarted.timer); restarted.closed = true; });
  await restarted.execute({ phase: 'normal', commands: ['heaton15'] }, { mode: 'active', now: r.now });
  assert.deepEqual(r.log.map(entry => entry.commands), [['heatoff'], ['heaton15']]);
  assert.equal(restarted.status().restorationPending, false);
});

test('a lost pulse acknowledgement still blocks reduction after restart', async t => {
  let fail = true;
  const r = rig(t, { native: false, publishLegacy: async commands => {
    if (fail && commands.includes('heaton60')) throw Object.assign(new Error('synthetic failure'), { code: 'MQTT_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await assert.rejects(r.executor.execute({ commands: ['heaton60'] }, { mode: 'shadow', manualTest: true, now: r.now }), { code: 'MQTT_TIMEOUT' });
  fail = false;
  const restarted = new Executor({ input: 'mqtt', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => { clearTimeout(restarted.timer); restarted.closed = true; });
  const result = await restarted.execute({ phase: 'reduction', commands: ['heatoff'] }, { mode: 'active', now: r.now });
  assert.equal(result.status, 'waiting'); assert.equal(r.log.some(entry => entry.commands.includes('heatoff')), false);
});

test('normal service DHWR is honored even when the normal phase is unchanged', async t => {
  const r = rig(t, { native: false });
  await r.run('normal'); await r.run('normal', 1_800_000, { commands: ['heaton60', 'heaton15'] });
  assert.deepEqual(r.log.map(entry => entry.commands), [['heaton15'], ['heaton60', 'heaton15']]);
  await r.run('normal', 1_800_000, { commands: ['heaton60', 'heaton15'] });
  assert.equal(r.log.length, 2);
});

test('PUBACK latency extends the conservative pulse end before reduction is allowed', async t => {
  let advance;
  const r = rig(t, { native: false, publishLegacy: async commands => {
    if (commands.includes('heaton60')) advance(3000);
    return { status: 'mqtt', sent: true, actual: null };
  } });
  advance = ms => r.advance(ms);
  const startedAt = r.now;
  await r.run('normal', 1_800_000, { commands: ['heaton60', 'heaton15'] });
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
    const result = r.executor.execute({ commands: ['heatoff'] }, { mode, now: r.now });
    assert.equal(result.sent, false); assert.equal(typeof result.then, 'undefined');
  }
  const pending = r.run('reduction');
  await assert.rejects(r.executor.execute({ commands: ['heaton15'] }, { mode: 'shadow', manualTest: true, now: r.now }), { code: 'EXECUTOR_BUSY' });
  acknowledge({ status: 'mqtt', sent: true, actual: null }); await pending;
});

test('shutdown restores owned native settings and the tariff relay', async t => {
  const r = rig(t); await r.run('reduction'); await r.executor.close();
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
  assert.deepEqual(r.log.at(-1).commands, ['heaton15']);
  assert.equal(r.executor.status().legacyOutstanding, false);
});
