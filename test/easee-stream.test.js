import test from 'node:test';
import assert from 'node:assert/strict';
import { createEaseeStream } from '../src/acquisition/easee-stream.js';

const START = Date.parse('2026-09-22T10:00:00Z');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Timers {
  now = START;
  next = 0;
  pending = new Map();
  set = (callback, ms) => {
    const id = ++this.next;
    this.pending.set(id, { callback, at: this.now + ms });
    return id;
  };
  clear = id => this.pending.delete(id);
  async advance(ms) {
    const until = this.now + ms;
    await flush();
    for (;;) {
      const due = [...this.pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.pending.delete(due[0]);
      due[1].callback();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

class Connection {
  handlers = new Map();
  subscriptions = [];
  starts = 0;
  stops = 0;
  startResult;
  invokeResult;
  on(name, callback) { this.handlers.set(name, callback); }
  onclose(callback) { this.closed = callback; }
  async start() {
    this.starts++;
    await this.options.accessTokenFactory();
    if (this.startResult instanceof Error) throw this.startResult;
    return this.startResult;
  }
  async invoke(...args) {
    this.subscriptions.push(args);
    if (this.invokeResult instanceof Error) throw this.invokeResult;
    return this.invokeResult;
  }
  async stop() { this.stops++; }
  lose(error = new Error('synthetic transport loss')) { this.closed(error); }
  update(mid, id, value, timestamp = new Date(START).toISOString(), extra = {}) {
    this.handlers.get('ProductUpdate')?.({ mid, id, value, timestamp, ...extra });
  }
}

function fixture(t, options = {}) {
  const timers = new Timers(), connections = [], tokens = [];
  const { prepare = () => {}, ...overrides } = options;
  let disconnected = 0, ready = 0;
  const stream = createEaseeStream({ products: [{ id: 'invented-charger', ids: [31, 120, 129, 223, 250] },
    { id: 'invented-equalizer', ids: [31, 40, 250] }],
    getAccessToken: async input => { tokens.push(input); return input.rejectedToken ? 'refreshed-fixture-value' : 'initial-fixture-value'; },
    clock: () => timers.now, setTimeoutFn: timers.set, clearTimeoutFn: timers.clear,
    timeoutMs: 1000, closeTimeoutMs: 100, retryMinMs: 100, retryMaxMs: 400, random: () => 0.5,
    onDisconnect: () => { disconnected++; }, onReady: () => { ready++; },
    connectionFactory: factoryOptions => {
      const connection = new Connection();
      connection.options = factoryOptions;
      prepare(connection, connections.length);
      connections.push(connection);
      return connection;
    }, ...overrides });
  t.after(async () => { await stream.close(); });
  return { stream, timers, connections, tokens, get disconnected() { return disconnected; }, get ready() { return ready; },
    async start() { stream.start(); await flush(); return connections.at(-1); } };
}

test('stream stays inert until started and waits for acknowledged subscriptions plus required observations', async t => {
  const subscription = deferred();
  const f = fixture(t, { prepare: connection => { connection.invokeResult = subscription.promise; } });
  assert.equal(f.stream.status().state, 'idle');
  assert.equal(f.tokens.length, 0);
  const connection = await f.start();
  f.stream.start();
  assert.equal(f.connections.length, 1);
  assert.equal(f.stream.status().state, 'subscribing');
  connection.update('invented-charger', 120, '3.5', undefined, { dataType: 3 });
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  subscription.resolve();
  await flush();
  assert.deepEqual(connection.subscriptions, [
    ['SubscribeWithCurrentState', 'invented-charger', true], ['SubscribeWithCurrentState', 'invented-equalizer', true],
  ]);
  assert.equal(f.ready, 1);
  assert.equal(f.stream.snapshot('invented-charger', [120, 250]), null);
  assert.deepEqual(f.stream.snapshot('invented-charger', [120, 250], { requiredIds: [120] }),
    [{ id: 120, value: 3.5, timestamp: new Date(START).toISOString() }]);
  assert.equal(f.stream.snapshot('unconfigured', [120]), null);
});

test('one connection isolates product observations and returns independent snapshots', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-charger', 31, 'true', undefined, { dataType: 2 });
  connection.update('invented-equalizer', 31, '12.5', undefined, { dataType: 3, unit: 'A' });
  const charger = f.stream.snapshot('invented-charger', [31]);
  assert.equal(charger[0].value, true);
  assert.equal(f.stream.snapshot('invented-equalizer', [31])[0].value, 12.5);
  charger[0].value = false;
  assert.equal(f.stream.snapshot('invented-charger', [31])[0].value, true);
  assert.equal(connection.options.url, 'https://streams.easee.com/hubs/chargers');
  assert.equal(connection.options.serverTimeoutMs, 30_000);
  assert.equal(connection.options.keepAliveMs, 15_000);
});

test('held source values retain their clocks while independent product activity proves stream liveness', async t => {
  const f = fixture(t), connection = await f.start(), old = START - 3_600_000;
  connection.update('invented-equalizer', 31, 4.5, old, { unit: 'A' });
  connection.update('invented-equalizer', 250, true, old);
  let evidence = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(evidence.synchronized, true);
  assert.equal(evidence.activityAt, null, 'A subscription baseline is not new source activity');
  assert.equal(evidence.receivedAt, START);
  assert.equal(Date.parse(evidence.observations[0].timestamp), old);
  await f.timers.advance(60_000);
  connection.update('invented-equalizer', 40, 2.5, f.timers.now);
  evidence = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(evidence.activityAt, START + 60_000);
  assert.equal(evidence.sourceAt, START + 60_000);
  assert.equal(evidence.receivedAt, START);
  assert.equal(Date.parse(evidence.observations[0].timestamp), old);
  await f.timers.advance(60_000);
  connection.update('invented-equalizer', 40, 2.5, START + 60_000);
  connection.update('invented-equalizer', 31, 4.5, old);
  f.stream.reconcile('invented-equalizer', [{ id: 31, value: 4.5, timestamp: new Date(f.timers.now).toISOString() }]);
  const unchanged = f.stream.evidence('invented-equalizer', [31]);
  assert.deepEqual(unchanged, evidence, 'Replays, REST reconciliation and reads cannot renew stream evidence');
  unchanged.observations[0].value = 999;
  assert.equal(f.stream.evidence('invented-equalizer', [31]).observations[0].value, 4.5);
  assert.equal(f.stream.evidence('invented-charger', [31]).activityAt, null, 'Another product cannot prove this device is alive');
});

test('newer contradictory REST evidence fences held stream currents until the live stream catches up', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-equalizer', 31, 4, START);
  connection.update('invented-equalizer', 250, true, START);
  await f.timers.advance(1000);
  f.stream.reconcile('invented-equalizer', [{ id: 31, value: 20, timestamp: new Date(f.timers.now).toISOString() }]);
  let evidence = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(evidence.synchronized, false, 'Known newer household load cannot be hidden behind an older held stream value');
  assert.equal(evidence.activityAt, null, 'REST cannot establish live stream activity');
  connection.update('invented-equalizer', 31, 20, f.timers.now);
  evidence = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(evidence.synchronized, true);
  assert.equal(evidence.observations[0].value, 20);
  assert.equal(evidence.activityAt, f.timers.now);
  await f.timers.advance(1000);
  f.stream.reconcile('invented-equalizer', [{ id: 250, value: false, timestamp: new Date(f.timers.now).toISOString() }]);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false, 'A known newer offline state cannot grant eligibility');
});

test('device offline and recovery require a new acknowledged baseline without borrowing old product fields', async t => {
  const f = fixture(t), connection = await f.start();
  for (const product of ['invented-charger', 'invented-equalizer']) {
    connection.update(product, 31, product === 'invented-charger' ? true : 4, START - 60_000);
    connection.update(product, 250, true, START - 60_000);
  }
  const first = f.stream.evidence('invented-equalizer', [31]);
  await f.timers.advance(1000);
  connection.update('invented-equalizer', 250, false, f.timers.now);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
  assert.equal(f.stream.evidence('invented-charger', [31]).synchronized, true);
  const subscription = deferred(); connection.invokeResult = subscription.promise;
  await f.timers.advance(1000);
  connection.update('invented-equalizer', 250, true, f.timers.now);
  await flush();
  assert.deepEqual(connection.subscriptions.at(-1), ['SubscribeWithCurrentState', 'invented-equalizer', true]);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
  connection.update('invented-equalizer', 31, 4, START - 60_000);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false, 'Baseline rows alone cannot bypass subscription acknowledgement');
  subscription.resolve(); await flush();
  const recovered = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(recovered.synchronized, true);
  assert.notEqual(recovered.epoch, first.epoch);
  assert.equal(Date.parse(recovered.observations[0].timestamp), START - 60_000, 'Unchanged source time remains historical');
  connection.lose();
  assert.equal(f.stream.evidence('invented-equalizer', [31]).connected, false);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).observations, null);
  await f.timers.advance(100);
  const replacement = f.connections.at(-1);
  replacement.update('invented-equalizer', 250, true, f.timers.now);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
  replacement.update('invented-equalizer', 31, 4, START - 60_000);
  const reconnected = f.stream.evidence('invented-equalizer', [31]);
  assert.equal(reconnected.synchronized, true);
  assert.notEqual(reconnected.epoch, recovered.epoch);
  assert.equal(reconnected.activityAt, null, 'Reconnect snapshots do not manufacture live activity');
});

