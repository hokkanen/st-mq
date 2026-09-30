import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFloorOverride, floorOverrideConfiguration } from '../src/control/floor-override.js';

const source = readFileSync(new URL('../scripts/shelly/floor-lease.js', import.meta.url), 'utf8');
const START = Date.parse('2026-09-20T12:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));
const protocol = 'stmq-floor-v1';

// Execute the actual uploadable script against Shelly's documented callback
// API. Native flip-back timers survive loss of the script and MQTT transport.
function device(prefix, output = () => {}) {
  let elapsed = 0, clockOffset = 0, clockValid = true, running = true, connected = true;
  let commandHandler, watchdog, context;
  const kvs = { stmq_floor_boot_v1: 0 }, channels = [false, false], deadlines = [0, 0], calls = [];
  const config = [0, 1].map(() => ({ initial_state: 'off', auto_on: false, auto_off: true, auto_off_delay: 900, in_mode: 'detached' }));
  const failures = new Set();
  const Shelly = {
    getComponentConfig(kind, id) { return kind === 'mqtt' ? { topic_prefix: prefix } : config[id]; },
    getComponentStatus(kind, id) {
      return kind === 'sys' ? { uptime: elapsed, unixtime: clockValid ? START / 1000 + elapsed + clockOffset : null }
        : { id, output: channels[id] };
    },
    call(method, params, callback) {
      calls.push({ method, params: structuredClone(params) });
      queueMicrotask(() => {
        if (failures.has(`${method}:${params.id}`)) { callback?.(null, -1); return; }
        if (method === 'KVS.Get') callback({ value: kvs[params.key] }, 0);
        else if (method === 'KVS.Set') { kvs[params.key] = params.value; callback({}, 0); }
        else if (method === 'Switch.Set') {
          channels[params.id] = params.on;
          deadlines[params.id] = params.on ? elapsed + (params.toggle_after ?? config[params.id].auto_off_delay) : 0;
          callback?.({ was_on: !params.on }, 0);
        } else throw new Error(`Unexpected RPC ${method}`);
      });
    },
  };
  function boot() {
    channels.fill(false); deadlines.fill(0); running = true;
    context = vm.createContext({ Shelly,
      MQTT: { publish(topic, payload) { if (connected) output(topic, payload); }, subscribe(topic, callback) { commandHandler = callback; } },
      Timer: { set(ms, repeat, callback) { assert.equal(ms, 1000); assert.equal(repeat, true); watchdog = callback; } },
    });
    vm.runInContext(source, context);
  }
  boot();
  return {
    channels, calls, config, failures, boot, kvs,
    send(command) { if (connected && running) commandHandler(`${prefix}/stmq/floor/command`, JSON.stringify(command)); },
    async advance(seconds, { runScript = true } = {}) {
      for (let i = 0; i < seconds; i++) {
        elapsed++;
        for (let id = 0; id < 2; id++) if (deadlines[id] && elapsed >= deadlines[id]) { channels[id] = false; deadlines[id] = 0; }
        if (runScript && running) watchdog();
        await flush();
      }
    },
    clock(value) { clockValid = value; }, offset(value) { clockOffset = value; }, connected(value) { connected = value; },
    stop() { running = false; }, status() { return context; },
  };
}

async function fixture(t, options = {}) {
  let now = START, authority = true, adapter;
  const memory = new Map(), publications = [], snapshots = [];
  const store = { getState: key => structuredClone(memory.get(key)), setState: (key, value) => memory.set(key, structuredClone(value)) };
  const settings = floorOverrideConfiguration({ enabled: true, commissioned: true,
    storage: { topic_prefix: 'invented-floor-storage' }, living: { topic_prefix: 'invented-floor-living' }, ...options });
  const devices = Object.fromEntries(settings.devices.map(row => [row.topicPrefix, device(row.topicPrefix,
    (topic, payload) => adapter?.ingest(topic, payload, {}, now))]));
  await flush();
  const publish = async (topic, payload, flags) => {
    const command = JSON.parse(payload); publications.push({ topic, command, flags });
    snapshots.push(structuredClone(memory.get('floor-override:v1')));
    devices[topic.replace('/stmq/floor/command', '')]?.send(command);
  };
  adapter = createFloorOverride({ store, settings, publish, clock: () => now, canControl: () => authority, readbackTimeoutMs: 100 });
  adapter.setConnected(true); await flush();
  t.after(() => adapter.close());
  return { adapter, devices: Object.values(devices), publications, snapshots, store, settings, publish,
    now: value => { now = value; }, authority: value => { authority = value; },
    async advance(seconds, { tick = true, script = true } = {}) {
      now += seconds * 1000;
      await Promise.all(Object.values(devices).map(item => item.advance(seconds, { runScript: script })));
      if (tick) await adapter.tick(now);
    } };
}

function leaseMessage(extra = {}) {
  return { protocol, requestId: 'invented-request', action: 'lease', boot: 1, sequence: 1,
    owner: 'episode-one', issuedAt: START / 1000, expiresAt: START / 1000 + 900, until: START / 1000 + 3600, ...extra };
}

test('floor configuration is disabled by default and requires two distinct exact devices and bounded leases', () => {
  assert.equal(floorOverrideConfiguration().enabled, false);
  assert.throws(() => floorOverrideConfiguration({ enabled: true }));
  assert.throws(() => floorOverrideConfiguration({ storage: { topic_prefix: '+' } }));
  assert.throws(() => floorOverrideConfiguration({ storage: { topic_prefix: 'same' }, living: { topic_prefix: 'same' } }));
  assert.throws(() => floorOverrideConfiguration({ renew_seconds: 300, lease_seconds: 3000 }));
});

test('pooled activation persists release obligation before all four ONs and uses fresh device readback', async t => {
  const f = await fixture(t);
  assert.equal(f.adapter.status().available, true);
  const result = await f.adapter.lease({ owner: 'cycle-one', until: START + 3_600_000 });
  assert.equal(result.confirmed, true); assert.equal(f.adapter.status().active, true);
  assert(f.devices.every(item => item.channels.every(Boolean)));
  for (let i = 0; i < f.publications.length; i++) {
    const row = f.publications[i]; assert.equal(row.flags.retain, false);
    if (row.command.action === 'lease') assert.equal(f.snapshots[i].outstanding.owner, 'cycle-one');
  }
  const count = f.publications.length;
  await f.adapter.lease({ owner: 'cycle-one', until: START + 3_600_000 });
  assert.equal(f.publications.length, count, 'Early same-owner keep-going is idempotent');
  assert.equal((await f.adapter.release()).released, true);
  assert(f.devices.every(item => item.channels.every(value => !value)));
});

test('renewals extend local lease every five minutes and never past planned end', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'cycle-one', until: START + 1_000_000 });
  for (let i = 0; i < 10; i++) await f.advance(30);
  const result = await f.adapter.lease({ owner: 'cycle-one', until: START + 1_000_000 });
  assert.equal(result.leaseUntil, START + 1_000_000);
  assert(f.publications.filter(row => row.command.action === 'lease').slice(-2).every(row => row.command.expiresAt === (START + 1_000_000) / 1000));
});

