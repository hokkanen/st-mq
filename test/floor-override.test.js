import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorOverride, floorOverrideConfiguration, FLOOR_MQTT_TOPICS } from '../src/control/floor-override.js';

const KEY = 'floor-override:v1', DEVICE = '02:00:00:00:00:01';
const G = 'a'.repeat(32), TOKEN = 'b'.repeat(32), CHALLENGE = 'c'.repeat(32);
function fixture({ saved = null, enabled = true, commissioned = true, deviceMac = DEVICE, transport = null, beforeSave = () => {} } = {}) {
  let wall = 1_800_000_000_000, mono = 10_000, authority = true, state = structuredClone(saved);
  const publications = [], observations = [], writes = [], learning = [];
  const native = { generation: G, active: false, mask: 0, gpio_mask: 0, gpio_match: true, now_ms: mono,
    owner: '', treatment: 0, seq: 0, highwater: 0, lease_until_ms: 0, end_ms: 0, reason: 'connected', board_ok: true };
  const frame = fields => ({ v: 1, build: 'sonoff4chpro-lease-v1', sketch_md5: 'd'.repeat(32), kind: 'reply', id: '', op: 'get',
    accepted: true, duplicate: false, code: 'ok', device: deviceMac, connected: true, state_evidence: 'gpio_output_readback',
    max_lease_ms: 900000, ...native, ...fields });
  const store = { getState: () => structuredClone(state), setState: (key, value) => { beforeSave(value); state = structuredClone(value); writes.push(structuredClone(value)); } };
  let adapter;
  const deliver = (body, packet = {}) => adapter.ingest(FLOOR_MQTT_TOPICS.state, JSON.stringify(body), packet, wall, mono);
  const respond = (body, fields = {}) => deliver(frame({ id: body.id, op: body.op, ...fields }));
  const standard = body => {
    native.now_ms = mono;
    if (native.active && mono >= native.lease_until_ms) Object.assign(native, { active: false, mask: 0, gpio_mask: 0, lease_until_ms: 0, reason: 'expired' });
    if (body.op === 'challenge') return respond(body, { challenge: CHALLENGE, issued_ms: mono, lifetime_ms: 2000 });
    if (body.op === 'acquire' || body.op === 'renew') {
      assert.equal(state.outstanding.phase, 'acquiring', 'Release obligation must be durable before ON');
      Object.assign(native, { active: true, mask: body.mask, gpio_mask: body.mask, owner: body.owner, treatment: body.treatment,
        highwater: body.treatment, seq: body.seq, end_ms: body.end_ms, lease_until_ms: Math.min(mono + body.ttl_ms, body.end_ms),
        reason: body.op === 'acquire' ? 'acquired' : 'renewed' });
      return respond(body, body.op === 'acquire' ? { token: TOKEN } : {});
    }
    if (body.op === 'release') Object.assign(native, { active: false, mask: 0, gpio_mask: 0, lease_until_ms: 0, reason: 'released', seq: body.seq });
    respond(body);
  };
  adapter = createFloorOverride({ store, settings: floorOverrideConfiguration({ device_mac: deviceMac, enabled, commissioned }),
    clock: () => wall, monotonicClock: () => mono, brokerIdentity: { address: 'mqtt://fixture.invalid' }, canControl: () => authority,
    onLearningMode: value => learning.push(value), onObservation: value => observations.push(value), publish: async (topic, payload, options) => {
      const body = JSON.parse(payload); options.beforePublish(); options.beforeWrite(); publications.push({ topic, body, options });
      if (transport) await transport({ body, options, respond, standard, native, frame, deliver, advance: ms => { mono += ms; wall += ms; } }); else standard(body);
    } });
  return { adapter, store, native, frame, deliver, publications, observations, writes, learning,
    get now() { return wall; }, get mono() { return mono; }, get saved() { return state; },
    advance: ms => { mono += ms; wall += ms; }, authority: value => { authority = value; },
    async ready() { adapter.setConnected(true); await adapter.tick(); },
    manual: (channel, on, id = 'request_1', scope = adapter.status().commandScope) => adapter.manual({ channel, enabled: on, durationSeconds: 900, requestId: id, scope }) };
}

