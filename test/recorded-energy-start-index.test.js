import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordedEnergyStart } from '../src/storage/energy-history.js';
import { RECOVERABLE_TABLES, recoveryRecordKey } from '../src/storage/schema.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';
import { openJournalSource } from '../src/recovery/incremental-source.js';
import { PeerTransfers } from '../src/replication/coalesced.js';
import { fixture } from './helpers/recovery-fixture.js';

const T = Date.UTC(2026, 8, 1), MINUTE = 60_000, DAY = 86400_000;
const proposed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function put(store, from, to, { prefix = 'ev1', raw = {}, ...extra } = {}) {
  return store.observation({ source: 'easee', device: `invented-${prefix}`, signal: prefix === 'caravan' ? 'caravan_energy' : `${prefix}_energy_l1`,
    value: 0.1, unit: 'kWh', sourceTime: to, receivedAt: to, quality: [],
    raw: { intervalStart: from, intervalEnd: to, ...raw }, ...extra });
}

test('energy-start seeks its signal rather than walking a growing unrelated energy archive', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  put(store, T, T + MINUTE);
  const insert = store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw)
    VALUES('easee','invented-property',?,0.1,'kWh',?,?,'[]',?)`);
  let previous = 0;
  for (const count of [1000, 30000]) {
    for (let start = previous; start < count; start += 64) store.transaction(() => {
      for (let n = start; n < Math.min(count, start + 64); n++) {
        const from = T - (n + 1) * MINUTE, to = from + MINUTE;
        for (const phase of [1, 2, 3]) insert.run(`property_energy_l${phase}`, to, to, JSON.stringify({ intervalStart: from, intervalEnd: to }));
      }
    });
    previous = count;
    const plans = [], schema = store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), checkpoint = store.checkpoint();
    let candidateRows = 0;
    const reader = { db: { prepare(sql) {
      const statement = store.db.prepare(sql);
      return { *iterate(...args) {
        if (sql.includes('observations_energy_start')) plans.push(store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail));
        for (const row of statement.iterate(...args)) { if (sql.includes('observations_energy_start')) candidateRows++; yield row; }
      } };
    } } };
    const began = performance.now();
    assert.equal(recordedEnergyStart(reader, 'ev1', 'providers', T + 2 * MINUTE), T);
    assert.equal(candidateRows, 1);
    assert.equal(plans.length, 1);
    assert(plans[0].some(detail => /SEARCH candidate USING INDEX observations_energy_start \(signal=\?\)/.test(detail)));
    assert(plans[0].some(detail => /SEARCH r USING INTEGER PRIMARY KEY/.test(detail)), 'Actual selected-view membership remains an indexed point lookup');
    assert(!plans[0].some(detail => /SCAN |TEMP B-TREE/.test(detail)));
    assert.deepEqual(store.checkpoint(), checkpoint);
    assert.deepEqual(store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema, 'A read creates no index or format conversion');
    t.diagnostic(JSON.stringify({ unrelatedPhaseRows: count * 3, candidateRows, elapsedMs: performance.now() - began }));
  }
});

for (const prefix of ['property', 'ev1', 'ev2', 'caravan']) test(`${prefix} start preserves earliest valid geometry, original admission and simulation scope`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = T + 3 * MINUTE;
  put(store, T, T + MINUTE, { prefix });
  put(store, T - 5 * DAY, T + 2 * MINUTE, { prefix });
  const excluded = put(store, T - 10 * DAY, T + MINUTE, { prefix });
  store.transaction(() => store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)")
    .run(String(excluded)));
  put(store, T - 15 * DAY, T + MINUTE, { prefix, receivedAt: now + MINUTE });
  put(store, T - 20 * DAY, T + MINUTE, { prefix, raw: { timeBasis: 'completed-hour' } });
  put(store, T - 25 * DAY, T + MINUTE, { prefix, raw: { intervalEnd: T + MINUTE + 1 } });
  put(store, T - 30 * DAY, T + MINUTE, { prefix, source: 'simulation' });
  put(store, T - 35 * DAY, T + MINUTE, { prefix, receivedAt: T + MINUTE - 1,
    raw: { timeAdmission: { sourceTime: T + MINUTE, receivedAt: T + MINUTE - 1, admittedAt: now + 1 } } });
  assert.equal(recordedEnergyStart(store, prefix, 'providers', now), T - 5 * DAY,
    'The later-ending long interval retains its earlier start; excluded, unknown and unadmitted rows do not precede it');
  assert.equal(recordedEnergyStart(store, prefix, 'providers', now + 1), T - 35 * DAY,
    'A source-admitted row becomes eligible at its original admission clock');
  assert.equal(recordedEnergyStart(store, prefix, 'simulated', now), T - 30 * DAY);
  assert.equal(recordedEnergyStart(store, 'unsupported-prefix', 'providers', now), Infinity);
});

test('pending-only and earlier pending energy keep their original long start and input scope', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const pending = (source, prefix, from) => store.setState(`recorder:energy:${JSON.stringify([source, 'invented-pending', prefix])}`, {
    pending: { start: from, end: T + MINUTE, receivedAt: T + MINUTE, energies: prefix === 'caravan' ? [0.1] : [0.1, 0.2, 0.3], quality: [] } });
  pending('easee', 'caravan', T - 50 * DAY);
  assert.equal(recordedEnergyStart(store, 'caravan', 'providers', T + 2 * MINUTE), T - 50 * DAY);
  assert.equal(recordedEnergyStart(store, 'caravan', 'simulated', T + 2 * MINUTE), Infinity);
  put(store, T - DAY, T + MINUTE);
  pending('easee', 'ev1', T - 60 * DAY);
  pending('simulation', 'ev1', T - 70 * DAY);
  assert.equal(recordedEnergyStart(store, 'ev1', 'providers', T + 2 * MINUTE), T - 60 * DAY);
  assert.equal(recordedEnergyStart(store, 'ev1', 'simulated', T + 2 * MINUTE), T - 70 * DAY);
  assert.equal(recordedEnergyStart(store, 'ev1', 'providers', T), Infinity, 'Neither a future receipt nor pending publication renews historical availability');
});

function selectActualProposedViews(db) {
  const source = readFileSync(new URL('../src/recovery/revision-worker.js', import.meta.url), 'utf8');
  const producer = source.match(/function selectProposedViews\(\) \{[\s\S]*?\n\}/)?.[0];
  assert(producer);
  new Function('db', 'generation', 'RECOVERABLE_TABLES', 'recoveryRecordKey', `${producer};selectProposedViews();`)
    (db, proposed, RECOVERABLE_TABLES, recoveryRecordKey);
}

for (const proposedExcludes of [true, false]) test(`energy start honors actual proposed ${proposedExcludes ? 'exclusion' : 'inclusion'} without publishing it`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = put(store, T - 5 * DAY, T + MINUTE);
  put(store, T, T + MINUTE);
  store.transaction(() => store.db.prepare('INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)')
    .run(proposedExcludes ? proposed : 'original', 'observations', String(first)));
  assert.equal(recordedEnergyStart(store, 'ev1', 'providers', T + 2 * MINUTE), proposedExcludes ? T - 5 * DAY : T);
  const before = store.checkpoint(), rows = store.db.prepare('SELECT * FROM main.observations ORDER BY id').all();
  selectActualProposedViews(store.db);
  assert.equal(recordedEnergyStart(store, 'ev1', 'providers', T + 2 * MINUTE), proposedExcludes ? T : T - 5 * DAY);
  assert.deepEqual(store.checkpoint(), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM main.observations ORDER BY id').all(), rows);
});

test('journal-source overlays retain complete donor start context beyond their changed-key active rows', async t => {
  const f = fixture(t);
  const first = put(f.master, T - 10 * DAY, T - DAY);
  const base = enrollJournalPeer(f.master.db).checkpoint;
  const donor = await f.donor();
  put(donor, T, T + MINUTE);
  const transfers = new PeerTransfers(join(f.directory, 'start-wire'));
  const metadata = await transfers.export({ dbPath: donor.path, after: base });
  const journalPath = join(f.directory, 'start-source.ndjson');
  await writeFile(journalPath, await readFile(join(transfers.directory, `peer-${metadata.id}.changes`)), { mode: 0o600 });
  const original = f.master.checkpoint();
  const source = await openJournalSource({ masterPath: f.master.path, journalPath, yieldControl: async () => {} });
  try {
    assert.equal(source.journalSource, true);
    assert.equal(source.db.prepare("SELECT type FROM temp.sqlite_schema WHERE name='observations'").get().type, 'view');
    assert.equal(source.db.prepare('SELECT 1 FROM active_observations WHERE id=?').get(first), undefined,
      'The current active overlay is a changed-key closure, not the complete donor archive');
    assert.equal(recordedEnergyStart(source, 'ev1', 'providers', T + 2 * MINUTE), T - 10 * DAY);
    assert.deepEqual(f.master.checkpoint(), original);
  } finally { source.close(); }
});