test('partial activation releases all outputs and never reports successful pooled treatment', async t => {
  const f = await fixture(t);
  f.devices[1].failures.add('Switch.Set:1');
  await assert.rejects(f.adapter.lease({ owner: 'partial', until: START + 3_600_000 }), { code: 'FLOOR_READBACK' });
  assert.equal(f.adapter.status().active, false);
  assert.equal(f.devices[0].channels.some(Boolean), false);
  assert.equal(f.devices[1].channels[0], false);
});

test('lost release readback retains durable obligation and retry clears it only after OFF readback', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'cycle-one', until: START + 3_600_000 });
  f.devices[1].connected(false);
  const result = await f.adapter.release();
  assert.equal(result.restorationPending, true);
  assert(f.store.getState('floor-override:v1').outstanding);
  f.devices[1].connected(true);
  assert.equal((await f.adapter.release()).released, true);
  assert.equal(f.store.getState('floor-override:v1').outstanding, null);
});

test('host restart releases persisted ownership before permitting another episode', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'old-cycle', until: START + 3_600_000 });
  // Capture the durable obligation before the original controller closes.
  const saved = f.store.getState('floor-override:v1');
  await f.adapter.close(); f.store.setState('floor-override:v1', saved);
  const resumed = createFloorOverride({ store: f.store, settings: f.settings, publish: async (topic, payload) => {
    const command = JSON.parse(payload); const item = f.devices[topic.includes('storage') ? 0 : 1];
    // Dedicated fixture reply is sufficient to verify the restart write order.
    assert.equal(command.action === 'lease', false, 'Restart must first release');
    queueMicrotask(() => resumed.ingest(topic.replace('/command', '/status'), JSON.stringify({
      protocol, requestId: command.requestId, at: START / 1000, boot: 1, sequence: command.sequence ?? 0,
      ready: true, clockOk: true, channels: [{ id: 0, output: false }, { id: 1, output: false }],
    })));
  }, clock: () => START, readbackTimeoutMs: 100 });
  resumed.setConnected(true); await flush();
  assert.equal(resumed.status().restorationPending, false); await resumed.close();
});

