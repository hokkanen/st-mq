import test from 'node:test';
import { testCompletionLimit, testLatencyLimit } from '../../scripts/lib/offline-test-profile.js';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../../src/storage/store.js';
import { appendLearningRecord, replayLearningJournal, learningVersion,
  LEARNING_WINDOW_MS as WINDOW } from '../../src/app/committed-learning.js';
import { decodeLearningCheckpoint } from '../../src/storage/learning-checkpoint-storage.js';
import { enrollJournalPeer } from '../../src/storage/journal-peer.js';

const HOUR = 3_600_000, START = Date.parse('2026-01-01T00:00:00Z');
const CONFIG = { indoorSensorWeights: { indoor_temperature: 1 } };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Every segment is a current resolved equipment/input window. Frequent genuine
// input changes, rather than padding fields, make fitting archives substantial.
function richSample(at) {
  const segmentCount = 30, durationHours = WINDOW / segmentCount / HOUR;
  const inputSegments = Array.from({ length: segmentCount }, (_, index) => ({
    start: at - WINDOW + index * WINDOW / segmentCount,
    end: at - WINDOW + (index + 1) * WINDOW / segmentCount,
    outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0, targetC: 21,
    regime: 'occupied', episodeId: null, supplyC: 35 + index / 10, brineC: 0,
    compressorHeatKw: 9.4, sourceRelativeUncertainty: 0.25,
    sourceEstimateBasis: 'manufacturer-two-point-estimate; not measured heat or electricity',
    sourceUncertaintyReasons: ['installed-model-not-confirmed'], sourcePumpsIncluded: true,
    floorOverrideMode: 'off', treatmentKey: 'normal', compressorDuty: 1,
    compressorPowerKw: 2.2, circulationKw: 0, dhwrKw: 0, auxKw: 0, powerKw: 2.2,
    thermalCompressorDuty: 1, thermalAuxKw: 0, auxRoute: 'space',
    dhwCompressorDuty: 0, dhwAuxKw: 0, auxiliaryStage: 'off',
    auxiliaryPowerBasis: 'observed-output-stage', integral: -100 + index, supplyShortfallC: 1,
    operatingMode: 1, quality: [], hydronicHeatKw: 9.4,
    compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true,
    actualModeKnown: true, energyBasis: 'estimated', configurationVersion: 'a'.repeat(64),
    durationHours, energyKwh: 2.2 * durationHours, hydronicHeatKwh: 9.4 * durationHours,
    compressorKwh: 2.2 * durationHours, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
  }));
  return { sensorInputVersion: 1, timestamp: at, windowStart: at - WINDOW, windowEnd: at,
    indoorC: 21, outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied',
    roomBoostC: 0, targetC: 21, quality: [], actualModeKnown: true, energyBasis: 'estimated',
    thermalCompressorDuty: 1, thermalAuxKw: 0,
    heating: { verified: true, compressorActive: true, compressorDuty: 1, route: 'space-heating', quality: [] },
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: at,
      reportCoverageComplete: true, reportCoveredThrough: at,
      reportIntervals: [{ start: at - WINDOW, end: at, observedAt: at, endpoint: true }] } }, inputSegments };
}

function advance(store, windows, onCheckpoint = () => {}) {
  let checkpoint = null;
  for (let index = 1; index <= windows; index++) {
    store.transaction(() => appendLearningRecord(store, 'mqtt', 'sample', richSample(START + index * WINDOW), { config: CONFIG }));
    checkpoint = replayLearningJournal(store, 'mqtt', checkpoint);
    onCheckpoint(checkpoint);
  }
  return checkpoint;
}

