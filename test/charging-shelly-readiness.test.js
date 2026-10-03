import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyEvseAdapter, createShellyController } from '../src/charging/shelly-evse.js';

const NOW = 1800000000000;
const DEVICE = 'synthetic-readiness-evse';
const PREFIX = 'test/readiness-evse';
const TYPES = { current_limit: 'Number', start_charging: 'Boolean', work_state: 'Enum', phase_info: 'Object' };

function fixture(t, configuration = {}) {
  let now = NOW;
  const client = new EventEmitter(), saved = new Map(), calls = [], measuredAt = {};
  const info = { id: DEVICE, model: 'synthetic-model', fw_id: 'synthetic-firmware' };
  const service = { id: 0, auto_balance: { enable: false }, auto_charge: true,
    global_charge_limit: 0, global_time_limit: 0 };
  const serviceStatus = { state: 'running' }, schedules = { rev: 1, jobs: [] };
  const components = {
    current_limit: { id: 200, owner: 'service:0', access: 'crw', min: 6, max: 16, meta: { ui: { step: 1 } } },
    start_charging: { id: 201, owner: 'service:0', access: 'crw' },
    work_state: { id: 202, owner: 'service:0', access: 'cr',
      options: ['charger_free', 'charger_wait', 'charger_pause', 'charger_end', 'charger_charging'] },
    phase_info: { id: 203, owner: 'service:0', access: 'cr' },
  };
  const fields = { current_limit: 16, start_charging: true, work_state: 'charger_charging',
    phase_info: { total_power: 8.28, total_act_energy: 4,
      phase_a: { voltage: 230, current: 12, power: 2.76 },
      phase_b: { voltage: 230, current: 12, power: 2.76 },
      phase_c: { voltage: 230, current: 12, power: 2.76 } } };
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    calls.push({ ...frame, topic, options });
    let result;
    if (frame.method === 'Shelly.GetDeviceInfo') result = info;
    else if (frame.method === 'Service.GetConfig') result = service;
    else if (frame.method === 'Service.GetStatus') result = serviceStatus;
    else if (frame.method === 'Schedule.List') result = schedules;
    else if (frame.method.endsWith('.GetConfig')) result = components[frame.params.role];
    else if (frame.method.endsWith('.Set')) {
      fields[frame.params.role] = frame.params.value;
      measuredAt[frame.params.role] = now;
      result = null;
    }
    else result = { value: fields[frame.params.role], last_update_ts: (measuredAt[frame.params.role] ?? now) / 1000 };
    const reply = Buffer.from(JSON.stringify({ id: frame.id, src: DEVICE, dst: frame.src, result }));
    done?.();
    queueMicrotask(() => client.emit('message', `${frame.src}/rpc`, reply, {}));
  };
  const config = chargingConfiguration({ chargers: { charger2: {
    enabled: true, deviceId: DEVICE, topicPrefix: PREFIX, ...configuration,
  } } }).chargers.charger2;
  const adapter = createShellyEvseAdapter({ config, client, broker: { address: 'mqtt://synthetic-readiness' },
    clock: () => now, canControl: () => true,
    store: { getState: key => structuredClone(saved.get(key)),
      setState: (key, value) => saved.set(key, structuredClone(value)), transaction: fn => fn(), event() {} },
    engine: { recorder: { recordEnergy() {}, energyGap() {} }, voltage: { ingest() {} } },
  });
  t.after(() => adapter.close());
  return { adapter, client, info, service, serviceStatus, schedules, components, fields, calls, measuredAt,
    advance(milliseconds) { now += milliseconds; },
    mutations: () => calls.filter(call => call.method.endsWith('.Set')),
    async ready() {
      client.emit('connect');
      client.emit('message', `${PREFIX}/online`, Buffer.from('true'), { retain: true });
      await adapter.refresh();
    },
    async refresh() { now += 1000; await adapter.refresh(); },
    notify(role, value) {
      now += 1000;
      fields[role] = value;
      measuredAt[role] = now;
      client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE,
        method: 'NotifyStatus', params: {
          [`${TYPES[role].toLowerCase()}:${components[role].id}`]: { value, last_update_ts: now / 1000 },
        } })), {});
    },
    command(role, value, extra = {}) {
      return adapter.rpc(`${TYPES[role]}.Set`, { owner: 'service:0', role, value }, { mutation: true, ...extra });
    },
  };
}

