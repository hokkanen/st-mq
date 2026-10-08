import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Node 22 otherwise applies --test-timeout to the entire isolated file too.
 * Own the file processes here so every supported runtime enforces a case budget. */
export async function runOfflineTests({ extended = false, files, args = [],
  timeout = extended ? 180000 : 60000, concurrency = extended ? 1 : 4 } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Offline test timeout and concurrency must be positive integers.');
  const directory = join(root, 'test', ...(extended ? ['extended'] : []));
  files ??= (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort().map(name => join(directory, name));
  const queue = [...files], children = new Set();
  let result = 0, stopped = false;
  const stop = signal => {
    stopped = true; result = signal === 'SIGINT' ? 130 : 143;
    for (const child of children) child.kill(signal);
  };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (!stopped && queue.length) {
        const file = queue.shift();
        const child = spawn(process.execPath, ['--test', '--experimental-test-isolation=none',
          `--test-timeout=${timeout}`, ...args, file], { cwd: root, env, stdio: 'inherit' });
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
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), extended = args[0] === '--extended';
  if (extended) args.shift();
  if (args.some(arg => !/^--test-(?:(?:name-pattern|skip-pattern|reporter)=.+|only)$/.test(arg)))
    throw new Error('Use --extended, --test-name-pattern=..., --test-skip-pattern=..., --test-reporter=... or --test-only.');
  process.exitCode = await runOfflineTests({ extended, args });
}
