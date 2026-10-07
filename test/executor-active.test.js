import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../src/app/executor.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { validateExecutorState } from '../src/domain/heating-control-state.js';

test('retired automatic-reduction manual baselines cannot reacquire tariff authority', () => {
  const saved = { version: 2, targetBindings: {},
    manualBaseline: { phase: 'reduction', expiresAt: Date.now() + 60_000, legacyOutstanding: true } };
  let mutations = 0;
  assert.throws(() => new Executor({ input: 'mqtt',
    store: { getState: () => saved, setState() { mutations++; } },
    commandTransport: { publish() { mutations++; } },
  }), /Unsupported heating state/);
  assert.equal(mutations, 0);
});

test('unreadable executor state cannot erase outstanding tariff or circulation restoration', () => {
  const unreadable = new SyntaxError('Synthetic unreadable persisted state');
  let mutations = 0;
  assert.throws(() => new Executor({ input: 'mqtt',
    store: { getState() { throw unreadable; }, setState() { mutations++; } },
    commandTransport: { publish() { mutations++; }, publishDhwr() { mutations++; } },
  }), error => error === unreadable);
  assert.equal(mutations, 0);
});

function rig(t, { native = true, saved = new Map(), publishLegacy, publishDhwr, floorOverride = null, config = {} } = {}) {
  let now = Date.parse('2026-09-07T12:00Z'), elapsed = 0;
  const log = [], observations = [], snapshots = [], values = { '0203': 19, '0212': 47, '0208': 62, '2201': 1 };
  const store = { getState: key => structuredClone(saved.get(key) ?? null),
    setState: (key, value) => {
      if (key === 'executor:home') { validateExecutorState(value); snapshots.push(structuredClone(value)); }
      saved.set(key, structuredClone(value));
    }, event() {}, observation: row => observations.push(row) };
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
  const transport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publish: async commands => {
    log.push({ commands: [...commands], now });
    assert(!commands.includes('circulation'), 'DHWR button intents must never enter the heating transport');
    return publishLegacy ? publishLegacy(commands) : { status: 'mqtt', sent: true, actual: null };
  }, publishDhwr: async on => {
    log.push({ dhwr: on, now });
    if (on) {
      assert.equal(saved.get('executor:home').dhwrOutstanding, true, 'Save the OFF obligation before ON can reach the broker');
      assert.equal(saved.get('executor:home').pulseUntil, now + (config.dhwrPulseMinutes ?? 10) * 60_000 + 10_000);
    }
    return publishDhwr ? publishDhwr(on) : { status: 'mqtt', sent: true, actual: null };
  }, async close() {} };
  const executor = new Executor({ input: 'mqtt', store, h66, floorOverride, config, commandTransport: transport, clock: () => now, monotonicClock: () => elapsed });
  t.after(async () => { clearTimeout(executor.timer); executor.closed = true; await h66?.close(); });
  return { executor, h66, log, observations, snapshots, values, saved, store, transport, get now() { return now; },
    elapse(ms) { elapsed += ms; },
    advance(ms) { now += ms; if (h66) for (const [index, value] of Object.entries(values)) receive(index, value); },
    run(phase, duration = 1_800_000, extra = {}) { return executor.execute({ phase, action: phase === 'reduction' ? 'reduction' : 'normal',
      commands: phase === 'reduction' ? ['reduction'] : ['normal'], roomBoostC: 5, expiresAt: now + duration, ...extra }, { automationEnabled: true, now }); } };
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

test('recovery holds reduced DHW after cold-room fallback releases AUX alone',async t=>{
  const r=rig(t);
  await r.run('reduction');
  const first=r.log.length;
  const hold = { recoveryHoldActive:true, recoveryCompressorOnly:true, owner:'synthetic-cycle' };
  const result=await r.run('recovery',1800000,hold);
  assert.equal(result.recoveryCompressorOnly,true);
  assert.equal(result.recoveryHoldUntil,r.now+3600000);
  assert.deepEqual(r.values,{'0203':19,'0212':40,'0208':50,'2201':2});
  assert.deepEqual(r.log.at(-1).commands,['normal']);
  assert.equal(r.log.slice(first).some(row=>row.native==='2201'&&row.value===1),false);
  assert.ok(r.h66.status().obligations['2201']);
  const before=r.log.length;
  await r.run('recovery',1800000,hold);
  assert.equal(r.log.length,before);
  r.advance(15*60000);
  const fallback = await r.run('recovery',1800000,{...hold,recoveryCompressorOnly:false,recoveryFallbackReason:'recovery-comfort-margin'});
  assert.equal(fallback.recoveryHoldUntil,result.recoveryHoldUntil);
  assert.deepEqual(r.values,{'0203':19,'0212':40,'0208':50,'2201':1});
  assert.equal(r.h66.status().obligations['2201'],undefined);
  assert.ok(r.h66.status().obligations['0212']);
  assert.ok(r.h66.status().obligations['0208']);
  const renewed=await r.run('recovery',1800000,hold);
  assert.equal(renewed.recoveryCompressorOnly,false,'AUX permission is not removed again within the same hold');
  assert.equal(r.values['2201'],1);
  r.advance(45*60000);
  await r.run('recovery',1800000,{...hold,recoveryHoldActive:false,recoveryCompressorOnly:false});
  assert.deepEqual(r.values,{'0203':19,'0212':47,'0208':62,'2201':1});
  assert.deepEqual(r.h66.status().obligations,{});
  assert.equal(r.log.some(row=>row.dhwr===true),false,'Restoration does not force circulation');
});

