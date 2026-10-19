import test from 'node:test';
import assert from 'node:assert/strict';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { h66RequestResult } from '../chart/manual-control-status.js';

const values = { '0203': 20, '0212': 44, '0208': 60, '2201': 1 };
const changes = { '0203': 21, '0212': 45, '0208': 61, '2201': 2 };
function rig(t, { confirmationMs = 80, dispatch = true, delay = null, retained = false } = {}) {
  let controller;
  const saved = new Map(), commands = [], events = [];
  const store = { getState: key => structuredClone(saved.get(key) ?? null),
    setState: (key, value) => saved.set(key, structuredClone(value)),
    event: (type, detail) => events.push({ type, detail }) };
  const deviceId = 'synthetic-consistent-h66', decoder = createH66Decoder({ deviceId });
  const feed = (register, value, extra = {}) => controller.ingest(decoder.decode({
    topic: `${deviceId}/HP/${register}`, payload: String(value), receivedAt: Date.now(), ...extra }));
  controller = createH66Controller({ deviceId, store,
    config: { writeEnabled: true, readbackTimeoutMs: 20, confirmationTimeoutMs: confirmationMs },
    publish: async (topic, value, options) => {
      options.beforePublish();
      if (dispatch) options.onFirstWrite();
      commands.push({ register: topic.split('/').at(-1), value: Number(value) });
      if (delay !== null) setTimeout(() => feed(topic.split('/').at(-1), Number(value), { retained }), delay);
    } });
  controller.setConnected(true);
  for (const [register, value] of Object.entries(values)) feed(register, value);
  t.after(() => controller.close());
  return { controller, commands, events, feed };
}

for (const register of Object.keys(values)) {
  test(`${register}: confirmation may arrive after the dispatch budget without resending`, async t => {
    const r = rig(t, { delay: 35 });
    const result = await r.controller.setSetting({ register, value: changes[register] });
    assert.equal(result.confirmed, true); assert.equal(result.sent, true);
    assert(result.confirmedAt >= result.dispatchedAt + 20);
    assert.equal(result.code, undefined); assert.equal(r.commands.length, 1);
  });

  test(`${register}: late confirmation clears timeout and records one consistent receipt`, async t => {
    const r = rig(t, { confirmationMs: 20 });
    await assert.rejects(r.controller.setSetting({ register, value: changes[register] }), { code: 'H66_READBACK_TIMEOUT' });
    assert.equal(r.controller.status().lastManual.sent, true);
    r.feed(register, changes[register]);
    const result = r.controller.status().lastManual;
    assert.equal(result.status, 'confirmed'); assert.equal(result.confirmed, true);
    assert.equal(result.sent, true); assert.equal(result.code, undefined);
    assert.equal(result.readback, changes[register]);
    assert.equal(r.events.filter(row => row.type === 'h66-native-setting-confirmed').length, 1);
    r.feed(register, changes[register]);
    assert.equal(r.events.filter(row => row.type === 'h66-native-setting-confirmed').length, 1);
    assert.equal(r.commands.length, 1);
  });

  test(`${register}: retained feedback cannot confirm the write`, async t => {
    const r = rig(t, { confirmationMs: 20, delay: 2, retained: true });
    await assert.rejects(r.controller.setSetting({ register, value: changes[register] }), { code: 'H66_READBACK_TIMEOUT' });
    assert.equal(r.controller.status().lastManual.confirmed, false);
    assert.equal(r.commands.length, 1);
  });

  test(`${register}: temporary edits use the same confirmation budget and restore their baseline`, async t => {
    const r = rig(t, { delay: 35 });
    await r.controller.writeSettings({ [register]: changes[register] }, { expiresAt: Date.now() + 1000 });
    await r.controller.restore();
    assert.deepEqual(r.commands.map(row => row.value), [changes[register], values[register]]);
    assert.deepEqual(r.controller.status().obligations, {});
    assert.equal(r.controller.status().lastManual, null);
  });
}

test('a matching report before dispatch cannot confirm a failed unsent request or its UI receipt', async t => {
  const r = rig(t, { dispatch: false, delay: 2 });
  await assert.rejects(r.controller.setSetting({ register: '0203', value: 21 }), { code: 'H66_READBACK_TIMEOUT' });
  const status = r.controller.status();
  assert.equal(status.lastManual.status, 'failed'); assert.equal(status.lastManual.sent, false);
  assert.equal(status.lastManual.confirmed, false);
  assert.equal(h66RequestResult({ now: Date.now(), h66: status }).confirmed, false);
});

test('a matching pre-dispatch report cannot settle a sent request after its confirmation timeout', async t => {
  let now = Date.now(), controller;
  const decoder = createH66Decoder({ deviceId: 'synthetic-dispatch-fence' });
  const feed = (value, receivedAt = now) => controller.ingest(decoder.decode({
    topic: 'synthetic-dispatch-fence/HP/0203', payload: String(value), receivedAt }));
  controller = createH66Controller({ deviceId: 'synthetic-dispatch-fence', clock: () => now,
    store: { getState: () => null, setState() {} },
    config: { writeEnabled: true, readbackTimeoutMs: 20, confirmationTimeoutMs: 20 },
    publish: async (_topic, _value, options) => {
      options.beforePublish(); feed(21); now++; options.onFirstWrite();
    } });
  t.after(() => controller.close());
  controller.setConnected(true); feed(20);
  await assert.rejects(controller.setSetting({ register: '0203', value: 21 }), { code: 'H66_READBACK_TIMEOUT' });
  assert.equal(controller.status().lastManual.confirmed, false);
  assert.equal(h66RequestResult({ now, h66: controller.status() }).confirmed, false);
  feed(21, now - 1);
  assert.equal(controller.status().lastManual.confirmed, false);
  feed(21);
  assert.equal(controller.status().lastManual.confirmed, true);
});