test('conflicting stream fields and incomplete baseline cannot grant synchronized current evidence', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-equalizer', 250, true, START);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
  connection.update('invented-equalizer', 31, 4, START);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, true);
  connection.update('invented-equalizer', 31, 5, START);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).observations, null);
  await f.timers.advance(1000);
  connection.update('invented-equalizer', 31, 5, f.timers.now);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, true);
  assert.equal(f.stream.evidence('invented-equalizer', [999]).synchronized, false);
  f.stream.reconcile('invented-equalizer', [{ id: 250, value: false, timestamp: new Date(START).toISOString() }]);
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false, 'A conflicting online observation cannot grant liveness');
  await f.stream.close();
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
});

test('repeated device recovery fences an earlier pending baseline acknowledgement', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-equalizer', 250, true, START);
  connection.update('invented-equalizer', 31, 4, START);
  await f.timers.advance(100);
  connection.update('invented-equalizer', 250, false, f.timers.now);
  const first = deferred(); connection.invokeResult = first.promise;
  await f.timers.advance(100);
  connection.update('invented-equalizer', 250, true, f.timers.now); await flush();
  await f.timers.advance(100);
  connection.update('invented-equalizer', 250, false, f.timers.now);
  const second = deferred(); connection.invokeResult = second.promise;
  await f.timers.advance(100);
  connection.update('invented-equalizer', 250, true, f.timers.now); await flush();
  connection.update('invented-equalizer', 31, 4, START);
  first.resolve(); await flush();
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, false);
  second.resolve(); await flush();
  assert.equal(f.stream.evidence('invented-equalizer', [31]).synchronized, true);
  assert.equal(connection.subscriptions.filter(row => row[1] === 'invented-equalizer').length, 3);
});