test('the common recovery deadline restores DHW and native AUX permission without controller refresh',async t=>{
  const r=rig(t,{config:{recoveryHoldMinutes:1}});
  await r.run('reduction');await r.run('recovery',60000,{recoveryHoldActive:true,recoveryCompressorOnly:true});
  r.advance(60000);await r.h66.reconcile({now:r.now});
  assert.deepEqual(r.values,{'0203':19,'0212':47,'0208':62,'2201':1});assert.deepEqual(r.h66.status().obligations,{});
});

test('the reduction timer enters recovery without restoring and reapplying DHW or AUX',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=rig(t);
  await r.run('reduction',60000,{owner:'timer-cycle',recoveryAuxRestrictionAllowed:true});
  const boundary=r.now+60000, before=r.log.length;
  assert.equal(r.h66.status().expiresAt,boundary+3600000);
  r.advance(60000);
  t.mock.timers.tick(60000);
  await new Promise(resolve=>setImmediate(resolve));
  if(r.executor.pending)await r.executor.pending;
  assert.equal(r.executor.status().phase,'recovery');
  assert.deepEqual(r.values,{'0203':19,'0212':40,'0208':50,'2201':2});
  assert.deepEqual(r.log.slice(before).filter(row=>row.native),[],'No transient native DHW/AUX restore');
  assert.deepEqual(r.log.at(-1).commands,['normal']);
  assert.equal(r.executor.status().recoveryStartedAt,boundary);
  assert.equal(r.executor.status().recoveryHoldUntil,boundary+3600000);
});

test('recovery deadline starts at tariff acknowledgement and survives executor restart',async t=>{
  let r;
  r=rig(t,{publishLegacy:async commands=>{
    if(commands.includes('normal'))r.advance(2000);
    return {status:'mqtt',sent:true,actual:null};
  }});
  await r.run('reduction');
  const requested=r.now;
  const hold={recoveryHoldActive:true,recoveryCompressorOnly:true,owner:'persisted-cycle'};
  const first=await r.run('recovery',3600000,hold);
  assert.equal(first.recoveryStartedAt,requested+2000);
  assert.equal(first.recoveryHoldUntil,requested+2000+3600000);
  clearTimeout(r.executor.timer);
  r.advance(20*60000);
  const restarted=new Executor({input:'mqtt',store:r.store,h66:r.h66,commandTransport:r.transport,clock:()=>r.now});
  t.after(()=>{clearTimeout(restarted.timer);restarted.closed=true;});
  const result=await restarted.execute({phase:'recovery',commands:['normal'],expiresAt:r.now+3600000,...hold},{automationEnabled: true,now:r.now});
  assert.equal(result.recoveryHoldUntil,first.recoveryHoldUntil);
  assert.equal(r.h66.status().expiresAt,first.recoveryHoldUntil);
});

test('an explicit circulation pulse survives automatic recovery holding',async t=>{
  const r=rig(t);
  await r.run('reduction');
  const hold={recoveryHoldActive:true,recoveryCompressorOnly:true,owner:'manual-hot-water-cycle'};
  await r.run('recovery',3600000,hold);
  await r.executor.execute({commands:['circulation']},{automationEnabled: true,manualTest:true,now:r.now});
  const until=r.executor.status().pulseUntil;
  await r.run('recovery',3600000,hold);
  assert.equal(r.executor.status().pulseUntil,until);
  assert.equal(r.log.filter(row=>row.dhwr===true).length,1);
  assert.equal(r.log.filter(row=>row.dhwr===false).length,0);
});

