import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';

const START = 1_800_000_000_000, DEVICE = 'synthetic-periodic-evse', PREFIX = 'synthetic/periodic/evse';
const roles = ['current_limit', 'start_charging', 'work_state', 'phase_info'];
const round = ['Boolean.GetStatus', 'Enum.GetStatus', 'Number.GetConfig', 'Number.GetStatus',
  'Object.GetStatus', 'Schedule.List', 'Service.GetConfig', 'Service.GetStatus'].sort();
const ownedGates = new WeakMap();
function gate(t) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const abort = () => release();
  if (!ownedGates.has(t)) ownedGates.set(t, new Set());
  ownedGates.get(t).add(release);
  t.signal.addEventListener('abort', abort, { once: true });
  if (t.signal.aborted) release();
  t.after(() => { release(); t.signal.removeEventListener('abort', abort); });
  return { promise, release };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stmq-periodic-read-'));
  const store = new Store(join(dir, 'recording.sqlite')), client = new EventEmitter();
  let now = START, authority = true, authorityThrows = false, timer, runtime, adapter, holdReply = null;
  const requests = [], metadata = { state: 'running' }, measuredAt = {};
  const fields = { current_limit: 16, start_charging: false, work_state: 'charger_free',
    phase_info: { total_power: 0, total_act_energy: 0, ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c']
      .map(phase => [phase, { voltage: 230, current: 0, power: 0 }])) } };
  const config = { input: 'mqtt', connections: { mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic' } },
    charging: { chargers: { charger2: { enabled: true, deviceId: DEVICE, topicPrefix: PREFIX, limiterEnabled: false } } } };
  const canControl = () => { if (authorityThrows) throw new Error('synthetic authority unavailable'); return authority; };
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, done) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    requests.push({ method: frame.method, role: role ?? null });
    let result;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: DEVICE, model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') result = { ...metadata };
    else if (frame.method === 'Schedule.List') result = { jobs: [] };
    else if (frame.method.endsWith('.GetConfig')) result = { id: 200 + roles.indexOf(role), owner: 'service:0', access: 'crw', min: 6, max: 16,
      options: ['charger_free', 'charger_charging', 'charger_pause', 'charger_wait', 'charger_end'] };
    else if (frame.method.endsWith('.Set')) { fields[role] = frame.params.value; measuredAt[role] = now; result = null; }
    else result = { value: structuredClone(fields[role]), last_update_ts: (measuredAt[role] ?? START) / 1000 };
    done?.();
    const reply = () => client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id, src: DEVICE, dst: frame.src, result })), {});
    const held = holdReply?.(frame);
    if (held) void held.then(reply); else queueMicrotask(reply);
  };
  runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now, canControl });
  for (const item of Object.values(runtime.chargers)) item.controls.enabled = false;
  runtime.refreshSettings();
  // Own one real native timer episode, without automatic planner setup wakeups
  // or a global clock freeze. Real reconciliation/controller code stays active.
  t.mock.method(runtime, 'tick', () => {});
  const interval = setInterval;
  const replacement = t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms === 5000) { assert.equal(timer, undefined); timer = callback; return { unref() {} }; }
    return interval(callback, ms, ...args);
  });
  try {
    adapter = createShellyEvseAdapter({ config: runtime.configuration.chargers.charger2, broker: config.connections.mqtt,
      client, store, engine: { charging: runtime, recorder: { recordEnergy() {}, energyGap() {}, flush() {} } },
      clock: () => now, canControl });
  } finally { replacement.mock.restore(); }
  t.after(async () => {
    for (const release of ownedGates.get(t) ?? []) release();
    adapter.close(); await runtime.close(); await store.runWrite(() => {}).catch(() => {});
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  client.emit('connect'); client.emit('message', `${PREFIX}/online`, Buffer.from('true'), { retain: true });
  await adapter.refresh(); await runtime.setAdapter('charger2', adapter); await runtime.reconcile('charger2');
  while (runtime.chargers.charger2.reconcileFlight) { await runtime.chargers.charger2.reconcileFlight; await turn(); }
  await store.runWrite(() => {}); requests.length = 0;
  assert.equal(adapter.snapshot().controlReady, true);
  const f = { store, runtime, adapter, client, requests, fields, metadata, measuredAt, now: () => now,
    advance(ms = 5001) { now += ms; }, setNow(at) { now = at; },
    authority(value, throws = false) { authority = value; authorityThrows = throws; },
    holdReplies(check) { holdReply = check; }, fire() { timer(); },
    notify(role, value, at = now, source = 'rpc') {
      fields[role] = value; measuredAt[role] = at;
      const type = ['number', 'boolean', 'enum', 'object'][roles.indexOf(role)];
      client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
        params: { ts: at / 1000, [`${type}:${200 + roles.indexOf(role)}`]: { value, last_update_ts: at / 1000, source } } })), {});
    },
  };
  return f;
}
const clocks = adapter => Object.fromEntries(Object.entries(adapter.snapshot().fields).map(([role, field]) => [role, field.measuredAt]));
function assertRound(requests) { assert.deepEqual(requests.map(row => row.method).sort(), round); }
async function settled(t, promise) {
  let done = false;
  const result = Promise.resolve(promise).finally(() => { done = true; });
  void result.catch(() => {});
  // Source-time admission owns an unref'ed timer. Keep this test-owned wait
  // alive until its actual completion without freezing or extending its budget.
  while (!done) { t.signal.throwIfAborted(); await turn(); }
  return result;
}
async function periodic(t, f, beforeReconcile = () => {}) {
  const entered = gate(t), original = f.runtime.reconcileShellyObservation.bind(f.runtime);
  let flight;
  const mock = t.mock.method(f.runtime, 'reconcileShellyObservation', proof => {
    flight = Promise.resolve(beforeReconcile(proof)).then(() => original(proof)); entered.release(); return flight;
  });
  f.advance(); f.fire(); await entered.promise;
  try { await flight; await f.store.runWrite(() => {}); } finally { mock.mock.restore(); }
}
async function proofFromTimer(t, f) {
  const completed = gate(t); let proof;
  const mock = t.mock.method(f.runtime, 'reconcileShellyObservation', value => { proof = value; completed.release(); return Promise.resolve(); });
  f.advance(); f.fire(); await completed.promise; mock.mock.restore();
  // Adapter-only boundary cases own their later refreshes; notification-driven
  // reconciliation is covered separately through the real periodic producer.
  t.mock.method(f.runtime, 'reconcileShellyObservation', () => Promise.resolve());
  return proof;
}
async function reserveStore(t, f) {
  const started = gate(t), held = gate(t);
  const flight = f.store.runPublication(async () => { started.release(); await held.promise; });
  await started.promise;
  return { release: held.release, flight };
}