test('correlated current readback keeps a stable 6 A setting usable without rewriting its source clock', async t => {
  const f = fixture(t);
  f.fields.current_limit = 6;
  await f.ready();
  f.notify('current_limit', 6);
  const observedAt = f.adapter.snapshot().fields.current_limit.measuredAt;
  // The native status response uses the original update second while the
  // notification dated the same setting one second later.
  f.measuredAt.current_limit = observedAt - 1000;
  for (let repeat = 0; repeat < 3; repeat++) {
    f.advance(16000);
    assert.equal(f.adapter.snapshot().controlReady, false);
    await f.adapter.refresh();
    const snapshot = f.adapter.snapshot(), field = snapshot.fields.current_limit;
    assert.equal(snapshot.controlReady, true);
    assert.equal(snapshot.identificationReady, true);
    assert.equal(field.value, 6);
    assert.equal(field.measuredAt, observedAt, 'No new source event or instruction is invented');
    assert.equal(field.readback.measuredAt, observedAt - 1000, 'The actual RPC source clock is preserved too');
    assert.equal(field.readback.receivedAt, snapshot.readAt);
    assert.equal(field.readback.requestedAt, snapshot.readAt);
    assert.equal(f.adapter.normalize(null).currentA.value, 6);
  }
  assert.equal(f.mutations().length, 0, 'Reconciliation must not change the native setting');
});

test('unsolicited same-clock setting notifications cannot renew expired receipt evidence', async t => {
  const f = fixture(t); await f.ready();
  f.advance(16000);
  for (const [role, type] of Object.entries(TYPES)) {
    if (role === 'phase_info') continue;
    f.client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE,
      method: 'NotifyStatus', params: { [`${type.toLowerCase()}:${f.components[role].id}`]:
        { value: f.fields[role], last_update_ts: NOW / 1000 } } })), {});
    assert.equal(f.adapter.snapshot().fields[role].receivedAt, NOW);
  }
  assert.equal(f.adapter.snapshot().controlReady, false);
  await assert.rejects(f.command('start_charging', true));
  await f.adapter.refresh();
  assert.equal(f.adapter.snapshot().controlReady, true, 'Only a new correlated read confirms the current settings');
});

test('an older contradictory current reply blocks commands until a matching readback arrives', async t => {
  const f = fixture(t); await f.ready();
  f.notify('current_limit', 6);
  const before = f.adapter.snapshot().fields.current_limit;
  f.fields.current_limit = 16; f.measuredAt.current_limit = NOW;
  await f.refresh();
  assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.adapter.snapshot().error, 'conflicting-evse-reading');
  assert.deepEqual(f.adapter.snapshot().fields.current_limit, before);
  await assert.rejects(f.command('start_charging', true));
  f.fields.current_limit = 6;
  await f.refresh();
  assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.adapter.snapshot().error, null);
  assert.equal(f.adapter.snapshot().fields.current_limit.measuredAt, before.measuredAt);
  assert.equal(f.mutations().length, 0);
});