test('a45-minute preheat keeps its ROOM deadline through acknowledgement latency without requesting extra DHWR', async t => {
  let r;
  r = rig(t, { publishLegacy: async () => { r.advance(1000); return { status: 'mqtt', sent: true, actual: null }; } });
  const end = r.now + 45 * 60_000;
  for (let i = 0; i < 5 && r.now < end; i++) {
    assert.equal((await r.run('preheat', end - r.now)).phase, 'preheat');
    assert.equal(r.h66.status().expiresAt, end);
    assert.equal(r.values['0203'], 24);
    r.advance(10 * 60_000);
  }
  assert.equal(r.log.some(row => row.dhwr === true), false);
});

test('ROOM increase preheat restores the exact native baseline before reduction without a circulation dependency', async t => {
  const r = rig(t);
  const preheat = await r.run('preheat');
  assert.equal(preheat.phase, 'preheat'); assert.equal(r.values['0203'], 24);
  assert.deepEqual(r.log.slice(0, 2).map(entry => entry.commands ?? entry.native), [['normal'], '0203']);
  assert.equal(r.h66.status().expiresAt, r.now + 1_800_000);
  assert.equal((await r.run('preheat')).sent, false);
  r.advance(60_000);
  const reduction = await r.run('reduction');
  assert.equal(reduction.phase, 'reduction'); assert.equal(r.values['0203'], 19);
  const restore = r.log.findIndex(entry => entry.native === '0203' && entry.value === 19);
  const reduce = r.log.findIndex(entry => entry.commands?.includes('reduction'));
  assert(restore > 0 && reduce > restore);
  assert.equal(r.log.some(entry => typeof entry.dhwr === 'boolean'), false);
  assert.deepEqual(r.values, { '0203': 19, '0212': 40, '0208': 50, '2201': 2 });
  await r.run('recovery');
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
});

test('preheat with less than one DHWR pulse remaining still reaches its own planned end', async t => {
  const r = rig(t);
  const end = r.now + 5 * 60_000;
  assert.equal((await r.run('preheat', end - r.now)).phase, 'preheat');
  r.advance(4 * 60_000);
  assert.equal((await r.run('preheat', end - r.now)).phase, 'preheat');
  assert.equal(r.values['0203'], 24);
  assert.equal(r.h66.status().expiresAt, end);
  assert.equal(r.log.some(entry => entry.dhwr === true), false);
  r.advance(60_000);
  await r.h66.reconcile({ now: r.now });
  assert.equal(r.values['0203'], 19);
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
  await restarted.execute({ phase: 'normal', commands: ['normal'] }, { automationEnabled: true, now: r.now });
  assert.deepEqual(r.log.map(entry => entry.commands), [['reduction'], ['normal']]);
  assert.equal(restarted.status().restorationPending, false);
});

