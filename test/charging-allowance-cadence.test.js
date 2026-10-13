import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingAllowanceHistory, readChargingAllowanceHistory } from '../src/charging/allowance-history.js';

const at = Date.parse('2026-10-13T08:00:00Z'), association = 'a'.repeat(64);
const status = (offset = 0, overrides = {}) => ({
  mode: 'unrestricted', allowanceA: 16, maximumCurrentA: 16, reportedAllowanceA: null,
  reason: 'property-headroom', source: 'st-mq-load-balancing', measuredAt: at + offset - 100,
  receivedAt: at + offset, sourceTimes: [], sourceEpoch: 'fixture:1',
  limiter: { mode: 'unrestricted', allowanceA: 16, loadAllowanceA: 16,
    reason: 'property-headroom', appliedCurrentA: 16, applicationStatus: 'confirmed' }, ...overrides,
});
const observation = (value, chargerId = 'charger2', equipment = association) => ({ chargerId, association: equipment, status: value });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = new ChargingAllowanceHistory({ store, input: 'providers' });
  return { store, history, put: (offset, value = status(offset), chargerId = 'charger2', equipment = association) =>
    history.observe(observation(value, chargerId, equipment), at + offset),
  coverage: () => store.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(),
  transactions: () => store.writeHealth.status().transactions.committed,
  read: end => readChargingAllowanceHistory({ store, input: 'providers', range: { from: at, to: at + end }, now: at + end }) };
}

test('preflight is pure and unchanged confirmations advance RAM without opening a transaction', t => {
  const { store, history, put, coverage, transactions } = fixture(t);
  const initial = observation(status());
  assert.equal(history.needsWrite(initial, at), true);
  assert.equal(store.observations().length, 0);
  put(0);
  const saved = structuredClone(history.previous), boundary = store.checkpoint(), count = transactions();
  assert.equal(history.needsWrite(observation(status(1000)), at + 1000), false);
  assert.deepEqual(history.previous, saved);
  for (const offset of [100, 500, 1000, 2000, 4999]) {
    assert.equal(history.needsWrite(observation(status(offset)), at + offset), false);
    assert.equal(put(offset).saved, false);
  }
  assert.equal(transactions(), count);
  assert.deepEqual(store.checkpoint(), boundary);
  assert.equal(coverage()[0].end_at, at);
  assert.equal(history.previous.get('charger2').at, at + 4999);
  assert.equal(history.needsWrite(observation(status(5000)), at + 5000), true);
  put(5000);
  assert.equal(transactions(), count + 1);
  assert.equal(coverage()[0].end_at, at + 5000);
  assert.equal(coverage()[0].source_time, at + 4900);
  assert.equal(coverage()[0].samples, 7);
  assert.equal(history.needsWrite(observation(status(4000)), at + 4000), false);
  assert.equal(put(4000).reason, 'out-of-order');
  assert.equal(history.previous.get('charger2').at, at + 5000);
});

test('bursts preserve every confirmation count while writing only at independent charger cadences', t => {
  const { store, put, coverage, transactions } = fixture(t), before = transactions();
  for (let offset = 0; offset <= 120_000; offset += 100) {
    put(offset, status(offset), 'charger1');
    put(offset);
  }
  assert.equal(store.observations().length, 2);
  assert.equal(transactions() - before, 28, '2 initial writes, 2 minute extensions, and 24 five-second extensions for 2,402 calls');
  assert(coverage().every(row => row.samples === 1201 && row.end_at === at + 120_000));
  assert(coverage().every(row => row.source_time === at + 119_900));
  assert(store.observations().every(row => row.sourceTime === at - 100), 'Initial observation clocks remain original');
});

test('A to B to A, reason and application-status edges survive inside one persistence interval', t => {
  const { store, history, put, coverage, read } = fixture(t);
  put(0); put(500);
  put(1000, status(1000, { allowanceA: 8, mode: 'limited' }));
  put(2000); put(2500);
  const pending = status(3000); pending.limiter.applicationStatus = 'pending';
  put(3000, pending);
  put(4000, status(4000, { reason: 'native-current-limit' }));
  put(4500, status(4500, { reason: 'native-current-limit' }));
  history.flush();
  assert.deepEqual(store.observations().map(row => row.value), [16, 8, 16, 16, 16]);
  assert.deepEqual(coverage().map(row => [row.start_at - at, row.end_at - at]), [[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000], [4000, 4500]]);
  assert.deepEqual(coverage().map(row => row.source_time - at), [400, 900, 2400, 2900, 4400], 'Closing a span never borrows its replacement value\'s clock');
  assert.equal(read(4500).charger2.spans.some(row => row.mode === 'unknown'), false);
});

