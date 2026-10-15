import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';

const START = Date.parse('2026-10-15T10:00:00Z');
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-stream-worker-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  let now = START;
  const runtime = new ChargingRuntime({ engine: {}, store, config: { input: 'mqtt',
    connections: { easee: { charger_id: 'synthetic-charger' } } }, clock: () => now, canControl: () => true });
  // Exercise real stream receipt and persistence without starting a physical
  // controller or the separate asynchronous reconciliation episode.
  t.mock.method(runtime, 'scheduleStreamReconcile', () => {});
  const item = runtime.chargers.charger1;
  item.controller = { status: () => ({ session: { connectedAt: START - 5000 } }), close() {} };
  const gates = [], owned = [];
  t.after(async () => {
    for (const gate of owned) gate.release();
    await runtime.close(); await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await store.startWriter();
  const request = store.writer.request.bind(store.writer);
  store.writer.request = async (command, args) => {
    if (command === 'commit' && gates.length) {
      const gate = gates.shift(); gate.enter(); await gate.resumed;
      if (gate.fail) throw Object.assign(new Error('Synthetic charging COMMIT failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return request(command, args);
  };
  const hold = fail => {
    let enter, release;
    const gate = { fail, entered: new Promise(resolve => { enter = resolve; }), resumed: new Promise(resolve => { release = resolve; }),
      enter: () => enter(), release: () => release() };
    gates.push(gate); owned.push(gate); return gate;
  };
  const event = (id, value, previousValue, measuredAt = START + 1, previousMeasuredAt = START - 1) => {
    now = measuredAt + 1;
    assert.equal(runtime.receiveEaseeObservation({ id, value, previousValue, measuredAt, receivedAt: now, previousMeasuredAt }), true);
  };
  const match = { id: 'tesla', vehicleAssociation: 'synthetic-tesla', scope: `${item.association}:${START - 5000}`,
    association: item.association, connectedAt: START - 5000, matchedAt: START - 1000, revision: 1 };
  return { runtime, store, item, hold, event, match };
}

for (const transition of ['unplug-replug', 'charging']) test(`consumed ${transition} stream facts survive older worker rollback`, async t => {
  const f = await fixture(t), older = f.hold(true), saving = f.hold(false);
  f.item.vehicleMatch = structuredClone(f.match);
  const failed = assert.rejects(f.runtime.write(() => {
    f.runtime.revision = 99; f.item.replan = true; f.item.vehicleMatch = null;
    f.store.setState('older', true);
  }), /Synthetic charging COMMIT failure/);
  await older.entered;
  if (transition === 'unplug-replug') { f.event(100, 'A', 'B'); f.event(100, 'B', 'A', START + 11, START + 1); }
  else f.event(109, 3, 2);
  const evidence = structuredClone(f.item.streamEvidence), boundary = structuredClone(f.item.vehicleDisconnect);
  older.release(); await failed; await saving.entered;
  assert.deepEqual(f.item.streamEvidence, evidence);
  assert.deepEqual(f.item.vehicleDisconnect, boundary);
  assert.equal(f.item.replan, false, 'Unrelated provisional transaction state still rolls back');
  assert.equal(f.runtime.revision, 0);
  assert.deepEqual(f.item.vehicleMatch, transition === 'unplug-replug' ? null : f.match,
    'Only a new physical boundary withdraws the restored identity');
  assert.equal(f.runtime.streamPersistencePending, true);
  saving.release(); await f.store.runWrite(() => {});
  const saved = readChargingRuntime(f.store, f.runtime.key).chargers.charger1;
  assert.deepEqual(saved.streamEvidence, evidence);
  assert.deepEqual(saved.vehicleDisconnect, boundary);
  assert.equal(f.runtime.streamPersistencePending, false);
});

test('older successful stream commit cannot release a newer undurable native boundary', async t => {
  const f = await fixture(t), first = f.hold(false), second = f.hold(false);
  f.event(100, 'A', 'B'); await first.entered;
  f.event(100, 'B', 'A', START + 11, START + 1);
  const evidence = structuredClone(f.item.streamEvidence), settlements = [];
  const unsubscribe = f.store.onWriteSettled(() => settlements.push(f.runtime.streamPersistencePending));
  t.after(unsubscribe);
  first.release(); await second.entered;
  assert.equal(settlements[0], true, 'The old COMMIT must retain the command fence between writer jobs');
  assert.equal(f.runtime.streamPersistencePending, true);
  assert.equal(readChargingRuntime(f.store, f.runtime.key).chargers.charger1.streamEvidence.boundary.reconnected, undefined);
  second.release(); await f.store.runWrite(() => {});
  assert.equal(f.runtime.streamPersistencePending, false);
  assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers.charger1.streamEvidence, evidence);
});

for (const reconnect of [false, true]) test(`runtime rollback preserves MQTT transport loss${reconnect ? ' and reconnect without a report' : ''}`, async t => {
  const f = await fixture(t), feed = f.runtime.vehicleFeeds.bmw;
  f.runtime.setMqttStatus({ connected: true, subscribed: true, reason: null }, 'bmw');
  feed.mqtt.lastValidLiveAt = START; feed.mqtt.lastMessageAt = START;
  const older = f.hold(true);
  const failed = assert.rejects(f.runtime.write(() => {
    feed.mqtt.lastValidLiveAt = START + 1; feed.mqtt.lastMessageAt = START + 1;
    f.store.setState('older', true);
  }), /Synthetic charging COMMIT failure/);
  await older.entered;
  f.runtime.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected', broker: 'ha' }, 'bmw');
  if (reconnect) f.runtime.setMqttStatus({ connected: true, subscribed: true, reason: null, broker: 'ha' }, 'bmw');
  older.release(); await failed;
  assert.equal(feed.mqtt.connected, reconnect); assert.equal(feed.mqtt.subscribed, reconnect);
  assert.equal(feed.mqtt.lastValidLiveAt, null, 'Restored heartbeat cannot prove a report after transport loss');
  assert.equal(feed.mqtt.lastMessageAt, START, 'Provisional report metadata still rolls back');
  assert.equal(feed.mqtt.broker, 'ha');
  assert.equal(f.runtime.status().vehicleFeeds.find(row => row.id === 'bmw').reception.available, false);
});

test('failed admitted MQTT subscription state stays owned by its transaction', async t => {
  const f = await fixture(t), older = f.hold(true), feed = f.runtime.vehicleFeeds.bmw;
  const failed = assert.rejects(f.runtime.write(() => {
    f.runtime.setMqttStatus({ connected: true, subscribed: true, reason: null }, 'bmw');
    f.store.setState('subscription', true);
  }), /Synthetic charging COMMIT failure/);
  await older.entered; older.release(); await failed;
  assert.equal(feed.mqtt.connected, false); assert.equal(feed.mqtt.subscribed, false);
  assert.equal(feed.mqtt.lastValidLiveAt, null);
});
