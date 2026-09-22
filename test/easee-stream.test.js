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