test('one periodic episode reuses its actual completed read without renewing original clocks', async t => {
  const f = await fixture(t), before = clocks(f.adapter);
  await periodic(t, f);
  assert.equal(f.requests.length, 8);
  assertRound(f.requests); assert.deepEqual(clocks(f.adapter), before);
  assert.equal(f.adapter.snapshot().generation, 1); assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
});

test('the periodic native poll progresses while real Store evidence admission holds reconciliation', async t => {
  const f = await fixture(t), before = clocks(f.adapter), started = gate(t);
  const original = f.runtime.writeStreamEvidence.bind(f.runtime);
  let reservation, reconciliation;
  const mock = t.mock.method(f.runtime, 'writeStreamEvidence', () => {
    const result = original(); started.release(); return result;
  });
  const entry = gate(t), reconcile = f.runtime.reconcileShellyObservation.bind(f.runtime);
  const callback = t.mock.method(f.runtime, 'reconcileShellyObservation', async proof => {
    if (!reservation) { reservation = await reserveStore(t, f); reconciliation = reconcile(proof); entry.release(); }
  });
  f.advance(); f.fire(); await entry.promise; await started.promise;
  assert.equal(f.requests.length, 8); assert(f.runtime.chargers.charger2.reconcileFlight);
  const replies = gate(t); let published = 0;
  f.holdReplies(() => { if (++published === 8) replies.release(); return null; });
  f.advance(); f.fire(); await replies.promise;
  assert.equal(f.requests.length, 16, 'Second independent native poll starts before held Store admission releases');
  assert.deepEqual(clocks(f.adapter), before);
  reservation.release(); await reservation.flight; await reconciliation;
  await f.adapter.refresh(); await f.store.runWrite(() => {});
  callback.mock.restore(); mock.mock.restore();
  assert.equal(f.adapter.snapshot().controlReady, true);
});