const transitionProducts = [{ id: 'invented-charger', ids: [31, 96, 100, 109, 250] }];

test('live stream callback preserves each one-second and sixteen-second mode and pilot transition', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts,
    onObservation: (device, row) => observations.push({ device, row }) });
  const connection = await f.start();
  connection.update('invented-charger', 109, '2', START, { dataType: 4 });
  connection.update('invented-charger', 100, 'B', START, { dataType: 6 });
  await f.timers.advance(1000);
  connection.update('invented-charger', 109, '1', f.timers.now, { dataType: 4, privateField: 'synthetic-hidden' });
  connection.update('invented-charger', 100, 'A', f.timers.now, { dataType: 6 });
  await f.timers.advance(16_000);
  connection.update('invented-charger', 109, '2', f.timers.now, { dataType: 4 });
  connection.update('invented-charger', 100, 'B', f.timers.now, { dataType: 6 });
  assert.deepEqual(observations, [
    { device: 'invented-charger', row: { id: 109, value: 1, measuredAt: START + 1000, receivedAt: START + 1000,
      previousValue: 2, previousMeasuredAt: START } },
    { device: 'invented-charger', row: { id: 100, value: 'A', measuredAt: START + 1000, receivedAt: START + 1000,
      previousValue: 'B', previousMeasuredAt: START } },
    { device: 'invented-charger', row: { id: 109, value: 2, measuredAt: START + 17_000, receivedAt: START + 17_000,
      previousValue: 1, previousMeasuredAt: START + 1000 } },
    { device: 'invented-charger', row: { id: 100, value: 'B', measuredAt: START + 17_000, receivedAt: START + 17_000,
      previousValue: 'A', previousMeasuredAt: START + 1000 } },
  ]);
  assert.doesNotMatch(JSON.stringify(observations.map(item => item.row)), /mid|private|token|unit|dataType|timestamp/i);
  observations[0].row.value = 99;
  assert.equal(f.stream.snapshot('invented-charger', [109])[0].value, 2, 'Callback rows cannot mutate the cache');
});

