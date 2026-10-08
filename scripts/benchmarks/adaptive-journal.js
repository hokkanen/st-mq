// Isolated, disk-backed storage workload. No installation configuration or data.
// --source-root is only for comparing source checkouts; it never opens their DBs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
assert(args.every(arg => /^--(?:source-root|cycles|large-cycles|workloads|child|history-rows|replicate-every|verify-every|peer-mode|offline-cycles)=/.test(arg)), 'Unknown argument');
const currentRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = resolve(option('source-root', currentRoot));
const cycles = Number(option('cycles', '5760'));
const largeCycles = Number(option('large-cycles', '300'));
const historyRows = Number(option('history-rows', '0'));
const replicateEvery = Number(option('replicate-every', '0'));
const verifyEvery = Number(option('verify-every', '0'));
const explicitPeerMode = option('peer-mode', null);
const peerMode = explicitPeerMode ?? 'coalesced';
const offlineCycles = Number(option('offline-cycles', '0'));
assert(['transaction', 'coalesced'].includes(peerMode));
assert(peerMode !== 'transaction' || sourceRoot !== currentRoot,
  'Transaction replay is only available for an external historical --source-root comparison; current peers use coalesced catch-up');
for (const value of [cycles, largeCycles]) assert(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000);
for (const value of [historyRows, replicateEvery, verifyEvery, offlineCycles]) assert(Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000);
const names = ['constant', 'nearly-constant', 'large-state', 'mixed', 'append', 'no-op'];
const child = option('child', null);
if (!child) {
  const workloads = option('workloads', names.join(',')).split(',');
  assert(workloads.every(name => names.includes(name)));
  console.log(JSON.stringify({ synthetic: true, node: process.version, cpu: cpus()[0]?.model,
    hardwareThreads: cpus().length, memoryBytes: totalmem(), sourceRoot, cycles, largeCycles, historyRows, replicateEvery, verifyEvery, peerMode, offlineCycles,
    criteria: 'Exact recorder values, gaps, accepted sample counts and energy; append rows and latest state preserved. Disposable journal reaches its documented retention bound through repeated maintenance; retained data may grow. Compare absolute allocation and per-stage growth, not a universal multiplier.',
    limits: 'Host results, not Raspberry Pi deadlines. Reports run at maximum synthetic speed, yielding every 16 operations; heartbeat delay includes that deliberate batching and synchronous transaction-tail peer export/apply. SQL dbstat scans are benchmark instrumentation outside timed work. Linux process I/O counts include SQLite reads/writes but physical I/O is cache dependent. Peak memory is per child. No vacuum: free pages are reported separately. Replication wire bytes are serialized batches, excluding transport framing. Temporary-file inventory is final, not a peak of OS scratch usage. Mixed learning uses current synthetic observed-input samples and verifies exact seed replay; it does not validate household thermal physics.' }));
  for (const workload of workloads) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args.filter(arg => !arg.startsWith('--workloads=')), `--child=${workload}`],
      { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    process.stdout.write(result.stdout);
  }
} else {
  assert(names.includes(child));
  const { Store } = await import(pathToFileURL(join(sourceRoot, 'src/storage/store.js')).href);
  const { Recorder } = await import(pathToFileURL(join(sourceRoot, 'src/storage/recorder.js')).href);
  const { appendLearningRecord, replayLearningJournal } = await import(pathToFileURL(join(sourceRoot, 'src/app/committed-learning.js')).href);
  const { currentHomeSample } = await import(pathToFileURL(join(sourceRoot, 'test/helpers/home-learning-fixture.js')).href);
  const verifyDatabase = verifyEvery ? (await import(pathToFileURL(join(sourceRoot, 'src/storage/full-verifier.js')).href)).verifyDatabase : null;
  const peerModule = peerMode === 'coalesced' && (replicateEvery || explicitPeerMode === 'coalesced')
    ? await import(pathToFileURL(join(sourceRoot, 'src/replication/coalesced.js')).href) : null;
  const peerOperation = peerModule?.peerOperation;
  const directory = mkdtempSync(join(tmpdir(), 'stmq-adaptive-journal-'));
  const peerTransfers = peerModule ? new peerModule.PeerTransfers(join(directory, 'transfers')) : null;
  const path = join(directory, 'source.sqlite');
  const store = new Store(path), recorder = new Recorder(store);
  let replica = null;
  const bytes = path => { try { return statSync(path).size; } catch { return 0; } };
  const filesUnder = (path, prefix = '') => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(join(path, entry.name), relative) : [{ name: relative, bytes: bytes(join(path, entry.name)) }];
  });
  const io = () => {
    if (process.platform !== 'linux') return null;
    return Object.fromEntries(readFileSync('/proc/self/io', 'utf8').trim().split('\n').map(line => {
      const [key, value] = line.split(':'); return [key, Number(value.trim())];
    }));
  };
  const tables = () => store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row => row.name);
  const hasTable = name => tables().includes(name);
  const count = name => hasTable(name) ? store.db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n : 0;
  const measure = ({ detail = true } = {}) => {
    const pageSize = store.db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = store.db.prepare('PRAGMA page_count').get().page_count;
    const freePages = store.db.prepare('PRAGMA freelist_count').get().freelist_count;
    const physical = { databaseBytes: bytes(path), allocatedBytes: pageCount * pageSize, reusableBytes: freePages * pageSize,
      walBytes: bytes(`${path}-wal`), shmBytes: bytes(`${path}-shm`) };
    if (!detail) return { ...physical, journalCommits: count('journal_commits'), journalChanges: count('journal_changes') };
    const allocations = store.db.prepare('SELECT name, SUM(pgsize) allocatedBytes, SUM(payload) payloadBytes, SUM(unused) unusedBytes FROM dbstat GROUP BY name ORDER BY name').all();
    const counts = Object.fromEntries(tables().map(name => [name, count(name)]));
    const objects = new Map(store.db.prepare("SELECT name,type,tbl_name FROM sqlite_schema WHERE type IN ('table','index')").all().map(row => [row.name, row]));
    const categories = { observations: 0, learning: 0, coverage: 0, state: 0, journal: 0, peerBacklog: 0, branches: 0, indexes: 0, other: 0 };
    for (const row of allocations) {
      const object = objects.get(row.name);
      const category = object?.type === 'index' ? 'indexes' : row.name.startsWith('journal_branch') || row.name.startsWith('journal_peer_branch') ? 'branches'
        : row.name.startsWith('journal_peer') ? 'peerBacklog'
        : row.name.startsWith('journal_') ? 'journal' : row.name.startsWith('learning_') ? 'learning'
        : row.name === 'observations' ? 'observations' : row.name === 'recorder_coverage' ? 'coverage'
        : row.name === 'state' ? 'state' : 'other';
      categories[category] += row.allocatedBytes;
    }
    return { ...physical, counts, categories, allocations,
      otherFiles: filesUnder(directory).filter(row => !['source.sqlite', 'source.sqlite-wal', 'source.sqlite-shm', 'replica.sqlite', 'replica.sqlite-wal', 'replica.sqlite-shm'].includes(row.name)) };
  };
  const start = Date.UTC(2026, 0, 1), minute = 60_000;
  const scalar = (i, value) => recorder.record({ source: 'synthetic', device: 'synthetic-sensor', signal: 'supply_temperature',
    value, unit: 'degC', sourceTime: value === null ? null : start + i * minute, receivedAt: start + i * minute,
    quality: value === null ? ['provider-error'] : [], raw: { verified: true } });
  const insertEvent = store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
  const largeDocument = { chunks: Array.from({ length: 128 }, (_, i) => Array.from({ length: 32 }, (_, j) => createHash('sha256').update(`${i}:${j}`).digest('hex')).join('')), counter: 0 };
  const snapshots = [], latencies = [], eventLoop = monitorEventLoopDelay({ resolution: 5 });
  let wireBytes = 0, expectedEnergy = 0, peakWalBytes = 0, lastBeat = performance.now(), maxHeartbeatGapMs = 0;
  let peakRssBytes = process.memoryUsage.rss();
  let before, initial, elapsedMs, deltaIO;
  let pendingVerification = null, verificationFailure = null;
  const verifications = [];
  const transfers = [];
  let learningCheckpoint = null;
  const replicate = async atCycle => {
    if (peerOperation) {
      const stageMetrics = [];
      const stage = async (name, operation) => {
        const before = io(), began = performance.now(), result = await operation(), after = io();
        stageMetrics.push({ name, elapsedMs: performance.now() - began,
          io: before && Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) });
        return result;
      };
      const metadata = await stage('export', () => peerTransfers.export({ dbPath: path, after: replica.checkpoint() }));
      wireBytes += metadata.bytes;
      await stage('apply', () => peerOperation('apply', { dbPath: replica.path, metadata, path: join(directory, 'transfers', `peer-${metadata.id}.changes`) }));
      await stage('acknowledge', () => peerOperation('acknowledge', { dbPath: path, checkpoint: replica.checkpoint() }));
      transfers.push({ atCycle, bytes: metadata.bytes, rows: metadata.rows, stages: stageMetrics });
    } else for (;;) {
      const batch = store.exportChanges({ after: replica.checkpoint() });
      wireBytes += Buffer.byteLength(JSON.stringify(batch)); replica.applyChanges(batch);
      if (!batch.hasMore) break;
    }
  };
  try {
    // Seed outside the measured tail; this is intentionally retained history.
    for (let offset = 0; offset < historyRows; offset += 128) store.transaction(() => {
      for (let i = offset; i < Math.min(historyRows, offset + 128); i++) insertEvent.run('synthetic-prefix', JSON.stringify({ i, payload: 'prefix'.repeat(170) }), start - historyRows + i);
    });
    if (child === 'large-state') store.setState('synthetic-large-state', largeDocument);
    if (child === 'no-op') store.setState('synthetic-no-op', { value: 1 });
    if (replicateEvery || peerOperation) {
      if (!peerOperation) assert.equal(typeof store.applyChanges, 'function', 'Historical transaction measurement needs its matching source implementation');
      if (peerOperation) await peerOperation('enroll', { dbPath: path });
      // Deliberate one-time synthetic seed, excluded from wire and I/O metrics.
      await store.backup(join(directory, 'replica.sqlite'));
      replica = new Store(join(directory, 'replica.sqlite'));
      if (peerOperation) await peerOperation('accept', { dbPath: replica.path });
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    initial = measure(); before = io();
    const begin = performance.now(), n = child === 'large-state' ? largeCycles : cycles;
    lastBeat = begin;
    eventLoop.enable();
    const beat = setInterval(() => {
      const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastBeat); lastBeat = now;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    }, 5);
    try {
      for (let i = 0; i < n; i++) {
        const then = performance.now();
        if (child === 'constant') scalar(i, 35);
        else if (child === 'nearly-constant') recorder.record({ source: 'voltage-estimate', device: 'synthetic-voltage',
          signal: 'voltage_estimate_l1', value: 230 + Math.sin(i / 150) * 0.01, unit: 'V', sourceTime: start + i * minute,
          receivedAt: start + i * minute, quality: [], raw: { verified: true } });
        else if (child === 'large-state') store.setState('synthetic-large-state', { ...largeDocument, counter: i + 1 });
        else if (child === 'append') store.transaction(() => {
          insertEvent.run('synthetic-append', JSON.stringify({ i, payload: 'retained-evidence'.repeat(32) }), start + i * minute);
        });
        else if (child === 'no-op') {
          store.setState('synthetic-no-op', { value: 1 });
          store.db.prepare('UPDATE state SET value=value,updated_at=updated_at WHERE key=?').run('synthetic-no-op');
        } else store.transaction(() => {
          const gap = i >= Math.floor(n / 2) && i < Math.floor(n / 2) + 15;
          scalar(i, gap ? null : 35 + 4 * Math.sin(i / 150));
          if (gap) {
            if (i === Math.floor(n / 2)) recorder.energyGap({ source: 'synthetic', device: 'synthetic-meter', prefix: 'property',
              start: start + i * minute, end: start + (i + 15) * minute, quality: ['provider-error'] });
          } else {
            const powers = [0.8, 0.5, Math.floor(i / 120) % 2 ? 2 : 0.1], energies = powers.map(power => power / 60);
            expectedEnergy += energies.reduce((sum, value) => sum + value, 0);
            recorder.recordEnergy({ source: 'synthetic', device: 'synthetic-meter', prefix: 'property', start: start + i * minute,
              end: start + (i + 1) * minute, receivedAt: start + (i + 1) * minute, powers, energies, quality: [] });
          }
          store.setState('synthetic-control-intent', { automatic: false, equipment: 'synthetic-device', revision: Math.floor(i / 120) });
          if (i % 15 === 0) {
            const at = start + i * minute;
            appendLearningRecord(store, 'history', 'sample', currentHomeSample({ timestamp: at, windowStart: at - 15 * minute,
              indoorC: 21 + Math.sin(i / 300) * 0.1, outdoorC: 0, solarRadiationWm2: 0,
              phase: 'normal', roomBoostC: 0, targetC: 21, regime: 'occupied', quality: [],
              energyBasis: 'estimated', actualModeKnown: false }));
            learningCheckpoint = replayLearningJournal(store, 'history', learningCheckpoint);
            store.setState('adaptive:history', learningCheckpoint);
          }
          if (i % 60 === 0) insertEvent.run('synthetic-control-audit', JSON.stringify({ at: start + i * minute, permitted: false }), start + i * minute);
        });
        latencies.push(performance.now() - then);
        if (verifyDatabase && (i + 1) % verifyEvery === 0 && !pendingVerification) {
          const atCycle = i + 1;
          pendingVerification = verifyDatabase({ dbPath: path, origin: 'synthetic-benchmark' }).then(result => {
            verifications.push({ atCycle, checkpoint: result.checkpoint, rows: result.rows });
          }).catch(error => { verificationFailure = error; }).finally(() => { pendingVerification = null; });
        }
        if (replica && replicateEvery && i + 1 >= offlineCycles && (i + 1) % replicateEvery === 0) await replicate(i + 1);
        peakWalBytes = Math.max(peakWalBytes, bytes(`${path}-wal`));
        if ((i + 1) % Math.max(1, Math.floor(n / 4)) === 0 || i + 1 === n) {
          const snapshotStart = performance.now(); snapshots.push({ cycle: i + 1, ...measure({ detail: false }) });
          // Bookkeeping queries are excluded from the heartbeat metric.
          lastBeat += performance.now() - snapshotStart;
        }
        if (i % 16 === 15) await new Promise(resolve => setImmediate(resolve));
      }
      if (child === 'mixed') recorder.flush(start + cycles * minute, { force: true });
      if (replica) {
        if (!transfers.length || JSON.stringify(replica.checkpoint()) !== JSON.stringify(store.checkpoint())) await replicate(n);
        assert.deepEqual(replica.checkpoint(), store.checkpoint());
        for (const table of ['observations', 'recorder_coverage', 'recorder_metrics', 'learning_journal_entries']) {
          const order = table === 'recorder_metrics' ? 'key,bucket' : 'id';
          assert.deepEqual(replica.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
            store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(), `Replica preserves actual ${table} rows`);
        }
        assert.deepEqual(replica.db.prepare("SELECT * FROM state WHERE key<>'backup:metadata' ORDER BY key").all(),
          store.db.prepare("SELECT * FROM state WHERE key<>'backup:metadata' ORDER BY key").all(), 'Replica preserves actual durable state');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      await pendingVerification;
      assert.ifError(verificationFailure);
    } finally { clearInterval(beat); eventLoop.disable(); }
    elapsedMs = performance.now() - begin;
    const after = io(); deltaIO = before && Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
    if (replica) {
      // Independent validation of append-only retained history, outside measured
      // catch-up I/O. Streaming avoids a whole-history JavaScript allocation.
      const eventDigest = database => {
        const hash = createHash('sha256');
        for (const row of database.prepare('SELECT * FROM events ORDER BY id').iterate()) hash.update(JSON.stringify(row)).update('\n');
        return hash.digest('hex');
      };
      assert.equal(eventDigest(replica.db), eventDigest(store.db), 'Replica preserves exact retained event rows');
    }
    const retained = measure();
    const journalBytes = hasTable('journal_commits') ? store.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM journal_commits').get().bytes : 0;
    if (child === 'constant' || child === 'nearly-constant') {
      assert.equal(count('observations'), 1);
      const row = store.db.prepare('SELECT * FROM recorder_coverage').get();
      assert.equal(row.end_at, start + (cycles - 1) * minute); assert.equal(row.samples, cycles);
    }
    if (child === 'large-state') assert.deepEqual(store.getState('synthetic-large-state'), { ...largeDocument, counter: largeCycles });
    if (child === 'append') assert.equal(count('events'), historyRows + cycles);
    if (child === 'mixed') {
      assert.equal(count('learning_journal_entries'), Math.ceil(cycles / 15));
      assert.deepEqual(replayLearningJournal(store, 'history', null, { rebuild: true }), learningCheckpoint,
        'Committed valid samples reproduce the complete live checkpoint from the seed');
      assert.deepEqual(store.getState('adaptive:history'), learningCheckpoint);
      const actual = store.db.prepare("SELECT SUM(value) n FROM observations WHERE signal LIKE 'property_energy_l%'").get().n;
      assert(Math.abs(expectedEnergy - actual) < 1e-8, 'Energy remains conserved through gaps and finalization');
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations WHERE value IS NULL').get().n, 4);
    }
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    latencies.sort((a, b) => a - b);
    console.log(JSON.stringify({ workload: child, cycles: n, elapsedMs, io: deltaIO, wireBytes, peakWalBytes,
      maxHeartbeatGapMs, eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
      maxOperationMs: latencies.at(-1), p99OperationMs: latencies[Math.floor(latencies.length * 0.99)],
      peakRssBytes: Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024), expectedEnergy,
      initial, snapshots, retained, retainedJournalLogicalBytes: journalBytes, verifications, transfers, finalCheckpointed: measure(), growthBytes: retained.allocatedBytes - initial.allocatedBytes }));
  } finally { await pendingVerification; replica?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
}
