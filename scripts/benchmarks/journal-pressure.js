// Controlled, isolated FULL-durability pressure comparison. Never opens an
// installation database. --reference-root may name a pre-refactor source tree.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), option = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
assert(args.every(arg => /^--(?:reference-root|source-root|child|mode|cycles|pressure-rows)=/.test(arg)), 'Unknown argument');
const sourceRoot = resolve(option('source-root', fileURLToPath(new URL('../..', import.meta.url))));
const referenceRoot = option('reference-root', null), child = option('child', null), mode = option('mode', 'default');
const cycles = Number(option('cycles', '6144')), pressureRows = Number(option('pressure-rows', '131072'));
assert(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 100_000);
assert(Number.isSafeInteger(pressureRows) && pressureRows > 0 && pressureRows <= 262144);
assert(['default', 'off'].includes(mode));
if (!child) {
  console.log(JSON.stringify({ synthetic: true, node: process.version, cpu: cpus()[0]?.model, cycles, pressureRows,
    scope: 'One concurrent disk writer plus current FULL-WAL recording with automatic checkpoints enabled/disabled and optional reference implementation.',
    limits: 'Diagnostic disables checkpoints only in its disposable comparison database; synchronous=FULL remains unchanged. Host filesystem pressure is nondeterministic. Trace fsync descriptors/timestamps before attributing any delay to commit WAL durability or database checkpoints. This is not a latency guarantee.' }));
  const jobs = [['writer', sourceRoot, 'default'], ['sample', sourceRoot, 'default'], ['sample', sourceRoot, 'off'],
    ...(referenceRoot ? [['sample', resolve(referenceRoot), 'default']] : [])];
  await Promise.all(jobs.map(([kind, root, checkpointMode]) => new Promise((resolveJob, reject) => {
    const childProcess = spawn(process.execPath, [fileURLToPath(import.meta.url), `--source-root=${root}`, `--child=${kind}`,
      `--mode=${checkpointMode}`, `--cycles=${cycles}`, `--pressure-rows=${pressureRows}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    childProcess.stdout.setEncoding('utf8'); childProcess.stderr.setEncoding('utf8');
    childProcess.stdout.on('data', value => { stdout += value; }); childProcess.stderr.on('data', value => { stderr += value; });
    childProcess.once('error', reject);
    childProcess.once('exit', code => {
      if (code !== 0) reject(new Error(stderr || `${kind} exited ${code}`));
      else { process.stdout.write(stdout); resolveJob(); }
    });
  })));
} else {
  assert(['sample', 'writer'].includes(child));
  const { Store } = await import(pathToFileURL(join(sourceRoot, 'src/storage/store.js')).href);
  const { Recorder } = await import(pathToFileURL(join(sourceRoot, 'src/storage/recorder.js')).href);
  const directory = mkdtempSync(join(tmpdir(), 'stmq-journal-pressure-')), store = new Store(join(directory, 'synthetic.sqlite'));
  const io = () => process.platform === 'linux' ? Object.fromEntries(readFileSync('/proc/self/io', 'utf8').trim().split('\n')
    .map(line => { const [key, value] = line.split(':'); return [key, Number(value)]; })) : null;
  if (mode === 'off') store.db.exec('PRAGMA wal_autocheckpoint=0');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL durability is never relaxed');
  const before = io(), began = performance.now(), slow = [];
  let maxOperationMs = 0;
  try {
    if (child === 'writer') {
      const insert = store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
      const payload = JSON.stringify({ synthetic: 'x'.repeat(2048) });
      for (let offset = 0; offset < pressureRows; offset += 256) store.transaction(() => {
        for (let i = offset; i < Math.min(pressureRows, offset + 256); i++) insert.run('synthetic-disk-pressure', payload, i);
      });
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, pressureRows);
    } else {
      const recorder = new Recorder(store);
      for (let i = 0; i < cycles; i++) {
        const at = Date.UTC(2026, 0, 1) + i * 60_000, began = performance.now(), startedAt = Date.now();
        recorder.record({ source: 'synthetic', device: 'synthetic-pressure-sensor', signal: 'supply_temperature', unit: 'degC',
          value: 35, sourceTime: at, receivedAt: at, quality: [], raw: { verified: true } });
        const elapsedMs = performance.now() - began;
        maxOperationMs = Math.max(maxOperationMs, elapsedMs);
        if (elapsedMs >= 40) slow.push({ cycle: i, startedAt, endedAt: Date.now(), elapsedMs });
        await new Promise(resolveNext => setImmediate(resolveNext));
      }
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 1);
      assert.equal(store.db.prepare('SELECT samples FROM recorder_coverage').get().samples, cycles);
    }
    const after = io();
    console.log(JSON.stringify({ child, sourceRoot, mode, elapsedMs: performance.now() - began, maxOperationMs, slow,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      io: before && Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) }));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
