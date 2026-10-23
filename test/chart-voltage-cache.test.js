import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { createChartService } from '../src/app/chart-service.js';
import { getChartData } from '../src/app/chart-data.js';
import { createChartQueryContext } from '../src/app/chart-query-context.js';
import { seedVoltage } from './voltage-fixture.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const from = Date.parse('2026-10-22T06:00:00Z'), now = Date.now() + MINUTE;
const selection = { input: 'providers', view: 'power', startDate: '2026-10-22', endDate: '2026-10-22', now, points: 100 };
async function fixture(t, { imported = false, energy = false, voltage = true, cacheDays = 14, input = 'providers' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-voltage-cache-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  const args = { ...selection, input };
  if (imported) {
    const path = join(directory, 'easee.csv');
    writeFileSync(path, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
      `${from / 1000},10,10,10,12,12,12`, `${(from + MINUTE) / 1000},11,11,11,13,13,13`,
      `${(from + 2 * MINUTE) / 1000},0,0,0,2,2,2`].join('\n'));
    await importCsv(store, path, { kind: 'easee' });
  } else {
    for (const at of [from, from + MINUTE, from + 2 * MINUTE]) for (const prefix of ['property', 'ev1']) {
      for (let phase = 1; phase <= 3; phase++) store.observation({ source: input === 'simulated' ? 'simulation' : 'easee',
        device: 'invented-charger', signal: `${prefix}_current_l${phase}`, value: at === from + 2 * MINUTE ? 0 : 10,
        unit: 'A', sourceTime: at, receivedAt: at, quality: [] });
    }
  }
  if (energy) for (let phase = 1; phase <= 3; phase++) store.observation({ source: input === 'simulated' ? 'simulation' : 'easee',
    device: 'invented-charger', signal: `ev1_energy_l${phase}`, value: 1, unit: 'kWh',
    sourceTime: from + HOUR, receivedAt: from + HOUR, quality: ['estimated'],
    raw: { intervalStart: from, intervalEnd: from + HOUR, durationMs: HOUR, basis: 'integrated-power-phase-allocation' } });
  if (voltage) seedVoltage(store, from - HOUR, [220, 225, 230], { input });
  const service = createChartService({ store, clock: () => now, warmCache: false, cacheDays });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, args };
}
async function canonical(f, args = f.args) {
  const result = await f.service.query(args), direct = getChartData({ ...args, store: f.store });
  assert.deepEqual(result.series, direct.series);
  assert.deepEqual(result.shading, direct.shading);
  return result;
}

for (const cacheDays of [0, 14]) for (const kind of ['native', 'energy', 'imported']) {
  test(`${cacheDays ? 'resident' : 'archive'} historical ${kind} plots survive current-day voltage updates`, async t => {
    const f = await fixture(t, { cacheDays, imported: kind === 'imported', energy: kind === 'energy' });
    const first = await canonical(f);
    assert(first.series.charger_power.some(point => point.y > 0));
    assert.equal((await f.service.query(f.args)).meta.cacheHit, true);
    for (let index = 0; index < 3; index++) {
      seedVoltage(f.store, now - MINUTE + index, [235 + index, 238, 240]);
      const next = await canonical(f);
      assert.equal(next.meta.cacheHit, true); assert.deepEqual(next.series, first.series);
    }
  });
}

for (const input of ['providers', 'mqtt', 'simulated']) {
  test(`historical voltage dependencies respect ${input} input scope`, async t => {
    const f = await fixture(t, { input, energy: true });
    const args = { ...f.args, view: 'phases' }, first = await canonical(f, args);
    seedVoltage(f.store, from + MINUTE, [245, 245, 245], { input: input === 'simulated' ? 'providers' : 'simulated' });
    assert.equal((await canonical(f, args)).meta.cacheHit, true);
    seedVoltage(f.store, from + MINUTE, [240, 240, 240], { input });
    const changed = await canonical(f, args);
    assert.notEqual(changed.meta.cacheHit, true); assert.notDeepEqual(changed.series, first.series);
  });
}