for (const boundary of ['unknown', 'epoch', 'equipment', 'charger2-gap', 'charger1-gap'])
  test(`${boundary} flushes only the preceding observed tail and retains an unknown gap`, t => {
    const { history, put, coverage, read } = fixture(t), chargerId = boundary === 'charger1-gap' ? 'charger1' : 'charger2';
    put(0, status(), chargerId); put(1000, status(1000), chargerId);
    const offset = boundary === 'charger2-gap' ? 31_001 : boundary === 'charger1-gap' ? 91_001 : 2000;
    const next = status(offset, boundary === 'unknown' ? { mode: 'unknown', allowanceA: null }
      : boundary === 'epoch' ? { sourceEpoch: 'fixture:2' } : {});
    const equipment = boundary === 'equipment' ? 'b'.repeat(64) : association;
    put(offset, next, chargerId, equipment);
    assert.equal(coverage()[0].end_at, at + 1000);
    assert.equal(coverage()[0].source_time, at + 900);
    assert.equal(coverage()[0].samples, 2);
    assert.equal(coverage()[1].start_at, at + offset);
    assert(read(offset)[chargerId].spans.some(row => row.mode === 'unknown' && row.start === at + 1000 && row.end === at + offset));
    assert.equal(history.previous.get(chargerId).at, at + offset);
  });

test('outer COMMIT failure restores the buffered tail and removes rolled-back observation identity', t => {
  const { store, history, put, coverage } = fixture(t);
  put(0); put(1000);
  const previous = structuredClone(history.previous), exec = store.db.exec.bind(store.db);
  let fail = true;
  store.db.exec = sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Injected commit failure'); }
    return exec(sql);
  };
  assert.throws(() => store.transaction(() => {
    put(5000); put(5100, status(5100, { allowanceA: 8, mode: 'limited' }));
  }), /Injected commit failure/);
  assert.deepEqual(history.previous, previous);
  assert.equal(store.observations().length, 1);
  assert.equal(coverage()[0].samples, 1);
  assert.equal(coverage()[0].end_at, at);
  put(5000); put(5100, status(5100, { allowanceA: 8, mode: 'limited' }));
  assert.equal(store.observations().length, 2);
  assert.equal(coverage()[0].samples, 4, 'The failed attempt contributes no duplicate confirmations');
  assert.equal(history.previous.get('charger2').id, store.observations().at(-1).id);
});

test('caught savepoint rollback restores RAM-only confirmations and pending tail counts', t => {
  const { store, history, put, coverage } = fixture(t);
  put(0); put(1000);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => {
      put(2000); put(2100, status(2100, { allowanceA: 8, mode: 'limited' }));
      throw new Error('Discard inner observation');
    }), /Discard inner observation/);
    assert.equal(history.previous.get('charger2').at, at + 1000);
    put(3000);
  });
  assert.equal(store.observations().length, 1);
  assert.equal(coverage()[0].samples, 1);
  put(5000);
  assert.equal(coverage()[0].samples, 4);
  assert.equal(coverage()[0].end_at, at + 5000);
});

test('explicit flush preserves confirmed clocks, is rollback safe, and does not extrapolate on suspension', t => {
  const { store, history, put, coverage, transactions } = fixture(t);
  put(0); put(1000);
  assert.throws(() => store.transaction(() => { history.flush(); history.suspend(); throw new Error('Rollback suspension'); }), /Rollback suspension/);
  assert.equal(history.previous.get('charger2').at, at + 1000);
  assert.equal(coverage()[0].end_at, at);
  assert.equal(history.flush(), 1);
  assert.equal(coverage()[0].end_at, at + 1000);
  assert.equal(coverage()[0].source_time, at + 900);
  const count = transactions();
  assert.equal(history.flush(), 0);
  assert.equal(transactions(), count);
  history.suspend(); put(2000);
  assert.equal(coverage()[0].end_at, at + 1000);
  assert.equal(coverage()[1].start_at, at + 2000);
});

test('restart cannot recover or bridge the unflushed confirmation tail', t => {
  const { store, put, coverage, read } = fixture(t);
  put(0); put(1000);
  const restarted = new ChargingAllowanceHistory({ store, input: 'providers' });
  restarted.observe(observation(status(2000)), at + 2000);
  restarted.observe(observation(status(7000)), at + 7000);
  assert.deepEqual(coverage().map(row => [row.start_at - at, row.end_at - at]), [[0, 0], [2000, 7000]]);
  assert.deepEqual(read(7000).charger2.spans.map(row => [row.start - at, row.end - at, row.mode]), [[0, 2000, 'unknown'], [2000, 7000, 'unrestricted']]);
});