test('periodic acquisition remains independent of an already busy real controller planning wait', async t => {
  const f = await fixture(t), entered = gate(t), held = gate(t);
  const previous = f.runtime.chargers.charger2.controller;
  t.after(() => previous.close());
  const controller = f.adapter.createController({ clock: f.now, canControl: () => true,
    getPlan: async () => { entered.release(); await held.promise; return null; } });
  t.after(() => controller.close());
  f.advance(1000);
  f.notify('work_state', 'charger_wait'); f.notify('start_charging', true); await f.adapter.refresh({ force: true });
  // Reconcile through the actual runtime/controller; only the economic result is held.
  f.runtime.chargers.charger2.controller = controller;
  f.runtime.chargers.charger2.controls.enabled = true;
  f.runtime.refreshSettings();
  f.runtime.pricesInitialized = true;
  assert.equal(f.adapter.snapshot().session.connected, true);
  assert.equal(f.adapter.snapshot().controlReady, true);
  assert.equal(f.runtime.views().find(row => row.id === 'charger2').settings.enabled, true);
  const reconciliation = f.runtime.reconcile('charger2');
  await Promise.race([entered.promise, reconciliation.then(() => assert.fail('Real controller returned before the owned planning boundary'))]);
  f.requests.length = 0;
  await periodic(t, f);
  assertRound(f.requests); assert(f.runtime.chargers.charger2.reconcileFlight);
  held.release(); await reconciliation;
});

test('completed witnesses are opaque, one-use and unavailable from cached snapshots', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  assert(Object.isFrozen(proof)); assert.deepEqual(Reflect.ownKeys(proof), []);
  f.requests.length = 0;
  await f.adapter.refresh({ completedRead: proof }); assert.equal(f.requests.length, 0);
  await f.adapter.refresh({ completedRead: proof }); assertRound(f.requests);
  f.requests.length = 0;
  await f.adapter.refresh({ completedRead: Object.freeze({}) }); assertRound(f.requests);
  f.requests.length = 0;
  await f.adapter.refresh({ completedRead: f.adapter.snapshot() }); assertRound(f.requests);
  f.requests.length = 0;
  const unknown = new Proxy({}, { get() { throw new Error('synthetic private getter'); }, ownKeys() { throw new Error('synthetic private keys'); } });
  await f.adapter.refresh({ completedRead: unknown }); assertRound(f.requests);
});

test('a received notification still awaiting actual Store admission invalidates reuse', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f), reservation = await reserveStore(t, f);
  f.notify('current_limit', 10); assert.equal(f.adapter.snapshot().controlReady, false);
  f.requests.length = 0;
  const fresh = f.adapter.refresh({ completedRead: proof });
  await turn(); assertRound(f.requests);
  reservation.release(); await reservation.flight; await fresh; await f.store.runWrite(() => {});
  assert.equal(f.adapter.snapshot().fields.current_limit.value, 10);
});

test('same-value instructions and subsequent successful polls invalidate an earlier completion', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.advance(1000); f.notify('start_charging', false, f.now(), 'sys'); await f.store.runWrite(() => {});
  await f.adapter.refresh({ force: true }); f.requests.length = 0;
  await f.adapter.refresh({ completedRead: proof }); assertRound(f.requests);
  assert.equal(f.adapter.snapshot().fields.start_charging.measuredAt, f.now());
});

test('newer known native service restriction is observed by the invalidated ordinary fresh read', async t => {
  const f = await fixture(t);
  await periodic(t, f, async () => {
    f.metadata.state = 'stopped'; f.notify('work_state', 'charger_pause'); await f.store.runWrite(() => {});
  });
  assert(f.requests.length >= 16); assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.adapter.snapshot().commissioning.nativeCaps.state, 'stopped');
});

test('physical reconnect and MQTT generation changes cannot reuse a prior completed poll', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.advance(1000); f.notify('work_state', 'charger_wait'); await f.adapter.refresh({ force: true });
  const session = f.adapter.snapshot().session;
  f.advance(1000); f.notify('work_state', 'charger_free'); await f.adapter.refresh({ force: true });
  f.advance(1000); f.notify('work_state', 'charger_wait'); await f.adapter.refresh({ force: true });
  assert.notEqual(f.adapter.snapshot().session.sessionId, session.sessionId);
  await turn(); await f.adapter.refresh(); await f.store.runWrite(() => {}); await turn();
  f.requests.length = 0; await f.adapter.refresh({ completedRead: proof }); assertRound(f.requests);
  const current = await proofFromTimer(t, f); f.client.emit('offline'); f.client.emit('connect');
  f.client.emit('message', `${PREFIX}/online`, Buffer.from('true'), {}); await f.adapter.refresh();
  assert.equal(f.adapter.snapshot().generation, 3);
  f.requests.length = 0; await f.adapter.refresh({ completedRead: current }); assertRound(f.requests);
});

