import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), root = dirname(dirname(script));

/** Own file isolation and configure node:test through its public run() API.
 * Node 22's CLI otherwise adds a file timeout and owns application signals. */
export async function runOfflineTests({ extended = false, files, args = [],
  timeout = extended ? 180000 : 60000, concurrency = extended ? 1 : 4 } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Offline test timeout and concurrency must be positive integers.');
  const directory = join(root, 'test', ...(extended ? ['extended'] : []));
  files ??= (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort().map(name => join(directory, name));
  const queue = [...files], children = new Set();
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
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (!stopped && queue.length) {
        const file = queue.shift();
        const child = spawn(process.execPath, [...args, script, '--file', file, String(timeout), ...args],
          { cwd: root, env, stdio: 'inherit' });
        children.add(child);
        const code = await new Promise(resolveCode => {
          child.once('error', () => resolveCode(1));
          child.once('exit', code => resolveCode(code ?? 1));
        });
        children.delete(child);
        if (code !== 0) { if (!stopped) result = 1; console.error(`Offline test file failed: ${file}`); }
      }
    }));
    return result;
  } finally {
    clearTimeout(killTimer);
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
  tests.on('test:fail', () => { process.exitCode = 1; });
  for (const format of formats) tests.compose(format).pipe(process.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--file') await runFile(args[1], Number(args[2]), args.slice(3));
  else {
    const extended = args[0] === '--extended';
    if (extended) args.shift();
    if (args.some(arg => !/^--test-(?:(?:name-pattern|skip-pattern|reporter)=.+|only)$/.test(arg)))
      throw new Error('Use --extended, --test-name-pattern=..., --test-skip-pattern=..., --test-reporter=... or --test-only.');
    process.exitCode = await runOfflineTests({ extended, args });
  }
}