test('shared prepared samples reduce accumulating checkpoint payloads while retaining exact replay', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-checkpoint-growth-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const windows = 96, formerSparse = new Map();
  const checkpoint = advance(store, windows, value => {
    const latest = store.db.prepare('SELECT journal_cursor FROM learning_checkpoints ORDER BY journal_cursor DESC LIMIT 1').get();
    if (latest?.journal_cursor === value.journalCursor && !formerSparse.has(value.journalCursor))
      formerSparse.set(value.journalCursor, { bytes: bytes(value), digest: learningVersion(value) });
  });
  assert.equal(checkpoint.samples.length, windows);
  assert.deepEqual([...formerSparse.keys()], [1, 25, 49, 73], 'the six-hour sparse cadence is unchanged');
  const sparse = store.db.prepare('SELECT journal_cursor,payload FROM learning_checkpoints ORDER BY journal_cursor').all();
  for (const row of sparse) assert.equal(learningVersion(decodeLearningCheckpoint(store.db, JSON.parse(row.payload))),
    formerSparse.get(row.journal_cursor).digest, 'each saved sparse boundary restores exactly');
  assert.ok(isDeepStrictEqual(store.getState('adaptive:mqtt'), checkpoint), 'the full current state restores exactly');
  assert.ok(isDeepStrictEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), checkpoint),
    'the unchanged immutable journal reproduces the complete checkpoint');
  const body = store.db.prepare(`SELECT COUNT(*) rows,COALESCE(SUM(length(CAST(payload AS BLOB))+length(digest)),0) bytes
    FROM learning_checkpoint_samples`).get();
  const compactActiveBytes = store.db.prepare("SELECT length(CAST(value AS BLOB)) bytes FROM state WHERE key='adaptive:mqtt'").get().bytes;
  const compactSparseBytes = sparse.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
  const formerActiveBytes = bytes(checkpoint), formerSparseBytes = [...formerSparse.values()].reduce((sum, row) => sum + row.bytes, 0);
  const compactTotalBytes = body.bytes + compactActiveBytes + compactSparseBytes;
  const formerTotalBytes = formerActiveBytes + formerSparseBytes;
  assert.equal(body.rows, windows, 'one prepared interpretation is retained per window');
  assert.ok(formerActiveBytes > 3 * 1024 ** 2, 'resolved segments exercise substantial fitting archives');
  assert.ok(compactTotalBytes < formerTotalBytes * 0.45, 'shared bodies remove most duplicate checkpoint payloads');
  assert.ok(compactSparseBytes < formerSparseBytes * 0.02, 'future sparse checkpoints add small manifests instead of fitting copies');
  const journalBefore = learningVersion(store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all());
  const head = store.checkpoint();
  for (let index = 0; index < 8; index++) assert.equal(store.setState('adaptive:mqtt', checkpoint).changes, 0);
  assert.deepEqual(store.checkpoint(), head, 'unchanged saves create no new transaction or sparse boundary');
  assert.equal(store.db.prepare('SELECT COUNT(*) rows FROM learning_checkpoint_samples').get().rows, windows);
  assert.equal(learningVersion(store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all()), journalBefore,
    'source payloads and identifiers remain unchanged');
  t.diagnostic(JSON.stringify({ windows, sparseCheckpoints: sparse.length, preparedRows: body.rows,
    preparedBodyBytes: body.bytes, compactActiveBytes, compactSparseBytes, compactTotalBytes,
    formerActiveBytes, formerSparseBytes, formerTotalBytes,
    checkpointPayloadReductionPercent: 100 * (1 - compactTotalBytes / formerTotalBytes),
    sparsePayloadReductionPercent: 100 * (1 - compactSparseBytes / formerSparseBytes),
    comparison: 'logical cache payloads only; excludes common source history, SQLite pages/indexes, journal and filesystem overhead' }));
});

const storeURL = new URL('../../src/storage/store.js', import.meta.url).href;
const learningURL = new URL('../../src/app/committed-learning.js', import.meta.url).href;
const peerURL = new URL('../../src/storage/journal-peer.js', import.meta.url).href;
const measure = `import {Store} from ${JSON.stringify(storeURL)};
import {appendLearningRecord,replayLearningJournal,learningCheckpointDigest} from ${JSON.stringify(learningURL)};
import {preparePeerTransfer,peerTransferRows,applyPeerTransfer,acknowledgePeer} from ${JSON.stringify(peerURL)};
import {readFileSync} from 'node:fs';
const WINDOW=${WINDOW},HOUR=${HOUR},START=${START},CONFIG=${JSON.stringify(CONFIG)};
const richSample=${richSample.toString()};
const io=()=>Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\\n').map(line=>{const [key,value]=line.split(':');return [key,Number(value.trim())];}));
const before=io(),begun=performance.now(),phaseIO={};let previous=before;
const mark=phase=>{const current=io();phaseIO[phase]={rchar:current.rchar-previous.rchar,wchar:current.wchar-previous.wchar};previous=current;};
const source=new Store(process.argv[1]),replica=new Store(process.argv[2]);
const checkpoint=source.getState('adaptive:mqtt'),hydrationMs=performance.now()-begun;
if(checkpoint.samples.length!==48 || learningCheckpointDigest(checkpoint)!==checkpoint.checkpointDigest)throw Error('Invalid hydrated checkpoint');
mark('openAndHydrate');
const base=replica.checkpoint(),started=performance.now();
const oldBodies=source.db.prepare('SELECT COUNT(*) n FROM learning_checkpoint_samples').get().n;
source.transaction(()=>appendLearningRecord(source,'mqtt','sample',richSample(START+49*WINDOW),{config:CONFIG}));
const next=replayLearningJournal(source,'mqtt',checkpoint);
if(source.db.prepare('SELECT COUNT(*) n FROM learning_checkpoint_samples').get().n!==oldBodies+1)throw Error('Old sample bodies rewritten');
mark('learningWindow');
const {path,...metadata}=preparePeerTransfer(source.db,{after:base});
const rows=peerTransferRows(source.db,{id:metadata.id});
if(rows.some(row=>row.change.table==='events'))throw Error('Unrelated history transferred');
mark('stageChangedRows');
applyPeerTransfer(replica.db,{...metadata,changes:rows.map(row=>row.change)});
mark('applyChangedRows');
while(!acknowledgePeer(source.db,{checkpoint:metadata.target}).complete){}
mark('acknowledge');
const restored=replica.getState('adaptive:mqtt');
if(restored.samples.length!==49 || learningCheckpointDigest(restored)!==next.checkpointDigest)throw Error('Replica model differs');
if(source.checkpoint().hash!==replica.checkpoint().hash)throw Error('Different transaction boundaries');
mark('replicaHydration');
const updateAndPairMs=performance.now()-started,changedBytes=Buffer.byteLength(JSON.stringify(metadata))+rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.change)),0);
const changedTables=rows.map(row=>row.change.table).sort();
source.close();replica.close();mark('close');const after=io();
console.log(JSON.stringify({hydrationMs,updateAndPairMs,changedBytes,changedRows:rows.length,changedTables,
 phaseIO,rchar:after.rchar-before.rchar,wchar:after.wchar-before.wchar,readBytes:after.read_bytes-before.read_bytes,writeBytes:after.write_bytes-before.write_bytes}));`;

