// Isolated synthetic comparison. The optional preload delays the native COMMIT
// call only in these child processes; it is not a filesystem/fsync measurement.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleUrl = new URL(import.meta.url);
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
const immediate = () => new Promise(resolveImmediate => setImmediate(resolveImmediate));

if (moduleUrl.searchParams.get('preload') === 'commit-delay') {
  const milliseconds = Number(moduleUrl.searchParams.get('milliseconds'));
  assert(Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 10_000);
  const nativeExec = DatabaseSync.prototype.exec;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  DatabaseSync.prototype.exec = function (sql) {
    if (/^\s*COMMIT\s*;?\s*$/i.test(sql) && milliseconds) Atomics.wait(wait, 0, 0, milliseconds);
    return nativeExec.call(this, sql);
  };
} else {
  const args = process.argv.slice(2);
  assert(args.every(arg => /^--(?:source-root|child|mode|modes|writes|commit-delay-ms|probe-interval-ms)=/.test(arg)), 'Unknown argument');
  const option = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
  const sourceRoot = resolve(option('source-root', fileURLToPath(new URL('../..', import.meta.url))));
  const child = option('child', null), mode = option('mode', 'direct');
  const writes = Number(option('writes', '12')), delayMs = Number(option('commit-delay-ms', '250'));
  const probeIntervalMs = Number(option('probe-interval-ms', '10'));
  assert(Number.isSafeInteger(writes) && writes >= 1 && writes <= 10_000);
  assert(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 10_000);
  assert(Number.isSafeInteger(probeIntervalMs) && probeIntervalMs >= 1 && probeIntervalMs <= 1000);
  assert(['direct', 'worker'].includes(mode));
  const modes = option('modes', 'direct,worker').split(',');
  assert(modes.length >= 1 && modes.length <= 2 && new Set(modes).size === modes.length
    && modes.every(value => ['direct', 'worker'].includes(value)));

  if (child === 'sample') await sample();
  else {
    assert.equal(child, null, 'Unknown child role');
    console.log(JSON.stringify({ synthetic: true, node: process.version, cpu: cpus()[0]?.model, writes,
      injectedCommitDelayMs: delayMs, probeIntervalMs,
      scope: 'Sequential identical small durable writes in isolated child processes, measured by an independent loopback HTTP client.',
      limits: 'Injected delay models a blocked native COMMIT and is not measured fsync latency. FULL durability remains enabled. This does not qualify household equipment, physical storage, throughput under sustained arrivals, or Raspberry Pi scheduling.' }));
    for (const selectedMode of modes) console.log(JSON.stringify(await measure(selectedMode)));
  }

  async function sample() {
    assert(process.send, 'Sample requires a parent IPC connection');
    const { Store } = await import(pathToFileURL(join(sourceRoot, 'src/storage/store.js')).href);
    const { verifyJournal } = await import(pathToFileURL(join(sourceRoot, 'src/storage/journal.js')).href);
    const directory = mkdtempSync(join(tmpdir(), 'stmq-writer-response-'));
    let store, server;
    try {
      store = new Store(join(directory, 'synthetic.sqlite'));
      if (mode === 'worker') {
        assert.equal(typeof store.startWriter, 'function', 'Selected source has no dedicated writer entry point');
        await store.startWriter();
      }
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL durability must remain enabled');
      await store.runWrite(() => store.setState('synthetic-counter', { count: 0 }));
      const initialHead = store.checkpoint();
      let completed = 0, waitingForWrite = false, peakPending = 0, heartbeatMaxMs = 0, heartbeatCount = 0;
      let lastBeat = performance.now();
      const heartbeat = setInterval(() => {
        const now = performance.now();
        heartbeatMaxMs = Math.max(heartbeatMaxMs, now - lastBeat);
        lastBeat = now; heartbeatCount++;
        peakPending = Math.max(peakPending, store.writeQueueStatus().pending);
      }, probeIntervalMs);
      server = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end(JSON.stringify({ completed, waitingForWrite }));
      });
      await new Promise((resolveListening, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolveListening);
      });
      const go = nextMessage('go');
      process.send({ type: 'ready', port: server.address().port });
      await go;
      lastBeat = performance.now(); heartbeatMaxMs = 0; heartbeatCount = 0;
      const started = performance.now();
      try {
        for (let index = 0; index < writes; index++) {
          waitingForWrite = true;
          await store.runWrite(() => {
            const previous = store.getState('synthetic-counter');
            assert.equal(previous.count, index, 'Each dependent read sees the preceding committed write');
            store.setState('synthetic-counter', { count: index + 1 });
            store.event('synthetic-writer-order', { index }, index);
          });
          waitingForWrite = false; completed++;
          // Direct synchronous callbacks need the same opportunity for network
          // work between transactions; microtask starvation is not this test.
          await immediate();
        }
        await pause(probeIntervalMs * 2);
      } finally { clearInterval(heartbeat); }
      const elapsedMs = performance.now() - started;
      // Drain the independent client before full journal/integrity scans. Those
      // verification reads must not be mistaken for a commit or HTTP stall.
      const verify = nextMessage('verify');
      process.send({ type: 'workload-finished' });
      await verify;
      assert.equal(store.getState('synthetic-counter').count, writes);
      const rows = store.db.prepare("SELECT payload FROM events WHERE type='synthetic-writer-order' ORDER BY id").all();
      assert.deepEqual(rows.map(row => JSON.parse(row.payload).index), Array.from({ length: writes }, (_, index) => index));
      assert.equal(store.checkpoint().sequence, initialHead.sequence + writes, 'Every logical write has exactly one journal commit');
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      verifyJournal(store.db);
      const timing = store.writeHealth.status().transactions;
      if (delayMs) assert(timing.nativeCommitMs.last >= delayMs * 0.9, 'Preload must delay the actual owning connection');
      const stop = nextMessage('stop');
      process.send({ type: 'result', mode, elapsedMs, writesPerSecond: writes * 1000 / elapsedMs,
        heartbeatMaxMs, heartbeatCount, peakPending, committedWrites: completed,
        storageTimings: timing, integrity: 'ok', journal: 'verified', orderedRows: rows.length });
      await stop;
    } finally {
      if (server) await new Promise(resolveClosed => server.close(resolveClosed));
      if (store) await store.close();
      rmSync(directory, { recursive: true, force: true });
      process.disconnect();
    }
  }

  function nextMessage(type) {
    return new Promise(resolveMessage => {
      const listener = message => { if (message?.type === type) { process.off('message', listener); resolveMessage(message); } };
      process.on('message', listener);
    });
  }

  async function measure(selectedMode) {
    const preload = new URL(import.meta.url);
    preload.searchParams.set('preload', 'commit-delay');
    preload.searchParams.set('milliseconds', String(delayMs));
    const childProcess = fork(fileURLToPath(import.meta.url), [`--child=sample`, `--mode=${selectedMode}`,
      `--source-root=${sourceRoot}`, `--writes=${writes}`, `--commit-delay-ms=${delayMs}`, `--probe-interval-ms=${probeIntervalMs}`],
    { execArgv: ['--import', preload.href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = '', exited = false, finished = false, collecting = false;
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    failure.catch(() => {});
    const deadline = setTimeout(() => rejectFailure(new Error('Synthetic writer sample exceeded its bounded run time')),
      30_000 + (writes + 4) * (delayMs + 1000));
    const messages = new Map(), waiters = new Map();
    const receive = type => messages.has(type) ? Promise.resolve(messages.get(type))
      : Promise.race([new Promise(resolveMessage => waiters.set(type, resolveMessage)), failure]);
    childProcess.stderr.setEncoding('utf8');
    childProcess.stderr.on('data', value => { stderr = (stderr + value).slice(-16_384); });
    childProcess.on('message', message => {
      messages.set(message.type, message); waiters.get(message.type)?.(message);
    });
    childProcess.once('error', rejectFailure);
    const exit = new Promise(resolveExit => childProcess.once('exit', code => {
      exited = true;
      if (code !== 0 || !messages.has('result')) rejectFailure(new Error(stderr || `${selectedMode} sample exited ${code}`));
      resolveExit(code);
    }));
    const samples = [];
    let probes;
    try {
      const ready = await receive('ready');
      // Warm up the independent client before starting the write workload.
      for (let index = 0; index < 3; index++) await probe(ready.port);
      collecting = true;
      probes = (async () => {
        while (!finished) {
          const measured = collecting, result = await probe(ready.port);
          if (measured) samples.push(result);
          if (!finished) await pause(probeIntervalMs);
        }
      })();
      childProcess.send({ type: 'go' });
      await receive('workload-finished');
      collecting = false; finished = true;
      await probes;
      childProcess.send({ type: 'verify' });
      const result = await receive('result');
      childProcess.send({ type: 'stop' });
      await Promise.race([exit, failure]);
      const durations = samples.map(row => row.elapsedMs).sort((a, b) => a - b);
      assert(samples.length > 0, 'Independent HTTP measurement must observe the workload');
      const { type, ...details } = result;
      return { ...details, http: { samples: samples.length, maxMs: durations.at(-1),
        p99Ms: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.99) - 1)],
        repliesWhileWritePending: samples.filter(row => row.waitingForWrite).length } };
    } finally {
      clearTimeout(deadline);
      finished = true;
      if (!exited) childProcess.kill();
      await probes?.catch(() => {});
      await exit;
    }
  }

  function probe(port) {
    const started = performance.now();
    return new Promise((resolveProbe, reject) => {
      const request = get({ host: '127.0.0.1', port, path: '/', agent: false }, response => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', value => { body += value; });
        response.once('error', reject);
        response.once('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            resolveProbe({ elapsedMs: performance.now() - started, ...JSON.parse(body) });
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error('Synthetic HTTP probe timed out')));
      request.once('error', reject);
    });
  }
}