for (const replace of ['controller', 'adapter', 'generation']) {
  test(`runtime ${replace} replacement cannot inherit a periodic completion`, async t => {
    const f = await fixture(t), item = f.runtime.chargers.charger2;
    const original = f.runtime.writeStreamEvidence.bind(f.runtime);
    let changed = false;
    t.mock.method(f.runtime, 'writeStreamEvidence', async () => {
      const result = await original();
      if (!changed) {
        changed = true;
        if (replace === 'generation') item.adapterGeneration++;
        else item[replace] = { ...item[replace] };
      }
      return result;
    });
    await periodic(t, f).catch(error => { assert.equal(replace, 'adapter'); assert.equal(error.code, 'STORAGE_WRITE_STALE'); });
    assert.equal(f.requests.length, 16);
  });
}

test('authority loss after the poll sends no second read or mutation', async t => {
  const f = await fixture(t); await periodic(t, f, () => f.authority(false));
  assertRound(f.requests); assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
});

test('unsafe authority and clock freshness cannot turn a completed poll into permission', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.authority(true, true); f.requests.length = 0;
  await f.adapter.refresh({ completedRead: proof }); assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
  f.authority(true); await f.adapter.refresh();
  const fresh = await proofFromTimer(t, f); f.advance(60_000); f.requests.length = 0;
  await f.adapter.refresh({ completedRead: fresh }); assertRound(f.requests);
  const future = await proofFromTimer(t, f); f.setNow(START); f.requests.length = 0;
  await f.adapter.refresh({ completedRead: future }); assert.equal(f.requests.length, 8);
});

test('explicit reconciliation and forced post-write confirmation retain their fresh request order', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.requests.length = 0; await f.runtime.reconcile('charger2'); assertRound(f.requests);
  f.requests.length = 0;
  await f.adapter.rpc('Boolean.Set', { owner: 'service:0', role: 'start_charging', value: false },
    { mutation: true, guard: () => true });
  await f.adapter.refresh({ force: true, completedRead: proof });
  assert.equal(f.requests[0].method, 'Boolean.Set'); assertRound(f.requests.slice(1));
  assert.equal(f.adapter.snapshot().fields.start_charging.readback.requestedAt, f.now());
});

test('a failed real transaction cannot mint a completed read and old evidence cannot skip recovery', async t => {
  const f = await fixture(t), old = await proofFromTimer(t, f), setState = f.store.setState.bind(f.store);
  let fail = true;
  const mock = t.mock.method(f.store, 'setState', (...args) => {
    if (fail && args[0].startsWith('charging:shelly:')) throw new Error('synthetic recording rollback');
    return setState(...args);
  });
  f.advance(1000); f.fields.current_limit = 10; f.measuredAt.current_limit = f.now();
  const failed = await f.adapter.refresh(); assert.equal(failed, undefined);
  assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.adapter.snapshot().fields.current_limit.value, 16);
  fail = false; f.requests.length = 0; await f.adapter.refresh({ completedRead: old }); assertRound(f.requests);
  mock.mock.restore(); assert.equal(f.adapter.snapshot().fields.current_limit.value, 10);
});

test('a pending native reply and source-time deferred input preserve original admission fences', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f), held = gate(t), entered = gate(t);
  f.holdReplies(frame => { if (frame.method === 'Service.GetStatus') { entered.release(); return held.promise; } return null; });
  const pending = f.adapter.rpc('Service.GetStatus', { id: 0 }); await entered.promise;
  f.requests.length = 0; const refresh = f.adapter.refresh({ completedRead: proof });
  await turn(); assertRound(f.requests); held.release(); await pending; await refresh;
  f.holdReplies(null);
  const next = await proofFromTimer(t, f); f.notify('current_limit', 9, f.now() + 400);
  assert.equal(f.adapter.snapshot().controlReady, false); f.requests.length = 0;
  const admission = f.adapter.refresh({ completedRead: next }); await turn(); assertRound(f.requests);
  f.advance(400); await settled(t, admission); await f.store.runWrite(() => {});
  assert.equal(f.adapter.snapshot().fields.current_limit.measuredAt, f.now());
});