test('new in-period and earlier predecessor voltage refresh original power without discarding energy evidence', async t => {
  const f = await fixture(t);
  const first = await canonical(f);
  seedVoltage(f.store, from + MINUTE / 2, [240, 240, 240]);
  const changed = await canonical(f);
  assert.notEqual(changed.meta.cacheHit, true); assert.notDeepEqual(changed.series, first.series);
  seedVoltage(f.store, from - MINUTE, [250, 250, 250]);
  const predecessor = await canonical(f);
  assert.notEqual(predecessor.meta.cacheHit, true); assert.notDeepEqual(predecessor.series, changed.series);
});

test('late native voltage received after closed dates cannot rewrite their causal history', async t => {
  const f = await fixture(t), first = await canonical(f);
  seedVoltage(f.store, from - MINUTE, [250, 250, 250], { receivedAt: now });
  const after = await canonical(f);
  assert.equal(after.meta.cacheHit, true); assert.deepEqual(after.series, first.series);
});

test('first usable voltage after closed dates refreshes imported missing and partially known history', async t => {
  const f = await fixture(t, { imported: true, voltage: false });
  const unknown = await canonical(f);
  assert(unknown.series.charger_power.every(point => point.y === null));
  seedVoltage(f.store, now - MINUTE, [220, null, null]);
  const partial = await canonical(f);
  assert.notEqual(partial.meta.cacheHit, true); assert(partial.series.charger_power.every(point => point.y === null));
  seedVoltage(f.store, now - MINUTE / 2, [240, 225, 230]);
  const complete = await canonical(f);
  assert.notEqual(complete.meta.cacheHit, true);
  assert(complete.series.charger_power.some(point => point.y > 0 && point.retrospectiveVoltage));
  const point = complete.series.charger_power.find(point => point.y > 0);
  assert.deepEqual(point.voltageV, [220, 225, 230]);
});

test('a newly discovered earlier first estimate refreshes imported history but later unusable updates do not', async t => {
  const f = await fixture(t, { imported: true, voltage: false });
  seedVoltage(f.store, now - MINUTE, [240, 240, 240]);
  const first = await canonical(f);
  seedVoltage(f.store, now - 2 * MINUTE, [220, 225, 230]);
  const earlier = await canonical(f);
  assert.notEqual(earlier.meta.cacheHit, true); assert.notDeepEqual(earlier.series, first.series);
  seedVoltage(f.store, now - MINUTE / 2, [null, null, null]);
  assert.equal((await canonical(f)).meta.cacheHit, true);
});

for (const clock of ['receipt', 'source']) {
  test(`future ${clock} admission refreshes retrospective history without another committed row`, async t => {
    const f = await fixture(t, { imported: true, voltage: false });
    seedVoltage(f.store, clock === 'source' ? now + 3000 : now - MINUTE, [230, 230, 230],
      { receivedAt: clock === 'receipt' ? now + 3000 : now });
    const first = await canonical(f), head = f.store.checkpoint();
    assert(first.series.charger_power.every(point => point.y === null));
    assert.equal((await f.service.query({ ...f.args, now: now + 1000 })).meta.cacheHit, true);
    const after = await canonical(f, { ...f.args, now: now + 4000 });
    assert.notEqual(after.meta.cacheHit, true); assert(after.series.charger_power.some(point => point.y > 0));
    assert.deepEqual(f.store.checkpoint(), head);
  });

  test(`same-bucket future native ${clock} admission refreshes the voltage plot`, async t => {
    const f = await fixture(t);
    const at = Math.floor(now / 15_000) * 15_000 + 1000;
    const args = { ...f.args, now: at, startDate: '2026-10-23', endDate: '2026-10-23', view: 'voltage_estimates' };
    seedVoltage(f.store, clock === 'source' ? at + 3000 : at - 3000, [245, 245, 245],
      { receivedAt: clock === 'receipt' ? at + 3000 : at });
    const first = await canonical(f, args), head = f.store.checkpoint();
    assert.equal((await f.service.query({ ...args, now: at + 1000 })).meta.cacheHit, true);
    const after = await canonical(f, { ...args, now: at + 4000 });
    assert.notEqual(after.meta.cacheHit, true); assert.notDeepEqual(after.series, first.series);
    assert.deepEqual(f.store.checkpoint(), head);
  });
}