test('retained or replayed statuses cannot make devices available', async t => {
  const f = await fixture(t);
  f.adapter.setConnected(false);
  const status = { protocol, requestId: 'old', at: START / 1000, boot: 1, ready: true, clockOk: true,
    channels: [{ id: 0, output: true }, { id: 1, output: true }] };
  assert.equal(f.adapter.ingest('invented-floor-storage/stmq/floor/status', JSON.stringify(status), { retain: true }), false);
  assert.equal(f.adapter.ingest('invented-floor-storage/stmq/floor/status', JSON.stringify(status), { dup: true }), false);
  assert.equal(f.adapter.ingest('invented-floor-storage/stmq/floor/status', JSON.stringify(status)), false);
  assert.equal(f.adapter.status().available, false);
});

test('manual owner supersession releases the previous pooled override before opening a new one', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'automatic', until: START + 3_600_000 });
  const start = f.publications.length;
  await f.adapter.lease({ owner: 'manual', until: START + 600_000 });
  assert.deepEqual(f.publications.slice(start).map(row => row.command.action), ['release', 'release', 'lease', 'lease']);
  assert.equal(f.adapter.status().owner, 'manual');
});

test('loss of command authority or fresh device feedback releases the override', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'cycle', until: START + 3_600_000 });
  f.authority(false); await f.adapter.tick();
  assert.equal(f.adapter.status().active, false);
  assert(f.devices.every(item => item.channels.every(value => !value)));
});

test('actual device script expires without host or broker and duplicate ON cannot restart it', async () => {
  const d = device('invented-device'); await flush();
  d.send(leaseMessage()); await flush(); assert.deepEqual(d.channels, [true, true]);
  d.connected(false); await d.advance(900); assert.deepEqual(d.channels, [false, false]);
  d.connected(true); d.send(leaseMessage()); await flush(); assert.deepEqual(d.channels, [false, false]);
  d.send(leaseMessage({ sequence: 2, issuedAt: START / 1000 + 900, expiresAt: START / 1000 + 1000 }));
  await flush(); assert.deepEqual(d.channels, [false, false], 'Expired owner is closed even for a newly issued renewal');
});

test('native switch timer releases at plan end even if the local script stops', async () => {
  const d = device('invented-device'); await flush();
  d.send(leaseMessage({ expiresAt: START / 1000 + 40, until: START / 1000 + 40 })); await flush();
  d.stop(); await d.advance(40); assert.deepEqual(d.channels, [false, false]);
});

test('device reboot increments persisted boot challenge and rejects pre-reboot commands', async () => {
  const d = device('invented-device'); await flush();
  d.send(leaseMessage()); await flush(); d.boot(); await flush();
  assert.equal(d.kvs.stmq_floor_boot_v1, 2); assert.deepEqual(d.channels, [false, false]);
  d.send(leaseMessage({ sequence: 2 })); await flush(); assert.deepEqual(d.channels, [false, false]);
});

test('release fences queued old ON and duplicates do not extend native timer', async () => {
  const d = device('invented-device'); await flush();
  d.send(leaseMessage()); await flush(); await d.advance(20);
  const before = d.calls.filter(row => row.params.on === true).length;
  d.send(leaseMessage()); await flush();
  assert.equal(d.calls.filter(row => row.params.on === true).length, before);
  d.send({ protocol, requestId: 'release', action: 'release', sequence: 2 }); await flush();
  d.send(leaseMessage()); await flush(); assert.deepEqual(d.channels, [false, false]);
});

test('missing clock, backwards clock step, and unsafe native configuration fail closed', async () => {
  for (const fault of ['missing', 'backwards', 'configuration']) {
    const d = device('invented-device'); await flush(); d.send(leaseMessage()); await flush();
    if (fault === 'missing') d.clock(false);
    if (fault === 'backwards') d.offset(-300);
    if (fault === 'configuration') d.config[1].auto_off = false;
    await d.advance(1); assert.deepEqual(d.channels, [false, false], fault);
  }
});

test('cancel during activation fences the pending ON work and finishes with every relay OFF', async t => {
  const f = await fixture(t);
  const pending = f.adapter.lease({ owner: 'cancelled', until: START + 3_600_000 });
  const rejected = assert.rejects(pending);
  await Promise.resolve();
  const released = f.adapter.release({ reason: 'manual-cancel' });
  await rejected; assert.equal((await released).released, true);
  assert(f.devices.every(item => item.channels.every(value => !value)));
  assert.equal(f.adapter.status().active, false);
});