test('initial snapshots and delayed pre-readiness clocks supply baselines without emitting live transitions', async t => {
  const subscription = deferred(), observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row),
    prepare: connection => { connection.invokeResult = subscription.promise; } });
  const connection = await f.start();
  connection.update('invented-charger', 109, 2, START);
  await f.timers.advance(500);
  connection.update('invented-charger', 109, 1, START + 200);
  subscription.resolve(); await flush();
  assert.equal(f.stream.status().connected, true);
  connection.update('invented-charger', 109, 2, START + 400);
  connection.update('invented-charger', 100, 'B', START + 500);
  assert.equal(observations.length, 0);
  await f.timers.advance(1);
  connection.update('invented-charger', 109, 3, f.timers.now);
  connection.update('invented-charger', 31, true, f.timers.now, { dataType: 2 });
  assert.deepEqual(observations.map(row => [row.id, row.previousValue, row.value]), [[109, 2, 3]]);
});

test('repeated values, out-of-order rows and conflicting equal-time states cannot emit a transition', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const connection = await f.start();
  connection.update('invented-charger', 31, true, START);
  await f.timers.advance(1000);
  connection.update('invented-charger', 31, '1', f.timers.now);
  connection.update('invented-charger', 31, false, START + 500);
  connection.update('invented-charger', 31, false, f.timers.now);
  assert.equal(f.stream.snapshot('invented-charger', [31]), null);
  assert.equal(observations.length, 0);
  await f.timers.advance(1);
  connection.update('invented-charger', 31, false, f.timers.now);
  assert.equal(observations.length, 0, 'An ambiguous previous state cannot prove a changed edge');
  await f.timers.advance(1);
  connection.update('invented-charger', 31, true, f.timers.now);
  assert.deepEqual(observations.map(row => [row.previousValue, row.value]), [[false, true]]);
});

test('REST reconciliation never emits but cannot suppress the corresponding first live edge', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const connection = await f.start();
  connection.update('invented-charger', 109, 2, START);
  await f.timers.advance(1000);
  f.stream.reconcile('invented-charger', [{ id: 109, value: 1, timestamp: f.timers.now }]);
  assert.equal(observations.length, 0);
  connection.update('invented-charger', 109, 1, f.timers.now);
  assert.deepEqual(observations.map(row => [row.previousValue, row.value]), [[2, 1]]);
  await f.timers.advance(1);
  connection.update('invented-charger', 109, 1, f.timers.now);
  assert.equal(observations.length, 1);
  await f.timers.advance(1);
  connection.update('invented-charger', 109, 2, f.timers.now);
  assert.equal(observations.length, 2);
  assert.equal(observations[1].previousMeasuredAt, START + 1001);
});

test('a newer REST snapshot cannot hide delayed live disconnect and reconnect edges', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const connection = await f.start(); connection.update('invented-charger', 109, 3, START);
  await f.timers.advance(17_000);
  f.stream.reconcile('invented-charger', [{ id: 109, value: 1, timestamp: START + 1000 }]);
  f.stream.reconcile('invented-charger', [{ id: 109, value: 3, timestamp: START + 17_000 }]);
  assert.equal(observations.length, 0);
  connection.update('invented-charger', 109, 1, START + 1000);
  assert.equal(f.stream.snapshot('invented-charger', [109])[0].value, 3, 'Late live edges do not rewind the REST-merged cache');
  connection.update('invented-charger', 109, 3, START + 17_000);
  assert.deepEqual(observations, [
    { id: 109, value: 1, measuredAt: START + 1000, receivedAt: START + 17_000,
      previousValue: 3, previousMeasuredAt: START },
    { id: 109, value: 3, measuredAt: START + 17_000, receivedAt: START + 17_000,
      previousValue: 1, previousMeasuredAt: START + 1000 },
  ]);
});

