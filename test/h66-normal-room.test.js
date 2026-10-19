import test from 'node:test';
import assert from 'node:assert/strict';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { validateH66ControlState } from '../src/domain/heating-control-state.js';

const START = Date.parse('2026-10-19T00:00:00Z');
const turn = () => new Promise(resolve => setImmediate(resolve));
function rig(t, { saved = new Map(), snapshot = () => {}, preparationMs = 80, beforeWrite = () => {} } = {}) {
  let now = START, controller, mode = 'normal', verified = true, authority = true, identity = 'a'.repeat(64);
  const sent = [], events = [], values = { '0203': 21, '0212': 40, '0208': 55, '2201': 1 };
  const store = { getState: key => structuredClone(saved.get(key) ?? null),
    setState(key, value) { validateH66ControlState(value); saved.set(key, structuredClone(value)); },
    event(type, detail) { events.push({ type, detail }); } };
  const decoder = createH66Decoder({ deviceId: 'synthetic-normal-room' });
  const feed = (register, value, extra = {}, admission) => {
    values[register] = value;
    controller.ingest(decoder.decode({ topic: `synthetic-normal-room/HP/${register}`, payload: String(value), receivedAt: now, ...extra }), admission);
  };
  controller = createH66Controller({ deviceId: 'synthetic-normal-room', store, clock: () => now,
    config: { writeEnabled: true, readbackTimeoutMs: 30, confirmationTimeoutMs: 30, preheatPreparationMs: preparationMs },
    canControl: () => authority,
    tariffFeedback: () => ({ mode, verified, identity }), requestSnapshot: () => snapshot({ feed, values }),
    publish: async (topic, payload, options) => {
      options.beforePublish(); beforeWrite(); options.beforeWrite(); options.onFirstWrite();
      const register = topic.split('/').at(-1), value = Number(payload);
      sent.push({ register, value }); queueMicrotask(() => feed(register, value));
    } });
  controller.setConnected(true);
  for (const [register, value] of Object.entries(values)) feed(register, value);
  t.after(() => controller.close());
  return { controller, sent, events, saved, store, feed, values,
    advance(ms = 1) { now += ms; },
    mode(value) { mode = value; }, verified(value) { verified = value; },
    authority(value) { authority = value; }, identity(value) { identity = value; },
    async reduce({ report = true } = {}) {
      await controller.captureTariffReduction(); mode = 'reduction'; now++;
      feed(report ? '0203' : '0107', report ? 11 : 30);
    },
    prepare() { return controller.preparePreheat({ expiresAt: now + 60_000,
      releaseTariff: async () => { mode = 'normal'; now++; } }); },
  };
}

test('Preheat rejects the reduction ROOM, accepts a changed normal baseline and restores that exact value', async t => {
  const r = rig(t); await r.reduce();
  const operation = r.prepare(); await turn();
  r.advance(); r.feed('0203', 11); await turn();
  assert.equal(r.controller.status().normalRoomReady, false);
  assert.equal(r.controller.status().preheatPreparation.reason, 'Waiting for normal ROOM setting.');
  assert.deepEqual(r.sent, []);
  r.advance(); r.feed('0203', 22);
  const prepared = await operation; assert.equal(prepared.roomSettingC, 22);
  await r.controller.setPhase({ phase: 'preheat', normalRoomC: 22, roomBoostC: 5 });
  assert.equal(r.values['0203'], 27);
  await r.controller.restore(); assert.equal(r.values['0203'], 22);
});

for (const invalid of ['retained', 'earlier-receipt', 'earlier-measurement', 'uncommitted', 'missing-reduction'])
  test(`Preheat cannot accept ${invalid} ROOM evidence`, async t => {
    const r = rig(t); await r.reduce({ report: invalid !== 'missing-reduction' });
    const operation = r.prepare(); const rejected = assert.rejects(operation, { code: 'H66_NORMAL_ROOM_TIMEOUT' });
    await turn(); r.advance();
    if (invalid === 'retained') r.feed('0203', 22, { retained: true });
    if (invalid === 'earlier-receipt') r.feed('0203', 22, { receivedAt: START });
    if (invalid === 'earlier-measurement') r.feed('0203', 22, { sourceAt: START });
    if (invalid === 'uncommitted') r.feed('0203', 22, {}, { afterCommit() {} });
    if (invalid === 'missing-reduction') r.feed('0203', 21);
    await rejected; assert.deepEqual(r.sent, []);
    assert.equal(r.controller.status().preheatPreparation, null);
  });

