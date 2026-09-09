import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, unlinkSync, readFileSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LIVE_SERVICES, selectedServices, readLiveState, writeLiveState, liveCooldowns, livePaths } from '../test/live/support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const help = `Usage: npm run test:live -- [--services name,name]\n\nServices: ${LIVE_SERVICES.join(', ')}\n\nThis command makes bounded, read-only live provider requests using STMQ_CONFIG\n(or ~/.config/st-mq/secrets.json; /data/options.json in addon mode). Easee authentication\nmay rotate cached tokens. No MQTT, device commands or history writes are\navailable. Local cooldowns prevent rapid repeats. Optional devices without IDs\nare reported as skipped.`;
let lock;
let child;
let lockPath;
try {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(help);
  } else {
    let requested = process.env.STMQ_LIVE_SERVICES ?? '';
    if (args.length === 2 && args[0] === '--services') requested = args[1];
    else if (args.length === 1 && args[0].startsWith('--services=')) requested = args[0].slice('--services='.length);
    else if (args.length) throw new Error('Invalid live-test arguments; use --help');
    const selected = selectedServices(requested);
    const { directory } = livePaths(process.env, root);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Live-test cache must be a private directory');
    chmodSync(directory, 0o700);
    lockPath = join(directory, 'run.lock');
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Live-test lock could not be created');
      let pid;
      try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { /* Unknown locks are not removed. */ }
      let stale = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
      }
      if (!stale) throw new Error('Another live test is running, or its lock needs inspection');
      unlinkSync(lockPath); lock = openSync(lockPath, 'wx', 0o600);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const state = readLiveState(directory), at = Date.now();
    const cooldowns = liveCooldowns(state, selected, at);
    if (cooldowns.length) throw new Error(`Live-test cooldown: ${cooldowns.map(item => `${item.service} (${item.seconds}s)`).join(', ')}. Select other services or wait.`);
    for (const service of selected) state.attemptedAt[service] = at;
    writeLiveState(directory, state);
    console.log(`Live checks: ${selected.join(', ')}. Requests are serial and bounded; device commands are disabled.`);
    child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec',
      fileURLToPath(new URL('../test/live/providers.test.js', import.meta.url))], {
      cwd: root, stdio: 'inherit', env: { ...process.env, STMQ_LIVE_TEST: '1',
        STMQ_LIVE_SERVICES: selected.join(','), STMQ_LIVE_DATA_DIR: directory },
    });
    const stop = signal => child?.kill(signal);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const result = await new Promise((resolveChild, reject) => {
      child.once('error', () => reject(new Error('Live-test worker could not start')));
      child.once('exit', (code, signal) => resolveChild({ code, signal }));
    });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.exitCode = result.code ?? (result.signal ? 130 : 1);
  }
} catch (error) {
  // Only locally authored messages are exposed; never dump configuration or HTTP responses.
  console.error(error instanceof Error && !error.code ? error.message : 'Live-test runner failed to prepare its private cache');
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockPath); } catch { /* Already removed on exit. */ } }
}