test('failed durable write prevents any attempted ON publication', async t => {
  const f = await fixture(t);
  const original = f.store.setState;
  f.store.setState = () => { throw new Error('Invented durable-storage failure'); };
  await assert.rejects(f.adapter.lease({ owner: 'not-durable', until: START + 3_600_000 }), /durable-storage/);
  assert.equal(f.publications.some(row => row.command.action === 'lease'), false);
  f.store.setState = original;
});

test('device expiry or output loss invalidates the pooled treatment and releases the other device', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'cycle', until: START + 3_600_000 });
  f.devices[1].channels[1] = false;
  await f.advance(30); await flush();
  assert.equal(f.adapter.status().active, false);
  assert(f.devices.every(item => item.channels.every(value => !value)));
});

test('OFF readback remains usable when the device UTC clock has disappeared', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'cycle', until: START + 3_600_000 });
  f.devices.forEach(item => item.clock(false));
  assert.equal((await f.adapter.release()).released, true);
  assert.equal(f.adapter.status().available, false);
});

test('device refuses expired, future, overlong and old queued lease messages', async () => {
  for (const fields of [
    { expiresAt: START / 1000 }, { issuedAt: START / 1000 + 10 },
    { expiresAt: START / 1000 + 901 }, { issuedAt: START / 1000 - 31 },
    { until: START / 1000 + 100 },
  ]) {
    const d = device('invented-device'); await flush();
    d.send(leaseMessage(fields)); await flush(); assert.deepEqual(d.channels, [false, false]);
  }
});

test('missing durable boot counter prevents local lease acceptance', async () => {
  const d = device('invented-device'); await flush();
  delete d.kvs.stmq_floor_boot_v1; d.boot(); await flush();
  d.send(leaseMessage({ boot: 0 })); await flush(); assert.deepEqual(d.channels, [false, false]);
});

test('close without restoration cancels an in-flight activation without a late cleanup publication', async t => {
  const f = await fixture(t);
  const pending = f.adapter.lease({ owner: 'handoff', until: START + 3_600_000 });
  const rejected = assert.rejects(pending);
  await Promise.resolve();
  const count = f.publications.length;
  await f.adapter.close({ restore: false });
  await rejected; await flush();
  assert.equal(f.publications.length, count);
  assert(f.store.getState('floor-override:v1').outstanding, 'The next authorized controller inherits release duty');
});

test('an old unscoped release obligation is never guessed to belong to the current broker', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'old-format', until: START + 60_000 });
  await f.adapter.close({ restore: false });
  const state = f.store.getState('floor-override:v1'); delete state.outstanding.brokerDigest;
  f.store.setState('floor-override:v1', state);
  const publications = [];
  const adapter = createFloorOverride({ store: f.store, settings: f.settings, clock: () => START,
    brokerIdentity: { address: 'mqtt://invented.invalid', username: 'invented-user' }, publish: async (...args) => publications.push(args) });
  adapter.setConnected(true); await flush();
  assert.equal(adapter.status().brokerMismatch, true);
  assert.equal((await adapter.release()).restorationPending, true);
  await assert.rejects(adapter.lease({ owner: 'replacement', until: START + 60_000 }), { code: 'FLOOR_PENDING' });
  assert.equal(publications.length, 0);
  await adapter.close({ restore: false });
});

test('lease completion probes all outputs before release and reports device-local expiry for24hours', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'expiry-check', until: START + 60_000 });
  const start = f.publications.length;
  await f.advance(60);
  assert.deepEqual(f.publications.slice(start, start + 4).map(row => row.command.action), ['probe', 'probe', 'release', 'release']);
  assert.equal(f.adapter.status().lastLeaseEnd.outcome, 'device-local');
  assert.equal(f.adapter.status().lastLeaseEnd.restorationPending, false);
  assert.equal(f.adapter.status().lastLeaseEnd.expiresAt, START + 60_000 + 86_400_000);
  assert.equal(f.adapter.status(START + 60_000 + 86_400_000).lastLeaseEnd, null);
});

test('lease completion exposes a failed local expiry before successfully enforcing host OFF', async t => {
  const f = await fixture(t);
  await f.adapter.lease({ owner: 'failed-expiry-check', until: START + 60_000 });
  // The correlated device reply still reports ON at host lease expiry. This
  // represents a broken local timeout; a successful host OFF must not hide it.
  f.now(START + 60_000);
  f.devices.forEach(device => device.offset(60));
  const result = await f.adapter.finishLease({ owner: 'failed-expiry-check' });
  assert.equal(result.outcome, 'fallback');
  assert.equal(result.released, true);
  assert(f.devices.every(device => device.channels.every(value => value === false)));
});