test('recovery waits for all setting readbacks while a healthy refresh keeps existing readiness', async t => {
  for (const recovering of [false, true]) await t.test(recovering ? 'conflicting readback recovery' : 'healthy polling', async t => {
    const f = fixture(t); await f.ready();
    f.notify('current_limit', 6);
    if (recovering) {
      f.fields.current_limit = 16; f.measuredAt.current_limit = NOW;
      await f.refresh();
      assert.equal(f.adapter.snapshot().controlReady, false);
      f.fields.current_limit = 6;
    }
    const publish = f.client.publish;
    let releaseCurrent, releaseWork, currentRequested, workRequested;
    const currentPending = new Promise(resolve => { currentRequested = resolve; });
    const workPending = new Promise(resolve => { workRequested = resolve; });
    f.client.publish = (topic, payload, options, done) => {
      const frame = JSON.parse(payload);
      if (!['Number.GetStatus', 'Enum.GetStatus'].includes(frame.method)) return publish(topic, payload, options, done);
      const release = () => publish(topic, payload, options, done);
      if (frame.method === 'Number.GetStatus') { releaseCurrent = release; currentRequested(); }
      else { releaseWork = release; workRequested(); }
    };
    const refresh = f.adapter.refresh(); await currentPending;
    assert.equal(f.adapter.snapshot().controlReady, !recovering);
    if (recovering) {
      assert.equal(f.adapter.snapshot().error, 'conflicting-evse-reading');
      await assert.rejects(f.command('start_charging', true));
    }
    releaseCurrent(); await workPending;
    assert.equal(f.adapter.snapshot().controlReady, !recovering, 'A partial recovery must not reopen command admission');
    if (recovering) await assert.rejects(f.command('start_charging', true));
    releaseWork(); await refresh;
    assert.equal(f.adapter.snapshot().controlReady, true);
    assert.equal(f.adapter.snapshot().error, null);
    assert.equal(f.mutations().length, 0);
  });
});

test('a conflicting native event during refresh cannot be cleared by the remaining successful replies', async t => {
  for (const heldMethod of ['Service.GetStatus', 'Number.GetStatus']) await t.test(heldMethod, async t => {
    const f = fixture(t); await f.ready();
    const publish = f.client.publish;
    let release, announced;
    const requested = new Promise(resolve => { announced = resolve; });
    f.client.publish = (topic, payload, options, done) => {
      const frame = JSON.parse(payload);
      if (frame.method !== heldMethod) return publish(topic, payload, options, done);
      f.client.publish = publish;
      release = () => publish(topic, payload, options, done); announced();
    };
    const refresh = f.adapter.refresh(); await requested;
    f.client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE,
      method: 'NotifyStatus', params: { 'number:200': { value: 6, last_update_ts: NOW / 1000 } } })), {});
    assert.equal(f.adapter.snapshot().controlReady, false);
    release(); await refresh;
    assert.equal(f.adapter.snapshot().controlReady, false);
    assert.equal(f.adapter.snapshot().error, 'conflicting-evse-reading');
    await assert.rejects(f.command('start_charging', true));
    await f.adapter.refresh();
    assert.equal(f.adapter.snapshot().controlReady, true, 'A subsequent complete healthy refresh can recover');
  });
});

test('a native event during a pending query fences its delayed setting reply even at the same value', async t => {
  for (const value of [6, 16]) await t.test(`${value} A event`, async t => {
    const f = fixture(t); f.fields.current_limit = 6; await f.ready();
    const publish = f.client.publish;
    let release, announced;
    const requested = new Promise(resolve => { announced = resolve; });
    f.client.publish = (topic, payload, options, done) => {
      const frame = JSON.parse(payload);
      if (frame.method !== 'Number.GetStatus') return publish(topic, payload, options, done);
      f.client.publish = publish;
      done?.();
      release = () => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
        id: frame.id, src: DEVICE, dst: frame.src, result: { value: 6, last_update_ts: NOW / 1000 },
      })), {});
      announced();
    };
    const refresh = f.adapter.refresh();
    await requested;
    f.notify('current_limit', value);
    const observed = f.adapter.snapshot().fields.current_limit;
    f.advance(16000);
    release(); await refresh;
    assert.deepEqual(f.adapter.snapshot().fields.current_limit, observed);
    assert.equal(f.adapter.snapshot().controlReady, false, 'A delayed query cannot refresh a later native event');
    await assert.rejects(f.command('start_charging', true));
    assert.equal(f.mutations().length, 0);
  });
});