test('public defaults support the native adapter but remain unconfigured and uncommissioned', () => {
  const cfg = floorOverrideConfiguration();
  assert.equal(cfg.integrationSupported, true); assert.equal(cfg.enabled, false); assert.equal(cfg.commissioned, false);
  assert.equal(cfg.deviceMac, null); assert.equal(cfg.devices.length, 1);
  for (const value of [{ device: {} }, { living: {} }, { device_mac: DEVICE.toLowerCase() + ' ' }, { enabled: true },
    { device_mac: DEVICE, enabled: true }, { renew_seconds: 29 }, { lease_seconds: 901 }, { lease_seconds: 599 }]) assert.throws(() => floorOverrideConfiguration(value));
});

test('unconfigured floor adapter does not publish or claim GPIO evidence', async () => {
  const f = fixture({ deviceMac: '', enabled: false, commissioned: false });
  await f.ready(); assert.deepEqual(f.adapter.topics, []); assert.equal(f.adapter.status().available, false);
  assert(f.adapter.status().devices[0].channels.every(row => row.output === null));
  assert.equal(f.publications.length, 0);
});

test('fresh correlated custom get establishes GPIO evidence without enabling uncommissioned control', async () => {
  const f = fixture({ enabled: false, commissioned: false }); await f.ready();
  const status = f.adapter.status(); assert.equal(status.devices[0].available, true); assert.equal(status.manualAvailable, false);
  assert.equal(status.manualReason, 'uncommissioned'); assert.equal(f.publications[0].body.op, 'get');
  assert(status.devices[0].channels.every(row => row.output === false && row.outputEvidence === 'gpio_output_readback'));
  assert.equal(f.observations.filter(row => row.value === 0).length, 4);
});

test('failed monitoring polls retain original GPIO evidence only until its freshness deadline', async () => {
  let failPoll = false;
  const f = fixture({ transport: ({ body, standard }) => {
    if (failPoll && body.op === 'get') throw new Error('synthetic publication failure');
    standard(body);
  } });
  await f.ready();
  const at = f.now, observations = f.observations.length, learning = f.learning.length;
  failPoll = true;
  for (let i = 0; i < 2; i++) {
    f.advance(30000); await f.adapter.tick();
    assert.equal(f.adapter.status().devices[0].available, true);
    assert.equal(f.adapter.status().devices[0].at, at);
    assert.equal(f.observations.length, observations);
    assert.equal(f.learning.length, learning);
  }
  f.advance(30001); await f.adapter.tick();
  assert.equal(f.adapter.status().devices[0].available, false);
  assert(f.observations.slice(-4).every(row => row.value === null && row.quality.includes('floor-feedback-stale')));
  failPoll = false; f.advance(30000); await f.adapter.tick();
  assert.equal(f.adapter.status().devices[0].available, true);
  assert.equal(f.adapter.status().devices[0].at, f.now);
  await f.adapter.close({ restore: false });
});

test('a missing poll reply neither invalidates fresh evidence nor lets a late reply renew it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let dropPoll = false, lateReply;
  const f = fixture({ transport: ({ body, standard, respond }) => {
    if (dropPoll && body.op === 'get') { lateReply = () => respond(body); return; }
    standard(body);
  } });
  await f.ready();
  const at = f.now, observations = f.observations.length;
  dropPoll = true; f.advance(30000);
  const poll = f.adapter.tick();
  await new Promise(resolve => setImmediate(resolve));
  f.advance(5000); t.mock.timers.tick(5000); await poll;
  assert.equal(f.adapter.status().devices[0].available, true);
  lateReply();
  assert.equal(f.adapter.status().devices[0].at, at);
  assert.equal(f.observations.length, observations);
  f.advance(55001); t.mock.timers.tick(85001);
  assert.equal(f.adapter.status().devices[0].available, false);
  assert(f.observations.slice(-4).every(row => row.value === null));
  await f.adapter.close({ restore: false });
});