test('a lost ON acknowledgement requires an acknowledged OFF before reduction after restart', async t => {
  let fail = true;
  const r = rig(t, { native: false, publishDhwr: async on => {
    if (fail && on) throw Object.assign(new Error('synthetic failure'), { code: 'SHELLY_READBACK_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await assert.rejects(r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now }), { code: 'SHELLY_READBACK_TIMEOUT' });
  assert.equal(r.saved.get('executor:home').dhwrOutstanding, true);
  fail = false;
  const restarted = new Executor({ input: 'mqtt', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => { clearTimeout(restarted.timer); restarted.closed = true; });
  const result = await restarted.execute({ phase: 'reduction', commands: ['reduction'] }, { automationEnabled: true, now: r.now });
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

test('Pause is synchronous and manual tests cannot overlap an active write', async t => {
  let acknowledge;
  const r = rig(t, { native: false, publishLegacy: () => new Promise(resolve => { acknowledge = resolve; }) });
  {
    for (const command of ['reduction', 'circulation']) {
      const result = r.executor.execute({ commands: [command] }, { automationEnabled: false, now: r.now });
      assert.equal(result.sent, false); assert.equal(typeof result.then, 'undefined');
    }
  }
  assert.equal(r.log.length, 0);
  const pending = r.run('reduction');
  await assert.rejects(r.executor.execute({ commands: ['normal'] }, { automationEnabled: false, manualTest: true, now: r.now }), { code: 'EXECUTOR_BUSY' });
  acknowledge({ status: 'mqtt', sent: true, actual: null }); await pending;
});

test('shutdown restores owned native settings and the tariff relay', async t => {
  const r = rig(t); await r.run('reduction'); await r.executor.close();
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
  assert.deepEqual(r.log.at(-1).commands, ['normal']);
  assert.equal(r.executor.status().legacyOutstanding, false);
});

test('the configured DHWR duration controls manual runs independently of preheat exposure', async t => {
  const r = rig(t, { config: { dhwrPulseMinutes: 3 } });
  const start = r.now;
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  assert.equal(r.executor.status().pulseUntil, start + 3 * 60_000);
  await r.executor.restore();
  assert.deepEqual(r.log.filter(row => typeof row.dhwr === 'boolean').map(row => row.dhwr), [true, false]);
  assert.equal(r.observations.at(-1).value, 0);
  const before = r.log.length;
  await r.run('preheat', 2 * 60_000);
  assert(!r.log.slice(before).some(row => row.dhwr === true));
  await r.run('preheat', 3 * 60_000);
  assert.equal(r.executor.status().pulseUntil, 0);
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
    if (!on && ++stops === 1) throw Object.assign(new Error('Synthetic timeout'), { code: 'SHELLY_READBACK_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  r.advance(60_000); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(r.saved.get('executor:home').dhwrOutstanding, true);
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
    if (!on && failStop) throw Object.assign(new Error('Synthetic timeout'), { code: 'SHELLY_READBACK_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.run('preheat', 1_800_000, { commands: ['circulation', 'normal'] });
  r.advance(600_000);
  const before = r.log.length;
  const pending = await r.executor.restore();
  assert.equal(pending.restorationPending, true);
  assert.equal(pending.dhwrError, 'SHELLY_READBACK_TIMEOUT');
  assert.deepEqual(r.log.slice(before).map(row => row.commands ?? row.native ?? row.dhwr), [false, '0203', ['normal']]);
  assert.equal(r.values['0203'], 19);
  assert.equal(r.saved.get('executor:home').legacyOutstanding, false);
  assert.equal(r.saved.get('executor:home').dhwrOutstanding, true);
  failStop = false;
  assert.equal((await r.executor.restore()).restorationPending, false);
  assert.equal(r.saved.get('executor:home').dhwrOutstanding, false);
});

test('shutdown stops an uncertain ON and demotion preserves its obligation without a write', async t => {
  const shutdown = rig(t, { native: false, publishDhwr: async on => {
    if (on) throw Object.assign(new Error('Synthetic timeout'), { code: 'SHELLY_READBACK_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await assert.rejects(shutdown.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: shutdown.now }), { code: 'SHELLY_READBACK_TIMEOUT' });
  await shutdown.executor.close();
  assert.deepEqual(shutdown.log.map(row => row.dhwr), [true, false]);
  assert.equal(shutdown.saved.get('executor:home').dhwrOutstanding, false);

  const demoted = rig(t, { native: false });
  await demoted.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: demoted.now });
  await demoted.executor.close({ restore: false });
  assert.deepEqual(demoted.log.map(row => row.dhwr), [true]);
  assert.equal(demoted.saved.get('executor:home').dhwrOutstanding, true);
  const successor = new Executor({ input: 'mqtt', store: demoted.store, commandTransport: demoted.transport, clock: () => demoted.now });
  t.after(() => { clearTimeout(successor.timer); successor.closed = true; });
  assert.equal(successor.status().restorationPending, true);
  await successor.restore({ reason: 'authority-transfer' });
  assert.deepEqual(demoted.log.map(row => row.dhwr), [true, false]);
});

test('a manual DHWR request cannot erase an outstanding tariff reduction', async t => {
  const r = rig(t, { native: false });
  await r.executor.execute({ commands: ['reduction'] }, { automationEnabled: false, manualTest: true, now: r.now });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  assert(r.saved.get('executor:home').legacyOutstanding || r.log.some(row => row.commands?.includes('normal')),
    'Starting a separate circulation switch cannot forget restoring the heat reduction relay');
  await r.executor.close();
  assert(r.log.some(row => row.commands?.includes('normal')));
  assert.equal(r.saved.get('executor:home').legacyOutstanding, false);
  assert.equal(r.saved.get('executor:home').dhwrOutstanding, false);
});

test('failed early DHWR stop retries without waiting for the original run deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stops = 0;
  const r = rig(t, { native: false, publishDhwr: async on => {
    if (!on && ++stops === 1) throw Object.assign(new Error('Synthetic timeout'), { code: 'SHELLY_READBACK_TIMEOUT' });
    return { status: 'mqtt', sent: true, actual: null };
  } });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  assert.equal((await r.executor.restore()).restorationPending, true);
  r.advance(10_000); t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 2);
  assert.equal(r.executor.status().dhwrOutstanding, false);
});


test('short ROOM lease expires without ending a separately requested normal-service circulation run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t);
  const start = r.now;
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  await r.run('preheat', 2 * 60_000);
  assert.equal(r.executor.status().pulseUntil, start + 10 * 60_000);
  assert.equal(r.h66.status().expiresAt, start + 2 * 60_000);
  r.advance(2 * 60_000); t.mock.timers.tick(2 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.values['0203'], 19);
  assert.equal(r.executor.status().dhwrOutstanding, true);
  assert.deepEqual(r.log.filter(row => typeof row.dhwr === 'boolean').map(row => row.dhwr), [true]);
  r.advance(8 * 60_000); t.mock.timers.tick(8 * 60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.executor.status().dhwrOutstanding, false);
  assert.deepEqual(r.log.filter(row => typeof row.dhwr === 'boolean').map(row => row.dhwr), [true, false]);
});


test('floor override and ROOM share only the preheat deadline and release before a new heating phase', async t => {
  const floorCalls = [];
  const floorOverride = { status: () => ({ enabled: true }),
    async lease(request) { floorCalls.push({ ...request, operation: 'lease' }); },
    async release(request) { floorCalls.push({ ...request, operation: 'release' }); return { restorationPending: false }; } };
  const r = rig(t, { floorOverride });
  const start = r.now, end = start + 90_000;
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: false, manualTest: true, now: r.now });
  await r.run('preheat', end - r.now, { floorOverride: true, owner: 'synthetic-pooled-treatment' });
  assert.equal(floorCalls[0].operation, 'lease'); assert.equal(floorCalls[0].until, end);
  assert.equal(r.h66.status().expiresAt, end);
  assert.equal(r.executor.status().pulseUntil, start + 600_000);
  r.advance(60_000);
  assert.equal((await r.run('preheat', end - r.now, { floorOverride: true, owner: 'synthetic-pooled-treatment' })).phase, 'preheat');
  assert.equal(floorCalls.at(-1).until, end, 'A late continuation cannot extend the promised preheat end');
  await r.run('normal');
  assert.equal(floorCalls.at(-1).operation, 'release');
  assert.equal(r.values['0203'], 19);
  assert.equal(r.executor.status().dhwrOutstanding, true, 'Separately requested DHWR keeps its own run');
});

test('an unconfirmed floor lease cannot leave a raised ROOM request active', async t => {
  let releases = 0;
  const floorOverride = { status: () => ({ enabled: true }),
    async lease() { throw Object.assign(new Error('Synthetic missing device timer confirmation'), { code: 'FLOOR_UNCONFIRMED' }); },
    async release() { releases++; return { restorationPending: false }; } };
  const r = rig(t, { floorOverride });
  await assert.rejects(r.run('preheat', 60_000, { floorOverride: true }), { code: 'FLOOR_UNCONFIRMED' });
  assert.equal(r.values['0203'], 19);
  assert.equal(r.log.some(row => row.native === '0203' && row.value > 19), false);
  assert(releases > 0);
});

test('expired reduction after native readback restores instead of dispatching late tariff', async t => {
  const r = rig(t, { native: false });
  r.executor.h66 = { status: () => ({ controlsReady: true, writesEnabled: true }),
    async setPhase() { r.advance(2000); return { changed: ['2201'] }; },
    async restore() { return { changed: ['2201'], restorationPending: false }; } };
  const result = await r.run('reduction', 1000);
  assert.equal(r.log.some(row => row.commands?.includes('reduction')), false);
  assert.equal(result.restorationPending, false);
  assert.equal(r.executor.status().legacyOutstanding, false);
});

test('current DHWR obligation stays on its original target across restart and input-mode changes', async t => {
  const r = rig(t, { native: false });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: true, manualTest: true, now: r.now });
  await r.executor.close({ restore: false });
  const count = r.log.length;
  r.transport.targetIdentity.dhwr = 'c'.repeat(64);
  const successor = new Executor({ input: 'providers', store: r.store, commandTransport: r.transport, clock: () => r.now });
  t.after(() => successor.close({ restore: false }));
  const blocked = await successor.restore();
  assert.equal(blocked.restorationPending, true);
  assert.equal(successor.status().dhwrOutstanding, true);
  assert.equal(r.log.length, count, 'No OFF is sent to the unrelated replacement');
  r.transport.targetIdentity.dhwr = 'b'.repeat(64);
  assert.equal((await successor.restore()).restorationPending, false);
  assert.equal(r.log.at(-1).dhwr, false);
});

test('an unsupported unscoped Executor state rejects before mutation or command', () => {
  const saved = { version: 1, dhwrOutstanding: true, pulseUntil: 1000 };
  let mutations = 0;
  assert.throws(() => new Executor({ input: 'mqtt', store: { getState: () => saved, setState() { mutations++; } } }),
    { code: 'EXECUTOR_STATE_UNSUPPORTED' });
  assert.equal(mutations, 0);
});

test('a one-minute circulation run ends after elapsed time despite repeated wall-clock rollback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { native: false, config: { dhwrPulseMinutes: 1 } });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: true, manualTest: true, now: r.now });
  r.advance(-3_600_000); r.elapse(30_000); t.mock.timers.tick(30_000);
  r.advance(-3_600_000); r.elapse(30_000); t.mock.timers.tick(30_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.log.at(-1).dhwr, false);
  assert.equal(r.executor.status().dhwrOutstanding, false);
});

test('elapsed expiry with unavailable OFF delivery retains the original stop obligation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t, { native: false, config: { dhwrPulseMinutes: 1 }, publishDhwr: on => {
    if (!on) throw Object.assign(new Error('synthetic unavailable'), { code: 'MQTT_UNAVAILABLE' });
    return { sent: true };
  } });
  await r.executor.execute({ commands: ['circulation'] }, { automationEnabled: true, manualTest: true, now: r.now });
  const binding = r.executor.status().targetBindings.dhwr;
  r.advance(-3_600_000); r.elapse(60_000); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.log.at(-1).dhwr, false);
  assert.equal(r.executor.status().dhwrOutstanding, true);
  assert.deepEqual(r.executor.status().targetBindings.dhwr, binding);
  assert.equal(r.executor.status().restorationPending, true);
});

test('manual Reduced applies automatic DHW and AUX settings and remains through an indefinite pause', async t => {
  const r = rig(t), pause = { id: 'synthetic-indefinite-pause', expiresAt: null };
  const result = await r.executor.execute({ phase: 'reduction', commands: ['reduction'] },
    { manualTest: true, now: r.now, pause });
  assert.equal(result.phase, 'reduction');
  assert.deepEqual(r.values, { '0203': 19, '0212': 40, '0208': 50, '2201': 2 });
  assert.equal(r.h66.status().expiresAt, null);
  r.advance(2 * 86_400_000);
  await r.executor.maintainPause(r.now, pause);
  assert.equal(r.executor.status().phase, 'reduction');
  assert.equal(r.h66.status().obligations['2201'].baseline, 1);
  await r.executor.execute({ commands: ['normal'] }, { manualTest: true, now: r.now, pause });
  assert.deepEqual(r.values, { '0203': 19, '0212': 47, '0208': 62, '2201': 1 });
});

test('changing a pause end updates held Reduced native restoration without rewriting its settings', async t => {
  const r = rig(t), pause = { id: 'synthetic-edited-pause', expiresAt: null };
  await r.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: r.now, pause });
  const count = r.log.length;
  const end = r.now + 3_600_000;
  await r.executor.maintainPause(r.now, { ...pause, expiresAt: end });
  assert.equal(r.h66.status().expiresAt, end);
  assert.equal(r.executor.status().manualRequested.expiresAt, end);
  assert.equal(r.log.length, count);
  await r.executor.maintainPause(r.now, pause);
  assert.equal(r.h66.status().expiresAt, null);
  assert.equal(r.log.length, count);
});