test('same-clock REST and stream disagreements invalidate live transition provenance', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const connection = await f.start(); connection.update('invented-charger', 109, 2, START);
  await f.timers.advance(1000);
  f.stream.reconcile('invented-charger', [{ id: 109, value: 1, timestamp: f.timers.now }]);
  connection.update('invented-charger', 109, 3, f.timers.now);
  assert.equal(f.stream.snapshot('invented-charger', [109]), null); assert.equal(observations.length, 0);
  await f.timers.advance(1); connection.update('invented-charger', 109, 2, f.timers.now);
  assert.equal(observations.length, 0, 'The contradictory previous source clock cannot prove an edge');
  await f.timers.advance(1); connection.update('invented-charger', 109, 3, f.timers.now);
  assert.deepEqual(observations.map(row => [row.previousValue, row.value]), [[2, 3]]);
});

test('reconnect resets field baselines and rejects late old-generation or snapshot replay transitions', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const first = await f.start(); first.update('invented-charger', 109, 2, START);
  first.lose(); await f.timers.advance(100);
  const second = f.connections[1];
  first.update('invented-charger', 109, 1, f.timers.now);
  second.update('invented-charger', 109, 1, START);
  second.update('invented-charger', 109, 2, START + 99);
  assert.equal(observations.length, 0);
  await f.timers.advance(1);
  second.update('invented-charger', 109, 1, f.timers.now);
  assert.deepEqual(observations.map(row => [row.previousValue, row.value]), [[2, 1]]);
});

test('unknown, future and more-than-fifteen-minute-old source clocks never emit fresh transitions', async t => {
  const observations = [];
  const f = fixture(t, { products: transitionProducts, onObservation: (_device, row) => observations.push(row) });
  const connection = await f.start(); connection.update('invented-charger', 109, 2, START);
  await f.timers.advance(16 * 60_000);
  for (const timestamp of [null, 'unknown', f.timers.now + 1])
    connection.update('invented-charger', 109, 1, timestamp);
  connection.update('invented-charger', 109, 1, START + 59_999);
  assert.equal(observations.length, 0);
  assert.equal(f.stream.snapshot('invented-charger', [109])[0].value, 1,
    'Suppressing stale transition callbacks does not change the existing cache contract');
  connection.update('invented-charger', 109, 2, f.timers.now);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].measuredAt, f.timers.now);
});

test('throwing or rejecting observation callbacks cannot break the cache, readiness, or later transitions', async t => {
  let calls = 0;
  const f = fixture(t, { products: transitionProducts, onObservation: () => {
    calls++;
    if (calls === 1) throw new Error('synthetic callback failure');
    return Promise.reject(new Error('synthetic asynchronous callback failure'));
  } });
  const connection = await f.start(); connection.update('invented-charger', 109, 2, START);
  await f.timers.advance(1); connection.update('invented-charger', 109, 1, f.timers.now);
  await f.timers.advance(1); connection.update('invented-charger', 109, 2, f.timers.now);
  await flush();
  assert.equal(calls, 2); assert.equal(f.stream.status().connected, true);
  assert.equal(f.stream.snapshot('invented-charger', [109])[0].value, 2);
  assert.doesNotMatch(JSON.stringify(f.stream.status()), /callback|synthetic/i);
});

test('source timestamps survive cache reads and late, malformed or future updates cannot refresh them', async t => {
  const f = fixture(t), connection = await f.start();
  const observed = new Date(START - 60_000).toISOString();
  connection.update('invented-charger', 120, '2', observed, { dataType: 3 });
  connection.update('invented-charger', 120, '1', new Date(START - 120_000).toISOString(), { dataType: 3 });
  for (const timestamp of [null, 'yesterday', '2026-09-22', new Date(START + 1).toISOString()]) {
    connection.update('invented-charger', 120, '99', timestamp, { dataType: 3 });
  }
  await f.timers.advance(24 * 60 * 60_000);
  assert.equal(f.stream.status().connected, true, 'No device changes is not a transport disconnect');
  assert.deepEqual(f.stream.snapshot('invented-charger', [120]), [{ id: 120, value: 2, timestamp: observed }]);
});