test('failed polls cannot mask explicit disconnection, invalid feedback or hardware faults', async () => {
  for (const invalidate of [
    f => f.adapter.setConnected(false),
    f => f.adapter.ingest(FLOOR_MQTT_TOPICS.availability, 'Offline', { retain: false }, f.now, f.mono),
    f => f.deliver(f.frame({ v: 2 })),
    f => f.deliver(f.frame({ kind: 'state', op: 'state', now_ms: f.mono, board_ok: false })),
  ]) {
    let failPoll = false;
    const f = fixture({ transport: ({ body, standard }) => {
      if (failPoll && body.op === 'get') { invalidate(f); throw new Error('synthetic poll failure'); }
      standard(body);
    } });
    await f.ready(); failPoll = true; f.advance(30000); await f.adapter.tick();
    assert.equal(f.adapter.status().devices[0].available, false);
    assert.equal(f.adapter.status().manualAvailable, false);
    await f.adapter.close({ restore: false });
  }
});

test('an explicitly rejected monitoring reply still withdraws GPIO evidence', async () => {
  let rejectPoll = false;
  const f = fixture({ transport: ({ body, respond, standard }) => {
    if (rejectPoll && body.op === 'get') return respond(body, { accepted: false, code: 'hardware-fault' });
    standard(body);
  } });
  await f.ready(); rejectPoll = true; f.advance(30000); await f.adapter.tick();
  assert.equal(f.adapter.status().devices[0].available, false);
  assert(f.observations.slice(-4).every(row => row.value === null));
  await f.adapter.close({ restore: false });
});

test('a failed monitoring poll preserves an active lease without extending its deadline', async () => {
  let failPoll = false;
  const f = fixture({ transport: ({ body, standard }) => {
    if (failPoll && body.op === 'get') throw new Error('synthetic publication failure');
    standard(body);
  } });
  await f.ready(); const until = f.now + 60000;
  await f.adapter.lease({ owner: 'cycle', until, renew: false });
  const end = f.native.end_ms;
  failPoll = true; f.advance(30000); await f.adapter.tick();
  assert.equal(f.adapter.status().active, true);
  assert.equal(f.adapter.status().restorationPending, false);
  assert.equal(f.native.end_ms, end); assert.equal(f.saved.outstanding.until, until);
  assert.equal(f.publications.some(row => row.body.op === 'release'), false);
  failPoll = false; f.advance(30001); await f.adapter.tick();
  assert.equal(f.adapter.status().active, false);
  assert.equal(f.saved.outstanding, null);
  assert(f.observations.slice(-4).every(row => row.value === 0));
  await f.adapter.close({ restore: false });
});

test('pooled automatic lease persists before ON, confirms four GPIO outputs, and releases with fresh OFF', async () => {
  const f = fixture(); await f.ready();
  const result = await f.adapter.lease({ owner: 'automatic-cycle', until: f.now + 600000 });
  assert.equal(result.confirmed, true); assert.equal(f.adapter.status().active, true); assert.equal(f.saved.outstanding.mask, 15);
  assert.equal(f.adapter.status().restorationPending, false);
  assert.equal(JSON.stringify(f.adapter.status()).includes(TOKEN), false);
  assert.equal(JSON.stringify(f.observations).includes(TOKEN), false);
  const released = await f.adapter.release(); assert.equal(released.released, true); assert.equal(f.saved.outstanding, null);
  assert(f.adapter.status().devices[0].channels.every(row => row.output === false));
});

test('individual manual channels share an immutable deadline, preserve manual ownership through heating releases and never report pooled active', async () => {
  const f = fixture({ enabled: false }); await f.ready();
  await f.manual(1, true); const firstUntil = f.saved.outstanding.until;
  f.advance(30000); await f.manual(4, true, 'request_2');
  assert.equal(f.native.mask, 9); assert.equal(f.saved.outstanding.until, firstUntil);
  assert.equal(f.adapter.status().mode, 'manual'); assert.equal(f.adapter.status().active, false);
  assert.equal((await f.adapter.release({ scope: 'heating' })).preservedManual, true);
  assert.equal(f.native.mask, 9);
  await f.manual(1, false, 'request_3'); assert.equal(f.native.mask, 8);
  await f.manual(4, false, 'request_4'); assert.equal(f.native.active, false);
  assert.deepEqual(f.adapter.status().manualResult, { channel: 4, enabled: false, at: f.now, status: 'confirmed', confirmed: true });
});