test('manual Reduced waits for an existing circulation service pulse exactly as automatic Reduced does', async t => {
  const r = rig(t), pause = { id: 'synthetic-circulation-pause', expiresAt: null };
  await r.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: r.now });
  const result = await r.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: r.now, pause });
  assert.equal(result.status, 'waiting');
  assert.equal(result.requestedPhase, 'reduction');
  assert.equal(r.values['0212'], 47);
  assert.equal(r.log.some(row => row.commands?.includes('reduction')), false);
  r.advance(600_001); await r.executor.maintainPause(r.now, pause);
  assert.equal(r.values['0212'], 40);
  assert.deepEqual(r.log.at(-1).commands, ['reduction']);
  assert.equal(r.executor.status().manualRequested.confirmed, true);
});

test('manual Preheat has one unrenewed floor lease and restores ROOM while floor expiry readback is still pending', async t => {
  let leases = 0, finish;
  const floor = { status: () => ({ enabled: true, leaseSeconds: 900 }),
    async lease({ until }) { leases++; return { confirmed: true, leaseUntil: until }; },
    async release() { return { restorationPending: false }; },
    finishLease() { return new Promise(resolve => { finish = resolve; }); } };
  const r = rig(t, { floorOverride: floor });
  await r.executor.execute({ phase: 'preheat', commands: ['normal'], roomBoostC: 5 }, { manualTest: true, now: r.now });
  const end = r.now + 900_000;
  assert.equal(r.h66.status().expiresAt, end);
  for (let i = 0; i < 2; i++) { r.advance(300_000); await r.executor.maintainPause(r.now); }
  await r.executor.execute({ phase: 'preheat', commands: ['normal'] }, { manualTest: true, now: r.now });
  assert.equal(leases, 1);
  assert.equal(r.executor.status().manualRequested.expiresAt, end);
  r.advance(300_000);
  const ending = r.executor.maintainPause(r.now);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.values['0203'], 19, 'ROOM restore must not wait for a failing floor timeout');
  finish({ outcome: 'device-local', restorationPending: false }); await ending;
  const report = r.executor.status().manualPreheatReport;
  assert.equal(report.floorOutcome, 'device-local');
  assert.equal(report.roomOutcome, 'restored');
  assert.equal(report.expiresAt, r.now + 86_400_000);
  assert.equal(r.executor.status().manualRequested, null);
  r.advance(86_400_000);
  assert.equal(r.executor.status().manualPreheatReport, null);
});