test('conflicting equal-time duplicates force fallback until a strictly newer observation', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-charger', 120, '2', undefined, { dataType: 3 });
  connection.update('invented-charger', 120, 2, undefined, { dataType: 3 });
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 2);
  connection.update('invented-charger', 120, 3);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  connection.update('invented-charger', 120, 2);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null, 'An identical replay cannot resolve a known conflict');
  await f.timers.advance(1);
  connection.update('invented-charger', 120, 4, new Date(f.timers.now).toISOString(), { unit: 'kW' });
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 4);
  connection.update('invented-charger', 120, 4, new Date(f.timers.now).toISOString(), { unit: 'W' });
  assert.equal(f.stream.snapshot('invented-charger', [120]), null, 'Units participate in duplicate conflict checks');
});

test('only whitelisted bounded data is cached and session authorization fields are discarded', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-charger', 128, 'invented-rfid');
  connection.update('invented-charger', 120, 'x'.repeat(257));
  connection.update('invented-charger', 250, 'maybe', undefined, { dataType: 2 });
  assert.equal(f.stream.snapshot('invented-charger', [128]), null);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  assert.equal(f.stream.snapshot('invented-charger', [250]), null);
  const session = { Id: 5, Start: '2026-09-22T09:00:00Z', Stop: '2026-09-22T09:30:00Z', EnergyKwh: 2,
    MeterValueStart: 10, MeterValueStop: 12, AuthToken: 'synthetic-private-value', Unexpected: { nested: 'private' } };
  connection.update('invented-charger', 129, JSON.stringify(session), undefined, { dataType: 6 });
  const value = JSON.parse(f.stream.snapshot('invented-charger', [129])[0].value);
  assert.deepEqual(value, { Id: 5, Start: session.Start, Stop: session.Stop, EnergyKwh: 2, MeterValueStart: 10, MeterValueStop: 12 });
  connection.update('invented-charger', 223, 'x'.repeat(16_385));
  assert.equal(f.stream.snapshot('invented-charger', [223]), null);
  assert.doesNotMatch(JSON.stringify(f.stream.status()), /invented|private|Token|https:/);
});

test('disconnect invalidates immediately, retries, resubscribes and rejects late callbacks from old connections', async t => {
  const f = fixture(t), first = await f.start();
  first.update('invented-charger', 120, 2);
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 2);
  first.lose();
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  assert.equal(f.disconnected, 1);
  first.lose();
  assert.equal(f.disconnected, 1);
  await f.timers.advance(100);
  const second = f.connections[1];
  assert.equal(second.subscriptions.length, 2);
  assert.equal(f.stream.status().generation, 2);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  first.update('invented-charger', 120, 8, new Date(f.timers.now).toISOString());
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  second.update('invented-charger', 120, 3, new Date(f.timers.now).toISOString());
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 3);
});

for (const error of [Object.assign(new Error('synthetic unauthorized'), { statusCode: 401 }),
  new Error('Failed to complete negotiation with the server: Error: Unauthorized: Status code \'401\'')]) {
  test(`initial authentication failure refreshes the rejected token (${error.statusCode ? 'status' : 'wrapped status'})`, async t => {
    const f = fixture(t, { prepare: (connection, index) => { if (!index) connection.startResult = error; } });
    await f.start();
    assert.equal(f.stream.status().state, 'retrying');
    await f.timers.advance(100);
    assert.equal(f.stream.status().connected, true);
    assert(f.tokens.some(input => input.rejectedToken === 'initial-fixture-value'));
    assert.equal(f.disconnected, 0, 'Failed startup never had usable state to interrupt');
  });
}

test('initial connection failures continue indefinitely with bounded exponential delay', async t => {
  const f = fixture(t, { prepare: connection => { connection.startResult = new Error('synthetic unavailable'); } });
  await f.start();
  for (const delay of [100, 200, 400, 400, 400, 400, 400, 400]) {
    assert.equal(f.stream.status().retryAt - f.timers.now, delay);
    await f.timers.advance(delay);
  }
  assert.equal(f.connections.length, 9);
});