test('old manual ON and OFF requests cannot replay after newer edits or original expiry', async () => {
  const f = fixture(); await f.ready(); const scopeA = f.adapter.status().commandScope;
  await f.manual(1, true, 'A', scopeA);
  const count = f.publications.length; await f.manual(1, true, 'A', scopeA); assert.equal(f.publications.length, count);
  const scopeB = f.adapter.status().commandScope; await f.manual(1, false, 'B', scopeB);
  await assert.rejects(f.manual(1, true, 'A', scopeA), { code: 'FLOOR_STALE' });
  f.advance(900001); await f.adapter.tick();
  await assert.rejects(f.manual(1, true, 'A', scopeA), { code: 'FLOOR_STALE' });
  await f.manual(1, true, 'C');
  await assert.rejects(f.manual(1, false, 'B', scopeB), { code: 'FLOOR_STALE' });
});

test('active GPIO evidence becomes unknown at the reported local expiry and fresh OFF can prove local lease expiry', async () => {
  const f = fixture(); await f.ready();
  await f.adapter.lease({ owner: 'manual-preheat', until: f.now + 60000, renew: false });
  f.advance(60001); assert.equal(f.adapter.status().active, false);
  assert(f.adapter.status().devices[0].channels.every(row => row.output === null));
  const result = await f.adapter.finishLease({ owner: 'manual-preheat' });
  assert.equal(result.outcome, 'device-local'); assert.equal(result.released, true);
});

test('automatic renewal never extends the immutable device treatment end', async () => {
  const f = fixture(); await f.ready(); await f.adapter.lease({ owner: 'cycle', until: f.now + 1800000 });
  const end = f.native.end_ms;
  for (let i = 0; i < 10; i++) { f.advance(30000); await f.adapter.tick(); }
  const renew = f.publications.filter(row => row.body.op === 'renew');
  assert.equal(renew.length, 1); assert.equal(renew[0].body.end_ms, end); assert.equal(f.native.mask, 15);
});

test('manual pooled preheat never renews its original device lease', async () => {
  const f = fixture(); await f.ready(); await f.adapter.lease({ owner: 'manual-preheat', until: f.now + 900000, renew: false });
  for (let i = 0; i < 11; i++) { f.advance(30000); await f.adapter.tick(); }
  assert.equal(f.publications.some(row => row.body.op === 'renew'), false);
});

test('restart preserves obligation and only fresh same-device OFF clears it', async () => {
  const f = fixture(); await f.ready(); await f.manual(2, true);
  const restarted = fixture({ saved: f.saved });
  assert.equal(restarted.adapter.status().restorationPending, true);
  await restarted.ready(); assert.equal(restarted.saved.outstanding, null); assert.equal(restarted.adapter.status().restorationPending, false);
  const replacement = fixture({ saved: f.saved, deviceMac: '02:00:00:00:00:02' }); await replacement.ready();
  assert.equal(replacement.adapter.status().restorationPending, true); assert.deepEqual(replacement.saved, f.saved);
  assert.equal(replacement.publications.length, 0);
});

test('malformed or retired persisted state blocks before any state mutation', async () => {
  for (const saved of [{}, { version: 1, outstanding: null }, { version: 99 }, [], '', false]) {
    const f = fixture({ saved }); await f.ready();
    assert.equal(f.adapter.status().stateUnknown, true); assert.equal(f.adapter.status().restorationPending, true);
    await assert.rejects(f.adapter.lease({ owner: 'new', until: f.now + 60000 }), { code: 'FLOOR_PENDING' });
    assert.equal((await f.adapter.release()).released, false); assert.deepEqual(f.saved, saved); assert.equal(f.writes.length, 0);
  }
});