test('fresh-process checkpoint loading, one learning window and incremental pairing avoid unrelated database-size work',
  { skip: process.platform !== 'linux', timeout: testCompletionLimit(180000) }, t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-checkpoint-size-scale-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const seedPath = join(directory, 'learning-seed.sqlite'), seed = new Store(seedPath);
    try { advance(seed, 48); } finally { seed.close(); }
    const results = [];
    const payload = JSON.stringify({ source: 'synthetic-unrelated-history', readings: Array.from({ length: 48 }, (_, index) => ({
      signal: `synthetic-signal-${index}`, value: index / 7, unit: 'synthetic-unit', quality: ['observed'], receivedAt: START })) });
    for (const payloadMiB of [4, 128]) {
      const sourcePath = join(directory, `source-${payloadMiB}.sqlite`), replicaPath = join(directory, `replica-${payloadMiB}.sqlite`);
      // Deliberate fixture seeding only: every source connection is closed before
      // copying. Routine measured work never copies a database or uses live data.
      copyFileSync(seedPath, sourcePath);
      const source = new Store(sourcePath);
      try {
        const insert = source.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
        const rows = Math.ceil(payloadMiB * 1024 ** 2 / Buffer.byteLength(payload));
        for (let offset = 0; offset < rows; offset += 128) source.transaction(() => {
          for (let index = offset; index < Math.min(rows, offset + 128); index++) insert.run('synthetic-size-scale', payload, START + index);
        });
        // Equalize the disposable recent suffix as well as the learning cache
        // and one-window peer backlog. Otherwise receiver publication can do
        // differing (bounded) deletion work from the fixture's insertion batches.
        source.setState('synthetic-scale-ready', { value: 1 });
        source.compactJournal({ maxBytes: 1, maxCommits: 1 });
        enrollJournalPeer(source.db);
      } finally { source.close(); }
      copyFileSync(sourcePath, replicaPath);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', measure, sourcePath, replicaPath],
        { encoding: 'utf8', timeout: testCompletionLimit(60000) });
      assert.equal(result.status, 0, result.stderr);
      const metrics = { payloadMiB, databaseMiB: statSync(sourcePath).size / 1024 ** 2, ...JSON.parse(result.stdout) };
      t.diagnostic(JSON.stringify(metrics));
      for (const key of ['hydrationMs', 'updateAndPairMs', 'changedBytes', 'changedRows', 'rchar', 'wchar', 'readBytes', 'writeBytes'])
        assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `a complete measurement is required for ${key}`);
      assert.deepEqual(metrics.changedTables,
        ['coefficient_generations', 'learning_checkpoint_samples', 'learning_checkpoints', 'learning_journal_entries', 'state']);
      assert.ok(metrics.changedBytes < 200 * 1024, 'only one source window, its prepared value and small manifests transfer');
      assert.ok(metrics.rchar < 32 * 1024 ** 2, `routine read I/O stays bounded: ${metrics.rchar}`);
      assert.ok(metrics.wchar < 4 * 1024 ** 2, `routine write I/O stays bounded: ${metrics.wchar}`);
      assert.ok(metrics.hydrationMs < testLatencyLimit(10000) && metrics.updateAndPairMs < testLatencyLimit(15000),
        'declared latency guards supplement the independent read, write and transfer work bounds');
      results.push(metrics);
    }
    assert.ok(results[1].databaseMiB > results[0].databaseMiB * 5, 'fixtures differ materially in unrelated history size');
    assert.ok(Math.abs(results[1].changedBytes - results[0].changedBytes) < 256, 'same learning backlog transfers the same bytes');
    assert.ok(Math.abs(results[1].rchar - results[0].rchar) < 4 * 1024 ** 2, 'read work follows the fitting set and changed rows');
    assert.ok(Math.abs(results[1].wchar - results[0].wchar) < 1024 ** 2, 'write work follows the fitting set and changed rows');
  });