for (const [error, delay] of [
  [Object.assign(new Error('synthetic token cooldown'), { status: 401, retryAfterMs: 45 * 60_000 }), 45 * 60_000],
  [Object.assign(new Error('synthetic forbidden'), { status: 403 }), 30 * 60_000],
  [Object.assign(new Error('synthetic rate limit'), { statusCode: 429 }), 5 * 60_000],
  [Object.assign(new Error('synthetic retry instruction'), { retryAfterMs: 12 * 60_000 }), 12 * 60_000],
  [Object.assign(new Error('synthetic excessive retry instruction'), { retryAfterMs: 48 * 60 * 60_000 }), 24 * 60 * 60_000],
  [new Error("Failed to complete negotiation with the server: HttpError: Forbidden: Status code '403'"), 30 * 60_000],
  [new Error("Failed to complete negotiation: Unexpected status code returned from negotiate '429'"), 5 * 60_000],
  [new Error('WebSocket failed: Unexpected server response: 403'), 30 * 60_000],
]) test(`stream respects provider cooldown without exposing error details (${error.message.split(':')[0]})`, async t => {
  let calls = 0;
  const f = fixture(t, { getAccessToken: async () => { calls++; throw error; } });
  await f.start();
  assert.equal(f.stream.status().retryAt, START + delay);
  await f.timers.advance(delay - 1);
  assert.equal(calls, 1, 'No token requests are sent while provider cooldown remains active');
  assert.doesNotMatch(JSON.stringify(f.stream.status()), /synthetic|HttpError|WebSocket|Forbidden|negotiat|http:/i);
  await f.stream.close();
  await f.timers.advance(delay + 1);
  assert.equal(calls, 1, 'Closing cancels a pending long cooldown');
  assert.equal(f.timers.pending.size, 0);
});

test('one token refresh is prompt but repeatedly rejected replacement tokens back off for thirty minutes', async t => {
  const f = fixture(t, { prepare: connection => {
    connection.startResult = Object.assign(new Error('synthetic unauthorized'), { statusCode: 401 });
  } });
  await f.start();
  assert.equal(f.stream.status().retryAt, START + 100);
  await f.timers.advance(100);
  assert.equal(f.connections.length, 2);
  assert.equal(f.stream.status().retryAt, f.timers.now + 30 * 60_000);
  await f.timers.advance(30 * 60_000 - 1);
  assert.equal(f.connections.length, 2);
  await f.timers.advance(1);
  assert.equal(f.connections.length, 3);
  assert.equal(f.stream.status().retryAt, f.timers.now + 30 * 60_000);
});

test('token callback retry metadata survives a SignalR wrapper that discards exception properties', async t => {
  let tokens = 0;
  const f = fixture(t, { getAccessToken: async () => {
    if (++tokens === 1) return 'initial-fixture-value';
    throw Object.assign(new Error('synthetic callback failure'), { status: 429, retryAfterMs: 14 * 60_000 });
  }, prepare: connection => {
    connection.start = async () => {
      try { await connection.options.accessTokenFactory(); }
      catch { throw new Error('Synthetic opaque negotiation failure'); }
    };
  } });
  await f.start();
  assert.equal(f.stream.status().retryAt, START + 14 * 60_000);
  await f.timers.advance(14 * 60_000 - 1);
  assert.equal(tokens, 2);
});

test('subscription deadlines abandon partial snapshots and permit a later complete connection', async t => {
  const pending = deferred();
  const f = fixture(t, { prepare: (connection, index) => { if (!index) connection.invokeResult = pending.promise; } });
  const first = await f.start();
  first.update('invented-charger', 120, 2);
  await f.timers.advance(1000);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  assert.equal(f.stream.status().state, 'retrying');
  await f.timers.advance(100);
  assert.equal(f.stream.status().connected, true);
  pending.resolve();
  await flush();
  assert.equal(first.subscriptions.length, 1, 'Late completion cannot continue the abandoned subscription sequence');
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
});