test('retained and unknown-version packets cannot establish command readiness', async () => {
  const f = fixture(); f.adapter.setConnected(true);
  f.deliver(f.frame({ kind: 'state', op: 'state', id: '' }), { retain: true });
  assert.equal(f.adapter.status().available, false);
  await f.adapter.tick(); assert.equal(f.adapter.status().available, true);
  f.deliver(f.frame({ v: 2, kind: 'state', op: 'state', id: '', now_ms: f.mono + 1 }));
  assert.equal(f.adapter.status().available, false);
  assert(f.adapter.status().devices[0].channels.every(row => row.output === null));
});

test('standby cannot publish, and late role loss is rechecked at the final write guard', async () => {
  const f = fixture(); await f.ready(); f.authority(false);
  await assert.rejects(f.adapter.lease({ owner: 'cycle', until: f.now + 60000 }), { code: 'FLOOR_UNAVAILABLE' });
  const count = f.publications.length; await f.adapter.tick(); assert.equal(f.publications.length, count);
  const g = fixture({ transport: ({ body, options, standard }) => { if (body.op === 'acquire') { g.authority(false); options.beforeWrite(); } else standard(body); } });
  await g.ready(); await assert.rejects(g.adapter.lease({ owner: 'cycle', until: g.now + 60000 }));
  assert.equal(g.native.active, false); assert.equal(g.adapter.status().restorationPending, true);
});

test('partial GPIO mismatch causes whole-lease release and never reports pooled success', async () => {
  const f = fixture({ transport: ({ body, standard, respond, native }) => {
    if (body.op !== 'acquire') return standard(body);
    Object.assign(native, { active: true, mask: 15, gpio_mask: 1, gpio_match: false, owner: body.owner,
      treatment: body.treatment, seq: 1, highwater: body.treatment, end_ms: body.end_ms, lease_until_ms: body.end_ms });
    respond(body, { token: TOKEN });
  } });
  await f.ready(); await assert.rejects(f.adapter.lease({ owner: 'cycle', until: f.now + 60000 }), { code: 'FLOOR_UNCONFIRMED' });
  assert.equal(f.adapter.status().active, false); assert.equal(f.adapter.status().restorationPending, true);
  assert.equal(f.publications.some(row => row.body.op === 'release'), true);
});

test('acquisition capability is available for safe release when saving the confirmed token fails', async () => {
  let rejectActive = true;
  const f = fixture({ beforeSave: next => { if (next.outstanding?.phase === 'active' && rejectActive) { rejectActive = false; throw new Error('synthetic write failure'); } } });
  await f.ready(); await assert.rejects(f.adapter.lease({ owner: 'cycle', until: f.now + 60000 }));
  assert.equal(f.native.active, false); assert.equal(f.publications.some(row => row.body.op === 'release'), true);
});

test('current persisted state rejects missing active capabilities and counter regression before mutation', async () => {
  const f = fixture(); await f.ready(); await f.manual(1, true);
  for (const change of [state => { state.outstanding.token = null; }, state => { state.outstanding.owner = 123; },
    state => { state.sequence = 0; }, state => { state.extra = true; }]) {
    const saved = structuredClone(f.saved); change(saved);
    const invalid = fixture({ saved }); await invalid.ready();
    assert.equal(invalid.adapter.status().stateUnknown, true); assert.equal(invalid.writes.length, 0);
  }
  assert.throws(() => floorOverrideConfiguration({ device_mac: null }));
});

test('wire numbers cannot impersonate string owner fields and duplicate JSON keys are rejected', async () => {
  const f = fixture(); await f.ready();
  f.deliver(f.frame({ kind: 'state', id: '', op: 'state', owner: 123, now_ms: f.mono + 1 }));
  assert.equal(f.adapter.status().available, false);
  await f.adapter.tick();
  const payload = JSON.stringify(f.frame({ kind: 'state', id: '', op: 'state', now_ms: f.mono + 1 })).replace('"v":1', '"v":1,"v":1');
  f.adapter.ingest(FLOOR_MQTT_TOPICS.state, payload);
  assert.equal(f.adapter.status().available, false);
});

