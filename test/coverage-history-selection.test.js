import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { RECOVERABLE_TABLES, recoveryRecordKey } from '../src/storage/schema.js';
import { selectedCoverageSpan } from '../src/storage/coverage-history.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';
import { openJournalSource } from '../src/recovery/incremental-source.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';
import { PeerTransfers } from '../src/replication/coalesced.js';
import { fixture, start } from './helpers/recovery-fixture.js';

const MINUTE = 60_000;
const proposed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function report(recorder, minute) {
  recorder.record({ source: 'mqtt-temperature', device: 'synthetic-room', signal: 'indoor_temperature',
    unit: 'degC', value: 21, sourceTime: start + minute * MINUTE, receivedAt: start + minute * MINUTE,
    quality: [], raw: { reportIntervalMs: MINUTE, reportGraceMs: 2 * MINUTE, retained: false,
      temperatureRouteSignature: 'a'.repeat(64) } });
}
const selected = store => store.db.prepare(`SELECT c.id FROM active_recorder_coverage c
  WHERE c.signal='indoor_temperature' AND ${selectedCoverageSpan('c')} ORDER BY c.id`).all().map(row => row.id);

function installActualProposedViews(db) {
  // Execute the actual worker producer, rather than a second copy of its
  // selection SQL. This does not claim that replay recomputes saved samples.
  const source = readFileSync(new URL('../src/recovery/revision-worker.js', import.meta.url), 'utf8');
  const producer = source.match(/function selectProposedViews\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(producer, 'The current revision worker exposes its proposed-view producer');
  new Function('db', 'generation', 'RECOVERABLE_TABLES', 'recoveryRecordKey',
    `${producer}; selectProposedViews();`)(db, proposed, RECOVERABLE_TABLES, recoveryRecordKey);
}

for (const excludeProposed of [true, false]) test(`coverage selection follows proposed ${excludeProposed ? 'exclusion' : 'inclusion'} independently of the published generation`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store); report(recorder, 0); report(recorder, 1);
  const original = store.db.prepare('SELECT * FROM recorder_coverage').get();
  let continuation;
  store.transaction(() => {
    continuation = store.db.prepare(`INSERT INTO recorder_coverage
      (source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      SELECT source,device,signal,status,start_at,end_at+?,source_time+?,observation_id,samples+4
      FROM recorder_coverage WHERE id=?`).run(4 * MINUTE, 4 * MINUTE, original.id).lastInsertRowid;
    store.db.prepare('INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)')
      .run(excludeProposed ? proposed : 'original', 'recorder_coverage', String(continuation));
  });
  assert.deepEqual(selected(store), [excludeProposed ? continuation : original.id],
    'The normal reader still follows the published generation');
  const checkpoint = store.checkpoint();
  const rows = store.db.prepare('SELECT * FROM main.recorder_coverage ORDER BY id').all();
  installActualProposedViews(store.db);
  const expected = excludeProposed ? original.id : continuation;
  assert.deepEqual(selected(store), [expected],
    'A continuation from another selection must neither suppress nor duplicate the proposed source');
  const reading = lastIndoorReading(store, { signal: 'indoor_temperature', input: 'providers', at: start + 3.5 * MINUTE });
  assert.equal(reading.stale, false, 'The actual sensor reader retains the selected report coverage');
  assert.deepEqual(reading.reportCoverage.coverage, [expected]);
  assert.deepEqual(store.checkpoint(), checkpoint, 'Proposed reads do not publish the generation');
  assert.deepEqual(store.db.prepare('SELECT * FROM main.recorder_coverage ORDER BY id').all(), rows);
  assert.equal(store.db.prepare('SELECT generation FROM main.history_selection WHERE id=1').get().generation, 'original');
});

test('coverage selection reads the actual incremental journal overlay and its changed-key active source', async t => {
  const f = fixture(t), masterRecorder = new Recorder(f.master);
  report(masterRecorder, 0); report(masterRecorder, 1);
  const base = enrollJournalPeer(f.master.db).checkpoint;
  const donor = await f.donor(), donorRecorder = new Recorder(donor);
  report(donorRecorder, 3);
  report(masterRecorder, 2);
  const transfers = new PeerTransfers(join(f.directory, 'peer-wire'));
  const metadata = await transfers.export({ dbPath: donor.path, after: base });
  const journal = join(f.directory, 'source.ndjson');
  await writeFile(journal, await readFile(join(transfers.directory, `peer-${metadata.id}.changes`)), { mode: 0o600 });
  const before = f.master.checkpoint();
  const source = await openJournalSource({ masterPath: f.master.path, journalPath: journal, yieldControl: async () => {} });
  try {
    assert.equal(source.db.prepare("SELECT type FROM temp.sqlite_schema WHERE name='recorder_coverage'").get().type, 'view');
    const span = source.db.prepare('SELECT * FROM active_recorder_coverage').get();
    assert.equal(span.end_at, start + 3 * MINUTE);
    assert.equal(f.master.db.prepare('SELECT end_at FROM recorder_coverage').get().end_at, start + 2 * MINUTE,
      'The overlay carries a genuinely different source value');
    assert.deepEqual(selected(source), [span.id]);
    const reading = lastIndoorReading(source, { signal: 'indoor_temperature', input: 'providers', at: start + 5.5 * MINUTE });
    assert.equal(reading.stale, false, 'The selected overlay endpoint supplies current report coverage');
    assert.equal(reading.reportExpiresAt, start + 6 * MINUTE);
    assert.deepEqual(f.master.checkpoint(), before, 'A donor overlay never changes the master');
  } finally { source.close(); }
});

test('coverage continuation bounds retain supported numeric, unknown-clock and as-of meanings', t => {
  for (const start of [-8_640_000_000_000_000, 1_700_000_000_000_000, 8_640_000_000_000_000 - 1000]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const observation = store.observation({ source: 'synthetic', device: 'numeric-boundary',
      signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start,
      receivedAt: start, quality: [] });
    const put = store.db.prepare(`INSERT INTO recorder_coverage
      (source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES('synthetic','numeric-boundary','indoor_temperature','fresh',?,?,?,?,1)`);
    let short, longer, unknown;
    store.transaction(() => {
      short = put.run(start, start + 100, start + 100, observation).lastInsertRowid;
      longer = put.run(start, start + 200, start + 150, observation).lastInsertRowid;
      unknown = put.run(start, start + 300, null, observation).lastInsertRowid;
    });
    const read = (through = null, fallback = false) => store.db.prepare(`WITH clock(at) AS (VALUES(?))
      SELECT c.id FROM active_recorder_coverage c CROSS JOIN clock
      WHERE ${selectedCoverageSpan('c', through === null ? null : 'clock.at', fallback)} ORDER BY c.id`)
      .all(through).map(row => row.id);
    assert.deepEqual(read(), [longer, unknown], 'A genuinely longer and newer endpoint dominates; NULL does not');
    assert.deepEqual(read(start + 125), [short, longer, unknown], 'A future continuation cannot suppress a known endpoint');
    assert.deepEqual(read(start + 125, true), [short, unknown], 'The known-endpoint fallback precedes the future endpoint');
    assert.deepEqual(read(start + 250), [longer, unknown]);
    assert.deepEqual(read(start + 250, true), [longer, unknown]);
  }
});