test('REST reconciliation cannot seed readiness and cannot move already streamed state backwards', async t => {
  const f = fixture(t), connection = await f.start();
  f.stream.reconcile('invented-charger', [{ id: 120, value: 5, timestamp: START }]);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  connection.update('invented-charger', 120, 1, START - 2);
  f.stream.reconcile('invented-charger', [{ id: 120, value: 3, timestamp: START - 1 }, { id: 250, value: true, timestamp: START }]);
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 3);
  assert.equal(f.stream.snapshot('invented-charger', [250]), null);
  connection.update('invented-charger', 120, 2, START - 2);
  assert.equal(f.stream.snapshot('invented-charger', [120])[0].value, 3);
  connection.update('invented-charger', 120, 9, START - 1);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  connection.lose();
  f.stream.reconcile('invented-charger', [{ id: 120, value: 8, timestamp: START }]);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
});

test('REST reconciliation compares real wire numeric and boolean forms without inventing unit conflicts', async t => {
  const f = fixture(t), connection = await f.start();
  connection.update('invented-charger', 120, '10.0', undefined, { dataType: 3 });
  connection.update('invented-charger', 250, 'true', undefined, { dataType: 2 });
  f.stream.reconcile('invented-charger', [
    { id: 120, value: '10', timestamp: START, unit: 'kW' },
    { id: 250, value: '1', timestamp: START },
  ]);
  assert.deepEqual(f.stream.snapshot('invented-charger', [120, 250]), [
    { id: 120, value: 10, timestamp: new Date(START).toISOString(), unit: 'kW' },
    { id: 250, value: true, timestamp: new Date(START).toISOString() },
  ]);
  await f.timers.advance(1);
  connection.update('invented-charger', 120, '11', f.timers.now, { dataType: 3 });
  assert.deepEqual(f.stream.snapshot('invented-charger', [120])[0],
    { id: 120, value: 11, timestamp: new Date(f.timers.now).toISOString(), unit: 'kW' });
  f.stream.reconcile('invented-charger', [{ id: 120, value: '11', timestamp: f.timers.now, unit: 'W' }]);
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
});

test('a stuck initial handshake is bounded and a later attempt can succeed', async t => {
  const pending = deferred();
  const f = fixture(t, { prepare: (connection, index) => { if (!index) connection.startResult = pending.promise; } });
  const connection = await f.start();
  await f.timers.advance(1000);
  assert.equal(f.stream.status().state, 'retrying');
  assert(connection.stops > 0);
  await f.timers.advance(100);
  assert.equal(f.stream.status().connected, true);
  pending.resolve();
  await flush();
  assert.equal(connection.subscriptions.length, 0);
});

test('closing an established connection needs no onclose callback and prevents any new work', async t => {
  const f = fixture(t), connection = await f.start();
  await f.stream.close();
  f.stream.start();
  connection.update('invented-charger', 120, 2);
  connection.lose();
  await f.timers.advance(100_000);
  assert.equal(f.connections.length, 1);
  assert.equal(f.stream.status().state, 'closed');
  assert.equal(f.stream.snapshot('invented-charger', [120]), null);
  assert.equal(f.disconnected, 0);
  assert.equal(f.timers.pending.size, 0);
});

test('shutdown aborts token acquisition and ignores its late result', async t => {
  const token = deferred();
  let signal;
  const f = fixture(t, { getAccessToken: input => { signal = input.signal; return token.promise; } });
  f.stream.start();
  await flush();
  await f.stream.close();
  assert.equal(signal.aborted, true);
  token.resolve('late-fixture-value');
  await flush();
  await f.timers.advance(10_000);
  assert.equal(f.connections.length, 0);
  assert.equal(f.timers.pending.size, 0);
});

test('shutdown during a pending connection start prevents late subscriptions and retry timers', async t => {
  const starting = deferred();
  const f = fixture(t, { prepare: connection => { connection.startResult = starting.promise; } });
  const connection = await f.start();
  await f.stream.close();
  starting.resolve();
  await flush();
  await f.timers.advance(10_000);
  assert.equal(connection.subscriptions.length, 0);
  assert.equal(f.connections.length, 1);
  assert.equal(f.timers.pending.size, 0);
});