test('confirmation that becomes stale while its durable save is waiting cannot report activation success', async () => {
  let advanceDuringSave = true;
  const f = fixture({ beforeSave: next => {
    if (next.outstanding?.phase === 'active' && advanceDuringSave) { advanceDuringSave = false; f.advance(900001); }
  } });
  await f.ready();
  await assert.rejects(f.adapter.lease({ owner: 'cycle', until: f.now + 1800000 }), { code: 'FLOOR_UNCONFIRMED' });
  assert.equal(f.adapter.status().active, false); assert.equal(f.native.active, false);
});

test('device challenge round-trip delay reduces the mapped immutable treatment end', async () => {
  let challengeAt;
  const f = fixture({ transport: ({ body, standard, respond, advance }) => {
    if (body.op !== 'challenge') return standard(body);
    challengeAt = f.mono; advance(100);
    respond(body, { challenge: CHALLENGE, issued_ms: challengeAt, lifetime_ms: 2000, now_ms: f.mono });
  } });
  await f.ready(); const until = f.now + 60000;
  await f.adapter.lease({ owner: 'cycle', until });
  assert.equal(f.native.end_ms, challengeAt + 59900);
});

test('a challenge delayed before dispatch cannot publish acquisition or gain a new deadline', async () => {
  const f = fixture({ transport: ({ body, standard, advance }) => { standard(body); if (body.op === 'challenge') advance(1900); } });
  await f.ready(); await assert.rejects(f.adapter.lease({ owner: 'cycle', until: f.now + 60000 }));
  assert.equal(f.publications.some(row => row.body.op === 'acquire'), false); assert.equal(f.native.active, false);
});

test('each channel retains its own bounded manual receipt across other-channel edits and restart', async () => {
  const f = fixture(); await f.ready(); await f.manual(1, true, 'A');
  const first = f.adapter.status().devices[0].channels[0].lastResult;
  f.advance(1000); await f.manual(2, true, 'B');
  const channels = f.adapter.status().devices[0].channels;
  assert.deepEqual(channels[0].lastResult, first); assert.equal(channels[1].lastResult.at, f.now);
  const restarted = fixture({ saved: f.saved });
  assert.deepEqual(restarted.adapter.status().devices[0].channels[0].lastResult, first);
});

test('healthy same-mask renewal preserves admitted ON learning while changed manual masks record uncertainty', async () => {
  const f = fixture({ transport: ({ body, standard }) => {
    if (body.op === 'renew' && f.saved.outstanding.kind === 'automatic') assert.equal(f.adapter.status().active, true, 'Original admitted grant remains active during renewal dispatch');
    standard(body);
  } });
  await f.ready(); await f.adapter.lease({ owner: 'cycle', until: f.now + 1800000 });
  const first = f.learning.length;
  for (let i = 0; i < 10; i++) { f.advance(30000); await f.adapter.tick(); }
  assert(f.learning.slice(first).every(row => row.mode === 'on'));
  await f.adapter.release(); await f.manual(1, true);
  const last = f.learning.length; await f.manual(2, true, 'manual_2');
  assert(f.learning.slice(last).some(row => row.mode === 'unknown'));
  assert.equal(f.learning.at(-1).mode, 'partial');
});

test('changing an existing immutable deadline cannot shorten or extend its device lease', async () => {
  const f = fixture(); await f.ready(); const until = f.now + 600000;
  await f.adapter.lease({ owner: 'cycle', until }); const commandCount = f.publications.length, original = f.native.end_ms;
  for (const changed of [until - 60000, until + 60000]) await assert.rejects(f.adapter.lease({ owner: 'cycle', until: changed }), { code: 'FLOOR_EXPIRED' });
  assert.equal(f.publications.length, commandCount); assert.equal(f.native.end_ms, original); assert.equal(f.adapter.status().active, true);
  await f.adapter.release(); assert.equal(f.native.active, false);
});

test('authority withdrawal clears live evidence without appending former-master history', async () => {
  const f = fixture(); await f.ready(); await f.manual(1, true);
  const observations = f.observations.length, contexts = f.learning.length;
  f.authority(false); f.adapter.setConnected(false);
  assert.equal(f.adapter.status().devices[0].available, false);
  assert.equal(f.observations.length, observations); assert.equal(f.learning.length, contexts);
});