test('manual Preheat restores ROOM and retains uncertain release duty after a failed floor timeout', async t => {
  const floor = { status: () => ({ enabled: true, leaseSeconds: 60 }),
    async lease({ until }) { return { confirmed: true, leaseUntil: until }; },
    async release() { return { restorationPending: false }; },
    async finishLease() { return { outcome: 'unverified', restorationPending: true }; } };
  const r = rig(t, { floorOverride: floor }), pause = { id: 'synthetic-preheat-pause', expiresAt: null };
  await r.executor.execute({ phase: 'preheat', commands: ['normal'] }, { manualTest: true, now: r.now, pause });
  r.advance(60_000); await r.executor.maintainPause(r.now, pause);
  assert.equal(r.values['0203'], 19);
  assert.equal(r.executor.status().manualPreheatReport.floorOutcome, 'unverified');
  assert.equal(r.executor.status().restorationPending, true);
});

test('manual Reduced survives same-owner restart without replaying saved native writes', async t => {
  const saved = new Map(), first = rig(t, { saved }), pause = { id: 'synthetic-restart-pause', expiresAt: null };
  await first.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: first.now, pause });
  clearTimeout(first.executor.timer); first.executor.closed = true; await first.h66.close();
  const restarted = rig(t, { saved, native: false });
  assert.equal(restarted.executor.status().restartManualPause, true);
  await restarted.executor.maintainPause(restarted.now, pause);
  assert.equal(restarted.executor.status().phase, 'reduction');
  assert.deepEqual(restarted.log, []);
  await restarted.executor.restoreManual({ now: restarted.now, reason: 'resume-automatic' });
  assert.deepEqual(restarted.log.at(-1).commands, ['normal']);
});