test('a reply from a disconnected MQTT generation cannot confirm the new connection', async t => {
  const f = fixture(t); await f.ready();
  const publish = f.client.publish;
  let release, announced;
  const requested = new Promise(resolve => { announced = resolve; });
  f.client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    if (frame.method !== 'Number.GetStatus') return publish(topic, payload, options, done);
    done?.();
    release = () => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: DEVICE, dst: frame.src, result: { value: 6, last_update_ts: NOW / 1000 },
    })), {});
    announced();
  };
  const refresh = f.adapter.refresh(); await requested;
  const before = f.adapter.snapshot().fields.current_limit;
  f.client.emit('offline'); await refresh;
  f.client.emit('connect');
  release();
  assert.deepEqual(f.adapter.snapshot().fields.current_limit, before);
  assert.equal(f.adapter.snapshot().controlReady, false);
  f.client.emit('offline'); await f.adapter.refresh();
});

test('a setting query started before command dispatch cannot refresh the pre-command value', async t => {
  const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true });
  await f.ready();
  const publish = f.client.publish;
  let release, announced;
  const requested = new Promise(resolve => { announced = resolve; });
  f.client.publish = (topic, payload, options, done) => {
    const frame = JSON.parse(payload);
    if (frame.method !== 'Number.GetStatus') return publish(topic, payload, options, done);
    f.client.publish = publish; done?.();
    release = () => f.client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: DEVICE, dst: frame.src, result: { value: 16, last_update_ts: NOW / 1000 },
    })), {});
    announced();
  };
  const refresh = f.adapter.refresh(); await requested;
  f.advance(1000); await f.command('current_limit', 6);
  const before = f.adapter.snapshot().fields.current_limit;
  f.advance(16000); release(); await refresh;
  assert.deepEqual(f.adapter.snapshot().fields.current_limit, before);
  assert.equal(f.adapter.snapshot().controlReady, false);
  await f.adapter.refresh();
  assert.equal(f.adapter.snapshot().fields.current_limit.value, 6);
  assert.equal(f.adapter.snapshot().controlReady, true);
});

test('Shelly discovers basic control without manual commissioning or current-step metadata', async t => {
  const f = fixture(t);
  delete f.components.current_limit.meta.ui.step;
  await f.ready();
  assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.adapter.snapshot().pluggedIn, true);
  assert.equal(f.mutations().length, 0, 'discovery must never commission by actuating equipment');
  await f.command('start_charging', false);
  assert.deepEqual(f.mutations().map(call => [call.method, call.params.value]), [['Boolean.Set', false]]);
  await assert.rejects(f.command('current_limit', 10));
  assert.equal(f.mutations().length, 1, 'missing numeric capability cannot authorize a current write');
});

test('basic start/stop preserves native load balancing and native settings', async t => {
  const f = fixture(t);
  f.service.auto_balance = { enable: true, max_current: 20, em_ip: '192.0.2.4' };
  f.service.auto_charge = false;
  f.service.global_charge_limit = 18;
  f.service.global_time_limit = 120;
  const settings = structuredClone(f.service);
  await f.ready();
  assert.equal(f.adapter.snapshot().controlReady, true);
  await f.command('start_charging', false);
  await f.command('start_charging', true);
  assert.deepEqual(f.service, settings);
  assert.ok(f.mutations().every(call => call.method === 'Boolean.Set'));
  await assert.rejects(f.command('current_limit', 10));
});

test('charger_end preserves the physical connection and unknown work states do not invent an unplug', async t => {
  const f = fixture(t);
  await f.ready();
  const connection = f.adapter.snapshot().session;
  f.notify('work_state', 'charger_end');
  assert.equal(f.adapter.snapshot().pluggedIn, true);
  assert.equal(f.adapter.snapshot().charging, false);
  assert.deepEqual(f.adapter.snapshot().session, connection);
  f.notify('work_state', 'unknown_future_state');
  assert.equal(f.adapter.snapshot().pluggedIn, null);
  assert.equal(f.adapter.snapshot().charging, null);
  assert.equal(f.adapter.snapshot().identificationReady, false);
  assert.equal(f.adapter.snapshot().controlReady, false);
  assert.deepEqual(f.adapter.snapshot().session, connection);
  await assert.rejects(f.command('start_charging', true));
  f.notify('work_state', 'charger_charging');
  assert.equal(f.adapter.snapshot().session.sessionId, connection.sessionId);
  f.notify('work_state', 'charger_free');
  assert.equal(f.adapter.snapshot().pluggedIn, false);
  assert.equal(f.adapter.snapshot().session.sessionId, null);
});