test('an opaque witness from another actual adapter cannot suppress fresh reads', async t => {
  const first = await fixture(t), proof = await proofFromTimer(t, first), second = await fixture(t);
  await second.adapter.refresh({ completedRead: proof }); assertRound(second.requests);
});

test('two timer callbacks sharing one in-flight poll cannot consume its completion twice', async t => {
  const f = await fixture(t), held = gate(t), entered = gate(t), completed = gate(t), proofs = [];
  f.holdReplies(frame => { if (frame.method === 'Service.GetStatus') { entered.release(); return held.promise; } return null; });
  t.mock.method(f.runtime, 'reconcileShellyObservation', proof => {
    proofs.push(proof); if (proofs.length === 2) completed.release(); return Promise.resolve();
  });
  f.advance(); f.fire(); await entered.promise; f.fire(); assertRound(f.requests);
  held.release(); await completed.promise; f.holdReplies(null);
  assert.equal(proofs.length, 2); assert.equal(proofs[0], proofs[1]); assert(Object.isFrozen(proofs[0]));
  f.requests.length = 0; await f.adapter.refresh({ completedRead: proofs[0] }); assert.equal(f.requests.length, 0);
  await f.adapter.refresh({ completedRead: proofs[1] }); assertRound(f.requests);
});

test('malformed native reads cannot mint a successful completion', async t => {
  const f = await fixture(t), old = await proofFromTimer(t, f);
  f.fields.phase_info.total_power = 'invalid';
  assert.equal(await f.adapter.refresh(), undefined); assert.equal(f.adapter.snapshot().controlReady, false);
  f.requests.length = 0; await f.adapter.refresh({ completedRead: old }); assertRound(f.requests);
  assert.equal(f.adapter.snapshot().controlReady, false);
  f.fields.phase_info.total_power = 0; await f.adapter.refresh();
  assert.equal(f.adapter.snapshot().controlReady, true);
});

test('a real post-commit effect failure leaves reuse unavailable without erasing committed input', async t => {
  const f = await fixture(t), old = await proofFromTimer(t, f), afterCommit = f.store.afterCommit.bind(f.store);
  const setState = f.store.setState.bind(f.store);
  let inject = true, effectFired = false;
  const mock = t.mock.method(f.store, 'setState', (key, value) => {
    const result = setState(key, value);
    if (inject && f.store.transactionDepth && key === `charging:shelly:${f.adapter.association}`
      && value?.fields?.current_limit?.value === 11 && value.fields.current_limit.measuredAt === f.now()) {
      inject = false;
      afterCommit(() => { effectFired = true; throw new Error('synthetic post-commit effect failure'); });
    }
    return result;
  });
  f.advance(1000); f.fields.current_limit = 11; f.measuredAt.current_limit = f.now();
  await assert.doesNotReject(f.store.runWrite(() => f.store.afterCommit(() => {})),
    'The injected effect belongs to the changed native reading, not another queued save');
  assert.equal(await f.adapter.refresh(), undefined);
  assert.equal(inject, false, 'The changed acquisition state registered its post-commit failure');
  assert.equal(effectFired, true, 'The real committed transaction executed the injected effect');
  assert.equal(f.adapter.snapshot().controlReady, false);
  assert.equal(f.adapter.snapshot().fields.current_limit.value, 11, 'Actual committed reading remains distinct from effect failure');
  mock.mock.restore(); f.requests.length = 0; await f.adapter.refresh({ completedRead: old }); assertRound(f.requests);
});

test('force waits for an older in-flight poll and then starts its own new round despite a witness', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f), entered = gate(t), held = gate(t);
  let hold = true;
  f.holdReplies(frame => {
    if (hold && frame.method === 'Service.GetStatus') { hold = false; entered.release(); return held.promise; }
    return null;
  });
  f.requests.length = 0; const earlier = f.adapter.refresh(); await entered.promise;
  const confirmation = f.adapter.refresh({ force: true, completedRead: proof }); assertRound(f.requests);
  held.release(); await earlier; await confirmation;
  assert.equal(f.requests.length, 16); assertRound(f.requests.slice(8));
});