test('restarting a paused Reduced choice waits for target identity without discarding its durable scope', async t => {
  const saved = new Map(), first = rig(t, { saved }), pause = { id: 'late-target-pause', expiresAt: null };
  await first.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: first.now, pause });
  clearTimeout(first.executor.timer); first.executor.closed = true; await first.h66.close();
  const restarted = rig(t, { saved, native: false });
  delete restarted.transport.targetIdentity.tariff;
  const result = await restarted.executor.maintainPause(restarted.now, pause);
  assert.equal(result.status, 'waiting');
  assert.equal(restarted.executor.status().restartManualPause, true);
  assert.equal(restarted.executor.status().restorationPending, false);
  assert.equal(restarted.executor.status().manualRequested.phase, 'reduction');
  assert.deepEqual(restarted.log, []);
  restarted.transport.targetIdentity.tariff = 'a'.repeat(64);
  await restarted.executor.maintainPause(restarted.now, pause);
  assert.equal(restarted.executor.status().phase, 'reduction');
  assert.deepEqual(restarted.log, []);
});

test('orderly shutdown preserves a durable paused Reduced choice and its native restoration obligations', async t => {
  const r = rig(t), pause = { id: 'shutdown-pause', expiresAt: null };
  await r.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: r.now, pause });
  const before = r.log.length;
  await r.executor.close();
  assert.equal(r.log.length, before);
  assert.equal(r.executor.status().manualRequested.phase, 'reduction');
  assert.equal(r.saved.get('executor:home').manualPause.id, pause.id);
  assert.equal(r.h66.status().obligations['2201'].baseline, 1);
  assert.equal(r.values['2201'], 2);
});