test('native restrictions withdraw basic control until fresh healthy service evidence', async t => {
  for (const restricted of [{ state: 'stopped' }, { errors: ['overtemperature'] }, { flags: ['charge_limit'] }]) {
    await t.test(JSON.stringify(restricted), async t => {
      const f = fixture(t);
      await f.ready();
      Object.assign(f.serviceStatus, restricted);
      await f.refresh();
      assert.equal(f.adapter.snapshot().controlReady, false);
      await assert.rejects(f.command('start_charging', true));
      assert.equal(f.mutations().length, 0);
      Object.assign(f.serviceStatus, { state: 'running', errors: [], flags: [] });
      await f.refresh();
      assert.equal(f.adapter.snapshot().controlReady, true);
    });
  }
});

test('incompatible device identity, EVSE role ownership, permissions and state vocabulary fail closed', async t => {
  const cases = [
    ['identity', f => { f.info.id = 'different-synthetic-device'; }],
    ['service owner', f => { f.components.start_charging.owner = 'service:1'; }],
    ['start permission', f => { f.components.start_charging.access = 'cr'; }],
    ['electrical permission', f => { f.components.phase_info.access = 'c'; }],
    ['enum states', f => { f.components.work_state.options = ['open', 'closed']; }],
    ['unreadable enum states', f => { delete f.components.work_state.options; }],
  ];
  for (const [name, modify] of cases) await t.test(name, async t => {
    const f = fixture(t); modify(f); await f.ready();
    assert.equal(f.adapter.snapshot().controlReady, false);
    assert.equal(f.adapter.snapshot().pluggedIn, null);
    assert.equal(f.adapter.snapshot().session, null, 'an unsupported role profile cannot establish a physical session');
    await assert.rejects(f.command('start_charging', true));
    assert.equal(f.mutations().length, 0);
  });
});

test('numeric mutations require enabled load management and live supported capabilities', async t => {
  const basic = fixture(t);
  await basic.ready();
  await assert.rejects(basic.command('current_limit', 10));
  assert.equal(basic.mutations().length, 0);

  const managed = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true });
  await managed.ready();
  await managed.command('current_limit', 10);
  assert.deepEqual(managed.mutations().map(call => call.params.value), [10]);
  for (const value of [5, 17, 10.5]) await assert.rejects(managed.command('current_limit', value));
  assert.equal(managed.mutations().length, 1);
  managed.service.auto_balance.enable = true;
  await managed.refresh();
  await assert.rejects(managed.command('current_limit', 8));
  assert.equal(managed.mutations().length, 1);
});

test('unsupported numeric capabilities disable current control without blocking basic stop', async t => {
  const cases = [
    ['missing step', component => { delete component.meta.ui.step; }],
    ['different step', component => { component.meta.ui.step = 2; }],
    ['different minimum', component => { component.min = 8; }],
    ['lower native maximum', component => { component.max = 12; }],
    ['read-only current', component => { component.access = 'cr'; }],
  ];
  for (const [name, modify] of cases) await t.test(name, async t => {
    const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true });
    modify(f.components.current_limit);
    await f.ready();
    assert.equal(f.adapter.snapshot().controlReady, true);
    assert.equal(f.adapter.snapshot().currentControlReady, false);
    await assert.rejects(f.command('current_limit', 10));
    assert.equal(f.mutations().length, 0);
    await f.command('start_charging', false);
    assert.equal(f.mutations().length, 1);
  });
});

test('callers cannot bypass actuation admission by omitting or clearing the mutation flag', async t => {
  const f = fixture(t);
  await f.ready();
  f.serviceStatus.errors = ['overtemperature'];
  await f.refresh();
  for (const options of [undefined, { mutation: false }]) {
    await assert.rejects(f.adapter.rpc('Boolean.Set', { owner: 'service:0', role: 'start_charging', value: true }, options));
    await assert.rejects(f.adapter.rpc('Number.Set', { owner: 'service:0', role: 'current_limit', value: 10 }, options));
  }
  assert.equal(f.mutations().length, 0);
});