test('a takeover request retains its separate fresh preflight even with a valid periodic witness', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.requests.length = 0;
  await f.runtime.chargers.charger2.controller.update({ enabled: true, takeover: 'synthetic-stale-takeover', completedRead: proof });
  assertRound(f.requests);
  assert.equal(f.runtime.chargers.charger2.controller.status().takeover.state, 'blocked');
  assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
});

test('close cancels owned pending work and an old completion cannot dispatch a late read', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f), held = gate(t), entered = gate(t);
  f.holdReplies(() => { entered.release(); return held.promise; });
  const pending = f.adapter.rpc('Service.GetStatus', { id: 0 });
  const rejected = assert.rejects(pending, { code: 'evse-offline' });
  await entered.promise; f.adapter.close(); held.release(); await rejected;
  f.requests.length = 0; await f.adapter.refresh({ completedRead: proof }); await turn();
  assert.equal(f.requests.length, 0); assert.equal(f.adapter.snapshot().online, false);
});

test('even unchanged availability received in the same clock tick invalidates an earlier completion', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  f.client.emit('message', `${PREFIX}/online`, Buffer.from('true'), {});
  await f.store.runWrite(() => {});
  f.requests.length = 0; await f.adapter.refresh({ completedRead: proof }); assertRound(f.requests);
  assert.equal(f.adapter.snapshot().controlReady, true);
});

for (const takeover of ['new-session', 'automatic', 'schedule']) {
  test(`${takeover} takeover retains a fresh preflight despite a completed periodic poll`, async t => {
    const f = await fixture(t);
    f.advance(1000); f.fields.work_state = 'charger_wait'; f.fields.start_charging = true;
    f.measuredAt.work_state = f.now(); f.measuredAt.start_charging = f.now();
    await f.adapter.refresh({ force: true });
    const session = f.adapter.snapshot().session;
    const initialState = takeover === 'new-session' ? undefined : { version: 1, association: f.adapter.association,
      phase: 'off', manual: null, ownedPause: false, pending: null, sessionId: session.sessionId,
      ...(takeover === 'automatic' ? { automaticTakeover: { sessionId: session.sessionId, fingerprint: null } }
        : { scheduleTakeoverPending: true }) };
    const controller = f.adapter.createController({ initialState, clock: f.now, canControl: () => true, getPlan: async () => null,
      saveState: state => f.store.runWrite(() => f.store.setState('synthetic-periodic-owner', state)) });
    t.after(() => controller.close());
    const proof = await proofFromTimer(t, f); assert(Object.isFrozen(proof)); f.requests.length = 0;
    await controller.update({ enabled: true, completedRead: proof });
    assertRound(f.requests); assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
  });
}

test('real same-adapter controller replacement during a held poll cannot inherit its completion', async t => {
  const f = await fixture(t), entered = gate(t), held = gate(t), completed = gate(t);
  let flight;
  f.holdReplies(frame => { if (frame.method === 'Service.GetStatus') { entered.release(); return held.promise; } return null; });
  const original = f.runtime.reconcileShellyObservation.bind(f.runtime);
  t.mock.method(f.runtime, 'reconcileShellyObservation', proof => {
    flight = original(proof); completed.release(); return flight;
  });
  const previous = f.runtime.chargers.charger2.controller, generation = f.runtime.chargers.charger2.adapterGeneration;
  f.advance(); f.fire(); await entered.promise; await f.runtime.setAdapter('charger2', f.adapter);
  assert.notEqual(f.runtime.chargers.charger2.controller, previous);
  assert.equal(f.runtime.chargers.charger2.adapterGeneration, generation + 1);
  f.holdReplies(null); held.release(); await completed.promise; await flight; await f.store.runWrite(() => {});
  assert.equal(f.requests.length, 16); assertRound(f.requests.slice(8));
});

test('real same-adapter owner replacement after issuance invalidates the unused witness', async t => {
  const f = await fixture(t), proof = await proofFromTimer(t, f);
  const previous = f.runtime.chargers.charger2.controller;
  await f.runtime.setAdapter('charger2', f.adapter);
  assert.notEqual(f.runtime.chargers.charger2.controller, previous);
  f.requests.length = 0;
  await f.runtime.chargers.charger2.controller.update({ enabled: false, completedRead: proof });
  assertRound(f.requests); assert.equal(f.requests.some(row => row.method.endsWith('.Set')), false);
});