test('starting circulation at an expired-run boundary saves a new bound OFF obligation', async t => {
  const r = rig(t, { native: false });
  await r.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: r.now });
  const previous = r.saved.get('executor:home').targetBindings.dhwr;
  r.advance(r.executor.pulseMs);
  await r.executor.execute({ commands: ['circulation'] }, { manualTest: true, now: r.now });
  assert.deepEqual(r.log.filter(row => 'dhwr' in row).map(row => row.dhwr), [true, false, true]);
  const saved = r.saved.get('executor:home');
  assert.equal(saved.dhwrOutstanding, true);
  assert.equal(saved.targetBindings.dhwr.identity, previous.identity);
  assert.notEqual(saved.targetBindings.dhwr.generation, previous.generation);
  const restarted = rig(t, { native: false, saved: r.saved });
  assert.equal(restarted.executor.status().dhwrOutstanding, true);
  assert.deepEqual(restarted.executor.status().targetBindings.dhwr, saved.targetBindings.dhwr);
});

test('malformed saved manual authority and deadlines reject before writes or command publication', async t => {
  const r = rig(t, { native: false }), pause = { id: 'validation-pause', expiresAt: null };
  await r.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: r.now, pause });
  const original = r.saved.get('executor:home');
  const cases = [
    { manualRequested: { ...original.manualRequested, confirmed: 'false' } },
    { manualRequested: { ...original.manualRequested, expiresAt: String(r.now + 1000) } },
    { manualRequested: { ...original.manualRequested, phase: 'retired' } },
    { manualRequested: { ...original.manualRequested, at: null } },
    { manualRequested: { ...original.manualRequested, roomBoostC: '5' } },
    { manualRequested: { ...original.manualRequested, phase: 'preheat', expiresAt: null, floorOwner: 'synthetic-floor' } },
    { manualRequested: { ...original.manualRequested, phase: 'preheat', expiresAt: r.now + 1000 } },
    { manualPause: { id: pause.id, expiresAt: String(r.now + 1000) } },
    { manualPause: { id: pause.id } },
    { manualPause: { id: 123, expiresAt: null } },
    { manualPause: null, manualTemporary: { expiresAt: null } },
    { manualTemporary: { expiresAt: r.now + 1000 } },
    { manualBaseline: null },
    { manualPause: null },
    { legacyOutstanding: false, targetBindings: {} },
    { legacyOutstanding: 'false' },
    { dhwrOutstanding: 'false' },
    { dhwrOutstanding: true, pulseUntil: 'soon' },
    { targetBindings: { tariff: { identity: 'not-an-equipment-identity', generation: 'synthetic' } } },
    { targetBindings: { tariff: { identity: 'a'.repeat(64) } } },
    ...['manualBaseline', 'manualPause', 'manualTemporary', 'manualRequested'].flatMap(key =>
      [false, 1, 'invalid', []].map(value => ({ [key]: value }))),
  ];
  for (const patch of cases) {
    let effects = 0;
    assert.throws(() => new Executor({ input: 'mqtt', clock: () => r.now,
      store: { getState: () => ({ ...structuredClone(original), ...patch }), setState() { effects++; } },
      commandTransport: { targetIdentity: r.transport.targetIdentity, publish() { effects++; }, publishDhwr() { effects++; } },
    }), { code: 'EXECUTOR_STATE_UNSUPPORTED' }, JSON.stringify(patch));
    assert.equal(effects, 0);
  }
});

test('every saved manual-restoration boundary stays restorable and cannot resume Released Reduced', async t => {
  const r = rig(t, { native: false }), pause = { id: 'restore-boundary-pause', expiresAt: null };
  await r.executor.execute({ commands: ['reduction'] }, { manualTest: true, now: r.now, pause });
  const from = r.snapshots.length;
  await r.executor.restoreManual({ now: r.now });
  assert.deepEqual(r.log.at(-1).commands, ['normal']);
  for (const snapshot of r.snapshots.slice(from)) {
    const restarted = new Executor({ input: 'mqtt', clock: () => r.now,
      store: { getState: () => snapshot, setState() { assert.fail('Construction must not mutate state'); } },
      commandTransport: r.transport });
    assert.equal(restarted.status().restartManualPause, false, 'Interrupted restoration cannot reacquire a paused Reduction');
    if (snapshot.legacyOutstanding) assert.equal(snapshot.targetBindings.tariff.identity, 'a'.repeat(64));
    if (snapshot.manualBaseline) assert.equal(restarted.status().restorationPending, true);
    await restarted.close({ restore: false });
  }
  assert.equal(r.executor.status().legacyOutstanding, false);
  assert.equal(r.executor.status().targetBindings.tariff, undefined);
});