test('native current capability changes are rechecked on every refresh', async t => {
  const cases = [
    ['lower maximum', component => { component.max = 12; }],
    ['withdrawn step', component => { delete component.meta.ui.step; }],
    ['read-only current', component => { component.access = 'cr'; }],
    ['component replacement', component => { component.id = 299; }],
    ['service replacement', component => { component.owner = 'service:1'; }],
  ];
  for (const [name, modify] of cases) await t.test(name, async t => {
    const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true });
    await f.ready();
    assert.equal(f.adapter.snapshot().currentControlReady, true);
    modify(f.components.current_limit);
    await f.refresh();
    assert.equal(f.adapter.snapshot().currentControlReady, false);
    await assert.rejects(f.command('current_limit', 10));
    assert.equal(f.mutations().length, 0);
  });
});

test('source-time-invalid current readback cannot authorize numeric control after publication awaits', async t => {
  const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true });
  await f.ready();
  await assert.rejects(f.command('current_limit', 10, { beforePublish: async () => {
    f.advance(16000);
    f.measuredAt.current_limit = 0;
    await f.refresh();
  } }));
  assert.equal(f.adapter.snapshot().controlReady, false, 'scheduling must also know the current native current setting');
  assert.equal(f.mutations().length, 0, 'numeric mutation needs its own current-setting evidence');
});

test('native restriction arriving while a mutation awaits publication revokes the command', async t => {
  const f = fixture(t);
  await f.ready();
  await assert.rejects(f.command('start_charging', true, { beforePublish: async () => {
    f.serviceStatus.flags = ['charge_limit'];
    await f.refresh();
  } }));
  assert.equal(f.mutations().length, 0);
});

test('a same-value native current selection supersedes the controller current setting', async t => {
  const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true, dwellMs: 0 });
  for (const role of Object.keys(TYPES)) f.measuredAt[role] = NOW;
  await f.ready();
  let now = NOW + 1000;
  f.advance(1000);
  const controller = createShellyController({ adapter: f.adapter, canControl: () => true, clock: () => now });
  t.after(() => controller.close());
  await controller.update({ enabled: false, allocation: { allocationA: 8 } });
  assert.equal(f.fields.current_limit, 8);
  f.notify('current_limit', 8);
  now += 1000;
  const before = f.mutations().length;
  await controller.update({ enabled: false, allocation: { allocationA: 16 } });
  assert.equal(f.fields.current_limit, 8, 'later automatic headroom cannot override the newer native selection');
  assert.equal(f.mutations().length, before);
  assert.equal(controller.status().manualCurrentA, 8);
});

test('a native current choice arriving between acceptance and readback retains its ceiling', async t => {
  const f = fixture(t, { limiterEnabled: true, additiveCurrentVerified: true, dwellMs: 0 });
  for (const role of Object.keys(TYPES)) f.measuredAt[role] = NOW;
  await f.ready();
  let now = NOW + 1000, selected = false;
  f.advance(1000);
  const controller = createShellyController({ adapter: f.adapter, canControl: () => true, clock: () => now,
    saveState: state => {
      if (!selected && state.pending?.role === 'current_limit' && state.pending.stage === 'accepted') {
        selected = true;
        f.notify('current_limit', state.pending.value);
        now += 1000;
      }
    },
  });
  t.after(() => controller.close());
  await controller.update({ enabled: false, allocation: { allocationA: 8 } });
  assert.equal(f.fields.current_limit, 8);
  const before = f.mutations().length;
  await controller.update({ enabled: false, allocation: { allocationA: 16 } });
  assert.equal(f.fields.current_limit, 8, 'readback must not claim a newer native choice as an owned instruction');
  assert.equal(f.mutations().length, before);
  assert.equal(controller.status().manualCurrentA, 8);
});
