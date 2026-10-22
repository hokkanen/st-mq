import { spawn } from 'node:child_process';
import { DeploymentSafetyError } from './paired-deployment.js';

// Kill the process group on timeout/cancellation, including npm's descendants.
// Output is bounded and never included in public errors.
export function runCommand(command, args, { cwd, env = process.env, timeout = 900000, signal, acceptedExitCodes = [0], detached = command !== 'sudo' } = {}) {
  return new Promise((yes, no) => {
    let output = [], bytes = 0, reason, timer, killer;
    // sudo must retain the invoking terminal/session so its timestamp matches
    // interactive sudo -v. npm/build jobs get a separate killable process group.
    const child = spawn(command, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = signal => { try { if (detached) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
    const stop = message => {
      if (reason) return;
      reason = message;
      kill('SIGTERM');
      killer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const abort = () => stop('Command cancelled; inspect service state before retrying.');
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop('Command output exceeded its limit.'); else output.push(data); });
    child.stderr.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop('Command output exceeded its limit.'); });
    child.on('error', () => { reason = 'Command could not start.'; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', abort);
      if (reason || !acceptedExitCodes.includes(code)) no(new DeploymentSafetyError(reason ?? 'Command failed; private command output suppressed.'));
      else yes(Buffer.concat(output).toString('utf8').trim());
    });
    timer = setTimeout(() => stop('Command timed out; inspect service state before retrying.'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