for (const invalid of ['reconnect', 'identity', 'authority', 'tariff-evidence', 'tariff-reenabled'])
  test(`Preheat preparation cancels on ${invalid}`, async t => {
    const r = rig(t); await r.reduce();
    const operation = r.prepare(), rejected = assert.rejects(operation);
    await turn();
    if (invalid === 'reconnect') { r.controller.setConnected(false); r.controller.setConnected(true); }
    if (invalid === 'identity') r.identity('b'.repeat(64));
    if (invalid === 'authority') r.authority(false);
    if (invalid === 'tariff-evidence') r.verified(false);
    if (invalid === 'tariff-reenabled') r.mode('reduction');
    r.advance(); r.feed('0203', 22);
    await rejected; assert.deepEqual(r.sent, []);
  });

test('restart retains unresolved reduction context without granting normal authority', async t => {
  const first = rig(t); await first.reduce(); await first.controller.close();
  const next = rig(t, { saved: first.saved });
  assert.equal(next.controller.status().normalRoomReady, true, 'Fresh normal 21 resolves the preserved reduced 11.');
  const operation = next.prepare(); await turn();
  assert.equal(next.controller.status().normalRoomReady, false, 'Preheat still requires a new post-confirmation report.');
  next.advance(); next.feed('0203', 22); assert.equal((await operation).roomSettingC, 22);
});

test('an explicit confirmed Normal ROOM edit can deliberately select the reduced value', async t => {
  const r = rig(t); await r.reduce(); r.mode('normal'); r.advance(); r.feed('0203', 11);
  assert.equal(r.controller.status().normalRoomReady, false);
  await r.controller.setSetting({ register: '0203', value: 11 });
  assert.equal(r.controller.status().normalRoomReady, true);
  const operation = r.prepare(); await turn(); r.advance(); r.feed('0203', 11);
  assert.equal((await operation).roomSettingC, 11);
});

test('a ROOM change after preparation cancels Preheat before any setting write', async t => {
  const r = rig(t), operation = r.prepare(); await turn(); r.advance(); r.feed('0203', 21);
  const prepared = await operation; r.advance(); r.feed('0203', 22);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat', normalRoomC: prepared.roomSettingC }), { code: 'H66_NORMAL_ROOM_UNCONFIRMED' });
  assert.deepEqual(r.sent, []);
});

test('equal observed normal and reduced ROOM values do not demand an impossible numerical change', async t => {
  const r = rig(t); await r.reduce(); r.feed('0203', 21);
  const operation = r.prepare(); await turn(); r.advance(); r.feed('0203', 21);
  assert.equal((await operation).roomSettingC, 21);
});

test('an early unchanged reduction report cannot authorize a later reduced baseline', async t => {
  const r = rig(t); await r.reduce(); r.feed('0203', 21);
  const operation = r.prepare(), rejected = assert.rejects(operation, { code: 'H66_NORMAL_ROOM_TIMEOUT' });
  await turn(); r.advance(); r.feed('0203', 11);
  await rejected; assert.equal(r.controller.status().normalRoomReady, false);
});

test('a delayed reduced reading cannot replace a normal baseline already confirmed after release', async t => {
  const r = rig(t); await r.reduce();
  const operation = r.prepare(); await turn(); r.advance(); r.feed('0203', 22); await operation;
  r.advance(); r.feed('0203', 11);
  assert.equal(r.controller.status().normalRoomReady, false);
  await assert.rejects(r.controller.setPhase({ phase: 'preheat' }), { code: 'H66_NORMAL_ROOM_UNCONFIRMED' });
  assert.deepEqual(r.sent, []);
});

test('malformed new tariff context fails before writes', () => {
  for (const tariffRoom of [{}, { identity: 'not-bound', mode: 'normal', normalC: 21, reducedC: null, normalAfter: START, awaitingNormal: false }])
    assert.throws(() => validateH66ControlState({ version: 1, phase: 'normal', baseline: {}, requested: {}, obligations: {}, expiresAt: null, lastResult: null, tariffRoom }), { code: 'H66_STATE_UNSUPPORTED' });
});

test('tariff reduction returning before the final byte-write gate cancels the ROOM boost', async t => {
  let r;
  r = rig(t, { beforeWrite: () => r.mode('reduction') });
  const operation = r.prepare(); await turn(); r.advance(); r.feed('0203', 21); await operation;
  await assert.rejects(r.controller.setPhase({ phase: 'preheat', normalRoomC: 21 }));
  assert.deepEqual(r.sent, []);
});

test('a requested tariff period remains ambiguous when its earlier relay feedback and reduced ROOM are missing', async t => {
  const r = rig(t);
  r.verified(false);
  await r.controller.captureTariffReduction({ identity: 'a'.repeat(64) });
  r.verified(true);
  const operation = r.prepare(), rejected = assert.rejects(operation, { code: 'H66_NORMAL_ROOM_TIMEOUT' });
  await turn(); r.advance(); r.feed('0203', 21);
  await rejected;
  assert.deepEqual(r.sent, []);
});
