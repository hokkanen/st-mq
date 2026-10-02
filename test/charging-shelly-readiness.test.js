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
    phase_info: { total_power: 8280, total_act_energy: 4,
      phase_a: { voltage: 230, current: 12, power: 2760 },
      phase_b: { voltage: 230, current: 12, power: 2760 },
      phase_c: { voltage: 230, current: 12, power: 2760 } } };
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
  return { adapter, info, service, serviceStatus, schedules, components, fields, calls, measuredAt,
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