test('recovery selection refreshes the first retrospective basis and preserves raw source observations', async t => {
  const f = await fixture(t, { imported: true, voltage: false });
  seedVoltage(f.store, now - 2 * MINUTE, [220, 220, 220]);
  seedVoltage(f.store, now - MINUTE, [240, 240, 240]);
  const first = await canonical(f), original = f.store.db.prepare('SELECT * FROM observations ORDER BY id').all();
  f.store.transaction(() => {
    for (const row of original.filter(row => row.source === 'voltage-estimate' && row.source_time === now - 2 * MINUTE))
      f.store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('synthetic-voltage-correction','observations',?)").run(String(row.id));
    f.store.db.prepare("UPDATE history_selection SET generation='synthetic-voltage-correction' WHERE id=1").run();
  });
  const after = await canonical(f);
  assert.notEqual(after.meta.cacheHit, true); assert.notDeepEqual(after.series, first.series);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM observations ORDER BY id').all(), original);
});

test('energy contexts retain the same bounded groups while resetting stale voltage lookups', async t => {
  const f = await fixture(t, { energy: true }), range = getChartData({ ...f.args, store: f.store }).range;
  const context = createChartQueryContext({ store: f.store, range, input: 'providers', now });
  const groups = [...context.energyGroups()]; assert(groups.length > 0);
  assert.equal(context.voltageReader(from).voltageV[0], 220);
  seedVoltage(f.store, from - MINUTE, [245, 245, 245]);
  assert.equal(context.voltageReader(from).voltageV[0], 220, 'An immutable reader retains its checked interval');
  context.resetVoltage(now);
  assert.equal(context.voltageReader(from).voltageV[0], 245);
  const reused = [...context.energyGroups()]; assert.equal(reused.length, groups.length);
  for (let index = 0; index < groups.length; index++) assert.equal(reused[index], groups[index]);
});

test('voltage-free drawings survive first voltage arrival and exact closed-period boundaries stay excluded', async t => {
  const f = await fixture(t, { voltage: false });
  const garage = { ...f.args, view: 'garage' };
  await canonical(f, garage);
  seedVoltage(f.store, now - MINUTE, [230, 230, 230]);
  assert.equal((await canonical(f, garage)).meta.cacheHit, true);
  const first = await canonical(f);
  seedVoltage(f.store, first.range.to, [240, 240, 240]);
  assert.equal((await canonical(f)).meta.cacheHit, true);
});

for (const imported of [false, true]) {
  test(`deterministic mixed voltage changes match uncached ${imported ? 'imported' : 'energy'} charts at every step`, async t => {
    const f = await fixture(t, { imported, energy: !imported });
    let random = 92831;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    let at = now;
    for (let index = 0; index < 32; index++) {
      const kind = next() % 5;
      const sourceTime = kind === 0 ? at - 1000 : from - HOUR + (next() % 120) * MINUTE;
      const receivedAt = kind === 1 ? at + 3000 : sourceTime;
      seedVoltage(f.store, sourceTime, [210 + next() % 40, index % 7 === 0 ? null : 225, 230],
        { receivedAt, input: kind === 2 ? 'simulated' : 'providers' });
      if (index % 4 === 3) at += 4000;
      for (const axis of ['power', 'phases', 'voltage_estimates']) {
        const args = { ...f.args, view: axis, now: at };
        await canonical(f, args);
        assert.equal((await f.service.query(args)).meta.cacheHit, true, `Step ${index} ${axis} is reusable`);
      }
    }
  });
}
