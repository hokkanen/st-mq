import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { offlineTestProfile } from './lib/offline-test-profile.js';

const script = fileURLToPath(import.meta.url), root = dirname(dirname(script));

/** Own file isolation and configure node:test through its public run() API.
 * Node 22's CLI otherwise adds a file timeout and owns application signals. */
export async function runOfflineTests({ extended = false, files, args = [],
  profile = process.env.STMQ_TEST_PROFILE ?? 'standard', report,
  timeout, concurrency } = {}) {
  const settings = offlineTestProfile(profile);
  timeout ??= extended ? settings.extendedCaseTimeoutMs : settings.caseTimeoutMs;
  concurrency ??= extended ? 1 : settings.concurrency;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Offline test timeout and concurrency must be positive integers.');
  const directory = join(root, 'test', ...(extended ? ['extended'] : []));
  files ??= (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort().map(name => join(directory, name));
  const queue = [...files], children = new Set();
  const receipt = event => { if (report) appendFileSync(report, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }); };
  if (report) {
    report = resolve(report); mkdirSync(dirname(report), { recursive: true, mode: 0o700 });
    const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim();
    const digest = createHash('sha256');
    const paths = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8' });
    if (paths.status === 0) for (const path of [...new Set(paths.stdout.split('\0').filter(Boolean))].sort()) {
      digest.update(path).update('\0');
      try { digest.update(readFileSync(join(root, path))); } catch { digest.update('[missing]'); }
      digest.update('\0');
    }
    const limit = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
    receipt({ event: 'suite-start', suite: extended ? 'extended' : 'routine', profile, node: process.version,
      architecture: process.arch, platform: process.platform, parallelism: availableParallelism(), hostMemoryBytes: totalmem(),
      cpuLimit: limit('/sys/fs/cgroup/cpu.max'), memoryLimit: limit('/sys/fs/cgroup/memory.max'),
      revision: git(['rev-parse', 'HEAD']), sourceDigest: paths.status === 0 ? digest.digest('hex') : null,
      sourceDirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal'])),
      files: files.length, concurrency, timeoutMs: timeout });
  }
  let result = 0, stopped = false, killTimer;
  const stop = signal => {
    stopped = true; result = signal === 'SIGINT' ? 130 : 143;
    for (const child of children) child.kill(signal);
    // A test can block its event loop or install a signal handler. Keep the
    // runner's own cancellation bounded even when that child cannot cooperate.
    if (children.size && !killTimer) killTimer = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
    }, 1000);
  };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const env = { ...process.env, STMQ_TEST_PROFILE: profile }; delete env.NODE_TEST_CONTEXT;
  let completed = 0, failed = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (!stopped && queue.length) {
        const file = queue.shift();
        const startedAt = performance.now();
        receipt({ event: 'file-start', file });
        const child = spawn(process.execPath, [...args, script, '--file', file, String(timeout), ...args],
          { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        child.on('message', value => receipt({ event: 'case-result', file, ...value }));
        children.add(child);
        const { code, signal } = await new Promise(resolveCode => {
          child.once('error', () => resolveCode({ code: 1, signal: null }));
          child.once('exit', (code, signal) => resolveCode({ code: code ?? 1, signal }));
        });
        children.delete(child);
        completed++; if (code !== 0) failed++;
        receipt({ event: 'file-end', file, code, signal, durationMs: performance.now() - startedAt });
        if (code !== 0) { if (!stopped) result = 1; console.error(`Offline test file failed: ${file}`); }
      }
    }));
    return result;
  } finally {
    clearTimeout(killTimer);
    receipt({ event: 'suite-end', completed, failed, unstarted: queue.length, interrupted: stopped, code: result });
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

async function runFile(file, timeout, args) {
  const { run } = await import('node:test'), reporters = await import('node:test/reporters');
  const values = option => args.filter(arg => arg.startsWith(`${option}=`)).map(arg => arg.slice(option.length + 1));
  const names = values('--test-reporter');
  const formats = await Promise.all((names.length ? names : ['spec']).map(async name => reporters[name]
    ?? (await import(name.startsWith('.') || name.startsWith('/') ? pathToFileURL(resolve(name)).href : name)).default));
  const patterns = values('--test-name-pattern'), skipped = values('--test-skip-pattern');
  const tests = run({ files: [file], isolation: 'none', timeout,
    ...(patterns.length ? { testNamePatterns: patterns } : {}), ...(skipped.length ? { testSkipPatterns: skipped } : {}),
    only: args.includes('--test-only') });
  tests.on('test:fail', value => {
    process.exitCode = 1;
    const error = value.details?.error;
    process.send?.({ result: 'fail', name: value.name, nesting: value.nesting,
      durationMs: value.details?.duration_ms, error: { message: error?.message,
        code: error?.code, failureType: error?.failureType, cause: error?.cause?.message } });
  });
  tests.on('test:summary', value => process.send?.({ result: 'summary', counts: value.counts, durationMs: value.duration_ms }));
  tests.on('test:pass', value => {
    if (value.skip || value.todo) process.send?.({ result: 'skip', name: value.name,
      nesting: value.nesting, reason: value.skip || value.todo });
  });
  tests.once('end', () => { if (process.connected) process.disconnect(); });
  for (const format of formats) tests.compose(format).pipe(process.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--file') await runFile(args[1], Number(args[2]), args.slice(3));
  else {
    const extended = args.includes('--extended');
    const settings = option => args.find(arg => arg.startsWith(option + '='))?.slice(option.length + 1);
    const profile = settings('--profile') ?? process.env.STMQ_TEST_PROFILE ?? 'standard', report = settings('--report');
    const forwarded = args.filter(arg => arg !== '--extended' && !arg.startsWith('--profile=') && !arg.startsWith('--report='));
    if (forwarded.some(arg => !/^--test-(?:(?:name-pattern|skip-pattern|reporter)=.+|only)$/.test(arg)))
      throw new Error('Use --extended, --profile=standard|ha-sd, --report=path, --test-name-pattern=..., --test-skip-pattern=..., --test-reporter=... or --test-only.');
    process.exitCode = await runOfflineTests({ extended, profile, report, args: forwarded });
  }
}
