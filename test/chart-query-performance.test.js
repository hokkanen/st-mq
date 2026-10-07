import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { recordedEnergyGroups, recordedEnergyStart } from '../src/storage/energy-history.js';
import { createChartQueryContext } from '../src/app/chart-query-context.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';

const DAY = 86_400_000, HOUR = DAY / 24;
const range = chartRange({ startDate: '2026-09-08' }), now = range.to + HOUR;
function put(store, start, end, { prefix = 'ev1', source = 'synthetic', receivedAt = end,
  values = [0.1, 0.2, 0.3], raw = {} } = {}) {
  for (let phase = 1; phase <= 3; phase++) store.observation({ source, device: `synthetic-${prefix}`,
    signal: `${prefix}_energy_l${phase}`, value: values[phase - 1], unit: 'kWh',
    sourceTime: end, receivedAt, quality: ['estimated'],
    raw: { intervalStart: start, intervalEnd: end, ...raw } });
}
function counted(store) {
  let energyReads = 0, startReads = 0;
  const facade = { db: { prepare(sql) {
    if (sql.includes('SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw')) energyReads++;
    if (sql.includes(' AS at FROM observations INDEXED BY observations_energy_geometry')) startReads++;
    return store.db.prepare(sql);
  } } };
  return { facade, counts: () => ({ energyReads, startReads }) };
}

test('recent end-time seek and historical geometry stream preserve long overlaps and receipt scope', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = range.from - 100 * DAY, end = range.from + HOUR;
  put(store, start, end);
  put(store, end, end + HOUR);
  put(store, range.from, end, { source: 'simulation' });
  put(store, range.from, end, { receivedAt: now + 100 * DAY });
  const query = at => [...recordedEnergyGroups(store, { from: range.from, to: range.to, now: at, input: 'providers' })];
  assert.deepEqual(query(now), query(now + 60 * DAY));
  const rows = query(now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].start, start, 'No bounded lookback may discard a long interval crossing the selected dates');
  assert.equal(rows[0].end, end);
  assert.deepEqual(rows[0].values, [0.1, 0.2, 0.3]);
  assert(rows.every(row => !row.conflict));
});

test('energy start uses earliest eligible geometry rather than earliest interval end or receipt', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, range.from, range.from + HOUR);
  put(store, range.from - 40 * DAY, range.from + 2 * HOUR);
  put(store, range.from - 90 * DAY, range.from + HOUR, { receivedAt: now + DAY });
  put(store, range.from - 80 * DAY, range.from + HOUR, { source: 'simulation' });
  put(store, range.from - 70 * DAY, range.from + HOUR, { raw: { timeBasis: 'completed-hour' } });
  assert.equal(recordedEnergyStart(store, 'ev1', 'providers', now), range.from - 40 * DAY);
  assert.equal(recordedEnergyStart(store, 'ev2', 'providers', now), Infinity);
  assert.equal(recordedEnergyStart(store, 'ev1', 'simulated', now), range.from - 80 * DAY);
});

for (const limit of ['none', 'groups', 'bytes']) test(`request-local energy replay (${limit} limit) preserves source rows and accounting`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 8; i++) for (const prefix of ['ev1', 'ev2', 'property'])
    put(store, range.from + i * HOUR, range.from + (i + 1) * HOUR, { prefix });
  const tracker = counted(store), context = createChartQueryContext({ store: tracker.facade, range, now,
    input: 'providers', ...(limit === 'groups' ? { maxEnergyGroups: 1 }
      : limit === 'bytes' ? { maxEnergyBytes: 1 } : {}) });
  const firstStats = { rows: 0, intervals: 0 };
  const first = [...context.energyGroups(firstStats)];
  // Projection counters belong to each caller and are not replay-cache state.
  firstStats.intervals = 400;
  const secondStats = { rows: 0, intervals: 0 };
  const second = [...context.energyGroups(secondStats)];
  assert.deepEqual(first, second);
  assert.equal(firstStats.rows, secondStats.rows);
  assert.equal(secondStats.intervals, 0);
  assert.deepEqual([...context.energyGroups(undefined, 'ev1')], first.filter(row => row.prefix === 'ev1'));
  assert.equal(tracker.counts().energyReads, limit === 'none' ? 1 : 3);
  assert.equal(context.energyStart('ev1'), range.from);
  assert.equal(context.energyStart('ev1'), range.from);
  assert.equal(tracker.counts().startReads, 1);
  put(store, range.from + 8 * HOUR, range.from + 9 * HOUR);
  const refreshed = createChartQueryContext({ store, range, now, input: 'providers' });
  assert.equal([...refreshed.energyGroups()].length, first.length + 1, 'A new request reads newly committed evidence');
});

test('chart loading emits truthful stage progress and keeps output independent of progress reporting', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, range.from, range.from + HOUR);
  const args = { store, input: 'providers', now, startDate: range.startDate, endDate: range.endDate, view: 'power' };
  const progress = [], actual = getChartData({ ...args, onProgress: row => progress.push(row) });
  const expected = getChartData(args);
  delete actual.meta.elapsedMs; delete expected.meta.elapsedMs;
  assert.deepEqual(actual, expected);
  for (const stage of ['reading-history', 'reading-energy']) {
    const rows = progress.filter(row => row.stage === stage);
    assert.equal(rows[0].completed, 0);
    assert.equal(rows.at(-1).completed, DAY);
    assert(rows.every((row, index) => row.total === DAY && row.completed >= (rows[index - 1]?.completed ?? 0)
      && row.completed <= row.total));
  }
  assert.equal(progress.at(-1).stage, 'preparing-summary', 'Traversal completion is not falsely labelled whole-load completion');
  assert(!Object.hasOwn(progress.at(-1), 'total'));
});
