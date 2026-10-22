// Bootstrap dependency installation must run before importing application modules.
// This file deliberately imports only Node built-ins.
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, writeSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function installSetupDependencies({ source, nodePath = process.execPath,
  npmPath = realpathSync(join(dirname(nodePath), 'npm')), env = process.env, signal,
  timeout = 900000, spawnProcess = spawn } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'st-mq-bootstrap-'));
  const logPath = join(directory, 'dependencies.log');
  const fd = openSync(logPath, 'wx', 0o600);
  const cleanEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('STMQ_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  let success = false;
  try {
    await new Promise((yes, no) => {
      const child = spawnProcess(nodePath, [npmPath, 'ci', '--include=dev', '--no-audit', '--no-fund'], {
        cwd: source, env: cleanEnvironment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timer, killer, bytes = 0, stopped = false;
      const stop = () => {
        if (stopped) return; stopped = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 1000);
      };
      const record = chunk => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) stop();
        else writeSync(fd, chunk);
      };
      child.stdout.on('data', record); child.stderr.on('data', record);
      child.once('error', () => { stopped = true; });
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', stop);
        if (stopped || code !== 0) no(new Error('Setup dependencies could not be installed. Private diagnostic log: ' + logPath));
        else yes();
      });
      timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });
    success = true;
  } finally {
    closeSync(fd);
    if (success) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => abort.abort());
  try {
    if (process.argv.length !== 3) throw Error('Invalid dependency bootstrap invocation.');
    await installSetupDependencies({ source: resolve(process.argv[2]), signal: abort.signal });
  } catch (error) {
    const message = error?.message?.startsWith('Setup dependencies could not be installed.') ? error.message
      : 'Setup dependencies could not be installed. Check the trusted Node installation and its bundled npm.';
    process.stderr.write(message + '\n'); process.exitCode = 1;
  }
}
